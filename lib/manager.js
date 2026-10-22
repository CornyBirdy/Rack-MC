/*
 * manager.js — the runtime brain. Owns every Minecraft server's lifecycle:
 * install → start → console I/O → stop, plus live status/players/stats that it
 * pushes out through a single EventEmitter (`events`). server.js turns those
 * events into SSE. Runtime state is in-memory; definitions live in store.js.
 */
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const store = require("./store");
const loaders = require("./loaders");
const java = require("./java");
const playit = require("./playit");
const modrinth = require("./modrinth");
const wake = require("./wake");
const playerlog = require("./playerlog");
const perf = require("./perf");
const voicechat = require("./voicechat");
const hosted = require("./hosted");
const uptime = require("./uptime");

const isWin = process.platform === "win32";
const LOG_CAP = 400; // console lines retained per server for replay
const hostKey = (id) => "srv-" + id;
// Servers run under their own host process (lib/host.js) unless this is off,
// so updating or restarting the panel leaves them running.
const keepRunning = () => store.getSettings().keepServersRunning !== false;
const events = new EventEmitter();
events.setMaxListeners(0);

// id -> live runtime slot
const rt = new Map();

function slot(id) {
  let s = rt.get(id);
  if (!s) {
    s = {
      proc: null,
      status: "stopped",
      log: [],
      install: { active: false, log: [] },
      preparing: false, // downloading a Java runtime before launch
      players: [],
      pings: {}, // name -> ms, only for servers whose console answers "ping"
      pingSupport: "unknown", // unknown | yes | no
      pingTimer: null,
      pingProbes: 0,
      startedAt: null,
      stopTimer: null,
      wake: null, // the stand-in listener holding the port while asleep
      paused: false, // Minecraft parked its own tick loop (light sleep)
      pausedAt: null, // when it did, so a backup can tell it already has this pause covered
      asleep: false, // we stopped it ourselves after it sat empty (deep sleep)
      sleepTimer: null,
      stopRequested: false, // the exit that follows is a stop, not a crash
      runningAt: null, // when it finished booting, for the lag watch's grace period
      crashes: [], // recent crash times, for the crash-loop guard
      crashGaveUp: false,
      restartTimer: null, // pending restart after a crash
      restartAt: null,
      poorSince: null, // start of the current run of low-TPS readings
      lagRestarts: [], // recent performance restarts, for the same kind of guard
      lagGaveUp: false,
      lagTimer: null, // the warning period before a performance restart
      lagRestartAt: null,
      backup: null, // the backup or restore job holding the world folder, if any
      schedTimer: null, // scheduled uptime: the countdown to a closing-time stop
      schedStopAt: null,
      schedWaiting: false, // closing time came with players on, and it waits for them
    };
    rt.set(id, s);
  }
  return s;
}

// playit's tunnel state shows up on every server card, so its changes ride the
// same event bus the dashboard is already listening to.
playit.events.on("change", (snapshot) => {
  events.emit("event", { type: "playit", playit: snapshot });
  for (const def of store.all())
    if (def.playit && def.playit.enabled) events.emit("event", { type: "status", ...summary(def.id) });
});

// The player log writes its own history; the dashboard wants to see it happen,
// so every recorded event is relayed onto the same bus as everything else.
playerlog.events.on("record", ({ id, event }) => {
  events.emit("event", { type: "playerlog", id, event });
});

// TPS, CPU, memory and the rest are sampled by perf.js; the dashboard hears
// about them on the same bus.
perf.events.on("stats", (id, stats) => {
  events.emit("event", { type: "stats", id, ...stats });
  if (stats.point) watchPerformance(id, stats); // a fresh sample, not a lag-line echo
});
perf.events.on("lag", (id, lag) => {
  events.emit("event", { type: "lag", id, lag });
});

// playit handed out (or took back) a voice chat address and the mod's config
// now says so. The mod reads it only at startup, so a running server is told.
voicechat.events.on("host", (id, host) => {
  if (slot(id).status === "running" || slot(id).status === "starting")
    emitConsole(
      id,
      "sys",
      host
        ? `[hoster] Voice chat address is now ${host} — restart the server for players to use it.`
        : "[hoster] Voice chat is local-only now (no public address) — this applies after a restart."
    );
  events.emit("event", { type: "status", ...summary(id) });
});

/* ------------------------------------------------------------------ helpers */

function emitConsole(id, stream, line) {
  const s = slot(id);
  s.log.push({ stream, line, t: Date.now() });
  if (s.log.length > LOG_CAP) s.log.shift();
  events.emit("event", { type: "console", id, stream, line });
}

function setStatus(id, status) {
  const s = slot(id);
  if (s.status === status) return;
  s.status = status;
  if (status === "running") startPings(id);
  else stopPings(id);
  if (status !== "running") s.paused = false;
  armSleepTimer(id);
  syncWake(id);
  events.emit("event", { type: "status", ...summary(id) });
}

// Deep sleep: once a running server has been empty for its configured number
// of minutes, stop it outright so the RAM goes back to the machine. Re-armed
// from every edge that can change the answer — status, joins, leaves, settings.
function armSleepTimer(id) {
  const s = slot(id);
  if (s.sleepTimer) clearTimeout(s.sleepTimer);
  s.sleepTimer = null;
  const def = store.find(id);
  const mins = Number(def && def.sleepAfter) || 0;
  if (!mins || s.status !== "running" || s.players.length) return;
  s.sleepTimer = setTimeout(() => {
    s.sleepTimer = null;
    // The world can have moved on across those minutes — check again.
    if (s.status !== "running" || s.players.length) return;
    emitConsole(id, "sys", `[hoster] Empty for ${mins} minute${mins === 1 ? "" : "s"} — going to sleep.`);
    playerlog.serverEvent(id, `Empty for ${mins} minute${mins === 1 ? "" : "s"} — going to sleep.`);
    stop(id, { auto: true });
  }, mins * 60000);
  if (s.sleepTimer.unref) s.sleepTimer.unref();
}

// Park a listener on the port of a stopped server so a join attempt can start
// it. Everything that can change the answer calls this; it is idempotent.
function syncWake(id) {
  const s = slot(id);
  const def = store.find(id);
  const want = !!(def && def.wakeOnJoin) && s.status === "stopped" && !s.install.active && !s.preparing;
  if (want === !!s.wake) return;

  if (want) {
    s.wake = wake.arm({
      port: def.port,
      name: def.name,
      maxPlayers: def.maxPlayers || 20,
      onWake: (who) => {
        emitConsole(id, "sys", `[hoster] ${who || "Someone"} knocked — waking up.`);
        playerlog.serverEvent(id, `${who || "Someone"} knocked — waking the server up.`, who ? { player: who } : null);
        Promise.resolve(start(id)).catch((e) => emitConsole(id, "err", "[hoster] wake failed: " + e.message));
      },
      onError: (e) => {
        // Usually something else already has the port. Say so once and stay out
        // of the way rather than retrying into a loop.
        s.wake = null;
        emitConsole(id, "sys", `[hoster] Wake-on-join can't hold port ${def.port}: ${e.message}`);
        events.emit("event", { type: "status", ...summary(id) });
      },
    });
  } else {
    const h = s.wake;
    s.wake = null;
    h.close();
  }
  events.emit("event", { type: "status", ...summary(id) });
}

// Hand the port back and wait until it is genuinely free, so Java can bind it.
async function disarmWake(id) {
  const s = slot(id);
  if (!s.wake) return;
  const h = s.wake;
  s.wake = null;
  await h.close();
  await new Promise((r) => setTimeout(r, 150)); // let the OS release it
  events.emit("event", { type: "status", ...summary(id) });
}

// Light sleep is Minecraft's own doing, so we learn about it from the console.
function setPaused(id, paused) {
  const s = slot(id);
  if (s.paused === paused) return;
  s.paused = paused;
  s.pausedAt = paused ? Date.now() : null;
  events.emit("event", { type: "status", ...summary(id) });
}

function emitInstall(id, line) {
  const s = slot(id);
  s.install.log.push(line);
  if (s.install.log.length > 800) s.install.log.shift();
  events.emit("event", { type: "install", id, line });
}

// Public snapshot used by the API + status events.
function summary(id) {
  const def = store.find(id);
  const s = slot(id);
  return {
    id,
    name: def ? def.name : id,
    loader: def ? def.loader : null,
    mc: def ? def.mc : null,
    build: def ? def.build : null,
    // A modpack server reports the loader it actually runs, plus which pack
    // and version it came from, so the UI can offer the right content.
    modLoader: def && def.start ? def.start.modLoader || null : null,
    pack: def && def.start ? def.start.pack || null : null,
    // Where Modrinth content goes for this server, and which loader tags it can
    // run — null until the install finishes and the loader is known.
    content: def ? modrinth.targetFor(def) : null,
    port: def ? def.port : null,
    memory: def ? def.memory : null,
    icon: def ? def.icon : null,
    status: s.status,
    // Two flavours of idle the dashboard paints differently: "paused" is the
    // server ticking over at ~0% CPU, "asleep" is it shut down to free the RAM.
    paused: s.status === "running" && s.paused,
    // A server holding its port for a knock is sleeping too, however it got
    // stopped — that is what the player on the other end sees.
    asleep: s.status === "stopped" && (s.asleep || !!s.wake),
    wakeArmed: !!s.wake,
    players: s.players,
    pings: s.pings,
    maxPlayers: def ? def.maxPlayers || 20 : 20,
    startedAt: s.startedAt,
    // Self-healing: a restart counting down after a crash or a lag streak, and
    // whether the crash-loop guard has stopped trying.
    restartAt: s.restartAt,
    lagRestartAt: s.lagRestartAt,
    crashGaveUp: s.status === "crashed" && s.crashGaveUp,
    // Scheduled uptime: when it next starts or stops, and a closing time that
    // is counting down or waiting for the last player to leave.
    schedule: def ? scheduleInfo(def) : null,
    schedStopAt: s.proc ? s.schedStopAt : null,
    schedWaiting: !!s.proc && s.schedWaiting,
    stats: perf.current(id),
    installing: s.install.active || s.preparing,
    backup: s.backup ? { kind: s.backup.kind, phase: s.backup.phase } : null,
    eula: def ? isEulaAccepted(id) : false,
    playit: def ? playit.serverInfo(def) : { enabled: false, address: null, status: "off" },
    voice: def ? voicechat.info(def) : null,
  };
}

function listSummaries() {
  return store.all().map((d) => summary(d.id));
}

/* ------------------------------------------------------------ create/install */

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Pick a runtime that can actually run this server's Minecraft version. An
// explicit per-server (or global) override always wins; otherwise we match the
// Java major Mojang pins for that version, downloading a Temurin JRE if the
// machine has nothing new enough. Returns {java, required, installed}.
async function resolveJava(def, { autoInstall = true, log = () => {} } = {}) {
  const explicitPath = (def && def.javaPath) || store.getSettings().javaPath || null;
  return java.resolveFor(def && def.mc, { explicitPath, autoInstall, log });
}

// Create a server definition and kick off (async) installation.
async function create(spec) {
  const loader = loaders.get(spec.loader); // throws on unknown
  const id = newId();
  const dir = store.dirFor(id);
  fs.mkdirSync(dir, { recursive: true });

  const def = {
    id,
    name: (spec.name || "New Server").trim(),
    loader: spec.loader,
    mc: spec.mc,
    build: spec.build || null,
    memory: Number(spec.memory) || store.getSettings().defaultMemory || 4096,
    port: Number(spec.port) || 25565,
    maxPlayers: Number(spec.maxPlayers) || 20,
    icon: spec.icon || null, // no auto emoji: the panel falls back to the initial
    javaPath: spec.javaPath || null,
    jvmArgs: spec.jvmArgs || "",
    pauseWhenEmpty: Number(spec.pauseWhenEmpty) || 0, // seconds; 0 = never pause
    sleepAfter: Number(spec.sleepAfter) || 0, // minutes empty before we stop it; 0 = never
    wakeOnJoin: !!spec.wakeOnJoin, // hold the port while stopped and boot on a join
    restartOnCrash: spec.restartOnCrash !== false,
    startWithPanel: !!spec.startWithPanel, // bring it back up when the panel boots
    lagRestartTps: Number(spec.lagRestartTps) || 0, // restart below this TPS; 0 = never
    lagRestartMins: Number(spec.lagRestartMins) || 10, // …sustained for this long
    start: null, // filled in after install
    createdAt: Date.now(),
  };
  store.add(def);
  events.emit("event", { type: "servers" });

  const s = slot(id);
  s.install.active = true;
  setStatus(id, "installing");

  // Install in the background; the UI streams progress over SSE.
  (async () => {
    try {
      emitInstall(id, `Installing ${loader.label} for Minecraft ${spec.mc}…`);
      const res = await resolveJava(def, { log: (line) => emitInstall(id, line) });
      const jv = res.java;
      emitInstall(id, `Minecraft ${spec.mc} requires Java ${res.required}.`);
      if (jv) emitInstall(id, `Using Java ${jv.version} (${jv.path})`);
      if (jv && jv.major < res.required)
        emitInstall(
          id,
          `⚠ Java ${jv.version} is older than the required ${res.required} — this server will fail to start until you point it at a newer runtime.`
        );
      const start = await loader.install({
        dir,
        mc: spec.mc,
        build: spec.build || null,
        memoryMB: def.memory,
        java: jv,
        log: (line) => emitInstall(id, line),
      });
      def.start = start;
      writeInitialProperties(def);
      ensureEula(id, false);
      store.update(id, { start });
      s.install.active = false;
      emitInstall(id, "✔ Installation complete. Accept the EULA, then hit Start.");
      setStatus(id, "stopped");
      events.emit("event", { type: "servers" });
    } catch (e) {
      s.install.active = false;
      emitInstall(id, "✖ Install failed: " + e.message);
      setStatus(id, "install-failed");
    }
  })();

  return def;
}


/* -------------------------------------------------------- properties / eula */

const propsPath = (id) => path.join(store.dirFor(id), "server.properties");
const eulaPath = (id) => path.join(store.dirFor(id), "eula.txt");

function readProperties(id) {
  try {
    return fs.readFileSync(propsPath(id), "utf8");
  } catch {
    return "";
  }
}
function writeProperties(id, text) {
  fs.writeFileSync(propsPath(id), text);
}

// Merge key=value pairs into server.properties, preserving other lines.
function patchProperties(id, kv) {
  const lines = readProperties(id).split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^([\w.-]+)=(.*)$/.exec(line);
    if (m && kv[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${kv[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(kv)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeProperties(id, out.join("\n").replace(/\n+$/, "") + "\n");
}

// `pause-when-empty-seconds` landed in Minecraft 1.21.2. Year-based versions
// (26.x) are all newer than that; anything we cannot parse — snapshots, odd
// builds — is assumed to support it, since the key is inert on servers that
// do not.
function supportsPause(mc) {
  const m = /^([0-9]+)[.]([0-9]+)(?:[.]([0-9]+))?/.exec(String(mc || ""));
  if (!m) return true;
  const [maj, min, patch] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (maj !== 1) return maj > 1;
  return min > 21 || (min === 21 && patch >= 2);
}

// Off writes -1 rather than nothing, so a server never quietly inherits
// Minecraft's own 60-second default.
function pauseSeconds(def) {
  const n = Number(def && def.pauseWhenEmpty) || 0;
  return n > 0 ? Math.max(10, Math.round(n)) : -1;
}

// Push the current setting into server.properties so the Properties tab and
// the next launch agree. Skipped until the file exists — Minecraft writes it
// with all the other defaults on first run.
function applySleepSetting(id) {
  armSleepTimer(id);
}

// Re-park the listener from scratch: the port or the name it announces may
// have moved, and those are baked into a live listener.
async function applyWakeSetting(id) {
  await disarmWake(id);
  syncWake(id);
}

// On boot every stopped server that wants a listener needs it put back (the
// ones still running under their hosts were adopted first, and need none).
function initWake() {
  for (const def of store.all()) syncWake(def.id);
}

function closeWakeListeners() {
  return Promise.all(store.all().map((def) => disarmWake(def.id)));
}

// The Properties tab edits `pause-when-empty-seconds` directly and the Settings
// switch writes the same key, so a hand edit would otherwise be silently undone
// the next time start() re-applies the switch. Read the file back instead and
// let it win: the two become views of one value rather than rival writers.
function syncPauseFromProperties(id) {
  const def = store.find(id);
  if (!def) return;
  const line = readProperties(id)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("pause-when-empty-seconds="));
  if (!line) return;
  const n = Number(line.slice(line.indexOf("=") + 1).trim());
  if (!Number.isFinite(n)) return;
  const next = n > 0 ? n : 0; // -1 (or anything <= 0) is the file's way of "off"
  if (next === (Number(def.pauseWhenEmpty) || 0)) return;
  store.update(id, { pauseWhenEmpty: next });
  events.emit("event", { type: "status", ...summary(id) });
}

function applyPauseProperty(id) {
  const def = store.find(id);
  if (!def || !supportsPause(def.mc) || !readProperties(id)) return;
  patchProperties(id, { "pause-when-empty-seconds": pauseSeconds(def) });
}

function writeInitialProperties(def) {
  if (fs.existsSync(propsPath(def.id))) {
    patchProperties(def.id, { "server-port": def.port, "max-players": def.maxPlayers });
    return;
  }
  patchProperties(def.id, {
    "server-port": def.port,
    "max-players": def.maxPlayers,
    motd: `${def.name} — powered by MC Hoster`,
    "online-mode": "true",
    "enable-command-block": "true",
  });
}

function isEulaAccepted(id) {
  try {
    return /eula\s*=\s*true/i.test(fs.readFileSync(eulaPath(id), "utf8"));
  } catch {
    return false;
  }
}
function ensureEula(id, accepted) {
  fs.writeFileSync(
    eulaPath(id),
    `# Minecraft EULA — https://aka.ms/MinecraftEULA\neula=${accepted ? "true" : "false"}\n`
  );
}
function setEula(id, accepted) {
  ensureEula(id, accepted);
  events.emit("event", { type: "status", ...summary(id) });
  return accepted;
}

/* ------------------------------------------------------------------- launch */

function buildJvm(def) {
  const mem = Math.max(512, Number(def.memory) || 2048);
  const args = [`-Xmx${mem}M`, `-Xms${Math.max(512, Math.floor(mem / 2))}M`, "-Dfile.encoding=UTF-8"];
  const extra = (def.jvmArgs || "").trim();
  if (extra) args.push(...extra.split(/\s+/));
  return args;
}

const BUSY = {
  backup: "A backup is being made — hang on.",
  restore: "A backup is being restored — hang on.",
  copy: "This server is being copied to a new one — hang on.",
  export: "This server is being exported — hang on.",
};

// `manual` is someone pressing Start: that is a fresh go, so the crash and lag
// guards forget what they had counted against the previous runs.
async function start(id, { manual = false } = {}) {
  const def = store.find(id);
  if (!def) return { ok: false, error: "No such server" };
  const s = slot(id);
  if (s.proc) return { ok: false, error: "Already running" };
  cancelPendingRestart(id);
  if (manual) {
    s.crashes = [];
    s.crashGaveUp = false;
    s.lagRestarts = [];
    s.lagGaveUp = false;
  }
  if (s.install.active) return { ok: false, error: "Still installing" };
  if (!def.start) return { ok: false, error: "Server was never installed successfully" };
  if (!isEulaAccepted(id))
    return { ok: false, error: "You must accept the Minecraft EULA before starting." };

  if (s.preparing) return { ok: false, error: "Still preparing the Java runtime — hang on." };
  // A restore is swapping the world out from under it, and booting mid-backup
  // would change files that are halfway into the zip.
  if (s.backup)
    return { ok: false, error: BUSY[s.backup.kind] || BUSY.backup };

  // Match the runtime to the game version. Modern Minecraft (26.x) needs Java
  // 25; running it on an older JVM dies with UnsupportedClassVersionError
  // before the server prints anything useful, so catch it here instead.
  const required = await java.requiredMajor(def.mc);
  const override = def.javaPath || store.getSettings().javaPath || null;
  let jv = null;
  if (override && fs.existsSync(override)) jv = await java.probe(override);
  if (!jv) {
    const { javas } = await java.discover();
    jv = java.pick(javas, required);
  }

  if (!jv) {
    // Nothing on this machine can run it — fetch a JRE, then start for real.
    s.preparing = true;
    setStatus(id, "installing");
    emitConsole(
      id,
      "sys",
      `[hoster] Minecraft ${def.mc} needs Java ${required}, which isn't installed. Fetching it…`
    );
    (async () => {
      try {
        await java.install(required, (line) => emitConsole(id, "sys", "[hoster] " + line));
        s.preparing = false;
        setStatus(id, "stopped");
        const r = await start(id);
        if (!r.ok) emitConsole(id, "err", "[hoster] " + r.error);
      } catch (e) {
        s.preparing = false;
        emitConsole(id, "err", "[hoster] Could not install Java " + required + ": " + e.message);
        setStatus(id, "crashed");
      }
    })();
    return { ok: true, preparing: true, message: `Downloading Java ${required}…` };
  }

  if (jv.major && jv.major < required) {
    const msg =
      `Java ${jv.version} is too old for Minecraft ${def.mc}, which needs Java ${required}. ` +
      (override
        ? "Clear the Java override in Settings to let MC Hoster fetch the right runtime."
        : `Install Temurin ${required}, or clear the Java path so one can be downloaded.`);
    emitConsole(id, "err", "[hoster] " + msg);
    return { ok: false, error: msg };
  }

  const dir = store.dirFor(id);
  const props = { "server-port": def.port, "max-players": def.maxPlayers };
  if (supportsPause(def.mc)) props["pause-when-empty-seconds"] = pauseSeconds(def);
  patchProperties(id, props);
  try {
    voicechat.prepare(id); // its port and address, read by the mod as it loads
  } catch (e) {
    emitConsole(id, "err", "[hoster] Could not write the voice chat config: " + e.message);
  }

  const jvm = buildJvm(def);
  let launchArgs;
  if (def.start.type === "args") {
    launchArgs = [...jvm, `@${def.start.argsFile}`, ...(def.start.args || [])];
  } else {
    launchArgs = [...jvm, "-jar", def.start.jar, ...(def.start.args || [])];
  }

  emitConsole(id, "sys", `[hoster] Starting with Java ${jv.version} (Minecraft ${def.mc} wants ${required})`);
  emitConsole(id, "sys", `[hoster] ${path.basename(jv.path)} ${launchArgs.join(" ")}`);

  await disarmWake(id); // we may be holding this server's own port

  let proc;
  try {
    const spec = { file: jv.path, args: launchArgs, cwd: dir };
    proc = keepRunning() ? hosted.launch(hostKey(id), spec) : hosted.direct(spec);
  } catch (e) {
    emitConsole(id, "err", "[hoster] failed to launch: " + e.message);
    setStatus(id, "crashed");
    return { ok: false, error: e.message };
  }

  s.startedAt = Date.now();
  s.stopRequested = false;
  s.runningAt = null;
  s.poorSince = null;
  // Remembered across panel restarts: "start with panel" brings back only the
  // servers that were meant to be up, not ones somebody stopped.
  if (!def.wantRunning) store.update(id, { wantRunning: true });
  s.players = [];
  s.paused = false;
  s.asleep = false;
  attach(id, proc);
  if (def.playit && def.playit.enabled) playit.sync(0); // tunnel up before players arrive
  setStatus(id, "starting");
  events.emit("event", { type: "players", id, players: [] });
  // Its first lines arrive with the host's hello; from then on, line by line.
  proc.once("hello", (h) => {
    if (s.proc !== proc) return;
    for (const [seq, , st, line] of h.lines || []) if (seq > (h.delivered || 0)) onLine(id, line, st);
  });
  return { ok: true };
}

// Everything a running server's handle needs wired up, whether we just
// started it or found it still running after a panel restart.
function attach(id, proc) {
  const s = slot(id);
  const def = store.find(id);
  s.proc = proc;
  s.pid = proc.pid || null;
  s.pingSupport = "unknown";
  s.pingProbes = 0;
  setPings(id, {});
  perf.begin(id, {
    pid: () => s.pid,
    def: () => store.find(id),
    players: () => s.players,
    status: () => s.status,
    paused: () => s.paused,
    startedAt: () => s.startedAt,
    supportsPause: supportsPause(def && def.mc),
    write: (cmd) => s.proc === proc && proc.write(cmd + "\n"),
  });
  proc.on("hello", (h) => {
    if (s.proc !== proc) return;
    s.pid = h.pid || s.pid;
    if (h.startedAt) s.startedAt = h.startedAt;
  });
  proc.on("line", (line, stream) => {
    if (s.proc === proc) onLine(id, line, stream);
  });
  proc.on("exit", (code, signal, error) => onExit(id, proc, code, signal, error));
}

function onLine(id, line, stream) {
  const r = perf.intercept(id, line);
  if (r === true) return; // a reply to one of our own probes
  for (const l of Array.isArray(r) ? r : [line]) {
    emitConsole(id, stream, l);
    parseLine(id, l);
  }
}

function onExit(id, proc, code, signal, error) {
  const s = slot(id);
  if (s.proc !== proc) return;
  if (s.stopTimer) clearTimeout(s.stopTimer);
  s.stopTimer = null;
  if (s.sleepTimer) clearTimeout(s.sleepTimer);
  s.sleepTimer = null;
  clearLagTimer(id);
  clearScheduledStop(id);
  s.paused = false;
  s.runningAt = null;
  s.poorSince = null;
  // A force kill from the panel is still a stop someone asked for.
  const graceful = s.stopRequested || s.status === "stopping" || code === 0;
  s.stopRequested = false;
  if (error) emitConsole(id, "err", "[hoster] " + error);
  emitConsole(id, "sys", `[hoster] Process exited (code ${code ?? signal ?? "unknown"}).`);
  // Whoever was still on is off now — close their sessions at this instant
  // so the playtime totals don't run on while the process is gone.
  playerlog.closeAll(id, graceful ? "server stopped" : "server crashed");
  playerlog.serverEvent(id, graceful ? "Server stopped." : `Server crashed (exit code ${code ?? signal ?? "unknown"}).`);
  s.proc = null;
  s.pid = null;
  s.startedAt = null;
  s.players = [];
  perf.end(id);
  // Stopped on purpose (the Stop button, `stop` typed in the console, deep
  // sleep) means it shouldn't come back on its own after a panel restart. A
  // crash leaves the wish standing. The panel shutting down is neither.
  if (graceful && !shuttingDown && store.find(id) && store.find(id).wantRunning)
    store.update(id, { wantRunning: false });
  setStatus(id, graceful ? "stopped" : "crashed");
  events.emit("event", { type: "players", id, players: [] });
  if (!graceful) onCrash(id);
}

/* ------------------------------------------------- surviving a panel restart */
/*
 * With servers under their own hosts, a panel that starts up may find some of
 * them already running. It takes them back exactly where they are: the
 * console as it was, anything printed while no panel was listening read as if
 * it had just happened (so joins, leaves and chat land in the player log), and
 * the player list checked against the server's own `list`.
 */
const PROBE_REPLY = [
  /^The game (?:is|runs)/i, /^Target tick rate/i, /^Average time per tick/i, /^Percentiles:/i,
  /^Test (?:passed|failed)\b/i, /^The time is \d+/i, /TPS from last/i, /Server tick times/i,
  /Mean tick time/i, /TPS \([0-9.,]+ ?ms\/tick\)/i, /(?:'s|s') ping is \d+/i,
  /Unknown or incomplete command/i, /<--\[HERE\]/, /^There are \d+ (?:of a max|out of maximum)/i,
];

async function adoptAll() {
  const known = new Set(store.all().map((d) => hostKey(d.id)));
  await Promise.all(
    store.all().map(async (def) => {
      const id = def.id;
      let r = { handle: null, exit: null };
      try {
        r = await hosted.adopt(hostKey(id));
      } catch {}
      if (r.handle) return adopt(id, r.handle, r.hello);
      // Not running. Anyone the log still has online went with it.
      playerlog.closeStale(id);
      if (r.exit) {
        const how = r.exit.error ? r.exit.error : `exit code ${r.exit.code ?? r.exit.signal ?? "unknown"}`;
        emitConsole(id, "sys", `[hoster] This server stopped while the panel was closed (${how}).`);
        playerlog.serverEvent(id, `Server stopped while the panel was closed (${how}).`);
      }
    })
  );
  // Hosts left behind by servers deleted while they ran elsewhere.
  for (const key of hosted.knownKeys()) {
    if (!key.startsWith("srv-") || known.has(key)) continue;
    hosted.adopt(key).then((r) => r.handle && r.handle.kill()).catch(() => {});
  }
}

function adopt(id, proc, hello) {
  const s = slot(id);
  const def = store.find(id);
  s.startedAt = hello.startedAt || Date.now();
  s.stopRequested = false;
  s.poorSince = null;
  s.asleep = false;
  // The log's open sessions are our best idea of who is on, until `list` says.
  s.players = playerlog.onlineNames(id);
  attach(id, proc);
  s.pid = hello.pid || null;
  s.status = hello.ready ? "running" : "starting";
  if (hello.ready) {
    s.runningAt = Date.now(); // a fresh grace period for the lag watch
    startPings(id);
  }
  events.emit("event", { type: "status", ...summary(id) });

  const lines = hello.lines || [];
  const delivered = hello.delivered || 0;
  let paused = false;
  let savingOff = false;
  for (const [seq, at, st, line] of lines) {
    if (/Server empty for [0-9]+ seconds, pausing/.test(line)) paused = true;
    else if (/joined the game/.test(line)) paused = false;
    if (/Automatic saving is now disabled|Turned off world auto-saving/i.test(line)) savingOff = true;
    else if (/Automatic saving is now enabled|Turned on world auto-saving/i.test(line)) savingOff = false;
    if (seq <= delivered) {
      // Already seen by the panel before this one: back into the console as
      // it was, minus the answers to its own questions.
      const body = line.replace(/^\s*(?:\[[^\]]*\]\s*)+:?\s*(?:System chat: )?/, "");
      if (PROBE_REPLY.some((re) => re.test(body))) continue;
      s.log.push({ stream: st, line, t: at });
      if (s.log.length > LOG_CAP) s.log.shift();
    } else onLine(id, line, st); // printed while nobody was listening
  }
  const up = Math.round((Date.now() - s.startedAt) / 60000);
  emitConsole(id, "sys", `[hoster] Panel restarted — reconnected to this server (running ${up} min). It was never stopped.`);
  if (paused && !s.players.length) setPaused(id, true);
  // A backup that was cut off by the restart would leave autosave off.
  if (savingOff) {
    emitConsole(id, "sys", "[hoster] Autosave was left off (a backup was interrupted) — turning it back on.");
    sendCommand(id, "save-on");
  }
  playerlog.serverEvent(id, "Panel restarted; the server kept running.");
  if (def && def.playit && def.playit.enabled) playit.sync(0);
  if (s.status === "running") checkPlayers(id);
  armSleepTimer(id);
}

// Ask the server who is on, and make the log agree: whoever left while the
// panel was away is signed out, whoever arrived is signed in.
function checkPlayers(id) {
  const s = slot(id);
  if (s.paused) return reconcilePlayers(id, []);
  let expect = null;
  perf.probe(id, {
    key: "list",
    cmd: "list",
    timeout: 6000,
    onLine(body) {
      if (expect != null) {
        const names = body.split(/,\s*|:\s+/).map((n) => n.trim()).filter((n) => /^[A-Za-z0-9_]{2,16}$/.test(n));
        reconcilePlayers(id, names.slice(-expect));
        return true;
      }
      const m = /^There are (\d+) (?:of a max(?: of)?|out of maximum) \d+ players online[:.]?\s*(.*)$/i.exec(body);
      if (!m) return false;
      const count = Number(m[1]);
      const names = m[2].split(/,\s*/).map((n) => n.trim()).filter((n) => /^[A-Za-z0-9_]{2,16}$/.test(n));
      if (count > 0 && !names.length) {
        expect = count; // Paper puts the names on the next line, by group
        return "more";
      }
      reconcilePlayers(id, names);
      return true;
    },
  });
}

function reconcilePlayers(id, names) {
  const s = slot(id);
  for (const n of s.players.filter((p) => !names.includes(p))) playerlog.leave(id, n, "left while the panel was closed");
  for (const n of names.filter((p) => !s.players.includes(p))) playerlog.join(id, n);
  s.players = names.slice();
  events.emit("event", { type: "players", id, players: s.players });
  if (s.players.length) setPaused(id, false);
  armSleepTimer(id);
  if (!s.players.length) scheduleEmptied(id);
}

// Recognise lifecycle + player events from server console output.
function parseLine(id, line) {
  const s = slot(id);
  // Chat, deaths, advancements and connection details go to the durable log
  // before anything below can change who counts as online.
  playerlog.observe(id, line, s.players);
  perf.observe(id, line); // lag warnings, startup time
  if (/\)! For help, type "help"|Done \(|Timings Reset/.test(line) || /: Done \(/.test(line)) {
    if (s.status === "starting") {
      s.runningAt = Date.now();
      setStatus(id, "running");
      playerlog.serverEvent(id, "Server is up and accepting players.");
    }
  }
  // "Server empty for 60 seconds, pausing" — 1.21.2+ parking its tick loop.
  if (/Server empty for [0-9]+ seconds, pausing/.test(line)) setPaused(id, true);
  let m;
  if ((m = /(?:^|: )([A-Za-z0-9_]{2,16}) joined the game/.exec(line))) {
    if (!s.players.includes(m[1])) {
      s.players.push(m[1]);
      playerlog.join(id, m[1]);
      setPaused(id, false); // whoever joined just woke it up
      armSleepTimer(id);
      events.emit("event", { type: "players", id, players: s.players });
      setTimeout(() => pollPings(id), 1500); // let them finish connecting first
    }
  } else if ((m = /(?:^|: )([A-Za-z0-9_]{2,16}) left the game/.exec(line))) {
    if (s.players.includes(m[1])) playerlog.leave(id, m[1], playerlog.dropReason(id, m[1]));
    s.players = s.players.filter((p) => p !== m[1]);
    if (m[1] in s.pings) {
      const rest = { ...s.pings };
      delete rest[m[1]];
      setPings(id, rest);
    }
    events.emit("event", { type: "players", id, players: s.players });
    armSleepTimer(id); // that may have been the last one out
    if (!s.players.length) scheduleEmptied(id);
  }
}

/* --------------------------------------------------------------- player ping */
/*
 * Minecraft servers never print latency, so the only plugin-free way to learn a
 * player's ping is to ask the console: Paper/Purpur (and Essentials-style
 * plugins) answer `ping <name>` with "<name>'s ping is 42ms". We probe one
 * player after startup and, if the command doesn't exist — vanilla and most
 * modded servers — quietly stop asking and the UI just shows no number. The
 * probes share perf.js's console queue with the TPS questions, which is what
 * keeps each reply (and each "Unknown command") paired with the command that
 * caused it, and out of the console view.
 */
const PING_EVERY = 5000;
const PING_TRIES = 3; // give up if the first few probes go unanswered
const PING_REPLY = /([A-Za-z0-9_]{2,16})(?:'s|s') ping is (\d+)/i;

function startPings(id) {
  const s = slot(id);
  if (s.pingTimer || s.pingSupport === "no") return;
  s.pingTimer = setInterval(() => pollPings(id), PING_EVERY);
}

function stopPings(id) {
  const s = slot(id);
  if (s.pingTimer) clearInterval(s.pingTimer);
  s.pingTimer = null;
  setPings(id, {});
}

function setPings(id, pings) {
  const s = slot(id);
  const same =
    Object.keys(pings).length === Object.keys(s.pings).length &&
    Object.keys(pings).every((k) => s.pings[k] === pings[k]);
  if (same) return;
  s.pings = pings;
  events.emit("event", { type: "pings", id, pings });
}

function pollPings(id) {
  const s = slot(id);
  if (!s.proc || s.status !== "running") return;
  if (s.pingSupport === "no") return;
  if (!s.players.length) return setPings(id, {});
  if (s.pingSupport === "unknown" && ++s.pingProbes > PING_TRIES) {
    s.pingSupport = "no";
    return stopPings(id);
  }
  // Until we know the command works, bother the server about one player only.
  const names = s.pingSupport === "yes" ? s.players : s.players.slice(0, 1);
  for (const name of names)
    perf.probe(id, {
      key: "ping:" + name,
      cmd: "ping " + name,
      timeout: 4000,
      onLine(body) {
        const m = PING_REPLY.exec(body);
        if (!m || m[1].toLowerCase() !== name.toLowerCase()) return false;
        s.pingSupport = "yes";
        if (s.players.includes(name)) setPings(id, { ...s.pings, [name]: Number(m[2]) });
        return true;
      },
      onUnknown() {
        s.pingSupport = "no";
        stopPings(id);
      },
    });
}

function sendCommand(id, cmd) {
  const s = slot(id);
  if (!s.proc || !s.proc.writable) return { ok: false, error: "Server is not running" };
  emitConsole(id, "sys", "> " + cmd);
  // No setPaused(false) here: a paused server still reads its console and runs
  // the command, but goes on sleeping — only a player joining wakes it, and it
  // never prints "pausing" again to tell us it is still parked.
  perf.external(id); // so an "Unknown command" reply is pinned on this, not a TPS probe
  s.proc.write(cmd.replace(/[\r\n]+$/, "") + "\n");
  return { ok: true };
}

// Force-kill whatever this server is running, through its handle.
function killServer(id) {
  const s = slot(id);
  if (s.proc) s.proc.kill();
  else hosted.killPid(s.pid);
}

function stop(id, { force = false, auto = false } = {}) {
  const s = slot(id);
  // Stop on a crashed server that is counting down to a restart calls it off.
  if (!s.proc && s.restartTimer) return cancelRestart(id);
  if (!s.proc) return { ok: false, error: "Not running" };
  // Only a deep sleep leaves the server flagged asleep; a manual stop is just
  // stopped, and should not come back wearing the sleeping badge.
  s.asleep = auto;
  s.stopRequested = true;
  clearLagTimer(id);
  if (force) {
    emitConsole(id, "sys", "[hoster] Force killing…");
    killServer(id);
    return { ok: true };
  }
  setStatus(id, "stopping");
  emitConsole(id, "sys", "[hoster] Stopping (saving world)…");
  if (!s.proc.write("stop\n")) killServer(id);
  // Escalate to a hard kill if it doesn't shut down in time.
  s.stopTimer = setTimeout(() => {
    if (s.proc) {
      emitConsole(id, "sys", "[hoster] Still running after 25s — force killing.");
      killServer(id);
    }
  }, 25000);
  return { ok: true };
}

async function restart(id) {
  const s = slot(id);
  if (s.proc) {
    await new Promise((resolve) => {
      const done = () => resolve();
      events.once("event", function wait(e) {
        if (e.type === "status" && e.id === id && (e.status === "stopped" || e.status === "crashed"))
          done();
        else events.once("event", wait);
      });
      stop(id);
      setTimeout(done, 30000); // safety
    });
  }
  return start(id);
}

/* ---------------------------------------------------------- self-healing */
/*
 * Three ways a server gets itself back up without anyone at the keyboard:
 *
 *   - Restart on crash (on unless switched off): a crash is followed by a
 *     fresh start a few seconds later. A server that keeps crashing — a broken
 *     mod, a corrupt chunk — would otherwise boot-loop forever, so after a few
 *     crashes close together it is left down for a person to look at.
 *   - Restart on poor performance (off unless switched on): TPS below a floor
 *     for long enough gets a restart, with a warning in chat first if anyone
 *     is on. Same kind of guard, so a server that is simply too much for the
 *     machine doesn't spend its life rebooting.
 *   - Start with panel: on boot the panel starts every server that has it on
 *     and was meant to be running when the panel went away.
 */
const CRASH_DELAY = 10000;
const CRASH_LIMIT = 3; // this many crashes inside the window and we stop trying
const CRASH_WINDOW = 10 * 60000;

const LAG_GRACE = 5 * 60000; // boot and spawn generation lag; don't judge it yet
const LAG_WARN = 30000; // how long players get between the chat warning and the restart
const LAG_LIMIT = 3; // performance restarts allowed inside the window
const LAG_WINDOW = 3 * 3600000;

const AUTOSTART_GAP = 20000; // between servers, so a small machine isn't swamped at boot

let shuttingDown = false;

const restartOnCrash = (def) => !!def && def.restartOnCrash !== false;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function cancelPendingRestart(id) {
  const s = slot(id);
  if (!s.restartTimer) return false;
  clearTimeout(s.restartTimer);
  s.restartTimer = null;
  s.restartAt = null;
  return true;
}

function clearLagTimer(id) {
  const s = slot(id);
  if (s.lagTimer) clearTimeout(s.lagTimer);
  s.lagTimer = null;
  s.lagRestartAt = null;
}

function onCrash(id) {
  const s = slot(id);
  const def = store.find(id);
  if (shuttingDown || !restartOnCrash(def)) return;
  const now = Date.now();
  s.crashes = s.crashes.filter((t) => now - t < CRASH_WINDOW);
  s.crashes.push(now);
  if (s.crashes.length >= CRASH_LIMIT) {
    const msg =
      `Crashed ${s.crashes.length} times in ${CRASH_WINDOW / 60000} minutes — not restarting it again. ` +
      "Check the console for the cause, then start it yourself.";
    s.crashes = [];
    s.crashGaveUp = true;
    emitConsole(id, "err", "[hoster] " + msg);
    playerlog.serverEvent(id, msg);
    events.emit("event", { type: "status", ...summary(id) });
    return;
  }
  const left = CRASH_LIMIT - s.crashes.length;
  emitConsole(
    id,
    "sys",
    `[hoster] Restarting in ${CRASH_DELAY / 1000}s. ` +
      `${left} more ${left === 1 ? "crash" : "crashes"} in the next ${CRASH_WINDOW / 60000} minutes and it stays down.`
  );
  playerlog.serverEvent(id, "Restarting automatically after the crash.");
  s.restartAt = now + CRASH_DELAY;
  s.restartTimer = setTimeout(() => {
    s.restartTimer = null;
    s.restartAt = null;
    if (s.proc || !store.find(id) || shuttingDown) return;
    start(id)
      .then((r) => {
        if (!r.ok) {
          emitConsole(id, "err", "[hoster] Automatic restart failed: " + r.error);
          events.emit("event", { type: "status", ...summary(id) });
        }
      })
      .catch((e) => emitConsole(id, "err", "[hoster] Automatic restart failed: " + e.message));
  }, CRASH_DELAY);
  events.emit("event", { type: "status", ...summary(id) });
}

// Called on every fresh perf sample (every 5 s) of a live server.
function watchPerformance(id, stats) {
  const s = slot(id);
  const def = store.find(id);
  const floor = Number(def && def.lagRestartTps) || 0;
  const mins = Math.max(1, Number(def && def.lagRestartMins) || 10);
  const now = Date.now();
  if (!floor || s.status !== "running" || s.lagTimer || s.lagGaveUp) {
    s.poorSince = null;
    return;
  }
  if (!s.runningAt || now - s.runningAt < LAG_GRACE || stats.idle) {
    s.poorSince = null; // still settling in, or paused and not ticking at all
    return;
  }
  const tps = stats.point.tps; // null when the last reading has gone stale
  if (tps != null) {
    if (tps >= floor) {
      s.poorSince = null;
      return;
    }
    if (!s.poorSince) s.poorSince = now;
  }
  // A server lagging badly enough can miss its TPS probe; a missing reading
  // inside a low streak keeps the streak going rather than resetting it.
  if (!s.poorSince || now - s.poorSince < mins * 60000) return;
  s.poorSince = null;

  s.lagRestarts = s.lagRestarts.filter((t) => now - t < LAG_WINDOW);
  if (s.lagRestarts.length >= LAG_LIMIT) {
    s.lagGaveUp = true;
    const msg =
      `TPS is below ${floor} again, but it has already been restarted ${s.lagRestarts.length} times in ` +
      `${LAG_WINDOW / 3600000} hours — leaving it running. Restarts aren't fixing this one; check the Stats tab.`;
    emitConsole(id, "err", "[hoster] " + msg);
    playerlog.serverEvent(id, msg);
    return;
  }
  s.lagRestarts.push(now);

  const why = `TPS has been below ${floor} for ${plural(mins, "minute")}`;
  const go = () => {
    clearLagTimer(id);
    if (!s.proc || s.status !== "running") return;
    events.emit("event", { type: "status", ...summary(id) });
    restart(id).catch((e) => emitConsole(id, "err", "[hoster] Performance restart failed: " + e.message));
  };
  playerlog.serverEvent(id, `${why} — restarting to recover.`);
  if (s.players.length) {
    emitConsole(id, "sys", `[hoster] ${why} — restarting in ${LAG_WARN / 1000}s. Players have been warned.`);
    sendCommand(id, `say Server restarting in ${LAG_WARN / 1000} seconds to fix lag. Rejoin in a minute or two.`);
    s.lagRestartAt = now + LAG_WARN;
    s.lagTimer = setTimeout(go, LAG_WARN);
    events.emit("event", { type: "status", ...summary(id) });
  } else {
    emitConsole(id, "sys", `[hoster] ${why} — restarting now (nobody is online).`);
    go();
  }
}

// The banner's Cancel button: call off whichever automatic restart is pending.
function cancelRestart(id) {
  const s = slot(id);
  if (s.proc && (s.schedStopAt || s.schedWaiting)) return cancelScheduledStop(id);
  const crash = cancelPendingRestart(id);
  const lag = !!s.lagTimer;
  if (lag) {
    clearLagTimer(id);
    s.lagRestarts.pop(); // it never happened, so it doesn't count toward the limit
  }
  if (!crash && !lag) return { ok: false, error: "No restart is pending" };
  emitConsole(id, "sys", "[hoster] Automatic restart cancelled.");
  if (lag && s.proc) sendCommand(id, "say Restart cancelled.");
  events.emit("event", { type: "status", ...summary(id) });
  return { ok: true };
}

// Settings changed in the panel: drop anything the new values no longer want.
function applyRestartSettings(id) {
  const s = slot(id);
  const def = store.find(id);
  if (!restartOnCrash(def) && cancelPendingRestart(id))
    emitConsole(id, "sys", "[hoster] Automatic restart cancelled — restart on crash is now off.");
  if (!(Number(def && def.lagRestartTps) > 0) && s.lagTimer) {
    clearLagTimer(id);
    emitConsole(id, "sys", "[hoster] Performance restart cancelled — the setting is now off.");
  }
  s.poorSince = null; // a new threshold starts a new streak
  s.lagGaveUp = false;
}

/* ---------------------------------------------------------- scheduled uptime */
/*
 * A server can have opening hours (lib/uptime.js does the clock arithmetic).
 * The panel acts at the edges only: when a window opens it starts the server,
 * when the last one closes it stops it. In between, Start and Stop work as
 * always, so stopping it mid-evening or starting it at 3 am for a friend
 * sticks until the next edge.
 *
 * Which side of the edge the panel last acted on is kept in the definition
 * (`uptimeInside`), so an edge that passed while the panel was closed is
 * still acted on when it comes back, and a restart never repeats one.
 *
 * Closing time with players on either warns them in chat and stops after a few
 * minutes, or waits until the last one leaves. Either way the banner on the
 * server page can call it off, and an empty server stops at once.
 */
const SCHEDULE_EVERY = 20000;

function scheduleInfo(def) {
  const sch = uptime.normalize(def.uptime);
  if (!sch.on) return null;
  return { inside: uptime.inside(sch), next: uptime.next(sch) };
}

function clearScheduledStop(id) {
  const s = slot(id);
  if (s.schedTimer) clearTimeout(s.schedTimer);
  const had = !!(s.schedStopAt || s.schedWaiting);
  s.schedTimer = null;
  s.schedStopAt = null;
  s.schedWaiting = false;
  return had;
}

function checkSchedule(id) {
  const def = store.find(id);
  const s = slot(id);
  if (!def) return;
  const sch = uptime.normalize(def.uptime);
  if (!sch.on) return;
  const want = uptime.inside(sch);
  if (def.uptimeInside === want) return;
  // Not ready to be started or stopped: try again on the next pass.
  if (!def.start || s.install.active || s.preparing || s.backup) return;
  store.update(id, { uptimeInside: want });
  if (want) scheduledStart(id);
  else scheduledStop(id, sch);
}

function scheduledStart(id) {
  const s = slot(id);
  if (clearScheduledStop(id)) {
    emitConsole(id, "sys", "[hoster] Scheduled hours have started again — it stays up.");
    if (s.proc) sendCommand(id, "say Never mind, the server is staying up.");
    events.emit("event", { type: "status", ...summary(id) });
  }
  if (s.proc || s.restartTimer) return; // up already, or about to be
  emitConsole(id, "sys", "[hoster] Scheduled uptime — starting.");
  // A fresh window is a fresh go, as if someone pressed Start.
  start(id, { manual: true })
    .then((r) => {
      if (r.ok) playerlog.serverEvent(id, "Started on schedule.");
      else emitConsole(id, "err", "[hoster] Couldn't start on schedule: " + r.error);
    })
    .catch((e) => emitConsole(id, "err", "[hoster] Couldn't start on schedule: " + e.message));
}

function scheduledStop(id, sch) {
  const s = slot(id);
  if (!s.proc) {
    // A crash restart counting down would bring it back after hours.
    if (cancelPendingRestart(id)) {
      emitConsole(id, "sys", "[hoster] Automatic restart called off — it's outside scheduled hours.");
      events.emit("event", { type: "status", ...summary(id) });
    }
    return;
  }
  if (s.status === "stopping") return;
  if (!s.players.length || s.status !== "running") return scheduledDown(id);
  const who = plural(s.players.length, "player");
  if (sch.players === "wait") {
    s.schedWaiting = true;
    emitConsole(id, "sys", `[hoster] Scheduled hours are over — waiting for ${who} to leave, then stopping.`);
    playerlog.serverEvent(id, `Scheduled hours are over; stopping once ${who} ${s.players.length === 1 ? "has" : "have"} left.`);
    sendCommand(id, "say Scheduled hours are over. The server will shut down after the last player leaves.");
  } else {
    s.schedStopAt = Date.now() + sch.warnMins * 60000;
    emitConsole(id, "sys", `[hoster] Scheduled hours are over — stopping in ${plural(sch.warnMins, "minute")}. Players have been warned.`);
    playerlog.serverEvent(id, `Scheduled hours are over; stopping in ${plural(sch.warnMins, "minute")}.`);
    sendCommand(id, `say Server closing in ${plural(sch.warnMins, "minute")} (scheduled downtime).`);
    scheduleCountdown(id);
  }
  events.emit("event", { type: "status", ...summary(id) });
}

// One timer at a time: to the next reminder (a minute out, ten seconds out),
// then to the stop itself.
function scheduleCountdown(id) {
  const s = slot(id);
  const left = s.schedStopAt - Date.now();
  if (left <= 500) return scheduledDown(id);
  const mark = [60000, 10000].find((m) => m < left - 1000) || 0;
  s.schedTimer = setTimeout(() => {
    s.schedTimer = null;
    if (!s.proc || !s.schedStopAt) return;
    if (mark) sendCommand(id, `say Server closing in ${mark >= 60000 ? "1 minute" : mark / 1000 + " seconds"}.`);
    scheduleCountdown(id);
  }, left - mark);
}

function scheduledDown(id) {
  clearScheduledStop(id);
  emitConsole(id, "sys", "[hoster] Outside scheduled hours — stopping.");
  playerlog.serverEvent(id, "Stopped on schedule.");
  stop(id);
}

// The last player left: closing time doesn't need to wait any more.
function scheduleEmptied(id) {
  const s = slot(id);
  if (s.proc && (s.schedStopAt || s.schedWaiting)) scheduledDown(id);
}

// The banner's "Keep it running": it stays up until the next closing time.
function cancelScheduledStop(id) {
  if (!clearScheduledStop(id)) return { ok: false, error: "No scheduled stop is pending" };
  emitConsole(id, "sys", "[hoster] Scheduled stop cancelled — it stays up until the next closing time.");
  sendCommand(id, "say Scheduled shutdown cancelled.");
  events.emit("event", { type: "status", ...summary(id) });
  return { ok: true };
}

// Settings changed. A new schedule is applied straight away, both ways: a
// stopped server inside its new hours starts, a running one outside them gets
// its closing time. Saving an unchanged schedule leaves things alone.
function applyUptimeSetting(id, changed) {
  const def = store.find(id);
  if (!def) return;
  const sch = uptime.normalize(def.uptime);
  const s = slot(id);
  if ((!sch.on || uptime.inside(sch)) && clearScheduledStop(id)) {
    emitConsole(id, "sys", "[hoster] Scheduled stop cancelled — the schedule changed.");
    if (s.proc) sendCommand(id, "say Scheduled shutdown cancelled.");
  }
  if (changed) store.update(id, { uptimeInside: null });
  checkSchedule(id);
  events.emit("event", { type: "status", ...summary(id) });
}

function initSchedule() {
  const pass = () => {
    for (const def of store.all())
      try {
        checkSchedule(def.id);
      } catch (e) {
        console.error("[schedule]", e && e.message);
      }
  };
  pass();
  setInterval(pass, SCHEDULE_EVERY).unref();
}

// On boot: bring back the servers that want it, one at a time.
async function autostart() {
  // Ones that kept running while the panel was away were picked up already.
  // A server on scheduled uptime is left to the schedule when it is outside
  // its hours, or when the schedule has a start or stop of its own to make.
  const due = store.all().filter((d) => {
    if (!d.startWithPanel || !d.wantRunning || !d.start || slot(d.id).proc) return false;
    const sch = uptime.normalize(d.uptime);
    return !sch.on || (uptime.inside(sch) && d.uptimeInside === true);
  });
  for (let i = 0; i < due.length; i++) {
    const def = due[i];
    if (shuttingDown) return;
    if (!store.find(def.id)) continue;
    emitConsole(def.id, "sys", "[hoster] Panel started — starting this server too (Start with panel is on).");
    try {
      const r = await start(def.id);
      if (r.ok) playerlog.serverEvent(def.id, "Started with the panel.");
      else emitConsole(def.id, "err", "[hoster] Couldn't start with the panel: " + r.error);
    } catch (e) {
      emitConsole(def.id, "err", "[hoster] Couldn't start with the panel: " + e.message);
    }
    if (i < due.length - 1) await new Promise((r) => setTimeout(r, AUTOSTART_GAP));
  }
}

// The panel is going away. Servers under their own host keep running and are
// simply let go of — the next panel picks them up again. Anything else is
// killed, without letting the crash handler restart it or the exit handler
// forget that it was meant to be up.
function shutdownAll() {
  shuttingDown = true;
  const keep = keepRunning();
  for (const def of store.all()) {
    const s = slot(def.id);
    cancelPendingRestart(def.id);
    clearLagTimer(def.id);
    // A closing time still counting down is made again by the next panel.
    if (s.schedStopAt || s.schedWaiting) store.update(def.id, { uptimeInside: true });
    clearScheduledStop(def.id);
    if (!s.proc) continue;
    if (keep && s.proc.detached) {
      s.proc.release();
      continue;
    }
    s.stopRequested = true; // logged as a stop, not a crash
    killServer(def.id);
  }
}

// Settings → "Stop all servers": a graceful stop for every running server.
function stopAll() {
  let n = 0;
  for (const def of store.all()) if (slot(def.id).proc && stop(def.id).ok) n++;
  return { ok: true, stopped: n };
}

// Remove a server: stop it, then delete its folder + definition. On Windows the
// folder can stay briefly locked (indexer/AV) after files are gone, so we retry.
function destroy(id) {
  const s = slot(id);
  if (s.wake) {
    s.wake.close();
    s.wake = null;
  }
  if (s.sleepTimer) clearTimeout(s.sleepTimer);
  cancelPendingRestart(id);
  clearLagTimer(id);
  clearScheduledStop(id);
  s.stopRequested = true; // the kill below is not a crash to recover from
  if (s.proc) killServer(id);
  playit.forget(id).catch(() => {});
  playerlog.forget(id);
  perf.forget(id);
  const dir = store.dirFor(id);
  rt.delete(id);
  store.remove(id);
  events.emit("event", { type: "servers" });

  const attempt = (tries) => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
    } catch (e) {
      if (tries > 0) return setTimeout(() => attempt(tries - 1), 1500);
      console.error(`[hoster] could not fully remove ${dir}: ${e.code || e.message}`);
    }
  };
  setTimeout(() => attempt(4), 800); // let the process fully release handles first
  return { ok: true };
}

/* ------------------------------------------------------------------ file mgr */

// Very small sandboxed file browser rooted at a server's folder.
function safeJoin(id, rel) {
  const root = store.dirFor(id);
  const full = path.resolve(root, rel || ".");
  if (!full.startsWith(path.resolve(root))) throw new Error("Path escapes server folder");
  return full;
}
function listFiles(id, rel) {
  const full = safeJoin(id, rel);
  const entries = fs.readdirSync(full, { withFileTypes: true }).map((e) => {
    let size = 0;
    try {
      size = e.isFile() ? fs.statSync(path.join(full, e.name)).size : 0;
    } catch {}
    return { name: e.name, dir: e.isDirectory(), size };
  });
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: rel || "", entries };
}
// Recursive name search below a folder. A world directory is tens of thousands
// of region files, so this is capped on both matches and depth and reports when
// it stopped early rather than pretending the list is complete.
function searchFiles(id, rel, query, limit = 300, maxDepth = 12) {
  const q = String(query || "").trim().toLowerCase();
  const base = rel || "";
  if (!q) return { path: base, query: "", entries: [], truncated: false };
  const entries = [];
  let truncated = false;

  const walk = (abs, prefix, depth) => {
    if (entries.length >= limit) { truncated = true; return; }
    let list;
    try { list = fs.readdirSync(abs, { withFileTypes: true }); }
    catch { return; }  // unreadable subtree: skip it, the rest still searches
    for (const e of list) {
      if (entries.length >= limit) { truncated = true; return; }
      const p = prefix ? prefix + "/" + e.name : e.name;
      if (e.name.toLowerCase().includes(q)) {
        let size = 0;
        try { size = e.isFile() ? fs.statSync(path.join(abs, e.name)).size : 0; } catch {}
        entries.push({ name: e.name, dir: e.isDirectory(), size, path: p });
      }
      if (e.isDirectory() && depth < maxDepth) walk(path.join(abs, e.name), p, depth + 1);
    }
  };
  walk(safeJoin(id, base), base, 0);

  entries.sort((a, b) => (a.dir === b.dir ? a.path.localeCompare(b.path) : a.dir ? -1 : 1));
  return { path: base, query: q, entries, truncated };
}
function readFile(id, rel) {
  const full = safeJoin(id, rel);
  if (fs.statSync(full).size > 2 * 1024 * 1024) throw new Error("File too large to edit here (>2MB).");
  return fs.readFileSync(full, "utf8");
}
function writeFile(id, rel, content) {
  fs.writeFileSync(safeJoin(id, rel), content);
}
function deleteFile(id, rel) {
  fs.rmSync(safeJoin(id, rel), { recursive: true, force: true });
}

// Batch delete and move both run per entry and collect failures rather than
// aborting on the first one: a selection of twelve files where one is locked
// should still move the other eleven, and the panel reports what was left.
function deleteFiles(id, rels) {
  const errors = [];
  let done = 0;
  for (const rel of rels) {
    try { deleteFile(id, rel); done++; }
    catch (e) { errors.push({ path: rel, error: e.message }); }
  }
  return { done, errors };
}

// Move keeps the entry's own name and only changes the folder it sits in.
function movePath(id, rel, destDir) {
  const from = safeJoin(id, rel);
  const dest = safeJoin(id, destDir);
  const name = path.basename(from);
  const to = path.join(dest, name);
  if (to === from) throw new Error(`${name} is already there`);
  // Dropping a folder inside itself would orphan the whole subtree.
  if ((to + path.sep).startsWith(from + path.sep)) throw new Error(`Can't move ${name} into itself`);
  if (fs.existsSync(to)) throw new Error(`${name} already exists there`);
  fs.mkdirSync(dest, { recursive: true });
  fs.renameSync(from, to);
}
function moveFiles(id, rels, destDir) {
  const errors = [];
  let done = 0;
  for (const rel of rels) {
    try { movePath(id, rel, destDir); done++; }
    catch (e) { errors.push({ path: rel, error: e.message }); }
  }
  return { done, errors };
}
function mkdir(id, rel) {
  fs.mkdirSync(safeJoin(id, rel), { recursive: true });
}
function saveUpload(id, rel, buffer) {
  const full = safeJoin(id, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, buffer);
}

module.exports = {
  events,
  playit,
  perf,
  slot,
  emitConsole,
  emitInstall,
  setStatus,
  newId,
  summary,
  listSummaries,
  create,
  start,
  stop,
  restart,
  cancelRestart,
  applyRestartSettings,
  applyUptimeSetting,
  initSchedule,
  autostart,
  adoptAll,
  shutdownAll,
  stopAll,
  keepRunning,
  destroy,
  sendCommand,
  setEula,
  isEulaAccepted,
  readProperties,
  writeProperties,
  patchProperties,
  writeInitialProperties,
  supportsPause,
  applyPauseProperty,
  syncPauseFromProperties,
  applySleepSetting,
  applyWakeSetting,
  initWake,
  closeWakeListeners,
  listFiles,
  searchFiles,
  readFile,
  writeFile,
  deleteFile,
  deleteFiles,
  moveFiles,
  mkdir,
  saveUpload,
};

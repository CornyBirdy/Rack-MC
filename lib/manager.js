/*
 * manager.js — the runtime brain. Owns every Minecraft server's lifecycle:
 * install → start → console I/O → stop, plus live status/players/stats that it
 * pushes out through a single EventEmitter (`events`). server.js turns those
 * events into SSE. Runtime state is in-memory; definitions live in store.js.
 */
const fs = require("fs");
const path = require("path");
const { spawn, exec, execFile } = require("child_process");
const { EventEmitter } = require("events");

const store = require("./store");
const loaders = require("./loaders");
const java = require("./java");
const playit = require("./playit");
const modrinth = require("./modrinth");
const wake = require("./wake");

const isWin = process.platform === "win32";
const LOG_CAP = 400; // console lines retained per server for replay
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
      pingWait: 0,
      pingProbes: 0,
      startedAt: null,
      stats: { memMB: 0, cpu: 0 },
      stopTimer: null,
      wake: null, // the stand-in listener holding the port while asleep
      paused: false, // Minecraft parked its own tick loop (light sleep)
      asleep: false, // we stopped it ourselves after it sat empty (deep sleep)
      sleepTimer: null,
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
    stats: s.stats,
    installing: s.install.active || s.preparing,
    eula: def ? isEulaAccepted(id) : false,
    playit: def ? playit.serverInfo(def) : { enabled: false, address: null, status: "off" },
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

// Servers do not survive a panel restart, so on boot every stopped one that
// wants a listener needs it put back.
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

async function start(id) {
  const def = store.find(id);
  if (!def) return { ok: false, error: "No such server" };
  const s = slot(id);
  if (s.proc) return { ok: false, error: "Already running" };
  if (s.install.active) return { ok: false, error: "Still installing" };
  if (!def.start) return { ok: false, error: "Server was never installed successfully" };
  if (!isEulaAccepted(id))
    return { ok: false, error: "You must accept the Minecraft EULA before starting." };

  if (s.preparing) return { ok: false, error: "Still preparing the Java runtime — hang on." };

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
    proc = spawn(jv.path, launchArgs, { cwd: dir, windowsHide: true });
  } catch (e) {
    emitConsole(id, "err", "[hoster] failed to launch: " + e.message);
    setStatus(id, "crashed");
    return { ok: false, error: e.message };
  }

  s.proc = proc;
  s.pid = proc.pid;
  s.startedAt = Date.now();
  if (def.playit && def.playit.enabled) playit.sync(0); // tunnel up before players arrive
  s.players = [];
  s.paused = false;
  s.asleep = false;
  s.pingSupport = "unknown";
  s.pingProbes = 0;
  setPings(id, {});
  setStatus(id, "starting");
  events.emit("event", { type: "players", id, players: [] });

  const onData = (buf, stream) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line) continue;
      if (interceptPing(id, line)) continue;
      emitConsole(id, stream, line);
      parseLine(id, line);
    }
  };
  proc.stdout.on("data", (d) => onData(d, "out"));
  proc.stderr.on("data", (d) => onData(d, "err"));
  proc.on("error", (e) => emitConsole(id, "err", "[hoster] " + e.message));
  proc.on("exit", (code, signal) => {
    if (s.stopTimer) clearTimeout(s.stopTimer);
    s.stopTimer = null;
    if (s.sleepTimer) clearTimeout(s.sleepTimer);
    s.sleepTimer = null;
    s.paused = false;
    const graceful = s.status === "stopping" || code === 0;
    emitConsole(id, "sys", `[hoster] Process exited (code ${code ?? signal}).`);
    s.proc = null;
    s.pid = null;
    s.startedAt = null;
    s.players = [];
    s.stats = { memMB: 0, cpu: 0 };
    setStatus(id, graceful ? "stopped" : "crashed");
    events.emit("event", { type: "players", id, players: [] });
    events.emit("event", { type: "stats", id, ...s.stats });
  });

  return { ok: true };
}

// Recognise lifecycle + player events from server console output.
function parseLine(id, line) {
  const s = slot(id);
  if (/\)! For help, type "help"|Done \(|Timings Reset/.test(line) || /: Done \(/.test(line)) {
    if (s.status === "starting") setStatus(id, "running");
  }
  // "Server empty for 60 seconds, pausing" — 1.21.2+ parking its tick loop.
  if (/Server empty for [0-9]+ seconds, pausing/.test(line)) setPaused(id, true);
  let m;
  if ((m = /(?:^|: )([A-Za-z0-9_]{2,16}) joined the game/.exec(line))) {
    if (!s.players.includes(m[1])) {
      s.players.push(m[1]);
      setPaused(id, false); // whoever joined just woke it up
      armSleepTimer(id);
      events.emit("event", { type: "players", id, players: s.players });
      setTimeout(() => pollPings(id), 1500); // let them finish connecting first
    }
  } else if ((m = /(?:^|: )([A-Za-z0-9_]{2,16}) left the game/.exec(line))) {
    s.players = s.players.filter((p) => p !== m[1]);
    if (m[1] in s.pings) {
      const rest = { ...s.pings };
      delete rest[m[1]];
      setPings(id, rest);
    }
    events.emit("event", { type: "players", id, players: s.players });
    armSleepTimer(id); // that may have been the last one out
  }
}

/* --------------------------------------------------------------- player ping */
/*
 * Minecraft servers never print latency, so the only plugin-free way to learn a
 * player's ping is to ask the console: Paper/Purpur (and Essentials-style
 * plugins) answer `ping <name>` with "<name>'s ping is 42ms". We probe one
 * player after startup and, if the command doesn't exist — vanilla and most
 * modded servers — quietly stop asking and the UI just shows no number. Probe
 * traffic never reaches the console view; see interceptPing.
 */
const PING_EVERY = 5000;
const PING_TRIES = 3; // give up if the first few probes go unanswered
const PING_REPLY = /([A-Za-z0-9_]{2,16})(?:'s|s') ping is (\d+)/i;
const PING_UNKNOWN = /Unknown or incomplete command|Unknown command|Incorrect argument/i;

function startPings(id) {
  const s = slot(id);
  if (s.pingTimer || s.pingSupport === "no") return;
  s.pingTimer = setInterval(() => pollPings(id), PING_EVERY);
}

function stopPings(id) {
  const s = slot(id);
  if (s.pingTimer) clearInterval(s.pingTimer);
  s.pingTimer = null;
  s.pingWait = 0;
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
  if (!s.proc || !s.proc.stdin.writable || s.status !== "running") return;
  if (s.pingSupport === "no") return;
  if (!s.players.length) return setPings(id, {});
  if (s.pingSupport === "unknown" && ++s.pingProbes > PING_TRIES) {
    s.pingSupport = "no";
    return stopPings(id);
  }
  // Until we know the command works, bother the server about one player only.
  const names = s.pingSupport === "yes" ? s.players : s.players.slice(0, 1);
  s.pingWait = Date.now() + 4000;
  for (const name of names) {
    try {
      s.proc.stdin.write("ping " + name + "\n");
    } catch {
      return;
    }
  }
}

// Keep the answers to our own probes out of the user's console. Returns true
// when the line was ours to eat.
function interceptPing(id, line) {
  const s = slot(id);
  // Vanilla prints its parse error across two lines; the second points at the
  // offending word.
  if (s.pingHere) {
    s.pingHere = false;
    if (/<--\[HERE\]/.test(line)) return true;
  }
  if (!s.pingWait || Date.now() > s.pingWait) return false;
  const m = PING_REPLY.exec(line);
  if (m && s.players.includes(m[1])) {
    s.pingSupport = "yes";
    setPings(id, { ...s.pings, [m[1]]: Number(m[2]) });
    return true;
  }
  if (s.pingSupport === "unknown" && PING_UNKNOWN.test(line)) {
    s.pingSupport = "no";
    s.pingHere = true;
    stopPings(id);
    return true;
  }
  return false;
}

function sendCommand(id, cmd) {
  const s = slot(id);
  if (!s.proc || !s.proc.stdin.writable) return { ok: false, error: "Server is not running" };
  emitConsole(id, "sys", "> " + cmd);
  setPaused(id, false); // the server unpauses to run whatever we just sent
  s.proc.stdin.write(cmd.replace(/[\r\n]+$/, "") + "\n");
  return { ok: true };
}

function killPid(pid) {
  if (!pid) return;
  if (isWin) exec(`taskkill /pid ${pid} /t /f`);
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function stop(id, { force = false, auto = false } = {}) {
  const s = slot(id);
  if (!s.proc) return { ok: false, error: "Not running" };
  // Only a deep sleep leaves the server flagged asleep; a manual stop is just
  // stopped, and should not come back wearing the sleeping badge.
  s.asleep = auto;
  if (force) {
    emitConsole(id, "sys", "[hoster] Force killing…");
    killPid(s.pid);
    return { ok: true };
  }
  setStatus(id, "stopping");
  emitConsole(id, "sys", "[hoster] Stopping (saving world)…");
  try {
    s.proc.stdin.write("stop\n");
  } catch {
    killPid(s.pid);
  }
  // Escalate to a hard kill if it doesn't shut down in time.
  s.stopTimer = setTimeout(() => {
    if (s.proc) {
      emitConsole(id, "sys", "[hoster] Still running after 25s — force killing.");
      killPid(s.pid);
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

// Remove a server: stop it, then delete its folder + definition. On Windows the
// folder can stay briefly locked (indexer/AV) after files are gone, so we retry.
function destroy(id) {
  const s = slot(id);
  if (s.wake) {
    s.wake.close();
    s.wake = null;
  }
  if (s.sleepTimer) clearTimeout(s.sleepTimer);
  if (s.proc) killPid(s.pid);
  playit.forget(id).catch(() => {});
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

/* ---------------------------------------------------------------- stats poll */

function pollStats() {
  const running = [...rt.entries()].filter(([, s]) => s.proc && s.pid);
  if (!running.length) return;
  if (isWin) {
    for (const [id, s] of running) {
      execFile(
        "tasklist",
        ["/fi", `PID eq ${s.pid}`, "/fo", "csv", "/nh"],
        { timeout: 5000 },
        (err, stdout) => {
          if (err || !stdout) return;
          const cols = stdout.trim().split('","');
          const memStr = (cols[cols.length - 1] || "").replace(/[",\sK]/g, "");
          const memKB = Number(memStr) || 0;
          s.stats = { memMB: Math.round(memKB / 1024), cpu: 0 };
          events.emit("event", {
            type: "stats",
            id,
            memMB: s.stats.memMB,
            cpu: 0,
            uptime: s.startedAt ? Date.now() - s.startedAt : 0,
          });
        }
      );
    }
  } else {
    for (const [id, s] of running) {
      try {
        const statm = fs.readFileSync(`/proc/${s.pid}/statm`, "utf8").split(" ");
        const memMB = Math.round((Number(statm[1]) * 4096) / 1048576);
        s.stats = { memMB, cpu: 0 };
        events.emit("event", { type: "stats", id, memMB, cpu: 0, uptime: Date.now() - s.startedAt });
      } catch {}
    }
  }
}
setInterval(pollStats, 4000).unref();

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
  slot,
  emitInstall,
  summary,
  listSummaries,
  create,
  start,
  stop,
  restart,
  destroy,
  sendCommand,
  setEula,
  isEulaAccepted,
  readProperties,
  writeProperties,
  patchProperties,
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

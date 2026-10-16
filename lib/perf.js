/*
 * perf.js — how a running server is actually doing, beyond "the process is up".
 *
 * Three sources, none of which needs a plugin:
 *
 *   1. The process itself: CPU time and resident memory, sampled every few
 *      seconds. Linux reads /proc; Windows keeps one small PowerShell helper
 *      alive and asks it about every Java pid at once (cheaper than spawning
 *      tasklist per server per tick, which is what this replaced, and the only
 *      built-in way to get CPU time at better than one-second resolution).
 *
 *   2. The server's own console. Every flavour can be asked how it's ticking —
 *      Paper/Purpur have `tps` and `mspt`, Forge/NeoForge have `forge tps`,
 *      and vanilla grew `tick query` in 1.20.3 — and `execute if entity @e`
 *      counts loaded entities on anything 1.13+. Probes go through one
 *      sequential queue per server, so every reply (including "Unknown
 *      command") is attributed to the command that caused it, and the replies
 *      are eaten before they reach the console view. A command a server turns
 *      out not to have is set aside and tried again later (in case the refusal
 *      was really somebody else's typo), backing off up to an hour.
 *
 *   3. Lines the server prints anyway: "Can't keep up! … 2034ms or 40 ticks
 *      behind" (the one lag signal every version has), and "Done (12.3s)!".
 *
 * Results ride the manager's event bus as `stats` events, and a rolling
 * history (1 h at 5 s, 24 h at 1 min, 7 days at 10 min — all kept on disk, so
 * a panel restart leaves no hole) feeds the Stats tab's charts.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFile } = require("child_process");
const { EventEmitter } = require("events");

const store = require("./store");

const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";

const SAMPLE_MS = 5000;
const FINE_KEEP = 720; // 1 h of 5-second points
const COARSE_KEEP = 1440; // 24 h of 1-minute points
const WEEK_STEP = 10 * 60000;
const WEEK_KEEP = 1008; // 7 days of 10-minute points
const LAG_KEEP = 200;
const SAVE_EVERY = 60000; // often enough that a panel killed mid-update loses little
const STATS_DIR = path.join(store.DATA_DIR, "stats");

const events = new EventEmitter();
events.setMaxListeners(0);

/* ------------------------------------------------------------ text helpers */

// Strip colour codes and the log4j prefix, leaving what the command said.
// Vanilla: "[12:00:00] [Server thread/INFO]: …"; Paper: "[12:00:00 INFO]: …";
// Forge adds a "[minecraft/DedicatedServer]" group. Continuation lines of a
// multi-line reply carry no prefix at all.
function bodyOf(line) {
  return String(line)
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/§[0-9a-fk-orx]/gi, "")
    .replace(/^\s*(?:\[[^\]]*\]\s*)+:?\s*/, "")
    .trim();
}

// Java formats with the JVM's locale, so a German machine prints "0,5ms".
const num = (s) => {
  const n = Number(String(s).replace(/[*\s]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const round = (n, d = 1) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

const UNKNOWN = /Unknown or incomplete command|Unknown command|Incorrect argument for command/i;

/* ------------------------------------------------------- versions & flavours */

// [major, minor, patch] for 1.x, or [year, drop, patch] for 26.x — comparable
// either way since year-based versions are all newer than any 1.x.
function mcParts(mc) {
  const m = /^([0-9]+)[.]([0-9]+)(?:[.]([0-9]+))?/.exec(String(mc || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
function mcAtLeast(mc, min) {
  const v = mcParts(mc);
  if (!v) return true; // snapshots and odd builds: try it, the queue learns
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
}

/* ------------------------------------------------------------ probe parsers */
/*
 * A probe is { cmd, onLine(body) -> true (done) | "more" (eaten, keep going) |
 * false (not ours) }. They write into the server's perf state `p`.
 */

function paperTps(p) {
  return {
    cmd: "tps",
    source: "paper",
    onLine(b) {
      const m = /TPS from last ([^:]+):\s*(.+)$/i.exec(b);
      if (!m) return false;
      const labels = m[1].split(/,\s*/).map((s) => s.trim());
      const vals = m[2].split(/,\s+/).map(num);
      const by = {};
      labels.forEach((l, i) => (by[l] = vals[i]));
      p.cur.tps1m = round(by["1m"]);
      p.cur.tps5m = round(by["5m"]);
      p.cur.tps15m = round(by["15m"]);
      // Paper's newest window is the closest thing it has to "right now".
      p.cur.tps = round(vals.find((v) => v != null));
      p.cur.tpsTarget = 20;
      p.cur.tpsAt = Date.now();
      return true;
    },
    // Purpur appends a memory line to the same reply.
    tail: /Current Memory Usage/i,
  };
}

function paperMspt(p) {
  return {
    cmd: "mspt",
    source: "paper",
    onLine(b) {
      if (/Server tick times/i.test(b)) return "more";
      // "◴ 0.5/0.3/1.2, 0.6/0.3/2.0, 0.6/0.2/9.1" — avg/min/max for 5s, 10s, 1m
      const re = /([0-9]+[.,][0-9]+)\/([0-9]+[.,][0-9]+)\/([0-9]+[.,][0-9]+)/g;
      const first = re.exec(b);
      if (!first) return false;
      p.cur.mspt = round(num(first[1]), 2);
      p.cur.msptMin = round(num(first[2]), 2);
      p.cur.msptMax = round(num(first[3]), 2);
      p.cur.msptAt = Date.now();
      return true;
    },
  };
}

// Vanilla 1.20.3+, and every loader built on it. The reply is a status line,
// the rate + average (two lines, one log record), then percentiles last.
function tickQuery(p) {
  return {
    cmd: "tick query",
    source: "vanilla",
    onLine(b) {
      let m;
      if (/^The game (?:is|runs)/i.test(b)) {
        p.cur.tickState = /frozen/i.test(b) ? "frozen" : /sprint/i.test(b) ? "sprinting" : /can.t keep up/i.test(b) ? "lagging" : "normal";
        return "more";
      }
      if ((m = /Target tick rate:\s*([0-9.,]+)/i.exec(b))) {
        p.cur.tpsTarget = num(m[1]);
        return "more";
      }
      if ((m = /Average time per tick:\s*([0-9.,]+)\s*ms/i.exec(b))) {
        const mspt = num(m[1]);
        p.cur.mspt = round(mspt, 2);
        p.cur.msptAt = Date.now();
        const target = p.cur.tpsTarget || 20;
        // Average tick *work* time, sleep excluded — so TPS is capped by the
        // target rate and only drops once a tick outgrows its budget.
        p.cur.tps = mspt > 0 ? round(Math.min(target, 1000 / mspt)) : target;
        p.cur.tpsAt = Date.now();
        return "more";
      }
      if ((m = /Percentiles:\s*P50:\s*([0-9.,]+)\s*ms\s*P95:\s*([0-9.,]+)\s*ms\s*P99:\s*([0-9.,]+)/i.exec(b))) {
        p.cur.msptP50 = round(num(m[1]), 2);
        p.cur.msptP95 = round(num(m[2]), 2);
        p.cur.msptP99 = round(num(m[3]), 2);
        return true;
      }
      return false;
    },
  };
}

// Forge: "Dim minecraft:overworld (…): Mean tick time: 0.512 ms. Mean TPS: 20.000"
//        "Overall: Mean tick time: 0.731 ms. Mean TPS: 20.000"
// NeoForge: "minecraft:overworld: 20.000 TPS (0.512 ms/tick)" / "Overall: …"
function forgeTps(p, cmd) {
  let dims = [];
  return {
    cmd,
    source: cmd.startsWith("neoforge") ? "neoforge" : "forge",
    onLine(b) {
      let mspt = null, tps = null, m;
      if ((m = /Mean tick time:\s*([0-9.,]+)\s*ms\.?\s*Mean TPS:\s*([0-9.,]+)/i.exec(b))) {
        mspt = num(m[1]);
        tps = num(m[2]);
      } else if ((m = /([0-9.,]+)\s*TPS\s*\(([0-9.,]+)\s*ms\/tick\)/i.exec(b))) {
        tps = num(m[1]);
        mspt = num(m[2]);
      } else return false;
      if (/^Overall/i.test(b)) {
        p.cur.tps = round(Math.min(20, tps));
        p.cur.tpsTarget = 20;
        p.cur.mspt = round(mspt, 2);
        p.cur.tpsAt = p.cur.msptAt = Date.now();
        p.cur.dims = dims;
        dims = [];
        return true;
      }
      const name = (/([a-z0-9_.-]+:[a-z0-9_./-]+)/i.exec(b) || [, b.split(":")[0]])[1];
      dims.push({ name: name.replace(/^minecraft:/, ""), tps: round(Math.min(20, tps)), mspt: round(mspt, 2) });
      return "more";
    },
  };
}

function entityCount(p) {
  return {
    cmd: "execute if entity @e",
    onLine(b) {
      let m;
      if ((m = /Test passed, count:\s*([0-9]+)/i.exec(b))) p.cur.entities = Number(m[1]);
      else if (/^Test passed\b/i.test(b)) p.cur.entities = 1;
      else if (/^Test failed\b/i.test(b)) p.cur.entities = 0;
      else return false;
      p.cur.entitiesAt = Date.now();
      return true;
    },
  };
}

function worldDay(p) {
  return {
    cmd: "time query day",
    onLine(b) {
      const m = /^The time is\s*([0-9]+)/i.exec(b);
      if (!m) return false;
      p.cur.day = Number(m[1]);
      return true;
    },
  };
}

// The questions worth asking this server, each with fallbacks in order. The
// first candidate the server hasn't refused is the one used.
function plan(def) {
  const loader = (def.start && def.start.modLoader) || def.loader;
  const mc = def.mc;
  const tq = mcAtLeast(mc, [1, 20, 3]) ? [tickQuery] : [];
  const slots = [];
  if (loader === "paper" || loader === "purpur") {
    slots.push({ key: "tps", every: 10000, candidates: [paperTps] });
    slots.push({ key: "mspt", every: 10000, candidates: [paperMspt, ...tq] });
  } else if (loader === "forge") {
    slots.push({ key: "tps", every: 10000, candidates: [(p) => forgeTps(p, "forge tps"), ...tq] });
  } else if (loader === "neoforge") {
    // NeoForge for 1.20.1 still answers to the old "forge" namespace.
    slots.push({
      key: "tps",
      every: 10000,
      candidates: [(p) => forgeTps(p, "neoforge tps"), (p) => forgeTps(p, "forge tps"), ...tq],
    });
  } else if (tq.length) {
    slots.push({ key: "tps", every: 10000, candidates: tq });
  }
  if (mcAtLeast(mc, [1, 13, 0])) slots.push({ key: "entities", every: 20000, candidates: [entityCount] });
  slots.push({ key: "day", every: 60000, candidates: [worldDay] });
  return slots;
}

/* -------------------------------------------------------------- probe queue */

const PROBE_TIMEOUT = 5000;
const GIVE_UP_AFTER = 6; // unanswered probes before a command is set aside
// An "Unknown command" while a probe is waiting used to be pinned on the probe
// outright — so one typo in the console while `tick query` was in flight
// wrote TPS off for the rest of the run. Brigadier's echo line now decides;
// for the servers that print none, a command typed in this recently owns it.
const EXTERNAL_GRACE = 3000;
const RETRY_FIRST = 5 * 60000; // a set-aside question is asked again after this…
const RETRY_MAX = 60 * 60000; // …doubling each time it is refused, up to this

function makeQueue(write) {
  const q = { items: [], active: null, timer: null, suspect: null, held: null, externalAt: 0, tail: null, write };

  q.push = (probe) => {
    if (probe.key && (q.items.some((x) => x.key === probe.key) || (q.active && q.active.key === probe.key))) return;
    q.items.push(probe);
    pump(q);
  };
  q.clear = () => {
    if (q.timer) clearTimeout(q.timer);
    q.timer = null;
    q.active = null;
    q.suspect = null;
    q.held = null;
    q.items = [];
  };
  return q;
}

function pump(q) {
  if (q.active || !q.items.length) return;
  const probe = q.items.shift();
  q.active = probe;
  if (!q.write(probe.cmd)) {
    q.active = null;
    q.items = [];
    return;
  }
  q.timer = setTimeout(() => {
    q.timer = null;
    if (q.active !== probe) return;
    // "Unknown command" with no echo line after it, and nothing else since:
    // Bukkit's style of refusal, so believe it.
    if (q.suspect === probe) {
      const typed = Date.now() - q.externalAt < EXTERNAL_GRACE;
      q.held = null;
      if (!typed) return refuse(q, probe);
      q.suspect = null;
    }
    q.active = null;
    try { probe.onTimeout && probe.onTimeout(); } catch {}
    pump(q);
  }, probe.timeout || PROBE_TIMEOUT);
}

// The server said it doesn't know the active probe's command.
function refuse(q, probe) {
  if (q.timer) clearTimeout(q.timer);
  q.timer = null;
  q.suspect = null;
  if (q.active === probe) q.active = null;
  try { probe.onUnknown && probe.onUnknown(); } catch {}
  pump(q);
}

// Brigadier follows "Unknown or incomplete command" with an echo of what was
// typed: "tick query<--[HERE]", or "...entity @e<--[HERE]" — the tail of the
// input from up to ten characters before the error. That echo is what says
// whose command it was.
function echoOf(line) {
  return bodyOf(line)
    .replace(/<--\[HERE\].*$/, "")
    .replace(/^(?:\.\.\.|\u2026)/, "")
    .trim();
}

function finish(q, ok = true) {
  const probe = q.active;
  if (q.timer) clearTimeout(q.timer);
  q.timer = null;
  q.active = null;
  if (ok && probe && probe.tail) q.tail = { re: probe.tail, until: Date.now() + 1500 };
  if (ok && probe && probe.onDone) probe.onDone();
  pump(q);
}

// What to do with a console line: true when it was a reply to one of our
// probes (hide it), false when it wasn't (show it), or an array of lines to
// show in its place — an error line we held back, it turning out not to be
// ours, plus this one.
function interceptLine(q, line) {
  let release = null;
  if (q.suspect) {
    const probe = q.suspect;
    const held = q.held;
    q.suspect = null;
    q.held = null;
    if (/<--\[HERE\]/.test(line)) {
      const said = echoOf(line);
      if (q.active === probe && (!said || probe.cmd.endsWith(said))) {
        refuse(q, probe);
        return true;
      }
      // Somebody else's command failed. Our probe is still waiting for its
      // answer; the error and its echo belong on screen.
      return [held, line];
    }
    // No echo at all (Bukkit's "Unknown command. Type /help"). Unless a
    // command was just typed in, take the refusal at its word; either way,
    // read this line like any other.
    if (Date.now() - q.externalAt < EXTERNAL_GRACE) release = [held];
    else if (q.active === probe) refuse(q, probe);
  }
  const eaten = readLine(q, line);
  if (!release) return eaten;
  return eaten ? release : release.concat([line]);
}

function readLine(q, line) {
  const b = bodyOf(line);
  if (q.tail) {
    if (Date.now() > q.tail.until) q.tail = null;
    else if (q.tail.re.test(b)) return true;
  }
  const probe = q.active;
  if (!probe) return false;
  if (UNKNOWN.test(b)) {
    // Ours, or a command typed in a moment ago? Brigadier's echo on the next
    // line says which, so hold this one back until then.
    q.suspect = probe;
    q.held = line;
    return true;
  }
  let r = false;
  try { r = probe.onLine(b, line); } catch {}
  if (r === true) finish(q);
  return !!r;
}

/* ---------------------------------------------------------------- per server */

const P = new Map();

function blankCurrent() {
  return {
    memMB: 0,
    cpu: null, // % of the whole machine, like Task Manager
    cores: null, // the same thing as "how many cores' worth"
    threads: null,
    tps: null,
    tpsTarget: null,
    tps1m: null,
    tps5m: null,
    tps15m: null,
    tpsAt: null,
    mspt: null,
    msptMin: null,
    msptMax: null,
    msptP50: null,
    msptP95: null,
    msptP99: null,
    msptAt: null,
    tickState: null,
    dims: null,
    entities: null,
    entitiesAt: null,
    day: null,
    tpsSource: null,
    tpsSupport: "unknown", // unknown | yes | no (this server can't) | retrying (stopped answering)
    tpsRetryAt: null,
    idle: false, // not being asked: paused, or empty with pause-when-empty on
    lagCount: 0,
    lagLast: null,
    startupSec: null,
    peakPlayers: 0,
    sampledAt: null,
  };
}

function perfFor(id) {
  let p = P.get(id);
  if (!p) {
    p = {
      id,
      src: null, // { pid, write, def(), players(), status(), paused() } while running
      queue: null,
      slots: [],
      cur: blankCurrent(),
      fine: [],
      coarse: [],
      week: [],
      lag: [],
      acc: null,
      acc10: null,
      prevCpu: null,
      dirty: false,
      disk: null,
      diskBusy: null,
    };
    load(p);
    P.set(id, p);
  }
  return p;
}

// Called by the manager right after it spawns the Java process.
function begin(id, src) {
  const p = perfFor(id);
  if (p.queue) p.queue.clear();
  p.src = src;
  p.queue = makeQueue((cmd) => src.write(cmd));
  p.cur = blankCurrent();
  p.prevCpu = null;
  const def = src.def();
  p.slots = def
    ? plan(def).map((s) => ({ ...s, idx: 0, fails: 0, ok: false, next: 0, parkedUntil: 0, backoff: RETRY_FIRST }))
    : [];
  p.cur.tpsSupport = p.slots.some((s) => s.key === "tps") ? "unknown" : "no";
}

function end(id) {
  const p = P.get(id);
  if (!p) return;
  if (p.queue) p.queue.clear();
  p.queue = null;
  p.src = null;
  p.cur = blankCurrent();
  flushAcc(p, true);
  emit(p);
}

function intercept(id, line) {
  const p = P.get(id);
  return p && p.queue ? interceptLine(p.queue, line) : false;
}

// The manager wrote something to the console that isn't one of our probes —
// a command typed in the panel, or a backup's save-off. Its reply, error
// included, is its own.
function external(id) {
  const p = P.get(id);
  if (p && p.queue) p.queue.externalAt = Date.now();
}

// One-off console questions from elsewhere (the player ping poll) share the
// queue, so their replies can't be mistaken for ours or vice versa.
function probe(id, spec) {
  const p = P.get(id);
  if (!p || !p.queue) return false;
  p.queue.push(spec);
  return true;
}

// Lines every server prints on its own.
function observe(id, line) {
  const p = P.get(id);
  if (!p || !p.src) return;
  let m;
  if ((m = /Can't keep up!.*?Running\s+([0-9]+)\s*ms\s+or\s+([0-9]+)\s+ticks behind/i.exec(line))) {
    const ev = { t: Date.now(), ms: Number(m[1]), ticks: Number(m[2]) };
    p.lag.push(ev);
    if (p.lag.length > LAG_KEEP) p.lag.shift();
    p.cur.lagCount++;
    p.cur.lagLast = ev;
    p.dirty = true;
    events.emit("lag", id, ev);
    emit(p);
  } else if ((m = /Done \(([0-9]+[.,]?[0-9]*)s\)!/.exec(line))) {
    p.cur.startupSec = round(num(m[1]), 1);
  }
}

function slotProbe(p, slot) {
  const make = slot.candidates[slot.idx];
  const spec = make(p);
  return {
    ...spec,
    key: "perf:" + slot.key,
    onDone() {
      slot.ok = true;
      slot.fails = 0;
      slot.backoff = RETRY_FIRST;
      if (slot.key === "tps" || slot.key === "mspt") {
        p.cur.tpsSupport = "yes";
        if (spec.source && (slot.key === "tps" || !p.cur.tpsSource)) p.cur.tpsSource = spec.source;
      }
    },
    onUnknown() {
      dropCandidate(p, slot);
    },
    onTimeout() {
      // A slow server can miss one; a command it silently doesn't understand
      // (an untranslated Forge key, say) misses every time.
      if (!slot.ok && ++slot.fails >= GIVE_UP_AFTER) dropCandidate(p, slot);
    },
  };
}

// Move on to the next way of asking. Out of ways, the question is set aside
// rather than abandoned: a refusal can still have been misread, a modded
// server can be too busy to answer while it boots, and asking again costs one
// line in the log every few minutes at most.
function dropCandidate(p, slot) {
  slot.idx++;
  slot.fails = 0;
  slot.ok = false;
  if (slot.idx < slot.candidates.length) return;
  slot.idx = 0;
  slot.parkedUntil = Date.now() + slot.backoff;
  slot.backoff = Math.min(RETRY_MAX, slot.backoff * 2);
  const tpsSlots = p.slots.filter((s) => s.key === "tps" || s.key === "mspt");
  if (tpsSlots.length && tpsSlots.every((s) => s.parkedUntil > Date.now())) {
    p.cur.tpsSupport = "retrying";
    p.cur.tpsRetryAt = Math.min(...tpsSlots.map((s) => s.parkedUntil));
    p.cur.tps = p.cur.mspt = null;
  }
}

function askConsole(p, now) {
  const src = p.src;
  const def = src.def();
  const players = src.players().length;
  // Don't nudge a server that is resting: a paused server should stay paused,
  // and one that is about to pause shouldn't be kept awake by our questions.
  const pauseOn = def && Number(def.pauseWhenEmpty) > 0 && src.supportsPause;
  const idle = src.status() !== "running" || src.paused() || (pauseOn && players === 0);
  p.cur.idle = idle;
  if (idle) return;
  // Nobody watching the world → ask less often; it keeps latest.log quieter.
  const slow = players === 0 ? 3 : 1;
  for (const slot of p.slots) {
    if (now < slot.next || now < slot.parkedUntil) continue;
    slot.next = now + slot.every * slow;
    p.queue.push(slotProbe(p, slot));
  }
}

/* ------------------------------------------------------- process sampling */

// Linux: utime + stime from /proc/<pid>/stat, in clock ticks (100 Hz on every
// distro that matters), plus threads and resident pages.
function sampleLinux(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
    // f[0] is field 3 of stat(5); field n lives at f[n - 3].
    const cpuMs = (Number(f[11]) + Number(f[12])) * 10;
    return { cpuMs, memBytes: Number(f[21]) * 4096, threads: Number(f[17]) };
  } catch {
    return null;
  }
}

// macOS and friends: one `ps` call. TIME is [[dd-]hh:]mm:ss[.ss].
function samplePs(pid) {
  return new Promise((resolve) => {
    execFile("ps", ["-o", "rss=,time=", "-p", String(pid)], { timeout: 4000 }, (err, out) => {
      if (err || !out.trim()) return resolve(null);
      const [rss, time] = out.trim().split(/\s+/);
      const parts = time.replace("-", ":").split(":").map(Number);
      let sec = 0;
      for (const v of parts) sec = sec * 60 + v;
      resolve({ cpuMs: sec * 1000, memBytes: Number(rss) * 1024, threads: null });
    });
  });
}

/*
 * Windows: a single long-lived PowerShell that reads comma-separated pids on
 * stdin and answers "OK pid cpuMs bytes threads;…" — one line per request.
 * Sent as -EncodedCommand so no quoting survives the trip to mangle it. If it
 * can't start or stops answering we fall back to tasklist, which knows memory
 * but not CPU.
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $l = [Console]::In.ReadLine()
  if ($l -eq $null) { break }
  $o = @()
  foreach ($x in ($l -split ',')) {
    $p = Get-Process -Id ([int]$x)
    if ($p) { $o += ('{0} {1} {2} {3}' -f $x, [long]$p.TotalProcessorTime.TotalMilliseconds, $p.WorkingSet64, $p.Threads.Count) }
  }
  [Console]::Out.WriteLine('OK ' + ($o -join ';'))
  [Console]::Out.Flush()
}`;

const ps = { proc: null, buf: "", waiting: [], broken: false, misses: 0, crashes: 0, releasing: false };

function psHelper() {
  if (ps.broken) return null;
  if (ps.proc) return ps.proc;
  try {
    const proc = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(PS_SCRIPT, "utf16le").toString("base64")],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }
    );
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => {
      ps.buf += d;
      let i;
      while ((i = ps.buf.indexOf("\n")) >= 0) {
        const line = ps.buf.slice(0, i).trim();
        ps.buf = ps.buf.slice(i + 1);
        if (!line.startsWith("OK")) continue;
        const map = new Map();
        for (const rec of line.slice(2).trim().split(";").filter(Boolean)) {
          const [pid, cpuMs, mem, threads] = rec.trim().split(/\s+/).map(Number);
          map.set(pid, { cpuMs, memBytes: mem, threads });
        }
        const w = ps.waiting.shift();
        if (w) w(map);
      }
    });
    const dead = () => {
      // Exiting because we closed its stdin is fine; dying on its own three
      // times means this machine's PowerShell won't cooperate — stop respawning.
      if (!ps.releasing && ++ps.crashes >= 3) ps.broken = true;
      ps.releasing = false;
      ps.proc = null;
      for (const w of ps.waiting.splice(0)) w(null);
    };
    proc.on("error", () => { ps.broken = true; dead(); });
    proc.on("exit", dead);
    proc.stdin.on("error", () => {});
    ps.proc = proc;
    return proc;
  } catch {
    ps.broken = true;
    return null;
  }
}

function psQuery(pids) {
  const proc = psHelper();
  if (!proc) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    ps.waiting.push(done);
    setTimeout(() => {
      if (settled) return;
      const i = ps.waiting.indexOf(done);
      if (i >= 0) ps.waiting.splice(i, 1);
      // PowerShell's first answer includes its own startup; after that a miss
      // is a sign it has wedged.
      if (++ps.misses >= 4) {
        ps.broken = true;
        try { ps.proc.kill(); } catch {}
      }
      done(null);
    }, 8000);
    try {
      proc.stdin.write(pids.join(",") + "\n");
    } catch {
      done(null);
    }
  }).then((v) => {
    if (v) ps.misses = 0;
    return v;
  });
}

function psRelease() {
  if (!ps.proc || ps.releasing) return;
  ps.releasing = true;
  try { ps.proc.stdin.end(); } catch {}
}

function sampleTasklist(pid) {
  return new Promise((resolve) => {
    execFile("tasklist", ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"], { timeout: 5000 }, (err, out) => {
      if (err || !out) return resolve(null);
      const cols = out.trim().split('","');
      const kb = Number((cols[cols.length - 1] || "").replace(/[^0-9]/g, "")) || 0;
      resolve({ cpuMs: null, memBytes: kb * 1024, threads: null });
    });
  });
}

async function sampleAll(pids) {
  const out = new Map();
  if (!pids.length) return out;
  if (isLinux) {
    for (const pid of pids) out.set(pid, sampleLinux(pid));
  } else if (isWin) {
    const map = await psQuery(pids);
    if (map) for (const pid of pids) out.set(pid, map.get(pid) || null);
    else for (const pid of pids) out.set(pid, await sampleTasklist(pid));
  } else {
    for (const pid of pids) out.set(pid, await samplePs(pid));
  }
  return out;
}

/* ------------------------------------------------------------------ history */

const fresh = (at, now, within) => at != null && now - at <= within;

function pointOf(p, now) {
  const c = p.cur;
  const live = !c.idle;
  return {
    t: now,
    cpu: c.cpu,
    mem: c.memMB || null,
    tps: live && fresh(c.tpsAt, now, 45000) ? c.tps : null,
    mspt: live && fresh(c.msptAt, now, 45000) ? c.mspt : null,
    players: p.src ? p.src.players().length : 0,
    entities: live && fresh(c.entitiesAt, now, 90000) ? c.entities : null,
  };
}

const AVG_KEYS = ["cpu", "mem", "tps", "mspt", "entities"];

// 10-minute buckets for the week view, built from the finished minutes.
function addToWeek(p, pt) {
  const bucket = Math.floor(pt.t / WEEK_STEP);
  if (p.acc10 && p.acc10.bucket !== bucket) flushWeek(p, true);
  if (!p.acc10) {
    p.acc10 = { bucket, n: {}, sum: {}, players: 0, tpsMin: null };
    for (const k of AVG_KEYS) { p.acc10.n[k] = 0; p.acc10.sum[k] = 0; }
  }
  const a = p.acc10;
  for (const k of AVG_KEYS)
    if (pt[k] != null) { a.sum[k] += pt[k]; a.n[k]++; }
  a.players = Math.max(a.players, pt.players || 0);
  const low = pt.tpsMin != null ? pt.tpsMin : pt.tps;
  if (low != null) a.tpsMin = a.tpsMin == null ? low : Math.min(a.tpsMin, low);
}

function weekPoint(a) {
  const pt = { t: a.bucket * WEEK_STEP + WEEK_STEP / 2, players: a.players, tpsMin: a.tpsMin };
  for (const k of AVG_KEYS) pt[k] = a.n[k] ? round(a.sum[k] / a.n[k], k === "mspt" ? 2 : 1) : null;
  if (pt.mem != null) pt.mem = Math.round(pt.mem);
  if (pt.entities != null) pt.entities = Math.round(pt.entities);
  return pt;
}

function flushWeek(p, force = false) {
  const a = p.acc10;
  if (!a) return;
  if (!force && a.bucket === Math.floor(Date.now() / WEEK_STEP)) return;
  p.acc10 = null;
  p.week.push(weekPoint(a));
  const cutoff = Date.now() - 7 * 86400000;
  while (p.week.length > WEEK_KEEP || (p.week.length && p.week[0].t < cutoff)) p.week.shift();
  p.dirty = true;
}

function addToAcc(p, pt) {
  const minute = Math.floor(pt.t / 60000);
  if (p.acc && p.acc.minute !== minute) flushAcc(p);
  if (!p.acc) {
    p.acc = { minute, n: {}, sum: {}, players: 0, tpsMin: null };
    for (const k of AVG_KEYS) { p.acc.n[k] = 0; p.acc.sum[k] = 0; }
  }
  for (const k of AVG_KEYS)
    if (pt[k] != null) { p.acc.sum[k] += pt[k]; p.acc.n[k]++; }
  p.acc.players = Math.max(p.acc.players, pt.players || 0);
  if (pt.tps != null) p.acc.tpsMin = p.acc.tpsMin == null ? pt.tps : Math.min(p.acc.tpsMin, pt.tps);
}

function accPoint(a) {
  const pt = { t: a.minute * 60000 + 30000, players: a.players, tpsMin: a.tpsMin };
  for (const k of AVG_KEYS) pt[k] = a.n[k] ? round(a.sum[k] / a.n[k], k === "mspt" ? 2 : 1) : null;
  if (pt.mem != null) pt.mem = Math.round(pt.mem);
  if (pt.entities != null) pt.entities = Math.round(pt.entities);
  return pt;
}

function flushAcc(p, force = false) {
  const a = p.acc;
  if (!a) return;
  if (!force && a.minute === Math.floor(Date.now() / 60000)) return;
  p.acc = null;
  const pt = accPoint(a);
  p.coarse.push(pt);
  addToWeek(p, pt);
  while (p.coarse.length > COARSE_KEEP) p.coarse.shift();
  const cutoff = Date.now() - 24 * 3600000;
  while (p.coarse.length && p.coarse[0].t < cutoff) p.coarse.shift();
  p.dirty = true;
}

/* ------------------------------------------------------------- persistence */

const fileFor = (id) => path.join(STATS_DIR, `${id}.json`);

function load(p) {
  try {
    const data = JSON.parse(fs.readFileSync(fileFor(p.id), "utf8"));
    const now = Date.now();
    p.coarse = (data.coarse || []).filter((x) => x.t >= now - 24 * 3600000);
    p.week = (data.week || []).filter((x) => x.t >= now - 7 * 86400000);
    p.fine = (data.fine || []).filter((x) => x.t >= now - FINE_KEEP * SAMPLE_MS);
    p.lag = (data.lag || []).filter((x) => x.t >= now - 7 * 86400000).slice(-LAG_KEEP);
    // Buckets that were still filling when the last panel went away carry on
    // filling, rather than leaving a half-minute and a duplicate behind.
    if (data.acc10 && data.acc10.bucket >= Math.floor(now / WEEK_STEP) - 1) p.acc10 = data.acc10;
    if (data.acc && data.acc.minute >= Math.floor(now / 60000) - 1) p.acc = data.acc;
  } catch {}
}

function save(p) {
  if (!p.dirty) return;
  p.dirty = false;
  try {
    fs.mkdirSync(STATS_DIR, { recursive: true });
    fs.writeFileSync(fileFor(p.id), JSON.stringify({ coarse: p.coarse, week: p.week, fine: p.fine, lag: p.lag, acc: p.acc, acc10: p.acc10 }));
  } catch {}
}

function flushAll() {
  for (const p of P.values()) {
    p.dirty = true;
    save(p);
  }
}

function forget(id) {
  const p = P.get(id);
  if (p && p.queue) p.queue.clear();
  P.delete(id);
  try { fs.rmSync(fileFor(id), { force: true }); } catch {}
}

setInterval(() => { for (const p of P.values()) save(p); }, SAVE_EVERY).unref();

/* ------------------------------------------------------------------- tick */

function emit(p) {
  events.emit("stats", p.id, { ...p.cur, uptime: p.src && p.src.startedAt ? Date.now() - p.src.startedAt() : 0 });
}

let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const live = [...P.values()].filter((p) => p.src && p.src.pid());
    if (!live.length) {
      psRelease();
      return;
    }
    const samples = await sampleAll(live.map((p) => p.src.pid()));
    const now = Date.now();
    const ncpu = os.cpus().length || 1;
    for (const p of live) {
      if (!p.src) continue; // stopped while we were sampling
      const smp = samples.get(p.src.pid());
      if (smp) {
        p.cur.memMB = Math.round(smp.memBytes / 1048576);
        if (smp.threads) p.cur.threads = smp.threads;
        if (smp.cpuMs != null && Number.isFinite(smp.cpuMs)) {
          const prev = p.prevCpu;
          if (prev && now > prev.t && smp.cpuMs >= prev.ms) {
            const used = (smp.cpuMs - prev.ms) / (now - prev.t); // cores' worth
            p.cur.cores = round(used, 2);
            p.cur.cpu = round(Math.min(100, (used / ncpu) * 100), 1);
          }
          p.prevCpu = { t: now, ms: smp.cpuMs };
        }
      }
      p.cur.peakPlayers = Math.max(p.cur.peakPlayers, p.src.players().length);
      p.cur.sampledAt = now;
      askConsole(p, now);

      const pt = pointOf(p, now);
      p.fine.push(pt);
      while (p.fine.length > FINE_KEEP) p.fine.shift();
      p.dirty = true;
      addToAcc(p, pt);
      flushAcc(p);
      events.emit("stats", p.id, { ...p.cur, uptime: now - p.src.startedAt(), point: pt });
    }
  } catch (e) {
    console.error("[perf]", e && e.message);
  } finally {
    ticking = false;
  }
}
setInterval(tick, SAMPLE_MS).unref();

/* ------------------------------------------------------------- disk usage */

async function sizeOf(abs) {
  let st;
  try { st = await fs.promises.lstat(abs); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let list;
  try { list = await fs.promises.readdir(abs); } catch { return 0; }
  let total = 0;
  for (const name of list) total += await sizeOf(path.join(abs, name));
  return total;
}

// What's taking the space in one folder of this server (the server folder
// itself by default), entry by entry. A world is tens of thousands of files,
// so it's walked in the background and cached per folder; the Files tab asks
// again at most every couple of minutes unless told to measure afresh.
const DISK_TTL = 120000;
function diskUsage(id, rel = "", { fresh = false } = {}) {
  const p = perfFor(id);
  const root = path.resolve(store.dirFor(id));
  const dir = path.resolve(root, rel || ".");
  if (dir !== root && !dir.startsWith(root + path.sep)) return Promise.reject(new Error("Path escapes server folder"));
  const key = path.relative(root, dir).split(path.sep).join("/");
  p.disk = p.disk || new Map();
  p.diskBusy = p.diskBusy || new Map();
  const hit = p.disk.get(key);
  if (hit && !fresh && Date.now() - hit.at < DISK_TTL) return Promise.resolve(hit);
  if (p.diskBusy.has(key)) return p.diskBusy.get(key);
  const job = (async () => {
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch {}
    const entries = [];
    for (const name of names) {
      let dirent = false;
      try { dirent = (await fs.promises.lstat(path.join(dir, name))).isDirectory(); } catch {}
      entries.push({ name, dir: dirent, bytes: await sizeOf(path.join(dir, name)) });
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    const out = { at: Date.now(), path: key, total: entries.reduce((a, e) => a + e.bytes, 0), entries };
    p.disk.set(key, out);
    // A fresh measurement of a folder makes the cached sizes of the folders
    // above it stale too.
    for (const k of p.disk.keys()) if (k !== key && (k === "" || key.startsWith(k + "/"))) p.disk.delete(k);
    return out;
  })().finally(() => p.diskBusy.delete(key));
  p.diskBusy.set(key, job);
  return job;
}

/* -------------------------------------------------------------- read side */

function current(id) {
  const p = P.get(id);
  return p ? { ...p.cur } : blankCurrent();
}

const RANGES = {
  "15m": { span: 15 * 60000, tier: "fine" },
  "1h": { span: 3600000, tier: "fine" },
  "6h": { span: 6 * 3600000, tier: "coarse" },
  "24h": { span: 24 * 3600000, tier: "coarse" },
  "7d": { span: 7 * 86400000, tier: "week" },
};

function history(id, range) {
  const p = perfFor(id);
  const r = RANGES[range] ? range : "1h";
  const { span, tier } = RANGES[r];
  const from = Date.now() - span;
  if (tier === "fine") return { range: r, step: SAMPLE_MS, points: p.fine.filter((x) => x.t >= from) };
  if (tier === "coarse") {
    const pts = p.coarse.filter((x) => x.t >= from);
    // The minute in progress, so the right edge isn't a minute stale.
    if (p.acc) pts.push(accPoint(p.acc));
    return { range: r, step: 60000, points: pts };
  }
  const pts = p.week.filter((x) => x.t >= from);
  if (p.acc10) pts.push(weekPoint(p.acc10));
  return { range: r, step: WEEK_STEP, points: pts };
}

function lagEvents(id) {
  return perfFor(id).lag.slice().reverse();
}

function clearLag(id) {
  const p = perfFor(id);
  p.lag = [];
  p.cur.lagCount = 0;
  p.cur.lagLast = null;
  p.dirty = true;
  save(p);
}

module.exports = {
  events,
  SAMPLE_MS,
  begin,
  end,
  intercept,
  external,
  probe,
  observe,
  current,
  history,
  lagEvents,
  clearLag,
  diskUsage,
  flushAll,
  forget,
  // exported for tests
  _bodyOf: bodyOf,
  _plan: plan,
  _makeQueue: makeQueue,
  _interceptLine: interceptLine,
  _parsers: { paperTps, paperMspt, tickQuery, forgeTps, entityCount, worldDay },
};

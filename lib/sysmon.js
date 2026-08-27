/*
 * sysmon.js — whole-machine resource sampling for the panel's "glance" meters.
 * Node built-ins only: CPU load from os.cpus() tick deltas, memory from
 * os.totalmem/freemem, disk from fs.statfs() on the data directory. Samples run
 * on a timer, keep a short ring buffer for the sparkline, and are emitted as
 * 'sample' — server.js forwards those onto the global SSE stream.
 *
 * Deliberately cheap: no child processes, no wmic/PowerShell shell-outs, so it
 * can tick every couple of seconds without stealing cycles from a running
 * Minecraft server.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const store = require("./store");

const SAMPLE_MS = 2000;
const HISTORY = 90; // ~3 minutes of sparkline at SAMPLE_MS
const DISK_EVERY = 15; // free space moves slowly — re-stat every ~30s

const events = new EventEmitter();
events.setMaxListeners(0);

const clampPct = (n) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
const toMB = (bytes) => Math.round(bytes / 1048576);

/* --------------------------------------------------------------------- cpu */

// os.cpus() reports cumulative tick counters, so load is only meaningful as a
// delta between two readings.
function readCpu() {
  return os.cpus().map((c) => {
    const t = c.times;
    return { total: t.user + t.nice + t.sys + t.irq + t.idle, idle: t.idle };
  });
}

let prevCpu = readCpu();

function cpuSince() {
  const now = readCpu();
  const cores = now.map((c, i) => {
    const p = prevCpu[i] || c;
    const dTotal = c.total - p.total;
    const dIdle = c.idle - p.idle;
    return dTotal > 0 ? clampPct(((dTotal - dIdle) / dTotal) * 100) : 0;
  });
  prevCpu = now;
  const pct = cores.length ? clampPct(cores.reduce((a, b) => a + b, 0) / cores.length) : 0;
  return { pct, cores };
}

/* -------------------------------------------------------------------- disk */

// The drive that actually matters here is the one holding data/servers — worlds
// and mod jars are what fill a disk up.
let disk = null;
function setDisk(st) {
  if (!st || !st.blocks) return;
  const total = st.blocks * st.bsize;
  const free = st.bavail * st.bsize;
  // Shown without its trailing separator: "C:" on Windows, "/" on POSIX.
  const root = path.parse(path.resolve(store.DATA_DIR)).root;
  disk = {
    drive: root.length > 1 ? root.slice(0, -1) : root,
    total,
    free,
    used: total - free,
    pct: clampPct(((total - free) / total) * 100),
  };
}
function refreshDisk() {
  fs.statfs(store.DATA_DIR, (err, st) => {
    if (!err) setDisk(st);
  });
}
// Warm the value synchronously once, so the very first bootstrap response
// already carries a disk reading instead of "unavailable".
try {
  setDisk(fs.statfsSync(store.DATA_DIR));
} catch {}

/* ------------------------------------------------------------------ sample */

const history = { cpu: [], mem: [] };
function push(arr, v) {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
}

const cpus = os.cpus();
const host = {
  platform: os.platform(),
  arch: os.arch(),
  hostname: os.hostname(),
  model: (cpus[0] && cpus[0].model ? cpus[0].model : "CPU").replace(/\s+/g, " ").trim(),
  cores: cpus.length,
  speedMHz: cpus[0] ? cpus[0].speed : 0,
};

let ticks = 0;
let last = null;

function tick() {
  const cpu = cpuSince();
  const totalMB = toMB(os.totalmem());
  const freeMB = toMB(os.freemem());
  const usedMB = Math.max(0, totalMB - freeMB);
  const mem = { totalMB, freeMB, usedMB, pct: totalMB ? clampPct((usedMB / totalMB) * 100) : 0 };

  if (ticks % DISK_EVERY === 0) refreshDisk();
  ticks++;

  push(history.cpu, cpu.pct);
  push(history.mem, mem.pct);

  last = {
    t: Date.now(),
    cpu,
    mem,
    disk,
    uptime: Math.round(os.uptime()),
    host,
    history: { cpu: history.cpu.slice(), mem: history.mem.slice() },
  };
  events.emit("sample", last);
  return last;
}

function snapshot() {
  return last || tick();
}

// Always-on, but unref'd so it never keeps the process alive on shutdown. The
// history stays warm whether or not a browser is currently watching.
setInterval(tick, SAMPLE_MS).unref();

module.exports = { events, snapshot, tick, SAMPLE_MS };

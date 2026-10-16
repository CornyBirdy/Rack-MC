/*
 * host.js — a tiny keeper that holds one long-running process (a Minecraft
 * server, or the playit agent) so it outlives the panel.
 *
 * The panel used to be the Java process's parent and the only thing holding
 * its console pipes, so anything that stopped the panel stopped every server
 * with it — including Rack's ⟳ Update, which kills the panel's whole process
 * tree with `taskkill /t /f` (no world save) and starts it again. Now the
 * panel starts this script instead, and this script starts Java:
 *
 *   panel ──spawn──▶ host.js --hop ──spawn──▶ host.js --run ──spawn──▶ java
 *                    (exits at once)
 *
 * The extra hop leaves the real host with no living parent, so a tree kill
 * aimed at the panel can't walk down to it. It is spawned detached, so it is
 * in no job object and no console of the panel's either.
 *
 * The host owns Java's stdin/stdout/stderr and serves them on a local socket
 * (a named pipe on Windows): newline-delimited JSON, one client at a time.
 * It keeps the last lines of output, so a panel that reconnects after an
 * update can show the console as it was and catch up on whatever was printed
 * while it was gone — joins, chat, a "Done" — line by line.
 *
 * This file runs on its own, outside the panel, and may keep running across
 * many panel updates: it must not require anything else from lib/, and its
 * protocol only ever grows (a newer panel talks to an older host).
 *
 * Protocol v1
 *   host → panel  {t:"hello", v, key, pid, hostPid, startedAt, file, args, ready,
 *                  delivered, lines:[[seq, at, stream, line]…], exit}
 *                 {t:"line", s, at, st, l}
 *                 {t:"exit", code, signal, error, at}
 *   panel → host  {t:"in", d}     write to the process's stdin
 *                 {t:"kill"}      force-kill the process
 */
"use strict";

const fs = require("fs");
const net = require("net");
const { spawn } = require("child_process");

const PROTOCOL = 1;
const KEEP_LINES = 1500;
const LINGER_MS = 10 * 60000; // after the process exits, wait this long for a panel to hear about it
// "Done (12.3s)! For help, type "help"" — the server is up. Kept here so a
// panel that reconnects later knows without the line still being in the buffer.
const READY = /\)! For help, type "help"|: Done \(|^Done \(|Timings Reset/;

const [mode, specFile] = process.argv.slice(2);
let spec;
try {
  spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
} catch (e) {
  process.exit(2);
}

function note(msg) {
  if (!spec.logFile) return;
  try {
    fs.appendFileSync(spec.logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

if (mode === "--hop") {
  // Start the real host and leave, so it has no living parent.
  try {
    const child = spawn(process.execPath, [__filename, "--run", specFile], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    note("hop failed: " + e.message);
  }
  process.exit(0);
}

if (mode !== "--run") process.exit(2);

/* ------------------------------------------------------------------ state */

const startedAt = Date.now();
const lines = []; // [seq, at, stream, line]
let seq = 0;
let delivered = 0; // newest line handed to a panel, as of the last hello
let ready = false;
let child = null;
let client = null;
let exitInfo = null;
let lingerTimer = null;

process.on("uncaughtException", (e) => note("uncaught: " + (e && e.stack ? e.stack : e)));
// A hang-up of a terminal we never had is not a reason to drop the server.
process.on("SIGHUP", () => {});
// Asked to go away politely: let the server save and stop the same way.
process.on("SIGTERM", () => {
  if (child && !exitInfo) writeIn("stop\n");
  else quit();
});

function send(obj) {
  if (!client || client.destroyed) return false;
  try {
    client.write(JSON.stringify(obj) + "\n");
    return true;
  } catch {
    return false;
  }
}

function push(stream, line) {
  const entry = [++seq, Date.now(), stream, line];
  lines.push(entry);
  if (lines.length > KEEP_LINES) lines.splice(0, lines.length - KEEP_LINES);
  if (!ready && READY.test(line)) ready = true;
  if (send({ t: "line", s: entry[0], at: entry[1], st: stream, l: line })) delivered = entry[0];
}

// A chunk can end mid-line; hold the tail until the rest arrives, but not
// forever — a prompt with no newline after it should still show up.
function reader(stream, name) {
  let carry = "";
  let timer = null;
  const flush = () => {
    timer = null;
    if (carry) push(name, carry);
    carry = "";
  };
  stream.setEncoding("utf8");
  stream.on("data", (d) => {
    const parts = (carry + d).split(/\r?\n/);
    carry = parts.pop();
    for (const l of parts) if (l) push(name, l);
    if (timer) clearTimeout(timer);
    timer = carry ? setTimeout(flush, 250) : null;
  });
  stream.on("end", () => {
    if (timer) clearTimeout(timer);
    flush();
  });
  stream.on("error", () => {});
}

function writeIn(text) {
  if (!child || exitInfo || !child.stdin || !child.stdin.writable) return false;
  try {
    child.stdin.write(text);
    return true;
  } catch {
    return false;
  }
}

function writeJSON(file, obj) {
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify(obj));
  } catch (e) {
    note(`could not write ${file}: ${e.message}`);
  }
}

function rm(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {}
}

function hello() {
  return {
    t: "hello",
    v: PROTOCOL,
    key: spec.key,
    pid: child ? child.pid || null : null,
    hostPid: process.pid,
    startedAt,
    file: spec.file,
    args: spec.args || [],
    ready,
    delivered,
    lines,
    exit: exitInfo,
  };
}

/* ------------------------------------------------------------- the socket */

function onClient(sock) {
  if (client && client !== sock) client.destroy(); // the newest panel wins
  client = sock;
  sock.setEncoding("utf8");
  sock.on("error", () => {});
  sock.on("close", () => {
    if (client === sock) client = null;
  });

  send(hello());
  delivered = seq;
  if (exitInfo) {
    // It heard. Nothing more to keep around for.
    sock.end();
    setTimeout(quit, 1500);
    return;
  }

  let buf = "";
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.t === "in" && typeof msg.d === "string") writeIn(msg.d);
      else if (msg.t === "kill") kill();
    }
  });
}

function kill() {
  if (!child || exitInfo) return;
  try {
    child.kill("SIGKILL");
  } catch {}
}

/* -------------------------------------------------------------- lifecycle */

function finish(code, signal, error) {
  if (exitInfo) return;
  exitInfo = { code: code ?? null, signal: signal ?? null, error: error || null, at: Date.now() };
  writeJSON(spec.exitFile, { ...exitInfo, key: spec.key, startedAt, socket: spec.socket });
  rm(spec.stateFile);
  if (send({ t: "exit", ...exitInfo })) {
    client.end();
    setTimeout(quit, 1500);
  } else {
    // Nobody is listening — the panel may be mid-update. Hold on so it can
    // hear how this ended; the exit file covers it if it never comes.
    lingerTimer = setTimeout(quit, LINGER_MS);
  }
}

function quit() {
  if (lingerTimer) clearTimeout(lingerTimer);
  try {
    server.close();
  } catch {}
  if (process.platform !== "win32") rm(spec.socket);
  process.exit(0);
}

function launch() {
  try {
    child = spawn(spec.file, spec.args || [], {
      cwd: spec.cwd || undefined,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    push("err", "[host] " + e.message);
    return finish(null, null, e.message);
  }
  child.stdin.on("error", () => {});
  reader(child.stdout, "out");
  reader(child.stderr, "err");
  child.on("error", (e) => {
    push("err", "[host] " + e.message);
    if (!child.pid) finish(null, null, e.message); // it never started
  });
  child.on("exit", (code, signal) => {
    // Let the last of its output drain into the buffer first.
    setTimeout(() => finish(code, signal, null), 150);
  });
  if (child.pid)
    writeJSON(spec.stateFile, {
      v: PROTOCOL,
      key: spec.key,
      pid: child.pid,
      hostPid: process.pid,
      startedAt,
      socket: spec.socket,
      file: spec.file,
    });
}

const server = net.createServer(onClient);
server.on("error", (e) => {
  // Most likely another host already serves this key — never run two.
  note("listen failed: " + e.message);
  process.exit(1);
});
if (process.platform === "win32") {
  server.listen(spec.socket, launch); // a pipe that is still served refuses a second listener
} else {
  // A socket file outlives a host that died; one that answers is a live host.
  const probe = net.connect(spec.socket);
  probe.on("connect", () => {
    note("another host already serves " + spec.socket);
    probe.destroy();
    process.exit(1);
  });
  probe.on("error", () => {
    rm(spec.socket);
    server.listen(spec.socket, launch);
  });
}

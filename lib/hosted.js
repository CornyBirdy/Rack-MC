/*
 * hosted.js — the panel's side of host.js: start a process that outlives the
 * panel, find it again after a restart, and talk to it.
 *
 * Both kinds of handle look the same to the rest of the panel:
 *
 *   launch(key, spec)  a process kept by its own host.js — survives the panel
 *   direct(spec)       a plain child of the panel — dies with it (the old way,
 *                      for when "keep servers running" is switched off)
 *   adopt(key)         reconnect to a host a previous panel left running
 *
 *   handle.pid / .startedAt / .detached / .writable
 *   handle.write(text) → bool     handle.kill()     handle.release()
 *   events: "hello" (info), "line" (line, stream, {seq, at}), "exit" (code, signal, error)
 */
const fs = require("fs");
const path = require("path");
const net = require("net");
const os = require("os");
const crypto = require("crypto");
const { spawn, exec } = require("child_process");
const { EventEmitter } = require("events");

const store = require("./store");

const isWin = process.platform === "win32";
const RUN_DIR = path.join(store.DATA_DIR, "run");
const HOST = path.join(__dirname, "host.js");
// Two checkouts (worktree.bat) each have their own data folder and their own
// servers; their pipe names must never meet.
const TAG = crypto.createHash("sha1").update(store.DATA_DIR).digest("hex").slice(0, 8);

const CONNECT_EVERY = 150;
const LAUNCH_WAIT = 20000; // a cold Node start on a busy machine is slow
const RECONNECT_WAIT = 4000;

const safeKey = (key) => String(key).replace(/[^A-Za-z0-9_-]/g, "_");

function socketPath(key) {
  return isWin
    ? `\\\\.\\pipe\\mchoster-${TAG}-${safeKey(key)}`
    : path.join(os.tmpdir(), `mchoster-${TAG}-${safeKey(key)}.sock`);
}

function filesFor(key) {
  const k = safeKey(key);
  return {
    spec: path.join(RUN_DIR, `${k}.spec.json`),
    state: path.join(RUN_DIR, `${k}.json`),
    exit: path.join(RUN_DIR, `${k}.exit.json`),
    log: path.join(RUN_DIR, `${k}.host.log`),
  };
}

const readJSON = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const rm = (file) => {
  try {
    fs.rmSync(file, { force: true });
  } catch {}
};

function killPid(pid) {
  if (!pid) return;
  if (isWin) exec(`taskkill /pid ${pid} /t /f`, () => {});
  else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

/* ------------------------------------------------------------ hosted handle */

class HostedHandle extends EventEmitter {
  constructor(key, socket) {
    super();
    this.key = key;
    this.socket = socket;
    this.detached = true;
    this.pid = null;
    this.hostPid = null;
    this.startedAt = null;
    this.sock = null;
    this.pending = []; // writes made before the socket is up
    this.done = false;
    this.released = false;
    this.info = null;
    this.lastSeq = 0;
  }

  get writable() {
    return !this.done && !this.released;
  }

  _send(obj) {
    const raw = JSON.stringify(obj) + "\n";
    if (!this.sock || this.sock.destroyed) {
      if (this.writable) this.pending.push(raw);
      return this.writable;
    }
    try {
      this.sock.write(raw);
      return true;
    } catch {
      return false;
    }
  }

  write(text) {
    if (!this.writable) return false;
    return this._send({ t: "in", d: String(text) });
  }

  // Force-kill. Through the host when it can hear us, by pid as well in case
  // the host itself is the thing that is stuck.
  kill() {
    if (this.done) return;
    this._send({ t: "kill" });
    const pid = this.pid;
    setTimeout(() => {
      if (!this.done) killPid(pid);
    }, 3000).unref();
    if (!this.sock) killPid(pid);
  }

  // Let go without stopping anything: the panel is going away, the server isn't.
  release() {
    this.released = true;
    if (this.sock) {
      try {
        this.sock.end();
      } catch {}
    }
  }

  _exit(code, signal, error) {
    if (this.done) return;
    this.done = true;
    rm(filesFor(this.key).exit); // heard it live; nothing left to report on boot
    this.emit("exit", code, signal, error || null);
  }

  // Keep dialling until the host answers or `wait` runs out.
  _connect(wait) {
    return new Promise((resolve) => {
      const until = Date.now() + wait;
      const attempt = () => {
        if (this.done || this.released) return resolve(false);
        const sock = net.connect(this.socket);
        let buf = "";
        let greeted = false;
        sock.setEncoding("utf8");
        sock.on("connect", () => {
          this.sock = sock;
        });
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
            if (msg.t === "hello" && !greeted) {
              greeted = true;
              this._hello(msg);
              resolve(true);
            } else this._message(msg);
          }
        });
        sock.on("error", () => {});
        sock.on("close", () => {
          if (this.sock === sock) this.sock = null;
          if (!greeted) {
            if (Date.now() < until) setTimeout(attempt, CONNECT_EVERY);
            else resolve(false);
            return;
          }
          this._lost();
        });
      };
      attempt();
    });
  }

  _hello(msg) {
    const again = !!this.info; // back after a dropped connection, not a first meeting
    this.info = msg;
    this.pid = msg.pid || null;
    this.hostPid = msg.hostPid || null;
    this.startedAt = msg.startedAt || Date.now();
    // Anything written while we were dialling goes now, in order.
    const queued = this.pending.splice(0);
    for (const raw of queued) {
      try {
        this.sock.write(raw);
      } catch {}
    }
    const lines = msg.lines || [];
    if (again) {
      // Only what was printed while the line was down.
      for (const [sq, at, st, l] of lines) if (sq > this.lastSeq) this._line(sq, at, st, l);
    } else {
      if (lines.length) this.lastSeq = lines[lines.length - 1][0];
      this.emit("hello", msg);
    }
    if (msg.exit) this._exit(msg.exit.code, msg.exit.signal, msg.exit.error);
  }

  _line(sq, at, st, l) {
    if (sq != null) this.lastSeq = Math.max(this.lastSeq, sq);
    this.emit("line", l, st === "err" ? "err" : "out", { seq: sq, at });
  }

  _message(msg) {
    if (msg.t === "line") this._line(msg.s, msg.at, msg.st, msg.l);
    else if (msg.t === "exit") this._exit(msg.code, msg.signal, msg.error);
  }

  // The socket dropped without an exit message: either we let go on purpose,
  // or the host died (killed by hand, machine trouble). Try to get back in; if
  // there is nobody there, whatever it was running went with it.
  async _lost() {
    if (this.done || this.released) return;
    const back = await this._connect(RECONNECT_WAIT);
    if (back || this.done || this.released) return;
    const ex = readJSON(filesFor(this.key).exit);
    rm(filesFor(this.key).state);
    this._exit(ex ? ex.code : null, ex ? ex.signal : null, ex ? ex.error : "its host process went away");
  }
}

// Start `spec.file spec.args` under a host of its own. Returns at once; the
// handle emits "hello" once the host answers (or "exit" if it never does).
function launch(key, { file, args = [], cwd = null }) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  const f = filesFor(key);
  rm(f.exit);
  // A fresh socket name per launch, so a host still lingering to report an
  // earlier exit can never be mistaken for this one.
  const socket = socketPath(`${key}-${Date.now().toString(36)}`);
  fs.writeFileSync(
    f.spec,
    JSON.stringify({ key, file, args, cwd, socket, stateFile: f.state, exitFile: f.exit, logFile: f.log })
  );
  const h = new HostedHandle(key, socket);
  try {
    const hop = spawn(process.execPath, [HOST, "--hop", f.spec], { detached: true, stdio: "ignore", windowsHide: true });
    hop.on("error", (e) => h._exit(null, null, "could not start its host: " + e.message));
    hop.unref();
  } catch (e) {
    setImmediate(() => h._exit(null, null, "could not start its host: " + e.message));
    return h;
  }
  h._connect(LAUNCH_WAIT).then((ok) => {
    if (ok || h.done || h.released) return;
    const ex = readJSON(f.exit);
    h._exit(ex ? ex.code : null, ex ? ex.signal : null, (ex && ex.error) || "its host never answered");
  });
  return h;
}

// Reconnect to a host a previous panel started. Resolves { handle, hello } for
// a live one, or { exit } with how it ended if it finished while we were away
// (exit null when there was never anything there).
async function adopt(key) {
  const f = filesFor(key);
  const state = readJSON(f.state);
  const ex = readJSON(f.exit);
  if (!state) {
    // Finished while we were away. Its host may still be waiting to say so;
    // a hello is all it needs to hear before it goes.
    if (ex) {
      rm(f.exit);
      if (ex.socket) {
        const s = net.connect(ex.socket);
        s.on("data", () => s.destroy());
        s.on("error", () => {});
        setTimeout(() => s.destroy(), 2000).unref();
      }
    }
    return { handle: null, exit: ex };
  }
  const h = new HostedHandle(key, state.socket || socketPath(key));
  const ok = await h._connect(1500);
  if (ok && !h.done) return { handle: h, hello: h.info };
  if (ok && h.done) return { handle: null, exit: h.info.exit };
  // Its state file says running, but nobody answers: it died hard.
  rm(f.state);
  rm(f.exit);
  return { handle: null, exit: ex || { code: null, signal: null, error: "lost while the panel was closed", at: null } };
}

// Keys with something left in the run folder, for tidying up after servers
// that were deleted while running elsewhere.
function knownKeys() {
  try {
    return fs
      .readdirSync(RUN_DIR)
      .filter((n) => n.endsWith(".json") && !n.endsWith(".spec.json") && !n.endsWith(".exit.json"))
      .map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------ direct handle */

// The pre-host way: the panel is the parent. Same interface, no survival.
class DirectHandle extends EventEmitter {
  constructor({ file, args = [], cwd = null }) {
    super();
    this.detached = false;
    this.done = false;
    this.startedAt = Date.now();
    this.proc = spawn(file, args, { cwd: cwd || undefined, windowsHide: true });
    this.pid = this.proc.pid;
    this.proc.stdin.on("error", () => {});
    const reader = (stream, name) => {
      let carry = "";
      stream.on("data", (d) => {
        const parts = (carry + String(d)).split(/\r?\n/);
        carry = parts.pop();
        for (const l of parts) if (l) this.emit("line", l, name, { seq: null, at: Date.now() });
      });
      stream.on("end", () => carry && this.emit("line", carry, name, { seq: null, at: Date.now() }));
    };
    reader(this.proc.stdout, "out");
    reader(this.proc.stderr, "err");
    this.proc.on("error", (e) => {
      if (!this.pid) {
        this.done = true;
        this.emit("exit", null, null, e.message);
      } else this.emit("line", "[hoster] " + e.message, "err", { seq: null, at: Date.now() });
    });
    this.proc.on("exit", (code, signal) => {
      this.done = true;
      this.emit("exit", code, signal, null);
    });
    setImmediate(() => this.pid && this.emit("hello", { pid: this.pid, startedAt: this.startedAt, ready: false, lines: [] }));
  }
  get writable() {
    return !this.done && this.proc.stdin.writable;
  }
  write(text) {
    if (!this.writable) return false;
    try {
      this.proc.stdin.write(text);
      return true;
    } catch {
      return false;
    }
  }
  kill() {
    killPid(this.pid);
  }
  release() {}
}

function direct(spec) {
  return new DirectHandle(spec);
}

module.exports = { launch, adopt, direct, knownKeys, killPid, socketPath, RUN_DIR };

/*
 * transfer.js — move a server between MC Hoster panels: export it to a file,
 * import that file somewhere else, or send it straight to another panel on
 * the network.
 *
 * An export is an ordinary zip:
 *   mchoster.json — what the server is: its loader, version, launch line and
 *                   the panel settings that travel with it (see TRAVELS);
 *   server/…      — the server folder, sorted into the same parts a duplicate
 *                   offers (world, mods/plugins, configs, player lists). The
 *                   server software always comes, so the other end starts it
 *                   without installing anything.
 *
 * Exports land in data/exports/, or in any folder on this computer (a USB
 * stick, a NAS share, another MC Hoster's folder). Importing takes the file
 * from the browser, from a path on this computer, or from another panel, and
 * runs like an install: the new server shows "Installing" with its progress on
 * its console.
 *
 * Sending is panel to panel: this one uploads the file to the other's
 * /api/import/upload and asks it to import what arrived. The panels have no
 * login, so this is for a home network, same as the rest of the panel.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");

const store = require("./store");
const manager = require("./manager");
const backup = require("./backup");
const duplicate = require("./duplicate");
const modrinth = require("./modrinth");
const loaders = require("./loaders");
const changelog = require("./changelog");
const zip = require("./zip");

const FORMAT = "mchoster-server";
const VERSION = 1;
const MANIFEST = "mchoster.json";
const PREFIX = "server/";
const EXPORTS_DIR = path.join(store.DATA_DIR, "exports");
const IMPORTS_DIR = path.join(store.DATA_DIR, "imports");
const INDEX = path.join(EXPORTS_DIR, "index.json");
const STAGED_TTL = 6 * 3600 * 1000;

// What a duplicate copies, less the Java path: that names a file on the other
// computer, and the panel there finds the right runtime by itself.
const TRAVELS = duplicate.COPIED.filter((k) => k !== "javaPath");
const NUMBERS = new Set(["memory", "maxPlayers", "pauseWhenEmpty", "sleepAfter", "lagRestartTps", "lagRestartMins", "backupEvery", "backupKeep"]);
const FLAGS = new Set(["wakeOnJoin", "restartOnCrash"]);

const mb = duplicate.mb;
const events = manager.events;

// Upload staging is per run: a token minted before a restart means nothing after.
fs.rmSync(IMPORTS_DIR, { recursive: true, force: true });

/* ------------------------------------------------------------------- index */
/*
 * data/exports/index.json lists every export this panel made, wherever it was
 * saved. It is reconciled on every read: an entry whose file is gone (moved,
 * deleted, a USB stick unplugged) is dropped.
 */
function readIndex() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(INDEX, "utf8"));
  } catch {}
  return list
    .filter((e) => {
      // The panel's own exports are kept by name, so moving the MC Hoster
      // folder doesn't lose them.
      if (!e.external) e.path = path.join(EXPORTS_DIR, path.basename(e.file || ""));
      try {
        e.size = fs.statSync(e.path).size;
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => b.created - a.created);
}
function writeIndex(list) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const slim = list.map(({ size, ...rest }) => (rest.external ? rest : { ...rest, path: undefined }));
  fs.writeFileSync(INDEX, JSON.stringify(slim, null, 2));
}
function entry(eid) {
  const e = readIndex().find((x) => x.id === eid);
  if (!e) throw new Error("That export no longer exists.");
  return e;
}

function exportsOf(id) {
  return readIndex().filter((e) => !id || e.serverId === id);
}

function removeExport(eid) {
  const e = entry(eid);
  if (sends.has(eid)) throw new Error("That export is being sent right now.");
  fs.rmSync(e.path, { force: true });
  writeIndex(readIndex().filter((x) => x.id !== eid));
  return { ok: true };
}

function openExport(eid) {
  const e = entry(eid);
  return { stream: fs.createReadStream(e.path), size: fs.statSync(e.path).size, file: path.basename(e.path) };
}

/* ------------------------------------------------------------------ events */

const rid = () => crypto.randomBytes(6).toString("hex");

function emit(id, extra) {
  const s = manager.slot(id);
  const job = s.backup && s.backup.kind === "export" ? { ...s.backup } : null;
  events.emit("event", { type: "transfer", id, job, ...extra });
}

// Per-file progress would be tens of thousands of events; a few a second will do.
function throttle(fn) {
  let last = 0;
  return (...a) => {
    const now = Date.now();
    if (now - last > 250) {
      last = now;
      fn(...a);
    }
  };
}

/* ------------------------------------------------------------------ export */

function fileSafe(name) {
  return String(name || "server").replace(/[^\w.() -]+/g, "_").replace(/^[ .]+|[ .]+$/g, "").slice(0, 60) || "server";
}

// The folder an export goes to: the panel's own by default, or any absolute
// folder on this computer, made if it isn't there yet.
function targetDir(dir) {
  const want = String(dir || "").trim();
  if (!want) {
    fs.mkdirSync(EXPORTS_DIR, { recursive: true });
    return EXPORTS_DIR;
  }
  if (!path.isAbsolute(want)) throw new Error("Give the full path of a folder, like D:\\Minecraft exports.");
  fs.mkdirSync(want, { recursive: true });
  if (!fs.statSync(want).isDirectory()) throw new Error("That path is a file, not a folder.");
  return path.resolve(want);
}

async function plan(id) {
  return { ...(await duplicate.plan(id)), exports: exportsOf(id), defaultDir: EXPORTS_DIR };
}

function manifestFor(def, opts, level) {
  const server = { name: def.name, port: def.port };
  for (const k of TRAVELS) if (def[k] !== undefined) server[k] = def[k];
  server.start = def.start;
  if (opts.content && def.voice && def.voice.enabled)
    server.voice = { enabled: true, installedByPanel: !!def.voice.installedByPanel };
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: Date.now(),
    from: { host: os.hostname(), platform: process.platform, build: changelog.stamp() },
    parts: duplicate.PARTS.filter((p) => opts[p]),
    level,
    server,
  };
}

/*
 * Start an export. Validation throws so the route can answer 400; the zipping
 * runs on, reporting through `transfer` events. With `send`, the finished file
 * goes straight on to that panel.
 */
function startExport(id, spec = {}) {
  const def = store.find(id);
  if (!def) throw new Error("Unknown server");
  const s = manager.slot(id);
  if (!def.start || s.install.active || s.preparing) throw new Error("Wait for this server to finish installing.");
  if (s.backup) throw new Error(s.backup.kind === "export" ? "This server is already being exported." : `Wait for the ${s.backup.kind} to finish.`);
  if (s.status === "starting" || s.status === "stopping") throw new Error(`Wait for the server to finish ${s.status}.`);

  const opts = Object.fromEntries(duplicate.PARTS.map((p) => [p, !!spec[p]]));
  if (!duplicate.contentFolder(def)) opts.content = false;
  const dir = targetDir(spec.dir);
  const to = spec.send ? normalizeUrl(spec.send) : null;

  const job = (s.backup = { kind: "export", phase: "starting", done: 0, total: 0, startedAt: Date.now(), send: to });
  emit(id);
  const live = opts.world && s.status === "running" && !!s.proc;
  const log = (line) => manager.emitConsole(id, "sys", "[hoster] " + line);

  (async () => {
    let partial = null;
    try {
      // A wrong address should cost a second, not a world's worth of packing.
      if (to) {
        job.phase = "connecting";
        emit(id);
        await hello(to);
      }
      if (live) {
        job.phase = "saving";
        emit(id);
        log("Export: flushing the world to disk…");
        if (!(await backup.quiesce(id))) log("Export: the server never confirmed the save — exporting what is on disk.");
      }

      job.phase = "collecting";
      emit(id);
      const root = store.dirFor(id);
      const kind = duplicate.classifier(def);
      const rels = (await fsp.readdir(root, { withFileTypes: true }))
        .filter((e) => {
          const part = kind(e.name, e.isDirectory());
          return part === "software" || opts[part];
        })
        .map((e) => e.name);
      const items = (await backup.collect(id, rels)).map((it) => ({ ...it, name: PREFIX + it.name }));

      let file = `${fileSafe(def.name)}_${backup.stamp()}.zip`;
      for (let n = 2; fs.existsSync(path.join(dir, file)); n++) file = `${fileSafe(def.name)}_${backup.stamp()}-${n}.zip`;
      const final = path.join(dir, file);
      partial = final + ".partial";

      const manifest = manifestFor(def, opts, backup.worldDirs(id)[0] || backup.levelName(id));
      const mfile = path.join(os.tmpdir(), `mchoster-${rid()}.json`);
      fs.writeFileSync(mfile, JSON.stringify(manifest, null, 2));

      job.phase = "zipping";
      emit(id);
      const tick = throttle(() => emit(id));
      let out;
      try {
        out = await zip.writeZip(partial, [{ name: MANIFEST, abs: mfile, mtime: new Date() }, ...items], {
          onEntry: (done, total) => {
            job.done = done;
            job.total = total;
            tick();
          },
        });
      } finally {
        fs.rmSync(mfile, { force: true });
      }
      await fsp.rename(partial, final);
      partial = null;

      const e = {
        id: rid(),
        path: final,
        file,
        created: Date.now(),
        serverId: id,
        serverName: def.name,
        loader: def.loader,
        modLoader: (def.start && def.start.modLoader) || null,
        mc: def.mc,
        parts: manifest.parts,
        files: out.files - 1,
        bytes: out.bytes,
        skipped: out.skipped.slice(0, 20),
        external: dir !== EXPORTS_DIR,
      };
      writeIndex([e, ...readIndex()]);
      const size = fs.statSync(final).size;
      log(`Exported to ${final} (${(out.files - 1).toLocaleString()} files, ${mb(size)})` +
        (out.skipped.length ? ` — ${out.skipped.length} locked file(s) skipped` : ""));
      s.backup = null;
      emit(id, { result: { ok: true, export: { ...e, size } } });
      if (to) send(e.id, to).catch(() => {});
    } catch (err) {
      if (partial) await fsp.rm(partial, { force: true }).catch(() => {});
      log("Export failed: " + err.message);
      s.backup = null;
      emit(id, { result: { ok: false, error: err.message } });
    } finally {
      if (live && s.proc) manager.sendCommand(id, "save-on");
      if (s.backup === job) s.backup = null;
    }
  })();

  return { ok: true };
}

/* -------------------------------------------------------------- sending */
/*
 * Another panel is an address like http://192.168.1.20:8100. Typed bare
 * ("192.168.1.20") it gets http:// and the panel's default port.
 */
function normalizeUrl(input) {
  const raw = String(input || "").trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!raw) throw new Error("Type the other panel's address.");
  const bare = !/^https?:\/\//i.test(raw);
  let u;
  try {
    u = new URL(bare ? "http://" + raw : raw);
  } catch {
    throw new Error(`"${input}" isn't an address.`);
  }
  if (bare && !/^[^/]*:\d+/.test(raw)) u.port = "8100";
  return u.origin;
}

function request(url, { method = "GET", body = null, headers = {}, timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).request(u, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let data = null;
        try {
          data = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, data });
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body && typeof body.pipe === "function") {
      body.on("error", (e) => req.destroy(e));
      body.pipe(req);
    }
    else req.end(body || undefined);
  });
}

// Is there an MC Hoster that takes imports at `to`?
async function hello(to) {
  let r;
  try {
    r = await request(`${to}/api/transfer/hello`, { timeout: 8000 });
  } catch (e) {
    throw new Error(`Nothing answered at ${to} (${e.code || e.message}). Is the other panel running, and is it on this network?`);
  }
  if (r.data && r.data.format === FORMAT) {
    if (r.data.version < VERSION) throw new Error(`The panel at ${to} is too old to take this export — update it first.`);
    return r.data;
  }
  if (r.data && r.data.error) throw new Error(`The panel at ${to} can't take imports yet — update it to the newest MC Hoster first.`);
  throw new Error(`${to} answered, but it isn't an MC Hoster panel.`);
}

const sends = new Map(); // export id -> { to, sent, total }

async function send(eid, toInput) {
  const e = entry(eid);
  const to = normalizeUrl(toInput);
  if (sends.has(eid)) throw new Error("That export is already being sent.");
  const job = { eid, to, phase: "connecting", sent: 0, total: fs.statSync(e.path).size, startedAt: Date.now() };
  sends.set(eid, job);
  const say = (extra = {}) => events.emit("event", { type: "transfer", id: e.serverId, send: { ...job }, ...extra });
  const log = (line) => store.find(e.serverId) && manager.emitConsole(e.serverId, "sys", "[hoster] " + line);
  say();
  try {
    const peer = await hello(to);
    job.phase = "sending";
    job.host = peer.host;
    say();
    log(`Sending ${e.file} (${mb(job.total)}) to ${peer.host || to}…`);

    const tick = throttle(say);
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        job.sent += chunk.length;
        tick();
        cb(null, chunk);
      },
    });
    const src = fs.createReadStream(e.path);
    src.on("error", (err) => counter.destroy(err));
    src.pipe(counter);
    const up = await request(`${to}/api/import/upload?name=${encodeURIComponent(e.file)}&from=${encodeURIComponent(os.hostname())}`, {
      method: "POST",
      body: counter,
      headers: { "Content-Type": "application/zip", "Content-Length": job.total },
      timeout: 120000, // idle time, not the whole upload
    });
    if (up.status !== 200 || !up.data || !up.data.token)
      throw new Error((up.data && up.data.error) || `the other panel answered ${up.status}`);

    job.phase = "importing";
    say();
    const imp = await request(`${to}/api/import`, {
      method: "POST",
      body: JSON.stringify({ token: up.data.token, auto: true }),
      headers: { "Content-Type": "application/json" },
    });
    if (imp.status !== 200 || !imp.data || !imp.data.server)
      throw new Error((imp.data && imp.data.error) || `the other panel answered ${imp.status}`);

    const where = { to, host: peer.host || null, id: imp.data.server.id, name: imp.data.server.name, url: `${to}/#/server/${imp.data.server.id}` };
    log(`✔ Sent to ${where.host || to} as "${where.name}". It is unpacking there now.`);
    sends.delete(eid);
    say({ send: null, result: { ok: true, kind: "send", eid, ...where } });
    return where;
  } catch (err) {
    sends.delete(eid);
    log(`Sending to ${to} failed: ${err.message}`);
    say({ send: null, result: { ok: false, kind: "send", eid, error: err.message, to } });
    throw err;
  }
}

/* ------------------------------------------------------------------ import */
/*
 * Importing is two steps so the person can see what arrived before a server
 * is made from it: stage the archive (an upload, a path, an export here) and
 * read its manifest, then import that token under a name and port.
 */
const staged = new Map(); // token -> { path, temp, manifest, from, size, at }

setInterval(() => {
  for (const [token, st] of staged)
    if (Date.now() - st.at > STAGED_TTL) dropStaged(token);
}, 10 * 60 * 1000).unref();

function dropStaged(token) {
  const st = staged.get(token);
  staged.delete(token);
  if (st && st.temp) fs.rm(st.path, { force: true }, () => {});
}

const safeRel = (p) =>
  typeof p === "string" && p && !path.isAbsolute(p) && !/^[a-zA-Z]:/.test(p) && !p.replace(/\\/g, "/").split("/").includes("..");

// The launch line decides what java is handed, so only the shapes the
// installers write get through, with paths inside the server folder.
function cleanStart(start) {
  if (!start || typeof start !== "object") throw new Error("The export doesn't say how to start the server.");
  const out = { type: start.type === "args" ? "args" : "jar" };
  if (out.type === "args") {
    if (!safeRel(start.argsFile)) throw new Error("The export's launch line points outside the server folder.");
    out.argsFile = start.argsFile;
  } else {
    if (!safeRel(start.jar)) throw new Error("The export's launch line points outside the server folder.");
    out.jar = start.jar;
  }
  out.args = Array.isArray(start.args) ? start.args.filter((a) => typeof a === "string").slice(0, 20) : ["nogui"];
  if (typeof start.modLoader === "string") out.modLoader = start.modLoader;
  if (start.pack && typeof start.pack === "object") out.pack = JSON.parse(JSON.stringify(start.pack));
  return out;
}

async function readManifest(file) {
  let raw;
  try {
    raw = await zip.readMember(file, MANIFEST);
  } catch (e) {
    throw new Error(`That file isn't a zip MC Hoster can read (${e.message}).`);
  }
  if (!raw) throw new Error("That zip isn't an MC Hoster server export — it has no mchoster.json. (World backups are restored from a server's Backups tab instead.)");
  let m;
  try {
    m = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("The export's mchoster.json is damaged.");
  }
  if (m.format !== FORMAT || !m.server) throw new Error("That zip isn't an MC Hoster server export.");
  if (Number(m.version) > VERSION) throw new Error("That export was made by a newer MC Hoster — update this panel first.");
  loaders.get(m.server.loader); // throws on a loader this panel doesn't know
  m.server.start = cleanStart(m.server.start);
  m.parts = (Array.isArray(m.parts) ? m.parts : []).filter((p) => duplicate.PARTS.includes(p));
  return m;
}

function uniqueName(name) {
  const base = String(name || "Imported server").trim().slice(0, 64) || "Imported server";
  const taken = new Set(store.all().map((d) => d.name));
  let out = base;
  for (let n = 2; taken.has(out); n++) out = `${base} (${n})`;
  return out;
}

async function stage(file, { temp, from = null }) {
  let m, size;
  try {
    m = await readManifest(file);
    size = fs.statSync(file).size;
  } catch (e) {
    if (temp) fs.rm(file, { force: true }, () => {});
    throw e;
  }
  const token = rid() + rid();
  staged.set(token, { path: file, temp, manifest: m, from, size, at: Date.now() });
  const srv = m.server;
  return {
    token,
    name: uniqueName(srv.name),
    port: duplicate.freePort(srv.port),
    original: { name: srv.name, port: srv.port, host: (m.from && m.from.host) || from, exportedAt: m.exportedAt || null },
    loader: srv.loader,
    modLoader: srv.start.modLoader || null,
    pack: srv.start.pack || null,
    mc: srv.mc,
    build: srv.build || null,
    memory: srv.memory || null,
    parts: m.parts,
    level: m.level || null,
    size,
    otherPlatform: !!(m.from && m.from.platform && m.from.platform !== process.platform),
  };
}

// The dialog closed without importing what it staged.
function cancelStaged(token) {
  if (staged.has(token)) dropStaged(token);
  return { ok: true };
}

// An upload from the browser or another panel, streamed to disk — exports
// run to gigabytes, far past what should sit in memory.
async function stageUpload(req, { from = null } = {}) {
  fs.mkdirSync(IMPORTS_DIR, { recursive: true });
  const file = path.join(IMPORTS_DIR, `${rid()}.zip`);
  try {
    await pipeline(req, fs.createWriteStream(file));
  } catch (e) {
    fs.rm(file, { force: true }, () => {});
    throw new Error("The upload didn't finish: " + e.message);
  }
  return stage(file, { temp: true, from: from ? String(from).slice(0, 80) : null });
}

// A zip already on this computer: an export in a folder, a USB stick, a share.
async function stagePath(p) {
  const file = String(p || "").trim().replace(/^"(.*)"$/, "$1");
  if (!file || !path.isAbsolute(file)) throw new Error("Give the full path of the export, like D:\\Minecraft exports\\Survival.zip.");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error("There's no file at that path.");
  }
  if (st.isDirectory()) throw new Error("That's a folder — give the path of the .zip inside it.");
  return stage(path.resolve(file), { temp: false });
}

async function stageExport(eid) {
  return stage(entry(eid).path, { temp: false });
}

// Forge and NeoForge launch from an args file named for the platform they
// were installed on; on the other one, use the twin the installer left beside it.
function fixArgsFile(def) {
  const st = def.start;
  if (st.type !== "args") return false;
  const dir = store.dirFor(def.id);
  const want = process.platform === "win32" ? "win_args.txt" : "unix_args.txt";
  if (path.basename(st.argsFile) === want) return false;
  const twin = path.posix.join(path.posix.dirname(st.argsFile.replace(/\\/g, "/")), want);
  if (!fs.existsSync(path.join(dir, twin))) return false;
  st.argsFile = twin;
  return true;
}

/*
 * Make a server from a staged archive. Validation throws so the route can
 * answer 400; the unpacking runs on, on the new server's console.
 */
function startImport(token, spec = {}) {
  const st = staged.get(token);
  if (!st) throw new Error("That upload has expired — add the file again.");
  const m = st.manifest;
  const srv = m.server;

  const name = spec.auto ? uniqueName(srv.name) : String(spec.name || "").trim().slice(0, 64) || uniqueName(srv.name);
  const port = spec.auto ? duplicate.freePort(srv.port) : Math.round(Number(spec.port)) || duplicate.freePort(srv.port);
  if (port < 1 || port > 65535) throw new Error("The port must be between 1 and 65535.");
  const clash = store.all().find((d) => Number(d.port) === port);
  if (clash) throw new Error(`Port ${port} is already used by ${clash.name}.`);
  staged.delete(token); // one server per upload; a second click mustn't make two

  const id = manager.newId();
  const def = { id, name, port };
  for (const k of TRAVELS) {
    if (srv[k] === undefined || srv[k] === null) continue;
    if (NUMBERS.has(k)) def[k] = Number(srv[k]) || 0;
    else if (FLAGS.has(k)) def[k] = !!srv[k];
    else def[k] = String(srv[k]).slice(0, 2000);
  }
  def.memory = def.memory || store.getSettings().defaultMemory || 4096;
  def.maxPlayers = def.maxPlayers || 20;
  def.start = srv.start;
  const content = m.parts.includes("content");
  if (!content && def.start.pack) def.start.pack = null;
  if (content && srv.voice && srv.voice.enabled)
    def.voice = { enabled: true, installedByPanel: !!srv.voice.installedByPanel, port: null };
  def.importedFrom = { name: srv.name, host: (m.from && m.from.host) || st.from || null, exportedAt: m.exportedAt || null, parts: m.parts };
  def.createdAt = Date.now();

  const dir = store.dirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  store.add(def);
  events.emit("event", { type: "servers" });
  const ns = manager.slot(id);
  ns.install.active = true;
  manager.setStatus(id, "installing");
  if (spec.auto) events.emit("event", { type: "transfer", id, received: { name, from: def.importedFrom.host } });
  const log = (line) => manager.emitConsole(id, "sys", "[hoster] " + line);

  (async () => {
    try {
      const from = def.importedFrom.host ? ` from ${def.importedFrom.host}` : "";
      log(`Importing ${srv.name}${from} — ${loaders.get(srv.loader).label} for Minecraft ${srv.mc}.`);
      let last = Date.now();
      const n = await zip.extractFile(st.path, dir, {
        prefix: PREFIX,
        onEntry: (done, total) => {
          if (done === 1) log(`Unpacking ${mb(st.size)}…`);
          if (Date.now() - last > 3000) {
            last = Date.now();
            log(`  ${Math.floor((done / total) * 100)}% unpacked…`);
          }
        },
      });
      if (!store.find(id)) return; // deleted while it was unpacking

      if (!m.parts.includes("config")) {
        manager.writeInitialProperties(def);
        if (m.parts.includes("world") && m.level && m.level !== "world") manager.patchProperties(id, { "level-name": m.level });
      } else manager.patchProperties(id, { "server-port": def.port, "max-players": def.maxPlayers });
      if (!content) modrinth.forgetPack(dir);
      if (fixArgsFile(def)) log(`It last ran on a different operating system, so it launches with ${path.posix.basename(def.start.argsFile)} here.`);
      store.update(id, { start: def.start });

      ns.install.active = false;
      log(`✔ Imported ${n.toLocaleString()} files.`);
      log(manager.isEulaAccepted(id) ? "Ready — hit Start." : "Accept the EULA, then hit Start.");
      manager.setStatus(id, "stopped");
      events.emit("event", { type: "servers" });
    } catch (e) {
      ns.install.active = false;
      log("✖ Import failed: " + e.message);
      if (store.find(id)) manager.setStatus(id, "install-failed");
    } finally {
      if (st.temp) fs.rm(st.path, { force: true }, () => {});
    }
  })();

  return def;
}

function helloInfo() {
  return { format: FORMAT, version: VERSION, app: "MC Hoster", host: os.hostname(), build: changelog.stamp() };
}

module.exports = {
  plan,
  startExport,
  exportsOf,
  removeExport,
  openExport,
  send,
  normalizeUrl,
  stageUpload,
  stagePath,
  stageExport,
  startImport,
  cancelStaged,
  helloInfo,
  sending: () => [...sends.values()],
};

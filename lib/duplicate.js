/*
 * duplicate.js — copy a server into a new one, choosing what comes along.
 *
 * A server folder is sorted into parts by its top-level names:
 *   world   — the level folder from server.properties and its _nether/_the_end
 *             (datapacks live inside it, so on vanilla they come with it);
 *   content — mods/ or plugins/ (plugins keep their configs in there too);
 *   config  — server.properties, config/, defaultconfigs/ and the loose
 *             .yml/.toml/.properties files Paper and friends keep at the top;
 *   players — ops, whitelist, bans and the name cache.
 * Logs and crash reports are never copied. Everything else is the server
 * software itself (jars, libraries, the loader's own files) and always comes,
 * so the copy runs without installing anything.
 *
 * Copying runs like an install: the new server shows "Installing" with the
 * progress on its console. The original is held the way a backup holds it —
 * no start, restore or delete until the copy is done — and a running original
 * is asked to flush its world first and stop autosaving until the copy has it.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const store = require("./store");
const manager = require("./manager");
const backup = require("./backup");
const modrinth = require("./modrinth");

const PARTS = ["world", "content", "config", "players"];
const NEVER = new Set(["logs", "crash-reports", "debug"]);
const PLAYER_FILES = new Set(["ops.json", "whitelist.json", "banned-players.json", "banned-ips.json", "usercache.json", "usernamecache.json"]);
const CONFIG_DIRS = new Set(["config", "defaultconfigs"]);
const CONFIG_FILE = /\.(ya?ml|toml|properties|json5|cfg|conf)$/i;

// Panel settings that belong to the copy as much as the original. Public
// addresses, opening hours and "start with panel" stay behind: two servers
// coming up together, or fighting over one tunnel, is never what was meant.
const COPIED = [
  "loader", "mc", "build", "memory", "maxPlayers", "icon", "javaPath", "jvmArgs",
  "pauseWhenEmpty", "sleepAfter", "wakeOnJoin", "restartOnCrash", "lagRestartTps", "lagRestartMins",
  "backupEvery", "backupKeep", "backupScope",
];

/* -------------------------------------------------------- what goes where */

function contentFolder(def) {
  const t = modrinth.targetFor(def);
  return t && t.folder !== "datapacks" ? t.folder : null;
}

// Top-level name -> part (or "software" / "never").
function classifier(def) {
  const worlds = new Set(backup.worldDirs(def.id));
  const content = contentFolder(def);
  return (name, isDir) => {
    if (NEVER.has(name)) return "never";
    if (worlds.has(name)) return "world";
    if (content && name === content) return "content";
    if (PLAYER_FILES.has(name)) return "players";
    if (isDir ? CONFIG_DIRS.has(name) : CONFIG_FILE.test(name)) return "config";
    return "software";
  };
}

// Sizes of each part, for the dialog. The Files tab's measurement is cached,
// so asking twice in a row doesn't walk a big world twice.
async function plan(id) {
  const def = store.find(id);
  if (!def) throw new Error("Unknown server");
  const disk = await manager.perf.diskUsage(id, "");
  const kind = classifier(def);
  const sizes = Object.fromEntries([...PARTS, "software"].map((p) => [p, 0]));
  const has = Object.fromEntries(PARTS.map((p) => [p, false]));
  for (const e of disk.entries) {
    const part = kind(e.name, e.dir);
    if (part === "never") continue;
    sizes[part] += e.bytes;
    if (part in has) has[part] = true;
  }
  const t = modrinth.targetFor(def);
  return {
    name: copyName(def.name),
    port: freePort(def.port),
    level: backup.worldDirs(id)[0] || null,
    content: contentFolder(def) ? { noun: t.noun, folder: t.folder } : null,
    // Datapacks live in the world, so a vanilla server's come with it.
    datapacks: !!t && t.folder === "datapacks",
    modded: !!t && t.folder !== "datapacks",
    sizes,
    has,
    running: manager.slot(id).status === "running",
  };
}

function copyName(name) {
  const base = String(name || "Server").replace(/ \(copy(?: \d+)?\)$/, "");
  const taken = new Set(store.all().map((d) => d.name));
  let out = `${base} (copy)`;
  for (let n = 2; taken.has(out); n++) out = `${base} (copy ${n})`;
  return out;
}

// The first port above the original's that no server here uses for its game
// or its voice chat.
function freePort(from) {
  const taken = new Set();
  for (const d of store.all()) {
    taken.add(Number(d.port));
    if (d.voice && d.voice.port) taken.add(Number(d.voice.port));
  }
  let port = Number(from) || 25565;
  while (taken.has(port) || port > 65535) port = port > 65535 ? 25565 : port + 1;
  return port;
}

/* ----------------------------------------------------------------- copying */

// Every file under `rels`, relative to `root`. A world is tens of thousands of
// files, so this is listed first to give the progress lines a total.
async function listFiles(root, rels) {
  const files = [];
  const dirs = [];
  let bytes = 0;
  const walk = async (rel) => {
    const st = await fsp.lstat(path.join(root, rel));
    if (st.isDirectory()) {
      dirs.push(rel);
      for (const e of await fsp.readdir(path.join(root, rel))) await walk(path.join(rel, e));
    } else if (st.isFile() && path.basename(rel) !== "session.lock") {
      files.push(rel);
      bytes += st.size;
    }
  };
  for (const r of rels) await walk(r);
  return { files, dirs, bytes };
}

const mb = (b) => (b / 1048576).toFixed(b < 10 * 1048576 ? 1 : 0) + " MB";

// `gone` says the new server was deleted mid-copy, which ends it quietly.
async function copyAll(from, to, rels, log, gone) {
  const { files, dirs, bytes } = await listFiles(from, rels);
  log(`Copying ${files.length.toLocaleString()} files (${mb(bytes)})…`);
  for (const d of dirs) await fsp.mkdir(path.join(to, d), { recursive: true });
  const skipped = [];
  let last = Date.now();
  for (let i = 0; i < files.length; i++) {
    if (i % 200 === 0 && gone()) return null;
    try {
      await fsp.copyFile(path.join(from, files[i]), path.join(to, files[i]));
    } catch (e) {
      // A file the running server holds locked; the rest is still worth having.
      if (!["EBUSY", "EPERM", "EACCES"].includes(e.code)) throw e;
      skipped.push(files[i]);
    }
    if (Date.now() - last > 3000) {
      last = Date.now();
      log(`  ${(i + 1).toLocaleString()} of ${files.length.toLocaleString()} files copied…`);
    }
  }
  return { files: files.length - skipped.length, bytes, skipped };
}

// Let the copy's own files say what it is: a fresh server.properties when the
// original's stayed behind, its new port either way, and no modpack once the
// pack's mods stayed behind.
function settle(srcId, def, opts) {
  if (!opts.config) {
    const level = backup.worldDirs(srcId)[0];
    manager.writeInitialProperties(def);
    // The world folder came under its own name; a fresh properties file would
    // otherwise go looking for "world" and generate a new one.
    if (opts.world && level && level !== "world") manager.patchProperties(def.id, { "level-name": level });
  } else manager.patchProperties(def.id, { "server-port": def.port, "max-players": def.maxPlayers });

  if (!opts.content) modrinth.forgetPack(store.dirFor(def.id));
}

/*
 * Start a copy. Validation throws so the route can answer 400; the copying
 * itself runs on and reports on the new server's console.
 */
function duplicate(srcId, spec = {}) {
  const src = store.find(srcId);
  if (!src) throw new Error("Unknown server");
  const s = manager.slot(srcId);
  if (!src.start || s.install.active || s.preparing) throw new Error("Wait for this server to finish installing.");
  if (s.backup) throw new Error(s.backup.kind === "copy" ? "This server is already being copied." : `Wait for the ${s.backup.kind} to finish.`);
  if (s.status === "starting" || s.status === "stopping") throw new Error(`Wait for the server to finish ${s.status}.`);

  const opts = Object.fromEntries(PARTS.map((p) => [p, !!spec[p]]));
  if (!contentFolder(src)) opts.content = false;
  const name = String(spec.name || "").trim().slice(0, 64) || copyName(src.name);
  const port = Math.round(Number(spec.port)) || freePort(src.port);
  if (port < 1 || port > 65535) throw new Error("The port must be between 1 and 65535.");
  const clash = store.all().find((d) => Number(d.port) === port);
  if (clash) throw new Error(`Port ${port} is already used by ${clash.name}.`);

  const id = manager.newId();
  const def = { id, name, port };
  for (const k of COPIED) if (src[k] !== undefined) def[k] = src[k];
  def.start = JSON.parse(JSON.stringify(src.start));
  // A pack's mods are what make it that pack; without them it's just its loader.
  if (!opts.content && def.start.pack) def.start.pack = null;
  // Voice chat comes with the mod; its port is picked fresh at the first start.
  if (opts.content && src.voice && src.voice.enabled)
    def.voice = { enabled: true, installedByPanel: !!src.voice.installedByPanel, port: null };
  def.copiedFrom = { id: srcId, name: src.name, parts: PARTS.filter((p) => opts[p]) };
  def.createdAt = Date.now();

  const to = store.dirFor(id);
  fs.mkdirSync(to, { recursive: true });
  store.add(def);
  manager.events.emit("event", { type: "servers" });
  const ns = manager.slot(id);
  ns.install.active = true;
  manager.setStatus(id, "installing");

  // Hold the original: nothing may start it, restore over it or delete it
  // while its files are on their way.
  s.backup = { kind: "copy", phase: "copying", done: 0, total: 0, startedAt: Date.now() };
  manager.events.emit("event", { type: "status", ...manager.summary(srcId) });
  // On the copy's console rather than its install log, so the lines are
  // replayed to anyone opening it later — a small server is copied in a blink.
  const log = (line) => manager.emitConsole(id, "sys", "[hoster] " + line);

  (async () => {
    const live = opts.world && s.status === "running" && !!s.proc;
    try {
      const LABEL = { world: "the world", content: (modrinth.targetFor(src) || {}).noun, config: "configs", players: "player lists" };
      const what = PARTS.filter((p) => opts[p]).map((p) => String(LABEL[p]).toLowerCase());
      log(`Copying ${src.name} — the server software${what.length ? ", " + what.join(", ") : " only"}.`);
      if (live) {
        log("Flushing the world to disk first…");
        manager.emitConsole(srcId, "sys", `[hoster] Copying this world to ${name}: flushing it to disk…`);
        if (!(await backup.quiesce(srcId))) log("The server never confirmed the save — copying what is on disk.");
      }

      const from = store.dirFor(srcId);
      const kind = classifier(src);
      const rels = (await fsp.readdir(from, { withFileTypes: true }))
        .filter((e) => {
          const part = kind(e.name, e.isDirectory());
          return part === "software" || opts[part];
        })
        .map((e) => e.name);
      const out = await copyAll(from, to, rels, log, () => !store.find(id));
      if (!out || !store.find(id)) return; // deleted while it was copying

      settle(srcId, store.find(id), opts);
      ns.install.active = false;
      log(`✔ Copied ${out.files.toLocaleString()} files (${mb(out.bytes)}).` +
        (out.skipped.length ? ` ${out.skipped.length} locked file(s) skipped: ${out.skipped.slice(0, 5).join(", ")}` : ""));
      log(manager.isEulaAccepted(id) ? "Ready — hit Start." : "Accept the EULA, then hit Start.");
      manager.setStatus(id, "stopped");
      manager.events.emit("event", { type: "servers" });
    } catch (e) {
      ns.install.active = false;
      log("✖ Copy failed: " + e.message);
      if (store.find(id)) manager.setStatus(id, "install-failed");
    } finally {
      if (live && s.proc) manager.sendCommand(srcId, "save-on");
      if (live) manager.emitConsole(srcId, "sys", `[hoster] Copy to ${name} finished.`);
      s.backup = null;
      if (store.find(srcId)) manager.events.emit("event", { type: "status", ...manager.summary(srcId) });
    }
  })();

  return def;
}

module.exports = { PARTS, COPIED, plan, duplicate, classifier, contentFolder, freePort, mb };

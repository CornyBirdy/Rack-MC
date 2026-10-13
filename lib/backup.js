/*
 * backup.js — world backups: make them, list them, restore them, and take them
 * on a timer.
 *
 * A backup is an ordinary .zip under data/backups/<server id>/, so it can be
 * downloaded and opened anywhere. Two scopes:
 *   world — the level folder from server.properties plus the _nether/_the_end
 *           folders Paper-family servers split dimensions into.
 *   full  — the whole server folder: world, mods, configs, jars, everything.
 *
 * A running server keeps writing chunks, so backing one up live follows the
 * usual console dance: `save-off` stops autosaves, `save-all flush` writes
 * everything out, we zip, `save-on` puts it back. Players stay connected.
 *
 * Restores only happen with the server stopped. The archive is extracted into a
 * scratch folder next to the server first and swapped in only once every file
 * has passed its CRC check, so a bad zip leaves the current world untouched.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const store = require("./store");
const manager = require("./manager");
const zip = require("./zip");

const BACKUPS_DIR = path.join(store.DATA_DIR, "backups");
const SCOPES = ["world", "full"];
const SAVE_TIMEOUT = 90 * 1000; // a big modpack can take a while to flush
const SAVED = /Saved the (game|world)|All dimensions are saved|All chunks are saved/i;

const dirOf = (id) => path.join(BACKUPS_DIR, id);
const indexOf = (id) => path.join(dirOf(id), "index.json");

/* ------------------------------------------------------------------- index */
/*
 * index.json carries what a zip can't say about itself cheaply — scope, note,
 * whether the scheduler made it. It is reconciled against the folder on every
 * read: an entry whose zip is gone is dropped, and a zip someone dropped in by
 * hand still shows up.
 */
function readIndex(id) {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(indexOf(id), "utf8"));
  } catch {}
  let names = [];
  try {
    names = fs.readdirSync(dirOf(id)).filter((n) => n.toLowerCase().endsWith(".zip"));
  } catch {}
  const have = new Set(names);
  list = list.filter((b) => have.has(b.file));
  const known = new Set(list.map((b) => b.file));
  for (const file of names) {
    if (known.has(file)) continue;
    const st = fs.statSync(path.join(dirOf(id), file));
    list.push({ file, created: st.mtimeMs, scope: "full", auto: false, note: "Added by hand" });
  }
  for (const b of list) {
    try {
      b.size = fs.statSync(path.join(dirOf(id), b.file)).size;
    } catch {
      b.size = 0;
    }
  }
  return list.sort((a, b) => b.created - a.created);
}
function writeIndex(id, list) {
  fs.mkdirSync(dirOf(id), { recursive: true });
  const slim = list.map(({ size, ...rest }) => rest); // size is read off the disk
  fs.writeFileSync(indexOf(id), JSON.stringify(slim, null, 2));
}

// Only names we minted (or that look like a plain zip) are ever touched, so a
// request can't reach outside the backups folder.
function fileFor(id, file) {
  if (typeof file !== "string" || !/^[\w.() -]+\.zip$/i.test(file) || file.includes(".."))
    throw new Error("Bad backup name.");
  const full = path.join(dirOf(id), file);
  if (!fs.existsSync(full)) throw new Error("That backup no longer exists.");
  return full;
}

/* -------------------------------------------------------------- what to zip */

function levelName(id) {
  const m = /^level-name=(.*)$/m.exec(manager.readProperties(id));
  // .properties escapes ":" "=" and friends with a backslash.
  const name = m ? m[1].trim().replace(/\\(.)/g, "$1") : "";
  return name || "world";
}

// The world folders that exist right now, relative to the server folder.
function worldDirs(id) {
  const root = path.resolve(store.dirFor(id));
  const lvl = levelName(id);
  return [lvl, lvl + "_nether", lvl + "_the_end"].filter((n) => {
    const full = path.resolve(root, n);
    if (!full.startsWith(root + path.sep)) return false;
    try {
      return fs.statSync(full).isDirectory();
    } catch {
      return false;
    }
  });
}

// Walk `rels` under the server folder into writeZip items. session.lock is held
// open by a running server and means nothing in a backup, so it stays out.
async function collect(id, rels) {
  const root = store.dirFor(id);
  const items = [];
  const walk = async (rel) => {
    const abs = path.join(root, rel);
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) {
      if (path.basename(rel) !== "session.lock")
        items.push({ name: rel.split(path.sep).join("/"), abs, mtime: st.mtime });
      return;
    }
    if (rel) items.push({ name: rel.split(path.sep).join("/"), dir: true, mtime: st.mtime });
    for (const e of await fsp.readdir(abs)) await walk(rel ? path.join(rel, e) : e);
  };
  for (const r of rels) await walk(r);
  return items;
}

/* ---------------------------------------------------------- job bookkeeping */
/*
 * One job per server at a time, held on the manager's runtime slot so start()
 * can refuse to boot a server whose folder is being zipped or replaced.
 * Progress rides the same event bus as everything else.
 */
function emitJob(id) {
  const job = manager.slot(id).backup;
  manager.events.emit("event", { type: "backup", id, job: job ? { ...job } : null });
}

function beginJob(id, job) {
  const s = manager.slot(id);
  if (s.backup) throw new Error(`A ${s.backup.kind} is already running for this server.`);
  if (s.install.active || s.preparing) throw new Error("The server is still installing.");
  s.backup = { ...job, done: 0, total: 0, startedAt: Date.now() };
  emitJob(id);
  return s.backup;
}

function endJob(id, result) {
  manager.slot(id).backup = null;
  manager.events.emit("event", { type: "backup", id, job: null, result });
}

// Progress callbacks fire per file; tens of thousands of SSE frames would be
// noise, so publish at most a few a second.
function progress(id, job) {
  let last = 0;
  return (done, total) => {
    job.done = done;
    job.total = total;
    const now = Date.now();
    if (now - last > 250 || done === total) {
      last = now;
      emitJob(id);
    }
  };
}

// Ask a running server to stop autosaving and flush everything to disk. Resolves
// true once the console confirms the save, false if it never says so in time.
function quiesce(id) {
  return new Promise((resolve) => {
    let timer;
    const finish = (ok) => {
      clearTimeout(timer);
      manager.events.off("event", onEvent);
      resolve(ok);
    };
    const onEvent = (e) => {
      if (e.id !== id) return;
      if (e.type === "console" && e.stream !== "sys" && SAVED.test(e.line)) finish(true);
      if (e.type === "status" && e.status !== "running") finish(false);
    };
    manager.events.on("event", onEvent);
    timer = setTimeout(() => finish(false), SAVE_TIMEOUT);
    manager.sendCommand(id, "save-off");
    manager.sendCommand(id, "save-all flush");
  });
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/* ---------------------------------------------------------------- creating */

// The zipping itself; the caller holds the job. Returns the index entry.
async function makeBackup(id, job, { scope, note, auto }) {
  const def = store.find(id);
  const s = manager.slot(id);
  const rels = scope === "full" ? [""] : worldDirs(id);
  if (!rels.length) throw new Error("There is no world yet — start the server once to generate one.");

  // A server mid-boot or mid-shutdown is writing its world in ways a console
  // command can't pause; wait for it to settle instead.
  if (s.status === "starting" || s.status === "stopping")
    throw new Error(`Wait for the server to finish ${s.status}.`);

  const live = s.status === "running" && !!s.proc;
  try {
    if (live) {
      job.phase = "saving";
      emitJob(id);
      manager.emitConsole(id, "sys", "[hoster] Backup: flushing the world to disk…");
      if (!(await quiesce(id)))
        manager.emitConsole(id, "sys", "[hoster] Backup: the server never confirmed the save — backing up what is on disk.");
    }

    job.phase = "collecting";
    emitJob(id);
    const items = rels[0] === "" ? (await collect(id, await fsp.readdir(store.dirFor(id)))) : await collect(id, rels);

    job.phase = "zipping";
    fs.mkdirSync(dirOf(id), { recursive: true });
    let file = `${stamp()}_${scope}.zip`;
    for (let n = 2; fs.existsSync(path.join(dirOf(id), file)); n++) file = `${stamp()}_${scope}-${n}.zip`;
    const final = path.join(dirOf(id), file);
    const partial = final + ".partial";
    let out;
    try {
      out = await zip.writeZip(partial, items, { onEntry: progress(id, job) });
      await fsp.rename(partial, final);
    } catch (e) {
      await fsp.rm(partial, { force: true });
      throw e;
    }

    const entry = {
      file,
      created: Date.now(),
      scope,
      auto: !!auto,
      note: String(note || "").slice(0, 120),
      level: levelName(id),
      mc: def ? def.mc : null,
      files: out.files,
      bytes: out.bytes,
      skipped: out.skipped.slice(0, 20),
      live,
    };
    // The zip is already on disk, so the reconcile pass has just listed it as a
    // stray — swap that placeholder for the real entry.
    const list = readIndex(id).filter((b) => b.file !== file);
    list.unshift(entry);
    writeIndex(id, list);
    const size = fs.statSync(final).size;
    manager.emitConsole(
      id, "sys",
      `[hoster] Backup saved: ${file} (${out.files} files, ${(size / 1048576).toFixed(1)} MB)` +
        (out.skipped.length ? ` — ${out.skipped.length} locked file(s) skipped` : "")
    );
    return { ...entry, size };
  } finally {
    // Only a server still up can take the command; one that stopped meanwhile
    // comes back with autosave on anyway.
    if (live && s.proc) manager.sendCommand(id, "save-on");
  }
}

/*
 * Start a backup. Validation errors throw synchronously so the route can answer
 * 400; the work itself runs on and reports through the event bus, since a big
 * world takes far longer than anyone wants to hold a request open.
 */
function create(id, { scope = "world", note = "", auto = false } = {}) {
  if (!store.find(id)) throw new Error("Unknown server");
  if (!SCOPES.includes(scope)) throw new Error("Unknown backup scope.");
  const s = manager.slot(id);
  if (s.status === "starting" || s.status === "stopping")
    throw new Error(`Wait for the server to finish ${s.status}.`);
  const job = beginJob(id, { kind: "backup", phase: "starting", scope, auto: !!auto });
  return makeBackup(id, job, { scope, note, auto }).then(
    (entry) => {
      if (auto) prune(id);
      endJob(id, { ok: true, kind: "backup", file: entry.file, auto: !!auto });
      return entry;
    },
    (e) => {
      manager.emitConsole(id, "sys", "[hoster] Backup failed: " + e.message);
      endJob(id, { ok: false, kind: "backup", error: e.message, auto: !!auto });
      throw e;
    }
  );
}

/* --------------------------------------------------------------- restoring */

// Windows can hold a just-closed folder for a moment (indexer, antivirus), so
// renames and removals get a few tries before giving up.
async function retry(fn) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 5 || !["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}

function restore(id, file, { safety = true } = {}) {
  if (!store.find(id)) throw new Error("Unknown server");
  const full = fileFor(id, file);
  const s = manager.slot(id);
  if (s.proc || !["stopped", "crashed"].includes(s.status))
    throw new Error("Stop the server before restoring a backup.");
  const meta = readIndex(id).find((b) => b.file === file) || { scope: "full" };
  const job = beginJob(id, { kind: "restore", phase: "starting", scope: meta.scope, file });

  return (async () => {
    const root = store.dirFor(id);
    const scratch = path.join(store.SERVERS_DIR, `${id}.restoring`);
    try {
      // A world that has existed since the backup was taken is about to be
      // replaced; keep it, unless the person said not to.
      if (safety && (meta.scope === "full" || worldDirs(id).length)) {
        job.phase = "safety";
        emitJob(id);
        await makeBackup(id, job, { scope: meta.scope, note: `Before restoring ${file}`, auto: false });
      }

      job.phase = "extracting";
      job.done = job.total = 0;
      emitJob(id);
      await fsp.rm(scratch, { recursive: true, force: true });
      await fsp.mkdir(scratch, { recursive: true });
      await zip.extractFile(full, scratch, { onEntry: progress(id, job) });

      job.phase = "swapping";
      emitJob(id);
      const incoming = await fsp.readdir(scratch);
      // A full backup is the whole folder; a world backup replaces the world
      // folders — including any dimension generated since, which would no
      // longer line up with the restored overworld.
      const outgoing = meta.scope === "full"
        ? await fsp.readdir(root)
        : [...new Set([...incoming, ...worldDirs(id)])];
      for (const name of outgoing) await retry(() => fsp.rm(path.join(root, name), { recursive: true, force: true }));
      for (const name of incoming) await retry(() => fsp.rename(path.join(scratch, name), path.join(root, name)));

      manager.emitConsole(id, "sys", `[hoster] Restored ${file}.`);
      endJob(id, { ok: true, kind: "restore", file });
    } catch (e) {
      manager.emitConsole(id, "sys", "[hoster] Restore failed: " + e.message);
      endJob(id, { ok: false, kind: "restore", error: e.message });
      throw e;
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  })();
}

/* ----------------------------------------------------------- list / delete */

function list(id) {
  const def = store.find(id) || {};
  return {
    backups: readIndex(id),
    job: manager.slot(id).backup,
    level: levelName(id),
    hasWorld: worldDirs(id).length > 0,
    schedule: scheduleOf(def),
  };
}

function remove(id, file) {
  const full = fileFor(id, file);
  const s = manager.slot(id);
  if (s.backup && s.backup.file === file) throw new Error("That backup is being restored right now.");
  fs.rmSync(full, { force: true });
  writeIndex(id, readIndex(id));
  return { ok: true };
}

function openRead(id, file) {
  const full = fileFor(id, file);
  return { stream: fs.createReadStream(full), size: fs.statSync(full).size };
}

// Called when a server is deleted — its backups go with it.
function forget(id) {
  fs.rmSync(dirOf(id), { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}

/* ---------------------------------------------------------------- schedule */
/*
 * Per server: back up every N hours while it is running, keep the newest K of
 * those. Backups made by hand are never pruned. A stopped server's world isn't
 * changing, so there is nothing new to take.
 */
function scheduleOf(def) {
  return {
    every: Math.max(0, Number(def.backupEvery) || 0), // hours, 0 = off
    keep: Math.max(1, Number(def.backupKeep) || 7),
    scope: SCOPES.includes(def.backupScope) ? def.backupScope : "world",
  };
}

function prune(id) {
  const { keep } = scheduleOf(store.find(id) || {});
  const autos = readIndex(id).filter((b) => b.auto);
  for (const b of autos.slice(keep)) {
    try {
      fs.rmSync(path.join(dirOf(id), b.file), { force: true });
    } catch {}
  }
  writeIndex(id, readIndex(id));
}

function tick() {
  for (const def of store.all()) {
    const sch = scheduleOf(def);
    if (!sch.every) continue;
    const s = manager.slot(def.id);
    if (s.status !== "running" || s.backup) continue;
    const last = readIndex(def.id)[0];
    // Count from whichever came later: the last backup, or the server coming
    // up — so a server that just booted isn't backed up before it's done much.
    const since = Math.max(last ? last.created : 0, s.startedAt || 0);
    if (Date.now() - since < sch.every * 3600 * 1000) continue;
    try {
      create(def.id, { scope: sch.scope, auto: true, note: "Scheduled" }).catch(() => {});
    } catch {}
  }
}
setInterval(tick, 60 * 1000).unref();

module.exports = { SCOPES, create, restore, list, remove, openRead, forget, scheduleOf };

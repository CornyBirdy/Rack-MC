/*
 * modrinth.js — Modrinth integration: browsing and installing content into a
 * server, plus unpacking Modrinth modpacks (.mrpack).
 *
 * Two separate jobs live here:
 *
 *  1. Content. `search`/`versions` wrap the public v2 API, and `install`
 *     downloads a project's jar into the right folder for the server's loader
 *     (mods/, plugins/ or world/<level>/datapacks/), pulling required
 *     dependencies with it. What we put there is recorded in a per-server
 *     manifest so the panel can list, update and remove it later.
 *
 *  2. Modpacks. A .mrpack is a zip holding modrinth.index.json — a list of
 *     files to fetch plus the loader versions the pack pins. `readPack` gets
 *     it, `applyPack` materialises it. loaders.js drives the two around its own
 *     Fabric/Forge/NeoForge/Quilt install, which is why they're split.
 *
 * No API key is needed; everything used here is public and unauthenticated.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const net = require("./net");
const zip = require("./zip");

const API = "https://api.modrinth.com/v2";
// Modrinth asks integrations to identify themselves in the User-Agent.
const HEADERS = { "User-Agent": "MC-Hoster/1.0 (self-hosted Minecraft panel)" };

const MANIFEST_DIR = ".mchoster";
const MANIFEST_FILE = "modrinth.json";

/* ---------------------------------------------------------------- API calls */

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    p.set(k, typeof v === "string" || typeof v === "number" ? String(v) : JSON.stringify(v));
  }
  const s = p.toString();
  return s ? "?" + s : "";
}

function api(pathname, params = {}) {
  return net.getJson(`${API}${pathname}${qs(params)}`, { headers: HEADERS });
}

/*
 * Search projects. `loaders` and `mc` narrow results to what this server can
 * actually run; `serverOnly` drops projects Modrinth marks client-side only,
 * which is most of the graphics mods people would otherwise install by mistake.
 */
async function search({
  query = "",
  projectType = "mod",
  loaders = [],
  mc = null,
  serverOnly = true,
  index = "relevance",
  offset = 0,
  limit = 20,
} = {}) {
  const facets = [[`project_type:${projectType}`]];
  if (loaders.length) facets.push(loaders.map((l) => `categories:${l}`));
  if (mc) facets.push([`versions:${mc}`]);
  if (serverOnly && projectType !== "modpack")
    facets.push(["server_side:required", "server_side:optional", "server_side:unknown"]);

  const d = await api("/search", { query, facets, index, offset, limit });
  return {
    total: d.total_hits,
    offset: d.offset,
    hits: (d.hits || []).map(hit),
  };
}

function hit(h) {
  return {
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    author: h.author,
    downloads: h.downloads,
    follows: h.follows,
    icon: h.icon_url || null,
    categories: (h.display_categories || h.categories || []).slice(0, 4),
    projectType: (h.all_project_types && h.all_project_types[0]) || h.project_type,
    clientSide: h.client_side,
    serverSide: h.server_side,
    updated: h.date_modified,
    // Enough to tell whether a result fits this server. Only needed once the
    // compatibility filter is unlocked, but it costs nothing to always send.
    gameVersions: h.versions || [],
    loaderTags: (h.categories || []).filter((c) => LOADER_TAGS.has(c)),
  };
}

// Versions of one project, newest first, optionally filtered to a loader/MC pair.
async function versions(project, { loaders = [], mc = null } = {}) {
  const params = {};
  if (loaders.length) params.loaders = loaders;
  if (mc) params.game_versions = [mc];
  const list = await api(`/project/${encodeURIComponent(project)}/version`, params);
  return list.map(versionInfo);
}

function versionInfo(v) {
  const file = v.files.find((f) => f.primary) || v.files[0] || null;
  return {
    id: v.id,
    projectId: v.project_id,
    name: v.name,
    number: v.version_number,
    type: v.version_type, // release | beta | alpha
    loaders: v.loaders,
    gameVersions: v.game_versions,
    published: v.date_published,
    downloads: v.downloads,
    dependencies: (v.dependencies || []).map((d) => ({
      projectId: d.project_id,
      versionId: d.version_id,
      type: d.dependency_type, // required | optional | incompatible | embedded
    })),
    file: file && {
      name: file.filename,
      url: file.url,
      size: file.size,
      sha1: file.hashes && file.hashes.sha1,
    },
  };
}

async function version(id) {
  return versionInfo(await api(`/version/${encodeURIComponent(id)}`));
}

// Look up many projects at once — used after a modpack install, where asking
// for 50 titles one at a time would be 50 round trips.
async function projects(ids) {
  if (!ids.length) return [];
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const batch = await api("/projects", { ids: ids.slice(i, i + 100) });
    out.push(...batch);
  }
  return out;
}

async function project(id) {
  const p = await api(`/project/${encodeURIComponent(id)}`);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body,
    icon: p.icon_url || null,
    downloads: p.downloads,
    categories: p.categories,
    loaders: p.loaders,
    gameVersions: p.game_versions,
    clientSide: p.client_side,
    serverSide: p.server_side,
    projectType: p.project_type,
    source: p.source_url || p.wiki_url || null,
  };
}

/* --------------------------------------------------- what fits which server */

/*
 * Each loader eats a different kind of content out of a different folder.
 * `loaders` is the set of Modrinth loader tags a server can run: Quilt loads
 * Fabric mods, and Paper/Purpur load anything built for Bukkit or Spigot.
 */
const TARGETS = {
  vanilla: { folder: "datapacks", projectType: "datapack", loaders: ["datapack"], noun: "Datapacks" },
  paper: { folder: "plugins", projectType: "plugin", loaders: ["paper", "spigot", "bukkit", "folia"], noun: "Plugins" },
  purpur: { folder: "plugins", projectType: "plugin", loaders: ["purpur", "paper", "spigot", "bukkit"], noun: "Plugins" },
  fabric: { folder: "mods", projectType: "mod", loaders: ["fabric"], noun: "Mods" },
  quilt: { folder: "mods", projectType: "mod", loaders: ["quilt", "fabric"], noun: "Mods" },
  forge: { folder: "mods", projectType: "mod", loaders: ["forge"], noun: "Mods" },
  neoforge: { folder: "mods", projectType: "mod", loaders: ["neoforge"], noun: "Mods" },
};

// Modrinth files loader tags in with the ordinary categories ("adventure",
// "fabric", "utility"), so this is how a search result's loaders are picked out
// of the pile.
const LOADER_TAGS = new Set(Object.values(TARGETS).flatMap((t) => t.loaders));

// The loader a server actually runs. Modpack servers say "modrinth" but are
// really Fabric/Forge/…, which the pack install records in its start descriptor.
function realLoader(def) {
  if (!def) return null;
  if (def.loader !== "modrinth") return def.loader;
  return (def.start && def.start.modLoader) || null;
}

function targetFor(def) {
  const t = TARGETS[realLoader(def)];
  if (!t) return null;
  return { ...t, loader: realLoader(def) };
}

// Datapacks belong to a world, and the world's name is a server.properties
// setting — so resolve it rather than assuming "world".
function datapackDir(dir) {
  let level = "world";
  try {
    const m = /^level-name=(.*)$/m.exec(fs.readFileSync(path.join(dir, "server.properties"), "utf8"));
    if (m && m[1].trim()) level = m[1].trim();
  } catch {}
  return path.join(level, "datapacks");
}

function folderFor(dir, target) {
  return target.folder === "datapacks" ? datapackDir(dir) : target.folder;
}

/* ------------------------------------------------------------- the manifest */

function manifestPath(dir) {
  return path.join(dir, MANIFEST_DIR, MANIFEST_FILE);
}

function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(dir), "utf8"));
    return {
      items: Array.isArray(m.items) ? m.items : [],
      pack: m.pack || null,
      // jars added by hand that Modrinth didn't know: { sha1: lastAsked ms }
      unknown: m.unknown && typeof m.unknown === "object" ? m.unknown : {},
      // a hand-added jar's hash, kept by name + size + mtime so it isn't re-read
      hashes: m.hashes && typeof m.hashes === "object" ? m.hashes : {},
    };
  } catch {
    return { items: [], pack: null, unknown: {}, hashes: {} };
  }
}

function writeManifest(dir, m) {
  fs.mkdirSync(path.join(dir, MANIFEST_DIR), { recursive: true });
  fs.writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2));
}

/*
 * Installed content, with the files that have since been deleted by hand
 * dropped. Anything sitting in mods/ or plugins/ that we didn't put there is
 * reported too, so the tab reflects the folder rather than only our own record.
 */
function installed(dir, def) {
  const target = targetFor(def);
  if (!target) return { target: null, items: [], unmanaged: [] };
  const rel = folderFor(dir, target);
  const abs = path.join(dir, rel);
  const m = readManifest(dir);

  const items = m.items.filter((it) => fs.existsSync(path.join(dir, it.file)));
  if (items.length !== m.items.length) writeManifest(dir, { ...m, items });

  const known = new Set(items.map((it) => path.basename(it.file)));
  let unmanaged = [];
  try {
    unmanaged = fs
      .readdirSync(abs, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(jar|zip)$/i.test(e.name) && !known.has(e.name))
      .map((e) => {
        const file = path.posix.join(rel.split(path.sep).join("/"), e.name);
        let size = 0;
        let notOnModrinth = false; // asked, and Modrinth didn't know it (see adopt)
        try {
          const st = fs.statSync(path.join(abs, e.name));
          size = st.size;
          const h = m.hashes[`${file}|${st.size}|${Math.round(st.mtimeMs)}`];
          notOnModrinth = !!(h && m.unknown[h]);
        } catch {}
        return { name: e.name, file, size, notOnModrinth };
      });
  } catch {}

  return { target, folder: rel.split(path.sep).join("/"), items, unmanaged, pack: m.pack };
}

/*
 * Recognise jars added by hand. A .jar dragged in from a Modrinth download page
 * is byte-for-byte the file Modrinth hosts, so its SHA-1 tells Modrinth which
 * project and version it is — one request for the whole folder. Each one it
 * knows becomes a normal manifest entry (icon, name, version, update checks);
 * the rest stay "added by hand" and aren't asked about again for a day.
 * Returns the entries it added.
 */
const UNKNOWN_RECHECK_MS = 24 * 3600 * 1000;

async function adopt(dir, def, { only = null } = {}) {
  const target = targetFor(def);
  if (!target) return [];
  const { unmanaged } = installed(dir, def);
  const loose = only ? unmanaged.filter((u) => only.includes(u.name)) : unmanaged;
  if (!loose.length) return [];

  const m = readManifest(dir);
  const now = Date.now();
  const hashes = {}; // sha1 -> loose file
  for (const u of loose) {
    const full = path.join(dir, u.file);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const key = `${u.file}|${st.size}|${Math.round(st.mtimeMs)}`;
    let h = m.hashes[key];
    if (!h) {
      try {
        h = sha1(fs.readFileSync(full));
      } catch {
        continue;
      }
      m.hashes[key] = h;
    }
    const asked = m.unknown[h];
    if (!only && asked && now - asked < UNKNOWN_RECHECK_MS) continue;
    hashes[h] = { ...u, mtime: st.mtimeMs };
  }
  // forget hashes of files that are gone
  const live = new Set(loose.map((u) => u.file));
  for (const k of Object.keys(m.hashes)) if (!live.has(k.split("|")[0])) delete m.hashes[k];

  const list = Object.keys(hashes);
  let found = {};
  if (list.length) {
    const r = await net.postJson(`${API}/version_files`, { hashes: list, algorithm: "sha1" }, HEADERS);
    if (r.status >= 300) throw new Error(`Modrinth answered ${r.status}`);
    found = r.body || {};
  }

  const metas = await projects([...new Set(Object.values(found).map((v) => v.project_id))]).catch(() => []);
  const byId = new Map(metas.map((p) => [p.id, p]));
  const added = [];
  for (const h of list) {
    const u = hashes[h];
    const v = found[h];
    if (!v) {
      m.unknown[h] = now;
      continue;
    }
    delete m.unknown[h];
    const p = byId.get(v.project_id);
    const item = {
      projectId: v.project_id,
      slug: p ? p.slug : v.project_id,
      title: p ? p.title : v.name,
      icon: p ? p.icon_url || null : null,
      projectType: p ? p.project_type : target.projectType,
      versionId: v.id,
      versionNumber: v.version_number,
      versionType: v.version_type,
      file: u.file,
      size: u.size,
      sha1: h,
      dependency: false,
      adopted: true, // added by hand, recognised from its hash
      installedAt: Math.round(u.mtime) || now,
    };
    m.items = m.items.filter((it) => it.file !== u.file).concat(item);
    added.push(item);
  }
  writeManifest(dir, m);
  return added;
}

/*
 * Save a file dropped onto the content tab into the content folder (mods/,
 * plugins/ or the world's datapacks/), then try to recognise it. Only the
 * file's own name is used, so it can't land anywhere else.
 */
async function upload(dir, def, name, buf) {
  const target = targetFor(def);
  if (!target) throw new Error("This server hasn't finished installing yet — try again once it's ready.");
  const base = path.basename(String(name).replace(/\\/g, "/"));
  const ok = target.folder === "datapacks" ? /\.(zip|jar)$/i : /\.jar$/i;
  if (!ok.test(base) || base.startsWith("."))
    throw new Error(`${base} isn't a ${target.folder === "datapacks" ? ".zip or .jar" : ".jar"} file.`);
  const rel = folderFor(dir, target).split(path.sep).join("/");
  const dest = path.join(dir, rel, base);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  // a file of the same name we installed earlier is replaced by this one
  const m = readManifest(dir);
  const file = rel + "/" + base;
  if (m.items.some((it) => it.file === file)) {
    m.items = m.items.filter((it) => it.file !== file);
    writeManifest(dir, m);
  }
  const added = await adopt(dir, def, { only: [base] }).catch(() => []);
  const item = added[0] || null;
  // Another build of the same mod already here (the usual way to update by
  // hand)? Two copies of one mod stop the server starting, so the old one goes.
  let replaced = null;
  if (item) {
    const m2 = readManifest(dir);
    const old = m2.items.find((it) => it.projectId === item.projectId && it.file !== file);
    if (old) {
      fs.rmSync(path.join(dir, old.file), { force: true });
      m2.items = m2.items.filter((it) => it !== old);
      writeManifest(dir, m2);
      replaced = old.file;
    }
  }
  return { file, item, replaced };
}

/* --------------------------------------------------------------- installing */

function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

// Download to `dest`, then check the hash Modrinth published for it. A corrupt
// jar in mods/ is a crash on startup with a far less obvious message.
async function fetchFile(url, dest, expectSha1, onProgress) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + ".part";
  await net.download(url, tmp, onProgress);
  if (expectSha1) {
    const got = sha1(fs.readFileSync(tmp));
    if (got !== expectSha1) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`Checksum mismatch for ${path.basename(dest)} — the download was corrupted.`);
    }
  }
  fs.rmSync(dest, { force: true });
  fs.renameSync(tmp, dest);
}

// Newest version of `projectId` this server can run, or null when the project
// has nothing for this loader/game-version pair. `any` is the escape hatch for
// when the panel's compatibility filter has been unlocked on purpose: take the
// newest build that exists, whatever it targets.
async function bestVersion(projectId, target, mc, { any = false } = {}) {
  const list = await versions(projectId, { loaders: target.loaders, mc });
  if (list.length) return list[0];
  // Some projects tag only the loader (datapacks in particular) and leave the
  // game version off, so retry without the version filter before giving up.
  const loose = await versions(projectId, { loaders: target.loaders });
  if (loose.length) return loose[0];
  if (!any) return null;
  const all = await versions(projectId);
  return all[0] || null;
}

/*
 * Install one project into a server, with its required dependencies.
 * Pass either `versionId` (an exact build) or `projectId` (take the newest
 * compatible one). Re-installing a project replaces the file already there.
 */
async function install(
  dir,
  def,
  { versionId = null, projectId = null, allowIncompatible = false, log = () => {} } = {}
) {
  const target = targetFor(def);
  if (!target)
    throw new Error("This server hasn't finished installing yet — try again once it's ready.");

  const added = [];
  const seen = new Set();

  async function one(v, depth) {
    if (!v || seen.has(v.projectId)) return;
    seen.add(v.projectId);
    if (!v.file) throw new Error(`${v.name} has no downloadable file.`);

    const meta = await project(v.projectId).catch(() => null);
    const relFolder = folderFor(dir, target);
    const file = path.posix.join(relFolder.split(path.sep).join("/"), v.file.name);

    log(`${depth ? "  ↳ " : ""}Downloading ${v.file.name} (${(v.file.size / 1048576).toFixed(1)} MB)…`);
    await fetchFile(v.file.url, path.join(dir, file), v.file.sha1);

    // Drop any older build of the same project we put there previously.
    const m = readManifest(dir);
    for (const old of m.items.filter((it) => it.projectId === v.projectId && it.file !== file))
      fs.rmSync(path.join(dir, old.file), { force: true });

    const item = {
      projectId: v.projectId,
      slug: meta ? meta.slug : v.projectId,
      title: meta ? meta.title : v.name,
      icon: meta ? meta.icon : null,
      projectType: meta ? meta.projectType : target.projectType,
      versionId: v.id,
      versionNumber: v.number,
      versionType: v.type,
      file,
      size: v.file.size,
      sha1: v.file.sha1,
      dependency: depth > 0,
      installedAt: Date.now(),
    };
    m.items = m.items.filter((it) => it.projectId !== v.projectId).concat(item);
    writeManifest(dir, m);
    added.push(item);

    if (depth >= 3) return; // dependency chains this deep are almost always a loop
    for (const d of v.dependencies) {
      if (d.type !== "required") continue;
      if (readManifest(dir).items.some((it) => it.projectId === d.projectId)) continue;
      const dv = d.versionId
        ? await version(d.versionId).catch(() => null)
        : await bestVersion(d.projectId, target, def.mc, { any: allowIncompatible }).catch(() => null);
      if (!dv) {
        log(`  ⚠ Required dependency ${d.projectId} has no build for ${def.mc} — install it by hand.`);
        continue;
      }
      await one(dv, depth + 1);
    }
  }

  const root = versionId
    ? await version(versionId)
    : await bestVersion(projectId, target, def.mc, { any: allowIncompatible });
  if (!root)
    throw new Error(
      `No ${target.loader} build of that project exists for Minecraft ${def.mc}. ` +
        "Unlock the loader/version filters to install it anyway."
    );
  await one(root, 0);
  log(`✔ Installed ${added.map((a) => a.title).join(", ")}.`);
  return { installed: added, folder: folderFor(dir, target).split(path.sep).join("/") };
}

// Remove an installed item (or any loose file in the content folder).
function remove(dir, def, file) {
  const target = targetFor(def);
  if (!target) throw new Error("Nothing is installed on this server yet.");
  const rel = folderFor(dir, target).split(path.sep).join("/");
  const clean = String(file).replace(/\\/g, "/");
  if (!clean.startsWith(rel + "/") || clean.includes(".."))
    throw new Error(`Refusing to delete ${file} — it isn't in ${rel}/.`);

  fs.rmSync(path.join(dir, clean), { force: true });
  const m = readManifest(dir);
  m.items = m.items.filter((it) => it.file !== clean);
  writeManifest(dir, m);
  return { ok: true };
}

/*
 * Which installed projects have a newer compatible build. Modrinth can answer
 * for a whole folder in one POST — you hand it the file hashes and it hands
 * back the newest version of each project for this loader and game version.
 * Anything it doesn't recognise falls back to a per-project lookup.
 */
async function updates(dir, def) {
  const target = targetFor(def);
  if (!target) return [];
  const { items } = installed(dir, def);
  if (!items.length) return [];

  let byHash = {};
  const hashes = items.map((it) => it.sha1).filter(Boolean);
  if (hashes.length) {
    const r = await net
      .postJson(
        `${API}/version_files/update`,
        { hashes, algorithm: "sha1", loaders: target.loaders, game_versions: [def.mc] },
        HEADERS
      )
      .catch(() => null);
    if (r && r.status < 300) byHash = r.body || {};
  }

  const out = [];
  for (const it of items) {
    let latest = it.sha1 && byHash[it.sha1] ? versionInfo(byHash[it.sha1]) : null;
    if (!latest) latest = await bestVersion(it.projectId, target, def.mc).catch(() => null);
    if (latest && latest.id !== it.versionId)
      out.push({
        projectId: it.projectId,
        title: it.title,
        from: it.versionNumber,
        to: latest.number,
        versionId: latest.id,
      });
  }
  return out;
}

/* ------------------------------------------------------------------ modpacks */

// Run `jobs` a few at a time. Modpacks pull 50–300 files and firing them all at
// once gets the CDN to start refusing connections.
async function pool(jobs, width, onDone) {
  let i = 0;
  let done = 0;
  const workers = Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (i < jobs.length) {
      const mine = i++;
      await jobs[mine]();
      if (onDone) onDone(++done, jobs.length);
    }
  });
  await Promise.all(workers);
}

// Which loader (and which version of it) a pack pins, from modrinth.index.json.
function packBase(deps) {
  const mc = deps.minecraft || null;
  if (deps["fabric-loader"]) return { id: "fabric", mc, build: deps["fabric-loader"] };
  if (deps["quilt-loader"]) return { id: "quilt", mc, build: deps["quilt-loader"] };
  if (deps.neoforge) return { id: "neoforge", mc, build: deps.neoforge };
  if (deps.forge) return { id: "forge", mc, build: deps.forge };
  return { id: "vanilla", mc, build: null };
}

/*
 * Turn the pack's file list into manifest entries, so the Mods tab shows the
 * pack's mods by name and can update or remove them one at a time instead of
 * reporting 50 mystery jars someone must have dropped in by hand.
 *
 * The index only gives download URLs, but a Modrinth CDN URL carries the
 * project and version ids — /data/<project>/versions/<version>/<file> — so one
 * bulk lookup gets every title. Files hosted elsewhere keep their filename.
 */
const CDN_RE = /cdn\.modrinth\.com\/data\/([^/]+)\/versions\/([^/]+)\//;

async function packItems(files, base, log = () => {}) {
  const target = TARGETS[base.id];
  const folder = target ? target.folder : "mods";
  const items = [];

  for (const f of files) {
    const rel = String(f.path).replace(/\\/g, "/");
    // Only what the loader actually loads; resource/shader packs aren't content
    // this tab can manage.
    if (!rel.startsWith(folder + "/")) continue;
    const m = CDN_RE.exec((f.downloads || [])[0] || "");
    items.push({
      projectId: m ? m[1] : null,
      slug: null,
      title: path.basename(rel),
      icon: null,
      projectType: target ? target.projectType : "mod",
      versionId: m ? m[2] : null,
      versionNumber: "",
      file: rel,
      size: f.fileSize || 0,
      sha1: (f.hashes && f.hashes.sha1) || null,
      fromPack: true,
      installedAt: Date.now(),
    });
  }

  // Fill in real names/icons/version numbers for everything that came from
  // Modrinth itself — two bulk calls for the whole pack.
  const ids = [...new Set(items.map((i) => i.projectId).filter(Boolean))];
  const vids = [...new Set(items.map((i) => i.versionId).filter(Boolean))];
  if (ids.length) {
    try {
      const [metas, vers] = await Promise.all([
        projects(ids),
        api("/versions", { ids: vids }).catch(() => []),
      ]);
      const byId = new Map(metas.map((p) => [p.id, p]));
      const byVer = new Map(vers.map((v) => [v.id, v]));
      for (const it of items) {
        const p = it.projectId && byId.get(it.projectId);
        if (p) {
          it.title = p.title;
          it.slug = p.slug;
          it.icon = p.icon_url || null;
        }
        const v = it.versionId && byVer.get(it.versionId);
        if (v) it.versionNumber = v.version_number;
      }
      log(`Recorded ${items.length} pack mod(s) so they can be updated or removed here.`);
    } catch (e) {
      log(`(Couldn't fetch mod names from Modrinth: ${e.message} — filenames will be shown instead.)`);
    }
  }
  return items;
}

/*
 * Fetch and open a .mrpack. Returns the parsed index plus the raw zip, which
 * `applyPack` needs later for the overrides — loaders.js installs the base
 * modloader in between the two calls.
 */
async function readPack({ dir, versionId, log = () => {} }) {
  const v = await version(versionId);
  if (!v.file) throw new Error("That modpack version has no downloadable file.");
  log(`Downloading modpack ${v.name} (${(v.file.size / 1048576).toFixed(1)} MB)…`);

  const tmp = path.join(dir, MANIFEST_DIR, "pack.mrpack");
  await fetchFile(v.file.url, tmp, v.file.sha1);
  const buf = fs.readFileSync(tmp);
  fs.rmSync(tmp, { force: true });

  const index = JSON.parse(zip.readEntry(buf, "modrinth.index.json").toString("utf8"));
  const base = packBase(index.dependencies || {});
  log(`Pack "${index.name}" ${index.versionId || ""} — Minecraft ${base.mc}, ${base.id}${base.build ? " " + base.build : ""}.`);
  return { buf, index, base, version: v };
}

/*
 * Write the pack out: every file the index lists, then its overrides. Client-only
 * files are skipped — on a server they're dead weight at best and a crash at
 * worst — and server-overrides are applied last so they win.
 */
async function applyPack({ dir, buf, index, version: packVersion, log = () => {} }) {
  const all = index.files || [];
  const files = all.filter((f) => !(f.env && f.env.server === "unsupported"));
  const skipped = all.length - files.length;
  log(`Fetching ${files.length} pack file${files.length === 1 ? "" : "s"}${skipped ? ` (${skipped} client-only, skipped)` : ""}…`);

  const failures = [];
  let lastPct = -1;
  await pool(
    files.map((f) => async () => {
      const rel = String(f.path).replace(/\\/g, "/");
      if (rel.split("/").includes("..") || /^([a-zA-Z]:)?\//.test(rel)) {
        failures.push(`${rel} (unsafe path)`);
        return;
      }
      const urls = f.downloads || [];
      for (let i = 0; i < urls.length; i++) {
        try {
          await fetchFile(urls[i], path.join(dir, rel), f.hashes && f.hashes.sha1);
          return;
        } catch (e) {
          if (i === urls.length - 1) failures.push(`${path.basename(rel)} — ${e.message}`);
        }
      }
      if (!urls.length) failures.push(`${rel} (no download URL)`);
    }),
    6,
    (done, total) => {
      const pct = Math.floor((done / total) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        log(`  ${pct}%  (${done}/${total} files)`);
      }
    }
  );

  const over = zip.extractTo(buf, dir, { prefix: "overrides/" });
  const serverOver = zip.extractTo(buf, dir, { prefix: "server-overrides/" });
  if (over || serverOver) log(`Applied ${over + serverOver} config/override file(s).`);

  const m = readManifest(dir);
  m.items = await packItems(files, packBase(index.dependencies || {}), log);
  m.pack = {
    name: index.name,
    versionId: packVersion ? packVersion.id : null,
    versionNumber: index.versionId || (packVersion && packVersion.number) || null,
    projectId: packVersion ? packVersion.projectId : null,
    files: files.length,
    installedAt: Date.now(),
  };
  writeManifest(dir, m);

  if (failures.length) {
    log(`⚠ ${failures.length} file(s) could not be downloaded:`);
    for (const f of failures.slice(0, 10)) log(`   • ${f}`);
    if (failures.length > 10) log(`   … and ${failures.length - 10} more.`);
  }
  return { files: files.length, skipped, failures };
}

module.exports = {
  search,
  versions,
  version,
  project,
  installed,
  adopt,
  upload,
  install,
  remove,
  updates,
  targetFor,
  realLoader,
  readPack,
  applyPack,
  packBase,
  TARGETS,
};

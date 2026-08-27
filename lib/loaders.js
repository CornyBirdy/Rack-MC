/*
 * loaders.js — everything loader-specific: listing installable versions and
 * installing a server into a folder. Each loader exposes:
 *
 *   { id, label, kind, blurb, needsBuild, listMc(), listBuild(mc)?, install(ctx) }
 *
 * kind:  "vanilla" | "plugin" (Bukkit/Spigot plugins) | "mod" (real modloaders)
 *        | "pack" (a curated modpack that brings its own loader with it)
 * install(ctx) receives { dir, mc, build, memoryMB, java, log } and returns a
 * start descriptor describing how the manager should launch the server:
 *   { type: "jar",  jar: "server.jar",  args: ["nogui"] }
 *   { type: "args", argsFile: "libraries/.../win_args.txt", args: ["nogui"] }
 */
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const net = require("./net");
const modrinth = require("./modrinth");

const isWin = process.platform === "win32";

/* --------------------------------------------------------------- utilities */

function xmlVersions(xml) {
  return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1]);
}

// Minecraft now has two version schemes: the classic "1.20.4" line and the
// year-based "26.1.2" / "26.2" line that replaced it. Sorting has to know that
// 26.x is *newer* than 1.21.x even though 1 < 26 numerically.
function mcKey(id) {
  const base = String(id).split("-")[0]; // drop "-pre1" / "-rc2" / "-snapshot-3"
  const nums = base.split(".").map(Number);
  if (!nums.length || nums.some((n) => !Number.isFinite(n))) return null; // "23w31a" etc.
  const legacy = nums[0] === 1 ? 1 : 0;
  return { legacy, parts: legacy ? nums.slice(1) : nums };
}

// Positive when `a` is a newer Minecraft version than `b`.
function cmpMc(a, b) {
  const ka = mcKey(a);
  const kb = mcKey(b);
  if (!ka || !kb) return !ka && !kb ? String(a).localeCompare(String(b)) : ka ? 1 : -1;
  if (ka.legacy !== kb.legacy) return kb.legacy - ka.legacy; // new scheme wins
  const n = Math.max(ka.parts.length, kb.parts.length);
  for (let i = 0; i < n; i++) {
    const d = (ka.parts[i] || 0) - (kb.parts[i] || 0);
    if (d) return d;
  }
  return 0;
}

// Positive when build string `a` is newer than `b` ("26.2.0.60" > "26.2.0.9",
// and a plain release outranks the same number tagged "-beta").
function cmpBuild(a, b) {
  const pa = String(a).split(/[.\-+]/);
  const pb = String(b).split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (x === undefined) return 1; // "…57" is newer than "…57-beta"
    if (y === undefined) return -1;
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx - ny;
      continue;
    }
    return String(x).localeCompare(String(y));
  }
  return 0;
}

// Run a Java installer jar (Forge/NeoForge/Quilt) and stream its output.
function runJava(java, args, cwd, log) {
  return new Promise((resolve, reject) => {
    log(`[installer] ${java} ${args.join(" ")}`);
    const child = execFile(java, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err) => {
      if (err) reject(new Error(`installer exited with an error: ${err.message}`));
      else resolve();
    });
    child.stdout && child.stdout.on("data", (d) => String(d).split(/\r?\n/).forEach((l) => l && log(l)));
    child.stderr && child.stderr.on("data", (d) => String(d).split(/\r?\n/).forEach((l) => l && log("! " + l)));
  });
}

function requireJava(java) {
  // The Forge/NeoForge installers are themselves Java programs. The manager
  // resolves (and downloads) the right runtime before calling us, so reaching
  // here means that failed.
  if (!java)
    throw new Error(
      "No Java runtime available to run the installer. Check your connection, or set a Java path in Settings."
    );
}

/* ------------------------------------------------------------------ Mojang */

const MOJANG_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
let _mojang = null;
async function mojangManifest() {
  if (!_mojang) _mojang = await net.getJson(MOJANG_MANIFEST);
  return _mojang;
}

async function vanillaMcList() {
  const m = await mojangManifest();
  // The manifest is already newest-first; keep Mojang's order.
  return m.versions
    .filter((v) => v.type === "release" || v.type === "snapshot")
    .map((v) => ({ id: v.id, type: v.type }));
}

async function vanillaServerUrl(mc) {
  const m = await mojangManifest();
  const v = m.versions.find((x) => x.id === mc);
  if (!v) throw new Error(`Unknown Minecraft version: ${mc}`);
  const pkg = await net.getJson(v.url);
  if (!pkg.downloads || !pkg.downloads.server)
    throw new Error(`Mojang has no downloadable server for ${mc} (very old versions have none).`);
  return pkg.downloads.server.url;
}

async function installJarDownload(url, dir, log, jarName = "server.jar") {
  const dest = path.join(dir, jarName);
  log(`Downloading ${jarName} …`);
  let lastPct = -1;
  await net.download(url, dest, (done, total) => {
    if (!total) return;
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 5 === 0) {
      lastPct = pct;
      log(`  ${pct}%  (${(done / 1048576).toFixed(1)} MB)`);
    }
  });
  log(`Saved ${jarName}.`);
  return { type: "jar", jar: jarName, args: ["nogui"] };
}

/* -------------------------------------------------------------- PaperMC/fill */

const PAPER = "https://fill.papermc.io/v3/projects";

async function paperLikeMcList(project) {
  const d = await net.getJson(`${PAPER}/${project}`);
  const out = [];
  for (const arr of Object.values(d.versions || {})) for (const v of arr) out.push(v);
  return out
    .sort((a, b) => cmpMc(b, a) || cmpBuild(b, a))
    .map((v) => ({ id: v, type: /-(pre|rc|snapshot)/i.test(v) ? "snapshot" : "release" }));
}

async function paperLikeUrl(project, mc) {
  const b = await net.getJson(`${PAPER}/${project}/versions/${mc}/builds/latest`);
  const dl = b.downloads && b.downloads["server:default"];
  if (!dl || !dl.url) throw new Error(`No ${project} build available for ${mc}.`);
  return { url: dl.url, build: b.id };
}

/* ------------------------------------------------------------------ Purpur */

async function purpurMcList() {
  const d = await net.getJson("https://api.purpurmc.org/v2/purpur");
  return (d.versions || [])
    .slice()
    .sort((a, b) => cmpMc(b, a) || cmpBuild(b, a))
    .map((v) => ({ id: v, type: "release" }));
}
function purpurUrl(mc) {
  return `https://api.purpurmc.org/v2/purpur/${mc}/latest/download`;
}

/* ------------------------------------------------------------ Fabric / Quilt */

async function fabricGameList() {
  const d = await net.getJson("https://meta.fabricmc.net/v2/versions/game");
  return d.map((x) => ({ id: x.version, type: x.stable ? "release" : "snapshot" }));
}
async function fabricLoaderList() {
  const d = await net.getJson("https://meta.fabricmc.net/v2/versions/loader");
  return d.map((x) => ({ id: x.version, stable: x.stable }));
}
async function fabricInstaller() {
  const d = await net.getJson("https://meta.fabricmc.net/v2/versions/installer");
  return (d.find((x) => x.stable) || d[0]).version;
}
async function fabricServerUrl(mc, loader) {
  const installer = await fabricInstaller();
  return `https://meta.fabricmc.net/v2/versions/loader/${mc}/${loader}/${installer}/server/jar`;
}

async function quiltGameList() {
  const d = await net.getJson("https://meta.quiltmc.org/v3/versions/game");
  return d.map((x) => ({ id: x.version, type: x.stable ? "release" : "snapshot" }));
}
async function quiltLoaderList() {
  const d = await net.getJson("https://meta.quiltmc.org/v3/versions/loader");
  return d.map((x) => ({ id: x.version, stable: !/beta|pre/i.test(x.version) }));
}
async function quiltServerUrl(mc, loader) {
  // Quilt mirrors Fabric's meta shape for the server launcher jar.
  return `https://meta.quiltmc.org/v3/versions/loader/${mc}/${loader}/server/jar`;
}

/* ------------------------------------------------------------ Forge / Neo */

// The maven listings are ~1600 entries and get hit twice per wizard step
// (versions, then builds); a short memo keeps the UI snappy.
function memo(fn, ttl = 10 * 60 * 1000) {
  let value = null;
  let at = 0;
  return async (...args) => {
    if (value && Date.now() - at < ttl) return value;
    value = await fn(...args);
    at = Date.now();
    return value;
  };
}

const forgeVersions = memo(async function () {
  const xml = await net.getText(
    "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml"
  );
  // "1.20.1-47.2.0" -> mc "1.20.1"; "26.1.2-64.1.3" -> mc "26.1.2"
  return xmlVersions(xml)
    .map((full) => {
      const dash = full.indexOf("-");
      if (dash < 0) return null;
      return { full, mc: full.slice(0, dash), loader: full.slice(dash + 1) };
    })
    .filter(Boolean)
    .sort((a, b) => cmpMc(b.mc, a.mc) || cmpBuild(b.loader, a.loader));
});

// NeoForge encodes the Minecraft version in its own version number, and two
// schemes now coexist on the maven:
//   3 parts  "21.1.248"   -> MC 1.21.1   (<mcMinor>.<mcPatch>.<build>)
//   4 parts  "26.1.2.99"  -> MC 26.1.2   (<mc>.<mc>.<mc>.<build>, new scheme)
//            "26.2.0.69"  -> MC 26.2     (a trailing .0 patch is dropped)
// Pre-release suffixes ("-beta", "-alpha.15") hang off the end; junk branches
// like "0.25w14craftmine.1" aren't real releases and are dropped.
function neoMc(version) {
  const parts = String(version).split("-")[0].split(".");
  if (!parts.every((p) => /^\d+$/.test(p))) return null;
  if (parts.length === 4) {
    const [a, b, c] = parts;
    return Number(c) > 0 ? `${a}.${b}.${c}` : `${a}.${b}`;
  }
  if (parts.length === 3) {
    const [maj, min] = parts;
    return Number(min) > 0 ? `1.${maj}.${min}` : `1.${maj}`;
  }
  return null;
}

const neoforgeVersions = memo(async function () {
  const xml = await net.getText(
    "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml"
  );
  return xmlVersions(xml)
    .map((full) => {
      const mc = neoMc(full);
      return mc ? { full, mc, loader: full, stable: !/-(alpha|beta|rc)/i.test(full) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => cmpMc(b.mc, a.mc) || cmpBuild(b.full, a.full));
});

// Shared installer-based flow for modern Forge/NeoForge. Runs `--installServer`,
// then finds the generated @args file used to launch the server.
async function installForgeLike({ dir, installerUrl, argGlobBase, java, log }) {
  requireJava(java);
  const installer = path.join(dir, "installer.jar");
  log("Downloading installer …");
  await net.download(installerUrl, installer, () => {});
  log("Running installer (this pulls libraries and can take a minute) …");
  await runJava(java.path, ["-jar", "installer.jar", "--installServer"], dir, log);

  // Modern (1.17+) installs drop args files under libraries/<argGlobBase>/<ver>/.
  const argsFile = findArgsFile(dir, argGlobBase);
  if (argsFile) {
    log(`Server ready. Launch descriptor: @${argsFile}`);
    return { type: "args", argsFile, args: ["nogui"] };
  }
  // Legacy (<=1.16): a runnable universal jar sits in the root.
  const jar = fs
    .readdirSync(dir)
    .find((f) => /forge.*(universal)?\.jar$/i.test(f) && !/installer/i.test(f));
  if (jar) {
    log(`Server ready (legacy jar): ${jar}`);
    return { type: "jar", jar, args: ["nogui"] };
  }
  throw new Error("Installer finished but no runnable server was produced. Check the log above.");
}

// Locate libraries/<base>/<version>/(win|unix)_args.txt after a Forge/Neo install.
function findArgsFile(dir, base) {
  const root = path.join(dir, "libraries", ...base.split("/"));
  if (!fs.existsSync(root)) return null;
  for (const ver of fs.readdirSync(root)) {
    const verDir = path.join(root, ver);
    const want = isWin ? "win_args.txt" : "unix_args.txt";
    const file = path.join(verDir, want);
    if (fs.existsSync(file)) return path.relative(dir, file).split(path.sep).join("/");
    // fall back to whichever args file exists
    const any = fs.existsSync(verDir) && fs.readdirSync(verDir).find((f) => /_args\.txt$/.test(f));
    if (any) return path.relative(dir, path.join(verDir, any)).split(path.sep).join("/");
  }
  return null;
}

/* ---------------------------------------------------------- loader registry */

const LOADERS = {
  vanilla: {
    id: "vanilla",
    label: "Vanilla",
    kind: "vanilla",
    blurb: "Official Mojang server. No mods or plugins.",
    needsBuild: false,
    listMc: vanillaMcList,
    async install(ctx) {
      const url = await vanillaServerUrl(ctx.mc);
      return installJarDownload(url, ctx.dir, ctx.log);
    },
  },

  paper: {
    id: "paper",
    label: "Paper",
    kind: "plugin",
    blurb: "High-performance Bukkit/Spigot server. Runs plugins, not mods.",
    needsBuild: false,
    listMc: () => paperLikeMcList("paper"),
    async install(ctx) {
      const { url } = await paperLikeUrl("paper", ctx.mc);
      return installJarDownload(url, ctx.dir, ctx.log);
    },
  },

  purpur: {
    id: "purpur",
    label: "Purpur",
    kind: "plugin",
    blurb: "Paper fork with extra gameplay/config options. Plugin-based.",
    needsBuild: false,
    listMc: purpurMcList,
    async install(ctx) {
      return installJarDownload(purpurUrl(ctx.mc), ctx.dir, ctx.log);
    },
  },

  fabric: {
    id: "fabric",
    label: "Fabric",
    kind: "mod",
    blurb: "Lightweight modloader. Huge mod ecosystem; needs Fabric API mod.",
    needsBuild: true,
    listMc: fabricGameList,
    listBuild: fabricLoaderList,
    async install(ctx) {
      const loader = ctx.build || (await fabricLoaderList())[0].id;
      const url = await fabricServerUrl(ctx.mc, loader);
      return installJarDownload(url, ctx.dir, ctx.log);
    },
  },

  quilt: {
    id: "quilt",
    label: "Quilt",
    kind: "mod",
    blurb: "Fabric-compatible modloader with extra features. (Experimental.)",
    needsBuild: true,
    listMc: quiltGameList,
    listBuild: quiltLoaderList,
    async install(ctx) {
      const loader = ctx.build || (await quiltLoaderList())[0].id;
      const url = await quiltServerUrl(ctx.mc, loader);
      return installJarDownload(url, ctx.dir, ctx.log);
    },
  },

  forge: {
    id: "forge",
    label: "Forge",
    kind: "mod",
    blurb: "The classic modloader. Runs the biggest modpacks. Needs a JDK.",
    needsBuild: true,
    async listMc() {
      const all = await forgeVersions();
      const seen = new Set();
      return all.filter((v) => !seen.has(v.mc) && seen.add(v.mc)).map((v) => ({ id: v.mc, type: "release" }));
    },
    async listBuild(mc) {
      const all = await forgeVersions();
      return all.filter((v) => v.mc === mc).map((v) => ({ id: v.loader, full: v.full }));
    },
    async install(ctx) {
      const all = await forgeVersions();
      const match = ctx.build
        ? all.find((v) => v.mc === ctx.mc && v.loader === ctx.build)
        : all.find((v) => v.mc === ctx.mc);
      if (!match) throw new Error(`No Forge build for ${ctx.mc}${ctx.build ? " / " + ctx.build : ""}.`);
      return installForgeLike({
        dir: ctx.dir,
        installerUrl: `https://maven.minecraftforge.net/net/minecraftforge/forge/${match.full}/forge-${match.full}-installer.jar`,
        argGlobBase: "net/minecraftforge/forge",
        java: ctx.java,
        log: ctx.log,
      });
    },
  },

  neoforge: {
    id: "neoforge",
    label: "NeoForge",
    kind: "mod",
    blurb: "Modern Forge fork (1.20.1+). Where most new mods are heading.",
    needsBuild: true,
    async listMc() {
      const all = await neoforgeVersions();
      const seen = new Set();
      return all.filter((v) => !seen.has(v.mc) && seen.add(v.mc)).map((v) => ({ id: v.mc, type: "release" }));
    },
    async listBuild(mc) {
      const all = await neoforgeVersions();
      return all
        .filter((v) => v.mc === mc)
        .map((v) => ({ id: v.loader, full: v.full, stable: v.stable }));
    },
    async install(ctx) {
      const all = await neoforgeVersions();
      const match = ctx.build
        ? all.find((v) => v.loader === ctx.build)
        : all.find((v) => v.mc === ctx.mc);
      if (!match) throw new Error(`No NeoForge build for ${ctx.mc}${ctx.build ? " / " + ctx.build : ""}.`);
      return installForgeLike({
        dir: ctx.dir,
        installerUrl: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${match.full}/neoforge-${match.full}-installer.jar`,
        argGlobBase: "net/neoforged/neoforge",
        java: ctx.java,
        log: ctx.log,
      });
    },
  },

  // A Modrinth modpack isn't a loader of its own — it's a manifest that pins
  // one of the loaders above plus a list of mods and configs. So install the
  // pinned loader with the same code path as a hand-built server, then let
  // modrinth.js lay the pack's files down on top of it. `build` is the pack's
  // Modrinth version id; the wizard picks it in its own step.
  modrinth: {
    id: "modrinth",
    label: "Modrinth Modpack",
    kind: "pack",
    blurb: "Install a ready-made modpack — its mods, configs and modloader are set up for you.",
    needsBuild: true,
    async install(ctx) {
      if (!ctx.build) throw new Error("No modpack version was chosen.");
      const pack = await modrinth.readPack({ dir: ctx.dir, versionId: ctx.build, log: ctx.log });
      const base = pack.base;
      const under = LOADERS[base.id];
      if (!under) throw new Error(`This pack needs the "${base.id}" loader, which MC Hoster can't install.`);

      ctx.log(`Installing ${under.label}${base.build ? " " + base.build : ""} for Minecraft ${base.mc || ctx.mc}…`);
      const start = await under.install({ ...ctx, mc: base.mc || ctx.mc, build: base.build });

      await modrinth.applyPack({
        dir: ctx.dir,
        buf: pack.buf,
        index: pack.index,
        version: pack.version,
        log: ctx.log,
      });

      // Remembering the real loader is what later lets the Mods tab offer
      // Fabric (or Forge, …) content on a server whose loader reads "modrinth".
      return {
        ...start,
        modLoader: base.id,
        pack: {
          projectId: pack.version.projectId,
          versionId: pack.version.id,
          name: pack.index.name,
          versionNumber: pack.index.versionId || pack.version.number,
        },
      };
    },
  },
};

function list() {
  return Object.values(LOADERS).map((l) => ({
    id: l.id,
    label: l.label,
    kind: l.kind,
    blurb: l.blurb,
    needsBuild: l.needsBuild,
  }));
}

function get(id) {
  const l = LOADERS[id];
  if (!l) throw new Error(`Unknown loader: ${id}`);
  return l;
}

module.exports = { LOADERS, list, get };

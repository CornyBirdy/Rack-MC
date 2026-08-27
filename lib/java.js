/*
 * java.js — locate, match and (when missing) install Java runtimes.
 *
 * Minecraft pins a Java major version per game version: 1.16 and older need 8,
 * 1.17 needs 16, 1.18–1.20.4 need 17, 1.20.5–1.21.x need 21, and the new
 * year-based releases (26.1, 26.1.2, 26.2 …) need 25. Running a server on a
 * Java that's too old fails with UnsupportedClassVersionError, so this module:
 *   - scans PATH / JAVA_HOME / vendor dirs / our own downloaded runtimes,
 *   - asks Mojang what major a given MC version wants (with an offline table),
 *   - picks the closest installed runtime that satisfies it,
 *   - and can download an Eclipse Temurin JRE into data/runtimes/ when nothing
 *     on the machine fits.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const net = require("./net");

const isWin = process.platform === "win32";
const EXE = isWin ? "java.exe" : "java";
const RUNTIMES_DIR = path.join(__dirname, "..", "data", "runtimes");

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// Return java executable info ({path, version, major}) or null if it won't run.
function probe(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ["-version"], { timeout: 8000 }, (err, _stdout, stderr) => {
      if (err) return resolve(null);
      // `java -version` prints to stderr: e.g.  openjdk version "21.0.2" ...
      const m = /version "([^"]+)"/.exec(stderr || "");
      const version = m ? m[1] : "unknown";
      resolve({
        path: javaPath,
        version,
        major: majorOf(version),
        managed: path.resolve(javaPath).startsWith(path.resolve(RUNTIMES_DIR)),
      });
    });
  });
}

// java executables inside runtimes we downloaded ourselves. Temurin archives
// unpack to a nested folder (jdk-25.0.1+9-jre/bin/java.exe), so look one deep.
function managedRuntimes() {
  const out = [];
  if (!exists(RUNTIMES_DIR)) return out;
  let tops = [];
  try {
    tops = fs.readdirSync(RUNTIMES_DIR);
  } catch {
    return out;
  }
  for (const top of tops) {
    const base = path.join(RUNTIMES_DIR, top);
    out.push(path.join(base, "bin", EXE));
    let inner = [];
    try {
      inner = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const e of inner) out.push(path.join(base, e, "bin", EXE));
  }
  return out;
}

// Depth-limited hunt for <…>/bin/java(.exe) under a launcher's runtime folder.
function walkForJava(dir, out, depth) {
  if (depth > 4) return;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = path.join(dir, e.name);
    if (e.name === "bin") out.add(path.join(child, EXE));
    else walkForJava(child, out, depth + 1);
  }
}

function candidateDirs() {
  const dirs = new Set(managedRuntimes());
  if (process.env.JAVA_HOME) dirs.add(path.join(process.env.JAVA_HOME, "bin", EXE));

  if (isWin) {
    const roots = [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
    ].filter(Boolean);
    const vendors = [
      "Eclipse Adoptium",
      "Eclipse Foundation",
      "Microsoft",
      "Java",
      "Amazon Corretto",
      "Zulu",
      "AdoptOpenJDK",
      "BellSoft",
      "Semeru",
    ];
    for (const root of roots) {
      for (const v of vendors) {
        const base = path.join(root, v);
        if (!exists(base)) continue;
        let entries = [];
        try {
          entries = fs.readdirSync(base);
        } catch {
          continue;
        }
        for (const e of entries) {
          dirs.add(path.join(base, e, "bin", EXE));
          dirs.add(path.join(base, e, "jre", "bin", EXE)); // some layouts nest a jre
        }
      }
    }
    // Minecraft launchers ship their own JREs — a modded player almost always
    // has several, including the newest one the game needs. Reuse them rather
    // than making the user install Java system-wide.
    const APPDATA = process.env.APPDATA;
    const HOME = process.env.USERPROFILE;
    for (const root of [
      APPDATA && path.join(APPDATA, ".minecraft", "runtime"),
      APPDATA && path.join(APPDATA, "ModrinthApp", "meta", "java_versions"),
      APPDATA && path.join(APPDATA, "PrismLauncher", "java"),
      APPDATA && path.join(APPDATA, "com.modrinth.theseus", "meta", "java_versions"),
      APPDATA && path.join(APPDATA, "ATLauncher", "runtimes"),
      APPDATA && path.join(APPDATA, "gdlauncher_next", "datastore", "java"),
      HOME && path.join(HOME, "curseforge", "minecraft", "Install", "runtime"),
      HOME && path.join(HOME, "AppData", "Local", "Packages"), // skipped: too deep
    ].filter(Boolean)) {
      if (!exists(root) || root.endsWith("Packages")) continue;
      walkForJava(root, dirs, 0);
    }
  } else {
    ["/usr/bin/java", "/usr/local/bin/java", "/opt/java/bin/java"].forEach((p) => dirs.add(p));
    const lib = "/usr/lib/jvm";
    if (exists(lib)) {
      try {
        for (const e of fs.readdirSync(lib)) dirs.add(path.join(lib, e, "bin", "java"));
      } catch {}
    }
  }
  return [...dirs].filter(exists);
}

// Ask the OS resolver for a bare `java` on PATH.
function fromPath() {
  return new Promise((resolve) => {
    const finder = isWin ? "where" : "which";
    execFile(finder, [EXE], { timeout: 6000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null);
    });
  });
}

let cache = null;

// Discover all working Java runtimes. Cached; pass force=true to rescan.
async function discover(force = false) {
  if (cache && !force) return cache;
  const paths = new Set(candidateDirs());
  const onPath = await fromPath();
  if (onPath) paths.add(onPath);

  const results = [];
  for (const p of paths) {
    const info = await probe(p);
    if (info) results.push(info);
  }
  // De-dupe by resolved path, newest major first.
  const seen = new Set();
  const uniq = results.filter((r) => {
    const key = r.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  uniq.sort((a, b) => b.major - a.major);
  cache = { javas: uniq, scannedAt: Date.now() };
  return cache;
}

function invalidate() {
  cache = null;
}

function majorOf(v) {
  if (!v) return 0;
  const parts = String(v).split(".");
  // "1.8.0_xxx" -> 8 ; "21.0.2" -> 21
  if (parts[0] === "1" && parts[1]) return Number(parts[1]) || 0;
  return Number(parts[0]) || 0;
}

// Best default runtime, or null if none found.
async function best() {
  const { javas } = await discover();
  return javas[0] || null;
}

/* ------------------------------------------------- which Java does MC want? */

const MOJANG_MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
let _manifest = null;
const _majorCache = new Map();

async function manifest() {
  if (!_manifest) _manifest = await net.getJson(MOJANG_MANIFEST);
  return _manifest;
}

// Offline/unknown-version fallback. Mirrors Mojang's own javaVersion pins.
function fallbackMajor(mc) {
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(mc || ""));
  if (!m) return 21;
  const a = Number(m[1]);
  const b = m[2] === undefined ? 0 : Number(m[2]);
  const c = m[3] === undefined ? 0 : Number(m[3]);
  // New year-based scheme: 26.1, 26.1.2, 26.2 …
  if (a !== 1) return a >= 26 ? 25 : 21;
  // Classic 1.x scheme.
  if (b >= 21) return 21;
  if (b === 20) return c >= 5 ? 21 : 17;
  if (b >= 18) return 17;
  if (b === 17) return 16;
  return 8;
}

// The Java major version a given Minecraft version requires. Mojang publishes
// this per version (`javaVersion.majorVersion`); we cache and fall back offline.
async function requiredMajor(mc) {
  if (!mc) return 21;
  if (_majorCache.has(mc)) return _majorCache.get(mc);
  let major = fallbackMajor(mc);
  try {
    const man = await manifest();
    const entry = man.versions.find((v) => v.id === mc);
    if (entry) {
      const pkg = await net.getJson(entry.url);
      if (pkg.javaVersion && pkg.javaVersion.majorVersion)
        major = Number(pkg.javaVersion.majorVersion) || major;
    }
  } catch {
    /* offline — keep the fallback */
  }
  _majorCache.set(mc, major);
  return major;
}

// Choose the runtime that best satisfies `major`. An exact match always wins.
// Modern Minecraft (Java 17+) runs happily on a newer JVM, so the lowest
// runtime above the requirement is fine; legacy versions (1.16 and older) break
// on anything newer, so those demand the exact major and return null otherwise
// — which is what triggers a download of the right one.
function pick(javas, major) {
  if (!major) return javas[0] || null;
  const exact = javas.find((j) => j.major === major);
  if (exact) return exact;
  if (major <= 16) return null;
  const newer = javas.filter((j) => j.major > major).sort((a, b) => a.major - b.major);
  return newer[0] || null;
}

/* --------------------------------------------------- installing a JRE for MC */

function adoptiumUrl(major) {
  const osName = isWin ? "windows" : process.platform === "darwin" ? "mac" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x64";
  // `jre` images are much smaller than full JDKs and are all a server needs.
  return `https://api.adoptium.net/v3/binary/latest/${major}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse`;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message || "").trim())) : resolve(stdout)
    );
  });
}

async function extract(archive, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archive.endsWith(".zip")) {
    // Windows 10+ ships bsdtar, which reads zips. PowerShell is the fallback.
    try {
      await run("tar", ["-xf", archive, "-C", destDir]);
      return;
    } catch {}
    await run("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath "${archive}" -DestinationPath "${destDir}" -Force`,
    ]);
  } else {
    await run("tar", ["-xzf", archive, "-C", destDir]);
  }
}

// Find bin/java inside a freshly extracted runtime folder.
function findJavaIn(dir) {
  const direct = path.join(dir, "bin", EXE);
  if (exists(direct)) return direct;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const nested = path.join(dir, e.name, "bin", EXE);
    if (exists(nested)) return nested;
  }
  return null;
}

const installing = new Map(); // major -> in-flight promise, so two servers share one download

// Download an Eclipse Temurin JRE for `major` into data/runtimes/. Resolves to
// the same {path, version, major} shape as discover().
function install(major, log = () => {}) {
  major = Number(major);
  if (!major) return Promise.reject(new Error("No Java version specified"));
  if (installing.has(major)) return installing.get(major);

  const job = (async () => {
    const dest = path.join(RUNTIMES_DIR, `temurin-${major}-jre`);
    const existingJava = exists(dest) && findJavaIn(dest);
    if (existingJava) {
      const info = await probe(existingJava);
      if (info) return info;
    }
    fs.mkdirSync(RUNTIMES_DIR, { recursive: true });
    const archive = path.join(RUNTIMES_DIR, `temurin-${major}${isWin ? ".zip" : ".tar.gz"}`);

    log(`Downloading Eclipse Temurin JRE ${major} (one-time, ~45 MB)…`);
    let lastPct = -1;
    await net.download(adoptiumUrl(major), archive, (done, total) => {
      if (!total) return;
      const pct = Math.floor((done / total) * 100);
      if (pct !== lastPct && pct % 10 === 0) {
        lastPct = pct;
        log(`  ${pct}%  (${(done / 1048576).toFixed(1)} MB)`);
      }
    });

    log("Extracting runtime…");
    fs.rmSync(dest, { recursive: true, force: true });
    await extract(archive, dest);
    try {
      fs.unlinkSync(archive);
    } catch {}

    const javaPath = findJavaIn(dest);
    if (!javaPath) throw new Error(`Temurin ${major} unpacked but no ${EXE} was found inside.`);
    if (!isWin) {
      try {
        fs.chmodSync(javaPath, 0o755);
      } catch {}
    }
    const info = await probe(javaPath);
    if (!info) throw new Error(`Downloaded Temurin ${major} but it would not run.`);
    invalidate();
    log(`✔ Installed Java ${info.version} at ${javaPath}`);
    return info;
  })().finally(() => installing.delete(major));

  installing.set(major, job);
  return job;
}

// One-stop resolver: give me a runtime that can run this MC version, installing
// one if the machine has nothing suitable. Returns {java, required, installed}.
async function resolveFor(mc, { explicitPath = null, autoInstall = true, log = () => {} } = {}) {
  const required = await requiredMajor(mc);

  if (explicitPath && exists(explicitPath)) {
    const info = await probe(explicitPath);
    if (info) return { java: info, required, installed: false, override: true };
  }

  const { javas } = await discover();
  const match = pick(javas, required);
  if (match) return { java: match, required, installed: false };

  if (!autoInstall) return { java: null, required, installed: false };
  const info = await install(required, log);
  return { java: info, required, installed: true };
}

module.exports = {
  discover,
  invalidate,
  best,
  probe,
  majorOf,
  requiredMajor,
  fallbackMajor,
  pick,
  install,
  resolveFor,
  RUNTIMES_DIR,
  EXE,
  isWin,
  homedir: os.homedir(),
};

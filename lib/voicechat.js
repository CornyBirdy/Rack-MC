/*
 * voicechat.js — the per-server "Voice chat" switch, built on Simple Voice Chat.
 *
 * Simple Voice Chat doesn't ride the Minecraft connection: the mod opens its own
 * UDP port (24454 by default) and every client connects to it separately. That
 * is why it breaks behind playit.gg — a Minecraft Java tunnel is TCP only — and
 * why two servers on one machine can't share a port.
 *
 * Off by default, and nothing is installed until it is switched on. Turning it
 * on:
 *   - installs Simple Voice Chat from Modrinth into mods/ or plugins/ (with its
 *     required dependencies, e.g. Fabric API), unless it's already there;
 *   - gives the server a UDP port no other server here uses (24454, 24455, …);
 *   - asks lib/playit.js for a UDP tunnel to that port while the server's public
 *     address is on;
 *   - writes `port` and `voice_host` into voicechat-server.properties, so the
 *     mod listens where the tunnel points and tells clients the playit address
 *     instead of letting them guess from the game address.
 *
 * Turning it off removes the mod again if this switch installed it, and pauses
 * the tunnel. The mod only reads its config at startup, so changes apply on the
 * next start.
 */
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const store = require("./store");
const modrinth = require("./modrinth");
const playit = require("./playit");

const SLUG = "simple-voice-chat";
// voicechat-fabric-1.21.1-2.5.26.jar, voicechat-bukkit-2.5.26.jar, …
const JAR_RE = /^voicechat-.*\.jar$/i;
const DEFAULT_PORT = 24454;
const LOADERS = ["fabric", "quilt", "forge", "neoforge", "paper", "purpur"];

const events = new EventEmitter();

/* ------------------------------------------------------------- what fits */

function support(def) {
  const target = def && def.start ? modrinth.targetFor(def) : null;
  if (!target) return { ok: false, reason: "Voice chat can be set up once the server has finished installing." };
  if (!LOADERS.includes(target.loader))
    return {
      ok: false,
      reason:
        "Simple Voice Chat is a mod or plugin, so it needs Fabric, Quilt, Forge, NeoForge, Paper or Purpur. Vanilla servers can't load it.",
    };
  return { ok: true, target };
}

// Mods keep their config in config/, Bukkit plugins in their own data folder.
function configPath(def, target) {
  const base = target.folder === "plugins" ? "plugins" : "config";
  return path.join(store.dirFor(def.id), base, "voicechat", "voicechat-server.properties");
}

// Is the mod there? Installed by the panel (from this switch, the Mods tab or
// a modpack) shows up in the manifest; dropped in by hand, by its file name.
function detect(def) {
  const sup = support(def);
  if (!sup.ok) return { installed: false };
  const { items, unmanaged } = modrinth.installed(store.dirFor(def.id), def);
  const item = items.find((it) => it.slug === SLUG || JAR_RE.test(path.basename(it.file)));
  if (item) return { installed: true, file: item.file, version: item.versionNumber || null, manual: false };
  const loose = unmanaged.find((u) => JAR_RE.test(u.name));
  if (loose) return { installed: true, file: loose.file, version: null, manual: true };
  return { installed: false };
}

// The first UDP port from 24454 that no other server here has claimed. Game
// ports are skipped too — TCP and UDP could share a number, but a port that
// means two things is a port somebody eventually forwards wrongly.
function pickPort(def) {
  const taken = new Set();
  for (const d of store.all()) {
    if (d.id === def.id) continue;
    taken.add(Number(d.port));
    if (d.voice && d.voice.port) taken.add(Number(d.voice.port));
  }
  const own = def.voice && Number(def.voice.port);
  if (own && !taken.has(own)) return own;
  let port = DEFAULT_PORT;
  while (taken.has(port)) port++;
  return port;
}

/* ---------------------------------------------------------------- config */

// The address clients are told to use, or "" to let them use the game's own
// host (which is right on a LAN, and the mod's default).
function voiceHost(def) {
  return playit.voiceInfo(def).address || "";
}

// Set keys in a .properties file, keeping every other line (the mod writes
// comments and its other settings there). Created if the mod hasn't run yet;
// it fills in the rest of its defaults on first start.
function patchFile(file, kv) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    lines = ["# Simple Voice Chat server config — port and voice_host are managed by MC Hoster"];
  }
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^\s*([\w.-]+)\s*[=:]/.exec(line);
    if (m && kv[m[1]] !== undefined) {
      seen.add(m[1]);
      return `${m[1]}=${kv[m[1]]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(kv)) if (!seen.has(k)) out.push(`${k}=${v}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join("\n").replace(/\n+$/, "") + "\n");
}

// Write this server's port and address into the mod's config. Returns true
// when the address changed, which a running server only picks up on restart.
function writeConfig(id) {
  const def = store.find(id);
  const sup = support(def);
  if (!def || !def.voice || !def.voice.enabled || !sup.ok) return false;
  const host = voiceHost(def);
  patchFile(configPath(def, sup.target), { port: def.voice.port, voice_host: host });
  const changed = host !== (def.voice.written ?? null);
  store.update(id, { voice: { ...def.voice, written: host } });
  return changed;
}

// Addresses arrive from playit on its own schedule — a fresh tunnel takes a
// few seconds to get one — so follow its changes and rewrite the config the
// moment the address a server should hand out is different.
playit.events.on("change", () => {
  for (const def of store.all()) {
    if (!def.voice || !def.voice.enabled) continue;
    if (def.voice.written === undefined) continue; // mid-setEnabled, which writes it itself
    if (voiceHost(def) === def.voice.written) continue;
    try {
      writeConfig(def.id);
      events.emit("host", def.id, voiceHost(def));
    } catch (e) {
      console.error(`[voice] could not update the config for ${def.name}: ${e.message}`);
    }
  }
});

/* ----------------------------------------------------------------- switch */

// A jar the JVM has open can't be deleted on Windows. Whatever couldn't go now
// goes before the next launch, when nothing holds it.
function removeJar(id, file) {
  const def = store.find(id);
  try {
    modrinth.remove(store.dirFor(id), def, file);
    store.update(id, { voice: { ...store.find(id).voice, removePending: null } });
    return true;
  } catch {
    store.update(id, { voice: { ...store.find(id).voice, removePending: file } });
    return false;
  }
}

async function setEnabled(id, enabled, { log = () => {} } = {}) {
  const def = store.find(id);
  if (!def) throw new Error("Unknown server");
  const v = def.voice || {};

  if (!enabled) {
    store.update(id, { voice: { ...v, enabled: false } });
    // Only take the mod away if this switch is what put it there; one installed
    // by hand or by a modpack is somebody else's decision.
    const found = detect(def);
    if (v.installedByPanel && found.installed && !found.manual) {
      if (removeJar(id, found.file)) log("Removed Simple Voice Chat from the server.");
      else log("Simple Voice Chat will be removed before the server next starts (the file is in use).");
    }
    store.update(id, { voice: { ...store.find(id).voice, installedByPanel: false } });
    await playit.syncVoice();
    return info(store.find(id), { deep: true });
  }

  const sup = support(def);
  if (!sup.ok) throw new Error(sup.reason);

  let installedByPanel = !!v.installedByPanel;
  const found = detect(def);
  if (found.installed) {
    if (v.removePending) store.update(id, { voice: { ...v, removePending: null } }); // keep it after all
    log(`Simple Voice Chat is already installed (${path.basename(found.file)}) — configuring it.`);
  } else {
    // Strictly this game version: a build for a different one is a crash on
    // startup, so no falling back to "newest for this loader" here.
    log("Installing Simple Voice Chat from Modrinth…");
    const builds = await modrinth.versions(SLUG, { loaders: sup.target.loaders, mc: def.mc });
    const pick = builds.find((b) => b.type === "release") || builds[0];
    if (!pick) throw new Error(`Simple Voice Chat has no ${sup.target.loader} build for Minecraft ${def.mc} yet.`);
    await modrinth.install(store.dirFor(id), def, { versionId: pick.id, log });
    installedByPanel = true;
  }

  const port = pickPort(store.find(id));
  store.update(id, {
    voice: { ...store.find(id).voice, enabled: true, port, installedByPanel, removePending: null },
  });
  log(`Voice chat uses UDP port ${port}.`);
  // Up before the config is written, so an address playit already has goes in.
  await playit.syncVoice({ retry: true });
  writeConfig(id);
  return info(store.find(id), { deep: true });
}

// Before every launch: finish a removal Windows blocked, and make sure the
// config says what the panel thinks it says (a hand edit, a modpack update
// overwriting config/, or a port another server has since taken).
function prepare(id) {
  const def = store.find(id);
  const v = def && def.voice;
  if (!v) return;
  if (v.removePending && !v.enabled) removeJar(id, v.removePending);
  if (!v.enabled) return;
  const port = pickPort(def);
  if (port !== v.port) {
    store.update(id, { voice: { ...v, port } });
    playit.syncVoice();
  }
  writeConfig(id);
}

/* ------------------------------------------------------------ public shape */

// `deep` adds what costs a look at the disk — whether the mod is actually in
// mods/ — which only the Settings tab needs.
function info(def, { deep = false } = {}) {
  if (!def) return null;
  const v = def.voice || {};
  const sup = support(def);
  const tunnel = playit.voiceInfo(def);
  const out = {
    supported: sup.ok,
    reason: sup.ok ? null : sup.reason,
    enabled: !!v.enabled,
    port: v.port || null,
    status: tunnel.status, // off | local | pending | ready | online | error
    address: tunnel.address,
    error: tunnel.error,
    hasTunnel: !!tunnel.hasTunnel,
  };
  if (deep && sup.ok) {
    const found = detect(def);
    out.installed = found.installed;
    out.manual = !!found.manual;
    out.version = found.version || null;
  }
  return out;
}

module.exports = { events, info, setEnabled, prepare, SLUG };

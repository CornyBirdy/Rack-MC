/*
 * pausemod.js — "pause when empty" for Minecraft versions that don't have it.
 *
 * Minecraft grew pause-when-empty-seconds in 1.21.2. Older servers get it a
 * different way, depending on what they are:
 *
 *   native — 1.21.2 and newer: server.properties does it, nothing to add.
 *   freeze — 1.20.3 to 1.21.1: `/tick freeze` exists, so the panel freezes the
 *            world itself once the server has been empty for the chosen time
 *            and thaws it the moment a player starts to connect. Any loader.
 *   mod    — Fabric/Quilt before 1.20.3: no tick command, so Tick Stasis (a
 *            small server-side Fabric mod) is installed into mods/ when the
 *            switch goes on and removed when it goes off. It pauses at once;
 *            it has no delay setting.
 *   null   — everything else (Vanilla, Paper, Forge, NeoForge before 1.20.3).
 *            Deep sleep still works there.
 */
const fs = require("fs");
const path = require("path");

const modrinth = require("./modrinth");

const MOD = { slug: "tick-stasis", title: "Tick Stasis" };

function method(def, native) {
  if (native) return "native";
  const m = /^([0-9]+)[.]([0-9]+)(?:[.]([0-9]+))?/.exec(String((def && def.mc) || ""));
  if (!m) return null;
  const minor = Number(m[2]);
  const patch = Number(m[3] || 0);
  if (minor > 20 || (minor === 20 && patch >= 3)) return "freeze";
  const loader = modrinth.realLoader(def);
  if ((loader === "fabric" || loader === "quilt") && minor >= 14) return "mod";
  return null;
}

// The jar if it is in mods/ — one we installed, or one dropped in by hand,
// since Fabric refuses to load the same mod twice.
function present(dir, def) {
  const ours = modrinth.installed(dir, def).items.find((it) => it.slug === MOD.slug);
  if (ours) return { file: ours.file, ours: true };
  try {
    const hand = fs.readdirSync(path.join(dir, "mods")).find((n) => /tick[-_ ]?stasis.*\.jar$/i.test(n));
    if (hand) return { file: path.posix.join("mods", hand), ours: false };
  } catch {}
  return null;
}

// Make mods/ match the switch. Resolves to "installed", "removed" or null (it
// already matched, or the jar is someone else's and stays put).
async function sync(dir, def, wanted, log) {
  const have = present(dir, def);
  if (wanted && !have) {
    await modrinth.install(dir, def, { projectId: MOD.slug, log });
    return "installed";
  }
  if (!wanted && have && have.ours) {
    modrinth.remove(dir, def, have.file);
    return "removed";
  }
  return null;
}

module.exports = { MOD, method, present, sync };

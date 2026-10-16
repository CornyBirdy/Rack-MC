/*
 * store.js — on-disk persistence for server definitions + global settings.
 * Everything lives under DATA_DIR:
 *   data/servers.json     — array of server metadata
 *   data/settings.json    — { javaPath, defaultMemory, quickCommands, keepServersRunning }
 *   data/servers/<id>/    — each server's working directory (world, jars, mods)
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SERVERS_DIR = path.join(DATA_DIR, "servers");
const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

function ensureDirs() {
  fs.mkdirSync(SERVERS_DIR, { recursive: true });
}
ensureDirs();

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// The one-click buttons beside every console. They are editable in the panel;
// this is only what a fresh install starts with. An empty label means the
// button shows the command itself.
const DEFAULT_QUICK_COMMANDS = [
  { label: "", cmd: "list" },
  { label: "", cmd: "say Hello from the panel!" },
  { label: "", cmd: "weather clear" },
  { label: "", cmd: "time set day" },
  { label: "", cmd: "save-all" },
];
const DEFAULT_SETTINGS = {
  javaPath: null,
  defaultMemory: 4096,
  quickCommands: DEFAULT_QUICK_COMMANDS,
  // Servers outlive the panel (lib/host.js), so updating it doesn't stop them.
  keepServersRunning: true,
};

let servers = readJSON(SERVERS_FILE, []);
// Spread over the defaults so settings files written by older versions pick up
// keys added since.
let settings = { ...DEFAULT_SETTINGS, ...readJSON(SETTINGS_FILE, {}) };

function saveServers() {
  writeJSON(SERVERS_FILE, servers);
}
function saveSettings() {
  writeJSON(SETTINGS_FILE, settings);
}

function all() {
  return servers;
}
function find(id) {
  return servers.find((s) => s.id === id);
}
function add(server) {
  servers.push(server);
  saveServers();
  return server;
}
function update(id, patch) {
  const s = find(id);
  if (!s) return null;
  Object.assign(s, patch);
  saveServers();
  return s;
}
function remove(id) {
  const s = find(id);
  servers = servers.filter((x) => x.id !== id);
  saveServers();
  return s;
}
function dirFor(id) {
  return path.join(SERVERS_DIR, id);
}

function getSettings() {
  return settings;
}
function setSettings(patch) {
  Object.assign(settings, patch);
  saveSettings();
  return settings;
}

module.exports = {
  DATA_DIR,
  DEFAULT_QUICK_COMMANDS,
  SERVERS_DIR,
  ROOT,
  all,
  find,
  add,
  update,
  remove,
  dirFor,
  getSettings,
  setSettings,
};

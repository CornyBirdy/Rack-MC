/*
 * store.js — on-disk persistence for server definitions + global settings.
 * Everything lives under DATA_DIR:
 *   data/servers.json     — array of server metadata
 *   data/settings.json    — { javaPath, defaultMemory }
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

let servers = readJSON(SERVERS_FILE, []);
let settings = readJSON(SETTINGS_FILE, { javaPath: null, defaultMemory: 4096 });

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

/*
 * playit.js — public addresses for servers without port forwarding.
 *
 * playit.gg runs a relay: an "agent" on this machine holds an outbound
 * connection to playit, and playit hands out a public address (for Minecraft
 * Java tunnels, a bare domain backed by an SRV record) that it forwards to a
 * local port. That means friends can join a server behind CGNAT or a router
 * nobody wants to reconfigure.
 *
 * How this module wires that up:
 *   - downloads the official single-file agent (pinned to AGENT_VERSION) into
 *     data/playit/, no system install;
 *   - links the panel to a playit account with the claim-code flow — we drive
 *     playit's HTTP API directly so the UI can show real progress — and stores
 *     the resulting agent secret in data/playit/playit.toml;
 *   - creates one minecraft-java tunnel per server that opts in;
 *   - runs ONE agent process for every enabled tunnel, launched with explicit
 *     `<tunnel-id>=127.0.0.1:<port>` mappings so routing always follows the
 *     panel's own port settings instead of whatever the website has stored.
 *
 * Zero external dependencies — Node built-ins plus lib/net.js.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { EventEmitter } = require("events");

const net = require("./net");
const store = require("./store");

// The 0.15 line is the last self-contained agent: one executable, no daemon and
// no Windows service. 1.x splits into playitd + tray + installer, which is not
// something a portable panel should be dropping onto someone's machine.
const AGENT_VERSION = "v0.15.26";
const API_BASE = "https://api.playit.gg";
const RELEASE_BASE = `https://github.com/playit-cloud/playit-agent/releases/download/${AGENT_VERSION}`;

const isWin = process.platform === "win32";
const DIR = path.join(store.DATA_DIR, "playit");
const SECRET_FILE = path.join(DIR, "playit.toml");
const BIN = path.join(DIR, isWin ? "playit.exe" : "playit");
const LOG_CAP = 200;

const events = new EventEmitter();
events.setMaxListeners(0);

/* ------------------------------------------------------------------- state */

const state = {
  installed: false,
  linked: false,
  agent: "stopped", // stopped | starting | online | error
  agentError: null,
  claim: null, // { code, url, status: waiting|visited|accepted|rejected|expired|error, error }
  account: null, // { status, agentId }
  log: [],
  installing: false,
};

// tunnelId -> live tunnel record from the playit API (only allocated ones).
const live = new Map();
let claimGen = 0; // bumped to cancel an in-flight claim loop
let proc = null;
let procKey = null; // the mapping set the running agent was launched with
let stopping = false;
let failures = 0;
let retryTimer = null;
let syncTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(line) {
  state.log.push({ t: Date.now(), line });
  if (state.log.length > LOG_CAP) state.log.shift();
  console.log("[playit] " + line);
}

function emit() {
  events.emit("change", snapshot());
}

/* -------------------------------------------------------------- the binary */

// playit publishes one static binary per platform. macOS isn't among them, so
// the panel says so instead of pretending the feature exists.
function assetName() {
  if (isWin) return process.arch === "ia32" ? "playit-windows-x86-signed.exe" : "playit-windows-x86_64-signed.exe";
  if (process.platform === "linux")
    return (
      { x64: "playit-linux-amd64", arm64: "playit-linux-aarch64", arm: "playit-linux-armv7", ia32: "playit-linux-i686" }[
        process.arch
      ] || null
    );
  return null;
}

const SUPPORTED = !!assetName();
const UNSUPPORTED_NOTE =
  "playit.gg doesn't publish an agent binary for " + process.platform + " — install it yourself and tunnel manually.";

function binInstalled() {
  try {
    return fs.statSync(BIN).size > 0;
  } catch {
    return false;
  }
}

let installJob = null;

// Fetch the agent once into data/playit/. Concurrent callers share the download.
function install(onLine = () => {}) {
  if (!SUPPORTED) return Promise.reject(new Error(UNSUPPORTED_NOTE));
  if (binInstalled()) {
    state.installed = true;
    return Promise.resolve({ path: BIN, version: AGENT_VERSION });
  }
  if (installJob) return installJob;

  installJob = (async () => {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = BIN + ".part";
    const url = `${RELEASE_BASE}/${assetName()}`;
    state.installing = true;
    emit();
    log(`Downloading playit agent ${AGENT_VERSION} (~5 MB)…`);
    onLine(`Downloading playit agent ${AGENT_VERSION}…`);
    let lastPct = -1;
    try {
      await net.download(url, tmp, (done, total) => {
        if (!total) return;
        const pct = Math.floor((done / total) * 100);
        if (pct !== lastPct && pct % 25 === 0) {
          lastPct = pct;
          onLine(`  ${pct}%`);
        }
      });
      fs.renameSync(tmp, BIN);
      if (!isWin) fs.chmodSync(BIN, 0o755);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw new Error(`Could not download the playit agent: ${e.message}`);
    } finally {
      state.installing = false;
    }
    state.installed = true;
    log("✔ Agent installed at " + BIN);
    emit();
    return { path: BIN, version: AGENT_VERSION };
  })().finally(() => (installJob = null));

  return installJob;
}

/* ------------------------------------------------------------- the secret */

// The agent reads its key from a tiny TOML file; we write and read the same
// file so `--secret_path` keeps the secret out of the process command line.
function readSecret() {
  try {
    const raw = fs.readFileSync(SECRET_FILE, "utf8");
    const m = /secret_key\s*=\s*"([0-9a-fA-F]+)"/.exec(raw) || /^\s*([0-9a-fA-F]{16,})\s*$/.exec(raw.trim());
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writeSecret(key) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(SECRET_FILE, `secret_key = "${key}"\n`, { mode: 0o600 });
}

/* ---------------------------------------------------------------- the API */

// playit answers every call with {status: "success"|"fail"|"error", data}. A
// "fail" is an expected outcome (code not ready yet, tunnel gone); an "error"
// is auth or server trouble.
async function api(pathname, body = {}, { auth = true } = {}) {
  const headers = {};
  if (auth) {
    const secret = readSecret();
    if (!secret) throw new Error("playit.gg isn't linked to an account yet.");
    headers.Authorization = `Agent-Key ${secret}`;
  }
  const { status, body: res } = await net.postJson(API_BASE + pathname, body, headers);
  if (res && res.status === "success") return res.data;
  const detail = res && res.data !== undefined ? JSON.stringify(res.data) : `HTTP ${status}`;
  const err = new Error(`playit API ${pathname}: ${detail}`);
  err.fail = res && res.status === "fail" ? res.data : null;
  err.apiError = res && res.status === "error" ? res.data : null;
  if (/InvalidAgentKey/i.test(detail)) err.invalidSecret = true;
  throw err;
}

/* ---------------------------------------------------------- claim / linking */

// Start the browser hand-shake: we invent a claim code, the user approves it at
// playit.gg/claim/<code>, and then we swap it for the permanent agent secret.
async function startLink() {
  if (!SUPPORTED) throw new Error(UNSUPPORTED_NOTE);
  await install();
  if (readSecret()) {
    state.linked = true;
    emit();
    return snapshot();
  }

  const gen = ++claimGen;
  const code = crypto.randomBytes(5).toString("hex");
  state.claim = { code, url: `https://playit.gg/claim/${code}`, status: "waiting", error: null };
  log("Waiting for approval at " + state.claim.url);
  emit();

  claimLoop(code, gen).catch((e) => {
    if (gen !== claimGen) return;
    state.claim = { ...state.claim, status: "error", error: e.message };
    log("Claim failed: " + e.message);
    emit();
  });

  return snapshot();
}

function cancelLink() {
  claimGen++;
  state.claim = null;
  emit();
  return snapshot();
}

async function claimLoop(code, gen) {
  const deadline = Date.now() + 10 * 60 * 1000;

  // Phase 1 — tell playit the code exists, then watch the user act on it.
  for (;;) {
    if (gen !== claimGen) return;
    if (Date.now() > deadline) {
      state.claim = { ...state.claim, status: "expired" };
      emit();
      return;
    }
    let step;
    try {
      step = await api(
        "/claim/setup",
        { code, agent_type: "self-managed", version: `MC Hoster (playit-cli ${AGENT_VERSION.slice(1)})` },
        { auth: false }
      );
    } catch (e) {
      // Transient network trouble shouldn't kill a flow the user is mid-way
      // through; a rejected/expired code is terminal though.
      if (e.fail === "CodeExpired") {
        state.claim = { ...state.claim, status: "expired" };
        emit();
        return;
      }
      await sleep(2000);
      continue;
    }
    if (step === "UserAccepted") break;
    if (step === "UserRejected") {
      state.claim = { ...state.claim, status: "rejected" };
      log("Claim rejected in the browser.");
      emit();
      return;
    }
    const status = step === "WaitingForUser" ? "visited" : "waiting";
    if (state.claim && state.claim.status !== status) {
      state.claim = { ...state.claim, status };
      emit();
    }
    await sleep(1500);
  }

  // Phase 2 — the approval is recorded; collect the secret.
  for (;;) {
    if (gen !== claimGen) return;
    try {
      const { secret_key: key } = await api("/claim/exchange", { code }, { auth: false });
      writeSecret(key);
      state.linked = true;
      state.claim = { ...state.claim, status: "accepted" };
      log("✔ Linked to a playit.gg account.");
      emit();
      setTimeout(() => {
        if (state.claim && state.claim.status === "accepted") {
          state.claim = null;
          emit();
        }
      }, 4000);
      await adoptExistingServers();
      await refresh();
      return;
    } catch (e) {
      if (e.fail === "UserRejected") {
        state.claim = { ...state.claim, status: "rejected" };
        emit();
        return;
      }
      if (e.fail === "CodeExpired" || e.fail === "CodeNotFound") {
        state.claim = { ...state.claim, status: "expired" };
        emit();
        return;
      }
      if (Date.now() > deadline) throw new Error("Timed out waiting for the claim to be approved.");
      await sleep(2000);
    }
  }
}

// Forget the account: stop tunnelling and drop the secret. Tunnels stay on the
// playit account (we can't touch them without the key) — say so in the UI.
function unlink() {
  claimGen++;
  state.claim = null;
  stopAgent();
  try {
    fs.unlinkSync(SECRET_FILE);
  } catch {}
  state.linked = false;
  state.account = null;
  live.clear();
  for (const def of store.all()) {
    if (def.playit && def.playit.tunnelId) store.update(def.id, { playit: { ...def.playit, address: null } });
  }
  log("Unlinked from playit.gg.");
  emit();
  return snapshot();
}

/* -------------------------------------------------------------- tunnels */

function tunnelAddress(t) {
  const host = t.custom_domain || t.assigned_domain;
  if (!host) return null;
  // Minecraft Java tunnels get an SRV record, so the bare domain is the
  // address players type. Everything else needs the port spelled out.
  return t.tunnel_type === "minecraft-java" ? host : `${host}:${t.port.from}`;
}

// Ask playit for this agent's tunnels and cache the allocated ones.
async function refresh() {
  if (!readSecret()) {
    state.linked = false;
    return snapshot();
  }
  state.linked = true;
  let data;
  try {
    data = await api("/agents/rundata");
  } catch (e) {
    if (e.invalidSecret) {
      log("The stored playit secret was rejected — link the panel again.");
      unlink();
    }
    return snapshot();
  }

  state.account = { status: data.account_status, agentId: data.agent_id };
  live.clear();
  for (const t of data.tunnels || []) live.set(t.id, t);
  const pendingIds = new Set((data.pending || []).map((t) => t.id));

  // Push freshly-allocated addresses onto the server definitions so the UI can
  // show them even before the agent is running.
  for (const def of store.all()) {
    const p = def.playit;
    if (!p || !p.tunnelId) continue;
    const t = live.get(p.tunnelId);
    const address = t ? tunnelAddress(t) : null;
    // A tunnel created seconds ago may not be listed yet, so only treat one as
    // gone once it has had time to show up.
    const settled = !p.since || Date.now() - p.since > 60000;
    const gone = !t && !pendingIds.has(p.tunnelId) && settled;
    if (gone) {
      // Deleted from the playit dashboard — drop it and make a new one later.
      log(`Tunnel for “${def.name}” no longer exists on the account; it will be recreated.`);
      store.update(def.id, { playit: { ...p, tunnelId: null, address: null } });
    } else if (address !== (p.address || null)) {
      store.update(def.id, { playit: { ...p, address } });
    }
  }

  emit();
  await syncAgent();
  return snapshot();
}

// Make sure `def` has a usable tunnel, creating one on the account if needed.
// Allocation isn't instant, so a brand-new tunnel may come back address-less;
// the refresh loop fills that in.
async function ensureTunnel(def) {
  const p = def.playit || {};
  if (p.tunnelId && (live.has(p.tunnelId) || p.address)) return p.tunnelId;

  const data = await api("/agents/rundata");
  live.clear();
  for (const t of data.tunnels || []) live.set(t.id, t);

  if (p.tunnelId && (live.has(p.tunnelId) || (data.pending || []).some((t) => t.id === p.tunnelId))) return p.tunnelId;

  // Reuse a tunnel we made for this server before (panel reinstalled, def
  // copied) rather than piling up tunnels on the account.
  const wanted = tunnelName(def);
  const mine = [...live.values(), ...(data.pending || [])].find(
    (t) => t.name === wanted && t.tunnel_type === "minecraft-java"
  );
  if (mine) {
    log(`Reusing existing playit tunnel “${wanted}”.`);
    return mine.id;
  }

  log(`Creating a Minecraft tunnel for “${def.name}”…`);
  const created = await api("/tunnels/create", {
    name: wanted,
    tunnel_type: "minecraft-java",
    port_type: "tcp",
    port_count: 1,
    origin: { type: "managed", data: { agent_id: null } },
    enabled: true,
    alloc: null,
    firewall_id: null,
  });
  return created.id;
}

function tunnelName(def) {
  return `MC Hoster · ${def.name}`.slice(0, 60);
}

/* -------------------------------------------------------- per-server toggle */

async function setEnabled(id, enabled) {
  const def = store.find(id);
  if (!def) throw new Error("Unknown server");
  if (!enabled) {
    store.update(id, { playit: { ...(def.playit || {}), enabled: false } });
    emit();
    await syncAgent();
    return serverInfo(store.find(id));
  }

  if (!SUPPORTED) throw new Error(UNSUPPORTED_NOTE);
  if (!readSecret()) throw new Error("Link MC Hoster to a playit.gg account first (Settings → playit.gg).");
  await install();

  const tunnelId = await ensureTunnel(def);
  const t = live.get(tunnelId);
  store.update(id, {
    playit: { enabled: true, tunnelId, address: t ? tunnelAddress(t) : null, since: Date.now() },
  });
  emit();
  await syncAgent();
  if (!t) scheduleRefresh(3000); // wait for playit to allocate the address
  return serverInfo(store.find(id));
}

// A server is being deleted: take its tunnel off the account too, so the
// account doesn't collect dead tunnels.
async function forget(id) {
  const def = store.find(id);
  const tunnelId = def && def.playit && def.playit.tunnelId;
  if (tunnelId && readSecret()) {
    try {
      await api("/tunnels/delete", { tunnel_id: tunnelId });
      log(`Deleted the playit tunnel for “${def.name}”.`);
    } catch (e) {
      log(`Could not delete the playit tunnel (${e.message}) — remove it at playit.gg/account if you care.`);
    }
  }
  live.delete(tunnelId);
  await syncAgent();
}

// Re-attach tunnels for servers that asked for playit before the panel was
// linked (or that were restored from a backup).
async function adoptExistingServers() {
  for (const def of store.all()) {
    if (!def.playit || !def.playit.enabled || def.playit.tunnelId) continue;
    try {
      const tunnelId = await ensureTunnel(def);
      store.update(def.id, { playit: { ...def.playit, tunnelId, since: Date.now() } });
    } catch (e) {
      log(`Could not prepare a tunnel for “${def.name}”: ${e.message}`);
    }
  }
}

/* --------------------------------------------------------- the agent process */

// One mapping per enabled server whose tunnel playit has actually allocated.
// Mappings come from the saved definitions, not from what's running, so
// starting or stopping a Minecraft server never disturbs the agent.
function mappings() {
  return store
    .all()
    .filter((d) => d.playit && d.playit.enabled && d.playit.tunnelId && live.has(d.playit.tunnelId))
    .map((d) => `${d.playit.tunnelId}=127.0.0.1:${d.port}`)
    .sort();
}

function stopAgent() {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (proc) {
    const p = proc;
    proc = null;
    procKey = null;
    try {
      p.kill();
    } catch {}
  }
  if (state.agent !== "stopped") {
    state.agent = "stopped";
    state.agentError = null;
    emit();
  }
}

// Bring the running agent in line with the current mapping set: start it, stop
// it, or restart it with new mappings.
async function syncAgent() {
  const wanted = mappings();
  const key = wanted.join(",");

  if (!state.linked || !binInstalled() || !wanted.length) {
    if (proc || state.agent !== "stopped") stopAgent();
    return;
  }
  if (proc && key === procKey) return;

  if (proc) {
    const old = proc;
    proc = null;
    try {
      old.kill();
    } catch {}
  }

  stopping = false;
  procKey = key;
  state.agent = "starting";
  state.agentError = null;
  emit();

  const args = ["--secret_path", SECRET_FILE, "-s", "run", key];
  let child;
  try {
    child = spawn(BIN, args, { cwd: DIR, windowsHide: true });
  } catch (e) {
    state.agent = "error";
    state.agentError = e.message;
    emit();
    return;
  }
  proc = child;
  log(`Agent started for ${wanted.length} tunnel(s).`);

  const onData = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // The agent's logs are verbose tracing output; keep the lines that say
      // something a person can act on.
      if (/error|warn|invalid|reject|denied|fail/i.test(trimmed)) log(trimmed.slice(0, 300));
      if (/InvalidAgentKey|MalformedSecret|InvalidSecret/i.test(trimmed)) {
        state.agentError = "playit rejected the stored secret — link the panel again.";
        state.agent = "error";
        emit();
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  // No "ready" line to wait for in log mode; if it's still alive after a few
  // seconds the control connection is up.
  const settle = setTimeout(() => {
    if (proc === child && state.agent === "starting") {
      state.agent = "online";
      failures = 0;
      emit();
    }
  }, 4000);

  child.on("error", (e) => {
    state.agentError = e.message;
    log("Agent error: " + e.message);
  });

  child.on("exit", (code) => {
    clearTimeout(settle);
    if (proc !== child) return; // superseded by a restart
    proc = null;
    procKey = null;
    if (stopping) return;
    failures++;
    state.agent = "error";
    state.agentError = state.agentError || `The playit agent exited (code ${code}).`;
    log(`Agent exited (code ${code}).`);
    emit();
    if (failures <= 5) {
      const wait = Math.min(30000, 5000 * failures);
      retryTimer = setTimeout(() => {
        procKey = null;
        syncAgent();
      }, wait);
    } else {
      log("Agent keeps failing — giving up until something changes.");
    }
  });
}

// Debounced re-sync, for callers that just changed a port or a name.
function sync(delay = 300) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncAgent().catch((e) => log("sync failed: " + e.message));
  }, delay);
}

function scheduleRefresh(delay = 5000) {
  setTimeout(() => refresh().catch(() => {}), delay).unref();
}

/* ------------------------------------------------------------- public shape */

function serverInfo(def) {
  const p = (def && def.playit) || {};
  if (!p.enabled) return { enabled: false, address: null, status: "off" };
  const t = p.tunnelId ? live.get(p.tunnelId) : null;
  let status = "pending";
  if (t && state.agent === "online") status = "online";
  else if (t) status = "ready";
  return {
    enabled: true,
    tunnelId: p.tunnelId || null,
    address: (t && tunnelAddress(t)) || p.address || null,
    host: t ? t.custom_domain || t.assigned_domain : null,
    port: t ? t.port.from : null,
    disabled: t && t.disabled ? t.disabled : null,
    status,
  };
}

function snapshot() {
  return {
    supported: SUPPORTED,
    note: SUPPORTED ? null : UNSUPPORTED_NOTE,
    version: AGENT_VERSION,
    installed: state.installed,
    installing: state.installing,
    linked: state.linked,
    agent: state.agent,
    agentError: state.agentError,
    claim: state.claim,
    account: state.account,
    tunnels: mappings().length,
  };
}

/* ------------------------------------------------------------------ startup */

state.installed = binInstalled();
state.linked = !!readSecret();

// Pick up tunnels + addresses at boot, then keep them fresh. The poll is cheap
// (one API call), fills in addresses playit allocated late, and re-launches the
// agent if it died. It runs whether or not the panel was linked at startup —
// linking happens mid-session too.
if (state.linked) scheduleRefresh(1500);
setInterval(() => {
  if (state.linked && store.all().some((d) => d.playit && d.playit.enabled)) refresh().catch(() => {});
}, 60000).unref();

module.exports = {
  events,
  snapshot,
  serverInfo,
  install,
  startLink,
  cancelLink,
  unlink,
  refresh,
  setEnabled,
  forget,
  sync,
  stopAgent,
  logLines: () => state.log,
  SUPPORTED,
};

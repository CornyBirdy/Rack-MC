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
 *   - gives a server either a fresh minecraft-java tunnel or one you already
 *     own, and keeps that tunnel pointed at the server's local port through
 *     playit's own API (`/tunnels/update`), so the panel's port settings are
 *     always what the relay forwards to;
 *   - gives a server with voice chat on a second, plain UDP tunnel for Simple
 *     Voice Chat's port, which a Minecraft Java tunnel doesn't carry;
 *   - runs ONE agent process for the whole panel, which serves every tunnel
 *     assigned to it.
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

// v0.17.1 is the newest self-contained agent: one executable, no daemon and no
// Windows service. 1.x splits into playitd + tray + installer, which is not
// something a portable panel should drop onto someone's machine — and anything
// older than the 0.16 line is refused by playit's control server now ("agent
// version is unknown / no longer supported").
const AGENT_VERSION = "v0.17.1";
const API_BASE = "https://api.playit.gg";
const RELEASE_BASE = `https://github.com/playit-cloud/playit-agent/releases/download/${AGENT_VERSION}`;

const isWin = process.platform === "win32";
const DIR = path.join(store.DATA_DIR, "playit");
const SECRET_FILE = path.join(DIR, "playit.toml");
// The filename carries the version so bumping AGENT_VERSION fetches the new
// agent instead of silently reusing an outdated one.
const BIN = path.join(DIR, `playit-${AGENT_VERSION}${isWin ? ".exe" : ""}`);
// Enough to scroll back through a reconnect storm; the agent is chatty.
const LOG_CAP = 1000;

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
  quota: null, // { tcp, udp, tunnels, blocked, at } — see readQuota
};

// tunnelId -> live tunnel record from the playit API (only allocated ones).
const live = new Map();
let claimGen = 0; // bumped to cancel an in-flight claim loop
let proc = null;
let stopping = false;
let failures = 0;
let retryTimer = null;
let syncTimer = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One log for the panel's agent console. `stream` says who wrote the line:
// "sys" is this module talking, "out"/"err" are the agent's own output (routine
// vs. something worth reading). The terminal only gets the first and last —
// routine agent output would bury everything else run.bat prints.
function log(line, stream = "sys") {
  const entry = { t: Date.now(), stream, line };
  state.log.push(entry);
  if (state.log.length > LOG_CAP) state.log.shift();
  if (stream !== "out") console.log("[playit] " + line);
  events.emit("log", entry);
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
    for (const stale of fs.readdirSync(DIR)) {
      if (/^playit(-v[\d.]+)?(\.exe)?$/.test(stale) && path.join(DIR, stale) !== BIN) {
        try {
          fs.unlinkSync(path.join(DIR, stale));
          log("Removed the superseded agent " + stale);
        } catch {}
      }
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
      await syncAgent(); // connect now, so playit.gg sees a live, versioned agent
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
  state.quota = null;
  agentIdCache = null;
  live.clear();
  for (const def of store.all()) {
    if (def.playit && def.playit.tunnelId) store.update(def.id, { playit: { ...def.playit, address: null } });
    // Remembered, so linking the same account again finds the tunnel; the
    // agent serving it is gone though, so it has to be bound afresh.
    if (def.voice && def.voice.tunnelId) store.update(def.id, { voice: { ...def.voice, address: null, bound: null } });
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
  agentIdCache = data.agent_id;
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

  // Voice chat tunnels get the same treatment: fill in the address, and drop
  // one deleted at playit.gg so syncVoice below makes a new one.
  for (const def of store.all()) {
    const v = def.voice;
    if (!v || !v.tunnelId) continue;
    const t = live.get(v.tunnelId);
    const address = t ? tunnelAddress(t) : null;
    const settled = !v.since || Date.now() - v.since > 60000;
    if (!t && !pendingIds.has(v.tunnelId) && settled) {
      log(`Voice chat tunnel for “${def.name}” no longer exists on the account; it will be recreated.`);
      store.update(def.id, { voice: { ...v, tunnelId: null, address: null, bound: null } });
    } else if (address !== (v.address || null)) {
      store.update(def.id, { voice: { ...v, address } });
    }
  }

  await quota();
  emit();
  await syncVoice();
  await syncAgent();
  return snapshot();
}

/* --------------------------------------------------------- the account quota */

// playit counts ports, not tunnels — though every tunnel the panel makes is one
// port — and keeps TCP and UDP apart: game addresses spend TCP ports, voice
// chat UDP ones. /tunnels/list reports both pools ({allowed, claimed,
// desired}) and, per tunnel, whether playit has switched it off because the
// account is over its limit or the tunnel needs Premium. Kept on the snapshot
// so the panel can show it and check before asking for another tunnel.
const QUOTA_TTL = 30000;

function pool(p) {
  if (!p || typeof p.allowed !== "number") return null;
  const used = Math.max(Number(p.claimed) || 0, Number(p.desired) || 0);
  return { allowed: p.allowed, used, free: Math.max(0, p.allowed - used) };
}

function readQuota(data) {
  const blocked = {};
  for (const t of data.tunnels || [])
    if (t.alloc && t.alloc.status === "disabled") blocked[t.id] = (t.alloc.data && t.alloc.data.reason) || "disabled";
  state.quota = {
    tcp: pool(data.tcp_alloc),
    udp: pool(data.udp_alloc),
    tunnels: (data.tunnels || []).length,
    blocked, // tunnelId -> "over-port-limit" | "requires-premium" | …
    at: Date.now(),
  };
  return state.quota;
}

async function quota({ fresh = false } = {}) {
  if (!readSecret()) return null;
  if (!fresh && state.quota && Date.now() - state.quota.at < QUOTA_TTL) return state.quota;
  try {
    return readQuota(await api("/tunnels/list", { tunnel_id: null, agent_id: null }));
  } catch (e) {
    log("Could not read the account's tunnel limits: " + e.message);
    return state.quota;
  }
}

// Every tunnel the account owns, shaped for the "use an existing tunnel"
// picker. Routing itself works off /agents/rundata; this list is also where
// the account's port limits come from.
async function listAccountTunnels() {
  const data = await api("/tunnels/list", { tunnel_id: null, agent_id: null });
  readQuota(data);
  // A server with its address switched on is using its tunnel; one switched
  // off only remembers it, so it can come back at the same address. Either
  // way the picker says who has it, and taking it moves it.
  const used = new Map(), held = new Map();
  for (const d of store.all()) {
    if (!d.playit || !d.playit.tunnelId) continue;
    (d.playit.enabled ? used : held).set(d.playit.tunnelId, { id: d.id, name: d.name });
  }
  // Voice chat tunnels are UDP and belong to the voice chat switch; offering
  // one as a game address would only break both.
  const voice = new Set(store.all().map((d) => d.voice && d.voice.tunnelId).filter(Boolean));

  return (data.tunnels || []).filter((t) => !voice.has(t.id)).map((t) => {
    const alloc = t.alloc && t.alloc.status === "allocated" ? t.alloc.data : null;
    const host = (t.domain && t.domain.name) || (alloc && alloc.assigned_domain) || null;
    const type = t.tunnel_type || null;
    return {
      id: t.id,
      name: t.name || "(unnamed)",
      type,
      portType: t.port_type,
      status: (t.alloc && t.alloc.status) || "pending",
      address: host ? (type === "minecraft-java" ? host : `${host}:${alloc ? alloc.port_start : ""}`) : null,
      agent: t.origin && t.origin.data ? t.origin.data.agent_name || null : null,
      usedBy: used.get(t.id) || null,
      heldBy: held.get(t.id) || null,
      // Only Minecraft Java tunnels give players a bare-domain address; the
      // rest still work, they just need the port typed in.
      recommended: type === "minecraft-java" && (t.port_type === "tcp" || t.port_type === "both"),
    };
  });
}

// Point a tunnel at this server and hand it to our agent. This is the same
// call playit.gg's own "transfer tunnel" screen makes, which is why adopting
// an existing tunnel and creating a fresh one end at the same place.
// `enabled: false` is how switching an address off actually takes it off the
// internet — the agent serves every enabled tunnel assigned to it, whatever the
// panel thinks of it.
async function bindTunnel(tunnelId, def, enabled = true, port = def.port) {
  const agentId = await ourAgentId();
  await api("/tunnels/update", {
    tunnel_id: tunnelId,
    local_ip: "127.0.0.1",
    local_port: port,
    agent_id: agentId,
    enabled,
  });
}

let agentIdCache = null;
async function ourAgentId() {
  if (agentIdCache) return agentIdCache;
  const data = await api("/agents/rundata");
  agentIdCache = data.agent_id;
  state.account = { status: data.account_status, agentId: data.agent_id };
  return agentIdCache;
}

// Give `def` a tunnel: the one the user picked, the one it already had, or a
// brand-new Minecraft tunnel. Allocation isn't instant, so a fresh tunnel can
// come back address-less; the refresh loop fills that in.
async function ensureTunnel(def, pick = null) {
  const p = def.playit || {};
  if (pick && pick !== "new") return pick;

  const data = await api("/agents/rundata");
  agentIdCache = data.agent_id;
  live.clear();
  for (const t of data.tunnels || []) live.set(t.id, t);

  // An explicit "new" means a new address — never quietly hand back the old one.
  const wanted = tunnelName(def);
  if (pick !== "new") {
    if (p.tunnelId && (live.has(p.tunnelId) || (data.pending || []).some((t) => t.id === p.tunnelId))) return p.tunnelId;

    // Reuse a tunnel we made for this server before (panel reinstalled, def
    // copied) rather than piling more onto the account.
    const mine = [...live.values(), ...(data.pending || [])].find(
      (t) => (t.name === wanted || t.name === legacyTunnelName(def)) && t.tunnel_type === "minecraft-java"
    );
    if (mine) {
      log(`Reusing existing playit tunnel “${wanted}”.`);
      return mine.id;
    }
  }

  log(`Creating a Minecraft tunnel for “${def.name}”…`);
  const created = await api("/tunnels/create", {
    name: wanted,
    tunnel_type: "minecraft-java",
    port_type: "tcp",
    port_count: 1,
    origin: { type: "agent", data: { agent_id: data.agent_id, local_ip: "127.0.0.1", local_port: def.port } },
    enabled: true,
    alloc: null,
    firewall_id: null,
    proxy_protocol: null,
  });
  return created.id;
}

// playit rejects names with anything beyond plain ASCII words (/tunnels/create
// answers "InvalidTunnelName" to the middle dot this used to have, to emoji and
// accents), so keep to letters, digits, spaces, dashes and underscores, short.
function tunnelName(def) {
  const clean = String(def.name || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // "é" -> "e", not "e "
    .replace(/[^A-Za-z0-9 _-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return ("MC Hoster - " + (clean || def.id)).slice(0, 32).trim();
}
// What older versions called it, so their tunnels are still found and reused.
const legacyTunnelName = (def) => `MC Hoster · ${def.name}`.slice(0, 60);

/* -------------------------------------------------------- per-server toggle */

// `tunnelId` adopts a tunnel the account already owns instead of making one —
// that's how you keep an address you've already handed out to friends. "new"
// always mints a fresh one; null means "whatever this server had before".
// A tunnel only ever points at one server, so adopting one another server has
// (or remembers) takes it away from that server.
async function setEnabled(id, enabled, { tunnelId = null } = {}) {
  const def = store.find(id);
  if (!def) throw new Error("Unknown server");
  if (!enabled) {
    const p = def.playit || {};
    if (p.tunnelId && readSecret()) {
      try {
        await bindTunnel(p.tunnelId, def, false);
      } catch (e) {
        log(`Could not pause the tunnel for “${def.name}” (${e.message}) — it may still answer until you disable it at playit.gg.`);
      }
    }
    store.update(id, { playit: { ...p, enabled: false } });
    await syncVoice(); // voice chat goes off the internet with the game
    emit();
    await syncAgent();
    return serverInfo(store.find(id));
  }

  if (!SUPPORTED) throw new Error(UNSUPPORTED_NOTE);
  if (!readSecret()) throw new Error("Link MC Hoster to a playit.gg account first (Settings → playit.gg).");
  await install();

  const picked = await ensureTunnel(def, tunnelId);
  await bindTunnel(picked, def);
  for (const other of store.all()) {
    if (other.id === id || !other.playit || other.playit.tunnelId !== picked) continue;
    log(`Moved the address from “${other.name}” to “${def.name}”.`);
    store.update(other.id, { playit: { enabled: false, tunnelId: null, address: null } });
  }
  const t = live.get(picked);
  store.update(id, {
    playit: { enabled: true, tunnelId: picked, address: t ? tunnelAddress(t) : null, since: Date.now() },
  });
  // Bring this server's voice chat tunnel up with it, and pause the one on any
  // server that just lost its address to this one.
  await syncVoice({ retry: true });
  emit();
  await syncAgent();
  scheduleRefresh(3000); // let playit publish the assignment, then read it back
  return serverInfo(store.find(id));
}

// A server is being deleted: take its tunnels off the account too, so the
// account doesn't collect dead tunnels.
async function forget(id) {
  const def = store.find(id);
  const tunnels = [
    [def && def.playit && def.playit.tunnelId, "playit tunnel"],
    [def && def.voice && def.voice.tunnelId, "voice chat tunnel"],
  ];
  for (const [tunnelId, what] of tunnels) {
    if (!tunnelId) continue;
    if (readSecret()) {
      try {
        await api("/tunnels/delete", { tunnel_id: tunnelId });
        log(`Deleted the ${what} for “${def.name}”.`);
      } catch (e) {
        log(`Could not delete the ${what} (${e.message}) — remove it at playit.gg/account if you care.`);
      }
    }
    live.delete(tunnelId);
  }
  await syncAgent();
}

/* ------------------------------------------------------- voice chat tunnels */

// Simple Voice Chat talks over its own UDP port, which a Minecraft Java tunnel
// (TCP only) never carries. So a server with voice chat on gets a second,
// plain UDP tunnel pointed at that port. It follows the public address: there
// is no point reaching voice chat from outside when the game itself can't be.
// lib/voicechat.js owns the switch and the mod; this owns the tunnel.

const VOICE_RETRY_MS = 10 * 60 * 1000;

function voiceWanted(def) {
  return !!(def.voice && def.voice.enabled && def.playit && def.playit.enabled && def.voice.port);
}

// Same character rules as tunnelName; the suffix survives a long server name.
function voiceTunnelName(def) {
  const base = tunnelName(def).replace(/^MC Hoster - /, "");
  return ("MC Hoster - " + base.slice(0, 14).trim() + " voice").slice(0, 32);
}

// playit's refusal, in words that say what to do about it.
const FULL_NOTE = "Delete a UDP tunnel you don't use at playit.gg/account/tunnels (or upgrade), then press Try again.";
function voiceError(e) {
  const msg = e.message || String(e);
  if (/RequiresDescription|InvalidTunnelConfig|TunnelType/i.test(msg))
    return "playit.gg won't let MC Hoster create this kind of tunnel automatically. Make one yourself at playit.gg (tunnel type “Simple Voice Chat”), then press Use a playit tunnel… and pick it.";
  if (/premium/i.test(msg))
    return "playit.gg only allows this kind of tunnel (plain UDP) on Premium accounts, so voice chat can't get a public address on this account.";
  if (/limit|max|quota/i.test(msg)) return "Your playit.gg account has no UDP ports left. " + FULL_NOTE;
  return "Could not set up the voice chat tunnel: " + msg;
}

// Why playit has switched a voice tunnel off, if it has.
function blockedNote(reason) {
  if (reason === "requires-premium")
    return "playit.gg made the voice chat tunnel but won't run it without Premium — plain UDP tunnels need it on this account.";
  if (reason === "over-port-limit")
    return "playit.gg switched the voice chat tunnel off: the account is over its UDP port limit. " + FULL_NOTE;
  return reason ? `playit.gg has switched the voice chat tunnel off (${reason}).` : null;
}

// Room for one more voice tunnel? Unknown counts as yes — playit is the final
// word, and an error from it is reported the same way.
async function udpRoom({ fresh = false } = {}) {
  const q = await quota({ fresh });
  return q && q.udp ? q.udp : null;
}

async function createVoiceTunnel(def) {
  const data = await api("/agents/rundata");
  agentIdCache = data.agent_id;
  const name = voiceTunnelName(def);
  // A tunnel we made for this server before (panel reinstalled, voice switched
  // off and on) is reused rather than piling more onto the account — unless
  // another server has it now, because it was moved there on purpose.
  const taken = new Set(store.all().map((d) => d.id !== def.id && d.voice && d.voice.tunnelId).filter(Boolean));
  const mine = [...(data.tunnels || []), ...(data.pending || [])].find((t) => t.name === name && !taken.has(t.id));
  if (mine) {
    log(`Reusing the voice chat tunnel “${name}”.`);
    return mine.id;
  }
  log(`Creating a UDP tunnel for “${def.name}” voice chat…`);
  const created = await api("/tunnels/create", {
    name,
    // playit refuses plain (preset-less) tunnels without one of these
    // ("TunnelTypeRequiresDescription"). Its published agent code doesn't
    // name the field, so this is our best reading of the rule; when playit
    // still says no, the tunnel can be made at playit.gg and picked instead.
    description: `Simple Voice Chat (Minecraft proximity voice) for the server "${def.name}"`,
    tunnel_type: null,
    port_type: "udp",
    port_count: 1,
    origin: { type: "agent", data: { agent_id: data.agent_id, local_ip: "127.0.0.1", local_port: def.voice.port } },
    enabled: true,
    alloc: null,
    firewall_id: null,
    proxy_protocol: null,
  });
  return created.id;
}

// Make every server's voice tunnel match what it should be: up and pointed at
// its voice port, or paused. `bound` records what playit was last told, so the
// steady state costs no API calls and this can run on every refresh. A tunnel
// playit refused to make isn't asked for again for a while unless `retry` —
// someone pressing a button — says so.
let voiceJob = Promise.resolve();
function syncVoice(opts) {
  voiceJob = voiceJob.then(() => reconcileVoice(opts)).catch((e) => log("voice sync failed: " + e.message));
  return voiceJob;
}

async function reconcileVoice({ retry = false } = {}) {
  if (!readSecret()) return;
  let created = false;
  for (const def of store.all()) {
    const v = def.voice;
    if (!v) continue;
    const want = voiceWanted(def);
    const bound = v.bound || null;
    try {
      if (want) {
        if (bound && bound.on && bound.port === v.port && v.tunnelId) continue;
        if (!v.tunnelId && v.failedAt && !retry && Date.now() - v.failedAt < VOICE_RETRY_MS) continue;
        let tunnelId = v.tunnelId;
        if (!tunnelId) {
          // Check first, so a full account is a clear message rather than a
          // tunnel playit makes and then leaves switched off.
          const room = await udpRoom({ fresh: true });
          if (room && room.free <= 0) {
            store.update(def.id, {
              voice: {
                ...store.find(def.id).voice,
                error: `Your playit.gg account has no UDP ports left (${room.used} of ${room.allowed} in use), so voice chat can't get a public address. ${FULL_NOTE}`,
                failedAt: Date.now(),
              },
            });
            continue;
          }
          tunnelId = await createVoiceTunnel(def);
          created = true;
          if (state.quota) state.quota.at = 0; // it just changed
        }
        await bindTunnel(tunnelId, def, true, v.port);
        const t = live.get(tunnelId);
        store.update(def.id, {
          voice: {
            ...store.find(def.id).voice,
            tunnelId,
            address: t ? tunnelAddress(t) : v.tunnelId === tunnelId ? v.address || null : null,
            since: v.tunnelId === tunnelId ? v.since : Date.now(),
            bound: { on: true, port: v.port },
            error: null,
            failedAt: null,
          },
        });
      } else if (v.tunnelId && (!bound || bound.on)) {
        await bindTunnel(v.tunnelId, def, false, v.port);
        store.update(def.id, { voice: { ...store.find(def.id).voice, bound: { on: false, port: v.port } } });
      }
    } catch (e) {
      log(`Voice chat tunnel for “${def.name}”: ${e.message}`);
      if (want) store.update(def.id, { voice: { ...store.find(def.id).voice, error: voiceError(e), failedAt: Date.now() } });
    }
  }
  if (created) scheduleRefresh(3000);
  emit();
}

// What the Settings tab and lib/voicechat.js need to know about one server's
// voice tunnel. `address` is only set while players outside can use it, which
// is exactly when it belongs in the mod's config.
function voiceInfo(def) {
  const v = (def && def.voice) || {};
  // A tunnel kept from before (paused) needs no new port to come back.
  const hasTunnel = !!v.tunnelId;
  if (!v.enabled) return { status: "off", address: null, error: null, hasTunnel };
  if (!SUPPORTED || !state.linked || !(def.playit && def.playit.enabled))
    return { status: "local", address: null, error: null, hasTunnel };
  const t = v.tunnelId ? live.get(v.tunnelId) : null;
  if (!v.tunnelId && v.error) return { status: "error", address: null, error: v.error, hasTunnel: false };
  const blocked = v.tunnelId && state.quota ? blockedNote(state.quota.blocked[v.tunnelId]) : null;
  if (blocked) return { status: "error", address: null, error: blocked, hasTunnel: true };
  const address = (t && tunnelAddress(t)) || v.address || null;
  return {
    status: t && state.agent === "online" ? "online" : address ? "ready" : "pending",
    address,
    error: v.error || null,
    hasTunnel: !!v.tunnelId,
  };
}

// Re-attach tunnels for servers that asked for playit before the panel was
// linked (or that were restored from a backup).
async function adoptExistingServers() {
  for (const def of store.all()) {
    if (!def.playit || !def.playit.enabled) continue;
    try {
      const tunnelId = await ensureTunnel(def);
      await bindTunnel(tunnelId, def);
      store.update(def.id, { playit: { ...def.playit, tunnelId, since: Date.now() } });
    } catch (e) {
      log(`Could not prepare a tunnel for “${def.name}”: ${e.message}`);
    }
  }
}

/* --------------------------------------------------------- the agent process */

// Servers whose tunnel playit has actually allocated — what the UI counts.
function enabledTunnels() {
  return store
    .all()
    .filter((d) => d.playit && d.playit.enabled && d.playit.tunnelId && live.has(d.playit.tunnelId));
}

function stopAgent() {
  stopping = true;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  if (proc) {
    const p = proc;
    proc = null;
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

// Keep exactly one agent alive for as long as the panel is linked. Routing
// lives on the tunnels themselves now, so the agent never needs restarting
// when a port changes or a server is added — and staying connected is also
// what makes the agent report a real version on playit.gg, which their
// tunnel-transfer screen refuses to work without.
async function syncAgent() {
  if (!state.linked || !binInstalled()) {
    if (proc || state.agent !== "stopped") stopAgent();
    return;
  }
  if (proc) return;

  stopping = false;
  state.agent = "starting";
  state.agentError = null;
  emit();

  const args = ["--secret_path", SECRET_FILE, "-s", "start"];
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
  log(`Agent ${AGENT_VERSION} started (${enabledTunnels().length} tunnel(s) in use).`);

  // Everything the agent prints goes to the console. It's tracing output with
  // colour codes, so strip those, and never echo the key should it turn up.
  const secret = readSecret();
  const onLine = (raw) => {
    let line = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim();
    if (!line) return;
    if (secret) line = line.split(secret).join("<secret>");
    const problem = /error|warn|invalid|reject|denied|fail/i.test(line);
    log(line.slice(0, 1000), problem ? "err" : "out");
    if (/InvalidAgentKey|MalformedSecret|InvalidSecret|Invalid secret/i.test(line)) {
      state.agentError = "playit rejected the stored secret — link the panel again.";
      state.agent = "error";
      emit();
    }
  };
  // A chunk can end mid-line; hold the tail until the rest arrives.
  const lineReader = (stream) => {
    let carry = "";
    stream.on("data", (buf) => {
      const lines = (carry + String(buf)).split(/\r?\n/);
      carry = lines.pop();
      lines.forEach(onLine);
    });
    stream.on("end", () => carry && onLine(carry));
  };
  lineReader(child.stdout);
  lineReader(child.stderr);

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
    if (stopping) return;
    failures++;
    state.agent = "error";
    state.agentError = state.agentError || `The playit agent exited (code ${code}).`;
    log(`Agent exited (code ${code}).`);
    emit();
    if (failures <= 5) {
      const wait = Math.min(30000, 5000 * failures);
      retryTimer = setTimeout(syncAgent, wait);
    } else {
      log("Agent keeps failing — giving up until something changes.");
    }
  });
}

// The console's "Restart agent" button. Also the way out after the agent has
// failed often enough that the retry loop gave up on it.
async function restartAgent() {
  if (!state.linked) throw new Error("Link MC Hoster to a playit.gg account first.");
  log("Restarting the agent…");
  stopAgent();
  failures = 0;
  await syncAgent();
  return snapshot();
}

// Debounced re-sync for callers that changed a server's port: the relay has to
// be told where to forward now, which is an API call rather than a restart.
function sync(delay = 300) {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    try {
      if (readSecret())
        for (const def of store.all())
          if (def.playit && def.playit.enabled && def.playit.tunnelId) await bindTunnel(def.playit.tunnelId, def);
      await syncVoice();
      await syncAgent();
    } catch (e) {
      log("sync failed: " + e.message);
    }
  }, delay);
}

function scheduleRefresh(delay = 5000) {
  setTimeout(() => refresh().catch(() => {}), delay).unref();
}

// Tunnels on the account that can carry voice chat (UDP, or TCP+UDP), for the
// "use a tunnel I made at playit.gg" picker. Game addresses are left out;
// another server's voice tunnel is listed, marked, and picking it moves it.
async function listVoiceTunnels() {
  const data = await api("/tunnels/list", { tunnel_id: null, agent_id: null });
  readQuota(data);
  const game = new Set(store.all().map((d) => d.playit && d.playit.tunnelId).filter(Boolean));
  const voiceBy = new Map();
  for (const d of store.all()) if (d.voice && d.voice.tunnelId) voiceBy.set(d.voice.tunnelId, { id: d.id, name: d.name });
  return (data.tunnels || [])
    .filter((t) => (t.port_type === "udp" || t.port_type === "both") && !game.has(t.id))
    .map((t) => {
      const alloc = t.alloc && t.alloc.status === "allocated" ? t.alloc.data : null;
      const host = (t.domain && t.domain.name) || (alloc && alloc.assigned_domain) || null;
      return {
        id: t.id,
        name: t.name || "(unnamed)",
        type: t.tunnel_type || null,
        portType: t.port_type,
        status: (t.alloc && t.alloc.status) || "pending",
        blocked: t.alloc && t.alloc.status === "disabled" ? (t.alloc.data && t.alloc.data.reason) || "disabled" : null,
        address: host && alloc ? `${host}:${alloc.port_start}` : null,
        voiceBy: voiceBy.get(t.id) || null,
      };
    });
}

// Give a server's voice chat a tunnel the user made at playit.gg. syncVoice
// then points it at the voice port and hands it to our agent, the same call
// adopting a game address makes. A tunnel only serves one server.
async function adoptVoiceTunnel(id, tunnelId) {
  const def = store.find(id);
  if (!def) throw new Error("Unknown server");
  for (const other of store.all()) {
    if (other.id === id || !other.voice || other.voice.tunnelId !== tunnelId) continue;
    log(`Moved the voice chat tunnel from “${other.name}” to “${def.name}”.`);
    store.update(other.id, { voice: { ...other.voice, tunnelId: null, address: null, bound: null } });
  }
  store.update(id, {
    voice: { ...(def.voice || {}), tunnelId, address: null, bound: null, since: Date.now(), error: null, failedAt: null },
  });
  if (state.quota) state.quota.at = 0;
  scheduleRefresh(3000);
}

/* ------------------------------------------------------------- public shape */

function serverInfo(def) {
  const p = (def && def.playit) || {};
  // Switched off, but the tunnel is remembered: turning it back on returns to
  // this address, so the UI can say which one.
  if (!p.enabled) return { enabled: false, address: null, status: "off", previous: p.tunnelId ? p.address || null : null };
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
    tunnels: enabledTunnels().length,
    quota: state.quota ? { tcp: state.quota.tcp, udp: state.quota.udp, tunnels: state.quota.tunnels } : null,
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
  listAccountTunnels,
  forget,
  sync,
  syncVoice,
  voiceInfo,
  quota,
  listVoiceTunnels,
  adoptVoiceTunnel,
  stopAgent,
  restartAgent,
  logLines: () => state.log,
  SUPPORTED,
};

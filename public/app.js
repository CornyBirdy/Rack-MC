/* ================================================================ MC Hoster
 * Single-page control panel. Vanilla JS, no build step.
 * Talks to the Node backend over REST + Server-Sent Events.
 * ======================================================================== */

const API = {
  async get(p) {
    const r = await fetch(p);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  },
  async send(method, p, body) {
    const r = await fetch(p, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body == null ? undefined : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  },
  post(p, b) { return this.send("POST", p, b); },
  put(p, b) { return this.send("PUT", p, b); },
  patch(p, b) { return this.send("PATCH", p, b); },
  del(p) { return this.send("DELETE", p); },
};

/* ------------------------------------------------------------------- state */
const state = {
  loaders: [],
  javas: [],
  settings: {},
  defaults: { quickCommands: [] }, // stock values the backend ships, for "reset"
  build: null, // { version, commit } — what this checkout is
  lan: [], // addresses a phone on the same network can open the panel at
  playit: { supported: false, linked: false, agent: "stopped" },
  sys: null, // latest host resource sample (see sysmon.js)
  servers: new Map(), // id -> summary
  route: { name: "dashboard", id: null },
  consoleES: null, // EventSource for the open server console
  content: null, // last /content payload for the open server (installed mods)
  plog: null, // players tab: filters + the page of history it is showing
  perf: null, // stats tab: chosen range + the history it is drawing
  activeTab: "console",
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const view = $("#view");

/* -------------------------------------------------------------- utilities */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtUptime(ms) {
  if (!ms) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${h % 24}h`;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
function fmtMem(mb) { return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB"; }
// Wall-clock time of day, and the day itself — the player log is read by
// scrolling, so rows carry the time and the day is a heading between them.
function fmtClock(t) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function fmtDay(t) {
  const d = new Date(t), now = new Date();
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(d)) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
function fmtWhen(t) { return t ? fmtDay(t) + " " + fmtClock(t) : "—"; }
function fmtAgo(t) {
  if (!t) return "never";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  const d = Math.floor(s / 86400);
  return d < 30 ? d + "d ago" : new Date(t).toLocaleDateString();
}
// "in 4 min" — for something scheduled.
function fmtIn(t) {
  const d = Math.max(0, t - Date.now());
  if (d < 60000) return "in under a minute";
  if (d < 3600000) return `in ${Math.round(d / 60000)} min`;
  return `in ${Math.round(d / 3600000)} h`;
}
// Per-server avatar: the emoji from Settings if there is one, else an initial.
function srvIcon(s) { return s && s.icon ? esc(s.icon) : initialTile(s && s.name); }
// Fills the <span data-ico> placeholders in index.html's static markup.
function hydrateIcons(root = document) {
  $$("[data-ico]", root).forEach((el) => { el.innerHTML = ico(el.dataset.ico); el.removeAttribute("data-ico"); });
}
function fmtBytes(b) {
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < 3);
  return b.toFixed(b < 10 ? 1 : 0) + " " + u[i];
}
const STATUS_LABEL = {
  running: "Online", stopped: "Offline", starting: "Starting", stopping: "Stopping",
  installing: "Installing", "install-failed": "Install failed", crashed: "Crashed",
  paused: "Paused", asleep: "Sleeping",
};

// The two idle states ride alongside the real status rather than replacing it,
// so buttons and stream handling still key off s.status while every indicator
// paints the more useful one.
function viewStatus(s) {
  if (!s) return "stopped";
  if (s.paused) return "paused";
  if (s.asleep) return "asleep";
  return s.status;
}
const statusLabel = (s) => STATUS_LABEL[viewStatus(s)] || viewStatus(s);
// Every status leads with its own icon, so none of them is told apart by colour alone.
const STATUS_ICON = {
  running: "● ", stopped: "○ ", starting: "◌ ", stopping: "◌ ", installing: "◌ ",
  "install-failed": "⚠ ", crashed: "⚠ ", paused: "‖ ", asleep: "☾ ",
};
const statusDot = (s) => STATUS_ICON[viewStatus(s)] || "";

/*
 * Range inputs are painted by hand. Chrome keeps the unfilled half of a native
 * track light even under color-scheme: dark, which is the one control that
 * would still glow white in this theme — so the track is a gradient driven by
 * --fill, refreshed here whenever a slider moves or a new one is rendered.
 */
function paintRange(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--fill", pct.toFixed(2) + "%");
}
function paintRanges(root = document) { $$('input[type="range"]', root).forEach(paintRange); }
document.addEventListener("input", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type === "range") paintRange(e.target);
});

function toast(msg, kind = "") {
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.textContent = msg;
  $("#toast-root").appendChild(t);
  setTimeout(() => { t.style.opacity = "0"; t.style.transition = "opacity .3s"; setTimeout(() => t.remove(), 300); }, 3400);
}

// Clipboard access needs a secure context; the panel is plain http on
// localhost, which counts, but fall back to a prompt anywhere it doesn't.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied " + text, "ok");
  } catch {
    prompt("Copy this address:", text);
  }
}

// A modal that holds something open (an event stream) registers its teardown
// here; it runs when the modal closes or another one replaces it.
let modalCleanup = null;
function runModalCleanup() {
  const fn = modalCleanup;
  modalCleanup = null;
  if (fn) fn();
}

function modal(html, { wide = false } = {}) {
  runModalCleanup();
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? "wide" : ""}">${html}</div></div>`;
  const bg = $(".modal-bg", root);
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) closeModal(); });
  paintRanges(root);
  return root;
}
// The dialog fades out rather than vanishing (unless the device asks for
// less motion). Only that dialog goes: one opened meanwhile stays.
function closeModal() {
  runModalCleanup();
  const bg = $(".modal-bg", $("#modal-root"));
  if (!bg || lessMotion()) { $("#modal-root").innerHTML = ""; return; }
  if (bg.classList.contains("closing")) return;
  bg.classList.add("closing");
  bg.inert = true;
  setTimeout(() => bg.remove(), 140);
}

const lessMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Restarts the entrance animation `cls` on node (see "motion" in style.css).
function playIn(node, cls = "page-in") {
  if (!node || lessMotion()) return;
  clearTimeout(node.playTimer);
  node.classList.remove(cls);
  void node.offsetWidth; // so re-adding the class starts the animation over
  node.classList.add(cls);
  node.playTimer = setTimeout(() => node.classList.remove(cls), 400);
}

/* ------------------------------------------------------------- build badge */
/*
 * The panel has no version number — it is deployed by pulling main — so the
 * "version" is the newest heading in CHANGELOG.md, with the commit alongside it
 * as the exact build. Clicking the badge opens the changelog itself.
 */
function renderBuildBadge() {
  const el = $("#build-badge");
  if (!el) return;
  const b = state.build || {};
  if (!b.version && !b.commit) return; // no changelog and no .git — say nothing
  el.hidden = false;
  el.innerHTML =
    `<span class="bb-dot"></span>` +
    (b.version ? `<span>${esc(b.version)}</span>` : "") +
    (b.commit ? `<span class="bb-commit">${esc(b.commit)}</span>` : "");
  el.title =
    `MC Hoster${b.version ? " — " + b.version : ""}${b.commit ? " (" + b.commit + ")" : ""}` +
    `\nClick for the changelog`;
  el.onclick = openChangelog;
}

async function openChangelog() {
  modal(
    `<div class="modal-head"><h2>Changelog</h2><button class="modal-close">×</button></div>
     <div class="modal-body"><div class="cl" id="cl-body"><p class="muted"><span class="spinner"></span> Loading…</p></div></div>
     <div class="modal-foot"><span class="muted" id="cl-build"></span><button class="btn btn-primary" data-x>Close</button></div>`,
    { wide: true }
  );
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  try {
    const c = await API.get("/api/changelog");
    const body = $("#cl-body");
    if (!body) return; // the modal was closed while we were fetching
    body.innerHTML = c.text ? mdToHTML(c.text) : `<p class="muted">No CHANGELOG.md in this checkout.</p>`;
    // Flag the newest entry as the one this checkout is actually running.
    const first = $(".cl h2", body);
    if (first && c.version) first.innerHTML += ` <span class="cl-current">— you are here</span>`;
    const foot = $("#cl-build");
    if (foot) foot.textContent = c.commit ? `commit ${c.commit}` : "";
  } catch (e) {
    const body = $("#cl-body");
    if (body) body.innerHTML = `<p class="muted">Couldn't load the changelog: ${esc(e.message)}</p>`;
  }
}

/*
 * Just enough Markdown for CHANGELOG.md: headings, bullet lists, paragraphs,
 * bold, inline code and links. Everything is escaped up front, so the inline
 * pass only ever sees text — no HTML from the file can reach the page.
 */
function mdToHTML(md) {
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const out = [];
  let list = null; // items of the <ul> being built
  let para = null; // lines of the <p> being built

  const flushList = () => { if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; } };
  const flushPara = () => { if (para) { out.push(`<p>${inline(para.join(" "))}</p>`); para = null; } };
  const flush = () => { flushList(); flushPara(); };

  for (const raw of md.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { flush(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) { flushPara(); (list = list || []).push(`<li>${inline(li[1])}</li>`); continue; }
    if (!line.trim()) { flush(); continue; }
    // An indented line under a bullet continues it rather than starting a paragraph.
    if (list && /^\s+\S/.test(raw)) {
      list[list.length - 1] = list[list.length - 1].replace(/<\/li>$/, " " + inline(line.trim()) + "</li>");
      continue;
    }
    flushList();
    (para = para || []).push(line.trim());
  }
  flush();
  return out.join("");
}


async function confirmDialog(title, body, okText = "Confirm", danger = true) {
  return new Promise((resolve) => {
    modal(`
      <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">${body}</div>
      <div class="modal-foot"><span></span><div style="display:flex;gap:10px">
        <button class="btn btn-ghost" data-x>Cancel</button>
        <button class="btn ${danger ? "btn-red" : "btn-primary"}" data-ok>${esc(okText)}</button>
      </div></div>`);
    $(".modal-close").onclick = $("[data-x]").onclick = () => { closeModal(); resolve(false); };
    $("[data-ok]").onclick = () => { closeModal(); resolve(true); };
  });
}

/* -------------------------------------------------------------------- theme */
// Dark is the default; a light choice is remembered per browser. index.html
// applies it before first paint, this keeps the label and toolbar colour in step.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem("theme", theme); } catch {}
  $("#nav-theme-label").textContent = `Theme: ${theme}`;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "light" ? "#eef1f7" : "#1b1c1f";
}

/* ---------------------------------------------------------------- bootstrap */
async function boot() {
  // The shell in index.html carries data-ico placeholders; fill them before
  // anything else so the sidebar never flashes empty boxes.
  $("#brand-mark").innerHTML = '<img src="/icon.svg" alt="" />';
  hydrateIcons();
  applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
  $("#nav-theme").onclick = () =>
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

  try {
    const b = await API.get("/api/bootstrap");
    state.loaders = b.loaders;
    state.javas = b.javas;
    state.settings = b.settings;
    state.defaults = b.defaults || state.defaults;
    state.build = b.build || null;
    state.lan = b.lan || [];
    state.playit = b.playit || state.playit;
    state.sys = b.sys || null;
    b.servers.forEach((s) => state.servers.set(s.id, s));
  } catch (e) {
    view.innerHTML = `<div class="page"><div class="banner err">Failed to reach the backend: ${esc(e.message)}</div></div>`;
    return;
  }
  renderSidebar();
  renderBuildBadge();
  initSysmon();
  openGlobalStream();
  window.addEventListener("hashchange", route);
  route();

  $("#nav-create").onclick = () => { closeNav(); openCreateWizard(); };
  $("#nav-settings").onclick = () => { closeNav(); openSettings(); };
  // Phones: the sidebar is a drawer behind the top bar's menu button.
  $("#tb-menu").onclick = () => document.body.classList.toggle("nav-open");
  $("#scrim").onclick = closeNav;
  $(".sidebar .nav-item[data-route]").addEventListener("click", closeNav);
}

function closeNav() { document.body.classList.remove("nav-open"); }

// The phone top bar: where you are, and how many servers are up.
function paintTopbar() {
  const t = $("#tb-title"), sum = $("#tb-sum");
  if (!t) return;
  const s = state.route.name === "server" ? state.servers.get(state.route.id) : null;
  t.innerHTML = s ? `<span class="dot ${viewStatus(s)}"></span>${esc(s.name)}` : "MC&nbsp;Hoster";
  const all = [...state.servers.values()];
  const up = all.filter((x) => x.status === "running").length;
  sum.textContent = s ? (s.status === "running" ? `${(s.players || []).length}/${s.maxPlayers} on` : statusLabel(s)) : all.length ? `${up}/${all.length} online` : "";
}

/* ------------------------------------------------------------ global stream */
function openGlobalStream() {
  const es = new EventSource("/api/events");
  es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    handleGlobalEvent(e);
  };
  es.onerror = () => {}; // browser auto-reconnects
}

async function handleGlobalEvent(e) {
  if (e.type === "ping") return;
  // Resource samples arrive every couple of seconds — patch the meters in
  // place instead of falling through to a full sidebar/dashboard re-render.
  if (e.type === "sysmon") {
    state.sys = e.sys;
    paintSysmon();
    return;
  }
  if (e.type === "playit") {
    state.playit = e.playit;
    renderSidebar();
    if ($("#playit-section")) renderPlayitSection();
    if ($("#plc-out")) paintPlayitConsoleHead();
    if (state.route.name === "server" && $("#st-playit")) renderServerPlayit(state.route.id);
    // The account's UDP allowance rides this event and the voice section shows it.
    if (state.route.name === "server" && $("#st-vc-on")) renderServerVoice(state.route.id);
    return;
  }
  // Player-log records arrive for every chat line; only the open Players tab
  // cares, and a sidebar redraw per message would be silly.
  // Backup progress only matters to an open Backups tab; the finish is worth a
  // toast wherever you are, unless the scheduler made it and it went fine.
  if (e.type === "backup") {
    const r = e.result;
    if (r && (!r.ok || !r.auto)) {
      const name = (state.servers.get(e.id) || {}).name || "Server";
      toast(r.ok
        ? `${name}: ${r.kind === "restore" ? "backup restored" : "backup saved"}.`
        : `${name}: ${r.kind} failed — ${r.error}`, r.ok ? "ok" : "err");
    }
    if (state.route.name === "server" && state.route.id === e.id && state.activeTab === "backups") {
      paintBackupJob(e.job);
      if (r) loadBackups(e.id);
    }
    return;
  }
  if (e.type === "transfer") {
    onTransferEvent(e);
    return;
  }
  if (e.type === "playerlog") {
    if (state.route.name === "server" && state.route.id === e.id) patchServerLive(e);
    return;
  }
  if (e.type === "servers") {
    const { servers } = await API.get("/api/servers");
    state.servers = new Map(servers.map((s) => [s.id, s]));
    renderSidebar();
    if (state.route.name === "dashboard") renderDashboard();
    return;
  }
  const s = state.servers.get(e.id);
  if (!s && e.type === "status") { // newly seen
    state.servers.set(e.id, e);
  } else if (s) {
    if (e.type === "status") Object.assign(s, e);
    if (e.type === "players") s.players = e.players;
    if (e.type === "pings") s.pings = e.pings;
    if (e.type === "stats") { const { type, id, point, ...st } = e; s.stats = st; }
  }
  // Lag spikes only matter to an open Stats tab.
  if (e.type === "lag") {
    if (state.route.name === "server" && state.route.id === e.id) patchServerLive(e);
    return;
  }
  renderSidebar();
  if (state.route.name === "dashboard") renderDashboard();
  if (state.route.name === "server" && state.route.id === e.id) patchServerLive(e);
}

/* -------------------------------------------------------------------- router */
function route() {
  const h = location.hash.replace(/^#/, "") || "/";
  const from = state.route ? state.route.name + "/" + state.route.id : "";
  closeConsoleStream();
  if (h.startsWith("/server/")) {
    state.route = { name: "server", id: h.slice(8) };
    renderServer(h.slice(8));
  } else {
    state.route = { name: "dashboard", id: null };
    renderDashboard();
  }
  renderSidebar();
  // A new page comes in; a re-render of the same one doesn't.
  if (from && from !== state.route.name + "/" + state.route.id) playIn(view);
}
function go(hash) { location.hash = hash; }

/* ------------------------------------------------------------------ sidebar */
function renderSidebar() {
  const list = $("#server-list");
  const servers = [...state.servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML =
    servers.map((s) => `
      <div class="srv-mini ${state.route.id === s.id ? "active" : ""}" data-id="${s.id}">
        <span class="emoji">${srvIcon(s)}</span>
        <div class="meta">
          <div class="nm">${esc(s.name)}</div>
          <div class="sub">${esc(cap(s.loader))} · ${esc(s.mc || "")}</div>
        </div>
        <span class="dot ${viewStatus(s)}" title="${esc(statusLabel(s))}"></span>
      </div>`).join("") ||
    `<div class="players-empty" style="padding:8px 10px">No servers yet.</div>`;
  $$(".srv-mini", list).forEach((el) => (el.onclick = () => { closeNav(); go("#/server/" + el.dataset.id); }));
  paintTopbar();

  $$(".nav-item[data-route]").forEach((el) =>
    el.classList.toggle("active", state.route.name === "dashboard" && el.dataset.route === "dashboard"));

  // playit.gg status chip — only once the panel is actually using it
  const pchip = $("#playit-chip");
  if (pchip) {
    const pl = state.playit || {};
    if (pl.linked && pl.tunnels) {
      const dot = pl.agent === "online" ? "running" : pl.agent === "error" ? "crashed" : "starting";
      pchip.style.display = "flex";
      pchip.innerHTML = `<span class="dot ${dot}"></span> playit ${esc(PLAYIT_AGENT_LABEL[pl.agent] || pl.agent)}`;
      pchip.onclick = openPlayitConsole;
      pchip.title = "playit.gg agent — click for its console";
      pchip.style.cursor = "pointer";
    } else pchip.style.display = "none";
  }

  // Java status chip
  const chip = $("#java-chip");
  if (state.javas.length) {
    chip.innerHTML = `<span class="dot running"></span> Java ${esc(state.javas[0].version)} ready`;
  } else {
    chip.innerHTML = `<span class="dot crashed"></span> No Java found`;
    chip.style.cursor = "pointer";
    chip.onclick = openSettings;
  }
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

/* ----------------------------------------------------------- system monitor */
/* Host CPU / RAM / disk at a glance. lib/sysmon.js samples every couple of
 * seconds and pushes a `sysmon` event down the global stream; we patch the
 * existing nodes in place so the bars glide instead of flickering. The same
 * metric shape feeds the compact sidebar strip and the dashboard card. */

const SYS_KEYS = ["cpu", "mem", "disk"];
const SPARK_N = 90; // history length the backend keeps
const SPARK_W = 300, SPARK_H = 52;

const gb = (mb) => (mb / 1024).toFixed(1);
const meterState = (pct) => (pct >= 90 ? "hot" : pct >= 75 ? "warn" : "");

function sysMetrics() {
  const sys = state.sys;
  if (!sys) return null;
  return {
    cpu: {
      label: "CPU", pct: sys.cpu.pct, num: Math.round(sys.cpu.pct) + "%",
      sub: `${sys.host.cores} threads · ${(sys.host.speedMHz / 1000).toFixed(1)} GHz`,
    },
    mem: {
      label: "RAM", pct: sys.mem.pct, num: Math.round(sys.mem.pct) + "%",
      sub: `${gb(sys.mem.usedMB)} / ${gb(sys.mem.totalMB)} GB used`,
    },
    disk: sys.disk
      ? {
          label: "Disk", pct: sys.disk.pct, num: Math.round(sys.disk.pct) + "%",
          sub: `${fmtBytes(sys.disk.free)} free on ${sys.disk.drive}`,
        }
      : { label: "Disk", pct: 0, num: "—", sub: "unavailable" },
  };
}

// Shared markup for one meter: label + number on top, bar, detail underneath.
function meterHTML(idPrefix, k, cls) {
  return `<div class="${cls}" id="${idPrefix}-${k}">
      <div class="mtop"><span class="mlabel"></span><b class="mnum">—</b></div>
      <div class="mbar"><i></i></div>
      <div class="msub"></div>
    </div>`;
}

function initSysmon() {
  const box = $("#sysmon");
  if (!box) return;
  box.innerHTML = `<div class="sys-mini-label">System</div>` +
    SYS_KEYS.map((k) => meterHTML("sm", k, "meter")).join("");
  paintSysmon();
}

function sysCardHTML() {
  if (!state.sys) return "";
  const h = state.sys.host;
  return `
    <div class="card sys-card">
      <div class="sys-head">
        <div>
          <h3>System resources</h3>
          <p>${esc(h.model)} · ${h.cores} threads · ${esc(h.platform === "win32" ? "Windows" : h.platform)} · up ${fmtUptime(state.sys.uptime * 1000)}</p>
        </div>
        <div class="sys-legend"><span class="lg cpu">CPU</span><span class="lg mem">RAM</span></div>
      </div>
      <div class="sys-meters">${SYS_KEYS.map((k) => meterHTML("sc", k, "sys-meter")).join("")}</div>
      <div class="sys-graph">
        <svg id="sys-spark" class="spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">
          <polygon class="sp-fill" points="" />
          <polyline class="sp-cpu" points="" />
          <polyline class="sp-mem" points="" />
        </svg>
        <div class="sys-cores" id="sys-cores" title="Load per CPU thread"></div>
      </div>
      <div class="sys-foot" id="sys-foot"></div>
    </div>`;
}

function paintMeter(el, d) {
  if (!el) return;
  const set = (sel, txt) => { const n = $(sel, el); if (n) n.textContent = txt; };
  set(".mlabel", d.label);
  set(".mnum", d.num);
  set(".msub", d.sub);
  const bar = $(".mbar > i", el);
  if (bar) bar.style.width = d.pct + "%";
  el.classList.toggle("warn", meterState(d.pct) === "warn");
  el.classList.toggle("hot", meterState(d.pct) === "hot");
}

function paintSysmon() {
  const m = sysMetrics();
  if (!m) return;
  for (const k of SYS_KEYS) {
    paintMeter($("#sm-" + k), m[k]);
    paintMeter($("#sc-" + k), m[k]);
  }
  const box = $("#sysmon");
  if (box) box.title = `CPU ${m.cpu.num} · RAM ${m.mem.sub} · Disk ${m.disk.sub}`;
  paintSysGraph();
}

// Newest sample sits at the right edge, so the trace scrolls in like Task
// Manager's rather than stretching while the buffer fills.
function sparkPts(arr) {
  const step = SPARK_W / (SPARK_N - 1);
  return arr.map((v, i) => {
    const x = SPARK_W - (arr.length - 1 - i) * step;
    return `${x.toFixed(1)},${(SPARK_H - (v / 100) * SPARK_H).toFixed(1)}`;
  });
}

function paintSysGraph() {
  const sys = state.sys;
  if (!sys) return;

  const spark = $("#sys-spark");
  if (spark) {
    const cpu = sparkPts(sys.history.cpu);
    const mem = sparkPts(sys.history.mem);
    const baseline = cpu.length
      ? `${cpu[0].split(",")[0]},${SPARK_H} ${cpu.join(" ")} ${cpu[cpu.length - 1].split(",")[0]},${SPARK_H}`
      : "";
    $(".sp-fill", spark).setAttribute("points", baseline);
    $(".sp-cpu", spark).setAttribute("points", cpu.join(" "));
    $(".sp-mem", spark).setAttribute("points", mem.join(" "));
  }

  const cores = $("#sys-cores");
  if (cores) {
    if (cores.children.length !== sys.cpu.cores.length)
      cores.innerHTML = sys.cpu.cores.map(() => `<span class="core"><i></i></span>`).join("");
    sys.cpu.cores.forEach((p, i) => {
      const bar = cores.children[i].firstElementChild;
      bar.style.height = Math.max(4, p) + "%";
      bar.className = meterState(p);
    });
  }

  const foot = $("#sys-foot");
  if (foot) foot.innerHTML = allocHTML();
}

// What the panel itself has promised the JVMs, versus what the box actually
// has — over-committing RAM across servers is the classic way to swap-thrash.
function allocHTML() {
  const servers = [...state.servers.values()];
  const running = servers.filter((s) => s.status === "running");
  const allocMB = running.reduce((n, s) => n + (Number(s.memory) || 0), 0);
  const totalMB = state.sys ? state.sys.mem.totalMB : 0;
  if (!running.length)
    return `<span class="muted">No servers running · ${servers.length} configured</span>`;
  const over = totalMB && allocMB > totalMB * 0.8;
  return `<span class="muted">${running.length} server${running.length === 1 ? "" : "s"} running ·
      <b>${gb(allocMB)} GB</b> of ${gb(totalMB)} GB allocated to Minecraft</span>
    ${over ? `<span class="over">${ico("alert")} over-committed</span>` : ""}`;
}

/* ---------------------------------------------------------------- dashboard */
function renderDashboard() {
  const servers = [...state.servers.values()].sort((a, b) => a.name.localeCompare(b.name));
  const online = servers.filter((s) => s.status === "running").length;

  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>${servers.length} server${servers.length === 1 ? "" : "s"} · ${online} online</p>
        </div>
        <div style="display:flex;gap:10px">
          <button class="btn" id="dash-import" title="Bring in a server exported from MC Hoster">${ico("download")} Import</button>
          <button class="btn btn-primary" id="dash-create"><span class="ic">＋</span> Create Server</button>
        </div>
      </div>
      ${sysCardHTML()}
      ${servers.length ? `<div class="grid">${servers.map(cardHTML).join("")}</div>` : emptyHTML()}
    </div>`;

  paintSysmon();
  $("#dash-create").onclick = openCreateWizard;
  $("#dash-import").onclick = openImport;
  if (!servers.length) $("#empty-create") && ($("#empty-create").onclick = openCreateWizard);
  if (!servers.length) $("#empty-import") && ($("#empty-import").onclick = openImport);
  $$(".srv-card").forEach((el) => {
    el.onclick = (e) => { if (!e.target.closest("[data-act]")) go("#/server/" + el.dataset.id); };
  });
  $$("[data-act]").forEach((btn) => (btn.onclick = (e) => { e.stopPropagation(); quickAction(btn.dataset.id, btn.dataset.act); }));
  bindAddrChips();
}

function emptyHTML() {
  return `<div class="empty">
    <div class="big">${ico("cube")}</div>
    <h2>No servers yet</h2>
    <p>Spin up a vanilla or modded Minecraft server in a few clicks.</p>
    <button class="btn btn-primary" id="empty-create">${ico("plus")} Create your first server</button>
    <p class="empty-alt">Moving from another computer? <a href="javascript:void 0" id="empty-import">Import a server</a> exported from MC Hoster.</p>
  </div>`;
}

function cardHTML(s) {
  const busy = ["starting", "stopping", "installing"].includes(s.status);
  const primary = s.status === "running"
    ? `<button class="btn btn-sm btn-red" data-act="stop" data-id="${s.id}">${ico("stop")} Stop</button>`
    : `<button class="btn btn-sm btn-green" data-act="start" data-id="${s.id}" ${busy || s.status === "installing" ? "disabled" : ""}>${ico("play")} Start</button>`;
  return `
    <div class="card srv-card" data-id="${s.id}">
      <div class="srv-card-top">
        <div class="srv-card-emoji">${srvIcon(s)}</div>
        <div class="srv-card-title">
          <h3>${esc(s.name)}</h3>
          <div class="row">
            <span class="badge loader">${esc(cap(s.loader))}</span>
            <span class="badge mc">${esc(s.mc || "—")}</span>
          </div>
        </div>
        <span class="pill ${viewStatus(s)}">${statusDot(s)}${statusLabel(s)}</span>
      </div>
      <div class="srv-card-body">
        <div class="stat">RAM <b>${fmtMem(s.memory)}</b></div>
        <div class="stat">Port <b>${s.port}</b></div>
        <div class="stat">Players <b>${(s.players || []).length}/${s.maxPlayers}</b></div>
        ${s.status === "running" ? `<div class="stat">TPS <b class="tps-${(tpsState(s.stats && !s.stats.idle ? s.stats.tps : null, s.stats && s.stats.tpsTarget) || {}).cls || "none"}">${fmtTps(s.stats)}</b></div>` : ""}
      </div>
      <div class="srv-card-foot">
        ${s.playit && s.playit.enabled
          ? addrChipHTML(s.playit)
          : `<span class="muted mono" style="font-size:12px">localhost:${s.port}</span>`}
        ${primary}
      </div>
    </div>`;
}

async function quickAction(id, act) {
  try {
    await API.post(`/api/servers/${id}/${act}`);
  } catch (e) { toast(e.message, "err"); }
}

/* ============================================================ CREATE WIZARD */
async function openCreateWizard() {
  const wiz = { step: 1, loader: null, mc: null, build: null, showSnapshots: false, mcList: [], buildList: [], javaReq: null };

  modal(`
    <div class="modal-head"><h2>Create a Server</h2><button class="modal-close">×</button></div>
    <div class="modal-body" id="wiz-body"></div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="wiz-back" style="visibility:hidden">← Back</button>
      <button class="btn btn-primary" id="wiz-next" disabled>Next →</button>
    </div>`, { wide: true });
  $(".modal-close").onclick = closeModal;

  const body = $("#wiz-body"), back = $("#wiz-back"), next = $("#wiz-next");

  function stepsBar() {
    return `<div class="steps">${[1, 2, 3].map((n) => `<div class="step ${wiz.step >= n ? "done" : ""}"></div>`).join("")}</div>`;
  }

  function renderStep() {
    back.style.visibility = wiz.step > 1 ? "visible" : "hidden";
    if (wiz.step === 1) renderLoaderStep();
    else if (wiz.step === 2) (isPack() ? renderPackStep : renderVersionStep)();
    else renderDetailsStep();
  }

  const isPack = () => (state.loaders.find((l) => l.id === wiz.loader) || {}).kind === "pack";

  function renderLoaderStep() {
    next.textContent = "Next →";
    next.disabled = !wiz.loader;
    body.innerHTML = stepsBar() + `
      <p class="muted" style="margin:0 0 16px">Pick what powers your server. <b>Fabric, Forge, NeoForge &amp; Quilt</b> run mods; Paper &amp; Purpur run plugins; a <b>Modrinth modpack</b> brings its own loader and mods with it.</p>
      <div class="loader-grid">
        ${state.loaders.map((l) => `
          <button class="loader-opt ${wiz.loader === l.id ? "sel" : ""}" data-l="${l.id}">
            <span class="li">${loaderTile(l.id, 26)}</span>
            <span class="ltxt">
              <strong>${esc(l.label)}</strong>
              <span class="kind ${l.kind}">${KIND_LABEL[l.kind] || l.kind}</span>
              <p>${esc(l.blurb)}</p>
            </span>
          </button>`).join("")}
      </div>`;
    $$(".loader-opt", body).forEach((el) => (el.onclick = () => {
      wiz.loader = el.dataset.l; wiz.mc = null; wiz.build = null; wiz.pack = null;
      renderLoaderStep();
    }));
  }

  async function renderVersionStep() {
    const loader = state.loaders.find((l) => l.id === wiz.loader);
    next.disabled = true;
    body.innerHTML = stepsBar() + `
      <div class="form-row">
        <label>Minecraft version — <span class="mono" style="color:var(--accent-text)">${esc(loader.label)}</span></label>
        <div id="mc-area"><span class="spinner"></span> <span class="muted">Fetching versions…</span></div>
        ${wiz.loader === "vanilla" || wiz.loader === "fabric" || wiz.loader === "quilt"
          ? `<label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-weight:400;cursor:pointer"><input type="checkbox" id="snap" style="width:auto" ${wiz.showSnapshots ? "checked" : ""}> Show snapshots / pre-releases</label>` : ""}
      </div>
      <div class="form-row" id="build-row" style="display:none">
        <label>${loaderVersionLabel(wiz.loader)}</label>
        <div id="build-area"></div>
      </div>
      <div id="java-req"></div>`;
    const snap = $("#snap"); if (snap) snap.onchange = () => { wiz.showSnapshots = snap.checked; wiz.mc = null; fillMc(); };
    await fillMc();
  }

  /* Modpacks don't fit the loader/version/build shape — you pick a pack first,
   * and the pack decides the Minecraft version and modloader. So step 2 becomes
   * a Modrinth search instead of two dropdowns. */
  async function renderPackStep() {
    next.disabled = !wiz.build;
    body.innerHTML = stepsBar() + `
      <div class="pk-bar">
        <input type="text" id="pk-q" placeholder="Search Modrinth modpacks…" value="${esc(wiz.packQuery || "")}" autocomplete="off" />
        <select id="pk-sort" style="width:auto;min-width:140px">
          ${[["relevance", "Best match"], ["downloads", "Most downloads"], ["follows", "Most followed"], ["updated", "Recently updated"]]
            .map(([v, l]) => `<option value="${v}" ${(wiz.packSort || "downloads") === v ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      <div class="pk-list" id="pk-list"></div>
      <div class="form-row" id="pk-ver-row" style="display:${wiz.pack ? "block" : "none"};margin-top:14px">
        <label>Pack version</label>
        <div id="pk-ver"></div>
      </div>
      <div id="java-req"></div>`;

    const q = $("#pk-q"), sort = $("#pk-sort");
    let timer = null;
    q.oninput = () => { clearTimeout(timer); timer = setTimeout(runSearch, 350); };
    q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); runSearch(); } };
    sort.onchange = runSearch;
    await runSearch();
    if (wiz.pack) await loadPackVersions();
  }

  async function runSearch() {
    const list = $("#pk-list");
    if (!list) return;
    wiz.packQuery = $("#pk-q").value.trim();
    wiz.packSort = $("#pk-sort").value;
    list.innerHTML = `<div class="pk-empty"><span class="spinner"></span> Searching Modrinth…</div>`;
    try {
      const r = await API.get(`/api/modrinth/search?type=modpack&limit=24&sort=${encodeURIComponent(wiz.packSort)}&q=${encodeURIComponent(wiz.packQuery)}`);
      if (!r.hits.length) { list.innerHTML = `<div class="pk-empty">No modpacks matched “${esc(wiz.packQuery)}”.</div>`; return; }
      list.innerHTML = r.hits.map((h) => projectRowHTML(h, wiz.pack && wiz.pack.id === h.id)).join("");
      $$(".pk-row", list).forEach((el) => (el.onclick = () => {
        const p = r.hits.find((h) => h.id === el.dataset.id);
        wiz.pack = p; wiz.build = null; wiz.mc = null;
        next.disabled = true;
        $$(".pk-row", list).forEach((x) => x.classList.toggle("sel", x.dataset.id === p.id));
        loadPackVersions();
      }));
    } catch (e) {
      list.innerHTML = `<div class="banner err" style="margin:0">Couldn't reach Modrinth: ${esc(e.message)}</div>`;
    }
  }

  async function loadPackVersions() {
    const row = $("#pk-ver-row"), area = $("#pk-ver");
    if (!row || !wiz.pack) return;
    row.style.display = "block";
    area.innerHTML = `<span class="spinner"></span> <span class="muted">Loading versions of ${esc(wiz.pack.title)}…</span>`;
    try {
      const { versions } = await API.get(`/api/modrinth/versions?project=${encodeURIComponent(wiz.pack.slug || wiz.pack.id)}`);
      if (!versions.length) { area.innerHTML = `<div class="muted">This pack has no published versions.</div>`; return; }
      area.innerHTML = `<select id="pk-vsel">${versions.slice(0, 200).map((v, i) =>
        `<option value="${esc(v.id)}">${esc(v.number)} · MC ${esc(v.gameVersions[0] || "?")} · ${esc(v.loaders[0] || "?")}${v.type !== "release" ? " · " + esc(v.type) : ""}${i === 0 ? " · latest" : ""}</option>`).join("")}</select>`;
      const sel = $("#pk-vsel");
      const apply = () => {
        const v = versions.find((x) => x.id === sel.value);
        wiz.build = v.id;
        wiz.mc = v.gameVersions[0] || null;
        wiz.packVersion = v;
        next.disabled = !wiz.mc;
        refreshJavaReq();
      };
      sel.onchange = apply;
      apply();
    } catch (e) {
      area.innerHTML = `<div class="banner err" style="margin:0">${esc(e.message)}</div>`;
    }
  }

  async function fillMc() {
    const area = $("#mc-area");
    try {
      if (!wiz._mcCache || wiz._mcCache.loader !== wiz.loader) {
        const { versions } = await API.get(`/api/loaders/${wiz.loader}/mc`);
        wiz._mcCache = { loader: wiz.loader, versions };
      }
      let versions = wiz._mcCache.versions;
      if (!wiz.showSnapshots) versions = versions.filter((v) => v.type === "release");
      if (!versions.length) versions = wiz._mcCache.versions;
      area.innerHTML = `<select id="mc-sel">${versions.slice(0, 400).map((v) =>
        `<option value="${esc(v.id)}" ${wiz.mc === v.id ? "selected" : ""}>${esc(v.id)}${v.type !== "release" ? " · " + v.type : ""}</option>`).join("")}</select>`;
      const sel = $("#mc-sel");
      wiz.mc = wiz.mc || sel.value;
      sel.onchange = () => { wiz.mc = sel.value; wiz.build = null; maybeBuilds(); refreshJavaReq(); };
      await maybeBuilds();
      refreshJavaReq();
    } catch (e) {
      area.innerHTML = `<div class="banner err" style="margin:0">Couldn't load versions: ${esc(e.message)}</div>`;
    }
  }

  // Each Minecraft version pins a Java major (26.x needs 25, 1.20.4 needs 17…).
  // Surface that here so a mismatch is caught before the server is created,
  // rather than as an UnsupportedClassVersionError on first start.
  async function refreshJavaReq() {
    const box = $("#java-req");
    if (!box || !wiz.mc) return;
    box.innerHTML = `<div class="hint"><span class="spinner"></span> Checking Java…</div>`;
    try {
      const r = await API.get(`/api/java/required?mc=${encodeURIComponent(wiz.mc)}`);
      if (wiz.mc !== r.mc) return; // a newer request won
      wiz.javaReq = r;
      box.innerHTML = r.ok
        ? `<div class="hint">${ico("coffee")} Minecraft ${esc(r.mc)} needs <b>Java ${r.required}</b> — will run on Java ${esc(r.java.version)}.</div>`
        : `<div class="hint" style="color:var(--warning)">${ico("coffee")} Minecraft ${esc(r.mc)} needs <b>Java ${r.required}</b>, which isn't on this machine.
             MC Hoster will download Eclipse Temurin ${r.required} automatically (~45 MB, once).
             <button class="btn btn-sm" id="java-now" style="margin-left:6px">Get it now</button></div>`;
      const btn = $("#java-now");
      if (btn)
        btn.onclick = async () => {
          btn.disabled = true;
          btn.textContent = "Downloading…";
          try {
            const out = await API.post("/api/java/install", { major: r.required });
            state.javas = out.javas;
            renderSidebar();
            refreshJavaReq();
          } catch (e) {
            btn.textContent = "Failed — " + e.message;
          }
        };
    } catch {
      box.innerHTML = "";
    }
  }

  async function maybeBuilds() {
    const loader = state.loaders.find((l) => l.id === wiz.loader);
    const row = $("#build-row"), area = $("#build-area");
    if (!loader.needsBuild) { row.style.display = "none"; wiz.build = null; next.disabled = !wiz.mc; return; }
    row.style.display = "block";
    area.innerHTML = `<span class="spinner"></span> <span class="muted">Loading builds…</span>`;
    next.disabled = true;
    try {
      const { builds } = await API.get(`/api/loaders/${wiz.loader}/builds?mc=${encodeURIComponent(wiz.mc)}`);
      if (!builds.length) { area.innerHTML = `<div class="muted">No builds available for this version.</div>`; return; }
      area.innerHTML = `<select id="build-sel">${builds.slice(0, 300).map((b, i) =>
        `<option value="${esc(b.id)}">${esc(b.id)}${i === 0 ? " · latest" : ""}</option>`).join("")}</select>`;
      const sel = $("#build-sel");
      wiz.build = sel.value;
      sel.onchange = () => (wiz.build = sel.value);
      next.disabled = false;
    } catch (e) {
      area.innerHTML = `<div class="banner err" style="margin:0">Couldn't load builds: ${esc(e.message)}</div>`;
    }
  }

  function renderDetailsStep() {
    next.textContent = "Create Server";
    next.disabled = false;
    const defMem = state.settings.defaultMemory || 4096;
    body.innerHTML = stepsBar() + `
      <div class="form-row">
        <label>Server name</label>
        <input type="text" id="d-name" placeholder="${esc(defaultName())}" value="${esc(defaultName())}" />
      </div>
      <div class="two-col">
        <div class="form-row">
          <label>Game port</label>
          <input type="number" id="d-port" value="${suggestPort()}" min="1024" max="65535" />
          <div class="hint">Players connect to <span class="mono">localhost:&lt;port&gt;</span></div>
        </div>
        <div class="form-row">
          <label>Max players</label>
          <input type="number" id="d-max" value="20" min="1" max="200" />
        </div>
      </div>
      <div class="form-row">
        <label>Memory (RAM)</label>
        <div class="range-row">
          <input type="range" id="d-mem" min="1024" max="16384" step="512" value="${defMem}" />
          <span class="range-val" id="d-memv">${fmtMem(defMem)}</span>
        </div>
        <div class="hint">${loaderMemHint(wiz.loader)}</div>
      </div>
      <div class="summary-box muted" style="font-size:12.5px;background:var(--surface-sunken);border:1px solid var(--hairline);border-radius:8px;padding:12px">
        ${wiz.pack
          ? `${ico("box")} <b style="color:var(--ink)">${esc(wiz.pack.title)}</b> ${esc(wiz.packVersion ? wiz.packVersion.number : "")} · Minecraft <b style="color:var(--ink)">${esc(wiz.mc)}</b> · ${esc((wiz.packVersion && wiz.packVersion.loaders[0]) || "")}
             <div style="margin-top:6px">Its mods and configs are downloaded during setup — client-only mods are left out.</div>`
          : `<b style="color:var(--ink)">${esc(cap(wiz.loader))}</b> · Minecraft <b style="color:var(--ink)">${esc(wiz.mc)}</b>${wiz.build ? ` · build <b style="color:var(--ink)">${esc(wiz.build)}</b>` : ""}`}
        ${wiz.javaReq
          ? wiz.javaReq.ok
            ? `<div style="margin-top:8px">${ico("coffee")} Java ${wiz.javaReq.required} · using ${esc(wiz.javaReq.java.version)}</div>`
            : `<div style="color:var(--warning);margin-top:8px">${ico("coffee")} Needs Java ${wiz.javaReq.required} — MC Hoster will download Eclipse Temurin ${wiz.javaReq.required} during setup.</div>`
          : ""}
      </div>`;
    const mem = $("#d-mem");
    paintRange(mem);
    mem.oninput = () => ($("#d-memv").textContent = fmtMem(Number(mem.value)));
  }

  function defaultName() {
    return wiz.pack ? wiz.pack.title : `My ${cap(wiz.loader)} Server`;
  }

  function suggestPort() {
    const used = new Set([...state.servers.values()].map((s) => s.port));
    let p = 25565; while (used.has(p)) p++;
    return p;
  }

  back.onclick = () => { if (wiz.step > 1) { wiz.step--; renderStep(); } };
  next.onclick = async () => {
    if (wiz.step === 1) { wiz.step = 2; renderStep(); return; }
    if (wiz.step === 2) { wiz.step = 3; renderStep(); return; }
    // create
    const spec = {
      loader: wiz.loader, mc: wiz.mc, build: wiz.build,
      name: $("#d-name").value.trim() || defaultName(),
      port: Number($("#d-port").value), maxPlayers: Number($("#d-max").value),
      memory: Number($("#d-mem").value),
    };
    try {
      next.disabled = true;
      const { server } = await API.post("/api/servers", spec);
      state.servers.set(server.id, server);
      closeModal();
      toast(`Creating “${server.name}” — installing…`, "ok");
      go("#/server/" + server.id);
    } catch (e) { toast(e.message, "err"); next.disabled = false; }
  };

  renderStep();
}

const KIND_LABEL = { mod: "modloader", pack: "modpack", plugin: "plugin", vanilla: "vanilla" };
function loaderVersionLabel(id) {
  return { fabric: "Fabric loader version", quilt: "Quilt loader version", forge: "Forge build", neoforge: "NeoForge build" }[id] || "Build";
}
function loaderMemHint(id) {
  if (id === "modrinth") return "Big packs want 6–8 GB; small optimisation packs are happy with 4.";
  if (id === "vanilla") return "2–4 GB is plenty for vanilla.";
  if (id === "paper" || id === "purpur") return "3–6 GB depending on plugins and players.";
  return "Modded servers are hungry — 4–8 GB for most packs, more for big ones.";
}

/* ============================================================= SERVER VIEW */
async function renderServer(id) {
  let data;
  try {
    data = await API.get(`/api/servers/${id}`);
  } catch (e) {
    view.innerHTML = `<div class="page"><div class="banner err">${esc(e.message)}</div><a href="#/" class="btn">← Back</a></div>`;
    return;
  }
  state.servers.set(id, data.server);
  const s = data.server, def = data.def;

  view.innerHTML = `
    <div class="page">
      <div class="srv-header">
        <div class="emoji">${srvIcon(s)}</div>
        <div>
          <h1>${esc(s.name)}</h1>
          <div class="row">
            <span class="pill ${viewStatus(s)}" id="srv-pill">${statusDot(s)}${statusLabel(s)}</span>
            <span class="badge loader">${esc(cap(s.loader))}</span>
            <span class="badge mc">${esc(s.mc || "")}</span>
            ${s.modLoader ? `<span class="badge loader">${esc(cap(s.modLoader))}</span>` : ""}
            ${s.pack ? `<span class="badge mc" title="Modrinth modpack">${ico("box")} ${esc(s.pack.versionNumber || "")}</span>` : s.build ? `<span class="badge">${esc(s.build)}</span>` : ""}
            <span class="badge mono" title="Local connect address">localhost:${s.port}</span>
            <span id="srv-addr">${addrChipHTML(s.playit)}</span>
          </div>
        </div>
        <div class="srv-actions" id="srv-actions"></div>
      </div>

      <div id="eula-slot"></div>

      <div class="statbar">
        <div class="stat-tile"><span class="label">Status</span><span class="value" id="t-status">${statusLabel(s)}</span></div>
        <div class="stat-tile"><span class="label">Uptime</span><span class="value" id="t-uptime">${fmtUptime(s.startedAt ? Date.now() - s.startedAt : 0)}</span></div>
        <div class="stat-tile">
          <span class="label">Memory</span>
          <span class="value" id="t-mem">${s.stats?.memMB ? fmtMem(s.stats.memMB) : "—"} <small>/ ${fmtMem(s.memory)}</small></span>
          <div class="bar"><i id="t-membar" style="width:${s.stats?.memMB ? Math.min(100, (s.stats.memMB / s.memory) * 100) : 0}%"></i></div>
        </div>
        <div class="stat-tile"><span class="label">Players</span><span class="value" id="t-players">${(s.players || []).length} <small>/ ${s.maxPlayers}</small></span></div>
        <div class="stat-tile" title="Ticks per second — 20 means the server is keeping up"><span class="label">TPS</span><span class="value" id="t-tps">${tpsTileHTML(s)}</span></div>
        <div class="stat-tile" title="Share of the whole machine this server is using"><span class="label">CPU</span><span class="value" id="t-cpu">${cpuTileHTML(s)}</span></div>
      </div>

      <div class="tabs" id="tabs">
        <div class="tab" data-tab="console">Console</div>
        <div class="tab" data-tab="stats">Stats</div>
        <div class="tab" data-tab="players">Players</div>
        <div class="tab" data-tab="content">${esc(s.content ? s.content.noun : "Mods")}</div>
        <div class="tab" data-tab="files">Files</div>
        <div class="tab" data-tab="backups">Backups</div>
        <div class="tab" data-tab="properties">Properties</div>
        <div class="tab" data-tab="settings">Settings</div>
      </div>
      <div id="tab-body"></div>
    </div>`;

  renderActions(s);
  renderEula(s);
  bindAddrChips();
  $$("#tabs .tab").forEach((t) => (t.onclick = () => selectTab(id, t.dataset.tab)));
  selectTab(id, TABS.includes(state.activeTab) ? state.activeTab : "console");

  // live uptime ticker
  if (renderServer._timer) clearInterval(renderServer._timer);
  renderServer._timer = setInterval(() => {
    const cur = state.servers.get(id);
    if (!cur || state.route.id !== id) return clearInterval(renderServer._timer);
    const u = $("#t-uptime");
    if (u && cur.startedAt) u.textContent = fmtUptime(Date.now() - cur.startedAt);
    const rs = $("#restart-secs");
    if (rs && (cur.restartAt || cur.lagRestartAt)) rs.textContent = restartSecs(cur);
    const ss = $("#sched-secs");
    if (ss && cur.schedStopAt) ss.textContent = fmtCountdown(cur.schedStopAt);
    if (state.activeTab === "stats") perfPaintSession(id);
  }, 1000);
}

function renderActions(s) {
  const box = $("#srv-actions");
  if (!box) return;
  const running = s.status === "running";
  const busy = ["starting", "stopping", "installing"].includes(s.status);
  box.innerHTML = `
    ${running || s.status === "starting"
      ? `<button class="btn btn-red" data-a="stop">${ico("stop")} Stop</button>
         <button class="btn" data-a="restart">${ico("rotate")} Restart</button>`
      : `<button class="btn btn-green" data-a="start" ${busy ? "disabled" : ""}>${ico("play")} Start</button>`}
    ${running || s.status === "starting" ? `<button class="btn btn-ghost btn-icon" data-a="kill" title="Force kill">${ico("bolt")}</button>` : ""}
    <button class="btn btn-ghost btn-icon" data-a="duplicate" title="Duplicate this server" aria-label="Duplicate this server"
      ${["installing", "install-failed"].includes(s.status) ? "disabled" : ""}>${ico("copy")}</button>
  `;
  $$("[data-a]", box).forEach((b) => (b.onclick = () => (b.dataset.a === "duplicate" ? openDuplicate(s.id) : serverAction(s.id, b.dataset.a))));
}

function renderEula(s) {
  const slot = $("#eula-slot");
  if (!slot) return;
  if (s.status === "installing") {
    slot.innerHTML = `<div class="banner warn"><span class="spinner"></span> Installing server files… watch the console below for progress.</div>`;
  } else if (s.status === "install-failed") {
    slot.innerHTML = `<div class="banner err">${ico("alert")} Installation failed. Check the console for details — you can delete this server in Settings and try again.</div>`;
  } else if (s.restartAt || s.lagRestartAt) {
    const crash = s.status === "crashed" && s.restartAt;
    slot.innerHTML = `<div class="banner warn">
      <span class="spinner"></span>
      <div>${crash ? "The server crashed. Restarting automatically" : "TPS has stayed low. Restarting to recover"} in <b id="restart-secs">${restartSecs(s)}</b>s.</div>
      <div class="b-actions"><button class="btn btn-sm" id="cancel-restart">Cancel</button></div>
    </div>`;
    $("#cancel-restart").onclick = async () => {
      try { await API.post(`/api/servers/${s.id}/cancel-restart`); toast("Restart cancelled.", "ok"); }
      catch (e) { toast(e.message, "err"); }
    };
  } else if (s.schedStopAt || s.schedWaiting) {
    slot.innerHTML = `<div class="banner warn">
      <span>${ico("clock")}</span>
      <div>${s.schedStopAt
        ? `Scheduled hours are over. Stopping in <b id="sched-secs">${fmtCountdown(s.schedStopAt)}</b> — players have been warned.`
        : "Scheduled hours are over. The server stops once the last player leaves."}</div>
      <div class="b-actions"><button class="btn btn-sm" id="cancel-sched">Keep it running</button></div>
    </div>`;
    $("#cancel-sched").onclick = async () => {
      try { await API.post(`/api/servers/${s.id}/cancel-restart`); toast("It stays up until the next closing time.", "ok"); }
      catch (e) { toast(e.message, "err"); }
    };
  } else if (s.crashGaveUp) {
    slot.innerHTML = `<div class="banner err">${ico("alert")} This server crashed 3 times in 10 minutes, so it won't be restarted again automatically. Check the console for the cause, then press Start.</div>`;
  } else if (!s.eula) {
    slot.innerHTML = `<div class="banner warn">
      <span>${ico("file")}</span>
      <div>You must accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" style="color:inherit;text-decoration:underline">Minecraft EULA</a> before starting this server.</div>
      <div class="b-actions"><button class="btn btn-sm btn-primary" id="accept-eula">Accept EULA</button></div>
    </div>`;
    $("#accept-eula").onclick = async () => {
      try { await API.post(`/api/servers/${s.id}/eula`, { accepted: true }); toast("EULA accepted.", "ok"); }
      catch (e) { toast(e.message, "err"); }
    };
  } else slot.innerHTML = "";
}

const restartSecs = (s) => Math.max(0, Math.ceil(((s.restartAt || s.lagRestartAt) - Date.now()) / 1000));
const fmtCountdown = (at) => {
  const left = Math.max(0, Math.ceil((at - Date.now()) / 1000));
  return left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : left + "s";
};

async function serverAction(id, act) {
  try {
    if (act === "kill" && !(await confirmDialog("Force kill?", "<p class='muted'>This hard-kills the process without saving the world. Use only if it's stuck.</p>", "Force kill"))) return;
    await API.post(`/api/servers/${id}/${act === "kill" ? "stop?force=1" : act}`);
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------- tab switching */
const TABS = ["console", "stats", "players", "content", "files", "backups", "properties", "settings"];
function selectTab(id, tab) {
  state.activeTab = tab;
  $$("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  closeConsoleStream();
  if (tab === "console") renderConsoleTab(id);
  else if (tab === "stats") renderStatsTab(id);
  else if (tab === "players") renderPlayersTab(id);
  else if (tab === "content") renderContentTab(id);
  else if (tab === "files") renderFilesTab(id);
  else if (tab === "backups") renderBackupsTab(id);
  else if (tab === "properties") renderPropertiesTab(id);
  else if (tab === "settings") renderSettingsTab(id);
}

/* --------------------------------------------------------------- console tab */
function renderConsoleTab(id) {
  const s = state.servers.get(id);
  const bodyEl = $("#tab-body");
  bodyEl.innerHTML = `
    <div class="console-wrap">
      <div class="console">
        <div class="console-head">
          <span class="t"><span class="dot ${viewStatus(s)}"></span> Console</span>
          <button class="btn btn-sm btn-ghost" id="con-clear">Clear</button>
        </div>
        <div class="console-out" id="con-out"></div>
        <div class="console-in">
          <span>&gt;</span>
          <input id="con-in" placeholder="Type a command (e.g. say hello, op &lt;name&gt;, stop)…" autocomplete="off" ${s.status === "running" ? "" : "disabled"} />
        </div>
      </div>
      <div class="side-panel">
        <div class="players-box">
          <h4>Players <span id="pl-count">${(s.players || []).length}/${s.maxPlayers}</span></h4>
          <div id="pl-list"></div>
        </div>
        <div class="players-box">
          <h4>Quick commands <button class="qc-edit" id="qc-edit" title="Customise these buttons">✎ Edit</button></h4>
          <div id="qc-box">${quickCommandsHTML()}</div>
        </div>
      </div>
    </div>`;

  const out = $("#con-out");
  renderPlayers(s);

  const inp = $("#con-in");
  const history = []; let hi = -1;
  inp.onkeydown = async (e) => {
    if (e.key === "Enter" && inp.value.trim()) {
      const cmd = inp.value.trim();
      history.unshift(cmd); hi = -1; inp.value = "";
      try { await API.post(`/api/servers/${id}/command`, { cmd }); } catch (err) { toast(err.message, "err"); }
    } else if (e.key === "ArrowUp" && history.length) { hi = Math.min(hi + 1, history.length - 1); inp.value = history[hi]; }
    else if (e.key === "ArrowDown") { hi = Math.max(hi - 1, -1); inp.value = hi < 0 ? "" : history[hi]; }
  };
  bindQuickCommands(id);
  $("#con-clear").onclick = () => (out.innerHTML = "");

  openServerStream(id, (e, s) => {
    if (e.type === "console") appendConsole(out, e.stream, e.line);
    else if (e.type === "players" || e.type === "pings") { if (s) renderPlayers(s); }
    else if (e.type === "status") {
      const inp = $("#con-in"); if (inp) inp.disabled = e.status !== "running";
      const dot = $(".console-head .dot"); if (dot) dot.className = "dot " + viewStatus(e);
    }
  });
}

/* ------------------------------------------------------- quick commands */
/* One list, kept in global settings, shown beside every server's console —
 * `label` is optional and the button falls back to the command itself. */

function quickCommands() {
  const list = state.settings.quickCommands;
  return Array.isArray(list) ? list : state.defaults.quickCommands || [];
}

function quickCommandsHTML() {
  const list = quickCommands();
  if (!list.length) return `<div class="players-empty">No quick commands — add some with Edit.</div>`;
  return `<div class="qc-list">${list.map((q) =>
    `<button class="btn btn-sm btn-ghost qc-btn" data-cmd="${esc(q.cmd)}" title="${esc(q.cmd)}">${esc(q.label || q.cmd)}</button>`).join("")}</div>`;
}

function bindQuickCommands(id) {
  $$("#qc-box [data-cmd]").forEach((b) => (b.onclick = async () => {
    try { await API.post(`/api/servers/${id}/command`, { cmd: b.dataset.cmd }); } catch (e) { toast(e.message, "err"); }
  }));
  $("#qc-edit").onclick = () => openQuickCommandsEditor(() => {
    $("#qc-box").innerHTML = quickCommandsHTML();
    bindQuickCommands(id);
  });
}

function openQuickCommandsEditor(onSaved) {
  let rows = quickCommands().map((q) => ({ label: q.label || "", cmd: q.cmd }));

  modal(`
    <div class="modal-head"><h2>✎ Quick commands</h2><button class="modal-close">×</button></div>
    <div class="modal-body">
      <p class="hint" style="margin-top:0">These buttons sit next to every server's console and send the command straight to it. The label is optional — leave it blank and the button shows the command itself.</p>
      <div id="qc-rows"></div>
      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        <button class="btn btn-sm" id="qc-add">+ Add command</button>
        <button class="btn btn-sm btn-ghost" id="qc-reset">↺ Reset to defaults</button>
      </div>
    </div>
    <div class="modal-foot"><span></span><div style="display:flex;gap:10px">
      <button class="btn btn-ghost" data-x>Cancel</button>
      <button class="btn btn-primary" id="qc-save">Save</button>
    </div></div>`);
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;

  // The inputs are the live copy while the modal is open, so pull them back
  // into `rows` before anything that redraws the list.
  const sync = () => $$("#qc-rows .qc-row").forEach((el, i) => {
    rows[i] = { label: $(".qc-label", el).value, cmd: $(".qc-cmd", el).value };
  });

  const draw = () => {
    $("#qc-rows").innerHTML = rows.length
      ? rows.map((q, i) => `
        <div class="qc-row">
          <input type="text" class="qc-label" placeholder="Label (optional)" maxlength="40" value="${esc(q.label)}" />
          <input type="text" class="qc-cmd mono" placeholder="say hello" maxlength="256" value="${esc(q.cmd)}" />
          <button class="btn btn-sm btn-ghost btn-icon" data-up title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
          <button class="btn btn-sm btn-ghost btn-icon" data-down title="Move down" ${i === rows.length - 1 ? "disabled" : ""}>↓</button>
          <button class="btn btn-sm btn-ghost btn-icon qc-del" data-del title="Remove">×</button>
        </div>`).join("")
      : `<p class="muted" style="margin:0">Nothing here yet — add a command below.</p>`;

    $$("#qc-rows .qc-row").forEach((el, i) => {
      const move = (j) => { sync(); rows.splice(j, 0, rows.splice(i, 1)[0]); draw(); };
      $("[data-up]", el).onclick = () => move(i - 1);
      $("[data-down]", el).onclick = () => move(i + 1);
      $("[data-del]", el).onclick = () => { sync(); rows.splice(i, 1); draw(); };
      $$("input", el).forEach((inp) => (inp.onkeydown = (e) => { if (e.key === "Enter") $("#qc-save").click(); }));
    });
  };
  draw();

  $("#qc-add").onclick = () => {
    sync(); rows.push({ label: "", cmd: "" }); draw();
    $$("#qc-rows .qc-cmd").pop()?.focus();
  };
  $("#qc-reset").onclick = () => {
    rows = (state.defaults.quickCommands || []).map((q) => ({ label: q.label || "", cmd: q.cmd }));
    draw();
  };
  $("#qc-save").onclick = async () => {
    sync();
    const list = rows.map((q) => ({ label: q.label.trim(), cmd: q.cmd.trim() })).filter((q) => q.cmd);
    try {
      state.settings = await API.put("/api/settings", { quickCommands: list });
      closeModal();
      toast("Quick commands saved.", "ok");
      onSaved?.();
    } catch (e) { toast(e.message, "err"); }
  };
}

function appendConsole(out, stream, line) {
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  const div = document.createElement("div");
  div.className = "ln " + (stream === "err" ? "err" : stream === "sys" ? "sys" : "");
  let html = esc(line);
  if (stream === "out") html = html.replace(/\b(WARN|WARNING)\b/g, '<span class="warn">$1</span>');
  div.innerHTML = html;
  out.appendChild(div);
  while (out.children.length > 1200) out.removeChild(out.firstChild);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

/*
 * The per-server channel: console lines plus that server's status, players and
 * pings. Shared state is patched here for whoever is looking; `onEvent` is the
 * open tab's own business with the event.
 */
function openServerStream(id, onEvent) {
  const es = new EventSource(`/api/servers/${id}/console`);
  state.consoleES = es;
  es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "ping") return;
    const s = state.servers.get(id);
    if (s) {
      if (e.type === "players") s.players = e.players;
      else if (e.type === "pings") s.pings = e.pings;
      else if (e.type === "status") Object.assign(s, e);
    }
    onEvent(e, s);
  };
  es.onerror = () => {};
}
function closeConsoleStream() {
  if (state.consoleES) { state.consoleES.close(); state.consoleES = null; }
}

function renderPlayers(s) {
  const list = $("#pl-list"); const count = $("#pl-count");
  if (count) count.textContent = `${(s.players || []).length}/${s.maxPlayers}`;
  if (!list) return;
  list.innerHTML = (s.players || []).length
    ? s.players
        .map((p) => `<div class="player"><span class="head">${esc(p[0].toUpperCase())}</span><span class="pname">${esc(p)}</span>${pingChip((s.pings || {})[p])}</div>`)
        .join("")
    : `<div class="players-empty">${s.status === "running" ? "No one online." : s.wakeArmed ? "Sleeping — joining the server wakes it." : s.asleep ? "Sleeping — start it to wake up." : "Server offline."}</div>`;
}

// Latency comes from the server's own `ping` command, which only Paper,
// Purpur and plugin-added variants have — elsewhere we show a quiet dash.
function pingChip(ms) {
  if (!Number.isFinite(ms))
    return `<span class="ping none" title="This server doesn't report ping — Paper and Purpur do.">—</span>`;
  const q = ms < 80 ? "good" : ms < 160 ? "ok" : "bad";
  const word = { good: "Good", ok: "Fair", bad: "Poor" }[q];
  return `<span class="ping ${q}" title="${word} — ${ms} ms round-trip"><i></i>${ms}<small>ms</small></span>`;

}

/* --------------------------------------------------------------- players tab */
/*
 * The player log. Minecraft narrates every join, leave, chat line and death to
 * its console, but that console is a ring buffer that dies with the process —
 * so the backend keeps a durable copy per server and this tab reads it. The
 * roster on the left is everyone who has ever been on and how long they stayed;
 * the feed on the right is what happened, filtered by kind, by player or by
 * free text. Live records arrive on the global event stream, so the feed keeps
 * moving while you watch it.
 */
const PLOG_FILTERS = [
  { id: "all", label: "Everything", types: [] },
  { id: "sessions", label: "Joins & leaves", types: ["join", "leave"] },
  { id: "chat", label: "Chat", types: ["chat"] },
  { id: "death", label: "Deaths", types: ["death"] },
  { id: "advancement", label: "Advancements", types: ["advancement"] },
  { id: "command", label: "Commands", types: ["command"] },
  { id: "server", label: "Server", types: ["server"] },
];
const PLOG_PAGE = 200; // events per request, and per "load older" click
const PLOG_KEEP = 2000; // rows the browser holds before older ones are dropped

const PLOG_TYPE = {
  join: { label: "joined", icon: "check" },
  leave: { label: "left", icon: "moon" },
  chat: { label: "chat", icon: "chat" },
  death: { label: "death", icon: "alert" },
  advancement: { label: "advancement", icon: "star" },
  command: { label: "command", icon: "terminal" },
  server: { label: "server", icon: "cube" },
};

// View state survives re-renders (a live event repaints the feed) but resets
// when the tab is pointed at a different server.
function plogState(id) {
  if (!state.plog || state.plog.id !== id)
    state.plog = { id, filter: "all", q: "", player: null, find: "", rows: [], nextBefore: null, roster: null, total: 0 };
  return state.plog;
}
const plogOpen = (id) => state.route.name === "server" && state.route.id === id && state.activeTab === "players";

async function renderPlayersTab(id) {
  const P = plogState(id);
  const body = $("#tab-body");
  body.innerHTML = `
    <div class="plog-sum" id="plog-sum"></div>
    <div class="plog">
      <section class="plog-pane">
        <header class="plog-pane-head">
          <h4>${ico("users")} Roster</h4>
          <div class="fm-find">
            ${ico("search")}
            <input type="text" id="plog-find-p" placeholder="Find a player…" autocomplete="off" spellcheck="false" value="${esc(P.find)}" />
          </div>
        </header>
        <div id="plog-roster"><div class="players-empty">Loading…</div></div>
      </section>

      <section class="plog-pane">
        <header class="plog-pane-head">
          <h4>${ico("list")} Activity</h4>
          <div class="plog-tools">
            <div class="fm-find">
              ${ico("search")}
              <input type="text" id="plog-find-e" placeholder="Search the log…" autocomplete="off" spellcheck="false" value="${esc(P.q)}" />
              <button class="fm-x" id="plog-find-e-x" title="Clear search" ${P.q ? "" : "hidden"}>×</button>
            </div>
            <a class="btn btn-sm" href="/api/servers/${encodeURIComponent(id)}/players/export" download title="Download the whole log as a spreadsheet">${ico("download")} CSV</a>
            <button class="btn btn-sm btn-ghost btn-icon" id="plog-clear" title="Delete this server's recorded history">${ico("trash")}</button>
          </div>
        </header>
        <div class="plog-chips" id="plog-chips">
          ${PLOG_FILTERS.map((f) => `<button class="plog-chip ${P.filter === f.id ? "on" : ""}" data-f="${f.id}">${esc(f.label)}</button>`).join("")}
        </div>
        <div id="plog-who"></div>
        <div class="plog-feed" id="plog-feed"><div class="players-empty">Loading…</div></div>
        <div class="plog-foot" id="plog-foot"></div>
      </section>
    </div>`;

  $$("#plog-chips .plog-chip").forEach((b) => (b.onclick = () => {
    P.filter = b.dataset.f;
    $$("#plog-chips .plog-chip").forEach((x) => x.classList.toggle("on", x.dataset.f === P.filter));
    plogLoadFeed(id, { reset: true });
  }));

  const findE = $("#plog-find-e");
  let timer = null;
  findE.oninput = () => {
    P.q = findE.value.trim();
    $("#plog-find-e-x").hidden = !P.q;
    clearTimeout(timer);
    timer = setTimeout(() => plogLoadFeed(id, { reset: true }), 250);
  };
  $("#plog-find-e-x").onclick = () => { findE.value = ""; findE.oninput(); };

  const findP = $("#plog-find-p");
  findP.oninput = () => { P.find = findP.value.trim(); plogPaintRoster(id); };

  $("#plog-clear").onclick = async () => {
    if (!(await confirmDialog(
      "Clear the player log?",
      "<p class='muted'>Every recorded session, chat line and death for this server is deleted. The server itself and its world are untouched, and tracking starts again from now.</p>",
      "Clear log"
    ))) return;
    try {
      await API.del(`/api/servers/${id}/players/log`);
      toast("Player log cleared.", "ok");
      renderPlayersTab(id);
    } catch (e) { toast(e.message, "err"); }
  };

  plogLoadRoster(id);
  plogLoadFeed(id, { reset: true });

  // Anyone online is still accruing time; tick their row rather than refetching.
  if (renderPlayersTab._timer) clearInterval(renderPlayersTab._timer);
  renderPlayersTab._timer = setInterval(() => {
    if (!plogOpen(id)) return clearInterval(renderPlayersTab._timer);
    $$("#plog-roster [data-since]").forEach((el) => (el.textContent = fmtUptime(Date.now() - Number(el.dataset.since))));
  }, 1000);
}

/* ------------------------------------------------------------------- roster */

async function plogLoadRoster(id) {
  try {
    const data = await API.get(`/api/servers/${id}/players`);
    if (!plogOpen(id)) return;
    plogState(id).roster = data;
    plogPaintRoster(id);
    plogPaintSummary(id);
  } catch (e) {
    const box = $("#plog-roster");
    if (box) box.innerHTML = `<div class="players-empty">Couldn't load the roster: ${esc(e.message)}</div>`;
  }
}

// Joins and leaves land in bursts; one refresh a beat later covers the lot.
let plogRosterTimer = null;
function plogRosterSoon(id) {
  clearTimeout(plogRosterTimer);
  plogRosterTimer = setTimeout(() => { if (plogOpen(id)) plogLoadRoster(id); }, 1200);
}

function plogPaintSummary(id) {
  const box = $("#plog-sum");
  const P = plogState(id);
  if (!box || !P.roster) return;
  const t = P.roster.totals;
  const tile = (label, value, sub) =>
    `<div class="plog-tile"><span class="label">${esc(label)}</span><span class="value">${value}</span>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>`;
  box.innerHTML =
    tile("Players seen", t.players, t.online ? `${t.online} online now` : "none online") +
    tile("Sessions", t.sessions, P.roster.since ? "since " + fmtDay(P.roster.since) : "") +
    tile("Time played", fmtUptime(t.playtimeMs), "everyone, all sessions") +
    tile("Chat lines", t.chat, t.deaths ? `${t.deaths} death${t.deaths === 1 ? "" : "s"}` : "") +
    tile("Events logged", P.roster.events, "kept for this server");
}

function plogPaintRoster(id) {
  const box = $("#plog-roster");
  const P = plogState(id);
  if (!box || !P.roster) return;
  const needle = (P.find || "").toLowerCase();
  const rows = P.roster.players.filter((p) => !needle || p.name.toLowerCase().includes(needle));
  if (!rows.length) {
    box.innerHTML = `<div class="players-empty">${
      P.roster.players.length ? "No player matches that." : "Nobody has joined this server yet — the log fills itself as people play."
    }</div>`;
    return;
  }
  box.innerHTML = rows
    .map((p) => `
      <div class="plog-row ${p.online ? "online" : ""} ${P.player === p.name ? "sel" : ""}" data-name="${esc(p.name)}" title="Open ${esc(p.name)}'s history">
        <span class="head">${esc(p.name[0].toUpperCase())}</span>
        <div class="who">
          <div class="nm">${esc(p.name)} ${p.online ? '<span class="dot running"></span>' : ""}</div>
          <div class="sub">${p.online
            ? p.since
              ? `on for <span data-since="${p.since}">${fmtUptime(p.sessionMs)}</span>`
              : "online now"
            : `last seen ${esc(fmtAgo(p.lastSeen))}`} · ${p.sessions} session${p.sessions === 1 ? "" : "s"}</div>
        </div>
        <div class="time">
          <b>${fmtUptime(p.playtimeMs)}</b>
          <span>played</span>
        </div>
      </div>`)
    .join("");
  $$("#plog-roster .plog-row").forEach((r) => (r.onclick = () => openPlayerCard(id, r.dataset.name)));
}

/* --------------------------------------------------------------------- feed */

function plogFilterTypes(P) {
  return (PLOG_FILTERS.find((f) => f.id === P.filter) || PLOG_FILTERS[0]).types;
}

async function plogLoadFeed(id, { reset = false } = {}) {
  const P = plogState(id);
  const qs = new URLSearchParams({ limit: String(PLOG_PAGE) });
  const types = plogFilterTypes(P);
  if (types.length) qs.set("type", types.join(","));
  if (P.player) qs.set("player", P.player);
  if (P.q) qs.set("q", P.q);
  if (!reset && P.nextBefore) qs.set("before", String(P.nextBefore));
  try {
    const data = await API.get(`/api/servers/${id}/players/log?${qs}`);
    if (!plogOpen(id)) return;
    P.rows = reset ? data.events : P.rows.concat(data.events);
    P.nextBefore = data.nextBefore;
    P.total = data.total;
  } catch (e) {
    const feed = $("#plog-feed");
    if (feed) feed.innerHTML = `<div class="players-empty">Couldn't load the log: ${esc(e.message)}</div>`;
    return;
  }
  plogPaintFeed(id);
}

function plogPaintFeed(id) {
  const P = plogState(id);
  const feed = $("#plog-feed");
  if (!feed) return;

  $("#plog-who").innerHTML = P.player
    ? `<div class="plog-only">Showing <b>${esc(P.player)}</b> only <button class="fm-x" id="plog-only-x" title="Show everyone">×</button></div>`
    : "";
  if (P.player) $("#plog-only-x").onclick = () => plogSetPlayer(id, null);

  if (!P.rows.length) {
    feed.innerHTML = `<div class="players-empty">${
      P.q || P.player || plogFilterTypes(P).length ? "Nothing in the log matches that." : "Nothing logged yet. Start the server and the feed fills itself."
    }</div>`;
  } else {
    let day = null;
    feed.innerHTML = P.rows
      .map((e) => {
        const d = fmtDay(e.t);
        const head = d === day ? "" : `<div class="plog-day">${esc(d)}</div>`;
        day = d;
        return head + plogEventHTML(e);
      })
      .join("");
    $$("#plog-feed .pe-who").forEach((b) => (b.onclick = () => plogSetPlayer(id, b.dataset.name)));
  }

  const foot = $("#plog-foot");
  foot.innerHTML = P.nextBefore
    ? `<button class="btn btn-sm" id="plog-more">Load older</button><span class="muted">${P.rows.length} of ${P.total} events</span>`
    : P.rows.length
    ? `<span class="muted">That's the whole log — ${P.rows.length} event${P.rows.length === 1 ? "" : "s"}.</span>`
    : "";
  if ($("#plog-more")) $("#plog-more").onclick = () => plogLoadFeed(id);
}

function plogSetPlayer(id, name) {
  const P = plogState(id);
  P.player = name;
  plogPaintRoster(id);
  plogLoadFeed(id, { reset: true });
}

// One feed row. The player's name is a button everywhere it appears — clicking
// it narrows the feed to that person, which is the question this tab exists for.
function plogEventHTML(e) {
  const kind = PLOG_TYPE[e.type] || PLOG_TYPE.server;
  const meta = e.meta || {};
  const who = e.player ? `<button class="pe-who" data-name="${esc(e.player)}">${esc(e.player)}</button>` : "";
  let body;
  if (e.type === "join")
    body = `${who} joined the game${meta.ip ? ` <span class="pe-dim mono">${esc(meta.ip)}</span>` : ""}`;
  else if (e.type === "leave")
    body = `${who} left${meta.ms ? ` after <b>${fmtUptime(meta.ms)}</b>` : ""}${meta.reason ? ` <span class="pe-dim">(${esc(meta.reason)})</span>` : ""}`;
  else if (e.type === "chat") body = `${who}<span class="pe-dim">:</span> ${esc(e.text)}`;
  else if (e.type === "death") body = esc(e.text);
  else if (e.type === "advancement") body = `${who} earned <span class="pe-adv">${esc(e.text)}</span>`;
  else if (e.type === "command")
    body = meta.result
      ? `${who} <span class="pe-dim">used a command:</span> ${esc(e.text)}` // vanilla only says what it did
      : `${who} ran <span class="mono pe-dim">${esc(e.text)}</span>`;
  else body = `<span class="pe-dim">${esc(e.text)}</span>`;
  return `
    <div class="plog-ev ${esc(e.type)}">
      <span class="pe-time" title="${esc(fmtWhen(e.t))}">${fmtClock(e.t)}</span>
      <span class="pe-kind" title="${esc(kind.label)}">${ico(kind.icon)}</span>
      <span class="pe-body">${body}</span>
    </div>`;
}

// A record just landed. Prepend it if the open filter would have asked for it.
function plogLive(e) {
  if (state.activeTab !== "players") return;
  if (!e.event) return renderPlayersTab(e.id); // the log was cleared out from under us
  const P = plogState(e.id);
  const types = plogFilterTypes(P);
  const ev = e.event;
  const hay = ((ev.text || "") + " " + (ev.player || "")).toLowerCase();
  const wanted =
    (!types.length || types.includes(ev.type)) &&
    (!P.player || ev.player === P.player) &&
    (!P.q || hay.includes(P.q.toLowerCase()));
  if (wanted) {
    P.rows.unshift(ev);
    if (P.rows.length > PLOG_KEEP) P.rows.length = PLOG_KEEP;
    P.total++;
    plogPaintFeed(e.id);
  }
  plogRosterSoon(e.id);
}

/* ------------------------------------------------------------ player card */
/* One player's whole history with this server: the totals, and the sessions
 * they are made of — joined when, left when, and how long that was. */

async function openPlayerCard(id, name) {
  let p;
  try {
    p = (await API.get(`/api/servers/${id}/players/${encodeURIComponent(name)}`)).player;
  } catch (e) { return toast(e.message, "err"); }

  const stat = (label, value) => `<div class="pc-stat"><span>${esc(label)}</span><b>${value}</b></div>`;
  const sessions = p.sessions.length
    ? `<div class="pc-sessions">
         <div class="pc-srow head"><span>Joined</span><span>Left</span><span>For</span><span>Ended by</span></div>
         ${p.sessions.map((sn) => `
           <div class="pc-srow${sn.to ? "" : " live"}">
             <span>${esc(fmtWhen(sn.from))}</span>
             <span>${sn.to ? esc(fmtWhen(sn.to)) : "still on"}</span>
             <span>${fmtUptime(sn.ms)}</span>
             <span class="muted">${esc(sn.reason || (sn.to ? "disconnected" : "—"))}</span>
           </div>`).join("")}
       </div>`
    : `<p class="muted">No finished sessions recorded yet.</p>`;

  modal(`
    <div class="modal-head">
      <h2>${esc(p.name)} ${p.online ? '<span class="pill running">● Online</span>' : ""}</h2>
      <button class="modal-close">×</button>
    </div>
    <div class="modal-body">
      <div class="pc-stats">
        ${stat("Time played", fmtUptime(p.playtimeMs))}
        ${stat("Sessions", p.sessionCount)}
        ${stat("Chat lines", p.chat)}
        ${stat("Deaths", p.deaths)}
        ${stat("Advancements", p.advancements)}
        ${stat("Commands", p.commands)}
      </div>
      <div class="pc-facts">
        <div><span>First seen</span><b>${esc(fmtWhen(p.firstSeen))}</b></div>
        <div><span>Last seen</span><b>${p.online ? "now" : esc(fmtWhen(p.lastSeen))}</b></div>
        <div><span>Last address</span><b class="mono">${esc(p.ip || "—")}</b></div>
        <div><span>UUID</span><b class="mono small">${esc(p.uuid || "—")}</b></div>
      </div>
      <div class="section-title">Sessions${
        p.sessionCount > p.sessions.length ? ` <span class="muted" style="text-transform:none;letter-spacing:0">— the last ${p.sessions.length} of ${p.sessionCount}</span>` : ""
      }</div>
      ${sessions}
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" id="pc-close">Close</button>
      <button class="btn btn-primary" id="pc-filter">${ico("list")} Show in the log</button>
    </div>`, { wide: true });

  $("#pc-close").onclick = closeModal;
  $("#pc-filter").onclick = () => { closeModal(); plogSetPlayer(id, p.name); };
}

/* ---------------------------------------------------------------- stats tab */
/*
 * How the server is running, not just whether it is. The backend (perf.js)
 * asks the console for TPS / tick time / entities and samples the process for
 * CPU and memory; this tab shows the latest numbers as tiles, a rolling
 * history as charts (one measure each — they don't share a scale) that share a
 * crosshair, zoom by dragging, smooth, pause and export, plus the "Can't keep
 * up!" log. Live points arrive on the global event stream every 5 s and are
 * appended in place. (Disk usage lives in the Files tab.)
 */
const PERF_RANGES = [
  { id: "15m", label: "15m", long: "15 minutes", span: 15 * 60000 },
  { id: "1h", label: "1h", long: "hour", span: 3600000 },
  { id: "6h", label: "6h", long: "6 hours", span: 6 * 3600000 },
  { id: "24h", label: "24h", long: "24 hours", span: 86400000 },
  { id: "7d", label: "7d", long: "7 days", span: 7 * 86400000 },
];
// How the charts are shown is a preference, not per-server state: it is kept
// in this browser and applies to every server's Stats tab.
const PERF_PREFS_KEY = "mch.perf.prefs";
const PERF_DEFAULT_PREFS = { range: "15m", metrics: ["tps", "mspt", "cpu", "mem", "players", "entities"], layout: "grid", smooth: "off", lag: true };
function perfPrefs() {
  if (!perfPrefs.v) {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(PERF_PREFS_KEY) || "{}") || {}; } catch {}
    perfPrefs.v = { ...PERF_DEFAULT_PREFS, ...saved };
  }
  return perfPrefs.v;
}
function savePerfPrefs(patch) {
  Object.assign(perfPrefs(), patch);
  try { localStorage.setItem(PERF_PREFS_KEY, JSON.stringify(perfPrefs())); } catch {}
}

function perfState(id) {
  if (!state.perf || state.perf.id !== id)
    state.perf = { id, range: perfPrefs().range, data: null, fetchedAt: 0, ro: null, view: null, frozenAt: null, hoverT: null };
  return state.perf;
}
const perfOpen = (id) => state.route.name === "server" && state.route.id === id && state.activeTab === "stats";

// Shared verdicts, so the header tile, the dashboard card and this tab agree.
function tpsState(tps, target = 20) {
  if (tps == null) return null;
  const r = tps / (target || 20);
  return r >= 0.95 ? { cls: "good", label: "Healthy" } : r >= 0.75 ? { cls: "warn", label: "Struggling" } : { cls: "bad", label: "Lagging" };
}
// The header tiles beside Uptime / Memory.
function tpsTileHTML(s) {
  const st = s.stats || {};
  if (s.status !== "running") return "—";
  if (st.idle) return `<span class="muted">idle</span>`;
  if (st.tps == null) return st.tpsSupport === "no" ? `— <small>n/a</small>` : st.tpsSupport === "retrying" ? `— <small>retrying</small>` : "—";
  const v = tpsState(st.tps, st.tpsTarget);
  return `<span class="tps-${v.cls}">${st.tps.toFixed(1)}</span> <small>${st.mspt != null ? fmtMs(st.mspt) + " ms/tick" : v.label}</small>`;
}
function cpuTileHTML(s) {
  const st = s.stats || {};
  if (s.status !== "running" && s.status !== "starting") return "—";
  return st.cpu != null ? `${st.cpu.toFixed(1)}<small> %</small>` : "—";
}
function fmtTps(st) {
  return st && st.tps != null && !st.idle ? st.tps.toFixed(1) : "—";
}
const fmtMs = (v) => (v == null ? "—" : v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)) ;
const fmtNum = (v) => (v == null ? "—" : Number(v).toLocaleString());

function perfSourceLabel(src) {
  return { paper: "Paper's tps / mspt commands", vanilla: "Minecraft's /tick query", forge: "Forge's /forge tps", neoforge: "NeoForge's /neoforge tps" }[src] || "the server console";
}

async function renderStatsTab(id) {
  const P = perfState(id);
  const prefs = perfPrefs();
  const body = $("#tab-body");
  body.innerHTML = `
    <div class="perf">
      <div class="perf-tiles" id="perf-tiles"></div>
      <div id="perf-note"></div>
      <div id="perf-dims"></div>
      <div class="perf-bar">
        <div class="seg" id="perf-range">
          ${PERF_RANGES.map((r) => `<button class="seg-btn ${r.id === P.range ? "on" : ""}" data-r="${r.id}" title="Last ${r.long}">${r.label}</button>`).join("")}
        </div>
        <div class="perf-bar-right">
          <button class="btn btn-sm btn-ghost perf-live" id="perf-live" title="Pause or resume live updates"></button>
          <div class="perf-menu-wrap">
            <button class="btn btn-sm btn-ghost" id="perf-menu-btn" aria-haspopup="true" aria-expanded="false" title="Chart options">${ico("sliders")}<span class="perf-menu-l"> Charts</span></button>
            <div class="perf-menu" id="perf-menu" hidden>
              <div class="pm-sec">
                <div class="pm-h">Show</div>
                <div id="perf-metrics" class="pm-checks"></div>
              </div>
              <div class="pm-row">
                <span>Layout</span>
                <div class="seg seg-sm" id="perf-layout">
                  ${[["grid", "Grid"], ["list", "Large"]].map(([k, l]) => `<button class="seg-btn ${prefs.layout === k ? "on" : ""}" data-v="${k}">${l}</button>`).join("")}
                </div>
              </div>
              <div class="pm-row">
                <span>Smoothing</span>
                <div class="seg seg-sm" id="perf-smooth">
                  ${[["off", "Off"], ["light", "Light"], ["heavy", "Heavy"]].map(([k, l]) => `<button class="seg-btn ${prefs.smooth === k ? "on" : ""}" data-v="${k}">${l}</button>`).join("")}
                </div>
              </div>
              <label class="pm-row pm-check"><span>Lag spike markers</span><input type="checkbox" id="perf-lagmarks" ${prefs.lag ? "checked" : ""}/></label>
              <button class="pm-item" id="perf-csv">${ico("download")} Download as CSV</button>
              <p class="pm-hint">Drag across a chart to zoom in on that stretch; double-click to zoom back out.</p>
            </div>
          </div>
        </div>
      </div>
      <div class="perf-window muted"><span id="perf-window"></span><button class="link-btn" id="perf-zoom-reset" hidden title="Back to the whole range (or double-click a chart)">Reset zoom</button></div>
      <div class="perf-charts ${prefs.layout === "list" ? "list" : ""}" id="perf-charts"></div>
      <div class="perf-lower">
        <section class="plog-pane">
          <header class="plog-pane-head">
            <h4 title="&quot;Can't keep up!&quot; warnings from the server — moments it fell seconds behind.">${ico("alert")} Lag spikes <span class="muted" id="perf-lag-run"></span></h4>
            <div class="plog-tools"><button class="btn btn-sm btn-ghost" id="perf-lag-clear" hidden title="Forget recorded lag spikes">${ico("trash")} Clear</button></div>
          </header>
          <div id="perf-lag" class="perf-lag"></div>
        </section>
        <section class="plog-pane">
          <header class="plog-pane-head"><h4>${ico("clock")} This run</h4></header>
          <div id="perf-session" class="perf-kv"></div>
        </section>
      </div>
    </div>`;

  $$("#perf-range .seg-btn").forEach((b) => (b.onclick = () => {
    P.range = b.dataset.r;
    P.view = null;
    savePerfPrefs({ range: P.range });
    $$("#perf-range .seg-btn").forEach((x) => x.classList.toggle("on", x === b));
    perfLoad(id);
  }));
  $$("#perf-smooth .seg-btn").forEach((b) => (b.onclick = () => {
    savePerfPrefs({ smooth: b.dataset.v });
    $$("#perf-smooth .seg-btn").forEach((x) => x.classList.toggle("on", x === b));
    perfPaintCharts(id);
  }));
  $$("#perf-layout .seg-btn").forEach((b) => (b.onclick = () => {
    savePerfPrefs({ layout: b.dataset.v });
    $$("#perf-layout .seg-btn").forEach((x) => x.classList.toggle("on", x === b));
    $("#perf-charts").classList.toggle("list", b.dataset.v === "list");
    perfPaintCharts(id, true);
  }));
  $("#perf-lagmarks").onchange = (e) => { savePerfPrefs({ lag: e.target.checked }); perfPaintCharts(id); };
  $("#perf-live").onclick = () => {
    P.frozenAt = P.frozenAt ? null : Date.now();
    perfPaintCharts(id);
  };
  $("#perf-zoom-reset").onclick = () => { P.view = null; perfPaintCharts(id); };
  $("#perf-csv").onclick = () => { perfMenu(false); perfDownloadCsv(id); };
  $("#perf-menu-btn").onclick = () => perfMenu($("#perf-menu").hidden);
  $("#perf-lag-clear").onclick = async () => {
    if (!(await confirmDialog("Clear lag spikes?", "<p class='muted'>Forgets the recorded “Can't keep up!” warnings for this server. Charts are kept.</p>", "Clear"))) return;
    try { await API.del(`/api/servers/${id}/stats/lag`); if (P.data) P.data.lag = []; perfPaint(id); } catch (e) { toast(e.message, "err"); }
  };
  perfPaintMetricChips(id);

  if (P.ro) P.ro.disconnect();
  if (window.ResizeObserver) {
    let raf = 0;
    P.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => perfOpen(id) && perfPaintCharts(id)); });
    P.ro.observe($("#perf-charts"));
  }

  perfPaint(id); // tiles from the summary we already hold, before the fetch
  await perfLoad(id);
}

// The chart options live in one menu so the toolbar stays a range picker and
// a live switch. A click anywhere else, or Escape, closes it.
function perfMenu(open) {
  const menu = $("#perf-menu"), btn = $("#perf-menu-btn");
  if (perfMenu.off) { perfMenu.off(); perfMenu.off = null; }
  if (!menu) return;
  menu.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  btn.classList.toggle("on", open);
  if (!open) return;
  const away = (e) => { if (!e.target.closest(".perf-menu-wrap")) perfMenu(false); };
  const key = (e) => { if (e.key === "Escape") perfMenu(false); };
  document.addEventListener("pointerdown", away);
  document.addEventListener("keydown", key);
  perfMenu.off = () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key); };
}

function perfPaintMetricChips(id) {
  const box = $("#perf-metrics");
  if (!box) return;
  const on = new Set(perfPrefs().metrics);
  box.innerHTML = perfCharts(id).map((c) =>
    `<label class="pm-check"><input type="checkbox" data-k="${c.key}" ${on.has(c.key) ? "checked" : ""}/> <span>${esc(c.title)}</span></label>`).join("");
  $$("input", box).forEach((b) => (b.onchange = () => {
    const keys = new Set(perfPrefs().metrics);
    if (b.checked) keys.add(b.dataset.k); else keys.delete(b.dataset.k);
    // Keep the order the charts are defined in, whatever order they were ticked.
    savePerfPrefs({ metrics: perfCharts(id).map((c) => c.key).filter((k) => keys.has(k)) });
    perfPaintCharts(id, true);
  }));
}

async function perfLoad(id) {
  const P = perfState(id);
  try {
    P.data = await API.get(`/api/servers/${id}/stats?range=${P.range}`);
    P.fetchedAt = Date.now();
    const s = state.servers.get(id);
    if (s) s.stats = P.data.current;
  } catch (e) {
    toast(e.message, "err");
  }
  if (perfOpen(id)) perfPaint(id);
}

// A live sample: refresh the tiles, and extend the fine-grained history.
function perfLive(e) {
  const P = perfState(e.id);
  if (!P.data) return;
  const { type, id, point, ...cur } = e;
  P.data.current = cur;
  const range = PERF_RANGES.find((r) => r.id === P.range);
  if (point && P.data.history.step <= 5000) {
    P.data.history.points.push(point);
    const from = Date.now() - range.span;
    while (P.data.history.points.length && P.data.history.points[0].t < from) P.data.history.points.shift();
  } else if (P.data.history.step > 5000 && Date.now() - P.fetchedAt > Math.max(60000, P.data.history.step)) {
    if (!P.frozenAt) return perfLoad(e.id); // a new minute (or ten) has been averaged
  }
  perfPaintTiles(e.id);
  perfPaintSession(e.id);
  if (!P.frozenAt) perfPaintCharts(e.id);
}

function perfPaint(id) {
  perfPaintTiles(id);
  perfPaintCharts(id);
  perfPaintLag(id);
  perfPaintSession(id);
}

function perfTile(label, value, sub, opts = {}) {
  const bar = opts.pct != null
    ? `<div class="bar"><i class="${opts.barCls || ""}" style="width:${Math.max(0, Math.min(100, opts.pct))}%"></i></div>` : "";
  const verdict = opts.verdict ? `<span class="verdict ${opts.verdict.cls}">${opts.verdict.label}</span>` : "";
  return `<div class="plog-tile perf-tile" ${opts.title ? `title="${esc(opts.title)}"` : ""}>
      <span class="label">${label}</span>
      <span class="value">${value}${verdict}</span>
      ${bar}
      <span class="sub">${sub}</span>
    </div>`;
}

function perfPaintTiles(id) {
  const box = $("#perf-tiles");
  if (!box) return;
  const s = state.servers.get(id) || {};
  const P = perfState(id);
  const st = (P.data && P.data.current) || s.stats || {};
  const host = (P.data && P.data.host) || { cores: state.sys ? state.sys.host.cores : 0 };
  const up = s.status === "running" || s.status === "starting";
  const live = up && !st.idle;

  // TPS
  let tpsSub;
  if (!up) tpsSub = "server offline";
  else if (st.idle) tpsSub = s.paused ? "paused — nothing is ticking" : "empty — not asking, so it can pause";
  else if (st.tpsSupport === "no") tpsSub = "this server can't report it";
  else if (st.tpsSupport === "retrying") tpsSub = `not answering — asking again ${st.tpsRetryAt ? fmtIn(st.tpsRetryAt) : "soon"}`;
  else if (st.tps == null) tpsSub = "asking the server…";
  else if (st.tps1m != null) tpsSub = `1m ${st.tps1m} · 5m ${st.tps5m ?? "—"} · 15m ${st.tps15m ?? "—"}`;
  else tpsSub = `target ${st.tpsTarget || 20}${st.tickState && st.tickState !== "normal" ? " · " + st.tickState : ""}`;
  const verdict = live ? tpsState(st.tps, st.tpsTarget) : null;

  // Tick time: share of the 50 ms budget a tick may take at 20 TPS.
  const budget = 1000 / (st.tpsTarget || 20);
  const msptSub = !live || st.mspt == null ? `budget ${budget} ms per tick`
    : st.msptP95 != null ? `P95 ${fmtMs(st.msptP95)} · P99 ${fmtMs(st.msptP99)} ms`
    : st.msptMax != null ? `min ${fmtMs(st.msptMin)} · max ${fmtMs(st.msptMax)} ms`
    : `${Math.round((st.mspt / budget) * 100)}% of the ${budget} ms budget`;
  const msptPct = live && st.mspt != null ? (st.mspt / budget) * 100 : 0;

  const memPct = st.memMB && s.memory ? (st.memMB / s.memory) * 100 : 0;
  const players = (s.players || []).length;

  box.innerHTML = [
    perfTile("TPS", live ? fmtTps(st) : "—", tpsSub, { verdict, title: "Ticks per second — 20 is a server keeping up. Below ~18 players start to notice." }),
    perfTile("Tick time", live && st.mspt != null ? `${fmtMs(st.mspt)}<small> ms</small>` : "—", msptSub,
      { pct: msptPct, barCls: meterState(msptPct), title: "Milliseconds of work per tick (MSPT). Over 50 ms and TPS starts to drop." }),
    perfTile("CPU", up && st.cpu != null ? `${st.cpu.toFixed(1)}<small> %</small>` : "—",
      up && st.cores != null ? `≈ ${st.cores.toFixed(2)} of ${host.cores} cores` : up ? "measuring…" : "server offline",
      { pct: up ? st.cpu || 0 : 0, barCls: meterState(st.cpu || 0), title: "Share of the whole machine this server's Java process is using" }),
    perfTile("Memory", up && st.memMB ? `${fmtMem(st.memMB)}<small> / ${fmtMem(s.memory)}</small>` : "—",
      up ? `process${st.threads ? ` · ${st.threads} threads` : ""}` : "server offline",
      { pct: up ? memPct : 0, barCls: memPct > 100 ? "hot" : "", title: "What the Java process holds in RAM. It can sit above the -Xmx heap limit — the JVM needs some memory outside the heap." }),
    perfTile("Entities", live && st.entities != null ? fmtNum(st.entities) : "—", "loaded, all dimensions",
      { title: "Mobs, items, minecarts… everything with a position in loaded chunks. Thousands of dropped items or mobs in a farm is the classic cause of lag." }),
    perfTile("Players", `${players}<small> / ${s.maxPlayers || 20}</small>`, up ? `peak ${Math.max(st.peakPlayers || 0, players)} this run` : "server offline"),
  ].join("");

  const lagRun = $("#perf-lag-run");
  if (lagRun) lagRun.textContent = up ? `${fmtNum(st.lagCount || 0)} this run` : "";

  const note = $("#perf-note");
  if (note) {
    note.innerHTML = up && st.tpsSupport === "no"
      ? `<div class="banner perf-banner">${ico("alert")}<div>This server has no command that reports TPS. That needs Minecraft <b>1.20.3+</b> (any loader — it has <code>/tick query</code>), or Paper, Purpur, Forge or NeoForge on any version. CPU, memory, players and lag spikes are still tracked.</div></div>`
      : up && st.tpsSupport === "retrying"
      ? `<div class="banner perf-banner">${ico("alert")}<div>The server stopped answering the TPS question, so it has been set aside for a few minutes and will be asked again ${st.tpsRetryAt ? fmtIn(st.tpsRetryAt) : "shortly"}. A server that is very busy (booting a big modpack, or lagging hard) can miss its answers. CPU, memory, players and lag spikes are still tracked.</div></div>`
      : "";
  }
  const dims = $("#perf-dims");
  if (dims) {
    dims.innerHTML = live && st.dims && st.dims.length
      ? `<div class="perf-dimrow">${st.dims.map((d) => `<span class="perf-dim"><b>${esc(d.name)}</b> ${d.tps != null ? d.tps.toFixed(1) : "—"} TPS · ${fmtMs(d.mspt)} ms</span>`).join("")}</div>`
      : "";
  }
}

// One chart per measure — never two scales on one axis.
function perfCharts(id) {
  const s = state.servers.get(id) || {};
  const st = (state.perf && state.perf.data && state.perf.data.current) || {};
  const target = st.tpsTarget || 20;
  const budget = 1000 / target;
  return [
    { key: "tps", title: "TPS", unit: "TPS", fmt: (v) => v.toFixed(1), yMax: () => target, ref: { v: target, label: `target ${target}` }, lag: true },
    { key: "mspt", title: "Tick time", unit: "ms", fmt: fmtMs, yMax: (m) => niceMax(Math.max(m, budget * 1.1)), ref: { v: budget, label: `${budget} ms budget` } },
    { key: "cpu", title: "CPU", unit: "%", fmt: (v) => v.toFixed(1), yMax: (m) => Math.min(100, niceMax(Math.max(m, 10))) },
    { key: "mem", title: "Memory", unit: "", fmt: (v) => fmtMem(Math.round(v)), yMax: (m) => niceMax(Math.max(m, s.memory || 0) * 1.05), ref: s.memory ? { v: s.memory, label: "heap limit" } : null },
    { key: "players", title: "Players", unit: "online", fmt: (v) => String(Math.round(v)), yMax: (m) => Math.max(4, niceMax(m)), step: true },
    { key: "entities", title: "Loaded entities", unit: "", fmt: (v) => fmtNum(Math.round(v)), yMax: (m) => niceMax(Math.max(m, 10)) },
  ];
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

// The time window the charts show: a zoom if there is one, otherwise the whole
// range up to now (or up to the moment live updates were paused).
function perfWindow(P) {
  const range = PERF_RANGES.find((r) => r.id === P.range) || PERF_RANGES[0];
  const end = P.frozenAt || Date.now();
  return P.view ? { x0: P.view.x0, x1: P.view.x1, zoomed: true } : { x0: end - range.span, x1: end, zoomed: false };
}

// Centred moving average inside each unbroken run of readings.
function perfSmooth(pts, key, mode, step) {
  if (mode === "off" || pts.length < 4) return pts;
  const k = mode === "heavy" ? Math.max(5, Math.round(pts.length / 18)) : Math.max(3, Math.round(pts.length / 60));
  const half = Math.floor(k / 2);
  const out = pts.map((p) => ({ ...p }));
  for (let i = 0; i < pts.length; i++) {
    if (pts[i][key] == null) continue;
    let sum = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) {
      const q = pts[j];
      if (!q || q[key] == null || Math.abs(q.t - pts[i].t) > step * (half + 1.5)) continue;
      sum += q[key];
      n++;
    }
    out[i][key] = n ? sum / n : pts[i][key];
  }
  return out;
}

function perfPaintCharts(id, rebuild = false) {
  const box = $("#perf-charts");
  const P = perfState(id);
  if (!box || !P.data) return;
  const prefs = perfPrefs();
  const charts = perfCharts(id).filter((c) => prefs.metrics.includes(c.key));
  const want = charts.map((c) => c.key).join(",");
  if (rebuild || box.dataset.keys !== want) {
    box.dataset.keys = want;
    box.innerHTML = charts.length ? charts.map((c) => `
      <div class="perf-chart" data-k="${c.key}">
        <div class="pc-head">
          <span class="pc-title">${c.title}</span>
          ${c.lag && prefs.lag ? `<span class="pc-key"><i class="lag-key"></i>lag spike</span>` : ""}
          <b class="pc-now"></b>
        </div>
        <div class="pc-plot"><svg></svg><div class="pc-tip" hidden></div></div>
        <div class="pc-sum"></div>
      </div>`).join("")
      : `<div class="players-empty">No charts picked — choose some under Charts.</div>`;
  }

  const win = perfWindow(P);
  const step = P.data.history.step || 5000;
  const all = P.data.history.points.filter((p) => p && p.t >= win.x0 - step && p.t <= win.x1 + step);
  const lag = prefs.lag ? P.data.lag || [] : null;
  const H = prefs.layout === "list" ? 200 : 140;
  for (const c of charts) {
    const card = $(`.perf-chart[data-k="${c.key}"]`, box);
    if (!card) continue;
    const pts = c.step ? all : perfSmooth(all, c.key, prefs.smooth, step);
    drawPerfChart(id, card, c, pts, all, { ...win, step, lag: c.lag ? lag : null, H });
  }

  // Toolbar state follows the window.
  const range = PERF_RANGES.find((r) => r.id === P.range);
  const reset = $("#perf-zoom-reset");
  if (reset) reset.hidden = !win.zoomed;
  const live = $("#perf-live");
  if (live) {
    live.innerHTML = P.frozenAt ? `${ico("pause")} Paused` : `<i class="live-dot"></i> Live`;
    live.title = P.frozenAt ? "Paused — click to resume live updates" : "Live — click to pause";
    live.classList.toggle("paused", !!P.frozenAt);
  }
  const wl = $("#perf-window");
  if (wl) {
    const parts = [`${fmtWhen(win.x0)} → ${win.zoomed || P.frozenAt ? fmtWhen(win.x1) : "now"}`];
    parts.push(step >= 600000 ? "10-minute averages" : step >= 60000 ? "1-minute averages" : "every 5 s");
    if (win.zoomed) parts.push(`zoomed in on ${fmtSpan(win.x1 - win.x0)} of the last ${range.long}`);
    wl.textContent = parts.join(" · ");
  }
}

function fmtSpan(ms) {
  if (ms < 120000) return Math.round(ms / 1000) + " s";
  if (ms < 7200000) return Math.round(ms / 60000) + " min";
  if (ms < 172800000) return (ms / 3600000).toFixed(ms < 36000000 ? 1 : 0) + " h";
  return (ms / 86400000).toFixed(1) + " days";
}

// Every chart shares one crosshair: pointing at a moment on any of them shows
// that moment on all of them.
function perfHover(id, t, source) {
  const P = perfState(id);
  P.hoverT = t;
  $$("#perf-charts .perf-chart").forEach((card) => card._hover && card._hover(t, card === source));
}

function drawPerfChart(id, card, c, pts, raw, dom) {
  const svg = $(".pc-plot svg", card);
  const plot = $(".pc-plot", card);
  const W = Math.max(200, plot.clientWidth || 400);
  const H = dom.H;
  const pad = { l: 42, r: 10, t: 10, b: 20 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);
  svg.setAttribute("height", H);

  const inWin = pts.filter((p) => p.t >= dom.x0 && p.t <= dom.x1);
  const rawWin = raw.filter((p) => p.t >= dom.x0 && p.t <= dom.x1 && p[c.key] != null);
  const vals = inWin.map((p) => p[c.key]).filter((v) => v != null);
  const last = [...rawWin].reverse()[0];
  const nowText = last ? `${c.fmt(last[c.key])}${c.unit ? " " + c.unit : ""}` : "";
  const nowEl = $(".pc-now", card);
  nowEl.textContent = nowText;
  const yMax = c.yMax(vals.length ? Math.max(...vals) : 0) || 1;
  const span = dom.x1 - dom.x0;
  const X = (t) => pad.l + ((t - dom.x0) / span) * iw;
  const Y = (v) => pad.t + ih - (Math.max(0, Math.min(v, yMax)) / yMax) * ih;

  // Recessive grid: four bands, labels in muted ink.
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i, y = Y(v);
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
    g += `<text class="ax" x="${pad.l - 6}" y="${y + 3.5}" text-anchor="end">${esc(axisFmt(c, v))}</text>`;
  }
  const ticks = W < 360 ? 2 : 4;
  for (let i = 0; i <= ticks; i++) {
    const t = dom.x0 + (span / ticks) * i;
    const anchor = i === 0 ? "start" : i === ticks ? "end" : "middle";
    const label = i === ticks && !dom.zoomed && !perfState(id).frozenAt ? "now" : timeTick(t, span, dom.zoomed || !!perfState(id).frozenAt);
    g += `<text class="ax" x="${X(t)}" y="${H - 5}" text-anchor="${anchor}">${esc(label)}</text>`;
  }
  if (c.ref && c.ref.v <= yMax) {
    const y = Y(c.ref.v);
    // Labelled at the old end of the window: the new end is where the data is.
    g += `<line class="ref" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/><text class="ref-l" x="${pad.l + 4}" y="${y < pad.t + 12 ? y + 11 : y - 4}">${esc(c.ref.label)}</text>`;
  }

  // Break the line wherever the server was off or the value unknown.
  const segs = [];
  let cur = null, prevT = null;
  for (const p of pts) {
    const v = p[c.key];
    if (v == null || (prevT != null && p.t - prevT > dom.step * 2.5)) cur = null;
    if (v != null) {
      if (!cur) segs.push((cur = []));
      cur.push([X(p.t), Y(v)]);
    }
    prevT = p.t;
  }
  let lines = "";
  for (const sg of segs) {
    let d = "";
    sg.forEach(([x, y], i) => {
      if (i === 0) d += `M${x.toFixed(1)},${y.toFixed(1)}`;
      else if (c.step) d += `H${x.toFixed(1)}V${y.toFixed(1)}`;
      else d += `L${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const base = Y(0).toFixed(1);
    lines += `<path class="area" d="${d}V${base}H${sg[0][0].toFixed(1)}Z"/>`;
    lines += sg.length === 1
      ? `<circle class="dot" cx="${sg[0][0]}" cy="${sg[0][1]}" r="2.5"/>`
      : `<path class="line" d="${d}"/>`;
  }
  // The worst moment of each averaged point, as a faint band under the TPS line.
  if (c.key === "tps" && dom.step >= 60000) {
    const lows = inWin.filter((p) => p.tpsMin != null && p.tps != null && p.tpsMin < p.tps - 0.2);
    for (const p of lows) lines += `<line class="low" x1="${X(p.t)}" x2="${X(p.t)}" y1="${Y(p.tps)}" y2="${Y(p.tpsMin)}"/>`;
  }

  let marks = "";
  if (dom.lag)
    for (const l of dom.lag) {
      if (l.t < dom.x0 || l.t > dom.x1) continue;
      const x = X(l.t);
      marks += `<path class="lag-mark" d="M${x - 4},${pad.t} L${x + 4},${pad.t} L${x},${pad.t + 6}Z"><title>${esc(fmtWhen(l.t))} — ${l.ms} ms behind (${l.ticks} ticks)</title></path>`;
    }

  const empty = vals.length ? "" : `<text class="ax empty" x="${pad.l + iw / 2}" y="${pad.t + ih / 2}" text-anchor="middle">${c.key === "tps" || c.key === "mspt" || c.key === "entities" ? "No readings in this window" : "No data in this window yet"}</text>`;
  svg.innerHTML = `${g}${lines}${marks}${empty}<rect class="sel" y="${pad.t}" height="${ih}" width="0" visibility="hidden"/><line class="xhair" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/><circle class="xdot" r="3.5" visibility="hidden"/><rect class="hit" x="${pad.l}" y="0" width="${iw}" height="${H}"/>`;

  // Summary of what's on screen.
  const sum = $(".pc-sum", card);
  const rv = rawWin.map((p) => p[c.key]);
  if (rv.length) {
    const lo = Math.min(...rv), hi = Math.max(...rv), avg = rv.reduce((a, b) => a + b, 0) / rv.length;
    const f = (v) => `${c.fmt(v)}${c.unit && c.unit !== "online" ? " " + c.unit : ""}`;
    let extra = "";
    if (c.key === "tps") {
      const target = (state.perf.data.current || {}).tpsTarget || 20;
      const good = rv.filter((v) => v >= target * 0.95).length / rv.length;
      extra = `<span><em>healthy</em> ${Math.round(good * 100)}% of the time</span>`;
    }
    sum.innerHTML = `<span><em>min</em> ${esc(f(lo))}</span><span><em>avg</em> ${esc(f(avg))}</span><span><em>max</em> ${esc(f(hi))}</span>${extra}`;
  } else sum.innerHTML = "";

  // Crosshair + tooltip on the nearest sample; driven from any chart.
  const tip = $(".pc-tip", card);
  const hx = $(".xhair", svg), hd = $(".xdot", svg), hit = $(".hit", svg), sel = $(".sel", svg);
  const withVal = inWin.filter((p) => p[c.key] != null);
  const rawBy = new Map(rawWin.map((p) => [p.t, p]));
  card._hover = (t, mine) => {
    if (t == null || !withVal.length || t < dom.x0 || t > dom.x1) {
      tip.hidden = true;
      hx.setAttribute("visibility", "hidden");
      hd.setAttribute("visibility", "hidden");
      nowEl.textContent = nowText;
      nowEl.classList.remove("at");
      return;
    }
    let best = withVal[0];
    for (const p of withVal) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    if (Math.abs(best.t - t) > Math.max(dom.step * 3, span / 40)) return card._hover(null);
    const shown = (rawBy.get(best.t) || best)[c.key];
    const x = X(best.t), y = Y(best[c.key]);
    hx.setAttribute("x1", x); hx.setAttribute("x2", x); hx.setAttribute("visibility", "visible");
    hd.setAttribute("cx", x); hd.setAttribute("cy", y); hd.setAttribute("visibility", "visible");
    const val = `${c.fmt(shown)}${c.unit ? " " + c.unit : ""}`;
    nowEl.textContent = `${val} · ${fmtClock(best.t)}`;
    nowEl.classList.add("at");
    if (!mine) { tip.hidden = true; return; }
    const low = c.key === "tps" && best.tpsMin != null && best.tpsMin < shown ? ` <span>low ${best.tpsMin.toFixed(1)}</span>` : "";
    const avgNote = dom.step >= 60000 ? ` <span>${dom.step >= 600000 ? "10-min" : "1-min"} average</span>` : "";
    tip.innerHTML = `<b>${esc(val)}</b>${low}${avgNote}<span>${esc(fmtWhen(best.t))}</span>`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(W - tw, x - tw / 2)) + "px";
  };
  if (perfState(id).hoverT != null) card._hover(perfState(id).hoverT, false);

  const tAt = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    return dom.x0 + ((Math.max(pad.l, Math.min(W - pad.r, px)) - pad.l) / iw) * span;
  };
  // Mouse: hover reads, drag zooms. Touch: a finger dragged sideways reads
  // (vertical swipes still scroll the page — see touch-action in the CSS).
  let drag = null;
  hit.onpointerdown = (ev) => {
    if (ev.pointerType === "mouse" && ev.button === 0) {
      drag = { t0: tAt(ev), x0: ev.clientX };
      hit.setPointerCapture(ev.pointerId);
    } else if (ev.pointerType !== "mouse") perfHover(id, tAt(ev), card);
  };
  hit.onpointermove = (ev) => {
    const t = tAt(ev);
    if (drag && Math.abs(ev.clientX - drag.x0) > 4) {
      const a = X(Math.min(drag.t0, t)), b = X(Math.max(drag.t0, t));
      sel.setAttribute("x", a); sel.setAttribute("width", Math.max(1, b - a)); sel.setAttribute("visibility", "visible");
    }
    perfHover(id, t, card);
  };
  hit.onpointerup = (ev) => {
    if (!drag) return;
    const t = tAt(ev), d = drag;
    drag = null;
    sel.setAttribute("visibility", "hidden");
    if (Math.abs(ev.clientX - d.x0) <= 6) return;
    const a = Math.min(d.t0, t), b = Math.max(d.t0, t);
    if (b - a < dom.step * 3) return toast("That's too narrow to zoom into — drag across a wider stretch.", "");
    perfState(id).view = { x0: a, x1: b };
    perfHover(id, null);
    perfPaintCharts(id);
  };
  hit.onpointercancel = () => { drag = null; sel.setAttribute("visibility", "hidden"); perfHover(id, null); };
  hit.onpointerleave = (ev) => { if (!drag) perfHover(id, null); };
  hit.ondblclick = () => { if (perfState(id).view) { perfState(id).view = null; perfPaintCharts(id); } };
}

function axisFmt(c, v) {
  if (c.key === "mem") return v >= 1024 ? (v / 1024).toFixed(v % 1024 ? 1 : 0) + "G" : Math.round(v) + "M";
  if (v >= 10000) return Math.round(v / 1000) + "k";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function timeTick(t, span, absolute) {
  const d = new Date(t);
  if (span > 2 * 86400000) return d.toLocaleDateString([], { weekday: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", hour12: false });
  if (absolute || span > 3 * 3600000) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return "-" + Math.round((Date.now() - t) / 60000) + "m";
}

// What the charts show right now, as a spreadsheet.
function perfDownloadCsv(id) {
  const P = perfState(id);
  if (!P.data) return;
  const win = perfWindow(P);
  const rows = P.data.history.points.filter((p) => p.t >= win.x0 && p.t <= win.x1);
  if (!rows.length) return toast("Nothing in this window to download.", "");
  const keys = ["tps", "tpsMin", "mspt", "cpu", "mem", "players", "entities"];
  const head = ["time", "TPS", "TPS (lowest)", "tick time ms", "CPU %", "memory MB", "players", "entities"];
  const csv = [head.join(",")].concat(rows.map((p) => [new Date(p.t).toISOString(), ...keys.map((k) => (p[k] == null ? "" : p[k]))].join(","))).join("\n");
  const name = ((state.servers.get(id) || {}).name || "server").replace(/[^A-Za-z0-9_-]+/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `${name}-stats-${P.range}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function perfPaintLag(id) {
  const box = $("#perf-lag");
  const P = perfState(id);
  if (!box || !P.data) return;
  const lag = P.data.lag || [];
  const clear = $("#perf-lag-clear");
  if (clear) clear.hidden = !lag.length;
  box.innerHTML = lag.length
    ? `<div class="perf-lag-list">${lag.slice(0, 60).map((l) => `
        <div class="perf-lag-row">
          <span class="t mono">${esc(fmtWhen(l.t))}</span>
          <span class="bar"><i class="${l.ms >= 10000 ? "hot" : l.ms >= 4000 ? "warn" : ""}" style="width:${Math.min(100, (l.ms / 15000) * 100)}%"></i></span>
          <span class="v"><b>${fmtNum(l.ms)} ms</b> behind <small>${fmtNum(l.ticks)} ticks skipped</small></span>
        </div>`).join("")}</div>`
    : `<div class="players-empty">No lag spikes recorded — the server has kept up.<br><small class="muted">A spike is logged whenever the server prints “Can't keep up!”, which it does once it falls 2 s or more behind.</small></div>`;
}

function perfPaintSession(id) {
  const box = $("#perf-session");
  if (!box) return;
  const s = state.servers.get(id) || {};
  const P = perfState(id);
  const st = (P.data && P.data.current) || s.stats || {};
  const up = !!s.startedAt;
  const rows = [
    ["Started", up ? fmtWhen(s.startedAt) : "—"],
    ["Uptime", up ? fmtUptime(Date.now() - s.startedAt) : "—"],
    ["Boot time", st.startupSec != null ? st.startupSec + " s" : "—"],
    ["In-game day", st.day != null ? fmtNum(st.day) : "—"],
    ["Java threads", st.threads ? fmtNum(st.threads) : "—"],
    ["Heap limit", fmtMem(s.memory || 0)],
    ["TPS from", up && st.tpsSource ? perfSourceLabel(st.tpsSource) : up && st.tpsSupport === "no" ? "not available" : up && st.tpsSupport === "retrying" ? "retrying" : "—"],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
}

/* ------------------------------------------------------- live patch (server) */
function patchServerLive(e) {
  if (e.type === "status") {
    const s = state.servers.get(e.id);
    renderActions(s); renderEula(s);
    const pill = $("#srv-pill"); if (pill) { pill.className = "pill " + viewStatus(s); pill.textContent = statusDot(s) + statusLabel(s); }
    const ts = $("#t-status"); if (ts) ts.textContent = statusLabel(s);
    const addr = $("#srv-addr");
    if (addr) { addr.innerHTML = addrChipHTML(s.playit); bindAddrChips(addr); }
    if ($("#st-playit")) renderServerPlayit(s.id);
    if ($("#st-voice")) renderServerVoice(s.id);
    // The install finishing is what tells us which loader the server runs, so a
    // content tab that was showing "still installing" can now do its job.
    if (state.activeTab === "content" && s.content && !$("#md-list")) renderContentTab(s.id);
    // Restore is only offered while stopped, so the rows follow the status.
    if (state.activeTab === "backups" && bkData) paintBackups(s.id);
    if (perfOpen(s.id)) { perfPaintTiles(s.id); perfPaintSession(s.id); }
  }
  if (e.type === "stats") {
    const s = state.servers.get(e.id);
    const m = $("#t-mem"); if (m) m.innerHTML = `${e.memMB ? fmtMem(e.memMB) : "—"} <small>/ ${fmtMem(s.memory)}</small>`;
    const bar = $("#t-membar"); if (bar) bar.style.width = Math.min(100, (e.memMB / s.memory) * 100) + "%";
    const tps = $("#t-tps"); if (tps) tps.innerHTML = tpsTileHTML(s);
    const cpu = $("#t-cpu"); if (cpu) cpu.innerHTML = cpuTileHTML(s);
    if (perfOpen(e.id)) perfLive(e);
  }
  if (e.type === "lag" && perfOpen(e.id)) {
    const P = perfState(e.id);
    if (P.data) { P.data.lag = [e.lag, ...(P.data.lag || [])]; perfPaintLag(e.id); perfPaintCharts(e.id); }
  }
  if (e.type === "players") {
    const p = $("#t-players"); const s = state.servers.get(e.id);
    if (p) p.innerHTML = `${e.players.length} <small>/ ${s.maxPlayers}</small>`;
    if (state.activeTab === "players") plogRosterSoon(e.id);
    if (perfOpen(e.id)) perfPaintTiles(e.id);
  }
  if (e.type === "playerlog") plogLive(e);
  if (e.type === "pings") {
    const s = state.servers.get(e.id); if (s) renderPlayers(s);
  }
  if (e.type === "install") {
    const out = $("#con-out"); if (out && state.activeTab === "console") appendConsole(out, "sys", e.line);
  }
}

/* =========================================================== MODRINTH TAB */
/* Browse Modrinth and install straight into this server. What "content" means
 * depends on the loader — the backend hands us {noun, folder, projectType,
 * loaders} in the server summary, and every search here is scoped to it, so the
 * results are things this server can actually load. */

function fmtCount(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(n);
}

// One search result. Shared by the modpack picker and the content browser.
function projectRowHTML(p, selected, actions = "", badge = "") {
  return `
    <div class="pk-row ${selected ? "sel" : ""}" data-id="${esc(p.id)}" data-slug="${esc(p.slug)}">
      <span class="pk-icon">${p.icon ? `<img src="${esc(p.icon)}" alt="" loading="lazy" />` : `<span>${ico("box")}</span>`}</span>
      <div class="pk-meta">
        <div class="pk-title">${esc(p.title)} <span class="pk-author">by ${esc(p.author)}</span> ${badge}</div>
        <div class="pk-desc">${esc(p.description)}</div>
        <div class="pk-tags">${(p.categories || []).map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>
      </div>
      <div class="pk-side">
        <div class="pk-dl"><b>${fmtCount(p.downloads)}</b><span>downloads</span></div>
        ${actions}
      </div>
    </div>`;
}

const loaderQS = (content) => content.loaders.map((l) => "&loader=" + encodeURIComponent(l)).join("");

async function renderContentTab(id) {
  const s = state.servers.get(id);
  const body = $("#tab-body");
  const content = s.content;

  if (!content) {
    body.innerHTML = `<div class="banner warn">${
      s.status === "installing"
        ? "Still installing — the loader has to be in place before mods can be added."
        : "This server has no completed install yet, so there's nowhere to put mods."
    }</div>`;
    return;
  }

  body.innerHTML = `
    <div class="mods-head">
      <div>
        <h3>${esc(content.noun)} <span class="muted" id="md-count"></span></h3>
        <p class="muted">Installed into <span class="mono">${esc(content.folder === "datapacks" ? "world/datapacks" : content.folder)}/</span> · ${esc(cap(content.loader))} · Minecraft ${esc(s.mc)}</p>
      </div>
      <div style="margin-left:auto;display:flex;gap:8px;align-items:center">
        <div class="fm-find">
          ${ico("search")}
          <input type="text" id="md-filter" placeholder="Filter installed…" autocomplete="off" spellcheck="false" />
          <button class="fm-x" id="md-filter-clear" title="Clear filter" hidden>×</button>
        </div>
        <button class="btn btn-sm" id="md-add" title="Add .${content.folder === "datapacks" ? "zip" : "jar"} files from your computer — or drag them onto the list">${ico("upload")} Add files</button>
        <input type="file" id="md-file" multiple accept="${content.folder === "datapacks" ? ".zip,.jar" : ".jar"}" hidden />
        <button class="btn btn-sm" id="md-upd">↻ Check for updates</button>
      </div>
    </div>
    <div class="fm-prog" id="md-prog" hidden>
      <div class="fm-prog-track"><i id="md-prog-fill"></i></div>
      <span class="fm-prog-text" id="md-prog-text"></span>
    </div>
    <div class="fm-drop md-drop" id="md-drop">
      <div id="md-installed"></div>
      <div class="fm-drop-veil"><span>Drop to add to ${esc(content.folder === "datapacks" ? "world/datapacks" : content.folder)}/</span></div>
    </div>

    <div class="divider"></div>
    <div class="mods-head">
      <div>
        <h3>Browse Modrinth</h3>
        <p class="muted">Scoped to what this server can load. Open a lock below to search wider.</p>
      </div>
    </div>
    <div class="pk-bar">
      <input type="text" id="md-q" placeholder="Search ${esc(content.noun.toLowerCase())}…" autocomplete="off" />
      <select id="md-sort" style="width:auto;min-width:150px">
        ${[["relevance", "Best match"], ["downloads", "Most downloads"], ["follows", "Most followed"], ["updated", "Recently updated"]]
          .map(([v, l]) => `<option value="${v}" ${v === "downloads" ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="filter-bar" id="md-filters"></div>
    <div class="pk-list" id="md-list"></div>
    <div id="md-more" style="margin-top:12px"></div>`;

  // Locked by default: only things that fit this server. Each lock can be
  // opened individually, so you can go looking for a mod the filters hid.
  state.mdFilters = { loader: true, mc: true, server: true };
  state.mdQuery = "";
  state.mdUpdates = new Map();
  renderFilters(id);

  await loadInstalled(id);

  let timer = null;
  const q = $("#md-q");
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => browse(id, 0), 350); };
  q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); browse(id, 0); } };
  $("#md-sort").onchange = () => browse(id, 0);
  $("#md-upd").onclick = () => checkUpdates(id);
  $("#md-add").onclick = () => $("#md-file").click();
  $("#md-file").onchange = (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    uploadContent(id, files);
  };
  wireContentDrop(id);

  // Filtering what is already installed is a local matter — the list is
  // already in hand, so it narrows on every keystroke with no request.
  const mf = $("#md-filter");
  mf.oninput = () => {
    state.mdQuery = mf.value;
    $("#md-filter-clear").hidden = !mf.value;
    paintInstalled(id);
  };
  mf.onkeydown = (e) => { if (e.key === "Escape") { mf.value = ""; mf.oninput(); } };
  $("#md-filter-clear").onclick = () => { mf.value = ""; mf.oninput(); mf.focus(); };
  browse(id, 0);
}

/* ------------------------------------------------------- compatibility locks */
/* Three constraints keep the results to things this server can load. They are
 * on by default because installing a Forge mod on Paper is a crash, not a
 * surprise — but they're locks, not walls: click one open and the search
 * widens, with anything that no longer fits marked as such. */

function filterDefs(id) {
  const s = state.servers.get(id);
  const c = s.content;
  return [
    { key: "loader", on: `${cap(c.loader)} only`, off: "Any loader",
      tip: `Only ${c.noun.toLowerCase()} built for ${cap(c.loader)}` },
    { key: "mc", on: `MC ${s.mc}`, off: "Any Minecraft version",
      tip: `Only builds that list Minecraft ${s.mc}` },
    { key: "server", on: "Server-side", off: "Client mods too",
      tip: "Hide client-only projects — on a server they do nothing, and a few crash it" },
  ];
}

function renderFilters(id) {
  const box = $("#md-filters");
  if (!box) return;
  const f = state.mdFilters;
  const defs = filterDefs(id);
  const open = defs.filter((d) => !f[d.key]).length;

  box.innerHTML =
    `<span class="fl-label">Showing</span>` +
    defs.map((d) => `
      <button class="fchip ${f[d.key] ? "on" : "off"}" data-f="${d.key}" title="${esc(d.tip)} — click to ${f[d.key] ? "unlock" : "lock"}">
        <span class="fl-ic">${f[d.key] ? ico("lock") : ico("unlock")}</span> ${esc(f[d.key] ? d.on : d.off)}
      </button>`).join("") +
    (open
      ? `<span class="fl-warn">${ico("alert")} ${open} filter${open === 1 ? "" : "s"} unlocked — results may not run here.</span>`
      : "");

  $$(".fchip", box).forEach((b) => (b.onclick = () => {
    state.mdFilters[b.dataset.f] = !state.mdFilters[b.dataset.f];
    renderFilters(id);
    browse(id, 0);
  }));
}

// Does this search result fit the server as it is configured? Only consulted
// once a lock is open — with everything locked, every result fits by
// construction.
function compatOf(hit, id) {
  const s = state.servers.get(id);
  const c = s.content;
  const loaderOk = !hit.loaderTags.length || hit.loaderTags.some((l) => c.loaders.includes(l));
  const mcOk = !hit.gameVersions.length || hit.gameVersions.includes(s.mc);
  if (loaderOk && mcOk) return null;
  const why = [];
  if (!loaderOk) why.push(`no ${cap(c.loader)} build`);
  if (!mcOk) why.push(`not for ${s.mc}`);
  return why.join(" · ");
}

async function loadInstalled(id) {
  const box = $("#md-installed");
  if (!box) return;
  let data;
  try {
    data = await API.get(`/api/servers/${id}/content`);
  } catch (e) {
    box.innerHTML = `<div class="banner err" style="margin:0">${esc(e.message)}</div>`;
    return;
  }
  state.content = data;
  paintInstalled(id);
}

// Draws the installed list from what is already in state, so the filter box and
// the update badges can both repaint without going back to the server.
function paintInstalled(id) {
  const box = $("#md-installed");
  const data = state.content;
  if (!box || !data) return;

  const q = (state.mdQuery || "").trim().toLowerCase();
  const hit = (...fields) => !q || fields.some((f) => String(f || "").toLowerCase().includes(q));
  const items = data.items.filter((it) => hit(it.title, it.file, it.versionNumber));
  const unmanaged = data.unmanaged.filter((u) => hit(u.name, u.file));
  const pack = data.pack && hit(data.pack.name, data.pack.versionNumber) ? data.pack : null;

  const total = data.items.length + data.unmanaged.length;
  const shown = items.length + unmanaged.length;
  const count = $("#md-count");
  if (count) count.textContent = !total ? "" : q ? `· ${shown} of ${total} installed` : `· ${total} installed`;

  const packRow = pack
    ? `<div class="file-row md-item" data-slug="${esc(pack.projectId || "")}">
         <span class="fic">${ico("box")}</span>
         <span class="fname"><b>${esc(pack.name)}</b> ${esc(pack.versionNumber || "")}
           <span class="muted">modpack · ${pack.files} files installed with the server</span></span>
       </div>`
    : "";

  const rows = items.map((it) => `
    <div class="file-row md-item" data-slug="${esc(it.slug || "")}">
      <span class="fic">${it.icon ? `<img class="md-ic" src="${esc(it.icon)}" alt="" loading="lazy" />` : ico("layers")}</span>
      <span class="fname">
        <a href="https://modrinth.com/project/${esc(it.slug)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <span class="muted">${esc(it.versionNumber || it.file.split("/").pop())}${it.fromPack ? " · from the modpack" : it.dependency ? " · dependency" : it.adopted ? " · added by hand" : ""} · ${fmtBytes(it.size)}</span>
      </span>
      <span class="md-upd-slot" data-project="${esc(it.projectId)}">${updateButtonHTML(state.mdUpdates && state.mdUpdates.get(it.projectId))}</span>
      <span class="fdel" data-del="${esc(it.file)}" title="Remove">${ico("trash")}</span>
    </div>`).join("");

  const loose = unmanaged.map((u) => `
    <div class="file-row">
      <span class="fic">${ico("file")}</span>
      <span class="fname">${esc(u.name)} <span class="muted">added by hand${u.notOnModrinth ? " · not on Modrinth" : ""} · ${fmtBytes(u.size)}</span></span>
      <span class="fdel" data-del="${esc(u.file)}" title="Remove">${ico("trash")}</span>
    </div>`).join("");

  box.innerHTML = packRow || rows || loose
    ? `<div class="file-table">${packRow}${rows}${loose}</div>`
    : q
      ? `<div class="pk-empty">Nothing installed matches “${esc(state.mdQuery.trim())}”.</div>`
      : `<div class="pk-empty">Nothing installed yet — search below, or drop .${data.folder === "datapacks" ? "zip" : "jar"} files here.</div>`;

  bindModrinthLinks(box);
  $$(".md-upd-slot [data-up]", box).forEach((b) => (b.onclick = (ev) =>
    installContent(id, { versionId: b.dataset.up }, ev.currentTarget)));
  $$("[data-del]", box).forEach((el) => (el.onclick = async () => {
    const file = el.dataset.del;
    if (!(await confirmDialog("Remove?",
      `<p>Delete <b class="mono">${esc(file)}</b> from this server?</p>
       <p class="muted">Anything that depends on it may stop working. Restart the server to apply.</p>`, "Remove"))) return;
    try {
      await API.del(`/api/servers/${id}/content?file=${encodeURIComponent(file)}`);
      toast("Removed. Restart to apply.", "ok");
      loadInstalled(id);
    } catch (e) { toast(e.message, "err"); }
  }));
}

/* Dropping jars onto the installed list (or "Add files") puts them in the
 * content folder. The server looks each one up on Modrinth by its hash, so a
 * jar downloaded from there shows with its icon and can be updated later. */
function wireContentDrop(id) {
  guardWindowDrops();
  const zone = $("#md-drop");
  let depth = 0;
  const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  zone.addEventListener("dragenter", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add("dropping");
  });
  zone.addEventListener("dragover", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  zone.addEventListener("dragleave", (e) => {
    if (!carriesFiles(e)) return;
    if (--depth <= 0) { depth = 0; zone.classList.remove("dropping"); }
  });
  zone.addEventListener("drop", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove("dropping");
    uploadContent(id, [...(e.dataTransfer.files || [])]);
  });
}

async function uploadContent(id, files) {
  const s = state.servers.get(id);
  const content = s && s.content;
  if (!content || !files.length) return;
  const okExt = content.folder === "datapacks" ? /\.(zip|jar)$/i : /\.jar$/i;
  const wrong = files.filter((f) => !okExt.test(f.name));
  files = files.filter((f) => okExt.test(f.name));
  if (wrong.length)
    toast(`Skipped ${wrong.map((f) => f.name).slice(0, 3).join(", ")}${wrong.length > 3 ? "…" : ""} — only ${content.folder === "datapacks" ? ".zip/.jar" : ".jar"} files go here.`, "err");
  if (!files.length) return;

  const prog = $("#md-prog");
  const show = (done, label) => {
    if (!prog) return;
    prog.hidden = false;
    $("#md-prog-fill").style.width = ((done / files.length) * 100).toFixed(1) + "%";
    $("#md-prog-text").textContent = `Adding ${done} of ${files.length} · ${label}`;
  };
  let known = 0, running = false;
  const replaced = [];
  const errors = [];
  show(0, "starting…");
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const r = await fetch(`/api/servers/${id}/content/upload?name=${encodeURIComponent(f.name)}`, { method: "POST", body: f });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `HTTP ${r.status}`);
      if (out.item) known++;
      if (out.replaced) replaced.push(out.replaced.split("/").pop());
      running = running || out.running;
    } catch (e) {
      errors.push(`${f.name}: ${e.message}`);
    }
    show(i + 1, f.name);
  }
  if (prog) prog.hidden = true;
  const added = files.length - errors.length;
  if (added)
    toast(`Added ${added} file${added === 1 ? "" : "s"}` +
      (known ? ` — ${known === added ? (added === 1 ? "it's" : "all") : known} recognised on Modrinth` : "") +
      (replaced.length ? `, replacing ${replaced.slice(0, 2).join(", ")}${replaced.length > 2 ? "…" : ""}` : "") +
      (running ? ". Restart to apply." : "."), "ok");
  if (errors.length) toast(errors.slice(0, 2).join(" · ") + (errors.length > 2 ? ` (+${errors.length - 2} more)` : ""), "err");
  loadInstalled(id);
}

async function browse(id, offset) {
  const list = $("#md-list");
  if (!list) return;
  const s = state.servers.get(id);
  const content = s.content;
  const query = $("#md-q").value.trim();
  const sort = $("#md-sort").value;
  const f = state.mdFilters || { loader: true, mc: true, server: true };
  if (!offset) list.innerHTML = `<div class="pk-empty"><span class="spinner"></span> Searching Modrinth…</div>`;

  try {
    const r = await API.get(
      `/api/modrinth/search?type=${encodeURIComponent(content.projectType)}` +
        `&q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}` +
        `&server=${f.server ? "1" : "0"}&offset=${offset}&limit=20` +
        (f.mc ? `&mc=${encodeURIComponent(s.mc)}` : "") +
        (f.loader ? loaderQS(content) : "")
    );
    state.mdHits = { ...(offset ? state.mdHits : {}) };
    const have = new Map(((state.content && state.content.items) || []).map((i) => [i.projectId, i]));
    const html = r.hits
      .map((h) => {
        state.mdHits[h.id] = h;
        const bad = f.loader && f.mc ? null : compatOf(h, id);
        return projectRowHTML(
          h,
          false,
          `<div class="pk-actions">
            <button class="btn btn-sm ${have.has(h.id) ? "" : "btn-primary"}" data-install="${esc(h.id)}">${have.has(h.id) ? "Reinstall" : "Install"}</button>
            <button class="btn btn-sm btn-ghost btn-icon" data-versions="${esc(h.id)}" title="Pick a specific version">⋯</button>
          </div>`,
          bad ? `<span class="pk-warn" title="This won't load on ${esc(cap(content.loader))} ${esc(s.mc)}">${ico("alert")} ${esc(bad)}</span>` : ""
        );
      })
      .join("");

    if (!offset)
      list.innerHTML = html || `<div class="pk-empty">Nothing on Modrinth matches that${f.loader || f.mc ? ` for ${esc(cap(content.loader))} ${esc(s.mc)} — try unlocking a filter above.` : "."}</div>`;
    else list.insertAdjacentHTML("beforeend", html);

    const shown = offset + r.hits.length;
    const more = $("#md-more");
    more.innerHTML = shown < r.total
      ? `<button class="btn btn-sm" id="md-more-btn">Load more (${shown} of ${r.total})</button>`
      : r.total ? `<span class="muted" style="font-size:12px">${r.total} result${r.total === 1 ? "" : "s"}</span>` : "";
    const mb = $("#md-more-btn");
    if (mb) mb.onclick = () => { mb.disabled = true; mb.textContent = "Loading…"; browse(id, shown); };

    bindBrowseActions(id, list);
  } catch (e) {
    list.innerHTML = `<div class="banner err" style="margin:0">Couldn't reach Modrinth: ${esc(e.message)}</div>`;
  }
}

function bindBrowseActions(id, root) {
  $$("[data-install]", root).forEach((b) => {
    if (b._bound) return;
    b._bound = true;
    b.onclick = () => {
      const f = state.mdFilters || {};
      // With a lock open, "Install" means "install it even though it may not
      // fit" — otherwise the backend refuses and the button just errors.
      installContent(id, { projectId: b.dataset.install, allowIncompatible: !f.loader || !f.mc }, b);
    };
  });
  $$("[data-versions]", root).forEach((b) => {
    if (b._bound) return;
    b._bound = true;
    b.onclick = () => openVersionPicker(id, b.dataset.versions);
  });
  bindModrinthLinks(root);
}

// Clicking anywhere on a result — but not on its buttons — opens the project's
// Modrinth page, which is where the screenshots, changelog and comments are.
function bindModrinthLinks(root) {
  $$("[data-slug]", root).forEach((row) => {
    if (row._linked || !row.dataset.slug) return;
    row._linked = true;
    row.title = "Open on Modrinth";
    row.onclick = (e) => {
      // The row's own controls win — install, update, the version list, delete.
      if (e.target.closest("button, a, input, select, label, [data-del]")) return;
      window.open(`https://modrinth.com/project/${encodeURIComponent(row.dataset.slug)}`, "_blank", "noopener");
    };
  });
}

async function installContent(id, body, btn) {
  const label = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "Installing…"; }
  try {
    const out = await API.post(`/api/servers/${id}/content`, body);
    const names = out.installed.map((i) => i.title);
    toast(
      `Installed ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2} more` : ""}` +
        (out.running ? " — restart to apply." : "."),
      "ok"
    );
    if (btn) { btn.textContent = "Installed ✓"; btn.classList.remove("btn-primary"); }
    await loadInstalled(id);
  } catch (e) {
    toast(e.message, "err");
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

/* ------------------------------------------------------------ version picker */
/* "Install" takes the newest build that fits. This is for when you need a
 * particular one — a pack pins it, or a friend's client is on it. Modrinth
 * hands back a lot per version (a name, a version number, sometimes a dozen
 * game versions), so the job here is to boil each one down to the three things
 * that actually decide it: how stable it is, what it runs on, how old it is. */

// A dozen game versions is noise; the span between the first and last is the
// useful part. Modrinth returns them oldest-first.
function mcRange(list) {
  if (!list || !list.length) return "any version";
  if (list.length === 1) return "MC " + list[0];
  return `MC ${list[0]} – ${list[list.length - 1]}`;
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const CHANNEL = {
  release: { label: "Release", note: "stable" },
  beta: { label: "Beta", note: "testing" },
  alpha: { label: "Alpha", note: "unstable" },
};

async function openVersionPicker(id, projectId) {
  const s = state.servers.get(id);
  const content = s.content;
  const p = (state.mdHits && state.mdHits[projectId]) || null;
  const installedItem = ((state.content && state.content.items) || []).find((i) => i.projectId === projectId);
  const f = state.mdFilters || {};

  modal(`
    <div class="modal-head"><h2>Choose a version</h2><button class="modal-close">×</button></div>
    <div class="modal-body">
      <div class="vp-top">
        <span class="pk-icon">${p && p.icon ? `<img src="${esc(p.icon)}" alt="" />` : `<span>${ico("layers")}</span>`}</span>
        <div class="vp-who">
          <b>${esc(p ? p.title : "This project")}</b>
          <span>Installs into <span class="mono">${esc(content.folder === "datapacks" ? "world/datapacks" : content.folder)}/</span> · ${esc(cap(content.loader))} · Minecraft ${esc(s.mc)}</span>
        </div>
        <label class="chk" title="Builds for other loaders or Minecraft versions won't load on this server">
          <input type="checkbox" id="vp-all" ${!f.loader || !f.mc ? "checked" : ""} /> Show builds that don't fit
        </label>
      </div>
      <div id="vp-list"><div class="pk-empty"><span class="spinner"></span> Loading versions…</div></div>
    </div>
    <div class="modal-foot">
      ${p ? `<a class="muted" href="https://modrinth.com/project/${esc(p.slug)}" target="_blank" rel="noopener" style="font-size:12px">Changelogs on Modrinth ${ico("external")}</a>` : "<span></span>"}
      <button class="btn btn-ghost" data-x>Close</button>
    </div>`, { wide: true });
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  $("#vp-all").onchange = load;
  load();

  async function load() {
    const box = $("#vp-list");
    if (!box) return;
    const all = $("#vp-all").checked;
    box.innerHTML = `<div class="pk-empty"><span class="spinner"></span> Loading versions…</div>`;
    try {
      const { versions } = await API.get(
        `/api/modrinth/versions?project=${encodeURIComponent(projectId)}` +
          (all ? "" : `&mc=${encodeURIComponent(s.mc)}${loaderQS(content)}`)
      );
      if (!$("#vp-list")) return; // modal closed while we were fetching
      render(versions);
    } catch (e) {
      const b = $("#vp-list");
      if (b) b.innerHTML = `<div class="banner err" style="margin:0">${esc(e.message)}</div>`;
    }
  }

  function render(versions) {
    const box = $("#vp-list");
    if (!versions.length) {
      box.innerHTML = `<div class="pk-empty">No builds of this project target ${esc(cap(content.loader))} ${esc(s.mc)}.
        ${$("#vp-all").checked ? "" : "<br />Tick “show builds that don’t fit” above to see the rest."}</div>`;
      return;
    }
    const fits = (v) =>
      v.loaders.some((l) => content.loaders.includes(l)) && v.gameVersions.includes(s.mc);

    // Once the misfits are shown, the handful that actually run here can be
    // hundreds of rows down — so they go first, under their own heading, and
    // the newest of them is the one tagged "Latest".
    const fitting = versions.filter(fits);
    const misfits = versions.filter((v) => !fits(v));
    const ordered = [...fitting, ...misfits].slice(0, 80);
    const latestId = (fitting[0] || {}).id;
    const sep = `<div class="vp-sep">Doesn't fit ${esc(cap(content.loader))} ${esc(s.mc)}</div>`;

    box.innerHTML = `<div class="vp-list">${ordered.map((v, i) => {
      const head = i === fitting.length && fitting.length && misfits.length ? sep : "";
      const ch = CHANNEL[v.type] || CHANNEL.release;
      const bad = !fits(v);
      const isInstalled = installedItem && installedItem.versionId === v.id;
      return head + `
        <div class="vp-row ${bad ? "bad" : ""} ${isInstalled ? "cur" : ""}">
          <span class="vp-ch ${esc(v.type)}" title="${ch.note}">${ch.label}</span>
          <div class="vp-meta">
            <div class="vp-num">${esc(v.number)}
              ${v.id === latestId ? `<span class="vp-tag latest">Latest that fits</span>` : ""}
              ${isInstalled ? `<span class="vp-tag cur">Installed</span>` : ""}
              ${bad ? `<span class="vp-tag bad" title="This build won't load on ${esc(cap(content.loader))} ${esc(s.mc)}">${ico("alert")} doesn't fit</span>` : ""}
            </div>
            <div class="vp-sub" title="${esc(v.gameVersions.join(", "))}">
              ${esc(v.loaders.map(cap).join(", ") || "any loader")} · ${esc(mcRange(v.gameVersions))} · ${esc(fmtDate(v.published))} · ${fmtCount(v.downloads)} downloads
            </div>
          </div>
          <button class="btn btn-sm ${bad || isInstalled ? "" : "btn-primary"}" data-v="${esc(v.id)}">${isInstalled ? "Reinstall" : bad ? "Install anyway" : "Install"}</button>
        </div>`;
    }).join("")}</div>
    ${versions.length > ordered.length ? `<p class="hint">Showing ${ordered.length} of ${versions.length} builds.</p>` : ""}`;

    $$("[data-v]", box).forEach((btn) => (btn.onclick = async () => {
      await installContent(id, { versionId: btn.dataset.v }, btn);
      closeModal();
    }));
  }
}

function updateButtonHTML(u) {
  return u
    ? `<button class="btn btn-sm btn-primary" data-up="${esc(u.versionId)}" title="${esc(u.from)} → ${esc(u.to)}">Update to ${esc(u.to)}</button>`
    : "";
}

async function checkUpdates(id) {
  const btn = $("#md-upd");
  btn.disabled = true;
  btn.textContent = "↻ Checking…";
  try {
    const { updates } = await API.get(`/api/servers/${id}/content/updates`);
    // Held in state, not written straight into the DOM, so filtering the list
    // afterwards redraws the badges instead of losing them.
    state.mdUpdates = new Map(updates.map((u) => [u.projectId, u]));
    paintInstalled(id);
    toast(updates.length
      ? `${updates.length} update${updates.length === 1 ? "" : "s"} available.`
      : "Everything is up to date.", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
  btn.disabled = false;
  btn.textContent = "↻ Check for updates";
}

/* ------------------------------------------------------------- files tab */
/* The table does three jobs at once: browse, search, and multi-select.
 *
 * Selection is by full path and lives for one view only — changing folder or
 * running a new search drops it — because a batch spanning places the table
 * isn't showing can't be reviewed before it runs, and a delete you can't see
 * is a delete you didn't mean.
 *
 * Search filters the open folder as you type; Enter widens it to a recursive
 * walk of everything below. Editing the box afterwards falls back to the local
 * filter, so the rows on screen always match the text in the box. */
let fmDir = "";          // folder currently open
let fmEntries = [];      // raw listing of fmDir
let fmDeep = null;       // recursive search payload, or null while browsing
let fmQuery = "";        // text in the search box
let fmRows = [];         // entries on screen, in display order
let fmSel = new Set();   // paths ticked, relative to the server folder
let fmAnchor = null;     // index of the last row touched, for shift-click
let fmDisk = null;       // what's taking the space in fmDir: { path, total, entries, at }
// Sizes and the sort order are this browser's preference, for every server.
const fmPrefs = (() => {
  let v = {};
  try { v = JSON.parse(localStorage.getItem("mch.files.prefs") || "{}") || {}; } catch {}
  return { sizes: v.sizes !== false, sort: v.sort === "size" ? "size" : "name" };
})();
function saveFmPrefs() {
  try { localStorage.setItem("mch.files.prefs", JSON.stringify(fmPrefs)); } catch {}
}

async function renderFilesTab(id, dir = "") {
  const body = $("#tab-body");
  fmQuery = "";
  fmDeep = null;
  body.innerHTML = `
    <div class="fm-bar">
      <div class="breadcrumb" id="fm-crumb"></div>
      <div class="fm-find">
        ${ico("search")}
        <input type="text" id="fm-q" placeholder="Search this folder…" autocomplete="off" spellcheck="false" />
        <button class="fm-x" id="fm-q-clear" title="Clear search" hidden>×</button>
      </div>
      <div class="fm-acts">
        <button class="btn btn-sm ${fmPrefs.sizes ? "on" : ""}" id="fm-sizes" title="Show what's taking the space in this folder">${ico("chart")} Disk usage</button>
        <button class="btn btn-sm" id="fm-mkdir">${ico("plus")} New folder</button>
        <label class="btn btn-sm" style="cursor:pointer" title="Upload a folder, keeping its structure">${ico("folder")} Upload folder
          <input type="file" id="fm-upload-dir" webkitdirectory directory multiple style="display:none" />
        </label>
        <label class="btn btn-sm btn-primary" style="cursor:pointer">${ico("upload")} Upload
          <input type="file" id="fm-upload" multiple style="display:none" />
        </label>
      </div>
    </div>
    <div class="fm-prog" id="fm-prog" hidden>
      <div class="fm-prog-track"><i id="fm-prog-fill"></i></div>
      <span class="fm-prog-text" id="fm-prog-text"></span>
    </div>
    <div class="fm-usage" id="fm-usage" hidden></div>
    <div class="fm-drop" id="fm-drop">
      <div class="file-table" id="fm-table"></div>
      <p class="hint" style="margin-top:10px">Drag files or whole folders in from your desktop — drop them on a folder row to go straight inside it. Tick rows to delete or move several at once; shift-click extends the selection. Mods go in <span class="mono">mods/</span>, plugins in <span class="mono">plugins/</span>, datapacks in <span class="mono">world/datapacks/</span> — or install them from Modrinth in the previous tab.</p>
      <div class="fm-drop-veil" id="fm-drop-veil"><span id="fm-drop-label"></span></div>
    </div>`;

  const q = $("#fm-q");
  q.oninput = () => {
    fmQuery = q.value;
    fmDeep = null;               // the box no longer matches the deep results
    $("#fm-q-clear").hidden = !fmQuery;
    paintFiles(id);
  };
  q.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); deepSearch(id); }
    if (e.key === "Escape") { q.value = ""; q.oninput(); }
  };
  $("#fm-q-clear").onclick = () => { q.value = ""; q.oninput(); q.focus(); };

  $("#fm-sizes").onclick = () => {
    fmPrefs.sizes = !fmPrefs.sizes;
    saveFmPrefs();
    $("#fm-sizes").classList.toggle("on", fmPrefs.sizes);
    if (fmPrefs.sizes) loadDisk(id, fmDir);
    else { fmDisk = null; paintUsage(id); paintFiles(id); }
  };
  $("#fm-mkdir").onclick = async () => {
    const name = prompt("New folder name:");
    if (!name) return;
    try { await API.post(`/api/servers/${id}/mkdir`, { path: joinPath(fmDir, name) }); loadDir(id, fmDir); }
    catch (e) { toast(e.message, "err"); }
  };
  // Both pickers feed the same runner. The folder picker fills in
  // webkitRelativePath, which is the tree we rebuild on the server.
  const pick = (input) => (input.onchange = (ev) => {
    const files = [...ev.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name }));
    ev.target.value = "";  // so picking the same thing twice still fires
    if (files.length) runUpload(id, fmDir, files, []);
  });
  pick($("#fm-upload"));
  pick($("#fm-upload-dir"));
  wireDropZone(id);

  await loadDir(id, dir);
}

function joinPath(a, b) { return (a ? a + "/" : "") + b; }
function parentOf(p) { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); }
// The server folder itself has no path to print, and a bare "/" reads as a
// typo mid-sentence. The breadcrumb already calls it root, so everything does.
function dirLabel(d) { return d ? "/" + d : "root"; }

/* ---------------------------------------------------------------- uploads */
/* Dropping from the desktop and picking with the buttons end up in the same
 * runner. A drop is the harder half: directory trees only reach us through
 * webkitGetAsEntry, and the DataTransfer is emptied the moment the drop
 * handler returns — so the entry handles are taken synchronously and walked
 * afterwards. */

const UPLOAD_CONCURRENCY = 4;
const BIG_UPLOAD_FILES = 50;
const BIG_UPLOAD_BYTES = 250 * 1024 * 1024;

function wireDropZone(id) {
  guardWindowDrops();
  const zone = $("#fm-drop");
  let depth = 0;   // dragenter/leave also fire for every child, so count them
  let dest = "";

  const carriesFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  const clear = () => {
    depth = 0;
    zone.classList.remove("dropping");
    $$(".file-row.drop-into", zone).forEach((r) => r.classList.remove("drop-into"));
  };
  // Dropping on a folder row puts things inside that folder; anywhere else in
  // the pane means the folder currently open.
  const targetOf = (node) => {
    const row = node && node.closest ? node.closest(".file-row[data-i]") : null;
    const entry = row && fmRows[Number(row.dataset.i)];
    return entry && entry.dir ? { dir: entry.path, row } : { dir: fmDir, row: null };
  };

  zone.addEventListener("dragenter", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add("dropping");
  });
  zone.addEventListener("dragover", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const t = targetOf(e.target);
    dest = t.dir;
    $$(".file-row.drop-into", zone).forEach((r) => r !== t.row && r.classList.remove("drop-into"));
    if (t.row) t.row.classList.add("drop-into");
    $("#fm-drop-label").textContent = `Drop to upload into ${dirLabel(dest)}`;
  });
  zone.addEventListener("dragleave", (e) => {
    if (!carriesFiles(e)) return;
    if (--depth <= 0) clear();
  });
  zone.addEventListener("drop", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    const into = dest;
    clear();
    const entries = [...(e.dataTransfer.items || [])]
      .filter((i) => i.kind === "file")
      .map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null))
      .filter(Boolean);
    const flat = [...(e.dataTransfer.files || [])].map((f) => ({ file: f, rel: f.name }));
    collectDrop(id, into, entries, flat);
  });
}

// A file dropped anywhere outside the zone would otherwise be opened by the
// browser, throwing away the panel and whatever was on screen. Registered once.
let fmWindowGuard = false;
function guardWindowDrops() {
  if (fmWindowGuard) return;
  fmWindowGuard = true;
  for (const ev of ["dragover", "drop"])
    window.addEventListener(ev, (e) => {
      if (!e.target.closest || !e.target.closest("#fm-drop, #md-drop")) e.preventDefault();
    });
}

async function collectDrop(id, dest, entries, flat) {
  if (!entries.length) return flat.length && runUpload(id, dest, flat, []);
  const files = [], dirs = [];
  for (const entry of entries) await walkEntry(entry, "", files, dirs);
  if (!files.length && !dirs.length) return toast("Nothing in that drop.", "");
  runUpload(id, dest, files, dirs);
}

// Depth-first walk of one dropped entry. readEntries hands back at most a
// hundred children per call, so it has to be drained in a loop.
function walkEntry(entry, prefix, files, dirs) {
  const rel = prefix ? prefix + "/" + entry.name : entry.name;
  if (entry.isFile)
    return new Promise((res) => entry.file((f) => { files.push({ file: f, rel }); res(); }, () => res()));
  dirs.push(rel);
  const reader = entry.createReader();
  return new Promise((res) => {
    const batch = () => reader.readEntries(async (kids) => {
      if (!kids.length) return res();
      for (const k of kids) await walkEntry(k, rel, files, dirs);
      batch();
    }, () => res());
    batch();
  });
}

function showUploadProgress(done, total, label) {
  const p = $("#fm-prog");
  if (!p) return;
  p.hidden = false;
  $("#fm-prog-fill").style.width = total ? ((done / total) * 100).toFixed(1) + "%" : "0%";
  $("#fm-prog-text").textContent = `Uploading ${done} of ${total} · ${label}`;
}

async function runUpload(id, dest, files, dirs) {
  const bytes = files.reduce((n, f) => n + (f.file.size || 0), 0);
  // A dropped world folder is tens of thousands of files. Say what is about to
  // go over the wire before it starts, not after.
  if (files.length > BIG_UPLOAD_FILES || bytes > BIG_UPLOAD_BYTES) {
    const ok = await confirmDialog("Upload this?",
      `<p><b>${files.length}</b> file${files.length === 1 ? "" : "s"} (${fmtBytes(bytes)}) into <b class="mono">${esc(dirLabel(dest))}</b>.</p>
       <p class="muted">Folders keep their structure. Files already there are overwritten.</p>`,
      "Upload", false);
    if (!ok) return;
  }

  const queue = files.slice();
  const errors = [];
  let done = 0;
  showUploadProgress(0, files.length, "starting…");

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const r = await fetch(
          `/api/servers/${id}/upload?path=${encodeURIComponent(dest)}&name=${encodeURIComponent(item.rel)}`,
          { method: "POST", body: item.file });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      } catch (e) {
        errors.push({ path: item.rel, error: e.message });
      }
      showUploadProgress(++done, files.length, item.rel);
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));

  // Folders that held no files at all would otherwise vanish, since a file
  // upload is what creates the directories on the way to it.
  const empties = dirs.filter((d) => !files.some((f) => f.rel === d || f.rel.startsWith(d + "/")));
  for (const d of empties) {
    try { await API.post(`/api/servers/${id}/mkdir`, { path: joinPath(dest, d) }); }
    catch (e) { errors.push({ path: d, error: e.message }); }
  }

  const prog = $("#fm-prog");
  if (prog) prog.hidden = true;
  reportBatch({ done: files.length - errors.length, errors }, "Uploaded");
  refreshFiles(id);
}

async function loadDir(id, dir, fresh = false) {
  const table = $("#fm-table"), crumb = $("#fm-crumb");
  fmDir = dir;
  fmDeep = null;
  try {
    const data = await API.get(`/api/servers/${id}/files?path=${encodeURIComponent(dir)}`);
    const parts = dir ? dir.split("/") : [];
    crumb.innerHTML = `<a data-p="">⌂ root</a>` + parts.map((p, i) =>
      ` / <a data-p="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("");
    $$("#fm-crumb a").forEach((a) => (a.onclick = () => renderFilesTab(id, a.dataset.p)));
    fmEntries = data.entries.map((e) => ({ ...e, path: joinPath(dir, e.name) }));
    if (fmDisk && fmDisk.path !== dir) fmDisk = null;
    paintFiles(id);
    paintUsage(id);
    if (fmPrefs.sizes) loadDisk(id, dir, fresh);
  } catch (e) {
    fmEntries = [];
    table.innerHTML = `<div class="file-row"><span class="muted">${esc(e.message)}</span></div>`;
  }
}

// Walk everything below the open folder. Kept behind Enter rather than run on
// every keystroke: a world folder is tens of thousands of files, and that walk
// is not something to fire off four times a second.
async function deepSearch(id) {
  const q = fmQuery.trim();
  if (!q) return;
  const table = $("#fm-table");
  table.innerHTML = `<div class="file-row"><span class="muted"><span class="spinner"></span> Searching every folder below ${esc(dirLabel(fmDir))}…</span></div>`;
  try {
    fmDeep = await API.get(`/api/servers/${id}/search?path=${encodeURIComponent(fmDir)}&q=${encodeURIComponent(q)}`);
    paintFiles(id);
  } catch (e) {
    fmDeep = null;
    toast(e.message, "err");
    paintFiles(id);
  }
}

/* ------------------------------------------------------------- disk usage */
/* Sizes of everything in the open folder, folders included — measured on the
 * server by walking them (a world is tens of thousands of files, so it is
 * cached for a couple of minutes), shown as bars above the table and as the
 * size of each folder row. */
async function loadDisk(id, dir, fresh = false) {
  const box = $("#fm-usage");
  if (box && (fresh || !fmDisk)) {
    box.hidden = false;
    box.innerHTML = `<div class="fm-usage-head"><span class="muted"><span class="spinner"></span> Measuring ${esc(dirLabel(dir))}…</span></div>`;
  }
  let disk;
  try {
    ({ disk } = await API.get(`/api/servers/${id}/disk?path=${encodeURIComponent(dir)}${fresh ? "&fresh=1" : ""}`));
  } catch (e) {
    if (box && fmDir === dir) box.innerHTML = `<div class="fm-usage-head"><span class="muted">${esc(e.message)}</span></div>`;
    return;
  }
  if (fmDir !== dir || !fmPrefs.sizes || !$("#fm-usage")) return;
  fmDisk = disk;
  paintUsage(id);
  // Folder sizes in the table — repaint only if nothing is ticked, so a
  // selection in progress isn't thrown away by a measurement finishing.
  if (!fmSel.size) paintFiles(id);
  else $$("#fm-table .file-row[data-i]").forEach((row) => {
    const e = fmRows[Number(row.dataset.i)];
    const b = e && sizeOfEntry(e);
    if (b != null) $(".fsize", row).textContent = fmtBytes(b);
  });
}

function sizeOfEntry(e) {
  if (!e.dir) return e.size;
  if (!fmDisk || fmDeep || parentOf(e.path) !== fmDisk.path) return null;
  const hit = fmDisk.entries.find((x) => x.name === e.name);
  return hit ? hit.bytes : null;
}

function paintUsage(id) {
  const box = $("#fm-usage");
  if (!box) return;
  if (!fmPrefs.sizes || fmDeep || !fmDisk) { if (!fmPrefs.sizes || fmDeep) box.hidden = true; return; }
  box.hidden = false;
  const d = fmDisk;
  const top = d.entries.slice(0, 6);
  const rest = d.entries.slice(6);
  const restBytes = rest.reduce((a, e) => a + e.bytes, 0);
  const total = Math.max(1, d.total);
  const pct = (b) => (b / total) * 100;
  const sys = state.sys && state.sys.disk;
  box.innerHTML = `
    <div class="fm-usage-head">
      <b>${fmtBytes(d.total)}</b>
      <span class="muted">in ${esc(dirLabel(d.path))} · measured ${fmtAgo(d.at)}${!d.path && sys && sys.total ? ` · ${fmtBytes(sys.free)} free on ${esc(sys.drive || "the drive")}` : ""}</span>
      <button class="btn btn-sm btn-ghost" id="fm-usage-refresh" title="Measure again">${ico("rotate")}</button>
    </div>
    <div class="fm-usage-strip" title="Share of ${esc(dirLabel(d.path))}">
      ${top.filter((e) => pct(e.bytes) >= 0.5).map((e, i) => `<i class="u${i}" style="width:${pct(e.bytes)}%" title="${esc(e.name)} — ${fmtBytes(e.bytes)}"></i>`).join("")}
    </div>
    <div class="fm-usage-rows">
      ${top.map((e, i) => `
        <div class="fm-usage-row ${e.dir ? "dir" : ""}" data-n="${esc(e.name)}" title="${esc(e.name)} — ${fmtBytes(e.bytes)}${e.dir ? " · open" : ""}">
          <span class="n"><i class="sw u${i}"></i>${ico(e.dir ? "folder" : "file")} ${esc(e.name)}</span>
          <span class="bar"><i style="width:${pct(e.bytes)}%"></i></span>
          <span class="v mono">${fmtBytes(e.bytes)}</span>
          <span class="p mono">${pct(e.bytes) < 1 && e.bytes ? "<1" : Math.round(pct(e.bytes))}%</span>
        </div>`).join("")}
      ${rest.length ? `<div class="fm-usage-row other"><span class="n">${rest.length} more</span><span class="bar"><i style="width:${pct(restBytes)}%"></i></span><span class="v mono">${fmtBytes(restBytes)}</span><span class="p mono">${Math.round(pct(restBytes))}%</span></div>` : ""}
      ${d.entries.length ? "" : `<div class="muted" style="padding:6px 2px">Empty folder.</div>`}
    </div>`;
  $("#fm-usage-refresh").onclick = () => loadDisk(id, fmDir, true);
  $$(".fm-usage-row.dir", box).forEach((r) => (r.onclick = () => renderFilesTab(id, joinPath(d.path, r.dataset.n))));
}

function paintFiles(id) {
  const table = $("#fm-table");
  if (!table) return;
  const q = fmQuery.trim().toLowerCase();
  const src = fmDeep ? fmDeep.entries : fmEntries;
  fmRows = q ? src.filter((e) => e.name.toLowerCase().includes(q)) : src.slice();
  paintUsage(id);
  if (fmPrefs.sort === "size")
    fmRows.sort((a, b) => (sizeOfEntry(b) ?? -1) - (sizeOfEntry(a) ?? -1) || a.name.localeCompare(b.name));
  fmSel = new Set();
  fmAnchor = null;

  const head = `
    <div class="file-row file-head">
      <label class="fcheck"><input type="checkbox" id="fm-all" ${fmRows.length ? "" : "disabled"} /></label>
      <span class="fhead-label" id="fm-count"></span>
      <div class="fhead-acts" id="fm-acts" hidden>
        <button class="btn btn-sm" id="fm-move">${ico("folder")} Move to…</button>
        <button class="btn btn-sm btn-red" id="fm-del-sel">${ico("trash")} Delete</button>
        <button class="btn btn-sm btn-ghost" id="fm-clear">Clear</button>
      </div>
      <button class="btn btn-sm btn-ghost" id="fm-deep" ${q && !fmDeep ? "" : "hidden"}>${ico("search")} All sub-folders ⏎</button>
      <button class="btn btn-sm btn-ghost fm-sort" id="fm-sort" title="Change the order">Sort: ${fmPrefs.sort === "size" ? "largest first" : "name"}</button>
    </div>`;

  const rows = fmRows.map((e, i) => `
    <div class="file-row" data-i="${i}">
      <label class="fcheck"><input type="checkbox" class="fsel" data-i="${i}" /></label>
      <span class="fic">${e.dir ? ico("folder") : fileIcon(e.name)}</span>
      <span class="fname ${e.dir ? "dir" : ""}" data-i="${i}">${esc(e.name)}${
        fmDeep && parentOf(e.path) !== fmDir ? `<span class="fpath">in /${esc(parentOf(e.path))}</span>` : ""}</span>
      <span class="fsize">${sizeOfEntry(e) == null ? "" : fmtBytes(sizeOfEntry(e))}</span>
      <span class="fdel" data-i="${i}" title="Delete">${ico("trash")}</span>
    </div>`).join("");

  const empty = q
    ? `<div class="file-row"><span class="muted" style="padding:4px">Nothing here matches “${esc(fmQuery.trim())}”.${fmDeep ? "" : " Press Enter to search every folder below."}</span></div>`
    : `<div class="file-row"><span class="muted" style="padding:4px">Empty folder.</span></div>`;

  table.innerHTML = head + (fmRows.length ? rows : empty) +
    (fmDeep && fmDeep.truncated
      ? `<div class="file-row"><span class="muted" style="padding:4px">Only the first ${fmDeep.entries.length} matches are listed — narrow the search to see the rest.</span></div>`
      : "");

  $$("#fm-table .fname").forEach((el) => (el.onclick = () => {
    const e = fmRows[Number(el.dataset.i)];
    if (e.dir) renderFilesTab(id, e.path);
    else openFileEditor(id, e.path, e.name);
  }));
  $$("#fm-table .fdel").forEach((el) => (el.onclick = async () => {
    const e = fmRows[Number(el.dataset.i)];
    if (!(await confirmDialog("Delete?", `<p>Delete <b class="mono">${esc(e.path)}</b>?</p>`, "Delete"))) return;
    try { await API.del(`/api/servers/${id}/file?path=${encodeURIComponent(e.path)}`); refreshFiles(id); }
    catch (err) { toast(err.message, "err"); }
  }));

  // A plain click toggles one row; shift-click paints every row between here
  // and the last one touched with whatever state this click landed on.
  $$("#fm-table .fsel").forEach((cb) => (cb.onclick = (ev) => {
    const i = Number(cb.dataset.i), on = cb.checked;
    const from = ev.shiftKey && fmAnchor !== null ? fmAnchor : i;
    for (let k = Math.min(from, i); k <= Math.max(from, i); k++) {
      if (on) fmSel.add(fmRows[k].path); else fmSel.delete(fmRows[k].path);
    }
    fmAnchor = i;
    syncSelection();
  }));
  $("#fm-all").onclick = () => {
    fmSel = $("#fm-all").checked ? new Set(fmRows.map((e) => e.path)) : new Set();
    fmAnchor = null;
    syncSelection();
  };
  $("#fm-clear").onclick = () => { fmSel = new Set(); fmAnchor = null; syncSelection(); };
  $("#fm-del-sel").onclick = () => deleteSelection(id);
  $("#fm-move").onclick = () => moveSelection(id);
  $("#fm-deep").onclick = () => deepSearch(id);
  $("#fm-sort").onclick = () => {
    fmPrefs.sort = fmPrefs.sort === "size" ? "name" : "size";
    saveFmPrefs();
    if (fmPrefs.sort === "size" && !fmPrefs.sizes) {
      fmPrefs.sizes = true;
      saveFmPrefs();
      $("#fm-sizes") && $("#fm-sizes").classList.add("on");
      loadDisk(id, fmDir);
    }
    paintFiles(id);
  };
  syncSelection();
}

// After a change, come back the way we came: re-run the search if one is on
// screen, otherwise just reload the folder.
function refreshFiles(id) {
  if (fmDeep) return deepSearch(id);
  return loadDir(id, fmDir, true); // something changed, so the sizes did too
}

// Repaint everything that depends on the selection without rebuilding the
// rows, so ticking a box costs no round trip and keeps the scroll position.
function syncSelection() {
  const n = fmSel.size;
  $$("#fm-table .fsel").forEach((cb) => {
    const on = fmSel.has(fmRows[Number(cb.dataset.i)].path);
    cb.checked = on;
    cb.closest(".file-row").classList.toggle("sel", on);
  });
  const all = $("#fm-all");
  all.checked = n > 0 && n === fmRows.length;
  all.indeterminate = n > 0 && n < fmRows.length;
  const total = fmDeep ? fmDeep.entries.length : fmEntries.length;
  $("#fm-count").textContent = n
    ? `${n} selected`
    : fmDeep
      ? `${fmRows.length} match${fmRows.length === 1 ? "" : "es"} under ${dirLabel(fmDir)}`
      : fmQuery.trim()
        ? `${fmRows.length} of ${total} item${total === 1 ? "" : "s"}`
        : `${total} item${total === 1 ? "" : "s"}`;
  $("#fm-acts").hidden = !n;
  $("#fm-deep").hidden = !(fmQuery.trim() && !fmDeep) || !!n;
}

// A batch runs entry by entry, so it can half-succeed. Say how far it got and
// why the rest stayed, rather than reporting a flat failure.
function reportBatch(out, verb) {
  const bad = out.errors || [];
  if (!bad.length) return toast(`${verb} ${out.done} item${out.done === 1 ? "" : "s"}.`, "ok");
  toast(`${verb} ${out.done}, ${bad.length} left: ${bad[0].error}`, out.done ? "" : "err");
}

async function deleteSelection(id) {
  const paths = [...fmSel];
  const shown = paths.slice(0, 8).map((p) => `<li class="mono">${esc(p)}</li>`).join("");
  const more = paths.length > 8 ? `<li class="muted">…and ${paths.length - 8} more</li>` : "";
  const ok = await confirmDialog("Delete selection?",
    `<p>Delete these ${paths.length} item${paths.length === 1 ? "" : "s"}? Folders go with everything inside them, and this can't be undone.</p>
     <ul class="fm-list">${shown}${more}</ul>`, "Delete");
  if (!ok) return;
  try {
    reportBatch(await API.post(`/api/servers/${id}/delete`, { paths }), "Deleted");
    refreshFiles(id);
  } catch (e) { toast(e.message, "err"); }
}

async function moveSelection(id) {
  const paths = [...fmSel];
  const dest = await pickFolder(id, paths);
  if (dest === null) return;
  try {
    reportBatch(await API.post(`/api/servers/${id}/move`, { paths, dest }), "Moved");
    refreshFiles(id);
  } catch (e) { toast(e.message, "err"); }
}

/* The destination picker browses the same sandbox the file table does, but
 * shows folders only. Anything in the selection is hidden from the list, since
 * dropping a folder inside itself would orphan its whole subtree. */
async function pickFolder(id, moving) {
  return new Promise((resolve) => {
    let cur = "";
    const blocked = (p) => moving.some((m) => p === m || p.startsWith(m + "/"));
    // Every entry already sitting in the folder it would move to is a no-op,
    // so "Move here" is only offered where it would actually change something.
    const pointless = () => moving.every((m) => parentOf(m) === cur);
    modal(`
      <div class="modal-head"><h2>Move ${moving.length} item${moving.length === 1 ? "" : "s"}</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <div class="breadcrumb" id="fp-crumb"></div>
        <div class="file-table fp-list" id="fp-list"></div>
        <p class="hint" style="margin-top:10px">Open a folder to move into it. Names are kept as they are.</p>
      </div>
      <div class="modal-foot"><span class="mono muted" id="fp-dest"></span>
        <div style="display:flex;gap:10px">
          <button class="btn btn-ghost" data-x>Cancel</button>
          <button class="btn btn-primary" id="fp-ok">Move here</button>
        </div>
      </div>`);
    const finish = (v) => { closeModal(); resolve(v); };
    $(".modal-close").onclick = $("[data-x]").onclick = () => finish(null);
    $("#fp-ok").onclick = () => finish(cur);
    draw();

    async function draw() {
      const list = $("#fp-list");
      const parts = cur ? cur.split("/") : [];
      $("#fp-crumb").innerHTML = `<a data-p="">⌂ root</a>` + parts.map((p, i) =>
        ` / <a data-p="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("");
      $$("#fp-crumb a").forEach((a) => (a.onclick = () => { cur = a.dataset.p; draw(); }));
      $("#fp-dest").textContent = "→ /" + cur;
      const ok = $("#fp-ok");
      ok.disabled = pointless();
      ok.title = ok.disabled ? "The selection is already in this folder" : "";
      list.innerHTML = `<div class="file-row"><span class="muted">Loading…</span></div>`;
      try {
        const data = await API.get(`/api/servers/${id}/files?path=${encodeURIComponent(cur)}`);
        const dirs = data.entries.filter((e) => e.dir && !blocked(joinPath(cur, e.name)));
        list.innerHTML = dirs.length ? dirs.map((e) => `
          <div class="file-row">
            <span class="fic">${ico("folder")}</span>
            <span class="fname dir" data-name="${esc(e.name)}">${esc(e.name)}</span>
          </div>`).join("") : `<div class="file-row"><span class="muted" style="padding:4px">No sub-folders here.</span></div>`;
        $$("#fp-list .fname").forEach((el) => (el.onclick = () => { cur = joinPath(cur, el.dataset.name); draw(); }));
      } catch (e) {
        list.innerHTML = `<div class="file-row"><span class="muted">${esc(e.message)}</span></div>`;
      }
    }
  });
}

function fileIcon(name) {
  if (/\.jar$/i.test(name)) return ico("box");
  if (/\.(png|jpg|jpeg|gif)$/i.test(name)) return ico("image");
  if (/\.(zip|gz)$/i.test(name)) return ico("archive");
  return ico("file");
}

const EDITABLE = /\.(properties|toml|json|json5|cfg|conf|yml|yaml|txt|log|md|sh|bat|mcmeta)$/i;
async function openFileEditor(id, path, name) {
  if (!EDITABLE.test(name)) { toast("That file type can't be edited here — only text files.", ""); return; }
  let content = "";
  try { content = (await API.get(`/api/servers/${id}/file?path=${encodeURIComponent(path)}`)).content; }
  catch (e) { toast(e.message, "err"); return; }
  modal(`
    <div class="modal-head"><h2>✎ ${esc(name)}</h2><button class="modal-close">×</button></div>
    <div class="modal-body"><textarea id="ed-area" style="height:52vh;min-height:320px" spellcheck="false">${esc(content)}</textarea></div>
    <div class="modal-foot"><span class="mono muted" style="font-size:12px">${esc(path)}</span>
      <div style="display:flex;gap:10px"><button class="btn btn-ghost" data-x>Cancel</button><button class="btn btn-primary" id="ed-save">Save</button></div>
    </div>`, { wide: true });
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  $("#ed-save").onclick = async () => {
    try { await API.put(`/api/servers/${id}/file?path=${encodeURIComponent(path)}`, { content: $("#ed-area").value }); closeModal(); toast("Saved.", "ok"); }
    catch (e) { toast(e.message, "err"); }
  };
}

/* -------------------------------------------------------------- backups tab */
/* A backup is a zip the panel keeps under data/backups. Making one while the
 * server runs is safe — the backend pauses autosave and flushes first — so the
 * button stays live for that. Restoring needs the server stopped. Progress
 * arrives on the global event stream as "backup" events. */
let bkData = null; // last /backups payload for the open server

const BK_PHASE = {
  starting: "Starting",
  saving: "Saving the world to disk",
  collecting: "Listing files",
  snapshotting: "Snapshotting Distant Horizons data",
  zipping: "Compressing",
  safety: "Backing up the current world first",
  extracting: "Unpacking",
  swapping: "Swapping the world in",
  copying: "Being copied to a new server",
};
const BK_SCOPE = { world: "World", full: "Whole server" };

async function renderBackupsTab(id) {
  bkData = null;
  $("#tab-body").innerHTML = `
    <div class="bk-make">
      <select id="bk-scope">
        <option value="world">World only</option>
        <option value="full">Whole server</option>
      </select>
      <input type="text" id="bk-note" maxlength="120" placeholder="Note (optional) — e.g. before updating mods" />
      <button class="btn btn-primary" id="bk-go">${ico("archive")} Back up now</button>
    </div>
    <div class="fm-prog" id="bk-prog" hidden>
      <div class="fm-prog-track"><i id="bk-prog-fill"></i></div>
      <span class="fm-prog-text" id="bk-prog-text"></span>
    </div>
    <div id="bk-list"><div class="pk-empty">Loading…</div></div>
    <p class="hint" style="margin-top:10px"><b>World only</b> is the world folder plus its Nether and End. <b>Whole server</b> adds mods, configs and jars too. Backing up a running server is safe — autosave is paused and the world flushed to disk first, and nobody gets kicked. Restoring needs the server stopped.</p>
    <div class="section-title">Automatic backups</div>
    <div id="bk-sched"></div>`;
  $("#bk-go").onclick = async () => {
    const btn = $("#bk-go");
    btn.disabled = true;
    try {
      await API.post(`/api/servers/${id}/backups`, { scope: $("#bk-scope").value, note: $("#bk-note").value.trim() });
      $("#bk-note").value = "";
    } catch (e) {
      toast(e.message, "err");
      btn.disabled = false;
    }
  };
  await loadBackups(id);
}

async function loadBackups(id) {
  try {
    bkData = await API.get(`/api/servers/${id}/backups`);
  } catch (e) {
    const box = $("#bk-list");
    if (box) box.innerHTML = `<div class="banner err" style="margin:0">${esc(e.message)}</div>`;
    return;
  }
  if (!$("#bk-list")) return; // tab changed while loading
  const opt = $('#bk-scope option[value="world"]');
  if (opt) opt.textContent = `World only (${bkData.level})`;
  paintBackups(id);
  paintBackupJob(bkData.job);
  paintBackupSchedule(id);
}

function paintBackups(id) {
  const box = $("#bk-list");
  if (!box || !bkData) return;
  const s = state.servers.get(id) || {};
  const stopped = s.status === "stopped" || s.status === "crashed";
  const busy = !!bkData.job;
  const list = bkData.backups;

  if (!list.length) {
    box.innerHTML = `<div class="file-table"><div class="pk-empty">${bkData.hasWorld
      ? "No backups yet."
      : "No world yet — start the server once and there will be something to back up."}</div></div>`;
    return;
  }
  box.innerHTML = `<div class="file-table">${list.map((b, i) => `
    <div class="file-row bk-row">
      <span class="fic">${ico("archive")}</span>
      <span class="fname"><b>${esc(fmtWhen(b.created))}</b>${b.auto ? ` <span class="badge">auto</span>` : ""}
        <span class="muted">${esc(BK_SCOPE[b.scope] || b.scope)} · ${fmtBytes(b.size)}${b.files ? ` · ${b.files.toLocaleString()} files` : ""}${b.mc ? ` · MC ${esc(b.mc)}` : ""}${b.note ? ` · ${esc(b.note)}` : ""}${
          b.skipped && b.skipped.length ? ` · ${b.skipped.length} locked file(s) skipped` : ""}</span></span>
      <div class="bk-acts">
        <a class="btn btn-sm btn-ghost" href="/api/servers/${esc(id)}/backups/${encodeURIComponent(b.file)}" download title="Download the zip">${ico("download")}</a>
        <button class="btn btn-sm" data-restore="${i}" ${stopped && !busy ? "" : "disabled"} title="${stopped ? "Restore this backup" : "Stop the server to restore"}">${ico("rotate")} Restore</button>
        <span class="fdel" data-del="${i}" title="Delete">${ico("trash")}</span>
      </div>
    </div>`).join("")}</div>`;

  $$("[data-restore]", box).forEach((el) => (el.onclick = () => restoreBackup(id, list[Number(el.dataset.restore)])));
  $$("[data-del]", box).forEach((el) => (el.onclick = async () => {
    const b = list[Number(el.dataset.del)];
    if (!(await confirmDialog("Delete backup?", `<p>Delete the backup from <b>${esc(fmtWhen(b.created))}</b>? This can't be undone.</p>`, "Delete"))) return;
    try { await API.del(`/api/servers/${id}/backups/${encodeURIComponent(b.file)}`); loadBackups(id); }
    catch (e) { toast(e.message, "err"); }
  }));
}

async function restoreBackup(id, b) {
  let safety = true;
  const asked = confirmDialog("Restore this backup?",
    `<p>Replace ${b.scope === "full" ? "<b>everything</b> in this server's folder" : "this server's <b>world</b>"} with the backup from <b>${esc(fmtWhen(b.created))}</b>?</p>
     <div class="switch-row" style="margin-top:12px">
       <label class="switch"><input type="checkbox" id="bk-safety" checked /><i></i></label>
       <div class="txt"><b>Back up what's there now first</b><span>So you can undo the restore if it wasn't the one you wanted.</span></div>
     </div>`,
    "Restore", true);
  $("#bk-safety").onchange = (ev) => (safety = ev.target.checked);
  if (!(await asked)) return;
  try { await API.post(`/api/servers/${id}/backups/${encodeURIComponent(b.file)}/restore`, { safety }); }
  catch (e) { toast(e.message, "err"); }
}

function paintBackupJob(job) {
  if (bkData) bkData.job = job;
  const prog = $("#bk-prog");
  if (!prog) return;
  const go = $("#bk-go");
  if (go) go.disabled = !!job;
  $$("#bk-list [data-restore]").forEach((b) => (b.disabled = !!job || b.title !== "Restore this backup"));
  if (!job) { prog.hidden = true; return; }
  prog.hidden = false;
  const counted = job.total && (job.phase === "zipping" || job.phase === "extracting" || job.phase === "safety");
  $("#bk-prog-fill").style.width = counted ? ((job.done / job.total) * 100).toFixed(1) + "%" : "4%";
  $("#bk-prog-text").textContent = `${job.kind === "restore" ? "Restoring · " : ""}${BK_PHASE[job.phase] || job.phase}${
    counted ? ` · ${job.done.toLocaleString()} of ${job.total.toLocaleString()} files` : "…"}`;
}

function paintBackupSchedule(id) {
  const box = $("#bk-sched");
  if (!box || !bkData) return;
  const sch = bkData.schedule;
  // Stored in hours; anything under two hours reads better in minutes.
  const mins = sch.every && sch.every < 2;
  const shown = sch.every ? (mins ? Math.round(sch.every * 60) : sch.every) : 6;
  box.innerHTML = `
    <div class="switch-row">
      <label class="switch"><input type="checkbox" id="bk-auto" ${sch.every ? "checked" : ""} /><i></i></label>
      <div class="txt"><b>Back up on a timer</b><span>Only while the server is running — a stopped world isn't changing.</span></div>
      <span class="unit">every</span>
      <input type="number" id="bk-every" min="5" max="720" value="${shown}" style="width:68px" ${sch.every ? "" : "disabled"} />
      <select id="bk-unit" ${sch.every ? "" : "disabled"}>
        <option value="min" ${mins ? "selected" : ""}>minutes</option>
        <option value="h" ${mins ? "" : "selected"}>hours</option>
      </select>
    </div>
    <div class="two-col" style="margin-top:14px">
      <div class="form-row"><label>Keep the newest</label><input type="number" id="bk-keep" min="1" max="200" value="${sch.keep}" />
        <div class="hint">automatic backups; older ones are deleted. Backups you make yourself are never deleted for you.</div></div>
      <div class="form-row"><label>What to back up</label>
        <select id="bk-auto-scope">
          <option value="world" ${sch.scope === "world" ? "selected" : ""}>World only</option>
          <option value="full" ${sch.scope === "full" ? "selected" : ""}>Whole server</option>
        </select></div>
    </div>
    <button class="btn btn-primary" id="bk-save">Save schedule</button>`;
  const sw = $("#bk-auto");
  sw.onchange = () => ($("#bk-every").disabled = $("#bk-unit").disabled = !sw.checked);
  $("#bk-save").onclick = async () => {
    try {
      const n = Number($("#bk-every").value) || 6;
      const hours = $("#bk-unit").value === "min" ? Math.max(5, n) / 60 : n;
      await API.patch(`/api/servers/${id}`, {
        backupEvery: sw.checked ? hours : 0,
        backupKeep: Number($("#bk-keep").value) || 7,
        backupScope: $("#bk-auto-scope").value,
      });
      toast(sw.checked ? "Automatic backups on." : "Automatic backups off.", "ok");
      loadBackups(id);
    } catch (e) { toast(e.message, "err"); }
  };
}

/* ------------------------------------------------------- properties tab */
/* server.properties gets a real form. The file on disk stays the source of
 * truth: we parse it, draw one control per key, and write back only the keys
 * that were actually touched, so comments, ordering and any keys we don't
 * know about survive untouched. A raw editor is one click away. */

const BOOL = "bool", INT = "int", TXT = "text", SEL = "sel", SECRET = "secret";

const PROP_GROUPS = [
  { title: "Gameplay", icon: "sliders", open: true, items: [
    { k: "gamemode", n: "Default game mode", t: SEL, d: "survival", desc: "Mode new players join in.",
      opts: [["survival", "Survival"], ["creative", "Creative"], ["adventure", "Adventure"], ["spectator", "Spectator"]] },
    { k: "force-gamemode", n: "Force game mode", t: BOOL, d: "false", desc: "Put returning players back into the default mode on every join." },
    { k: "difficulty", n: "Difficulty", t: SEL, d: "easy", desc: "Peaceful removes hostile mobs entirely.",
      opts: [["peaceful", "Peaceful"], ["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]] },
    { k: "hardcore", n: "Hardcore", t: BOOL, d: "false", desc: "Death is permanent — players are switched to spectator. Locks difficulty to hard." },
    { k: "pvp", n: "Player vs player", t: BOOL, d: "true", desc: "Let players damage each other directly." },
    { k: "allow-flight", n: "Allow flight", t: BOOL, d: "false", desc: "Stops the anti-cheat kicking players who fly. Needed for most flight mods." },
    { k: "enable-command-block", n: "Command blocks", t: BOOL, d: "false", desc: "Allow command blocks to be placed and run." },
    { k: "spawn-protection", n: "Spawn protection", t: INT, d: "16", min: 0, max: 512, unit: "blocks", desc: "Radius around spawn only operators can build in. 0 disables it." },
    { k: "player-idle-timeout", n: "Idle kick", t: INT, d: "0", min: 0, max: 1440, unit: "min", desc: "Kick players after this many idle minutes. 0 never kicks." },
    { k: "op-permission-level", n: "Operator level", t: SEL, d: "4", desc: "How much power the /op command hands out.",
      opts: [["1", "1 — bypass spawn protection"], ["2", "2 — singleplayer cheats"], ["3", "3 — player management"], ["4", "4 — full control"]] },
    { k: "function-permission-level", n: "Function level", t: SEL, d: "2", desc: "Permission level datapack functions run at.",
      opts: [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]] },
  ] },

  { title: "Players & access", icon: "users", open: true, items: [
    { k: "motd", n: "Message of the day", t: TXT, d: "A Minecraft Server", wide: true, motd: true,
      desc: "The line shown under the server name in the client's server list. §-codes colour it." },
    { k: "max-players", n: "Max players", t: INT, d: "20", min: 1, max: 2000, desc: "Also editable in Settings, which keeps the panel's player counter in sync." },
    { k: "online-mode", n: "Online mode", t: BOOL, d: "true", desc: "Verify every player against Mojang's servers. Turning this off lets anyone join under any name." },
    { k: "white-list", n: "Whitelist", t: BOOL, d: "false", desc: "Only players on the whitelist may join. Manage it with /whitelist add." },
    { k: "enforce-whitelist", n: "Enforce whitelist", t: BOOL, d: "false", desc: "Kick players already online the moment they fall off the whitelist." },
    { k: "enforce-secure-profile", n: "Require signed chat", t: BOOL, d: "true", desc: "Reject players without a Mojang chat signing key." },
    { k: "hide-online-players", n: "Hide player list", t: BOOL, d: "false", desc: "Don't reveal who is online in the server list ping." },
  ] },

  { title: "World", icon: "map", open: true, items: [
    { k: "level-name", n: "World folder", t: TXT, d: "world", desc: "Folder the world lives in. A new name generates a fresh world." },
    { k: "level-seed", n: "Seed", t: TXT, d: "", ph: "random", desc: "Only used the first time the world generates." },
    { k: "level-type", n: "World type", t: SEL, d: "minecraft:normal", desc: "Terrain generator for a newly created world.",
      opts: [["minecraft:normal", "Normal"], ["minecraft:flat", "Superflat"], ["minecraft:large_biomes", "Large biomes"],
             ["minecraft:amplified", "Amplified"], ["minecraft:single_biome_surface", "Single biome"]] },
    { k: "generate-structures", n: "Generate structures", t: BOOL, d: "true", desc: "Villages, temples, strongholds and the rest." },
    { k: "allow-nether", n: "Allow the Nether", t: BOOL, d: "true", desc: "Off makes nether portals inert." },
    { k: "spawn-monsters", n: "Spawn monsters", t: BOOL, d: "true", desc: "Hostile mobs. Difficulty peaceful overrides this." },
    { k: "spawn-animals", n: "Spawn animals", t: BOOL, d: "true", desc: "Passive mobs like cows and sheep." },
    { k: "spawn-npcs", n: "Spawn villagers", t: BOOL, d: "true", desc: "Villagers in generated villages." },
    { k: "max-world-size", n: "World border", t: INT, d: "29999984", min: 1, max: 29999984, unit: "blocks", desc: "Maximum radius the world can be explored to." },
    { k: "generator-settings", n: "Generator settings", t: TXT, d: "{}", desc: "JSON for superflat / single-biome layouts. Advanced." },
    { k: "initial-enabled-packs", n: "Enabled datapacks", t: TXT, d: "vanilla", desc: "Packs switched on when the world is first created." },
    { k: "initial-disabled-packs", n: "Disabled datapacks", t: TXT, d: "", desc: "Packs switched off when the world is first created." },
  ] },

  { title: "Performance", icon: "gauge", open: false, items: [
    { k: "view-distance", n: "View distance", t: INT, d: "10", min: 2, max: 32, unit: "chunks", desc: "How far players can see. The single biggest lever on CPU and bandwidth." },
    { k: "simulation-distance", n: "Simulation distance", t: INT, d: "10", min: 2, max: 32, unit: "chunks", desc: "How far entities, redstone and crops keep ticking." },
    { k: "entity-broadcast-range-percentage", n: "Entity range", t: INT, d: "100", min: 10, max: 1000, unit: "%", desc: "Distance at which entities are sent to clients. Lower is lighter." },
    { k: "max-tick-time", n: "Watchdog timeout", t: INT, d: "60000", min: -1, unit: "ms", desc: "Crash the server if a tick hangs this long. -1 disables the watchdog." },
    { k: "pause-when-empty-seconds", n: "Pause when empty", t: INT, d: "60", min: -1, unit: "sec", desc: "Seconds of emptiness before the server stops ticking. Saving here moves the Settings sleep switch to match; -1 is off." },
    { k: "network-compression-threshold", n: "Compression threshold", t: INT, d: "256", min: -1, unit: "bytes", desc: "Compress packets above this size. -1 disables compression." },
    { k: "sync-chunk-writes", n: "Sync chunk writes", t: BOOL, d: "true", desc: "Flush chunks to disk immediately. Off is faster but riskier on a crash." },
    { k: "max-chained-neighbor-updates", n: "Chained block updates", t: INT, d: "1000000", desc: "Cap on consecutive neighbour updates before the rest are dropped." },
    { k: "region-file-compression", n: "Region compression", t: SEL, d: "deflate", desc: "Trade disk space against CPU when saving regions.",
      opts: [["deflate", "Deflate — smallest"], ["lz4", "LZ4 — fastest"], ["none", "None"]] },
    { k: "use-native-transport", n: "Native transport", t: BOOL, d: "true", desc: "Linux-only optimised networking. Ignored elsewhere." },
  ] },

  { title: "Resource pack", icon: "box", open: false, items: [
    { k: "resource-pack", n: "Pack URL", t: TXT, d: "", ph: "https://…", desc: "Direct download link to a .zip resource pack." },
    { k: "resource-pack-sha1", n: "Pack SHA-1", t: TXT, d: "", desc: "Checksum of the zip. Without it clients re-download every join." },
    { k: "require-resource-pack", n: "Require the pack", t: BOOL, d: "false", desc: "Kick players who decline it." },
    { k: "resource-pack-prompt", n: "Prompt text", t: TXT, d: "", wide: true, desc: "JSON chat component shown in the accept dialog." },
    { k: "resource-pack-id", n: "Pack UUID", t: TXT, d: "", desc: "Optional UUID identifying the pack." },
  ] },

  { title: "Network & remote access", icon: "globe", open: false, items: [
    { k: "server-port", n: "Game port", t: INT, d: "25565", min: 1, max: 65535, desc: "Port Minecraft listens on. Settings changes this too, and keeps the panel in sync." },
    { k: "server-ip", n: "Bind address", t: TXT, d: "", ph: "all interfaces", desc: "Leave blank unless the machine has several addresses." },
    { k: "enable-status", n: "Answer server pings", t: BOOL, d: "true", desc: "Off hides the server from the client's list — it still accepts joins." },
    { k: "prevent-proxy-connections", n: "Block proxies", t: BOOL, d: "false", desc: "Refuse players whose Mojang-reported region doesn't match their IP." },
    { k: "accepts-transfers", n: "Accept transfers", t: BOOL, d: "false", desc: "Allow players transferred here from another server." },
    { k: "rate-limit", n: "Packet rate limit", t: INT, d: "0", min: 0, unit: "pkt/s", desc: "Kick players who exceed this. 0 is unlimited." },
    { k: "log-ips", n: "Log IP addresses", t: BOOL, d: "true", desc: "Write player IPs to the console and log files." },
    { k: "broadcast-console-to-ops", n: "Echo console to ops", t: BOOL, d: "true", desc: "Show commands run from the console to online operators." },
    { k: "enable-query", n: "GameSpy query", t: BOOL, d: "false", desc: "Expose player counts and mods to query tools." },
    { k: "query.port", n: "Query port", t: INT, d: "25565", min: 1, max: 65535 },
    { k: "enable-rcon", n: "RCON", t: BOOL, d: "false", desc: "Remote console access. Only enable with a strong password." },
    { k: "rcon.port", n: "RCON port", t: INT, d: "25575", min: 1, max: 65535 },
    { k: "rcon.password", n: "RCON password", t: SECRET, d: "", desc: "Stored in plain text in server.properties." },
    { k: "broadcast-rcon-to-ops", n: "Echo RCON to ops", t: BOOL, d: "true", desc: "Show RCON commands to online operators." },
  ] },

  { title: "Advanced", icon: "flask", open: false, items: [
    { k: "enable-jmx-monitoring", n: "JMX monitoring", t: BOOL, d: "false", desc: "Expose tick metrics over JMX." },
    { k: "debug", n: "Debug mode", t: BOOL, d: "false", desc: "Very verbose logging." },
    { k: "bug-report-link", n: "Bug report link", t: TXT, d: "", ph: "https://…", desc: "URL offered to players on a crash." },
    { k: "text-filtering-config", n: "Text filter config", t: TXT, d: "", desc: "Endpoint for chat filtering. Rarely used." },
    { k: "text-filtering-version", n: "Text filter version", t: INT, d: "0", min: 0 },
  ] },
];

const PROP_INDEX = new Map();
for (const g of PROP_GROUPS) for (const it of g.items) PROP_INDEX.set(it.k, it);

function parseProps(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*([\w.-]+)\s*=(.*)$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// server.properties is a Java properties file, so Minecraft escapes colons and
// non-ASCII on write. Show the human form in the inputs; we write values back
// plainly, which the loader is equally happy with.
function propUnesc(v) {
  return String(v ?? "")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([:=\\])/g, "$1");
}

// Rebuild the file with `changes` merged in, leaving every other line — blank
// lines, comments, keys we know nothing about — exactly where it was.
function serializeProps(text, changes) {
  const lines = String(text || "").split(/\r?\n/);
  const seen = new Set();
  const out = lines.map((line) => {
    const m = /^([\w.-]+)\s*=(.*)$/.exec(line);
    if (m && changes[m[1]] !== undefined) { seen.add(m[1]); return `${m[1]}=${changes[m[1]]}`; }
    return line;
  });
  while (out.length && !out[out.length - 1].trim()) out.pop();
  for (const [k, v] of Object.entries(changes)) if (!seen.has(k)) out.push(`${k}=${v}`);
  const body = out.join("\n").replace(/^\n+|\n+$/g, "");
  return body ? body + "\n" : "";
}

const MC_COLORS = { 0: "#000000", 1: "#0000aa", 2: "#00aa00", 3: "#00aaaa", 4: "#aa0000", 5: "#aa00aa",
  6: "#ffaa00", 7: "#aaaaaa", 8: "#555555", 9: "#5555ff", a: "#55ff55", b: "#55ffff", c: "#ff5555",
  d: "#ff55ff", e: "#ffff55", f: "#ffffff" };

// Render §-codes the way the client's server list does, so the motd can be
// tuned without alt-tabbing into Minecraft.
function motdPreviewHTML(raw) {
  const src = String(raw || "").replace(/\\n/g, "\n");
  let st = { color: "", b: false, i: false, u: false, s: false };
  let html = "", buf = "";
  const flush = () => {
    if (!buf) return;
    const css = [st.color ? `color:${st.color}` : "", st.b ? "font-weight:700" : "", st.i ? "font-style:italic" : "",
      st.u || st.s ? `text-decoration:${[st.u ? "underline" : "", st.s ? "line-through" : ""].filter(Boolean).join(" ")}` : ""]
      .filter(Boolean).join(";");
    html += `<span style="${css}">${esc(buf)}</span>`;
    buf = "";
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\n") { flush(); html += "<br>"; continue; }
    if (ch !== "§" || i === src.length - 1) { buf += ch; continue; }
    const code = src[++i].toLowerCase();
    flush();
    if (MC_COLORS[code]) st = { color: MC_COLORS[code], b: false, i: false, u: false, s: false };
    else if (code === "l") st.b = true;
    else if (code === "o") st.i = true;
    else if (code === "n") st.u = true;
    else if (code === "m") st.s = true;
    else if (code === "r") st = { color: "", b: false, i: false, u: false, s: false };
  }
  flush();
  return html || `<span class="muted">—</span>`;
}

async function renderPropertiesTab(id) {
  const body = $("#tab-body");
  body.innerHTML = `<div class="muted" style="padding:24px 2px"><span class="spinner"></span> Reading server.properties…</div>`;
  let text, def;
  try {
    const [p, d] = await Promise.all([API.get(`/api/servers/${id}/properties`), API.get(`/api/servers/${id}`)]);
    text = p.text || "";
    def = d.def || {};
  } catch (e) {
    body.innerHTML = `<div class="banner err">Couldn't read server.properties — ${esc(e.message)}</div>`;
    return;
  }
  if (state.route.id !== id || state.activeTab !== "properties") return;
  drawProperties(id, text, def);
}

function drawProperties(id, text, def) {
  const body = $("#tab-body");


  // Nothing on disk yet: Minecraft writes the file on its first run. Show the
  // vanilla defaults, with this server's own port and slots filled in, and let
  // Save create the file up front.
  const fresh = !text.trim();
  const onDisk = parseProps(text);
  const start = {};
  if (fresh) {
    for (const [k, it] of PROP_INDEX) start[k] = it.d;
    if (def.port) start["server-port"] = start["query.port"] = String(def.port);
    if (def.maxPlayers) start["max-players"] = String(def.maxPlayers);
    if (def.name) start["motd"] = `${def.name} — powered by MC Hoster`;
  }
  Object.assign(start, onDisk);

  const cur = { ...start };
  const extras = Object.keys(onDisk).filter((k) => !PROP_INDEX.has(k)).sort();
  let rawMode = false;

  const isDirty = (k) => cur[k] !== start[k];
  const dirtyKeys = () => Object.keys(cur).filter(isDirty);

  const ctlHTML = (it, val) => {
    const v = propUnesc(val);
    if (it.t === BOOL) {
      const on = /^true$/i.test(String(val).trim());
      return `<label class="switch"><input type="checkbox" data-k="${esc(it.k)}" ${on ? "checked" : ""} /><i></i></label>`;
    }
    if (it.t === SEL) {
      const opts = it.opts.slice();
      if (!opts.some(([o]) => o === val)) opts.push([val, `${val} (from file)`]);
      return `<select data-k="${esc(it.k)}">${opts.map(([o, lbl]) =>
        `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(lbl)}</option>`).join("")}</select>`;
    }
    if (it.t === INT) {
      return `<input type="number" data-k="${esc(it.k)}" value="${esc(v)}"
        ${it.min !== undefined ? `min="${it.min}"` : ""} ${it.max !== undefined ? `max="${it.max}"` : ""} />
        ${it.unit ? `<span class="unit">${esc(it.unit)}</span>` : ""}`;
    }
    if (it.t === SECRET) {
      return `<input type="password" data-k="${esc(it.k)}" value="${esc(v)}" autocomplete="new-password" />
        <button class="btn btn-ghost btn-sm prop-eye" data-eye="${esc(it.k)}" title="Show">${ico("eye")}</button>`;
    }
    return `<input type="text" data-k="${esc(it.k)}" ${it.mono ? 'class="mono"' : ""} value="${esc(v)}" placeholder="${esc(it.ph || "")}" />`;
  };

  const rowHTML = (it) => {
    const missing = cur[it.k] === undefined;
    return `<div class="prop${it.wide ? " wide" : ""}" data-row="${esc(it.k)}"
        data-find="${esc((it.k + " " + it.n + " " + (it.desc || "")).toLowerCase())}">
      <div class="prop-txt">
        <b>${esc(it.n)}<span class="dot" title="Unsaved change">●</span></b>
        <span class="k">${esc(it.k)}</span>${missing ? `<span class="k miss">not in file</span>` : ""}
        ${it.desc ? `<span class="d">${esc(it.desc)}</span>` : ""}
      </div>
      <div class="prop-ctl">
        ${ctlHTML(it, missing ? it.d : cur[it.k])}
        <button class="btn btn-ghost btn-sm prop-undo" data-undo="${esc(it.k)}" title="Undo this change">↺</button>
      </div>
      ${it.motd ? `<div class="motd-prev"><span class="tag">in-game</span><div class="motd-txt" id="motd-prev"></div></div>` : ""}
    </div>`;
  };

  const groupHTML = (g, items, note) => `
    <details class="prop-group" ${g.open ? "open" : ""} data-group>
      <summary><span class="gi">${ico(g.icon)}</span><span class="gt">${esc(g.title)}</span>
        <span class="gcount">${items.length}</span><span class="caret">▸</span></summary>
      <div class="prop-list">${note || ""}${items.map(rowHTML).join("")}</div>
    </details>`;

  const guessType = (v) => /^(true|false)$/i.test(String(v).trim()) ? BOOL : TXT;
  const extraItems = extras.map((k) => ({ k, n: k, t: guessType(onDisk[k]), d: "", mono: true }));

  body.innerHTML = `
    <div class="prop-bar">
      <input type="text" id="prop-search" placeholder="Search settings…" autocomplete="off" />
      <span class="prop-count" id="prop-count"></span>
      <button class="btn btn-sm" id="prop-raw">${ico("file")} Raw file</button>
      <button class="btn btn-sm btn-ghost" id="prop-undo-all" disabled>Discard</button>
      <button class="btn btn-sm btn-primary" id="prop-save" disabled>Save</button>
    </div>
    ${fresh
      ? `<div class="banner warn">This server hasn't generated its <span class="mono">server.properties</span> yet — these are the defaults. Saving writes the file now; Minecraft fills in anything missing on first start.</div>`
      : `<div class="prop-hint">Changes are written to <span class="mono">server.properties</span> and apply on the next start or restart.</div>`}
    <div id="prop-form">
      ${PROP_GROUPS.map((g) => groupHTML(g, g.items)).join("")}
      ${extraItems.length
        ? groupHTML({ title: "Other keys in this file", icon: "folder", open: false }, extraItems,
            `<div class="prop-note">Keys this panel doesn't know — usually written by a mod or an older Minecraft version. Edited as plain text.</div>`)
        : ""}
    </div>
    <div id="prop-raw-box" style="display:none">
      <textarea id="prop-raw-area" style="height:56vh;min-height:340px" spellcheck="false"></textarea>
    </div>`;

  const form = $("#prop-form"), rawBox = $("#prop-raw-box"), rawArea = $("#prop-raw-area");
  const saveBtn = $("#prop-save"), undoAllBtn = $("#prop-undo-all"), countEl = $("#prop-count");
  const search = $("#prop-search");

  const readCtl = (el) => {
    if (el.type === "checkbox") return el.checked ? "true" : "false";
    if (el.type !== "number") return el.value;
    const it = PROP_INDEX.get(el.dataset.k) || {};
    let n = Number(el.value);
    if (el.value === "" || !Number.isFinite(n)) return it.d ?? "";
    if (it.min !== undefined) n = Math.max(it.min, n);
    if (it.max !== undefined) n = Math.min(it.max, n);
    return String(Math.trunc(n));
  };

  const paintRow = (k) => {
    const row = form.querySelector(`[data-row="${CSS.escape(k)}"]`);
    if (!row) return;
    const dirty = isDirty(k);
    row.classList.toggle("dirty", dirty);
    const undo = $(".prop-undo", row);
    if (undo) undo.style.visibility = dirty ? "visible" : "hidden";
  };

  function refresh() {
    const n = dirtyKeys().length;
    saveBtn.disabled = !(n || fresh);
    undoAllBtn.disabled = !n;
    saveBtn.textContent = fresh ? "Create file" : n ? `Save ${n} change${n === 1 ? "" : "s"}` : "Save";
    countEl.textContent = n ? `${n} unsaved` : "";
    const prev = $("#motd-prev"), motdIn = form.querySelector('[data-k="motd"]');
    if (prev) prev.innerHTML = motdPreviewHTML(motdIn ? motdIn.value : cur["motd"]);
  }

  $$("[data-k]", form).forEach((el) => {
    const k = el.dataset.k;
    const on = () => { cur[k] = readCtl(el); paintRow(k); refresh(); };
    el.oninput = on;
    el.onchange = on;
    // Clamping happens on read, so echo the clamped number back once the field
    // is done being typed in — otherwise the box and the file disagree.
    if (el.type === "number") el.onblur = () => { el.value = cur[k]; };
  });

  $$("[data-undo]", form).forEach((b) => (b.onclick = () => {
    const k = b.dataset.undo, el = form.querySelector(`[data-k="${CSS.escape(k)}"]`);
    cur[k] = start[k];
    const back = start[k] !== undefined ? start[k] : (PROP_INDEX.get(k) || {}).d || "";
    if (el.type === "checkbox") el.checked = /^true$/i.test(String(back).trim());
    else el.value = propUnesc(back);
    paintRow(k); refresh();
  }));

  $$("[data-eye]", form).forEach((b) => (b.onclick = () => {
    const el = form.querySelector(`[data-k="${CSS.escape(b.dataset.eye)}"]`);
    el.type = el.type === "password" ? "text" : "password";
    b.classList.toggle("on", el.type === "text");
  }));

  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    $$("[data-group]", form).forEach((g) => {
      let hits = 0;
      $$("[data-row]", g).forEach((r) => {
        const show = !q || r.dataset.find.includes(q);
        r.style.display = show ? "" : "none";
        if (show) hits++;
      });
      g.style.display = hits ? "" : "none";
      if (q) g.open = true;
      $(".gcount", g).textContent = hits;
    });
  };

  // Everything the form would write, as the finished file.
  function pending() {
    const changes = {};
    for (const k of (fresh ? Object.keys(cur) : dirtyKeys())) changes[k] = cur[k];
    return serializeProps(fresh ? "#Minecraft server properties" : text, changes);
  }

  $("#prop-raw").onclick = () => {
    rawMode = !rawMode;
    if (rawMode) {
      rawArea.value = pending();
      form.style.display = "none";
      rawBox.style.display = "";
      $("#prop-raw").textContent = "Form";
      search.disabled = true;
      saveBtn.disabled = false;
      saveBtn.textContent = "Save file";
    } else {
      drawProperties(id, rawArea.value, def); // reparse whatever the text now says
    }
  };

  saveBtn.onclick = async () => {
    const out = rawMode ? rawArea.value : pending();
    saveBtn.disabled = true;
    try {
      await API.put(`/api/servers/${id}/properties`, { text: out });
      const s = state.servers.get(id);
      toast(s && s.status === "running" ? "Saved — restart to apply." : "Saved.", "ok");
      renderPropertiesTab(id);
    } catch (e) { saveBtn.disabled = false; toast(e.message, "err"); }
  };

  undoAllBtn.onclick = () => drawProperties(id, text, def);

  $$("[data-row]", form).forEach((r) => paintRow(r.dataset.row));
  refresh();
}

/* -------------------------------------------------------------- settings tab */
async function renderSettingsTab(id) {
  const s = state.servers.get(id);
  const data = await API.get(`/api/servers/${id}`);
  const def = data.def;
  const pauseOn = Number(def.pauseWhenEmpty) > 0;
  const pauseSecs = pauseOn ? Number(def.pauseWhenEmpty) : 60;
  const canPause = data.pauseSupported !== false;
  const sleepOn = Number(def.sleepAfter) > 0;
  const sleepMins = sleepOn ? Number(def.sleepAfter) : 30;
  const wakeOn = !!def.wakeOnJoin;
  const crashOn = def.restartOnCrash !== false;
  const withPanel = !!def.startWithPanel;
  const lagOn = Number(def.lagRestartTps) > 0;
  const lagTps = lagOn ? Number(def.lagRestartTps) : 12;
  const lagMins = Number(def.lagRestartMins) || 10;
  const body = $("#tab-body");
  body.innerHTML = `
    <div style="max-width:620px">
      <div class="form-row"><label>Server name</label><input type="text" id="st-name" value="${esc(def.name)}" /></div>
      <div class="form-row"><label>Icon</label><input type="text" id="st-icon" value="${esc(def.icon || "")}" maxlength="4" style="width:90px" placeholder="—" />
        <div class="hint">An emoji, if you want one. Left blank the server shows its initial.</div></div>
      <div class="two-col">
        <div class="form-row"><label>Game port</label><input type="number" id="st-port" value="${def.port}" /></div>
        <div class="form-row"><label>Max players</label><input type="number" id="st-max" value="${def.maxPlayers}" /></div>
      </div>
      <div class="form-row">
        <label>Memory (RAM)</label>
        <div class="range-row"><input type="range" id="st-mem" min="1024" max="16384" step="512" value="${def.memory}" /><span class="range-val" id="st-memv">${fmtMem(def.memory)}</span></div>
      </div>
      <div class="form-row">
        <label>Custom JVM arguments <span class="muted">(optional, advanced)</span></label>
        <input type="text" id="st-jvm" class="mono" value="${esc(def.jvmArgs || "")}" placeholder="-XX:+UseG1GC …" />
        <div class="hint">Added after the auto memory flags. Aikar's flags go here.</div>
      </div>
      <div class="form-row">
        <label>Java runtime override <span class="muted">(optional)</span></label>
        <input type="text" id="st-java" class="mono" value="${esc(def.javaPath || "")}" placeholder="uses global default: ${esc(state.javas[0]?.path || "none found")}" />
      </div>
      <div class="form-row">
        <label>Sleep when empty</label>
        <div class="switch-row">
          <label class="switch"><input type="checkbox" id="st-pause" ${pauseOn ? "checked" : ""} ${canPause ? "" : "disabled"} /><i></i></label>
          <div class="txt"><b>Pause while nobody is online</b><span>CPU drops to almost nothing. The server stays up and RAM stays reserved, so rejoining is instant.</span></div>
          <input type="number" id="st-pause-secs" min="10" step="10" value="${pauseSecs}" style="width:72px" ${pauseOn && canPause ? "" : "disabled"} />
          <span class="unit">sec</span>
        </div>
        <div class="hint">${canPause
          ? "Seconds of emptiness before pausing. Nothing ticks while paused — crops, furnaces, redstone and the daylight cycle all stop, including in spawn and force-loaded chunks."
          : `Minecraft ${esc(def.mc)} cannot pause — the setting arrived in 1.21.2.`}</div>
      </div>
      <div class="form-row">
        <label>Deep sleep</label>
        <div class="switch-row">
          <label class="switch"><input type="checkbox" id="st-sleep" ${sleepOn ? "checked" : ""} /><i></i></label>
          <div class="txt"><b>Shut down while nobody is online</b><span>Gives the RAM back to the machine. Works on every Minecraft version.</span></div>
          <input type="number" id="st-sleep-mins" min="1" step="5" value="${sleepMins}" style="width:72px" ${sleepOn ? "" : "disabled"} />
          <span class="unit">min</span>
        </div>
        <div class="hint">Minutes empty before the server stops itself. Waking it is a full boot, so give a big modpack room.</div>
      </div>
      <div class="form-row">
        <label>Wake on join</label>
        <div class="switch-row">
          <label class="switch"><input type="checkbox" id="st-wake" ${wakeOn ? "checked" : ""} /><i></i></label>
          <div class="txt"><b>Start the server when someone tries to join</b><span>While it is stopped the panel holds the port, shows it as Sleeping in the server list, and boots it the moment anyone connects.</span></div>
        </div>
        <div class="hint">The player who knocks is asked to reconnect once it is up — nobody can join mid-boot, so a big modpack still means a couple of minutes in the queue. The port is only held while the server is stopped.</div>
      </div>
      <div class="form-row">
        <label>Restart on crash</label>
        <div class="switch-row">
          <label class="switch"><input type="checkbox" id="st-crash" ${crashOn ? "checked" : ""} /><i></i></label>
          <div class="txt"><b>Start it again if it crashes</b><span>Restarts 10 seconds after a crash. Stopping it yourself never triggers this.</span></div>
        </div>
        <div class="hint">After 3 crashes within 10 minutes it stays down, so a broken mod can't leave it restarting forever. Press Start once you've fixed it.</div>
      </div>
      <div class="form-row">
        <label>Start with panel</label>
        <div class="switch-row">
          <label class="switch"><input type="checkbox" id="st-withpanel" ${withPanel ? "checked" : ""} /><i></i></label>
          <div class="txt"><b>Start this server when MC Hoster starts</b><span>Brings it back after a reboot or a panel restart, unless you'd stopped it yourself.</span></div>
        </div>
        <div class="hint">If several servers have this on, they start 20 seconds apart. For it to work after a PC reboot, MC Hoster itself also has to start on boot, for example with autostart on in Rack.</div>
      </div>
      <div class="form-row">
        <label>Restart on poor performance</label>
        <div class="switch-row">
          <label class="switch"><input type="checkbox" id="st-lag" ${lagOn ? "checked" : ""} ${s && s.stats && s.stats.tpsSupport === "no" ? "disabled" : ""} /><i></i></label>
          <div class="txt"><b>Restart when TPS stays below</b><span>Clears memory leaks and piled-up lag. Players get a 30-second warning in chat.</span></div>
          <input type="number" id="st-lag-tps" min="1" max="19" step="1" value="${lagTps}" style="width:64px" ${lagOn ? "" : "disabled"} />
          <span class="unit">TPS for</span>
          <input type="number" id="st-lag-mins" min="1" max="240" step="1" value="${lagMins}" style="width:64px" ${lagOn ? "" : "disabled"} />
          <span class="unit">min</span>
        </div>
        <div class="hint">${s && s.stats && s.stats.tpsSupport === "no"
          ? "This server doesn't report its TPS (that needs Minecraft 1.20.3+, or Paper, Purpur, Forge or NeoForge), so there's nothing to watch."
          : "20 TPS is full speed. The first 5 minutes after a start don't count, and neither does time spent paused. After 3 restarts in 3 hours it stops trying and leaves the server running."}</div>
      </div>
      <div style="display:flex;gap:10px;margin-top:8px"><button class="btn btn-primary" id="st-save">Save changes</button></div>

      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Scheduled uptime</div>
      <div id="st-sched"></div>

      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Public address</div>
      <div id="st-playit"></div>

      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Voice chat</div>
      <div id="st-voice" class="form-row"></div>

      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Duplicate</div>
      <div class="banner dup-banner">
        <div>Make a new server from this one — its world, its ${esc(s.content && s.content.folder !== "datapacks" ? s.content.noun.toLowerCase() : "configs")}, or both. This server isn't changed.</div>
        <div class="b-actions"><button class="btn" id="st-dup">${ico("copy")} Duplicate…</button></div>
      </div>

      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Export or move</div>
      <div class="banner dup-banner">
        <div>Save this server as a file, or send it to MC Hoster on another computer. Bring it in there with <b>Import</b> on the dashboard. This server isn't changed.</div>
        <div class="b-actions"><button class="btn" id="st-export">${ico("upload")} Export…</button></div>
      </div>
      <div id="st-exports"></div>

      <div class="divider"></div>
      <div class="section-title" style="color:var(--danger)">Danger zone</div>
      <div class="banner err" style="align-items:center">
        <div>Delete this server and all its files (world, mods, configs). This cannot be undone.</div>
        <div class="b-actions"><button class="btn btn-red" id="st-delete">Delete server</button></div>
      </div>
    </div>`;
  const mem = $("#st-mem"); paintRange(mem); mem.oninput = () => ($("#st-memv").textContent = fmtMem(Number(mem.value)));
  const pauseSw = $("#st-pause"); pauseSw.onchange = () => ($("#st-pause-secs").disabled = !pauseSw.checked);
  const sleepSw = $("#st-sleep"); sleepSw.onchange = () => ($("#st-sleep-mins").disabled = !sleepSw.checked);
  const wakeSw = $("#st-wake");
  const lagSw = $("#st-lag");
  lagSw.onchange = () => ($("#st-lag-tps").disabled = $("#st-lag-mins").disabled = !lagSw.checked);
  renderServerSchedule(id, data.schedule);
  renderServerPlayit(id);
  voiceDisk.set(id, data.voice || {});
  renderServerVoice(id);
  $("#st-save").onclick = async () => {
    try {
      await API.patch(`/api/servers/${id}`, {
        name: $("#st-name").value.trim(), icon: $("#st-icon").value.trim(),
        port: Number($("#st-port").value), maxPlayers: Number($("#st-max").value),
        memory: Number(mem.value), jvmArgs: $("#st-jvm").value.trim(), javaPath: $("#st-java").value.trim() || null,
        pauseWhenEmpty: pauseSw.checked ? Number($("#st-pause-secs").value) || 60 : 0,
        sleepAfter: sleepSw.checked ? Number($("#st-sleep-mins").value) || 30 : 0,
        wakeOnJoin: wakeSw.checked,
        restartOnCrash: $("#st-crash").checked,
        startWithPanel: $("#st-withpanel").checked,
        lagRestartTps: lagSw.checked ? Number($("#st-lag-tps").value) || 12 : 0,
        lagRestartMins: Number($("#st-lag-mins").value) || 10,
      });
      toast("Settings saved.", "ok");
      const fresh = await API.get(`/api/servers/${id}`); state.servers.set(id, fresh.server); renderServer(id);
    } catch (e) { toast(e.message, "err"); }
  };
  $("#st-dup").onclick = () => openDuplicate(id);
  $("#st-export").onclick = () => openExport(id);
  loadServerExports(id);
  $("#st-delete").onclick = async () => {
    const pl = state.servers.get(id)?.playit;
    if (!(await confirmDialog("Delete server?",
      `<p>Permanently delete <b>${esc(def.name)}</b>, every file it owns and all of its backups?</p>
       <p class="muted">Stop it first if it's running.${pl && pl.enabled ? " Its playit.gg tunnel is removed from your account too." : ""}</p>`,
      "Delete forever"))) return;
    try { await API.del(`/api/servers/${id}`); state.servers.delete(id); toast("Server deleted.", "ok"); go("#/"); }
    catch (e) { toast(e.message, "err"); }
  };
}

/* --------------------------------------------------------------- duplicate */
/* A new server made from this one. The server software always comes along, so
 * the copy starts without installing anything; the world, mods/plugins,
 * configs and player lists are each a choice. The backend sizes each part from
 * the Files tab's measurement and does the copying as the new server's install. */
const DUP_PRESETS = {
  all: { label: "Everything", world: true, content: true, config: true, players: true },
  world: { label: "World only", world: true, content: false, config: true, players: true },
  content: { label: "Fresh world", world: false, content: true, config: true, players: true },
  none: { label: "Fresh start", world: false, content: false, config: false, players: false },
};

// The part checkboxes and quick picks Duplicate and Export share. `plan` is
// what /duplicate (or /export) measured; the server software always comes.
function planParts(plan) {
  const noun = plan.content ? plan.content.noun : "Mods";
  return [
    { k: "world", title: "World", desc: plan.level
        ? `<code>${esc(plan.level)}</code> with its Nether and End${plan.datapacks ? ", datapacks included" : ""}`
        : "No world yet — the copy makes its own on first start", has: plan.has.world },
    plan.content && { k: "content", title: noun, desc: `everything in <code>${esc(plan.content.folder)}/</code>${plan.content.folder === "plugins" ? ", plugin settings included" : ""}`, has: plan.has.content },
    { k: "config", title: "Configs", desc: "<code>server.properties</code>, <code>config/</code> and the other settings files", has: plan.has.config },
    { k: "players", title: "Player lists", desc: "ops, whitelist and bans", has: plan.has.players },
  ].filter(Boolean);
}

function partsPickerHTML(plan, s) {
  const noun = plan.content ? plan.content.noun : "Mods";
  return `
    <div class="seg seg-sm pp-presets" style="margin-bottom:10px;flex-wrap:wrap">
      ${Object.entries(DUP_PRESETS).filter(([k]) => plan.content || k !== "world")
        .map(([k, p]) => `<button class="seg-btn" data-p="${k}">${esc(k === "content" ? (plan.content ? `${noun}, fresh world` : "Fresh world") : p.label)}</button>`).join("")}
    </div>
    <div class="dup-parts">
      ${planParts(plan).map((p) => `
        <label class="dup-part ${p.has ? "" : "empty"}">
          <input type="checkbox" data-k="${p.k}" ${p.has ? "" : "disabled"} />
          <span class="dup-txt"><b>${esc(p.title)}</b><span>${p.has ? p.desc : p.k === "world" ? p.desc : "Nothing here yet"}</span></span>
          <span class="dup-size">${p.has ? fmtBytes(plan.sizes[p.k]) : "—"}</span>
        </label>`).join("")}
      <div class="dup-part always">
        <span class="dup-tick">${ico("check")}</span>
        <span class="dup-txt"><b>Server software</b><span>${esc(cap(s.modLoader || s.loader || ""))} for Minecraft ${esc(s.mc || "")} — always included, so nothing needs installing</span></span>
        <span class="dup-size">${fmtBytes(plan.sizes.software)}</span>
      </div>
    </div>`;
}

// Wires the picker inside `root`; `onPaint({on, bytes, noun})` runs on every
// change. Returns { opts() } — the ticked parts, as the backend takes them.
function bindPartsPicker(root, plan, onPaint) {
  const parts = planParts(plan);
  const noun = plan.content ? plan.content.noun : "Mods";
  const pick = { ...DUP_PRESETS.all };
  const box = (k) => $(`[data-k="${k}"]`, root);
  const on = (k) => { const c = box(k); return !!c && c.checked; };
  const paint = () => {
    $$("[data-k]", root).forEach((c) => { if (!c.disabled) c.checked = !!pick[c.dataset.k]; });
    const preset = Object.entries(DUP_PRESETS).find(([, p]) => parts.every((x) => !x.has || !!p[x.k] === on(x.k)));
    $$(".pp-presets .seg-btn", root).forEach((b) => b.classList.toggle("on", !!preset && preset[0] === b.dataset.p));
    const bytes = plan.sizes.software + parts.reduce((a, p) => a + (on(p.k) ? plan.sizes[p.k] : 0), 0);
    onPaint({ on, bytes, noun });
  };
  $$(".pp-presets .seg-btn", root).forEach((b) => (b.onclick = () => { Object.assign(pick, DUP_PRESETS[b.dataset.p]); paint(); }));
  $$("[data-k]", root).forEach((c) => (c.onchange = () => { pick[c.dataset.k] = c.checked; paint(); }));
  paint();
  return { opts: () => Object.fromEntries($$("[data-k]", root).map((c) => [c.dataset.k, c.checked])) };
}

async function openDuplicate(id) {
  const s = state.servers.get(id) || {};
  modal(`
    <div class="modal-head"><h2>Duplicate ${esc(s.name)}</h2><button class="modal-close">×</button></div>
    <div class="modal-body" id="dup-body"><p class="muted"><span class="spinner"></span> Measuring the server folder…</p></div>
    <div class="modal-foot"><span class="muted" id="dup-total"></span><div style="display:flex;gap:10px">
      <button class="btn btn-ghost" data-x>Cancel</button>
      <button class="btn btn-primary" id="dup-go" disabled>${ico("copy")} Duplicate</button>
    </div></div>`);
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  let plan;
  try { plan = await API.get(`/api/servers/${id}/duplicate`); }
  catch (e) {
    const b = $("#dup-body"); if (b) b.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
    return;
  }
  const body = $("#dup-body");
  if (!body) return; // closed while measuring

  body.innerHTML = `
    <div class="two-col">
      <div class="form-row"><label>Name</label><input type="text" id="dup-name" maxlength="64" value="${esc(plan.name)}" /></div>
      <div class="form-row"><label>Game port</label><input type="number" id="dup-port" min="1" max="65535" value="${plan.port}" /></div>
    </div>
    <div class="form-row">
      <label>What to copy</label>
      ${partsPickerHTML(plan, s)}
      <div class="hint" style="margin-top:8px">Logs, backups, stats and player history stay with the original. So do its public address, opening hours and "start with panel".</div>
    </div>
    <div id="dup-warn"></div>`;

  const picker = bindPartsPicker(body, plan, ({ on, bytes, noun }) => {
    $("#dup-total").textContent = `About ${fmtBytes(bytes)} to copy`;
    let warn = "";
    if (plan.modded && on("world") && plan.has.content && !on("content"))
      warn += `<div class="banner warn">The world was played with ${esc(noun.toLowerCase())}. Opening it without them deletes their blocks, items and creatures from the copy — for good.</div>`;
    if (on("world") && plan.running)
      warn += `<div class="hint">${esc(s.name)} is running, so it saves its world first and pauses autosaving until the copy has it. Players stay connected.</div>`;
    $("#dup-warn").innerHTML = warn;
  });

  const btn = $("#dup-go");
  btn.disabled = false;
  btn.onclick = async () => {
    const opts = picker.opts();
    btn.disabled = true;
    try {
      const r = await API.post(`/api/servers/${id}/duplicate`, {
        ...opts, name: $("#dup-name").value.trim(), port: Number($("#dup-port").value),
      });
      state.servers.set(r.server.id, r.server);
      closeModal();
      toast(`Copying to ${r.server.name}…`, "ok");
      state.activeTab = "console"; // the copy's progress is on its console
      go("#/server/" + r.server.id);
    } catch (e) { btn.disabled = false; toast(e.message, "err"); }
  };
}

/* ------------------------------------------------------- export and import */
/* Moving a server to another MC Hoster: export it to a zip (downloaded, saved
 * in a folder on the panel computer, or sent straight to another panel), and
 * import that zip on the other side. The zip carries the server folder plus
 * mchoster.json saying what it is, so the other panel needs nothing else. */
const EX_MODES = {
  download: { label: "Download", icon: "download" },
  folder: { label: "Save to a folder", icon: "folder" },
  send: { label: "Send to another panel", icon: "globe" },
};
const EX_PHASE = { starting: "Starting", saving: "Saving the world", collecting: "Listing files", zipping: "Packing", connecting: "Reaching the other panel", sending: "Sending", importing: "Handing it over" };
const PART_LABEL = { world: "World", content: "Mods", config: "Configs", players: "Player lists" };
let exView = null; // the open export dialog: { id, mode, eid }

const lsGet = (k) => { try { return localStorage.getItem(k) || ""; } catch { return ""; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

function partsText(parts, noun = "Mods") {
  return parts && parts.length ? parts.map((p) => (p === "content" ? noun : PART_LABEL[p] || p)).join(", ") : "Server software only";
}

async function openExport(id) {
  const s = state.servers.get(id) || {};
  modal(`
    <div class="modal-head"><h2>Export ${esc(s.name)}</h2><button class="modal-close">×</button></div>
    <div class="modal-body" id="ex-body"><p class="muted"><span class="spinner"></span> Measuring the server folder…</p></div>
    <div class="modal-foot"><span class="muted" id="ex-total"></span><div style="display:flex;gap:10px" id="ex-foot">
      <button class="btn btn-ghost" data-x>Cancel</button>
      <button class="btn btn-primary" id="ex-go" disabled>${ico("upload")} Export</button>
    </div></div>`);
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  modalCleanup = () => (exView = null);
  let plan;
  try { plan = await API.get(`/api/servers/${id}/export`); }
  catch (e) {
    const b = $("#ex-body"); if (b) b.innerHTML = `<div class="banner err">${esc(e.message)}</div>`;
    return;
  }
  const body = $("#ex-body");
  if (!body) return; // closed while measuring
  let mode = EX_MODES[lsGet("mch-export-mode")] ? lsGet("mch-export-mode") : "download";
  const lan = (state.lan || [])[0];

  body.innerHTML = `
    <div class="form-row">
      <label>What to take</label>
      ${partsPickerHTML(plan, s)}
      <div class="hint" style="margin-top:8px">Logs, backups, stats and player history stay here. So do the public address, opening hours, "start with panel" and the Java path — the other panel finds its own Java.</div>
    </div>
    <div id="ex-warn"></div>
    <div class="form-row">
      <label>Where to</label>
      <div class="seg seg-sm" id="ex-modes" style="flex-wrap:wrap">
        ${Object.entries(EX_MODES).map(([k, m]) => `<button class="seg-btn" data-m="${k}">${ico(m.icon)} ${esc(m.label)}</button>`).join("")}
      </div>
      <div id="ex-where" style="margin-top:10px"></div>
    </div>`;

  const where = () => {
    $$("#ex-modes .seg-btn").forEach((b) => b.classList.toggle("on", b.dataset.m === mode));
    $("#ex-where").innerHTML = mode === "download"
      ? `<div class="hint">The zip downloads to this device. A copy stays on the panel computer under <b>Settings → Export or move</b> until you delete it, so you can send it on later.</div>`
      : mode === "folder"
      ? `<input type="text" id="ex-dir" class="mono" placeholder="${esc(plan.defaultDir)}" value="${esc(lsGet("mch-export-dir"))}" />
         <div class="hint">A folder on the computer running the panel: a USB stick, a network share, or another MC Hoster's folder. Leave it empty for the panel's own <code>data/exports</code>.</div>`
      : `<input type="text" id="ex-to" class="mono" placeholder="192.168.1.20:8100" value="${esc(lsGet("mch-send-to"))}" />
         <div class="hint">The other panel's address. On that computer it's under <b>Settings → On your phone</b>${lan ? ` (this one is <code>${esc(lan)}</code>)` : ""}. Both computers need to be on the same network, and the server arrives there as a new server. This one isn't changed.</div>`;
  };
  $$("#ex-modes .seg-btn").forEach((b) => (b.onclick = () => { mode = b.dataset.m; lsSet("mch-export-mode", mode); where(); }));
  where();

  const picker = bindPartsPicker(body, plan, ({ on, bytes, noun }) => {
    $("#ex-total").textContent = `About ${fmtBytes(bytes)} before packing`;
    let warn = "";
    if (plan.modded && on("world") && plan.has.content && !on("content"))
      warn += `<div class="banner warn">The world was played with ${esc(noun.toLowerCase())}. Opening it somewhere without them deletes their blocks, items and creatures from it — for good.</div>`;
    if (on("world") && plan.running)
      warn += `<div class="hint">${esc(s.name)} is running, so it saves its world first and pauses autosaving until the export has it. Players stay connected.</div>`;
    $("#ex-warn").innerHTML = warn;
  });

  const btn = $("#ex-go");
  btn.disabled = false;
  btn.onclick = async () => {
    const spec = picker.opts();
    if (mode === "folder") { spec.dir = $("#ex-dir").value.trim(); lsSet("mch-export-dir", spec.dir); }
    if (mode === "send") {
      spec.send = $("#ex-to").value.trim();
      if (!spec.send) return toast("Type the other panel's address.", "err");
      lsSet("mch-send-to", spec.send);
    }
    btn.disabled = true;
    // Listening before asking: a small server can be packed before the answer lands.
    exView = { id, mode, eid: null, started: false };
    try {
      await API.post(`/api/servers/${id}/export`, spec);
      if (exView && !exView.started) paintExportProgress({ kind: "export", phase: "starting" });
    } catch (e) { exView = { id: null }; btn.disabled = false; toast(e.message, "err"); }
  };
}

// Sending an export that already exists, from the list in Settings.
function openSendExport(e) {
  const lan = (state.lan || [])[0];
  modal(`
    <div class="modal-head"><h2>Send to another panel</h2><button class="modal-close">×</button></div>
    <div class="modal-body" id="ex-body">
      <p class="muted" style="margin-top:0">${esc(e.serverName)} · ${esc(fmtWhen(e.created))} · ${fmtBytes(e.size)}</p>
      <div class="form-row"><label>The other panel's address</label>
        <input type="text" id="ex-to" class="mono" placeholder="192.168.1.20:8100" value="${esc(lsGet("mch-send-to"))}" />
        <div class="hint">On that computer it's under <b>Settings → On your phone</b>${lan ? ` (this one is <code>${esc(lan)}</code>)` : ""}. The server arrives there as a new server.</div></div>
    </div>
    <div class="modal-foot"><span class="muted" id="ex-total"></span><div style="display:flex;gap:10px" id="ex-foot">
      <button class="btn btn-ghost" data-x>Cancel</button>
      <button class="btn btn-primary" id="ex-go">${ico("globe")} Send</button>
    </div></div>`);
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  modalCleanup = () => (exView = null);
  $("#ex-to").focus();
  $("#ex-go").onclick = async () => {
    const to = $("#ex-to").value.trim();
    if (!to) return toast("Type the other panel's address.", "err");
    lsSet("mch-send-to", to);
    $("#ex-go").disabled = true;
    exView = { id: e.serverId, mode: "send", eid: e.id, started: false };
    try {
      await API.post(`/api/exports/${encodeURIComponent(e.id)}/send`, { to });
      if (exView && !exView.started) paintExportProgress({ kind: "send", phase: "connecting", to });
    } catch (err) { exView = { id: null }; $("#ex-go").disabled = false; toast(err.message, "err"); }
  };
}

// The dialog's body once the work has started. `job` is an export job
// ({phase, done, total}) or a send ({phase, sent, total}).
function paintExportProgress(job) {
  const body = $("#ex-body");
  if (!body || !exView) return;
  exView.started = true;
  $("#ex-total").textContent = "";
  $("#ex-foot").innerHTML = `<button class="btn btn-ghost" data-x>Close</button>`;
  $("#ex-foot [data-x]").onclick = closeModal;
  const sending = job.sent != null || job.kind === "send";
  const frac = sending ? (job.total ? job.sent / job.total : 0) : job.phase === "zipping" && job.total ? job.done / job.total : 0;
  const detail = sending
    ? job.phase === "sending" ? ` · ${fmtBytes(job.sent || 0)} of ${fmtBytes(job.total)}` : "…"
    : job.phase === "zipping" && job.total ? ` · ${job.done.toLocaleString()} of ${job.total.toLocaleString()} files` : "…";
  const to = job.to || (exView.mode === "send" ? lsGet("mch-send-to") : "");
  body.innerHTML = `
    <p style="margin-top:0">${sending ? `Sending to <code>${esc(job.host || to)}</code>.` : "Packing the server into a zip."} You can close this — it carries on, and the console says when it's done.</p>
    <div class="fm-prog"><div class="fm-prog-track"><i style="width:${Math.max(4, frac * 100).toFixed(1)}%"></i></div>
      <span class="fm-prog-text">${esc(EX_PHASE[job.phase] || job.phase)}${detail}</span></div>`;
}

function paintExportDone(r) {
  const body = $("#ex-body");
  if (!body || !exView) return;
  exView.started = true;
  $("#ex-total").textContent = "";
  $("#ex-foot").innerHTML = `<button class="btn btn-ghost" data-x>Close</button>`;
  $("#ex-foot [data-x]").onclick = closeModal;
  if (!r.ok) {
    body.innerHTML = `<div class="banner err">${esc(r.error)}</div>`;
    return;
  }
  if (r.kind === "send") {
    body.innerHTML = `
      <div class="banner ex-done">${ico("check")} <b>${esc(r.name)}</b> arrived on ${esc(r.host || r.to)} and is unpacking there now. It shows up there as a new server; accept the EULA if asked, then hit Start.</div>
      <a class="btn" href="${esc(r.url)}" target="_blank" rel="noopener">${ico("external")} Open it on the other panel</a>`;
    return;
  }
  const e = r.export;
  exView.eid = e.id;
  if (exView.mode === "send") return; // the send carries on; its events paint the rest
  const dl = `/api/exports/${encodeURIComponent(e.id)}`;
  body.innerHTML = exView.mode === "folder"
    ? `<div class="banner ex-done">${ico("check")} Saved ${fmtBytes(e.size)} to <code>${esc(e.path)}</code>.</div>
       <div class="hint">To bring it in on another MC Hoster, use <b>Import</b> on its dashboard and give it this file.</div>`
    : `<div class="banner ex-done">${ico("check")} Exported ${fmtBytes(e.size)} — ${e.files.toLocaleString()} files.</div>
       <a class="btn btn-primary" href="${dl}" download>${ico("download")} Download again</a>
       <div class="hint" style="margin-top:10px">To bring it in on another MC Hoster, use <b>Import</b> on its dashboard and give it this file.</div>`;
  if (exView.mode === "download") {
    const a = document.createElement("a");
    a.href = dl; a.download = e.file; document.body.appendChild(a); a.click(); a.remove();
  }
}

function onTransferEvent(e) {
  const name = (state.servers.get(e.id) || {}).name || "Server";
  const mine = exView && exView.id === e.id;
  if (e.received) toast(`Receiving ${e.received.name}${e.received.from ? ` from ${e.received.from}` : ""}…`, "ok");
  if (mine && e.job) paintExportProgress(e.job);
  if (mine && e.send && (!exView.eid || exView.eid === e.send.eid)) { exView.eid = e.send.eid; paintExportProgress(e.send); }
  const r = e.result;
  if (r) {
    if (mine && (r.kind !== "send" || r.eid === exView.eid)) paintExportDone(r);
    else if (r.kind === "send") toast(r.ok ? `${name} arrived on ${r.host || r.to}.` : `${name}: sending failed — ${r.error}`, r.ok ? "ok" : "err");
    else toast(r.ok ? `${name}: exported.` : `${name}: export failed — ${r.error}`, r.ok ? "ok" : "err");
  }
  if (state.route.name === "server" && state.route.id === e.id && $("#st-exports")) {
    if (r) loadServerExports(e.id);
    else if (e.send) paintSendRow(e.send);
  }
}

// Settings → Export or move: this server's exports, wherever they were saved.
async function loadServerExports(id) {
  const box = $("#st-exports");
  if (!box) return;
  let data;
  try { data = await API.get("/api/exports"); }
  catch (e) { box.innerHTML = `<div class="banner err">${esc(e.message)}</div>`; return; }
  if (!$("#st-exports")) return;
  const s = state.servers.get(id) || {};
  const noun = s.content && s.content.folder !== "datapacks" ? s.content.noun : "Mods";
  const list = data.exports.filter((x) => x.serverId === id);
  if (!list.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="file-table" style="margin-top:12px">${list.map((x, i) => `
    <div class="file-row bk-row" data-eid="${esc(x.id)}">
      <span class="fic">${ico("archive")}</span>
      <span class="fname"><b>${esc(fmtWhen(x.created))}</b>
        <span class="muted">${esc(partsText(x.parts, noun))} · ${fmtBytes(x.size)}${x.external ? ` · <span class="mono">${esc(x.path)}</span>` : ""}</span>
        <span class="muted ex-sending" hidden></span></span>
      <div class="bk-acts">
        <a class="btn btn-sm btn-ghost" href="/api/exports/${encodeURIComponent(x.id)}" download title="Download the zip">${ico("download")}</a>
        <button class="btn btn-sm" data-send="${i}">${ico("globe")} Send…</button>
        <span class="fdel" data-del="${i}" title="Delete">${ico("trash")}</span>
      </div>
    </div>`).join("")}</div>`;
  $$("[data-send]", box).forEach((b) => (b.onclick = () => openSendExport(list[Number(b.dataset.send)])));
  $$("[data-del]", box).forEach((el) => (el.onclick = async () => {
    const x = list[Number(el.dataset.del)];
    if (!(await confirmDialog("Delete export?", `<p>Delete the export from <b>${esc(fmtWhen(x.created))}</b>${x.external ? ` at <code>${esc(x.path)}</code>` : ""}? The server itself isn't touched.</p>`, "Delete"))) return;
    try { await API.del(`/api/exports/${encodeURIComponent(x.id)}`); loadServerExports(id); }
    catch (err) { toast(err.message, "err"); }
  }));
  for (const job of data.sending || []) paintSendRow(job);
}

function paintSendRow(job) {
  const row = $(`#st-exports [data-eid="${CSS.escape(job.eid)}"]`);
  if (!row) return;
  const line = $(".ex-sending", row);
  line.hidden = false;
  line.textContent = job.phase === "sending" && job.total
    ? `Sending to ${job.host || job.to} · ${Math.floor((job.sent / job.total) * 100)}%`
    : `${EX_PHASE[job.phase] || job.phase} · ${job.to}`;
  const b = $("[data-send]", row);
  if (b) b.disabled = true;
}

/* Import: a zip from this device, a path on the panel computer, or an export
 * this panel already has. Staged first, so you see what's in it and pick its
 * name and port before a server is made. */
async function openImport() {
  let token = null; // a staged upload not yet imported, cancelled if the dialog closes
  let xhr = null;
  modal(`
    <div class="modal-head"><h2>Import a server</h2><button class="modal-close">×</button></div>
    <div class="modal-body" id="im-body"></div>
    <div class="modal-foot"><span class="muted" id="im-note"></span><div style="display:flex;gap:10px" id="im-foot"></div></div>`);
  $(".modal-close").onclick = closeModal;
  modalCleanup = () => {
    if (xhr) xhr.abort();
    if (token) API.post("/api/import/cancel", { token }).catch(() => {});
  };

  const pickSource = async () => {
    token = null;
    const lan = (state.lan || [])[0];
    $("#im-note").textContent = "";
    $("#im-foot").innerHTML = `<button class="btn btn-ghost" data-x>Cancel</button>`;
    $("#im-foot [data-x]").onclick = closeModal;
    $("#im-body").innerHTML = `
      <label class="im-drop" id="im-drop">
        <input type="file" id="im-file" accept=".zip,application/zip" hidden />
        <span class="im-drop-ic">${ico("upload")}</span>
        <b>Drop an export here, or choose the file</b>
        <span class="muted">A <code>.zip</code> made with <b>Export</b> on any MC Hoster</span>
      </label>
      <div class="form-row" style="margin-top:16px"><label>Or a file on the panel computer</label>
        <div style="display:flex;gap:8px"><input type="text" id="im-path" class="mono" placeholder="D:\\Minecraft exports\\Survival_2026-10-20.zip" />
          <button class="btn" id="im-path-go">Open</button></div>
        <div class="hint">Quicker for a big world: nothing goes through the browser.</div></div>
      <div id="im-local"></div>
      <div class="hint" style="margin-top:14px">Moving from another panel on your network? On that one, open the server's <b>Settings → Export or move</b>, choose <b>Send to another panel</b> and give it ${lan ? `<code>${esc(lan)}</code>` : "this panel's address"}. It arrives here without this dialog.</div>`;
    const drop = $("#im-drop"), file = $("#im-file");
    file.onchange = () => file.files[0] && upload(file.files[0]);
    drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (ev) => {
      ev.preventDefault();
      drop.classList.remove("over");
      const f = ev.dataTransfer.files[0];
      if (f) upload(f);
    });
    const byPath = async () => {
      const p = $("#im-path").value.trim();
      if (!p) return;
      try { show(await API.post("/api/import/inspect", { path: p })); } catch (e) { toast(e.message, "err"); }
    };
    $("#im-path-go").onclick = byPath;
    $("#im-path").onkeydown = (ev) => { if (ev.key === "Enter") byPath(); };

    // Exports this panel made — handy to bring back a server that was deleted.
    try {
      const { exports } = await API.get("/api/exports");
      const box = $("#im-local");
      if (!box || !exports.length) return;
      box.innerHTML = `<div class="form-row" style="margin-top:4px"><label>Or an export on this panel</label>
        <div class="file-table">${exports.slice(0, 8).map((x, i) => `
          <div class="file-row bk-row">
            <span class="fic">${ico("archive")}</span>
            <span class="fname"><b>${esc(x.serverName)}</b>
              <span class="muted">${esc(fmtWhen(x.created))} · ${esc(cap(x.modLoader || x.loader))} ${esc(x.mc)} · ${fmtBytes(x.size)}${state.servers.has(x.serverId) ? "" : " · deleted since"}</span></span>
            <div class="bk-acts"><button class="btn btn-sm" data-pick="${i}">Use</button></div>
          </div>`).join("")}</div></div>`;
      $$("[data-pick]", box).forEach((b) => (b.onclick = async () => {
        try { show(await API.post("/api/import/inspect", { export: exports[Number(b.dataset.pick)].id })); } catch (e) { toast(e.message, "err"); }
      }));
    } catch {}
  };

  const upload = (f) => {
    if (!/\.zip$/i.test(f.name)) return toast("That isn't a .zip — pick an export made with MC Hoster.", "err");
    $("#im-body").innerHTML = `
      <p style="margin-top:0">Uploading <b>${esc(f.name)}</b> (${fmtBytes(f.size)})…</p>
      <div class="fm-prog"><div class="fm-prog-track"><i id="im-fill" style="width:2%"></i></div><span class="fm-prog-text" id="im-prog">0%</span></div>`;
    const req = (xhr = new XMLHttpRequest());
    req.open("POST", `/api/import/upload?name=${encodeURIComponent(f.name)}`);
    req.upload.onprogress = (ev) => {
      if (!ev.lengthComputable || !$("#im-fill")) return;
      const pct = (ev.loaded / ev.total) * 100;
      $("#im-fill").style.width = Math.max(2, pct).toFixed(1) + "%";
      $("#im-prog").textContent = pct >= 100 ? "Reading it…" : `${Math.floor(pct)}% · ${fmtBytes(ev.loaded)}`;
    };
    req.onload = () => {
      xhr = null;
      let data = {};
      try { data = JSON.parse(req.responseText); } catch {}
      if (req.status !== 200 || !data.token) { toast(data.error || `Upload failed (HTTP ${req.status})`, "err"); return pickSource(); }
      show(data);
    };
    req.onerror = () => { xhr = null; toast("The upload was cut off.", "err"); pickSource(); };
    req.send(f);
  };

  const show = (info) => {
    token = info.token;
    const body = $("#im-body");
    if (!body) return;
    const noun = ["paper", "purpur"].includes(info.modLoader || info.loader) ? "Plugins" : "Mods";
    const o = info.original;
    body.innerHTML = `
      <div class="im-sum">
        <div class="srv-card-emoji">${initialTile(o.name)}</div>
        <div><b>${esc(o.name)}</b>
          <div class="row" style="margin-top:4px">
            <span class="badge loader">${esc(cap(info.modLoader || info.loader))}</span>
            <span class="badge mc">${esc(info.mc)}</span>
            ${info.pack ? `<span class="badge">${esc(info.pack.name || "Modpack")}</span>` : ""}
          </div>
          <div class="muted" style="font-size:12px;margin-top:6px">${esc(partsText(info.parts, noun))} · ${fmtBytes(info.size)}${o.host ? ` · from ${esc(o.host)}` : ""}${o.exportedAt ? ` · exported ${esc(fmtWhen(o.exportedAt))}` : ""}</div>
        </div>
      </div>
      <div class="two-col" style="margin-top:16px">
        <div class="form-row"><label>Name</label><input type="text" id="im-name" maxlength="64" value="${esc(info.name)}" /></div>
        <div class="form-row"><label>Game port</label><input type="number" id="im-port" min="1" max="65535" value="${info.port}" />
          ${o.port && o.port !== info.port ? `<div class="hint">It used ${o.port} before, which a server here already has.</div>` : ""}</div>
      </div>
      ${info.parts.includes("world") ? "" : `<div class="hint">No world in this export — it makes a fresh one on first start.</div>`}
      ${info.otherPlatform ? `<div class="hint" style="margin-top:8px">Exported on a different kind of computer. That's fine: the panel picks the right Java here, downloading it if needed.</div>` : ""}`;
    $("#im-foot").innerHTML = `<button class="btn btn-ghost" id="im-back">← Back</button><button class="btn btn-primary" id="im-go">${ico("download")} Import</button>`;
    $("#im-back").onclick = () => { API.post("/api/import/cancel", { token }).catch(() => {}); pickSource(); };
    $("#im-go").onclick = async () => {
      $("#im-go").disabled = true;
      try {
        const r = await API.post("/api/import", { token, name: $("#im-name").value.trim(), port: Number($("#im-port").value) });
        token = null;
        state.servers.set(r.server.id, r.server);
        closeModal();
        toast(`Importing ${r.server.name}…`, "ok");
        state.activeTab = "console"; // the unpacking shows on its console
        go("#/server/" + r.server.id);
      } catch (e) {
        $("#im-go").disabled = false;
        toast(e.message, "err");
        if (/expired/.test(e.message)) pickSource();
      }
    };
  };

  pickSource();
}

// Opening hours for a server: weekday chips and a from/to pair per window. The
// panel starts it as a window opens and stops it as the last one closes; the
// times are the panel computer's clock, which is said when the browser's differs.
const SCHED_DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]];
const SCHED_PRESETS = {
  evenings: [{ days: [1, 2, 3, 4, 5], from: "16:00", to: "23:00" }, { days: [6, 0], from: "10:00", to: "00:00" }],
  weekends: [{ days: [5], from: "16:00", to: "00:00" }, { days: [6], from: "00:00", to: "00:00" }, { days: [0], from: "00:00", to: "22:00" }],
  daily: [{ days: [0, 1, 2, 3, 4, 5, 6], from: "08:00", to: "23:00" }],
};

function fmtSchedNext(n) {
  if (!n) return "it stays up all week";
  const d = new Date(n.at);
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(new Date())) / 86400000);
  const day = days === 0 ? "today" : days === 1 ? "tomorrow" : d.toLocaleDateString([], { weekday: "long" });
  return `${n.kind === "start" ? "starts" : "stops"} ${day} at ${t}`;
}

function renderServerSchedule(id, sch) {
  const box = $("#st-sched");
  if (!box) return;
  sch = sch || {};
  let wins = (sch.windows && sch.windows.length ? sch.windows : SCHED_PRESETS.evenings).map((w) => ({ ...w, days: [...w.days] }));
  const browserZone = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return null; } })();
  const zoneNote = sch.zone && browserZone && sch.zone !== browserZone
    ? ` Times are on the panel computer's clock (<b>${esc(sch.zone)}</b>), not this device's.`
    : "";

  box.innerHTML = `
    <div class="switch-row">
      <label class="switch"><input type="checkbox" id="sch-on" ${sch.on ? "checked" : ""} /><i></i></label>
      <div class="txt"><b>Only run this server at set times</b><span>Starts it when a window opens and stops it when it closes. Start and Stop still work in between.</span></div>
    </div>
    <div id="sch-body" class="sched-body">
      <div class="sched-presets"><span class="unit">Quick fill:</span>
        <button class="plog-chip" data-preset="evenings">Evenings &amp; weekends</button>
        <button class="plog-chip" data-preset="weekends">Weekends only</button>
        <button class="plog-chip" data-preset="daily">Every day, 8 am – 11 pm</button>
      </div>
      <div id="sch-wins"></div>
      <button class="btn btn-sm btn-ghost" id="sch-add">${ico("plus")} Add window</button>
      <div class="form-row" style="margin-top:16px">
        <label>At closing time, if players are still on</label>
        <div class="sched-close">
          <select id="sch-players">
            <option value="warn" ${sch.players !== "wait" ? "selected" : ""}>Warn them, then stop after</option>
            <option value="wait" ${sch.players === "wait" ? "selected" : ""}>Wait until the last one leaves</option>
          </select>
          <input type="number" id="sch-warn" min="1" max="60" value="${Number(sch.warnMins) || 5}" style="width:72px" />
          <span class="unit" id="sch-warn-unit">min</span>
        </div>
      </div>
    </div>
    <div class="hint" id="sch-status" style="margin:10px 0 12px"></div>
    <button class="btn btn-primary" id="sch-save">Save schedule</button>`;

  const paintWins = () => {
    $("#sch-wins").innerHTML = wins.map((w, i) => `
      <div class="sched-win" data-i="${i}">
        <div class="sched-days">${SCHED_DAYS.map(([d, n]) =>
          `<button class="plog-chip ${w.days.includes(d) ? "on" : ""}" data-day="${d}">${n}</button>`).join("")}</div>
        <div class="sched-times">
          <input type="time" class="sch-from" value="${esc(w.from)}" />
          <span class="unit">to</span>
          <input type="time" class="sch-to" value="${esc(w.to)}" />
          <button class="btn btn-sm btn-ghost btn-icon" data-del title="Remove this window" ${wins.length < 2 ? "disabled" : ""}>${ico("trash")}</button>
        </div>
        ${w.to <= w.from ? `<div class="hint">${w.to === w.from ? "The whole 24 hours." : w.to === "00:00" ? "Until midnight." : "Runs past midnight into the next day."}</div>` : ""}
      </div>`).join("");
    $$("#sch-wins .sched-win").forEach((row) => {
      const w = wins[Number(row.dataset.i)];
      $$("[data-day]", row).forEach((b) => (b.onclick = () => {
        const d = Number(b.dataset.day);
        w.days = w.days.includes(d) ? w.days.filter((x) => x !== d) : [...w.days, d];
        paintWins();
      }));
      $(".sch-from", row).onchange = (e) => { w.from = e.target.value; paintWins(); };
      $(".sch-to", row).onchange = (e) => { w.to = e.target.value; paintWins(); };
      $("[data-del]", row).onclick = () => { wins.splice(Number(row.dataset.i), 1); paintWins(); };
    });
  };
  const paintStatus = () => {
    const on = $("#sch-on").checked;
    $("#sch-body").hidden = !on;
    const wait = $("#sch-players").value === "wait";
    $("#sch-warn").hidden = $("#sch-warn-unit").hidden = wait;
    const cur = state.servers.get(id);
    const live = cur && cur.schedule;
    $("#sch-status").innerHTML = !on
      ? "Off — the server runs whenever you start it."
      : live && sch.on
        ? `Now <b>${live.inside ? "inside" : "outside"}</b> scheduled hours — ${esc(fmtSchedNext(live.next))}.${zoneNote}`
        : `Saving applies it straight away: a stopped server inside these hours starts, a running one outside them gets its closing time.${zoneNote}`;
  };
  paintWins();
  paintStatus();
  $("#sch-on").onchange = paintStatus;
  $("#sch-players").onchange = paintStatus;
  $("#sch-add").onclick = () => { wins.push({ days: [6, 0], from: "12:00", to: "22:00" }); paintWins(); };
  $$("[data-preset]", box).forEach((b) => (b.onclick = () => {
    wins = SCHED_PRESETS[b.dataset.preset].map((w) => ({ ...w, days: [...w.days] }));
    paintWins();
  }));
  $("#sch-save").onclick = async () => {
    const on = $("#sch-on").checked;
    if (on && !wins.some((w) => w.days.length && w.from && w.to))
      return toast("Pick at least one day for a window.", "err");
    try {
      const r = await API.patch(`/api/servers/${id}`, {
        uptime: { on, windows: wins, players: $("#sch-players").value, warnMins: Number($("#sch-warn").value) || 5 },
      });
      state.servers.set(id, r.server);
      toast(on ? "Schedule saved — it " + fmtSchedNext(r.server.schedule && r.server.schedule.next) + "." : "Schedule off.", "ok");
      const fresh = await API.get(`/api/servers/${id}`);
      renderServerSchedule(id, fresh.schedule);
    } catch (e) { toast(e.message, "err"); }
  };
}

// The per-server public address. Off, it says whether there is an address to
// come back to; on, it shows the address with "Change" and "Turn off" beside
// it. Every way of picking an address goes through the same picker, so what a
// button says is what happens.
function renderServerPlayit(id) {
  const box = $("#st-playit");
  if (!box) return;
  const s = state.servers.get(id) || {};
  const pl = s.playit || { enabled: false };
  const acct = state.playit || {};

  if (!acct.supported) {
    box.innerHTML = `<div class="hint">${esc(acct.note || "playit.gg isn't available on this platform.")}</div>`;
    return;
  }
  if (!acct.linked) {
    box.innerHTML = `
      <div class="switch-row">
        <div class="txt"><b>Let friends join from anywhere</b><span>Connect a free playit.gg account to give this server a public address — no port forwarding.</span></div>
        <button class="btn btn-sm btn-primary" id="st-pl-setup">Set up</button>
      </div>`;
    $("#st-pl-setup").onclick = openSettings;
    return;
  }

  if (!pl.enabled) {
    box.innerHTML = `
      <div class="switch-row">
        <div class="txt"><b>Off</b><span>${pl.previous
          ? `Only players on this machine or your network can join. Turning it on brings back <span class="mono">${esc(pl.previous)}</span>.`
          : "Only players on this machine or your network can join."}</span></div>
        ${pl.previous
          ? `<button class="btn btn-sm btn-ghost" id="st-pl-pick">Different address…</button>
             <button class="btn btn-sm btn-primary" id="st-pl-on">${ico("globe")} Turn on</button>`
          : `<button class="btn btn-sm btn-primary" id="st-pl-pick">${ico("globe")} Choose an address…</button>`}
      </div>`;
    // No tunnel id means "the one this server had", which is what the button says.
    if ($("#st-pl-on")) $("#st-pl-on").onclick = (ev) => applyPlayit(id, ev.currentTarget, { enabled: true, tunnelId: null });
    $("#st-pl-pick").onclick = (ev) => choosePlayitAddress(id, ev.currentTarget);
    return;
  }

  const statusLine = pl.address
    ? (acct.agent === "online" ? "Live — anyone can join with this address." : "Address reserved; it goes live when the playit agent is online.")
    : "playit is allocating an address…";

  box.innerHTML = `
    <div class="switch-row">
      <div class="txt"><b>On</b><span>${esc(statusLine)}</span></div>
      ${addrChipHTML(pl)}
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <button class="btn btn-sm" id="st-pl-pick">Change address…</button>
      <button class="btn btn-sm btn-red" id="st-pl-off">Turn off</button>
    </div>
    ${pl.address && pl.port
      ? `<div class="hint" style="margin-top:10px">Java clients find the port through an SRV record. If a client refuses the bare domain, use <span class="mono">${esc(pl.host)}:${pl.port}</span>.</div>`
      : ""}
    ${pl.disabled ? `<div class="banner warn" style="margin-top:12px">This tunnel is disabled at playit.gg — re-enable it there.</div>` : ""}`;

  bindAddrChips(box);
  $("#st-pl-pick").onclick = (ev) => choosePlayitAddress(id, ev.currentTarget);
  $("#st-pl-off").onclick = async (ev) => {
    const btn = ev.currentTarget;
    if (!(await confirmDialog("Turn off the public address?",
      `<p>Friends can't join with <b class="mono">${esc(pl.address || "this address")}</b> until you turn it back on.</p>
       <p class="muted">The address stays reserved for this server — turning it on again brings the same one back.</p>`,
      "Turn off"))) return;
    applyPlayit(id, btn, { enabled: false });
  };
}

// Open the picker, confirm a move if the address belongs to another server,
// then apply it.
async function choosePlayitAddress(id, btn) {
  const pick = await pickTunnel(id);
  if (!pick) return;
  if (pick !== "new" && pick.owner && pick.owner.id !== id) {
    const live = pick.usedBy && pick.usedBy.id !== id;
    if (!(await confirmDialog("Move this address?",
      `<p><b class="mono">${esc(pick.address || pick.name)}</b> belongs to <b>${esc(pick.owner.name)}</b>.</p>
       <p class="muted">${live
         ? `Moving it here turns ${esc(pick.owner.name)}'s public address off. Anyone who joins with it will land on this server instead.`
         : `${esc(pick.owner.name)} has its address switched off and will forget this one.`}</p>`,
      "Move it here", false))) return;
  }
  applyPlayit(id, btn, { enabled: true, tunnelId: pick === "new" ? "new" : pick.id });
}

async function applyPlayit(id, btn, body) {
  if (btn) { btn.disabled = true; btn.textContent = body.enabled ? "Working…" : "Turning off…"; }
  try {
    const out = await API.post(`/api/servers/${id}/playit`, body);
    state.servers.set(id, out.server);
    const addr = out.server.playit && out.server.playit.address;
    toast(!body.enabled ? "Public address turned off." : addr ? "Public address: " + addr : "Public address on — playit is allocating it.", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
  renderServerPlayit(id);
  const chip = $("#srv-addr");
  if (chip) { chip.innerHTML = addrChipHTML((state.servers.get(id) || {}).playit); bindAddrChips(chip); }
}

// Every tunnel on the account, grouped by whose it is. Resolves to the picked
// tunnel, the string "new", or null if the picker was closed.
function pickTunnel(id) {
  return new Promise(async (resolve) => {
    let tunnels = [];
    try {
      tunnels = (await API.get("/api/playit/tunnels")).tunnels;
    } catch (e) {
      toast(e.message, "err");
      return resolve(null);
    }
    for (const t of tunnels) t.owner = t.usedBy || t.heldBy || null;
    const best = (a, b) => (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0);
    const current = tunnels.filter((t) => t.usedBy && t.usedBy.id === id);
    const previous = tunnels.filter((t) => t.heldBy && t.heldBy.id === id);
    const free = tunnels.filter((t) => !t.owner).sort(best);
    const taken = tunnels.filter((t) => t.owner && t.owner.id !== id).sort(best);

    const kind = (t) => t.recommended
      ? "Minecraft Java · players type just the address"
      : `${t.type || t.portType || "tunnel"} · players need the port too`;
    const row = (t, note, pickable = true) => `
      <div class="file-row ${pickable ? "pick" : ""}" ${pickable ? `data-t="${esc(t.id)}"` : ""}>
        <span class="fic">${ico("globe")}</span>
        <span class="fname"><b class="${t.address ? "mono" : ""}">${esc(t.address || (t.status === "pending" ? "address pending" : "no address yet"))}</b>
          <span class="muted">${esc(t.name)} · ${esc(kind(t))}${note ? " · " + note : ""}</span></span>
        ${pickable ? "" : `<span class="badge">current</span>`}
      </div>`;
    const group = (label, rows) => rows ? `<div class="file-row file-head"><span class="fhead-label">${label}</span></div>${rows}` : "";

    modal(`
      <div class="modal-head"><h2>Choose a public address</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <p class="hint" style="margin-top:0">Each address is a playit.gg tunnel on your account and points at one server at a time. Keep an address friends already have, or make a new one.</p>
        <div class="file-table tn-pick">
          ${group("This server", current.map((t) => row(t, "", false)).join("") + previous.map((t) => row(t, "its previous address")).join(""))}
          ${group("Not in use", free.map((t) => row(t, "")).join(""))}
          ${group("Other servers", taken.map((t) => row(t, t.usedBy ? `used by ${esc(t.owner.name)} — picking it moves it here` : `kept by ${esc(t.owner.name)} (off)`)).join(""))}
          ${group("New", `
            <div class="file-row pick" data-t="new">
              <span class="fic">${ico("plus")}</span>
              <span class="fname"><b>Create a new address</b><span class="muted">A fresh Minecraft Java tunnel, set up automatically. Takes a few seconds to get its address.</span></span>
            </div>`)}
        </div>
      </div>
      <div class="modal-foot"><span></span><button class="btn btn-ghost" data-x>Cancel</button></div>`, { wide: true });

    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    $(".modal-close").onclick = $("[data-x]").onclick = () => finish(null);
    $$(".tn-pick .file-row.pick").forEach((el) => (el.onclick = () =>
      finish(el.dataset.t === "new" ? "new" : tunnels.find((t) => t.id === el.dataset.t))));
  });
}

/* -------------------------------------------------------------- voice chat */
// Simple Voice Chat on a per-server switch. The live part (tunnel status, the
// address) rides the status events; whether the mod is actually in mods/ is a
// look at the disk, fetched with the Settings tab and after each switch.
const voiceDisk = new Map();

const VOICE_STATUS = {
  local: "On for players on your network. Turn on the public address above and voice chat gets one too.",
  pending: "playit is allocating a voice chat address…",
  ready: "Address reserved; it goes live when the playit agent is online.",
  online: "Live — players' voice chat connects to this address.",
};

function renderServerVoice(id) {
  const box = $("#st-voice");
  if (!box) return;
  const v = { ...(voiceDisk.get(id) || {}), ...((state.servers.get(id) || {}).voice || {}) };

  if (!v.supported) {
    box.innerHTML = `<div class="hint">${esc(v.reason || "Voice chat isn't available for this server.")}</div>`;
    return;
  }

  if (!v.enabled) {
    box.innerHTML = `
      <div class="switch-row">
        <div class="txt"><b>Off</b><span>${v.installed
          ? "Simple Voice Chat is already on this server. Turning this on gives it its own port and, with a public address, its own playit.gg tunnel."
          : "Proximity voice chat with Simple Voice Chat. Turning it on installs the mod from Modrinth and sets it up for you."}</span></div>
        <button class="btn btn-sm btn-primary" id="st-vc-on">${ico("mic")} Turn on</button>
      </div>
      ${voiceRoomHTML(id, v)}
      <div class="hint" style="margin-top:10px">Voice chat doesn't go through the game's address: it uses its own UDP port, so with a public address on it needs a second playit.gg tunnel. Every player needs Simple Voice Chat installed in their own game too.</div>`;
    $("#st-vc-on").onclick = (ev) => turnVoiceOn(id, ev.currentTarget, v);
    return;
  }

  const line = v.status === "error" ? "The voice chat tunnel couldn't be set up." : VOICE_STATUS[v.status] || "";
  const chip = v.address
    ? `<span class="addr" data-copy="${esc(v.address)}" title="Voice chat address — click to copy">${ico("mic")} ${esc(v.address)} <span class="copy">${ico("copy")}</span></span>`
    : v.status === "pending" ? `<span class="addr pending">${ico("mic")} allocating…</span>` : "";

  box.innerHTML = `
    <div class="switch-row">
      <div class="txt"><b>On</b><span>${esc(line)}</span></div>
      ${chip}
    </div>
    ${v.installed === false
      ? `<div class="banner warn" style="margin:12px 0 0">Simple Voice Chat isn't on this server any more — it was removed from the mods or plugins folder.
          <div class="b-actions"><button class="btn btn-sm" id="st-vc-fix">Reinstall</button></div></div>`
      : ""}
    ${v.error ? `<div class="banner err" style="margin:12px 0 0">${esc(v.error)}
        <div class="b-actions"><button class="btn btn-sm" id="st-vc-retry">Try again</button></div></div>` : ""}
    <div class="hint" style="margin-top:10px">
      UDP port <span class="mono">${esc(String(v.port || "—"))}</span> on this machine${v.version ? ` · Simple Voice Chat ${esc(v.version)}` : ""}${v.manual ? " · installed by hand" : ""}.
      ${v.address ? "Players don't type this address — the server hands it to their mod." : ""}
      Every player needs Simple Voice Chat installed too, then presses <b>V</b> in game. The mod reads its settings at startup, so restart the server after changes.
    </div>
    <div style="display:flex;gap:8px;margin-top:10px">
      ${voiceCanTunnel(id) ? `<button class="btn btn-sm${v.error ? " btn-primary" : ""}" id="st-vc-pick">${ico("globe")} Use a playit tunnel…</button>` : ""}
      <button class="btn btn-sm btn-red" id="st-vc-off">Turn off</button>
    </div>`;

  bindAddrChips(box);
  if ($("#st-vc-pick")) $("#st-vc-pick").onclick = (ev) => pickVoiceTunnel(id, ev.currentTarget, v);
  if ($("#st-vc-fix")) $("#st-vc-fix").onclick = (ev) => applyVoice(id, ev.currentTarget, true);
  if ($("#st-vc-retry")) $("#st-vc-retry").onclick = (ev) => applyVoice(id, ev.currentTarget, true);
  $("#st-vc-off").onclick = async (ev) => {
    const btn = ev.currentTarget;
    if (!(await confirmDialog("Turn off voice chat?",
      `<p>${v.manual
        ? "Simple Voice Chat was installed by hand, so it stays on the server, but it loses its public address."
        : "Simple Voice Chat is removed from the server (if MC Hoster installed it) and its playit.gg tunnel is paused."}</p>
       <p class="muted">Its settings are kept, so turning it on again brings the same port back.</p>`,
      "Turn off"))) return;
    applyVoice(id, btn, false);
  };
}

// Whether this server's voice chat would get a public address: only with the
// public address on, and only if the account has a UDP port to spare (or this
// server already has a voice tunnel waiting from before).
function voiceNeedsPort(id, v) {
  const s = state.servers.get(id) || {};
  return !!(state.playit && state.playit.linked && s.playit && s.playit.enabled && !v.hasTunnel);
}

function voiceRoomHTML(id, v) {
  const udp = state.playit && state.playit.quota && state.playit.quota.udp;
  if (!udp || !voiceNeedsPort(id, v)) return "";
  if (udp.free <= 0)
    return `<div class="banner warn" style="margin:12px 0 0">Your playit.gg account has no UDP ports left (${udp.used} of ${udp.allowed} in use), so voice chat would only work on your own network. Delete a UDP tunnel you don't use at <a href="https://playit.gg/account/tunnels" target="_blank" rel="noopener" style="text-decoration:underline">playit.gg</a> first.</div>`;
  return `<div class="hint" style="margin-top:10px">Uses 1 of the ${udp.free} UDP port${udp.free === 1 ? "" : "s"} left on your playit.gg account (${udp.used} of ${udp.allowed} in use).</div>`;
}

// Read the allowance fresh before asking for a tunnel — somebody may have made
// or deleted one at playit.gg since the page loaded — and say so plainly if
// there's no room, instead of finding out from a tunnel that never comes up.
async function turnVoiceOn(id, btn, v) {
  if (voiceNeedsPort(id, v)) {
    btn.disabled = true; btn.textContent = "Checking playit…";
    let udp = null;
    try {
      const out = await API.get("/api/playit/quota");
      if (out.playit) state.playit = out.playit;
      udp = out.quota && out.quota.udp;
    } catch {}
    btn.disabled = false; btn.innerHTML = ico("mic") + " Turn on";
    if (udp && udp.free <= 0) {
      if (!(await confirmDialog("No UDP ports left on playit.gg",
        `<p>Your playit.gg account is using <b>${udp.used} of ${udp.allowed}</b> UDP ports, so voice chat can't get a public address. Friends joining through playit won't be able to use it.</p>
         <p class="muted">Delete a UDP tunnel you don't use at playit.gg/account/tunnels (or upgrade), then press Try again on this server. You can still turn it on now for players on your own network.</p>`,
        "Turn on for my network only", false))) { renderServerVoice(id); return; }
    }
  }
  applyVoice(id, btn, true);
}

// A voice tunnel only makes sense while the game itself has a public address.
function voiceCanTunnel(id) {
  const s = state.servers.get(id) || {};
  return !!(state.playit && state.playit.linked && s.playit && s.playit.enabled);
}

// Pick a tunnel made at playit.gg for this server's voice chat. playit won't
// always let the panel create one itself, but its own site has a Simple Voice
// Chat tunnel type that free accounts can make; the panel then points it at
// the right port and writes its address into the mod's config.
function pickVoiceTunnel(id, btn, v) {
  modal(`
    <div class="modal-head"><h2>Use a playit tunnel for voice chat</h2><button class="modal-close">×</button></div>
    <div class="modal-body">
      <ol class="hint" style="margin:0 0 12px;padding-left:18px;line-height:1.7">
        <li>At <a href="https://playit.gg/account/tunnels" target="_blank" rel="noopener" style="text-decoration:underline">playit.gg → Tunnels</a>, press <b>Add tunnel</b>.</li>
        <li>Choose the <b>Simple Voice Chat</b> tunnel type (plain <b>UDP</b> works too). Local address and port don't matter — MC Hoster points it at port <span class="mono">${esc(String(v.port || 24454))}</span> for you.</li>
        <li>Come back here, press <b>Refresh</b>, and pick it.</li>
      </ol>
      <div class="file-table tn-pick" id="vt-list"><div class="file-row"><span class="fname muted">Loading tunnels…</span></div></div>
    </div>
    <div class="modal-foot"><button class="btn btn-sm" id="vt-refresh">${ico("rotate")} Refresh</button><button class="btn btn-ghost" data-x>Cancel</button></div>`, { wide: true });
  $(".modal-close").onclick = $("[data-x]").onclick = () => closeModal();

  const load = async () => {
    const list = $("#vt-list");
    if (!list) return;
    list.innerHTML = `<div class="file-row"><span class="fname muted">Loading tunnels…</span></div>`;
    let tunnels = [];
    try { tunnels = (await API.get("/api/playit/voice-tunnels")).tunnels; }
    catch (e) { list.innerHTML = `<div class="file-row"><span class="fname" style="color:var(--danger)">${esc(e.message)}</span></div>`; return; }
    if (!tunnels.length) {
      list.innerHTML = `<div class="file-row"><span class="fname muted">No UDP tunnels on your playit account yet — make one at playit.gg, then press Refresh.</span></div>`;
      return;
    }
    const BLOCK = { "over-port-limit": "switched off: account over its port limit", "requires-premium": "switched off: needs Premium" };
    list.innerHTML = tunnels.map((t) => {
      const mine = t.voiceBy && t.voiceBy.id === id;
      const note = mine ? "this server's voice tunnel"
        : t.voiceBy ? `voice chat for ${esc(t.voiceBy.name)} — picking it moves it here`
        : t.blocked ? esc(BLOCK[t.blocked] || "switched off at playit.gg") : "";
      return `
        <div class="file-row ${mine ? "" : "pick"}" ${mine ? "" : `data-t="${esc(t.id)}"`}>
          <span class="fic">${ico("mic")}</span>
          <span class="fname"><b class="${t.address ? "mono" : ""}">${esc(t.address || (t.status === "pending" ? "address pending" : "no address yet"))}</b>
            <span class="muted">${esc(t.name)} · ${esc(t.type || t.portType)}${note ? " · " + note : ""}</span></span>
          ${mine ? `<span class="badge">current</span>` : ""}
        </div>`;
    }).join("");
    $$("#vt-list .file-row.pick").forEach((el) => (el.onclick = () => {
      closeModal();
      applyVoice(id, btn, true, { tunnelId: el.dataset.t });
    }));
  };
  $("#vt-refresh").onclick = load;
  load();
}

async function applyVoice(id, btn, enabled, extra = {}) {
  if (btn) { btn.disabled = true; btn.textContent = enabled ? "Setting up…" : "Turning off…"; }
  try {
    const out = await API.post(`/api/servers/${id}/voice`, { enabled, ...extra });
    state.servers.set(id, out.server);
    voiceDisk.set(id, out.voice);
    const tail = out.running ? " Restart the server to apply." : "";
    toast((enabled ? "Voice chat is on." : "Voice chat is off.") + tail, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
  renderServerVoice(id);
}

/* ---------------------------------------------------------------- settings */
// What each Java major is for, shown in the Settings runtime picker.
const JAVA_NOTE = { 25: "Minecraft 26.x", 21: "1.20.5 – 1.21.x", 17: "1.18 – 1.20.4", 8: "1.16 and older" };

async function openSettings() {
  const { javas } = await API.get("/api/java");
  state.javas = javas;
  modal(`
    <div class="modal-head"><h2>Settings</h2><button class="modal-close">×</button></div>
    <div class="modal-body">
      <div class="section-title" style="margin-top:0">Java runtimes</div>
      ${javas.length ? `<div class="file-table">${javas.map((j) => `
        <div class="file-row"><span class="fic">${ico("coffee")}</span><span class="fname mono">${esc(j.path)}</span><span class="fsize">Java ${esc(String(j.major))}${j.managed ? " · managed" : ""} · v${esc(j.version)}</span></div>`).join("")}</div>`
        : `<div class="banner err" style="margin:0">No Java runtime found. Pick a version below and MC Hoster will fetch an Eclipse Temurin JRE into its own <span class="mono">data/runtimes</span> folder — nothing is installed system-wide.</div>`}
      <p class="hint" style="margin-top:8px">Minecraft pins a Java version per release: 1.16 and older need 8, 1.18–1.20.4 need 17, 1.20.5–1.21.x need 21, and 26.x needs 25. MC Hoster matches the right one per server and downloads it if it's missing.</p>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm" id="set-rescan">${ico("rotate")} Rescan for Java</button>
        <span class="muted" style="font-size:12px">Add runtime:</span>
        <select id="set-jmajor" style="width:auto;min-width:110px">${[25, 21, 17, 8].map((m) => `<option value="${m}">Java ${m}${JAVA_NOTE[m] ? " · " + JAVA_NOTE[m] : ""}</option>`).join("")}</select>
        <button class="btn btn-sm" id="set-jget">${ico("download")} Download</button>
      </div>

      <div class="form-row" style="margin-top:22px">
        <label>Default Java path <span class="muted">(used when a server doesn't override it)</span></label>
        <input type="text" id="set-java" class="mono" value="${esc(state.settings.javaPath || "")}" placeholder="${esc(javas[0]?.path || "auto-detect")}" />
      </div>
      <div class="form-row">
        <label>Default memory for new servers</label>
        <div class="range-row"><input type="range" id="set-mem" min="1024" max="16384" step="512" value="${state.settings.defaultMemory || 4096}" /><span class="range-val" id="set-memv">${fmtMem(state.settings.defaultMemory || 4096)}</span></div>
      </div>
      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Updating the panel</div>
      <div class="switch-row">
        <label class="switch"><input type="checkbox" id="set-keep" ${state.settings.keepServersRunning !== false ? "checked" : ""} /><i></i></label>
        <div class="txt"><b>Keep servers running when the panel closes</b><span>Rack's ⟳ Update (or closing the panel) leaves your Minecraft servers and the playit agent running. The panel reconnects when it's back, and nobody gets kicked.</span></div>
      </div>
      <p class="hint" style="margin-top:8px">With this off, servers stop when the panel stops — and Rack stops the panel with a hard kill, so the world doesn't get saved. Turning it on or off applies to servers started from now on. To shut everything down, stop the servers first:</p>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm btn-red" id="set-stopall">${ico("stop")} Stop all servers</button>
        <span class="muted" style="font-size:12px" id="set-running"></span>
      </div>

      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">On your phone</div>
      ${state.lan.length
        ? `<p class="hint" style="margin-top:0">On a phone connected to the same Wi-Fi, open:</p>
           <div class="lan-list">${state.lan.map((u) => `<button class="addr-chip lan-chip" data-copy="${esc(u)}" title="Click to copy">${ico("globe")} <span class="mono">${esc(u)}</span></button>`).join("")}</div>
           <p class="hint">Then use your browser's <b>Add to Home screen</b> for an app-style icon. If the page doesn't load, allow Node.js through Windows Firewall on private networks. The panel has no login, so keep it on your home network (Tailscale works well for checking in from outside).</p>`
        : `<p class="hint" style="margin-top:0">This machine doesn't seem to be on a home network right now, so there's no address to open from a phone.</p>`}

      <div class="divider"></div>
      <div class="section-title" style="margin-top:0">Public access · playit.gg</div>
      <div id="playit-section"></div>

      <p class="hint" style="margin-top:22px">MC Hoster runs under Rack. Each Minecraft server is its own Java process, kept by a small host process so it survives panel restarts; this panel's own web port is assigned by Rack.</p>
    </div>
    <div class="modal-foot"><span></span><div style="display:flex;gap:10px"><button class="btn btn-ghost" data-x>Close</button><button class="btn btn-primary" id="set-save">Save</button></div></div>`);
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  renderPlayitSection();
  const mem = $("#set-mem"); mem.oninput = () => ($("#set-memv").textContent = fmtMem(Number(mem.value)));
  $("#set-rescan").onclick = async () => { const { javas } = await API.get("/api/java?rescan=1"); state.javas = javas; closeModal(); renderSidebar(); openSettings(); };
  $("#set-jget").onclick = async () => {
    const btn = $("#set-jget");
    const major = Number($("#set-jmajor").value);
    btn.disabled = true;
    btn.textContent = "Downloading Java " + major + "…";
    try {
      const out = await API.post("/api/java/install", { major });
      state.javas = out.javas;
      closeModal();
      renderSidebar();
      toast(`Java ${out.java.version} installed.`, "ok");
      openSettings();
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = ico("download") + " Download";
      toast(e.message, "err");
    }
  };
  $$(".lan-chip").forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  const running = () => [...state.servers.values()].filter((x) => ["running", "starting"].includes(x.status)).length;
  const paintRunning = () => {
    const el = $("#set-running");
    if (el) el.textContent = running() ? `${running()} running` : "Nothing is running.";
  };
  paintRunning();
  $("#set-stopall").onclick = async () => {
    if (!running()) return toast("Nothing is running.", "");
    if (!(await confirmDialog("Stop all servers?", `<p class="muted">Saves and stops every running server (${running()}). Players are disconnected.</p>`, "Stop all"))) return openSettings();
    try {
      const r = await API.post("/api/servers/stop-all");
      toast(`Stopping ${r.stopped} server${r.stopped === 1 ? "" : "s"}…`, "ok");
    } catch (e) { toast(e.message, "err"); }
    openSettings();
  };
  $("#set-save").onclick = async () => {
    try {
      state.settings = await API.put("/api/settings", {
        javaPath: $("#set-java").value.trim() || null,
        defaultMemory: Number(mem.value),
        keepServersRunning: $("#set-keep").checked,
      });
      closeModal(); renderSidebar(); toast("Settings saved.", "ok");
    } catch (e) { toast(e.message, "err"); }
  };
}

/* ============================================================== playit.gg */
/* Public addresses without port forwarding: playit runs a relay, an agent on
 * this machine keeps an outbound connection to it, and each server gets a
 * domain that forwards to its local port. The backend owns all of it — this is
 * the account link plus the per-server switch. */

const PLAYIT_AGENT_LABEL = { stopped: "idle", starting: "connecting", online: "online", error: "error" };
const PLAYIT_ACCOUNT_NOTE = {
  guest: "You're on a guest playit account — claim it at playit.gg so you don't lose these addresses.",
  "email-not-verified": "Verify your email at playit.gg to keep tunnels running.",
  banned: "This playit account is banned; tunnels won't connect.",
  "agent-over-limit": "Too many agents on this playit account — remove one at playit.gg/account/agents.",
  "agent-disabled": "This agent is disabled at playit.gg/account/agents.",
};

// The address chip shown on cards and headers. Clicking copies it.
function addrChipHTML(pl) {
  if (!pl || !pl.enabled) return "";
  if (!pl.address) return `<span class="addr pending" title="playit is allocating an address">${ico("globe")} allocating…</span>`;
  return `<span class="addr" data-copy="${esc(pl.address)}" title="Public address — click to copy">${ico("globe")} ${esc(pl.address)} <span class="copy">${ico("copy")}</span></span>`;
}
function bindAddrChips(root = document) {
  $$("[data-copy]", root).forEach((el) => (el.onclick = (ev) => { ev.stopPropagation(); copyText(el.dataset.copy); }));
}

// The account's port allowance, one row per pool. playit counts ports, and
// every tunnel the panel makes is one port: game addresses are TCP, voice
// chat is UDP.
function quotaRowsHTML(q) {
  if (!q) return "";
  const row = (label, what, p) => {
    if (!p) return "";
    const full = p.free <= 0;
    return `
      <div class="file-row" title="Each tunnel uses one port">
        <span class="fic">${ico(what === "voice" ? "mic" : "globe")}</span>
        <span class="fname">${label} <span class="muted">· ${what === "voice" ? "voice chat" : "game addresses"}</span></span>
        <span class="fsize" style="${full ? "color:var(--danger)" : ""}">${p.used} of ${p.allowed} used${full ? " · full" : ` · ${p.free} free`}</span>
      </div>`;
  };
  return row("TCP ports", "game", q.tcp) + row("UDP ports", "voice", q.udp);
}

async function playitCall(path, body) {
  const out = await API.post(path, body);
  if (out.playit) state.playit = out.playit;
  return out;
}

// Rendered inside the Settings modal; re-rendered in place whenever the
// backend pushes a playit event (claim approved, agent online, …).
function renderPlayitSection() {
  const box = $("#playit-section");
  if (!box) return;
  const pl = state.playit || {};

  if (!pl.supported) {
    box.innerHTML = `<div class="hint">${esc(pl.note || "playit.gg isn't available on this platform.")}</div>`;
    return;
  }

  if (pl.claim) {
    const status = {
      waiting: "Waiting for you to open the link…",
      visited: "Approve MC Hoster in your browser to finish linking.",
      accepted: "Approved — finishing up…",
      rejected: "The request was rejected in the browser.",
      expired: "That claim link expired.",
      error: pl.claim.error || "Something went wrong.",
    }[pl.claim.status];
    const done = ["rejected", "expired", "error"].includes(pl.claim.status);
    box.innerHTML = `
      <div class="claim-box">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
          ${done ? "" : `<span class="spinner"></span>`}<b>${esc(status)}</b>
        </div>
        <a class="claim-link" href="${esc(pl.claim.url)}" target="_blank" rel="noopener">${esc(pl.claim.url)}</a>
        <div class="hint" style="margin-top:10px">Sign in (or make a free account) and approve the agent. This window updates itself.</div>
        <div style="margin-top:12px;display:flex;gap:8px">
          <a class="btn btn-sm btn-primary" href="${esc(pl.claim.url)}" target="_blank" rel="noopener">Open the link</a>
          <button class="btn btn-sm btn-ghost" id="pl-cancel">${done ? "Close" : "Cancel"}</button>
        </div>
      </div>`;
    $("#pl-cancel").onclick = async () => { await playitCall("/api/playit/link/cancel"); renderPlayitSection(); renderSidebar(); };
    return;
  }

  if (!pl.linked) {
    box.innerHTML = `
      <p class="hint" style="margin-top:0">Give your servers a public address that friends can join — no port forwarding, no router settings, works behind CGNAT. MC Hoster downloads the official playit agent (${esc(pl.version)}, ~5 MB) into its own <span class="mono">data/playit</span> folder and links it to your free playit.gg account. Nothing is installed system-wide.</p>
      <button class="btn btn-primary" id="pl-link">${ico("globe")} Connect playit.gg</button>`;
    $("#pl-link").onclick = async () => {
      const btn = $("#pl-link");
      btn.disabled = true;
      btn.textContent = pl.installed ? "Starting…" : "Downloading agent…";
      try {
        await playitCall("/api/playit/link");
        renderPlayitSection();
      } catch (e) {
        toast(e.message, "err");
        btn.disabled = false;
        btn.innerHTML = ico("globe") + " Connect playit.gg";
      }
    };
    return;
  }

  const dot = pl.agent === "online" ? "running" : pl.agent === "error" ? "crashed" : pl.tunnels ? "starting" : "stopped";
  const accountNote = pl.account && PLAYIT_ACCOUNT_NOTE[pl.account.status];
  box.innerHTML = `
    <div class="file-table" style="margin-bottom:12px">
      <div class="file-row">
        <span class="fic"><span class="dot ${dot}"></span></span>
        <span class="fname">Agent ${esc(PLAYIT_AGENT_LABEL[pl.agent] || pl.agent)}${pl.tunnels ? ` · ${pl.tunnels} tunnel${pl.tunnels === 1 ? "" : "s"}` : " · no tunnels yet"}</span>
        <span class="fsize">${esc(pl.version)}</span>
      </div>
      ${quotaRowsHTML(pl.quota)}
    </div>
    ${pl.agentError ? `<div class="banner err" style="margin:0 0 12px">${esc(pl.agentError)}</div>` : ""}
    ${accountNote ? `<div class="banner warn" style="margin:0 0 12px">${esc(accountNote)} <a href="https://playit.gg/account" target="_blank" rel="noopener" style="text-decoration:underline">Open playit.gg</a></div>` : ""}
    <p class="hint" style="margin-top:0">Give a server an address in its <b>Settings</b> tab, under <b>Public address</b> — pick one you already have, move one from another server, or make a new one. Tunnels stay up while the panel runs.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn btn-sm" id="pl-console">${ico("terminal")} Agent console</button>
      <button class="btn btn-sm" id="pl-refresh">${ico("rotate")} Refresh tunnels</button>
      <a class="btn btn-sm" href="https://playit.gg/account/tunnels" target="_blank" rel="noopener">Manage at playit.gg</a>
      <button class="btn btn-sm btn-red" id="pl-unlink">Unlink account</button>
    </div>`;
  $("#pl-console").onclick = openPlayitConsole;
  $("#pl-refresh").onclick = async () => {
    const btn = $("#pl-refresh");
    btn.disabled = true; btn.textContent = "Refreshing…";
    try { await playitCall("/api/playit/refresh"); } catch (e) { toast(e.message, "err"); }
    renderPlayitSection();
  };
  $("#pl-unlink").onclick = async () => {
    if (!(await confirmDialog("Unlink playit.gg?",
      "<p>Public addresses stop working until you link again.</p><p class='muted'>The tunnels stay on your playit.gg account — this panel just forgets the key.</p>",
      "Unlink"))) return;
    try { await playitCall("/api/playit/unlink"); toast("Unlinked from playit.gg.", "ok"); renderPlayitSection(); renderSidebar(); }
    catch (e) { toast(e.message, "err"); }
  };
}

/* The agent's own output, live. It takes no commands, so unlike a server
 * console there's no input line — just the log, a filter, and a restart for
 * when the agent is stuck or the retry loop has given up on it. */
function openPlayitConsole() {
  modal(`
    <div class="modal-head"><h2>playit agent console</h2><button class="modal-close">×</button></div>
    <div class="modal-body">
      <div class="console plc">
        <div class="console-head">
          <span class="t" id="plc-status"></span>
          <span class="plc-tools">
            <label class="plc-filter"><input type="checkbox" id="plc-problems" /> Hide routine output</label>
            <button class="btn btn-sm btn-ghost" id="plc-clear">Clear</button>
          </span>
        </div>
        <div class="console-out" id="plc-out"></div>
      </div>
      <p class="hint" style="margin-bottom:0">Everything the playit agent prints, live. MC Hoster's own playit messages are highlighted; errors and warnings are red. The agent takes no commands — if it's stuck, restart it.</p>
    </div>
    <div class="modal-foot"><span></span><div style="display:flex;gap:10px">
      <button class="btn btn-ghost" data-x>Close</button>
      <button class="btn" id="plc-restart">${ico("rotate")} Restart agent</button>
    </div></div>`, { wide: true });
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;

  const out = $("#plc-out");
  const empty = () => (out.innerHTML = `<div class="ln sys plc-empty">Nothing logged yet.</div>`);
  const es = new EventSource("/api/playit/console");
  // Every (re)connect replays the whole log, so start from a clean slate.
  es.onopen = empty;
  es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type !== "log") return;
    $(".plc-empty", out)?.remove();
    // The agent stamps its own lines; ours get the time added.
    appendConsole(out, e.stream, e.stream === "sys" ? `[${new Date(e.t).toLocaleTimeString()}] ${e.line}` : e.line);
  };
  es.onerror = () => {}; // browser auto-reconnects
  modalCleanup = () => es.close();

  $("#plc-problems").onchange = (ev) => out.classList.toggle("only-problems", ev.target.checked);
  $("#plc-clear").onclick = empty;
  $("#plc-restart").onclick = async () => {
    const btn = $("#plc-restart");
    btn.disabled = true;
    try { await playitCall("/api/playit/restart"); } catch (e) { toast(e.message, "err"); }
    btn.disabled = false;
    paintPlayitConsoleHead();
  };
  empty();
  paintPlayitConsoleHead();
}

function paintPlayitConsoleHead() {
  const el = $("#plc-status");
  if (!el) return;
  const pl = state.playit || {};
  const dot = { online: "running", error: "crashed", starting: "starting" }[pl.agent] || "stopped";
  el.innerHTML = `<span class="dot ${dot}"></span> Agent ${esc(PLAYIT_AGENT_LABEL[pl.agent] || pl.agent || "idle")}${pl.version ? ` · ${esc(pl.version)}` : ""}` +
    (pl.agentError ? ` <span class="plc-err">— ${esc(pl.agentError)}</span>` : "");
  const btn = $("#plc-restart");
  if (btn) btn.hidden = !pl.linked;
}

boot();

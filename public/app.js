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
// Online and paused both mean "the process is up" — worth a leading dot.
const statusDot = (s) => (viewStatus(s) === "running" || viewStatus(s) === "paused" ? "● " : "");

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
function closeModal() { runModalCleanup(); $("#modal-root").innerHTML = ""; }

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

/* ---------------------------------------------------------------- bootstrap */
async function boot() {
  // The shell in index.html carries data-ico placeholders; fill them before
  // anything else so the sidebar never flashes empty boxes.
  $("#brand-mark").innerHTML = ico("cube");
  hydrateIcons();

  try {
    const b = await API.get("/api/bootstrap");
    state.loaders = b.loaders;
    state.javas = b.javas;
    state.settings = b.settings;
    state.defaults = b.defaults || state.defaults;
    state.build = b.build || null;
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

  $("#nav-create").onclick = openCreateWizard;
  $("#nav-settings").onclick = openSettings;
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
    return;
  }
  // Player-log records arrive for every chat line; only the open Players tab
  // cares, and a sidebar redraw per message would be silly.
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
  closeConsoleStream();
  if (h.startsWith("/server/")) {
    state.route = { name: "server", id: h.slice(8) };
    renderServer(h.slice(8));
  } else {
    state.route = { name: "dashboard", id: null };
    renderDashboard();
  }
  renderSidebar();
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
  $$(".srv-mini", list).forEach((el) => (el.onclick = () => go("#/server/" + el.dataset.id)));

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
        <button class="btn btn-primary" id="dash-create"><span class="ic">＋</span> Create Server</button>
      </div>
      ${sysCardHTML()}
      ${servers.length ? `<div class="grid">${servers.map(cardHTML).join("")}</div>` : emptyHTML()}
    </div>`;

  paintSysmon();
  $("#dash-create").onclick = openCreateWizard;
  if (!servers.length) $("#empty-create") && ($("#empty-create").onclick = openCreateWizard);
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
        <label>Minecraft version — <span class="mono" style="color:var(--accent-2)">${esc(loader.label)}</span></label>
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
        : `<div class="hint" style="color:var(--amber)">${ico("coffee")} Minecraft ${esc(r.mc)} needs <b>Java ${r.required}</b>, which isn't on this machine.
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
      <div class="summary-box muted" style="font-size:12.5px;background:var(--bg-2);border:1px solid var(--line);border-radius:8px;padding:12px">
        ${wiz.pack
          ? `${ico("box")} <b style="color:var(--text)">${esc(wiz.pack.title)}</b> ${esc(wiz.packVersion ? wiz.packVersion.number : "")} · Minecraft <b style="color:var(--text)">${esc(wiz.mc)}</b> · ${esc((wiz.packVersion && wiz.packVersion.loaders[0]) || "")}
             <div style="margin-top:6px">Its mods and configs are downloaded during setup — client-only mods are left out.</div>`
          : `<b style="color:var(--text)">${esc(cap(wiz.loader))}</b> · Minecraft <b style="color:var(--text)">${esc(wiz.mc)}</b>${wiz.build ? ` · build <b style="color:var(--text)">${esc(wiz.build)}</b>` : ""}`}
        ${wiz.javaReq
          ? wiz.javaReq.ok
            ? `<div style="margin-top:8px">${ico("coffee")} Java ${wiz.javaReq.required} · using ${esc(wiz.javaReq.java.version)}</div>`
            : `<div style="color:var(--amber);margin-top:8px">${ico("coffee")} Needs Java ${wiz.javaReq.required} — MC Hoster will download Eclipse Temurin ${wiz.javaReq.required} during setup.</div>`
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
  `;
  $$("[data-a]", box).forEach((b) => (b.onclick = () => serverAction(s.id, b.dataset.a)));
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

async function serverAction(id, act) {
  try {
    if (act === "kill" && !(await confirmDialog("Force kill?", "<p class='muted'>This hard-kills the process without saving the world. Use only if it's stuck.</p>", "Force kill"))) return;
    await API.post(`/api/servers/${id}/${act === "kill" ? "stop?force=1" : act}`);
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------- tab switching */
const TABS = ["console", "stats", "players", "content", "files", "properties", "settings"];
function selectTab(id, tab) {
  state.activeTab = tab;
  $$("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  closeConsoleStream();
  if (tab === "console") renderConsoleTab(id);
  else if (tab === "stats") renderStatsTab(id);
  else if (tab === "players") renderPlayersTab(id);
  else if (tab === "content") renderContentTab(id);
  else if (tab === "files") renderFilesTab(id);
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
  return `<span class="ping ${q}" title="${ms} ms round-trip"><i></i>${ms}<small>ms</small></span>`;
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
  else if (e.type === "command") body = `${who} ran <span class="mono pe-dim">${esc(e.text)}</span>`;
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
 * history as small charts (one measure each — they don't share a scale), the
 * "Can't keep up!" log, and what is taking the disk. Live points arrive on the
 * global event stream every 5 s and are appended in place.
 */
const PERF_RANGES = [
  { id: "15m", label: "15 min", span: 15 * 60000 },
  { id: "1h", label: "1 hour", span: 3600000 },
  { id: "24h", label: "24 hours", span: 86400000 },
];
const PERF_CHART_H = 132;

function perfState(id) {
  if (!state.perf || state.perf.id !== id)
    state.perf = { id, range: "15m", data: null, disk: null, fetchedAt: 0, ro: null };
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
  if (st.tps == null) return st.tpsSupport === "no" ? `— <small>n/a</small>` : "—";
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
  const body = $("#tab-body");
  body.innerHTML = `
    <div class="perf">
      <div class="perf-tiles" id="perf-tiles"></div>
      <div id="perf-note"></div>
      <div id="perf-dims"></div>
      <div class="perf-bar">
        <h4>${ico("gauge")} History</h4>
        <div class="seg" id="perf-range">
          ${PERF_RANGES.map((r) => `<button class="seg-btn ${r.id === P.range ? "on" : ""}" data-r="${r.id}">${r.label}</button>`).join("")}
        </div>
      </div>
      <div class="perf-charts" id="perf-charts"></div>
      <div class="perf-lower">
        <section class="plog-pane">
          <header class="plog-pane-head">
            <h4>${ico("alert")} Lag spikes</h4>
            <div class="plog-tools"><button class="btn btn-sm btn-ghost" id="perf-lag-clear" title="Forget recorded lag spikes">${ico("trash")} Clear</button></div>
          </header>
          <div id="perf-lag" class="perf-lag"></div>
        </section>
        <div class="perf-side">
          <section class="plog-pane">
            <header class="plog-pane-head"><h4>${ico("clock")} This run</h4></header>
            <div id="perf-session" class="perf-kv"></div>
          </section>
          <section class="plog-pane">
            <header class="plog-pane-head">
              <h4>${ico("folder")} Disk usage</h4>
              <div class="plog-tools"><button class="btn btn-sm btn-ghost" id="perf-disk-refresh" title="Measure again">${ico("rotate")}</button></div>
            </header>
            <div id="perf-disk" class="perf-disk"><div class="players-empty">Measuring…</div></div>
          </section>
        </div>
      </div>
    </div>`;

  $$("#perf-range .seg-btn").forEach((b) => (b.onclick = () => {
    P.range = b.dataset.r;
    $$("#perf-range .seg-btn").forEach((x) => x.classList.toggle("on", x === b));
    perfLoad(id);
  }));
  $("#perf-lag-clear").onclick = async () => {
    if (!(await confirmDialog("Clear lag spikes?", "<p class='muted'>Forgets the recorded “Can't keep up!” warnings for this server. Charts are kept.</p>", "Clear"))) return;
    try { await API.del(`/api/servers/${id}/stats/lag`); if (P.data) P.data.lag = []; perfPaint(id); } catch (e) { toast(e.message, "err"); }
  };
  $("#perf-disk-refresh").onclick = () => perfLoadDisk(id, true);

  if (P.ro) P.ro.disconnect();
  if (window.ResizeObserver) {
    let raf = 0;
    P.ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => perfOpen(id) && perfPaintCharts(id)); });
    P.ro.observe($("#perf-charts"));
  }

  perfPaint(id); // tiles from the summary we already hold, before the fetch
  await perfLoad(id);
  perfLoadDisk(id);
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

async function perfLoadDisk(id, force) {
  const P = perfState(id);
  const box = $("#perf-disk");
  if (force && box) box.innerHTML = `<div class="players-empty">Measuring…</div>`;
  try {
    const { disk } = await API.get(`/api/servers/${id}/stats/disk${force ? "?t=" + Date.now() : ""}`);
    P.disk = disk;
  } catch (e) {
    if (box) box.innerHTML = `<div class="players-empty">${esc(e.message)}</div>`;
    return;
  }
  if (perfOpen(id)) perfPaintDisk(id);
}

// A live sample: refresh the tiles, and extend the fine-grained history.
function perfLive(e) {
  const P = perfState(e.id);
  if (!P.data) return;
  const { type, id, point, ...cur } = e;
  P.data.current = cur;
  if (point && P.range !== "24h") {
    P.data.history.points.push(point);
    const span = PERF_RANGES.find((r) => r.id === P.range).span;
    const from = Date.now() - span;
    while (P.data.history.points.length && P.data.history.points[0].t < from) P.data.history.points.shift();
  } else if (P.range === "24h" && Date.now() - P.fetchedAt > 60000) {
    return perfLoad(e.id); // a new minute has been averaged
  }
  perfPaint(e.id);
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
    perfTile("Lag spikes", up ? fmtNum(st.lagCount || 0) : "—",
      st.lagLast ? `${(st.lagLast.ms / 1000).toFixed(1)} s behind, ${fmtAgo(st.lagLast.t)}` : up ? "none this run" : "server offline",
      { title: "\"Can't keep up!\" warnings from the server — moments it fell seconds behind." }),
  ].join("");

  const note = $("#perf-note");
  if (note) {
    note.innerHTML = up && st.tpsSupport === "no"
      ? `<div class="banner perf-banner">${ico("alert")}<div>This server has no command that reports TPS. That needs Minecraft <b>1.20.3+</b> (any loader — it has <code>/tick query</code>), or Paper, Purpur, Forge or NeoForge on any version. CPU, memory, players and lag spikes are still tracked.</div></div>`
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
  const st = (state.perf.data && state.perf.data.current) || {};
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

function perfPaintCharts(id) {
  const box = $("#perf-charts");
  const P = perfState(id);
  if (!box || !P.data) return;
  const charts = perfCharts(id);
  if (box.children.length !== charts.length) {
    box.innerHTML = charts.map((c) => `
      <div class="perf-chart" data-k="${c.key}">
        <div class="pc-head"><span class="pc-title">${c.title}</span>${c.lag ? `<span class="pc-key"><i class="lag-key"></i>lag spike</span>` : ""}<b class="pc-now"></b></div>
        <div class="pc-plot"><svg height="${PERF_CHART_H}"></svg><div class="pc-tip" hidden></div></div>
      </div>`).join("");
  }
  const range = PERF_RANGES.find((r) => r.id === P.range);
  const now = Date.now();
  const x0 = now - range.span;
  const pts = P.data.history.points.filter((p) => p && p.t >= x0);
  const step = P.data.history.step || 5000;
  for (const c of charts) drawPerfChart($(`.perf-chart[data-k="${c.key}"]`, box), c, pts, { x0, x1: now, step, lag: c.lag ? (P.data.lag || []) : null });
}

function drawPerfChart(card, c, pts, dom) {
  const svg = $("svg", card);
  const plot = $(".pc-plot", card);
  const W = Math.max(200, plot.clientWidth || 400);
  const H = PERF_CHART_H;
  const pad = { l: 40, r: 10, t: 10, b: 20 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", W);

  const vals = pts.map((p) => p[c.key]).filter((v) => v != null);
  const last = [...pts].reverse().find((p) => p[c.key] != null);
  $(".pc-now", card).textContent = last ? `${c.fmt(last[c.key])}${c.unit ? " " + c.unit : ""}` : "";
  const yMax = c.yMax(vals.length ? Math.max(...vals) : 0) || 1;
  const X = (t) => pad.l + ((t - dom.x0) / (dom.x1 - dom.x0)) * iw;
  const Y = (v) => pad.t + ih - (Math.max(0, Math.min(v, yMax)) / yMax) * ih;

  // Recessive grid: four bands, labels in muted ink.
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (yMax / 4) * i, y = Y(v);
    g += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}"/>`;
    g += `<text class="ax" x="${pad.l - 6}" y="${y + 3.5}" text-anchor="end">${esc(axisFmt(c, v))}</text>`;
  }
  const span = dom.x1 - dom.x0;
  for (let i = 0; i <= 4; i++) {
    const t = dom.x0 + (span / 4) * i;
    const anchor = i === 0 ? "start" : i === 4 ? "end" : "middle";
    g += `<text class="ax" x="${X(t)}" y="${H - 5}" text-anchor="${anchor}">${i === 4 ? "now" : esc(timeTick(t, span))}</text>`;
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
    if (v == null || (prevT != null && p.t - prevT > dom.step * 2.5)) { cur = null; }
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

  let marks = "";
  if (dom.lag)
    for (const l of dom.lag) {
      if (l.t < dom.x0 || l.t > dom.x1) continue;
      const x = X(l.t);
      marks += `<path class="lag-mark" d="M${x - 4},${pad.t} L${x + 4},${pad.t} L${x},${pad.t + 6}Z"><title>${esc(fmtClock(l.t))} — ${l.ms} ms behind (${l.ticks} ticks)</title></path>`;
    }

  const empty = vals.length ? "" : `<text class="ax empty" x="${pad.l + iw / 2}" y="${pad.t + ih / 2}" text-anchor="middle">${c.key === "tps" || c.key === "mspt" || c.key === "entities" ? "No readings in this window" : "No data in this window yet"}</text>`;
  svg.innerHTML = `${g}${lines}${marks}${empty}<line class="xhair" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/><circle class="xdot" r="3.5" visibility="hidden"/><rect class="hit" x="${pad.l}" y="0" width="${iw}" height="${H}"/>`;

  // Crosshair + tooltip on the nearest sample.
  const tip = $(".pc-tip", card);
  const hx = $(".xhair", svg), hd = $(".xdot", svg), hit = $(".hit", svg);
  const withVal = pts.filter((p) => p[c.key] != null);
  hit.onmousemove = (ev) => {
    if (!withVal.length) return;
    const r = svg.getBoundingClientRect();
    const t = dom.x0 + ((ev.clientX - r.left - pad.l) / iw) * span;
    let best = withVal[0];
    for (const p of withVal) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    const x = X(best.t), y = Y(best[c.key]);
    hx.setAttribute("x1", x); hx.setAttribute("x2", x); hx.setAttribute("visibility", "visible");
    hd.setAttribute("cx", x); hd.setAttribute("cy", y); hd.setAttribute("visibility", "visible");
    const extra = c.key === "tps" && best.tpsMin != null && best.tpsMin < best.tps ? ` <span>low ${best.tpsMin.toFixed(1)}</span>` : "";
    tip.innerHTML = `<b>${esc(c.fmt(best[c.key]))}${c.unit ? " " + c.unit : ""}</b>${extra}<span>${esc(fmtWhen(best.t))}</span>`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.max(0, Math.min(W - tw, x - tw / 2)) + "px";
  };
  hit.onmouseleave = () => { tip.hidden = true; hx.setAttribute("visibility", "hidden"); hd.setAttribute("visibility", "hidden"); };
}

function axisFmt(c, v) {
  if (c.key === "mem") return v >= 1024 ? (v / 1024).toFixed(v % 1024 ? 1 : 0) + "G" : Math.round(v) + "M";
  if (v >= 10000) return Math.round(v / 1000) + "k";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
function timeTick(t, span) {
  const d = new Date(t);
  return span > 6 * 3600000
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : "-" + Math.round((Date.now() - t) / 60000) + "m";
}

function perfPaintLag(id) {
  const box = $("#perf-lag");
  const P = perfState(id);
  if (!box || !P.data) return;
  const lag = P.data.lag || [];
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
    ["TPS from", up && st.tpsSource ? perfSourceLabel(st.tpsSource) : up && st.tpsSupport === "no" ? "not available" : "—"],
  ];
  box.innerHTML = rows.map(([k, v]) => `<div><span>${k}</span><b>${esc(v)}</b></div>`).join("");
}

function perfPaintDisk(id) {
  const box = $("#perf-disk");
  const P = perfState(id);
  if (!box || !P.disk) return;
  const d = P.disk;
  const top = d.entries.slice(0, 7);
  const rest = d.entries.slice(7).reduce((a, e) => a + e.bytes, 0);
  if (rest) top.push({ name: `${d.entries.length - 7} more`, bytes: rest, other: true });
  const max = Math.max(1, ...top.map((e) => e.bytes));
  box.innerHTML = `
    <div class="perf-disk-total"><b>${fmtBytes(d.total)}</b> <span class="muted">in the server folder · measured ${fmtAgo(d.at)}</span></div>
    ${top.map((e) => `
      <div class="perf-disk-row" title="${esc(e.name)} — ${fmtBytes(e.bytes)}">
        <span class="n">${e.other ? "" : ico(e.dir ? "folder" : "file")} ${esc(e.name)}</span>
        <span class="bar"><i style="width:${(e.bytes / max) * 100}%"></i></span>
        <span class="v mono">${fmtBytes(e.bytes)}</span>
      </div>`).join("")}`;
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
    // The install finishing is what tells us which loader the server runs, so a
    // content tab that was showing "still installing" can now do its job.
    if (state.activeTab === "content" && s.content && !$("#md-list")) renderContentTab(s.id);
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
        <button class="btn btn-sm" id="md-upd">↻ Check for updates</button>
      </div>
    </div>
    <div id="md-installed"></div>

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
        <span class="muted">${esc(it.versionNumber || it.file.split("/").pop())}${it.fromPack ? " · from the modpack" : it.dependency ? " · dependency" : ""} · ${fmtBytes(it.size)}</span>
      </span>
      <span class="md-upd-slot" data-project="${esc(it.projectId)}">${updateButtonHTML(state.mdUpdates && state.mdUpdates.get(it.projectId))}</span>
      <span class="fdel" data-del="${esc(it.file)}" title="Remove">${ico("trash")}</span>
    </div>`).join("");

  const loose = unmanaged.map((u) => `
    <div class="file-row">
      <span class="fic">${ico("file")}</span>
      <span class="fname">${esc(u.name)} <span class="muted">added by hand · ${fmtBytes(u.size)}</span></span>
      <span class="fdel" data-del="${esc(u.file)}" title="Remove">${ico("trash")}</span>
    </div>`).join("");

  box.innerHTML = packRow || rows || loose
    ? `<div class="file-table">${packRow}${rows}${loose}</div>`
    : q
      ? `<div class="pk-empty">Nothing installed matches “${esc(state.mdQuery.trim())}”.</div>`
      : `<div class="pk-empty">Nothing installed yet — search below to add some.</div>`;

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
      <div style="margin-left:auto;display:flex;gap:8px">
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
      if (!e.target.closest || !e.target.closest("#fm-drop")) e.preventDefault();
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

async function loadDir(id, dir) {
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
    paintFiles(id);
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

function paintFiles(id) {
  const table = $("#fm-table");
  if (!table) return;
  const q = fmQuery.trim().toLowerCase();
  const src = fmDeep ? fmDeep.entries : fmEntries;
  fmRows = q ? src.filter((e) => e.name.toLowerCase().includes(q)) : src;
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
    </div>`;

  const rows = fmRows.map((e, i) => `
    <div class="file-row" data-i="${i}">
      <label class="fcheck"><input type="checkbox" class="fsel" data-i="${i}" /></label>
      <span class="fic">${e.dir ? ico("folder") : fileIcon(e.name)}</span>
      <span class="fname ${e.dir ? "dir" : ""}" data-i="${i}">${esc(e.name)}${
        fmDeep && parentOf(e.path) !== fmDir ? `<span class="fpath">in /${esc(parentOf(e.path))}</span>` : ""}</span>
      <span class="fsize">${e.dir ? "" : fmtBytes(e.size)}</span>
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
  syncSelection();
}

// After a change, come back the way we came: re-run the search if one is on
// screen, otherwise just reload the folder.
function refreshFiles(id) {
  if (fmDeep) return deepSearch(id);
  return loadDir(id, fmDir);
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
      <div class="section-title" style="margin-top:0">Public address</div>
      <div id="st-playit"></div>

      <div class="divider"></div>
      <div class="section-title" style="color:var(--red)">Danger zone</div>
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
  renderServerPlayit(id);
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
  $("#st-delete").onclick = async () => {
    const pl = state.servers.get(id)?.playit;
    if (!(await confirmDialog("Delete server?",
      `<p>Permanently delete <b>${esc(def.name)}</b> and every file it owns?</p>
       <p class="muted">Stop it first if it's running.${pl && pl.enabled ? " Its playit.gg tunnel is removed from your account too." : ""}</p>`,
      "Delete forever"))) return;
    try { await API.del(`/api/servers/${id}`); state.servers.delete(id); toast("Server deleted.", "ok"); go("#/"); }
    catch (e) { toast(e.message, "err"); }
  };
}

// The per-server public-address switch. Flipping it on creates a Minecraft
// tunnel on the linked playit.gg account and points it at this server's port.
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

  const statusLine = !pl.enabled
    ? "Off — players connect to localhost only."
    : pl.address
      ? (acct.agent === "online" ? "Live — anyone can join with this address." : "Address reserved; the tunnel connects when the agent is online.")
      : "playit is allocating an address…";

  box.innerHTML = `
    <div class="switch-row">
      <label class="switch"><input type="checkbox" id="st-pl" ${pl.enabled ? "checked" : ""} /><i></i></label>
      <div class="txt"><b>Public address via playit.gg</b><span>${esc(statusLine)}</span></div>
      ${pl.enabled ? addrChipHTML(pl) : ""}
    </div>
    ${pl.enabled && pl.address && pl.port
      ? `<div class="hint">Java clients find the port through an SRV record. If a client refuses the bare domain, use <span class="mono">${esc(pl.host)}:${pl.port}</span>.</div>`
      : ""}
    ${pl.disabled ? `<div class="banner warn" style="margin-top:12px">This tunnel is disabled at playit.gg — re-enable it there.</div>` : ""}`;

  bindAddrChips(box);
  const sw = $("#st-pl");
  if (!sw) return;
  sw.onchange = async () => {
    if (!sw.checked) return applyPlayit(id, sw, { enabled: false });
    // Turning it on: offer the account's existing tunnels first, so an address
    // friends already have can move here instead of a new one being minted.
    sw.checked = false;
    const pick = await pickTunnel(id);
    if (!pick) return;
    applyPlayit(id, sw, { enabled: true, tunnelId: pick === "new" ? null : pick });
  };
}

async function applyPlayit(id, sw, body) {
  if (sw) sw.disabled = true;
  try {
    const out = await API.post(`/api/servers/${id}/playit`, body);
    state.servers.set(id, out.server);
    toast(body.enabled ? "Public address enabled." : "Public address turned off.", "ok");
  } catch (e) {
    toast(e.message, "err");
  }
  if (sw) sw.disabled = false;
  renderServerPlayit(id);
  const addr = $("#srv-addr");
  if (addr) { addr.innerHTML = addrChipHTML((state.servers.get(id) || {}).playit); bindAddrChips(addr); }
}

// Resolves to a tunnel id, the string "new", or null if the user backed out.
// Skips straight to "new" when the account has nothing worth adopting.
function pickTunnel(id) {
  return new Promise(async (resolve) => {
    let tunnels = [];
    try {
      tunnels = (await API.get("/api/playit/tunnels")).tunnels;
    } catch (e) {
      toast(e.message, "err");
      return resolve(null);
    }
    const free = tunnels.filter((t) => !t.usedBy);
    if (!free.length) return resolve("new");

    modal(`
      <div class="modal-head"><h2>Public address</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <p class="hint" style="margin-top:0">Point one of your existing playit.gg tunnels at this server — it keeps its address, and MC Hoster takes over forwarding it — or make a new one.</p>
        <div class="file-table">
          ${free.map((t) => `
            <div class="file-row pick" data-t="${esc(t.id)}" style="cursor:pointer">
              <span class="fic">${t.recommended ? ico("check") : ico("plug")}</span>
              <span class="fname">${esc(t.name)}
                <span class="muted" style="font-size:11.5px">${esc(t.address || (t.status === "pending" ? "address pending" : "no address"))}${t.agent ? " · on " + esc(t.agent) : ""}</span>
              </span>
              <span class="fsize">${esc(t.type || t.portType)}</span>
            </div>`).join("")}
          <div class="file-row pick" data-t="new" style="cursor:pointer">
            <span class="fic">${ico("plus")}</span><span class="fname">Create a new Minecraft tunnel<span class="muted" style="font-size:11.5px">Fresh address, set up automatically</span></span>
            <span class="fsize">minecraft-java</span>
          </div>
        </div>
        <p class="hint">Tunnels already used by another server in this panel aren't listed.</p>
      </div>
      <div class="modal-foot"><span></span><button class="btn btn-ghost" data-x>Cancel</button></div>`, { wide: true });

    let done = false;
    const finish = (v) => { if (done) return; done = true; closeModal(); resolve(v); };
    $(".modal-close").onclick = $("[data-x]").onclick = () => finish(null);
    $$(".file-row.pick").forEach((el) => (el.onclick = () => finish(el.dataset.t)));
  });
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
      <div class="section-title" style="margin-top:0">Public access · playit.gg</div>
      <div id="playit-section"></div>

      <p class="hint" style="margin-top:22px">MC Hoster runs under the Multiapp Controller. Each Minecraft server is its own Java process managed here; this panel's own web port is assigned by the controller.</p>
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
  $("#set-save").onclick = async () => {
    try {
      state.settings = await API.put("/api/settings", { javaPath: $("#set-java").value.trim() || null, defaultMemory: Number(mem.value) });
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
    </div>
    ${pl.agentError ? `<div class="banner err" style="margin:0 0 12px">${esc(pl.agentError)}</div>` : ""}
    ${accountNote ? `<div class="banner warn" style="margin:0 0 12px">${esc(accountNote)} <a href="https://playit.gg/account" target="_blank" rel="noopener" style="text-decoration:underline">Open playit.gg</a></div>` : ""}
    <p class="hint" style="margin-top:0">Turn a public address on per server, in that server's <b>Settings</b> tab. Tunnels stay up while the panel runs.</p>
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

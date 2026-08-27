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
  playit: { supported: false, linked: false, agent: "stopped" },
  sys: null, // latest host resource sample (see sysmon.js)
  servers: new Map(), // id -> summary
  route: { name: "dashboard", id: null },
  consoleES: null, // EventSource for the open server console
  content: null, // last /content payload for the open server (installed mods)
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
function fmtBytes(b) {
  if (b < 1024) return b + " B";
  const u = ["KB", "MB", "GB", "TB"]; let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < 3);
  return b.toFixed(b < 10 ? 1 : 0) + " " + u[i];
}
const STATUS_LABEL = {
  running: "Online", stopped: "Offline", starting: "Starting", stopping: "Stopping",
  installing: "Installing", "install-failed": "Install failed", crashed: "Crashed",
};

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

function modal(html, { wide = false } = {}) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? "wide" : ""}">${html}</div></div>`;
  const bg = $(".modal-bg", root);
  bg.addEventListener("mousedown", (e) => { if (e.target === bg) closeModal(); });
  return root;
}
function closeModal() { $("#modal-root").innerHTML = ""; }

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
  try {
    const b = await API.get("/api/bootstrap");
    state.loaders = b.loaders;
    state.javas = b.javas;
    state.settings = b.settings;
    state.playit = b.playit || state.playit;
    state.sys = b.sys || null;
    b.servers.forEach((s) => state.servers.set(s.id, s));
  } catch (e) {
    view.innerHTML = `<div class="page"><div class="banner err">Failed to reach the backend: ${esc(e.message)}</div></div>`;
    return;
  }
  renderSidebar();
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
    if (state.route.name === "server" && $("#st-playit")) renderServerPlayit(state.route.id);
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
    if (e.type === "stats") s.stats = { memMB: e.memMB, cpu: e.cpu };
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
        <span class="emoji">${esc(s.icon || "🎮")}</span>
        <div class="meta">
          <div class="nm">${esc(s.name)}</div>
          <div class="sub">${esc(cap(s.loader))} · ${esc(s.mc || "")}</div>
        </div>
        <span class="dot ${s.status}"></span>
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
      pchip.onclick = openSettings;
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
    ${over ? `<span class="over">⚠ over-committed</span>` : ""}`;
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
    <div class="big">⛏️</div>
    <h2>No servers yet</h2>
    <p>Spin up a vanilla or modded Minecraft server in a few clicks.</p>
    <button class="btn btn-primary" id="empty-create"><span class="ic">＋</span> Create your first server</button>
  </div>`;
}

function cardHTML(s) {
  const busy = ["starting", "stopping", "installing"].includes(s.status);
  const primary = s.status === "running"
    ? `<button class="btn btn-sm btn-red" data-act="stop" data-id="${s.id}">■ Stop</button>`
    : `<button class="btn btn-sm btn-green" data-act="start" data-id="${s.id}" ${busy || s.status === "installing" ? "disabled" : ""}>▶ Start</button>`;
  return `
    <div class="card srv-card" data-id="${s.id}">
      <div class="srv-card-top">
        <div class="srv-card-emoji">${esc(s.icon || "🎮")}</div>
        <div class="srv-card-title">
          <h3>${esc(s.name)}</h3>
          <div class="row">
            <span class="badge loader">${esc(cap(s.loader))}</span>
            <span class="badge mc">${esc(s.mc || "—")}</span>
          </div>
        </div>
        <span class="pill ${s.status}">${s.status === "running" ? "● " : ""}${STATUS_LABEL[s.status] || s.status}</span>
      </div>
      <div class="srv-card-body">
        <div class="stat">RAM <b>${fmtMem(s.memory)}</b></div>
        <div class="stat">Port <b>${s.port}</b></div>
        <div class="stat">Players <b>${(s.players || []).length}/${s.maxPlayers}</b></div>
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
            <span class="li">${loaderEmoji(l.id)}</span>
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
        ? `<div class="hint">☕ Minecraft ${esc(r.mc)} needs <b>Java ${r.required}</b> — will run on Java ${esc(r.java.version)}.</div>`
        : `<div class="hint" style="color:var(--amber)">☕ Minecraft ${esc(r.mc)} needs <b>Java ${r.required}</b>, which isn't on this machine.
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
    next.textContent = "🚀 Create Server";
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
          ? `📦 <b style="color:var(--text)">${esc(wiz.pack.title)}</b> ${esc(wiz.packVersion ? wiz.packVersion.number : "")} · Minecraft <b style="color:var(--text)">${esc(wiz.mc)}</b> · ${esc((wiz.packVersion && wiz.packVersion.loaders[0]) || "")}
             <div style="margin-top:6px">Its mods and configs are downloaded during setup — client-only mods are left out.</div>`
          : `<b style="color:var(--text)">${esc(cap(wiz.loader))}</b> · Minecraft <b style="color:var(--text)">${esc(wiz.mc)}</b>${wiz.build ? ` · build <b style="color:var(--text)">${esc(wiz.build)}</b>` : ""}`}
        ${wiz.javaReq
          ? wiz.javaReq.ok
            ? `<div style="margin-top:8px">☕ Java ${wiz.javaReq.required} · using ${esc(wiz.javaReq.java.version)}</div>`
            : `<div style="color:var(--amber);margin-top:8px">☕ Needs Java ${wiz.javaReq.required} — MC Hoster will download Eclipse Temurin ${wiz.javaReq.required} during setup.</div>`
          : ""}
      </div>`;
    const mem = $("#d-mem");
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

function loaderEmoji(id) {
  return { vanilla: "🟩", paper: "📄", purpur: "🟣", fabric: "🧵", quilt: "🧶", forge: "🔨", neoforge: "🌘", modrinth: "📦" }[id] || "🎮";
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
        <div class="emoji">${esc(s.icon || "🎮")}</div>
        <div>
          <h1>${esc(s.name)}</h1>
          <div class="row">
            <span class="pill ${s.status}" id="srv-pill">${s.status === "running" ? "● " : ""}${STATUS_LABEL[s.status] || s.status}</span>
            <span class="badge loader">${esc(cap(s.loader))}</span>
            <span class="badge mc">${esc(s.mc || "")}</span>
            ${s.modLoader ? `<span class="badge loader">${esc(cap(s.modLoader))}</span>` : ""}
            ${s.pack ? `<span class="badge mc" title="Modrinth modpack">📦 ${esc(s.pack.versionNumber || "")}</span>` : s.build ? `<span class="badge">${esc(s.build)}</span>` : ""}
            <span class="badge mono" title="Local connect address">localhost:${s.port}</span>
            <span id="srv-addr">${addrChipHTML(s.playit)}</span>
          </div>
        </div>
        <div class="srv-actions" id="srv-actions"></div>
      </div>

      <div id="eula-slot"></div>

      <div class="statbar">
        <div class="stat-tile"><span class="label">Status</span><span class="value" id="t-status">${STATUS_LABEL[s.status] || s.status}</span></div>
        <div class="stat-tile"><span class="label">Uptime</span><span class="value" id="t-uptime">${fmtUptime(s.startedAt ? Date.now() - s.startedAt : 0)}</span></div>
        <div class="stat-tile">
          <span class="label">Memory</span>
          <span class="value" id="t-mem">${s.stats?.memMB ? fmtMem(s.stats.memMB) : "—"} <small>/ ${fmtMem(s.memory)}</small></span>
          <div class="bar"><i id="t-membar" style="width:${s.stats?.memMB ? Math.min(100, (s.stats.memMB / s.memory) * 100) : 0}%"></i></div>
        </div>
        <div class="stat-tile"><span class="label">Players</span><span class="value" id="t-players">${(s.players || []).length} <small>/ ${s.maxPlayers}</small></span></div>
      </div>

      <div class="tabs" id="tabs">
        <div class="tab" data-tab="console">Console</div>
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
  }, 1000);
}

function renderActions(s) {
  const box = $("#srv-actions");
  if (!box) return;
  const running = s.status === "running";
  const busy = ["starting", "stopping", "installing"].includes(s.status);
  box.innerHTML = `
    ${running || s.status === "starting"
      ? `<button class="btn btn-red" data-a="stop">■ Stop</button>
         <button class="btn" data-a="restart">↻ Restart</button>`
      : `<button class="btn btn-green" data-a="start" ${busy ? "disabled" : ""}>▶ Start</button>`}
    ${running || s.status === "starting" ? `<button class="btn btn-ghost btn-icon" data-a="kill" title="Force kill">⚡</button>` : ""}
  `;
  $$("[data-a]", box).forEach((b) => (b.onclick = () => serverAction(s.id, b.dataset.a)));
}

function renderEula(s) {
  const slot = $("#eula-slot");
  if (!slot) return;
  if (s.status === "installing") {
    slot.innerHTML = `<div class="banner warn"><span class="spinner"></span> Installing server files… watch the console below for progress.</div>`;
  } else if (s.status === "install-failed") {
    slot.innerHTML = `<div class="banner err">⚠ Installation failed. Check the console for details — you can delete this server in Settings and try again.</div>`;
  } else if (!s.eula) {
    slot.innerHTML = `<div class="banner warn">
      <span>📜</span>
      <div>You must accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" style="color:inherit;text-decoration:underline">Minecraft EULA</a> before starting this server.</div>
      <div class="b-actions"><button class="btn btn-sm btn-primary" id="accept-eula">Accept EULA</button></div>
    </div>`;
    $("#accept-eula").onclick = async () => {
      try { await API.post(`/api/servers/${s.id}/eula`, { accepted: true }); toast("EULA accepted.", "ok"); }
      catch (e) { toast(e.message, "err"); }
    };
  } else slot.innerHTML = "";
}

async function serverAction(id, act) {
  try {
    if (act === "kill" && !(await confirmDialog("Force kill?", "<p class='muted'>This hard-kills the process without saving the world. Use only if it's stuck.</p>", "Force kill"))) return;
    await API.post(`/api/servers/${id}/${act === "kill" ? "stop?force=1" : act}`);
  } catch (e) { toast(e.message, "err"); }
}

/* ------------------------------------------------------------- tab switching */
const TABS = ["console", "content", "files", "properties", "settings"];
function selectTab(id, tab) {
  state.activeTab = tab;
  $$("#tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  closeConsoleStream();
  if (tab === "console") renderConsoleTab(id);
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
          <span class="t"><span class="dot ${s.status}"></span> Console</span>
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
          <h4>Quick commands</h4>
          <div style="display:flex;flex-direction:column;gap:6px">
            ${["list", "say Hello from the panel!", "weather clear", "time set day", "save-all"].map((c) =>
              `<button class="btn btn-sm btn-ghost" data-cmd="${esc(c)}" style="justify-content:flex-start">${esc(c)}</button>`).join("")}
          </div>
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
  $$("[data-cmd]").forEach((b) => (b.onclick = async () => {
    try { await API.post(`/api/servers/${id}/command`, { cmd: b.dataset.cmd }); } catch (e) { toast(e.message, "err"); }
  }));
  $("#con-clear").onclick = () => (out.innerHTML = "");

  openConsoleStream(id, out);
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

function openConsoleStream(id, out) {
  const es = new EventSource(`/api/servers/${id}/console`);
  state.consoleES = es;
  es.onmessage = (ev) => {
    let e; try { e = JSON.parse(ev.data); } catch { return; }
    if (e.type === "ping") return;
    if (e.type === "console") appendConsole(out, e.stream, e.line);
    else if (e.type === "players") { const s = state.servers.get(id); if (s) { s.players = e.players; renderPlayers(s); } }
    else if (e.type === "pings") { const s = state.servers.get(id); if (s) { s.pings = e.pings; renderPlayers(s); } }
    else if (e.type === "status") {
      const s = state.servers.get(id); if (s) Object.assign(s, e);
      const inp = $("#con-in"); if (inp) inp.disabled = e.status !== "running";
      const dot = $(".console-head .dot"); if (dot) dot.className = "dot " + e.status;
    }
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
    : `<div class="players-empty">${s.status === "running" ? "No one online." : "Server offline."}</div>`;
}

// Latency comes from the server's own `ping` command, which only Paper,
// Purpur and plugin-added variants have — elsewhere we show a quiet dash.
function pingChip(ms) {
  if (!Number.isFinite(ms))
    return `<span class="ping none" title="This server doesn't report ping — Paper and Purpur do.">—</span>`;
  const q = ms < 80 ? "good" : ms < 160 ? "ok" : "bad";
  return `<span class="ping ${q}" title="${ms} ms round-trip"><i></i>${ms}<small>ms</small></span>`;
}

/* ------------------------------------------------------- live patch (server) */
function patchServerLive(e) {
  if (e.type === "status") {
    const s = state.servers.get(e.id);
    renderActions(s); renderEula(s);
    const pill = $("#srv-pill"); if (pill) { pill.className = "pill " + s.status; pill.textContent = (s.status === "running" ? "● " : "") + (STATUS_LABEL[s.status] || s.status); }
    const ts = $("#t-status"); if (ts) ts.textContent = STATUS_LABEL[s.status] || s.status;
    const addr = $("#srv-addr");
    if (addr) { addr.innerHTML = addrChipHTML(s.playit); bindAddrChips(addr); }
    if ($("#st-playit")) renderServerPlayit(s.id);
    // The install finishing is what tells us which loader the server runs, so a
    // content tab that was showing "still installing" can now do its job.
    if (state.activeTab === "content" && s.content && !$("#md-list")) renderContentTab(s.id);
  }
  if (e.type === "stats") {
    const s = state.servers.get(e.id);
    const m = $("#t-mem"); if (m) m.innerHTML = `${e.memMB ? fmtMem(e.memMB) : "—"} <small>/ ${fmtMem(s.memory)}</small>`;
    const bar = $("#t-membar"); if (bar) bar.style.width = Math.min(100, (e.memMB / s.memory) * 100) + "%";
  }
  if (e.type === "players") {
    const p = $("#t-players"); const s = state.servers.get(e.id);
    if (p) p.innerHTML = `${e.players.length} <small>/ ${s.maxPlayers}</small>`;
  }
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
function projectRowHTML(p, selected, actions = "") {
  return `
    <div class="pk-row ${selected ? "sel" : ""}" data-id="${esc(p.id)}" data-slug="${esc(p.slug)}">
      <span class="pk-icon">${p.icon ? `<img src="${esc(p.icon)}" alt="" loading="lazy" />` : "<span>📦</span>"}</span>
      <div class="pk-meta">
        <div class="pk-title">${esc(p.title)} <span class="pk-author">by ${esc(p.author)}</span></div>
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
      <button class="btn btn-sm" id="md-upd">↻ Check for updates</button>
    </div>
    <div id="md-installed"></div>

    <div class="divider"></div>
    <div class="mods-head">
      <div>
        <h3>Browse Modrinth</h3>
        <p class="muted">Only ${esc(content.noun.toLowerCase())} that run on ${esc(cap(content.loader))} ${esc(s.mc)} are listed.</p>
      </div>
    </div>
    <div class="pk-bar">
      <input type="text" id="md-q" placeholder="Search ${esc(content.noun.toLowerCase())}…" autocomplete="off" />
      <select id="md-sort" style="width:auto;min-width:150px">
        ${[["relevance", "Best match"], ["downloads", "Most downloads"], ["follows", "Most followed"], ["updated", "Recently updated"]]
          .map(([v, l]) => `<option value="${v}" ${v === "downloads" ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <label class="chk" title="Client-only mods do nothing on a server, and a few crash it"><input type="checkbox" id="md-srv" checked /> Server-compatible only</label>
    </div>
    <div class="pk-list" id="md-list"></div>
    <div id="md-more" style="margin-top:12px"></div>`;

  await loadInstalled(id);

  let timer = null;
  const q = $("#md-q");
  q.oninput = () => { clearTimeout(timer); timer = setTimeout(() => browse(id, 0), 350); };
  q.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); browse(id, 0); } };
  $("#md-sort").onchange = () => browse(id, 0);
  $("#md-srv").onchange = () => browse(id, 0);
  $("#md-upd").onclick = () => checkUpdates(id);
  browse(id, 0);
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
  const total = data.items.length + data.unmanaged.length;
  const count = $("#md-count");
  if (count) count.textContent = total ? `· ${total} installed` : "";

  const packRow = data.pack
    ? `<div class="file-row md-item" data-slug="${esc(data.pack.projectId || "")}">
         <span class="fic">📦</span>
         <span class="fname"><b>${esc(data.pack.name)}</b> ${esc(data.pack.versionNumber || "")}
           <span class="muted">modpack · ${data.pack.files} files installed with the server</span></span>
       </div>`
    : "";

  const rows = data.items.map((it) => `
    <div class="file-row md-item" data-slug="${esc(it.slug || "")}">
      <span class="fic">${it.icon ? `<img class="md-ic" src="${esc(it.icon)}" alt="" loading="lazy" />` : "🧩"}</span>
      <span class="fname">
        <a href="https://modrinth.com/project/${esc(it.slug)}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <span class="muted">${esc(it.versionNumber || it.file.split("/").pop())}${it.fromPack ? " · from the modpack" : it.dependency ? " · dependency" : ""} · ${fmtBytes(it.size)}</span>
      </span>
      <span class="md-upd-slot" data-project="${esc(it.projectId)}"></span>
      <span class="fdel" data-del="${esc(it.file)}" title="Remove">🗑</span>
    </div>`).join("");

  const loose = data.unmanaged.map((u) => `
    <div class="file-row">
      <span class="fic">📄</span>
      <span class="fname">${esc(u.name)} <span class="muted">added by hand · ${fmtBytes(u.size)}</span></span>
      <span class="fdel" data-del="${esc(u.file)}" title="Remove">🗑</span>
    </div>`).join("");

  box.innerHTML = packRow || rows || loose
    ? `<div class="file-table">${packRow}${rows}${loose}</div>`
    : `<div class="pk-empty">Nothing installed yet — search below to add some.</div>`;

  bindModrinthLinks(box);
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
  const serverOnly = $("#md-srv").checked ? "1" : "0";
  if (!offset) list.innerHTML = `<div class="pk-empty"><span class="spinner"></span> Searching Modrinth…</div>`;

  try {
    const r = await API.get(
      `/api/modrinth/search?type=${encodeURIComponent(content.projectType)}` +
        `&mc=${encodeURIComponent(s.mc)}&q=${encodeURIComponent(query)}&sort=${encodeURIComponent(sort)}` +
        `&server=${serverOnly}&offset=${offset}&limit=20${loaderQS(content)}`
    );
    const have = new Set(((state.content && state.content.items) || []).map((i) => i.projectId));
    const html = r.hits
      .map((h) => projectRowHTML(h, false, `
        <div class="pk-actions">
          <button class="btn btn-sm ${have.has(h.id) ? "" : "btn-primary"}" data-install="${esc(h.id)}">${have.has(h.id) ? "Reinstall" : "Install"}</button>
          <button class="btn btn-sm btn-ghost btn-icon" data-versions="${esc(h.slug)}" title="Pick a specific version">⋯</button>
        </div>`))
      .join("");

    if (!offset)
      list.innerHTML = html || `<div class="pk-empty">Nothing on Modrinth matches that for ${esc(cap(content.loader))} ${esc(s.mc)}.</div>`;
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
    b.onclick = () => installContent(id, { projectId: b.dataset.install }, b);
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

// Pick an exact build instead of "whatever is newest" — what you want when a
// pack, or a friend's client, pins one particular version.
async function openVersionPicker(id, slug) {
  const s = state.servers.get(id);
  const content = s.content;
  modal(`
    <div class="modal-head"><h2>Choose a version</h2><button class="modal-close">×</button></div>
    <div class="modal-body" id="vp-body"><div class="pk-empty"><span class="spinner"></span> Loading versions…</div></div>
    <div class="modal-foot"><span class="muted mono" style="font-size:12px">${esc(slug)}</span><button class="btn btn-ghost" data-x>Close</button></div>`,
    { wide: true });
  $(".modal-close").onclick = $("[data-x]").onclick = closeModal;
  try {
    const { versions } = await API.get(
      `/api/modrinth/versions?project=${encodeURIComponent(slug)}&mc=${encodeURIComponent(s.mc)}${loaderQS(content)}`
    );
    const b = $("#vp-body");
    if (!b) return;
    b.innerHTML = versions.length
      ? `<div class="file-table">${versions.slice(0, 60).map((v) => `
          <div class="file-row">
            <span class="fic">${v.type === "release" ? "🟢" : v.type === "beta" ? "🟡" : "🔴"}</span>
            <span class="fname">${esc(v.number)}
              <span class="muted">${esc(v.name)} · ${esc(v.gameVersions.join(", "))} · ${fmtCount(v.downloads)} downloads</span></span>
            <button class="btn btn-sm btn-primary" data-v="${esc(v.id)}">Install</button>
          </div>`).join("")}</div>`
      : `<div class="pk-empty">No builds of this project target ${esc(cap(content.loader))} ${esc(s.mc)}.</div>`;
    $$("[data-v]", b).forEach((btn) => (btn.onclick = async () => {
      await installContent(id, { versionId: btn.dataset.v }, btn);
      closeModal();
    }));
  } catch (e) {
    const b = $("#vp-body");
    if (b) b.innerHTML = `<div class="banner err" style="margin:0">${esc(e.message)}</div>`;
  }
}

async function checkUpdates(id) {
  const btn = $("#md-upd");
  btn.disabled = true;
  btn.textContent = "↻ Checking…";
  try {
    const { updates } = await API.get(`/api/servers/${id}/content/updates`);
    $$(".md-upd-slot").forEach((el) => (el.innerHTML = ""));
    if (!updates.length) toast("Everything is up to date.", "ok");
    for (const u of updates) {
      const slot = $(`.md-upd-slot[data-project="${u.projectId}"]`);
      if (!slot) continue;
      slot.innerHTML = `<button class="btn btn-sm btn-primary" data-up="${esc(u.versionId)}" title="${esc(u.from)} → ${esc(u.to)}">Update to ${esc(u.to)}</button>`;
      slot.firstElementChild.onclick = (ev) => installContent(id, { versionId: u.versionId }, ev.currentTarget);
    }
    if (updates.length) toast(`${updates.length} update${updates.length === 1 ? "" : "s"} available.`, "ok");
  } catch (e) {
    toast(e.message, "err");
  }
  btn.disabled = false;
  btn.textContent = "↻ Check for updates";
}

/* ------------------------------------------------------------- files tab */
async function renderFilesTab(id, dir = "") {
  const body = $("#tab-body");
  body.innerHTML = `
    <div class="fm-bar">
      <div class="breadcrumb" id="fm-crumb"></div>
      <div style="margin-left:auto;display:flex;gap:8px">
        <button class="btn btn-sm" id="fm-mkdir"><span class="ic">📁</span> New folder</button>
        <label class="btn btn-sm btn-primary" style="cursor:pointer"><span class="ic">⬆</span> Upload
          <input type="file" id="fm-upload" multiple style="display:none" />
        </label>
      </div>
    </div>
    <div class="file-table" id="fm-table"></div>
    <p class="hint" style="margin-top:10px">Drop mods into <span class="mono">mods/</span>, plugins into <span class="mono">plugins/</span>, datapacks into <span class="mono">world/datapacks/</span> — or install them from Modrinth in the previous tab.</p>`;

  await loadDir(id, dir);
  $("#fm-mkdir").onclick = async () => {
    const name = prompt("New folder name:");
    if (!name) return;
    try { await API.post(`/api/servers/${id}/mkdir`, { path: joinPath(dir, name) }); loadDir(id, dir); }
    catch (e) { toast(e.message, "err"); }
  };
  $("#fm-upload").onchange = async (ev) => {
    for (const file of ev.target.files) {
      try {
        await fetch(`/api/servers/${id}/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
        toast(`Uploaded ${file.name}`, "ok");
      } catch (e) { toast(`Upload failed: ${file.name}`, "err"); }
    }
    loadDir(id, dir);
  };
}

function joinPath(a, b) { return (a ? a + "/" : "") + b; }

async function loadDir(id, dir) {
  const table = $("#fm-table"), crumb = $("#fm-crumb");
  try {
    const data = await API.get(`/api/servers/${id}/files?path=${encodeURIComponent(dir)}`);
    const parts = dir ? dir.split("/") : [];
    crumb.innerHTML = `<a data-p="">⌂ root</a>` + parts.map((p, i) =>
      ` / <a data-p="${esc(parts.slice(0, i + 1).join("/"))}">${esc(p)}</a>`).join("");
    $$("#fm-crumb a").forEach((a) => (a.onclick = () => renderFilesTab(id, a.dataset.p)));

    table.innerHTML = data.entries.length ? data.entries.map((e) => `
      <div class="file-row">
        <span class="fic">${e.dir ? "📁" : fileIcon(e.name)}</span>
        <span class="fname ${e.dir ? "dir" : ""}" data-name="${esc(e.name)}" data-dir="${e.dir}">${esc(e.name)}</span>
        <span class="fsize">${e.dir ? "" : fmtBytes(e.size)}</span>
        <span class="fdel" data-name="${esc(e.name)}" title="Delete">🗑</span>
      </div>`).join("") : `<div class="file-row"><span class="muted" style="padding:4px">Empty folder.</span></div>`;

    $$("#fm-table .fname").forEach((el) => (el.onclick = () => {
      if (el.dataset.dir === "true") renderFilesTab(id, joinPath(dir, el.dataset.name));
      else openFileEditor(id, joinPath(dir, el.dataset.name), el.dataset.name);
    }));
    $$("#fm-table .fdel").forEach((el) => (el.onclick = async () => {
      if (!(await confirmDialog("Delete?", `<p>Delete <b class="mono">${esc(el.dataset.name)}</b>?</p>`, "Delete"))) return;
      try { await API.del(`/api/servers/${id}/file?path=${encodeURIComponent(joinPath(dir, el.dataset.name))}`); loadDir(id, dir); }
      catch (e) { toast(e.message, "err"); }
    }));
  } catch (e) {
    table.innerHTML = `<div class="file-row"><span class="muted">${esc(e.message)}</span></div>`;
  }
}

function fileIcon(name) {
  if (/\.jar$/i.test(name)) return "📦";
  if (/\.(properties|toml|json|json5|cfg|conf|yml|yaml|txt|log|md)$/i.test(name)) return "📄";
  if (/\.(png|jpg|jpeg|gif)$/i.test(name)) return "🖼";
  if (/\.(zip|gz)$/i.test(name)) return "🗜";
  return "📄";
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
async function renderPropertiesTab(id) {
  const body = $("#tab-body");
  body.innerHTML = `<div class="banner warn" style="margin-bottom:16px">Editing <span class="mono">server.properties</span>. Changes apply on next start (or restart).</div>
    <textarea id="props-area" style="height:52vh;min-height:340px" spellcheck="false"></textarea>
    <div style="margin-top:14px;display:flex;gap:10px"><button class="btn btn-primary" id="props-save">Save properties</button></div>`;
  try {
    const { text } = await API.get(`/api/servers/${id}/properties`);
    $("#props-area").value = text || "# server.properties will be generated after first start\n";
  } catch (e) { $("#props-area").value = "# " + e.message; }
  $("#props-save").onclick = async () => {
    try { await API.put(`/api/servers/${id}/properties`, { text: $("#props-area").value }); toast("Saved.", "ok"); }
    catch (e) { toast(e.message, "err"); }
  };
}

/* -------------------------------------------------------------- settings tab */
async function renderSettingsTab(id) {
  const s = state.servers.get(id);
  const data = await API.get(`/api/servers/${id}`);
  const def = data.def;
  const body = $("#tab-body");
  body.innerHTML = `
    <div style="max-width:620px">
      <div class="form-row"><label>Server name</label><input type="text" id="st-name" value="${esc(def.name)}" /></div>
      <div class="form-row"><label>Icon (emoji)</label><input type="text" id="st-icon" value="${esc(def.icon || "")}" maxlength="4" style="width:90px" /></div>
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
  const mem = $("#st-mem"); mem.oninput = () => ($("#st-memv").textContent = fmtMem(Number(mem.value)));
  renderServerPlayit(id);
  $("#st-save").onclick = async () => {
    try {
      await API.patch(`/api/servers/${id}`, {
        name: $("#st-name").value.trim(), icon: $("#st-icon").value.trim() || "🎮",
        port: Number($("#st-port").value), maxPlayers: Number($("#st-max").value),
        memory: Number(mem.value), jvmArgs: $("#st-jvm").value.trim(), javaPath: $("#st-java").value.trim() || null,
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
      <div class="modal-head"><h2>🌍 Public address</h2><button class="modal-close">×</button></div>
      <div class="modal-body">
        <p class="hint" style="margin-top:0">Point one of your existing playit.gg tunnels at this server — it keeps its address, and MC Hoster takes over forwarding it — or make a new one.</p>
        <div class="file-table">
          ${free.map((t) => `
            <div class="file-row pick" data-t="${esc(t.id)}" style="cursor:pointer">
              <span class="fic">${t.recommended ? "🟩" : "🔌"}</span>
              <span class="fname">${esc(t.name)}
                <span class="muted" style="font-size:11.5px">${esc(t.address || (t.status === "pending" ? "address pending" : "no address"))}${t.agent ? " · on " + esc(t.agent) : ""}</span>
              </span>
              <span class="fsize">${esc(t.type || t.portType)}</span>
            </div>`).join("")}
          <div class="file-row pick" data-t="new" style="cursor:pointer">
            <span class="fic">＋</span><span class="fname">Create a new Minecraft tunnel<span class="muted" style="font-size:11.5px">Fresh address, set up automatically</span></span>
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
    <div class="modal-head"><h2>⚙ Settings</h2><button class="modal-close">×</button></div>
    <div class="modal-body">
      <div class="section-title" style="margin-top:0">Java runtimes</div>
      ${javas.length ? `<div class="file-table">${javas.map((j) => `
        <div class="file-row"><span class="fic">☕</span><span class="fname mono">${esc(j.path)}</span><span class="fsize">Java ${esc(String(j.major))}${j.managed ? " · managed" : ""} · v${esc(j.version)}</span></div>`).join("")}</div>`
        : `<div class="banner err" style="margin:0">No Java runtime found. Pick a version below and MC Hoster will fetch an Eclipse Temurin JRE into its own <span class="mono">data/runtimes</span> folder — nothing is installed system-wide.</div>`}
      <p class="hint" style="margin-top:8px">Minecraft pins a Java version per release: 1.16 and older need 8, 1.18–1.20.4 need 17, 1.20.5–1.21.x need 21, and 26.x needs 25. MC Hoster matches the right one per server and downloads it if it's missing.</p>
      <div style="margin-top:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn btn-sm" id="set-rescan">↻ Rescan for Java</button>
        <span class="muted" style="font-size:12px">Add runtime:</span>
        <select id="set-jmajor" style="width:auto;min-width:110px">${[25, 21, 17, 8].map((m) => `<option value="${m}">Java ${m}${JAVA_NOTE[m] ? " · " + JAVA_NOTE[m] : ""}</option>`).join("")}</select>
        <button class="btn btn-sm" id="set-jget">⬇ Download</button>
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
    btn.textContent = "⬇ Downloading Java " + major + "…";
    try {
      const out = await API.post("/api/java/install", { major });
      state.javas = out.javas;
      closeModal();
      renderSidebar();
      toast(`Java ${out.java.version} installed.`, "ok");
      openSettings();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "⬇ Download";
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
  if (!pl.address) return `<span class="addr pending" title="playit is allocating an address">🌍 allocating…</span>`;
  return `<span class="addr" data-copy="${esc(pl.address)}" title="Public address — click to copy">🌍 ${esc(pl.address)} <span class="copy">⧉</span></span>`;
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
      accepted: "✔ Approved — finishing up…",
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
      <button class="btn btn-primary" id="pl-link">🌍 Connect playit.gg</button>`;
    $("#pl-link").onclick = async () => {
      const btn = $("#pl-link");
      btn.disabled = true;
      btn.textContent = pl.installed ? "Starting…" : "⬇ Downloading agent…";
      try {
        await playitCall("/api/playit/link");
        renderPlayitSection();
      } catch (e) {
        toast(e.message, "err");
        btn.disabled = false;
        btn.textContent = "🌍 Connect playit.gg";
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
      <button class="btn btn-sm" id="pl-refresh">↻ Refresh tunnels</button>
      <a class="btn btn-sm" href="https://playit.gg/account/tunnels" target="_blank" rel="noopener">Manage at playit.gg</a>
      <button class="btn btn-sm btn-red" id="pl-unlink">Unlink account</button>
    </div>`;
  $("#pl-refresh").onclick = async () => {
    const btn = $("#pl-refresh");
    btn.disabled = true; btn.textContent = "↻ Refreshing…";
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

boot();

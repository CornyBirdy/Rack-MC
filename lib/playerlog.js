/*
 * playerlog.js — the per-server player history: who joined, when, for how
 * long, what they said and what happened to them.
 *
 * Minecraft servers already narrate all of this to their console, but the
 * console is a 400-line ring buffer that dies with the process. This keeps a
 * durable copy per server:
 *
 *   data/playerlog/<id>/events.jsonl  — one JSON event per line, append-only
 *   data/playerlog/<id>/roster.json   — per-player totals + recent sessions
 *
 * manager.js feeds every console line through observe() and calls join()/
 * leave() from the same place it maintains the live player list, so the log
 * and the dashboard can never disagree about who is on. Everything is kept in
 * memory once loaded and written back in small batches; a panel that is only
 * ever asked for a roster should not be doing disk I/O per chat message.
 */
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");

const store = require("./store");

const LOG_DIR = path.join(store.DATA_DIR, "playerlog");
const MAX_EVENTS = 20000; // events retained per server
const TRIM_SLACK = 2000; // ... rewrite the file only once it is this far over
const FLUSH_MS = 2000; // batching window for appends
const MAX_SESSIONS = 40; // per-player session history kept in the roster
const MAX_TEXT = 500; // a chat line is not allowed to become a novel

const events = new EventEmitter();
events.setMaxListeners(0);

const EVENT_TYPES = ["join", "leave", "chat", "death", "advancement", "command", "server"];

// id -> in-memory book. Loaded lazily; a server nobody looks at costs nothing.
const books = new Map();

/* ------------------------------------------------------------------- files */

function dirFor(id) {
  return path.join(LOG_DIR, String(id));
}
function eventsFile(id) {
  return path.join(dirFor(id), "events.jsonl");
}
function rosterFile(id) {
  return path.join(dirFor(id), "roster.json");
}

// A roster row for someone the log has never recorded. Deliberately not saved:
// the moment they do anything, the real record is created.
function liveOnly(name, t) {
  return {
    name, uuid: null, ip: null, firstSeen: null, lastSeen: t,
    sessions: 0, playtimeMs: 0, chat: 0, deaths: 0, advancements: 0, commands: 0,
    online: true, since: null, sessionMs: 0,
  };
}

function blankPlayer(name, t) {
  return {
    name,
    uuid: null,
    ip: null,
    firstSeen: t,
    lastSeen: t,
    sessions: 0,
    playtimeMs: 0,
    chat: 0,
    deaths: 0,
    advancements: 0,
    commands: 0,
    online: false,
    joinedAt: null,
    recent: [], // newest first: { from, to, ms, reason }
  };
}

function book(id) {
  let b = books.get(id);
  if (b) return b;
  b = {
    id,
    events: [],
    players: {},
    since: null, // when tracking for this server began
    seq: 1,
    queue: [], // events waiting to be appended
    rewrite: false, // a trim happened: replace the file rather than append to it
    flushTimer: null,
    rosterTimer: null,
    pending: {}, // name -> { ip, uuid } learned from the login lines before "joined"
    typed: {}, // name -> when Paper last said they issued a command
  };
  books.set(id, b);
  load(b);
  return b;
}

// Read whatever previous runs left behind. A truncated or hand-edited line is
// skipped rather than taken as the end of the file — this is a log, not a
// ledger, and one bad line should not cost the rest of the history.
function load(b) {
  let lines = [];
  try {
    lines = fs.readFileSync(eventsFile(b.id), "utf8").split("\n");
  } catch {
    lines = [];
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e.t === "number" && e.type) b.events.push(e);
    } catch {}
  }
  if (b.events.length > MAX_EVENTS) {
    b.events = b.events.slice(-MAX_EVENTS);
    b.rewrite = true;
    schedule(b);
  }
  b.seq = b.events.length ? (b.events[b.events.length - 1].seq || 0) + 1 : 1;

  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(rosterFile(b.id), "utf8"));
  } catch {}
  if (saved && saved.players) {
    for (const [name, rec] of Object.entries(saved.players))
      b.players[name] = { ...blankPlayer(name, rec.firstSeen || Date.now()), ...rec, name };
    b.since = saved.since || null;
  }
  if (!b.since) b.since = b.events.length ? b.events[0].t : null;
  // Sessions still marked online are left open here: whether they really
  // ended depends on whether the server outlived the panel, which the manager
  // finds out on boot — see closeStale() and onlineNames().
}

// The panel (or the machine) went down with people online and the server
// went with it. Their session ends at the last thing we actually saw, not at
// whenever we booted again.
function closeStale(id) {
  const b = book(id);
  let changed = false;
  for (const rec of Object.values(b.players)) {
    if (!rec.online) continue;
    const end = Math.max(rec.lastSeen || 0, rec.joinedAt || 0);
    closeSession(rec, end, "panel restarted");
    changed = true;
  }
  b.pending = {};
  if (changed) saveRoster(b);
}

// Who the log still has online — after a panel restart, the starting point
// for a server that kept running.
function onlineNames(id) {
  return Object.values(book(id).players)
    .filter((rec) => rec.online)
    .map((rec) => rec.name);
}

function schedule(b) {
  if (b.flushTimer) return;
  b.flushTimer = setTimeout(() => {
    b.flushTimer = null;
    flush(b);
  }, FLUSH_MS);
  if (b.flushTimer.unref) b.flushTimer.unref();
}

function flush(b) {
  if (!b.rewrite && !b.queue.length) return;
  try {
    fs.mkdirSync(dirFor(b.id), { recursive: true });
    if (b.rewrite) {
      fs.writeFileSync(eventsFile(b.id), b.events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      b.rewrite = false;
    } else {
      fs.appendFileSync(eventsFile(b.id), b.queue.map((e) => JSON.stringify(e)).join("\n") + "\n");
    }
    b.queue = [];
  } catch (e) {
    // Losing history is not worth taking a Minecraft server down for.
    console.error("[playerlog] could not write log for " + b.id + ": " + e.message);
    b.queue = [];
  }
}

function saveRoster(b) {
  if (b.rosterTimer) return;
  b.rosterTimer = setTimeout(() => {
    b.rosterTimer = null;
    try {
      fs.mkdirSync(dirFor(b.id), { recursive: true });
      fs.writeFileSync(rosterFile(b.id), JSON.stringify({ since: b.since, players: b.players }, null, 2));
    } catch (e) {
      console.error("[playerlog] could not write roster for " + b.id + ": " + e.message);
    }
  }, FLUSH_MS);
  if (b.rosterTimer.unref) b.rosterTimer.unref();
}

// Write everything out now — used on shutdown, where a 2s batching window is
// two seconds we do not have.
function flushAll() {
  for (const b of books.values()) {
    if (b.flushTimer) clearTimeout(b.flushTimer);
    b.flushTimer = null;
    flush(b);
    if (b.rosterTimer) {
      clearTimeout(b.rosterTimer);
      b.rosterTimer = null;
      try {
        fs.mkdirSync(dirFor(b.id), { recursive: true });
        fs.writeFileSync(rosterFile(b.id), JSON.stringify({ since: b.since, players: b.players }, null, 2));
      } catch {}
    }
  }
}

/* ------------------------------------------------------------------ record */

function player(b, name) {
  let rec = b.players[name];
  if (!rec) rec = b.players[name] = blankPlayer(name, Date.now());
  return rec;
}

function record(id, type, { player: name = null, text = "", meta = null, t = Date.now() } = {}) {
  const b = book(id);
  const e = { seq: b.seq++, t, type, player: name, text: String(text).slice(0, MAX_TEXT) };
  if (meta) e.meta = meta;
  if (!b.since) b.since = t;
  b.events.push(e);
  b.queue.push(e);
  if (b.events.length > MAX_EVENTS + TRIM_SLACK) {
    b.events = b.events.slice(-MAX_EVENTS);
    b.rewrite = true;
    b.queue = [];
  }
  schedule(b);
  events.emit("record", { id, event: e });
  return e;
}

function closeSession(rec, end, reason) {
  if (!rec.online) return 0;
  const from = rec.joinedAt || end;
  const ms = Math.max(0, end - from);
  rec.playtimeMs += ms;
  rec.recent.unshift({ from, to: end, ms, reason: reason || null });
  if (rec.recent.length > MAX_SESSIONS) rec.recent.length = MAX_SESSIONS;
  rec.online = false;
  rec.joinedAt = null;
  rec.lastSeen = end;
  return ms;
}

/* --------------------------------------------------------------- lifecycle */

function join(id, name) {
  const b = book(id);
  const rec = player(b, name);
  const now = Date.now();
  if (rec.online) closeSession(rec, now, "reconnected"); // a join we never saw the end of
  const seen = b.pending[name] || {};
  if (seen.ip) rec.ip = seen.ip;
  if (seen.uuid) rec.uuid = seen.uuid;
  delete b.pending[name];
  rec.online = true;
  rec.joinedAt = now;
  rec.lastSeen = now;
  rec.sessions++;
  if (!rec.firstSeen) rec.firstSeen = now;
  saveRoster(b);
  record(id, "join", { player: name, text: "joined the game", meta: rec.ip ? { ip: rec.ip } : null, t: now });
}

function leave(id, name, reason = null) {
  const b = book(id);
  const rec = player(b, name);
  const now = Date.now();
  const ms = closeSession(rec, now, reason);
  saveRoster(b);
  record(id, "leave", { player: name, text: "left the game", meta: { ms, reason: reason || null }, t: now });
}

// Everyone still marked online goes offline — the process exited, whether it
// was asked to or not.
function closeAll(id, reason = "server stopped") {
  const b = book(id);
  for (const rec of Object.values(b.players)) if (rec.online) leave(id, rec.name, reason);
  b.pending = {};
}

function serverEvent(id, text, meta = null) {
  record(id, "server", { text, meta });
}

/* ----------------------------------------------------------------- parsing */
/*
 * Everything below reads the server's own console output. Vanilla, Paper and
 * every modded server in between print these lines in the same shapes, always
 * after a "[HH:MM:SS] [Server thread/INFO]: " style prefix — so each pattern
 * anchors on that prefix (or the start of the line) rather than searching the
 * whole line, which is what keeps a player typing "joined the game" in chat
 * from writing itself into the log.
 *
 * 26.3 began labelling everything the server broadcasts — deaths, joins,
 * advancements — as "System chat: Steve fell from a high place", so that
 * label is allowed between the prefix and the message too.
 */
const NAME = "[A-Za-z0-9_]{2,16}";
const PRE = "(?:^|\\]: |\\[Not Secure\\] )(?:System chat: )?"; // console prefix, or none at all

const RE_CHAT = new RegExp(PRE + "<(" + NAME + ")> (.+)$");
const RE_LOGIN = new RegExp(PRE + "(" + NAME + ")\\[/([0-9a-fA-F.:]+):\\d+\\] logged in");
const RE_UUID = new RegExp(PRE + "UUID of player (" + NAME + ") is ([0-9a-fA-F-]{32,36})");
const RE_LOST = new RegExp(PRE + "(" + NAME + ") lost connection: (.+)$");
const RE_ADVANCE = new RegExp(
  PRE + "(" + NAME + ") has (?:made the advancement|completed the challenge|reached the goal) (.+)$"
);
const RE_COMMAND = new RegExp(PRE + "(" + NAME + ") issued server command: (.+)$");
// Vanilla never prints the command a player typed — only what it did, the way
// ops see it in chat: "[Steve: Set the time to 1000]". Paper prints both.
const RE_FEEDBACK = new RegExp(PRE + "\\[(" + NAME + "): (.+)\\]$");
const TYPED_MS = 5000; // how long a Paper "issued server command" covers its feedback

// Minecraft has well over a hundred death messages and they are translated per
// server, so matching them all is hopeless. These are the stems the vanilla
// English set is built from; a line only counts as a death when it also starts
// with the name of somebody who is actually online.
const DEATH_STEMS = [
  "was slain by", "was shot by", "was killed", "was blown up by", "was fireballed by",
  "was pummelled by", "was pummeled by", "was impaled by", "was skewered by", "was squashed by",
  "was squished", "was stung to death", "was poked to death", "was pricked to death",
  "was struck by lightning", "was burnt to a crisp", "was roasted in dragon's breath",
  "was doomed to fall", "was obliterated by", "was frozen to death", "was stabbed to death",
  "blew up", "drowned", "starved to death", "suffocated in a wall", "died", "fell",
  "hit the ground too hard", "went up in flames", "burned to death", "tried to swim in lava",
  "discovered the floor was lava", "walked into a cactus", "walked into danger zone",
  "withered away", "froze to death", "experienced kinetic energy", "left the confines of this world",
  "didn't want to live in the same world as", "was in the wrong place at the wrong time",
];

function stripPrefix(line) {
  const i = line.indexOf("]: ");
  return (i >= 0 ? line.slice(i + 3) : line).replace(/^System chat: /, "");
}

/**
 * Feed one console line in. `online` is the live player list, used to keep the
 * fuzzier patterns (deaths) honest. Returns the event recorded, or null.
 */
function observe(id, line, online = []) {
  if (!line) return null;
  const b = book(id);
  let m;

  // Connection details arrive a moment before "joined the game"; hold them
  // until the join event exists to hang them on.
  if ((m = RE_UUID.exec(line))) {
    b.pending[m[1]] = { ...(b.pending[m[1]] || {}), uuid: m[2] };
    return null;
  }
  if ((m = RE_LOGIN.exec(line))) {
    b.pending[m[1]] = { ...(b.pending[m[1]] || {}), ip: m[2] };
    return null;
  }
  // Why someone dropped — remembered so the leave event a line later can say.
  if ((m = RE_LOST.exec(line))) {
    b.pending[m[1]] = { ...(b.pending[m[1]] || {}), reason: m[2].trim().slice(0, 120) };
    return null;
  }

  if ((m = RE_CHAT.exec(line)))
    return bump(b, m[1], "chat", record(id, "chat", { player: m[1], text: m[2] }));
  if ((m = RE_ADVANCE.exec(line)))
    return bump(b, m[1], "advancements", record(id, "advancement", { player: m[1], text: m[2] }));
  if ((m = RE_COMMAND.exec(line))) {
    b.typed[m[1]] = Date.now();
    return bump(b, m[1], "commands", record(id, "command", { player: m[1], text: m[2] }));
  }
  // Only for someone online — RCON and renamed command blocks report the same
  // way under their own names — and not when Paper already logged the command.
  if ((m = RE_FEEDBACK.exec(line)) && online.includes(m[1])) {
    if (Date.now() - (b.typed[m[1]] || 0) < TYPED_MS) return null;
    return bump(b, m[1], "commands", record(id, "command", { player: m[1], text: m[2], meta: { result: true } }));
  }

  const body = stripPrefix(line);
  const name = (body.match(new RegExp("^(" + NAME + ") ")) || [])[1];
  if (name && online.includes(name) && DEATH_STEMS.some((s) => body.includes(" " + s)))
    return bump(b, name, "deaths", record(id, "death", { player: name, text: body }));

  return null;
}

// Keep the roster counters in step with the feed.
function bump(b, name, field, event) {
  const rec = player(b, name);
  rec[field] = (rec[field] || 0) + 1;
  rec.lastSeen = event.t;
  saveRoster(b);
  return event;
}

// The reason a player dropped, if the console gave one just before the leave.
function dropReason(id, name) {
  const b = book(id);
  const seen = b.pending[name];
  if (!seen || !seen.reason) return null;
  const reason = seen.reason;
  delete b.pending[name];
  return reason;
}

/* ------------------------------------------------------------------ queries */

/**
 * The roster: one row per player who has ever been on, newest activity first.
 * `live` is the manager's current player list — it wins over what the log
 * believes, so a session the panel missed the end of can't show as online.
 */
function roster(id, live = []) {
  const b = book(id);
  const now = Date.now();
  const players = Object.values(b.players).map((rec) => {
    const online = live.includes(rec.name);
    const sessionMs = online && rec.joinedAt ? now - rec.joinedAt : 0;
    return {
      name: rec.name,
      uuid: rec.uuid,
      ip: rec.ip,
      firstSeen: rec.firstSeen,
      lastSeen: online ? now : rec.lastSeen,
      sessions: rec.sessions,
      playtimeMs: rec.playtimeMs + sessionMs,
      chat: rec.chat || 0,
      deaths: rec.deaths || 0,
      advancements: rec.advancements || 0,
      commands: rec.commands || 0,
      online,
      since: online ? rec.joinedAt : null,
      sessionMs,
    };
  });
  // Someone can be online with no history at all — the log was cleared out
  // from under them, or this is a session the panel never saw the start of.
  // They still belong on the roster; the numbers fill in as they play.
  for (const name of live) if (!b.players[name]) players.push(liveOnly(name, now));
  players.sort((a, c) => (c.online ? 1 : 0) - (a.online ? 1 : 0) || (c.lastSeen || 0) - (a.lastSeen || 0));
  const totals = players.reduce(
    (acc, p) => ({
      players: acc.players + 1,
      online: acc.online + (p.online ? 1 : 0),
      sessions: acc.sessions + p.sessions,
      playtimeMs: acc.playtimeMs + p.playtimeMs,
      chat: acc.chat + p.chat,
      deaths: acc.deaths + p.deaths,
    }),
    { players: 0, online: 0, sessions: 0, playtimeMs: 0, chat: 0, deaths: 0 }
  );
  return { since: b.since, events: b.events.length, totals, players };
}

/** One player's card: totals plus the sessions behind them, newest first. */
function playerDetail(id, name, live = []) {
  const b = book(id);
  const rec = b.players[name];
  if (!rec) return live.includes(name) ? { ...liveOnly(name, Date.now()), sessionCount: 0, sessions: [] } : null;
  const row = roster(id, live).players.find((p) => p.name === name);
  const sessions = [...rec.recent];
  // Only when we know when it started — a record can exist for someone whose
  // join we never saw (they chatted after the log was cleared, say).
  if (row && row.online && rec.joinedAt)
    sessions.unshift({ from: rec.joinedAt, to: null, ms: row.sessionMs, reason: null });
  // `sessions` is the recent history (capped); `sessionCount` is how many there
  // have ever been, which is the number worth showing beside a playtime total.
  return { ...row, sessionCount: rec.sessions, sessions };
}

/**
 * A page of the feed, newest first. `before` is a cursor — pass the `seq` of
 * the oldest row you already have to get the page behind it.
 */
function query(id, { types = null, player: name = null, q = null, before = null, limit = 200 } = {}) {
  const b = book(id);
  const want = Array.isArray(types) && types.length ? new Set(types.filter((t) => EVENT_TYPES.includes(t))) : null;
  const needle = q ? String(q).toLowerCase() : null;
  const cap = Math.min(1000, Math.max(1, Number(limit) || 200));
  const out = [];
  for (let i = b.events.length - 1; i >= 0 && out.length < cap; i--) {
    const e = b.events[i];
    if (before != null && e.seq >= before) continue;
    if (want && !want.has(e.type)) continue;
    if (name && e.player !== name) continue;
    if (needle && !((e.text || "") + " " + (e.player || "")).toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  const oldest = out.length ? out[out.length - 1].seq : null;
  // Whether anything is left behind this page — so the UI only offers "load
  // more" when there is more.
  const more = oldest != null && b.events.some((e) => e.seq < oldest && matches(e, want, name, needle));
  return { events: out, nextBefore: more ? oldest : null, total: b.events.length };
}

function matches(e, want, name, needle) {
  if (want && !want.has(e.type)) return false;
  if (name && e.player !== name) return false;
  if (needle && !((e.text || "") + " " + (e.player || "")).toLowerCase().includes(needle)) return false;
  return true;
}

const CSV_COLS = ["time", "type", "player", "text", "seconds", "ip", "reason"];

/** The whole log as CSV, for spreadsheets and long-term keeping. */
function csv(id) {
  const b = book(id);
  const cell = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = [CSV_COLS.join(",")];
  for (const e of b.events) {
    const meta = e.meta || {};
    rows.push(
      [
        new Date(e.t).toISOString(),
        e.type,
        e.player || "",
        e.text || "",
        meta.ms ? Math.round(meta.ms / 1000) : "",
        meta.ip || "",
        meta.reason || "",
      ]
        .map(cell)
        .join(",")
    );
  }
  return rows.join("\n") + "\n";
}

/* ---------------------------------------------------------------- housekeeping */

/** Wipe a server's history but keep tracking from here on. */
function clear(id) {
  const b = book(id);
  b.events = [];
  b.players = {};
  b.queue = [];
  b.pending = {};
  b.typed = {};
  b.seq = 1;
  b.since = Date.now();
  b.rewrite = true;
  flush(b);
  try {
    fs.mkdirSync(dirFor(id), { recursive: true });
    fs.writeFileSync(rosterFile(id), JSON.stringify({ since: b.since, players: {} }, null, 2));
  } catch {}
  events.emit("record", { id, event: null }); // "everything changed"
  return { ok: true };
}

/** The server is gone — so is its history. */
function forget(id) {
  const b = books.get(id);
  if (b) {
    if (b.flushTimer) clearTimeout(b.flushTimer);
    if (b.rosterTimer) clearTimeout(b.rosterTimer);
    books.delete(id);
  }
  try {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
  } catch {}
}

module.exports = {
  EVENT_TYPES,
  events,
  observe,
  join,
  leave,
  closeAll,
  closeStale,
  onlineNames,
  serverEvent,
  dropReason,
  roster,
  playerDetail,
  query,
  csv,
  clear,
  forget,
  flushAll,
};

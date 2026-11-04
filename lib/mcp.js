/*
 * MCP server — lets Claude (or any MCP client) look after your Minecraft
 * servers through the panel: see what's running, start / stop / restart a
 * server, read its console, run a console command, see who's online, check how
 * the PC and the server are coping, and take a backup.
 *
 * It's the "Streamable HTTP" transport, kept stateless: one JSON-RPC message
 * (or a batch) is POSTed to /mcp and answered in the response. No dependencies,
 * and it rides on the panel's own port, so there's nothing more to start.
 *
 *   claude mcp add --transport http mc-hoster http://localhost:8100/mcp
 *
 * The panel itself has no login (it's for your own network), and neither does
 * this by default. To ask for a key, set MC_MCP_TOKEN (before starting the
 * panel) and clients must send `Authorization: Bearer <that token>`. A request
 * from a web page on another site (an Origin that isn't this panel) is always
 * refused, so a page you happen to have open can't drive your servers.
 *
 * Deliberately not offered: deleting servers or backups, restoring a backup,
 * and editing files. Those stay in the panel.
 */
const crypto = require("crypto");

const store = require("./store");
const manager = require("./manager");
const playerlog = require("./playerlog");
const backup = require("./backup");
const sysmon = require("./sysmon");

const SERVER_INFO = { name: "mc-hoster", title: "MC Hoster", version: "1.0.0" };
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_BODY = 1024 * 1024;

const INSTRUCTIONS =
  "MC Hoster runs Minecraft servers on the user's own PC. Servers are named by their panel id or " +
  "their name (list_servers shows both). A server must be running before send_command works. " +
  "Stopping or restarting a server disconnects its players: say so before doing it while players are on. " +
  "start_server, stop_server and restart_server only begin the change; check get_server afterwards " +
  "(status goes starting, then running).";

/* ------------------------------------------------------------------- tools */

class ToolError extends Error {}

function fail(msg) {
  throw new ToolError(msg);
}

// A server by id, or by name (case-insensitive; a unique start of the name works too).
function resolve(ref) {
  const want = String(ref == null ? "" : ref).trim();
  if (!want) fail("Say which server (its id or name). list_servers shows them.");
  const all = store.all();
  const byId = all.find((d) => d.id === want);
  if (byId) return byId;
  const lc = want.toLowerCase();
  const exact = all.filter((d) => String(d.name).toLowerCase() === lc);
  if (exact.length === 1) return exact[0];
  const starts = all.filter((d) => String(d.name).toLowerCase().startsWith(lc));
  if (exact.length + starts.length === 1) return exact[0] || starts[0];
  if (exact.length + starts.length > 1)
    fail(`"${want}" matches more than one server (${[...exact, ...starts].map((d) => d.name).join(", ")}). Use the id.`);
  fail(`There's no server called "${want}". list_servers shows what exists.`);
}

// What a client needs to know about a server, without the panel's internals.
function brief(id) {
  const s = manager.summary(id);
  const o = {
    id: s.id,
    name: s.name,
    status: s.status,
    loader: s.modLoader || s.loader,
    minecraft: s.mc,
    port: s.port,
    memory_mb: s.memory,
    players_online: s.players.length,
    max_players: s.maxPlayers,
  };
  if (s.players.length) o.players = s.players;
  if (s.paused) o.paused = true; // running, but parked at ~0% CPU until someone joins
  if (s.asleep) o.asleep = true; // stopped to save RAM; a player joining wakes it
  if (s.pack) o.modpack = s.pack;
  if (s.startedAt && (s.status === "running" || s.status === "starting"))
    o.uptime_minutes = Math.max(0, Math.round((Date.now() - s.startedAt) / 60000));
  if (s.crashGaveUp) o.crashed_and_gave_up = true;
  return o;
}

const text = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

const SERVER = { type: "string", description: "The server's id or name (see list_servers)" };
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: "list_servers",
    title: "List servers",
    description: "Every Minecraft server in the panel with its status (stopped, starting, running, crashed...), loader, version, port and who's online.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: () => ({ servers: store.all().map((d) => brief(d.id)) }),
  },
  {
    name: "get_server",
    title: "Get a server",
    description: "One server in detail: status, uptime, version and loader, memory, port, who's online (with ping where known), restart and backup settings.",
    inputSchema: obj({ server: SERVER }, ["server"]),
    annotations: { readOnlyHint: true },
    run: (a) => {
      const def = resolve(a.server);
      const o = brief(def.id);
      o.settings = {
        restart_on_crash: !!def.restartOnCrash,
        start_with_panel: !!def.startWithPanel,
        backup_every_hours: def.backupEvery || 0,
        backups_kept: def.backupKeep || null,
        pause_when_empty: def.pauseWhenEmpty || false,
      };
      const s = manager.slot(def.id);
      if (s.pings && Object.keys(s.pings).length) o.ping_ms = s.pings;
      o.eula_accepted = !!manager.isEulaAccepted(def.id);
      return o;
    },
  },
  {
    name: "start_server",
    title: "Start a server",
    description: "Start a stopped server. It takes a while to boot; poll get_server until its status is running.",
    inputSchema: obj({ server: SERVER }, ["server"]),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: async (a) => {
      const def = resolve(a.server);
      const before = manager.slot(def.id).status;
      if (before === "running" || before === "starting") return { ...brief(def.id), note: `Already ${before}.` };
      const out = await manager.start(def.id, { manual: true });
      return { ...brief(def.id), result: out };
    },
  },
  {
    name: "stop_server",
    title: "Stop a server",
    description:
      "Stop a server gracefully (it saves the world first). Disconnects everyone on it. " +
      "force=true kills it immediately and can lose recent progress: only use that for a hung server.",
    inputSchema: obj({ server: SERVER, force: { type: "boolean", description: "Kill it outright (default false)" } }, ["server"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    run: (a) => {
      const def = resolve(a.server);
      const out = manager.stop(def.id, { force: a.force === true });
      return { ...brief(def.id), result: out };
    },
  },
  {
    name: "restart_server",
    title: "Restart a server",
    description: "Stop a server and start it again. Disconnects everyone on it for a minute or two.",
    inputSchema: obj({ server: SERVER }, ["server"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: async (a) => {
      const def = resolve(a.server);
      const out = await manager.restart(def.id);
      return { ...brief(def.id), result: out };
    },
  },
  {
    name: "send_command",
    title: "Run a console command",
    description:
      "Type a command into a running server's console, as the operator would (say, `list`, `say Back in 5`, " +
      "`whitelist add Steve`, `time set day`). Without the leading slash. The reply appears in the console: " +
      "read it with get_console a moment later.",
    inputSchema: obj({ server: SERVER, command: { type: "string", description: "The command, e.g. \"whitelist add Steve\"" } }, ["server", "command"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    run: (a) => {
      const def = resolve(a.server);
      const cmd = String(a.command || "").replace(/[\r\n]+/g, " ").trim().replace(/^\//, "");
      if (!cmd) fail("The command is empty.");
      if (cmd.length > 1000) fail("That command is too long.");
      const out = manager.sendCommand(def.id, cmd);
      if (!out.ok) fail(out.error || "The server isn't running.");
      return { sent: cmd };
    },
  },
  {
    name: "get_console",
    title: "Read the console",
    description: "The server's most recent console lines (its log, plus what was typed and any panel messages), oldest first.",
    inputSchema: obj({ server: SERVER, lines: { type: "integer", description: "How many lines (default 100, at most 500)" } }, ["server"]),
    annotations: { readOnlyHint: true },
    run: (a) => {
      const def = resolve(a.server);
      const n = Math.min(500, Math.max(1, Math.round(Number(a.lines)) || 100));
      const log = manager.slot(def.id).log;
      return log.slice(-n).map((e) => e.line).join("\n") || "(the console is empty)";
    },
  },
  {
    name: "list_players",
    title: "Who's on a server",
    description: "Everyone who has been on a server: who's online now, when each was last seen, total playtime and sessions. Online players first.",
    inputSchema: obj({ server: SERVER, limit: { type: "integer", description: "At most this many players (default 50)" } }, ["server"]),
    annotations: { readOnlyHint: true },
    run: (a) => {
      const def = resolve(a.server);
      const r = playerlog.roster(def.id, manager.slot(def.id).players);
      const list = r.players;
      const limit = Math.min(200, Math.max(1, Math.round(Number(a.limit)) || 50));
      const rows = list
        .slice()
        .sort((x, y) => (y.online ? 1 : 0) - (x.online ? 1 : 0) || (y.lastSeen || 0) - (x.lastSeen || 0))
        .slice(0, limit)
        .map((p) => ({
          name: p.name,
          online: !!p.online,
          last_seen: p.lastSeen ? new Date(p.lastSeen).toISOString() : null,
          playtime_hours: Math.round((p.playtimeMs || 0) / 360000) / 10,
          sessions: p.sessions || 0,
        }));
      return { online_now: rows.filter((p) => p.online).length, total_known: list.length, players: rows };
    },
  },
  {
    name: "server_performance",
    title: "Server performance",
    description: "How a running server is coping right now: TPS, memory and CPU where the panel has read them.",
    inputSchema: obj({ server: SERVER }, ["server"]),
    annotations: { readOnlyHint: true },
    run: (a) => {
      const def = resolve(a.server);
      return { server: def.name, status: manager.slot(def.id).status, now: manager.perf.current(def.id) };
    },
  },
  {
    name: "host_stats",
    title: "The PC's load",
    description: "CPU, memory and disk use of the computer the servers run on.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: () => sysmon.snapshot(),
  },
  {
    name: "list_backups",
    title: "List backups",
    description: "A server's backups (newest first) and whether one is being made right now.",
    inputSchema: obj({ server: SERVER }, ["server"]),
    annotations: { readOnlyHint: true },
    run: (a) => {
      const def = resolve(a.server);
      const b = backup.list(def.id);
      return { server: def.name, making_one_now: !!b.job, has_world: b.hasWorld, backups: b.backups };
    },
  },
  {
    name: "create_backup",
    title: "Make a backup",
    description: "Start a backup of a server's world (or its whole folder). It runs in the background; list_backups shows it when it's done.",
    inputSchema: obj(
      {
        server: SERVER,
        scope: { type: "string", enum: backup.SCOPES, description: "What to include (default: the world)" },
        note: { type: "string", description: "A label for it" },
      },
      ["server"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (a) => {
      const def = resolve(a.server);
      const scope = backup.SCOPES.includes(a.scope) ? a.scope : "world";
      backup.create(def.id, { scope, note: String(a.note || "").slice(0, 200) }).catch(() => {});
      return { started: true, server: def.name, scope };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

async function callTool(params) {
  const tool = BY_NAME.get(params && params.name);
  if (!tool) throw rpcError(-32602, `Unknown tool: ${params && params.name}`);
  try {
    const out = await tool.run((params && params.arguments) || {});
    return { content: [{ type: "text", text: text(out) }] };
  } catch (e) {
    // A problem with the request is the tool's answer, which the model can read and act on.
    return { content: [{ type: "text", text: e instanceof ToolError ? e.message : `Failed: ${e && e.message ? e.message : e}` }], isError: true };
  }
}

/* ----------------------------------------------------------------- JSON-RPC */

function rpcError(code, message) {
  return Object.assign(new Error(message), { rpcCode: code });
}

// One request → its result, or throws an rpcError. (Notifications never reach here.)
async function dispatch(method, params) {
  switch (method) {
    case "initialize": {
      const want = params && params.protocolVersion;
      return {
        protocolVersion: PROTOCOLS.includes(want) ? want : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) => ({
          name, title, description, inputSchema, annotations,
        })),
      };
    case "tools/call":
      return callTool(params);
    default:
      throw rpcError(-32601, `Method not found: ${method}`);
  }
}

// One JSON-RPC message → its response object, or null for a notification.
async function handleMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string")
    return { jsonrpc: "2.0", id: msg && msg.id != null ? msg.id : null, error: { code: -32600, message: "Invalid request" } };
  const isNote = msg.id === undefined || msg.id === null;
  try {
    const result = await dispatch(msg.method, msg.params);
    return isNote ? null : { jsonrpc: "2.0", id: msg.id, result };
  } catch (e) {
    if (isNote) return null;
    return { jsonrpc: "2.0", id: msg.id, error: { code: e.rpcCode || -32603, message: e.message || "Internal error" } };
  }
}

/* --------------------------------------------------------------------- HTTP */

function send(res, code, body, headers = {}) {
  const data = body == null ? "" : JSON.stringify(body);
  res.writeHead(code, {
    ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : { "Content-Length": 0 }),
    ...headers,
  });
  res.end(data);
}

// A browser page on another site can send requests here too: only an Origin
// that is this panel (same host as the request) gets through. Clients that
// aren't browsers send no Origin at all.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function tokenOk(req, token) {
  if (!token) return true;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handle(req, res) {
  if (!originAllowed(req)) return send(res, 403, { error: "Origin not allowed" });
  const token = process.env.MC_MCP_TOKEN || "";
  if (!tokenOk(req, token))
    return send(res, 401, { error: "A bearer token is needed" }, { "WWW-Authenticate": 'Bearer realm="mc-hoster"' });
  // No server-initiated stream and no sessions: only POST is offered.
  if (req.method !== "POST") return send(res, 405, { error: "Use POST" }, { Allow: "POST" });

  let msg;
  try {
    msg = JSON.parse(await readBody(req));
  } catch {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  if (Array.isArray(msg)) {
    if (!msg.length) return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Empty batch" } });
    const out = (await Promise.all(msg.map(handleMessage))).filter(Boolean);
    return out.length ? send(res, 200, out) : send(res, 202, null);
  }
  const out = await handleMessage(msg);
  return out ? send(res, 200, out) : send(res, 202, null);
}

module.exports = { handle, handleMessage, TOOLS };

/*
 * MC Hoster — a local "game-panel" style front end for hosting vanilla and
 * modded Minecraft servers. Designed to run under the Multiapp Controller: it
 * reads its web port from MC_PORT / MAC_PORT and serves a dashboard where each
 * Minecraft server is created, installed, and controlled with a live console.
 *
 * Zero external dependencies — Node built-ins only.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { exec } = require("child_process");

const store = require("./lib/store");
const loaders = require("./lib/loaders");
const manager = require("./lib/manager");
const java = require("./lib/java");
const playit = require("./lib/playit");
const sysmon = require("./lib/sysmon");
const changelog = require("./lib/changelog");
const modrinth = require("./lib/modrinth");
const playerlog = require("./lib/playerlog");
const backup = require("./lib/backup");
const voicechat = require("./lib/voicechat");

// Port precedence: explicit flag, then the launcher's MC_PORT (our portEnv),
// then whatever Rack/the old controller assigned, then the standalone default.
const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT =
  (portArg && Number(portArg.split("=")[1])) ||
  Number(process.env.MC_PORT) ||
  Number(process.env.RACK_PORT) ||
  Number(process.env.MAC_PORT) ||
  8100;
const PUBLIC_DIR = path.join(__dirname, "public");

/* ------------------------------------------------------------------- helpers */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

// Addresses another device on the network (a phone, say) can open the panel
// at. Only private IPv4 ranges: the panel has no login, so it is offered for
// the home network and nothing wider.
function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list || []) {
      if (a.internal || (a.family !== "IPv4" && a.family !== 4)) continue;
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(a.address)) continue;
      out.push(`http://${a.address}:${PORT}`);
    }
  return out;
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

// Plain-text/CSV answer, optionally offered to the browser as a download.
function sendText(res, code, text, { type = "text/plain; charset=utf-8", filename = null } = {}) {
  const headers = { "Content-Type": type, "Content-Length": Buffer.byteLength(text) };
  if (filename) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
  res.writeHead(code, headers);
  res.end(text);
}

function readJSONBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function readRawBody(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Upload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Quick-command buttons come straight from the browser, so keep only entries
// that could plausibly be a console command and bound how many we store.
function cleanQuickCommands(list) {
  if (!Array.isArray(list)) return store.DEFAULT_QUICK_COMMANDS;
  return list
    .map((q) => (typeof q === "string" ? { cmd: q } : q || {}))
    .filter((q) => typeof q.cmd === "string" && q.cmd.trim())
    .slice(0, 40)
    .map((q) => ({ label: String(q.label ?? "").trim().slice(0, 40), cmd: q.cmd.trim().slice(0, 256) }));
}

// Batch file operations take a list of paths; keep it a sane list of non-empty
// strings before it reaches the file manager, which sandboxes each one itself.
function asPathList(list) {
  if (!Array.isArray(list)) throw new Error("Expected a list of paths");
  const paths = list.filter((p) => typeof p === "string" && p.trim()).slice(0, 500);
  if (!paths.length) throw new Error("Nothing selected");
  return paths;
}

// Wrap async route handlers so thrown errors become 400s instead of crashes.
function guard(fn) {
  return async (req, res, ctx) => {
    try {
      await fn(req, res, ctx);
    } catch (e) {
      sendJSON(res, 400, { error: e.message || String(e) });
    }
  };
}

/* ----------------------------------------------------------------------- SSE */

function sseOpen(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
}
// Guarded write: a client that has disconnected can trigger an 'error' event on
// the response socket; without this guard that would crash the whole process.
function sseSend(res, obj) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    return res.write(`data: ${JSON.stringify(obj)}\n\n`);
  } catch {
    return false;
  }
}

// Common plumbing for an SSE endpoint: subscribes `onEvent` to the manager,
// heartbeats, and tears everything down exactly once on close/error. `extra`
// takes [emitter, event, handler] triples for channels that also want to relay
// something other than the manager's bus (the system monitor, for instance).
function sseChannel(res, onEvent, extra = []) {
  sseOpen(res);
  const subs = [[manager.events, "event", onEvent], ...extra];
  for (const [emitter, name, fn] of subs) emitter.on(name, fn);
  const ping = setInterval(() => sseSend(res, { type: "ping" }), 20000);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(ping);
    for (const [emitter, name, fn] of subs) emitter.off(name, fn);
  };
  res.on("close", cleanup);
  res.on("error", cleanup);
}

// Global event stream — everything except raw console lines (those get their
// own per-server channel so the dashboard isn't flooded). Host resource samples
// ride along here too, so the sidebar meters tick without polling.
function attachGlobalStream(res) {
  sseChannel(
    res,
    (e) => {
      if (e.type !== "console") sseSend(res, e);
    },
    [[sysmon.events, "sample", (sys) => sseSend(res, { type: "sysmon", sys })]]
  );
  sseSend(res, { type: "sysmon", sys: sysmon.snapshot() });
}

// Per-server console stream — replays the recent buffer, then live lines +
// status/players/stats for that one server.
function attachConsoleStream(res, id) {
  const s = manager.slot(id);
  sseChannel(res, (e) => {
    if (e.id === id) sseSend(res, e);
  });
  for (const entry of s.log) sseSend(res, { type: "console", id, stream: entry.stream, line: entry.line });
  sseSend(res, { type: "status", ...manager.summary(id) });
  sseSend(res, { type: "players", id, players: s.players });
  sseSend(res, { type: "pings", id, pings: s.pings });
}

// playit agent console — replays the log, then live lines. Agent status rides
// the global stream already, so this channel only relays playit's log.
function attachPlayitConsole(res) {
  sseChannel(res, () => {}, [[playit.events, "log", (entry) => sseSend(res, { type: "log", ...entry })]]);
  for (const entry of playit.logLines()) sseSend(res, { type: "log", ...entry });
}

/* -------------------------------------------------------------------- routes */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  const parts = p.split("/").filter(Boolean);
  const q = url.searchParams;

  // ---- Server-sent event channels ----
  if (p === "/api/events") return attachGlobalStream(res);
  if (parts[0] === "api" && parts[1] === "servers" && parts[3] === "console")
    return attachConsoleStream(res, parts[2]);
  if (p === "/api/playit/console") return attachPlayitConsole(res);

  if (parts[0] === "api") {
    // ---- meta / bootstrap ----
    if (p === "/api/changelog" && req.method === "GET")
      return sendJSON(res, 200, changelog.full());

    if (p === "/api/bootstrap" && req.method === "GET") {
      const { javas } = await java.discover();
      return sendJSON(res, 200, {
        loaders: loaders.list(),
        settings: store.getSettings(),
        defaults: { quickCommands: store.DEFAULT_QUICK_COMMANDS },
        build: changelog.stamp(),
        lan: lanUrls(),
        javas,
        playit: playit.snapshot(),
        sys: sysmon.snapshot(),
        servers: manager.listSummaries(),
      });
    }

    // ---- host resources ----
    if (p === "/api/sysmon" && req.method === "GET")
      return sendJSON(res, 200, { sys: sysmon.snapshot() });

    if (p === "/api/loaders" && req.method === "GET")
      return sendJSON(res, 200, { loaders: loaders.list() });

    // GET /api/loaders/:id/mc
    if (parts[1] === "loaders" && parts[3] === "mc" && req.method === "GET")
      return guard(async () => {
        const versions = await loaders.get(parts[2]).listMc();
        sendJSON(res, 200, { versions });
      })(req, res);

    // GET /api/loaders/:id/builds?mc=xxx
    if (parts[1] === "loaders" && parts[3] === "builds" && req.method === "GET")
      return guard(async () => {
        const loader = loaders.get(parts[2]);
        if (!loader.listBuild) return sendJSON(res, 200, { builds: [] });
        const builds = await loader.listBuild(q.get("mc"));
        sendJSON(res, 200, { builds });
      })(req, res);

    // ---- Modrinth ----
    // Browsing is a thin proxy: the panel's own origin does the talking so the
    // page needs no CORS dance, and every call is public + unauthenticated.
    if (p === "/api/modrinth/search" && req.method === "GET")
      return guard(async () =>
        sendJSON(
          res,
          200,
          await modrinth.search({
            query: q.get("q") || "",
            projectType: q.get("type") || "mod",
            loaders: q.getAll("loader"),
            mc: q.get("mc") || null,
            serverOnly: q.get("server") !== "0",
            index: q.get("sort") || "relevance",
            offset: Number(q.get("offset")) || 0,
            limit: Math.min(50, Number(q.get("limit")) || 20),
          })
        )
      )(req, res);

    // GET /api/modrinth/versions?project=slug&loader=fabric&mc=1.21.1
    if (p === "/api/modrinth/versions" && req.method === "GET")
      return guard(async () => {
        const project = q.get("project");
        if (!project) throw new Error("A project is required.");
        const versions = await modrinth.versions(project, {
          loaders: q.getAll("loader"),
          mc: q.get("mc") || null,
        });
        sendJSON(res, 200, { versions });
      })(req, res);

    // GET /api/modrinth/project/:idOrSlug
    if (parts[1] === "modrinth" && parts[2] === "project" && parts[3] && req.method === "GET")
      return guard(async () =>
        sendJSON(res, 200, { project: await modrinth.project(parts[3]) })
      )(req, res);

    // ---- java ----
    if (p === "/api/java" && req.method === "GET") {
      const { javas } = await java.discover(q.get("rescan") === "1");
      return sendJSON(res, 200, { javas });
    }

    // Which Java does this Minecraft version need, and do we have it?
    // GET /api/java/required?mc=26.1.2
    if (p === "/api/java/required" && req.method === "GET")
      return guard(async () => {
        const mc = q.get("mc");
        const required = await java.requiredMajor(mc);
        const { javas } = await java.discover();
        const match = java.pick(javas, required);
        sendJSON(res, 200, { mc, required, ok: !!match, java: match || null });
      })(req, res);

    // POST /api/java/install {major} — fetch a Temurin JRE into data/runtimes.
    if (p === "/api/java/install" && req.method === "POST")
      return guard(async () => {
        const body = await readJSONBody(req);
        const major = Number(body.major) || (await java.requiredMajor(body.mc));
        const info = await java.install(major, (line) => console.log("[java] " + line));
        const { javas } = await java.discover(true);
        sendJSON(res, 200, { java: info, javas });
      })(req, res);

    // ---- playit.gg tunnels ----
    // Public addresses for servers on machines that can't port-forward. The
    // agent binary, the account link and the per-server tunnels all live in
    // lib/playit.js; these routes are a thin shell over it.
    if (p === "/api/playit" && req.method === "GET")
      return sendJSON(res, 200, { playit: playit.snapshot(), log: playit.logLines() });

    if (p === "/api/playit/install" && req.method === "POST")
      return guard(async () => {
        await playit.install();
        sendJSON(res, 200, { playit: playit.snapshot() });
      })(req, res);

    if (p === "/api/playit/link" && req.method === "POST")
      return guard(async () => sendJSON(res, 200, { playit: await playit.startLink() }))(req, res);

    if (p === "/api/playit/link/cancel" && req.method === "POST")
      return sendJSON(res, 200, { playit: playit.cancelLink() });

    if (p === "/api/playit/unlink" && req.method === "POST")
      return sendJSON(res, 200, { playit: playit.unlink() });

    // The account's own tunnels, so a server can adopt an address you already
    // handed out instead of getting a brand-new one.
    if (p === "/api/playit/tunnels" && req.method === "GET")
      return guard(async () => sendJSON(res, 200, { tunnels: await playit.listAccountTunnels() }))(req, res);

    // The account's TCP/UDP port allowance, read fresh — asked just before
    // anything that would need another tunnel, so the answer is current.
    if (p === "/api/playit/quota" && req.method === "GET")
      return guard(async () => sendJSON(res, 200, { quota: await playit.quota({ fresh: true }), playit: playit.snapshot() }))(req, res);

    // UDP tunnels on the account that voice chat could use, for the picker.
    if (p === "/api/playit/voice-tunnels" && req.method === "GET")
      return guard(async () => sendJSON(res, 200, { tunnels: await playit.listVoiceTunnels(), playit: playit.snapshot() }))(req, res);

    if (p === "/api/playit/refresh" && req.method === "POST")
      return guard(async () => sendJSON(res, 200, { playit: await playit.refresh() }))(req, res);

    if (p === "/api/playit/restart" && req.method === "POST")
      return guard(async () => sendJSON(res, 200, { playit: await playit.restartAgent() }))(req, res);

    // ---- settings ----
    if (p === "/api/settings" && req.method === "GET")
      return sendJSON(res, 200, store.getSettings());
    if (p === "/api/settings" && req.method === "PUT") {
      const body = await readJSONBody(req);
      const patch = {};
      if ("javaPath" in body) patch.javaPath = body.javaPath || null;
      if ("defaultMemory" in body) patch.defaultMemory = Number(body.defaultMemory) || 4096;
      if ("keepServersRunning" in body) patch.keepServersRunning = !!body.keepServersRunning;
      // null means "put the stock buttons back".
      if ("quickCommands" in body)
        patch.quickCommands = body.quickCommands === null
          ? store.DEFAULT_QUICK_COMMANDS
          : cleanQuickCommands(body.quickCommands);
      return sendJSON(res, 200, store.setSettings(patch));
    }

    // ---- servers collection ----
    if (p === "/api/servers" && req.method === "GET")
      return sendJSON(res, 200, { servers: manager.listSummaries() });

    // Settings → "Stop all servers": every running server, gracefully.
    if (p === "/api/servers/stop-all" && req.method === "POST")
      return sendJSON(res, 200, manager.stopAll());

    if (p === "/api/servers" && req.method === "POST")
      return guard(async () => {
        const body = await readJSONBody(req);
        if (!body.loader || !body.mc)
          return sendJSON(res, 400, { error: "A loader and Minecraft version are required." });
        const def = await manager.create(body);
        sendJSON(res, 200, { server: manager.summary(def.id) });
      })(req, res);

    // ---- single server ----
    const id = parts[1] === "servers" ? parts[2] : null;
    const def = id ? store.find(id) : null;
    if (id && !def) return sendJSON(res, 404, { error: "Unknown server" });

    if (id) {
      const action = parts[3];

      if (!action && req.method === "GET") {
        const s = manager.slot(id);
        return sendJSON(res, 200, {
          server: manager.summary(id),
          def,
          pauseSupported: manager.supportsPause(def.mc),
          voice: voicechat.info(def, { deep: true }),
          installLog: s.install.log,
        });
      }
      if (!action && req.method === "PATCH") {
        const body = await readJSONBody(req);
        const patch = {};
        for (const k of ["name", "memory", "port", "maxPlayers", "javaPath", "jvmArgs", "icon", "pauseWhenEmpty", "sleepAfter", "wakeOnJoin"])
          if (k in body) patch[k] = body[k];
        if ("restartOnCrash" in body) patch.restartOnCrash = !!body.restartOnCrash;
        if ("startWithPanel" in body) patch.startWithPanel = !!body.startWithPanel;
        // TPS floor 0 is off; anything else is kept inside what TPS can be.
        if ("lagRestartTps" in body) {
          const t = Number(body.lagRestartTps) || 0;
          patch.lagRestartTps = t > 0 ? Math.min(19, Math.max(1, t)) : 0;
        }
        if ("lagRestartMins" in body)
          patch.lagRestartMins = Math.min(240, Math.max(1, Math.round(Number(body.lagRestartMins) || 10)));
        if ("backupEvery" in body) patch.backupEvery = Math.max(0, Math.min(24 * 30, Number(body.backupEvery) || 0));
        if ("backupKeep" in body) patch.backupKeep = Math.max(1, Math.min(200, Math.round(Number(body.backupKeep)) || 7));
        if ("backupScope" in body) patch.backupScope = backup.SCOPES.includes(body.backupScope) ? body.backupScope : "world";
        store.update(id, patch);
        if ("pauseWhenEmpty" in patch) manager.applyPauseProperty(id);
        if ("sleepAfter" in patch) manager.applySleepSetting(id);
        if ("restartOnCrash" in patch || "lagRestartTps" in patch || "lagRestartMins" in patch)
          manager.applyRestartSettings(id);
        if ("wakeOnJoin" in patch || "port" in patch || "name" in patch)
          manager.applyWakeSetting(id).catch(() => {});
        // The playit tunnel points at a fixed local port, so a port change has
        // to be pushed to the running agent.
        if ("port" in patch) playit.sync();
        manager.events.emit("event", { type: "status", ...manager.summary(id) });
        return sendJSON(res, 200, { server: manager.summary(id) });
      }
      if (!action && req.method === "DELETE") {
        if (manager.slot(id).backup)
          return sendJSON(res, 400, { error: "Wait for the running backup or restore to finish." });
        const out = manager.destroy(id);
        try { backup.forget(id); } catch (e) { console.error("[hoster] could not remove backups:", e.message); }
        return sendJSON(res, 200, out);
      }

      if (action === "start" && req.method === "POST")
        return guard(async () => sendJSON(res, 200, await manager.start(id, { manual: true })))(req, res);
      if (action === "stop" && req.method === "POST")
        return sendJSON(res, 200, manager.stop(id, { force: q.get("force") === "1" }));
      if (action === "restart" && req.method === "POST")
        return guard(async () => sendJSON(res, 200, await manager.restart(id)))(req, res);
      if (action === "cancel-restart" && req.method === "POST")
        return sendJSON(res, 200, manager.cancelRestart(id));

      if (action === "command" && req.method === "POST") {
        const body = await readJSONBody(req);
        return sendJSON(res, 200, manager.sendCommand(id, String(body.cmd || "")));
      }
      if (action === "playit" && req.method === "POST")
        return guard(async () => {
          const body = await readJSONBody(req);
          const info = await playit.setEnabled(id, !!body.enabled, { tunnelId: body.tunnelId || null });
          // Adopting a tunnel can take it off another server, so repaint them all.
          for (const d of store.all()) manager.events.emit("event", { type: "status", ...manager.summary(d.id) });
          sendJSON(res, 200, { playit: info, server: manager.summary(id) });
        })(req, res);

      // POST /api/servers/:id/voice {enabled} — Simple Voice Chat on or off.
      // Installing the mod streams its progress like a Mods-tab install does.
      if (action === "voice" && req.method === "POST")
        return guard(async () => {
          const body = await readJSONBody(req);
          const voice = await voicechat.setEnabled(id, !!body.enabled, {
            log: (line) => manager.emitInstall(id, line),
            tunnelId: typeof body.tunnelId === "string" ? body.tunnelId : null,
          });
          // Pausing or making a tunnel can touch other servers' state too.
          for (const d of store.all()) manager.events.emit("event", { type: "status", ...manager.summary(d.id) });
          const status = manager.slot(id).status;
          sendJSON(res, 200, { voice, server: manager.summary(id), running: status === "running" || status === "starting" });
        })(req, res);

      if (action === "eula" && req.method === "POST") {
        const body = await readJSONBody(req);
        return sendJSON(res, 200, { eula: manager.setEula(id, !!body.accepted) });
      }
      if (action === "logs" && req.method === "GET")
        return sendJSON(res, 200, { log: manager.slot(id).log });

      // ---- player log ----
      // Who has been on this server, when, for how long, and what was said.
      // The roster's "online" column comes from the live player list rather
      // than the log's own idea of it, so the two can never disagree.
      const live = () => manager.slot(id).players;

      if (action === "players" && !parts[4] && req.method === "GET")
        return sendJSON(res, 200, playerlog.roster(id, live()));

      // GET /api/servers/:id/players/:name — one player's sessions + totals
      if (action === "players" && parts[4] && !["log", "export"].includes(parts[4]) && req.method === "GET") {
        const detail = playerlog.playerDetail(id, decodeURIComponent(parts[4]), live());
        if (!detail) return sendJSON(res, 404, { error: "That player has never been on this server." });
        return sendJSON(res, 200, { player: detail });
      }

      // GET /api/servers/:id/players/log?type=chat,join&player=&q=&before=&limit=
      if (action === "players" && parts[4] === "log" && req.method === "GET")
        return sendJSON(
          res,
          200,
          playerlog.query(id, {
            types: (q.get("type") || "").split(",").filter(Boolean),
            player: q.get("player") || null,
            q: q.get("q") || null,
            before: q.get("before") ? Number(q.get("before")) : null,
            limit: Number(q.get("limit")) || 200,
          })
        );

      if (action === "players" && parts[4] === "log" && req.method === "DELETE")
        return sendJSON(res, 200, playerlog.clear(id));

      if (action === "players" && parts[4] === "export" && req.method === "GET")
        return sendText(res, 200, playerlog.csv(id), {
          type: "text/csv; charset=utf-8",
          filename: `${(def.name || "server").replace(/[^A-Za-z0-9_-]+/g, "-")}-players.csv`,
        });

      // ---- performance ----
      // Live numbers ride the SSE `stats` events; this is the backfill the
      // Stats tab draws its charts from, plus the lag log and disk usage.
      if (action === "stats" && !parts[4] && req.method === "GET")
        return sendJSON(res, 200, {
          current: manager.perf.current(id),
          history: manager.perf.history(id, q.get("range") || "1h"),
          lag: manager.perf.lagEvents(id).slice(0, 100),
          host: { cores: os.cpus().length, totalMB: Math.round(os.totalmem() / 1048576) },
        });
      // What is taking the space in a folder of the server (the root by
      // default) — the Files tab's sizes. /stats/disk is the old name.
      if ((action === "disk" || (action === "stats" && parts[4] === "disk")) && req.method === "GET")
        return guard(async () =>
          sendJSON(res, 200, { disk: await manager.perf.diskUsage(id, q.get("path") || "", { fresh: q.get("fresh") === "1" }) })
        )(req, res);
      if (action === "stats" && parts[4] === "lag" && req.method === "DELETE") {
        manager.perf.clearLag(id);
        return sendJSON(res, 200, { ok: true });
      }

      // properties
      if (action === "properties" && req.method === "GET")
        return sendJSON(res, 200, { text: manager.readProperties(id) });
      if (action === "properties" && req.method === "PUT") {
        const body = await readJSONBody(req);
        manager.writeProperties(id, String(body.text || ""));
        manager.syncPauseFromProperties(id); // keep the sleep switch in step
        return sendJSON(res, 200, { ok: true });
      }

      // ---- Modrinth content (mods / plugins / datapacks) ----
      // What this server can run, and what it already has installed.
      // Jars added by hand are looked up on Modrinth first (by hash), so ones
      // downloaded from there get their name, icon and update checks. A slow
      // or unreachable Modrinth only delays the list a little.
      if (action === "content" && !parts[4] && req.method === "GET")
        return guard(async () => {
          const dir = store.dirFor(id);
          await Promise.race([
            modrinth.adopt(dir, def).catch(() => {}),
            new Promise((r) => setTimeout(r, 6000)),
          ]);
          sendJSON(res, 200, modrinth.installed(dir, def));
        })(req, res);

      // POST /api/servers/:id/content/upload?name=foo.jar  (raw body)
      // A jar dropped on the content tab: saved into mods/ (or plugins/, …)
      // and recognised on Modrinth when it came from there.
      if (action === "content" && parts[4] === "upload" && req.method === "POST")
        return guard(async () => {
          const buf = await readRawBody(req);
          const out = await modrinth.upload(store.dirFor(id), def, q.get("name") || "", buf);
          sendJSON(res, 200, { ...out, running: manager.slot(id).status === "running" });
        })(req, res);

      // POST /api/servers/:id/content {versionId} | {projectId}
      // Progress lines ride the install event bus so the console tab shows the
      // download as it happens, exactly like the initial server install does.
      if (action === "content" && !parts[4] && req.method === "POST")
        return guard(async () => {
          const body = await readJSONBody(req);
          const out = await modrinth.install(store.dirFor(id), def, {
            versionId: body.versionId || null,
            projectId: body.projectId || null,
            allowIncompatible: !!body.allowIncompatible,
            log: (line) => manager.emitInstall(id, line),
          });
          sendJSON(res, 200, { ...out, running: manager.slot(id).status === "running" });
        })(req, res);

      // DELETE /api/servers/:id/content?file=mods/foo.jar
      if (action === "content" && !parts[4] && req.method === "DELETE")
        return guard(async () =>
          sendJSON(res, 200, modrinth.remove(store.dirFor(id), def, q.get("file")))
        )(req, res);

      if (action === "content" && parts[4] === "updates" && req.method === "GET")
        return guard(async () =>
          sendJSON(res, 200, { updates: await modrinth.updates(store.dirFor(id), def) })
        )(req, res);

      // ---- backups ----
      // GET    /api/servers/:id/backups                    list + schedule + running job
      // POST   /api/servers/:id/backups {scope, note}      start one (progress on the event bus)
      // GET    /api/servers/:id/backups/:file              download the zip
      // POST   /api/servers/:id/backups/:file/restore {safety}
      // DELETE /api/servers/:id/backups/:file
      if (action === "backups") {
        const file = parts[4] ? decodeURIComponent(parts[4]) : null;
        if (!file && req.method === "GET") return guard(async () => sendJSON(res, 200, backup.list(id)))(req, res);
        if (!file && req.method === "POST")
          return guard(async () => {
            const body = await readJSONBody(req);
            backup.create(id, { scope: body.scope || "world", note: body.note || "" }).catch(() => {});
            sendJSON(res, 200, { ok: true });
          })(req, res);
        if (file && !parts[5] && req.method === "GET")
          return guard(async () => {
            const { stream, size } = backup.openRead(id, file);
            const label = `${def.name.replace(/[^\w.-]+/g, "_")}_${file}`;
            res.writeHead(200, {
              "Content-Type": "application/zip",
              "Content-Length": size,
              "Content-Disposition": `attachment; filename="${label}"`,
            });
            stream.pipe(res);
            stream.on("error", () => res.destroy());
          })(req, res);
        if (file && parts[5] === "restore" && req.method === "POST")
          return guard(async () => {
            const body = await readJSONBody(req);
            backup.restore(id, file, { safety: body.safety !== false }).catch(() => {});
            sendJSON(res, 200, { ok: true });
          })(req, res);
        if (file && !parts[5] && req.method === "DELETE")
          return guard(async () => sendJSON(res, 200, backup.remove(id, file)))(req, res);
      }

      // file manager
      if (action === "files" && req.method === "GET")
        return guard(async () => sendJSON(res, 200, manager.listFiles(id, q.get("path") || "")))(req, res);
      // GET /api/servers/:id/search?path=&q= — recursive name search
      if (action === "search" && req.method === "GET")
        return guard(async () =>
          sendJSON(res, 200, manager.searchFiles(id, q.get("path") || "", q.get("q") || ""))
        )(req, res);
      if (action === "file" && req.method === "GET")
        return guard(async () =>
          sendJSON(res, 200, { content: manager.readFile(id, q.get("path")) })
        )(req, res);
      if (action === "file" && req.method === "PUT")
        return guard(async () => {
          const body = await readJSONBody(req);
          manager.writeFile(id, q.get("path"), String(body.content || ""));
          sendJSON(res, 200, { ok: true });
        })(req, res);
      if (action === "file" && req.method === "DELETE")
        return guard(async () => {
          manager.deleteFile(id, q.get("path"));
          sendJSON(res, 200, { ok: true });
        })(req, res);
      // POST /api/servers/:id/delete { paths: [] }  — batch delete
      // POST /api/servers/:id/move   { paths: [], dest } — batch move
      // Both answer with { done, errors: [{path, error}] } so a partly
      // successful batch can be reported honestly instead of as a flat failure.
      if (action === "delete" && req.method === "POST")
        return guard(async () => {
          const body = await readJSONBody(req);
          sendJSON(res, 200, manager.deleteFiles(id, asPathList(body.paths)));
        })(req, res);
      if (action === "move" && req.method === "POST")
        return guard(async () => {
          const body = await readJSONBody(req);
          sendJSON(res, 200, manager.moveFiles(id, asPathList(body.paths), String(body.dest || "")));
        })(req, res);
      if (action === "mkdir" && req.method === "POST")
        return guard(async () => {
          const body = await readJSONBody(req);
          manager.mkdir(id, body.path);
          sendJSON(res, 200, { ok: true });
        })(req, res);
      if (action === "upload" && req.method === "POST")
        return guard(async () => {
          const buf = await readRawBody(req);
          const name = q.get("name") || "upload.bin";
          const dest = path.posix.join(q.get("path") || "", name);
          manager.saveUpload(id, dest, buf);
          sendJSON(res, 200, { ok: true, name });
        })(req, res);
    }

    return sendJSON(res, 404, { error: "Not found" });
  }

  // ---- static files ----
  let file = p === "/" ? "index.html" : p.slice(1);
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC_DIR, "index.html"), (e2, html) => {
        if (e2) {
          res.writeHead(404);
          return res.end("Not found");
        }
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(html);
      });
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, async () => {
  const url = `http://localhost:${PORT}`;
  console.log(`MC Hoster running at ${url}  (${store.all().length} server(s) configured)`);
  for (const lan of lanUrls()) console.log(`  on your network: ${lan}`);
  // Servers that kept running while the panel was away come first: they must
  // not be started a second time, nor have a wake listener parked on their port.
  try {
    await manager.adoptAll();
  } catch (e) {
    console.error("[adopt]", e && e.message);
  }
  manager.initWake(); // stopped servers that want waking need their port held
  manager.autostart().catch((e) => console.error("[autostart]", e && e.message));
  // Only auto-open a browser when launched standalone. Rack captures this
  // process's console and provides its own links, so never pop a window there.
  const supervised = process.env.RACK || process.env.MAC;
  if (isWin() && !supervised && !process.argv.includes("--no-open")) exec(`start "" ${url}`);
});

function isWin() {
  return process.platform === "win32";
}

/* --------------------------------------------------------- graceful shutdown */
// With "keep servers running" on (the default), servers and the playit agent
// are only let go of here — they live on under their hosts until the next
// panel picks them up. Rack's update kills the panel outright and never gets
// this far, which is fine for the same reason.
function shutdown() {
  playit.releaseAgent();
  playerlog.flushAll(); // history batched in memory would otherwise go with us
  manager.perf.flushAll(); // so the 24-hour charts survive a panel restart
  manager.closeWakeListeners().catch(() => {});
  manager.shutdownAll(); // no crash restarts, and "start with panel" remembers who was up
  setTimeout(() => process.exit(0), 600);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// A local panel should never die from a single bad socket write or a rejected
// upstream fetch — log and keep the running Minecraft servers alive.
process.on("uncaughtException", (e) => console.error("[uncaught]", e && e.stack ? e.stack : e));
process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e));

/*
 * wake.js — hold a sleeping server's port and boot it when someone knocks.
 *
 * While a server is asleep nothing is bound to its port, so a client just gets
 * "connection refused" and the player has to go and press Start in the panel.
 * This parks a tiny listener there instead: it speaks just enough of the
 * Minecraft handshake to answer the server-list ping ("💤 Sleeping") and to
 * notice a join attempt, which is the cue to start the real server.
 *
 * It is deliberately NOT a proxy. Once someone knocks we hand the port straight
 * back so Java can bind it, tell the player to reconnect in a moment, and step
 * out of the way. Holding the connection open across a modpack's boot would
 * mean proxying every packet — a different, much larger job.
 *
 * Protocol, all of it we need (wiki.vg "Server List Ping" / "Login"):
 *   client → handshake  0x00: protocolVersion VarInt, address String,
 *                             port UnsignedShort, nextState VarInt
 *                             (1 = status, 2 = login, 3 = transfer)
 *   status:  client → 0x00 request        server → 0x00 JSON response
 *            client → 0x01 ping (8 bytes) server → 0x01 the same 8 bytes back
 *   login:   client → 0x00 login start (name String, …)
 *            server → 0x00 disconnect (JSON chat component)
 * Every packet is framed as: VarInt length, VarInt packet id, payload.
 */

const net = require("net");

// Nothing we care about is remotely this big; anything larger is a scanner or
// a malformed client, and gets dropped rather than buffered.
const MAX_FRAME = 32 * 1024;
const IDLE_MS = 10000;

/* ------------------------------------------------------------- primitives */

function writeVarInt(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

// { value, size }, or null when the buffer does not hold a whole VarInt yet —
// the caller waits for more bytes rather than guessing.
function readVarInt(buf, offset) {
  let value = 0;
  let size = 0;
  for (;;) {
    if (offset + size >= buf.length) return null;
    const b = buf[offset + size];
    value |= (b & 0x7f) << (size * 7);
    size++;
    if (!(b & 0x80)) break;
    if (size >= 5) return null; // malformed — five bytes is the maximum
  }
  return { value: value >>> 0, size };
}

function writeString(str) {
  const b = Buffer.from(str, "utf8");
  return Buffer.concat([writeVarInt(b.length), b]);
}

function readString(buf, offset) {
  const len = readVarInt(buf, offset);
  if (!len) return null;
  const start = offset + len.size;
  if (start + len.value > buf.length) return null;
  return { value: buf.toString("utf8", start, start + len.value), size: len.size + len.value };
}

function packet(id, ...parts) {
  const body = Buffer.concat([writeVarInt(id), ...parts]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

/* ----------------------------------------------------------------- listener */

/*
 * arm({ port, name, maxPlayers, onWake, onLog, onError }) → handle
 *
 * onWake(playerName) fires once per listener, on the first join attempt. The
 * caller is expected to close() us straight away and start the server.
 */
function arm({ port, name = "Server", maxPlayers = 20, onWake, onLog = () => {}, onError = () => {} }) {
  const sockets = new Set();
  let woken = false;

  // Echoing the client's own protocol number keeps the server list from
  // painting this red as a version mismatch — the MOTD is the message.
  const statusJSON = (protocol) =>
    JSON.stringify({
      version: { name: "Sleeping", protocol },
      players: { max: maxPlayers, online: 0, sample: [] },
      description: { text: "💤 " + name + " is sleeping\nJoin to wake it up", color: "aqua" },
    });

  const disconnectJSON = () =>
    JSON.stringify({
      text: "💤 " + name + " was asleep.\n\nIt is starting up now — reconnect in a moment.",
      color: "aqua",
    });

  const srv = net.createServer((sock) => {
    sockets.add(sock);
    let buf = Buffer.alloc(0);
    let state = 0; // 0 handshake, 1 status, 2 login
    let protocol = 0;

    sock.setTimeout(IDLE_MS, () => sock.destroy());
    sock.on("error", () => sock.destroy());
    sock.on("close", () => sockets.delete(sock));

    // Returns false when the socket is finished and the read loop should stop.
    const handleFrame = (frame) => {
      const pid = readVarInt(frame, 0);
      if (!pid) return sock.destroy(), false;
      let off = pid.size;

      if (state === 0) {
        if (pid.value !== 0x00) return sock.destroy(), false;
        const pv = readVarInt(frame, off);
        if (!pv) return sock.destroy(), false;
        off += pv.size;
        const addr = readString(frame, off);
        if (!addr) return sock.destroy(), false;
        off += addr.size + 2; // + UnsignedShort port, which we do not need
        const next = readVarInt(frame, off);
        if (!next) return sock.destroy(), false;
        protocol = pv.value;
        // 3 is "transfer" (1.20.5+); for our purposes it is a join like any other.
        state = next.value === 1 ? 1 : 2;
        return true;
      }

      if (state === 1) {
        if (pid.value === 0x00) {
          sock.write(packet(0x00, writeString(statusJSON(protocol))));
          return true;
        }
        if (pid.value === 0x01) {
          if (frame.length - off < 8) return sock.destroy(), false;
          sock.end(packet(0x01, frame.subarray(off, off + 8))); // echo the token
          return false;
        }
        return sock.destroy(), false;
      }

      // Login. The name is the first field, and the only one worth reading.
      if (pid.value === 0x00) {
        const who = readString(frame, off);
        sock.end(packet(0x00, writeString(disconnectJSON())));
        if (!woken) {
          woken = true;
          onWake(who ? who.value : null);
        }
        return false;
      }
      return sock.destroy(), false;
    };

    sock.on("data", (chunk) => {
      // Pre-1.7 clients open with a legacy 0xFE ping that shares nothing with
      // the modern framing. Not worth answering — those cannot join anyway.
      if (!buf.length && chunk.length && chunk[0] === 0xfe) return sock.destroy();
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const len = readVarInt(buf, 0);
        if (!len) return; // incomplete header, wait for more
        if (len.value > MAX_FRAME) return sock.destroy();
        const end = len.size + len.value;
        if (buf.length < end) return; // incomplete frame, wait for more
        const frame = buf.subarray(len.size, end);
        buf = buf.subarray(end);
        if (!handleFrame(frame)) return;
      }
    });
  });

  srv.on("error", (e) => onError(e));
  srv.listen(port, () => onLog(`listening on ${port}`));

  return {
    port,
    // Give the port back. Resolves once it is genuinely free, so the caller can
    // launch Java without racing the listener.
    close() {
      return new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          resolve();
        };
        srv.close(finish);
        // close() never calls back if we never bound (a port clash, say).
        setTimeout(finish, 1000).unref();
      });
    },
  };
}

module.exports = { arm };

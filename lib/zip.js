/*
 * zip.js — a tiny ZIP reader and writer built on zlib alone.
 *
 * Modrinth ships modpacks as ".mrpack" files, which are ordinary zips with a
 * different extension. Node has no zip support and this project has no
 * dependencies, so rather than shell out to tar/Expand-Archive (which key off
 * the file extension and behave differently per platform) we parse the central
 * directory ourselves. Deflate and store are the only methods zips in the wild
 * use, and both are covered. World backups are written and restored here too.
 */
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { promisify } = require("util");
const { pipeline } = require("stream/promises");
const { Transform } = require("stream");

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);

const EOCD_SIG = 0x06054b50;
const EOCD64_SIG = 0x06064b50;
const EOCD64_LOC_SIG = 0x07064b50;
const CEN_SIG = 0x02014b50;

// The end-of-central-directory record sits at the very end of the file, behind
// a variable-length comment — so scan backwards for its signature.
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--)
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  throw new Error("Not a zip file (no end-of-central-directory record).");
}

// Where the central directory starts and how many entries it holds. Big archives
// put the real numbers in a zip64 record and leave 0xFFFF.. sentinels here.
function directoryInfo(buf) {
  const eocd = findEOCD(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === EOCD64_LOC_SIG) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(z64) === EOCD64_SIG) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        offset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }
  return { count, offset };
}

// List every member: { name, dir, size, read() }. `read` inflates on demand so
// walking a big pack's directory doesn't decompress the whole thing.
function entries(buf) {
  const { count, offset } = directoryInfo(buf);
  const out = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    out.push({
      name,
      dir: name.endsWith("/"),
      size: usize,
      read() {
        // The central directory's name/extra lengths can differ from the local
        // header's, so re-read them there to find where the bytes really start.
        const lnLen = buf.readUInt16LE(local + 26);
        const leLen = buf.readUInt16LE(local + 28);
        const start = local + 30 + lnLen + leLen;
        const raw = buf.subarray(start, start + csize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`Unsupported zip compression method ${method} for ${name}`);
      },
    });
  }
  return out;
}

function readEntry(buf, name) {
  const e = entries(buf).find((x) => x.name === name);
  if (!e) throw new Error(`${name} is missing from the archive.`);
  return e.read();
}

// Reject absolute paths, drive letters and "../" escapes before writing — a
// malicious archive must not be able to write outside the server folder.
function safeTarget(destDir, name) {
  const clean = name.replace(/\\/g, "/").replace(/^([a-zA-Z]:)?\/+/, "");
  if (clean.split("/").includes("..")) return null;
  const full = path.resolve(destDir, clean);
  if (full !== path.resolve(destDir) && !full.startsWith(path.resolve(destDir) + path.sep)) return null;
  return full;
}

/*
 * Extract members into destDir. `prefix` (e.g. "overrides/") limits extraction
 * to one subtree and is stripped from the written paths. Returns the number of
 * files written.
 */
function extractTo(buf, destDir, { prefix = "" } = {}) {
  let written = 0;
  for (const e of entries(buf)) {
    if (prefix && !e.name.startsWith(prefix)) continue;
    const rel = prefix ? e.name.slice(prefix.length) : e.name;
    if (!rel || e.dir) continue;
    const full = safeTarget(destDir, rel);
    if (!full) continue; // path traversal attempt — skip it
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, e.read());
    written++;
  }
  return written;
}

/* ------------------------------------------------------------------ writer */
/*
 * World backups go the other direction, and they are big: a modded world is
 * tens of thousands of region files and can run past 4 GB. So the writer goes
 * entry by entry straight to disk, never holds more than one file in memory,
 * and switches to zip64 records whenever a size, an offset or the entry count
 * outgrows the classic 32/16-bit fields.
 *
 * Each file is compressed before its local header is written, so the header
 * carries the real CRC and sizes and no data descriptors are needed. Files too
 * big to buffer are stored instead: copied once, CRC'd as they go, and the
 * header's CRC patched in afterwards.
 */

const LOC_SIG = 0x04034b50;
const U32 = 0xffffffff;
const BUFFER_LIMIT = 64 * 1024 * 1024; // bigger than this is streamed, not buffered
const CHUNK = 1024 * 1024;

function dosStamp(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zip64Extra(values) {
  const b = Buffer.alloc(4 + 8 * values.length);
  b.writeUInt16LE(0x0001, 0);
  b.writeUInt16LE(8 * values.length, 2);
  values.forEach((v, i) => b.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
  return b;
}

function localHeader(e) {
  // A local zip64 extra must carry both sizes, whichever one overflowed.
  const z64 = e.usize >= U32 || e.csize >= U32;
  const extra = z64 ? zip64Extra([e.usize, e.csize]) : Buffer.alloc(0);
  const h = Buffer.alloc(30);
  h.writeUInt32LE(LOC_SIG, 0);
  h.writeUInt16LE(z64 ? 45 : 20, 4);
  h.writeUInt16LE(0x0800, 6); // names are UTF-8
  h.writeUInt16LE(e.method, 8);
  h.writeUInt16LE(e.time, 10);
  h.writeUInt16LE(e.date, 12);
  h.writeUInt32LE(e.crc, 14);
  h.writeUInt32LE(z64 ? U32 : e.csize, 18);
  h.writeUInt32LE(z64 ? U32 : e.usize, 22);
  h.writeUInt16LE(e.name.length, 26);
  h.writeUInt16LE(extra.length, 28);
  return Buffer.concat([h, e.name, extra]);
}

function centralHeader(e) {
  // Only the fields that overflowed go in the central zip64 extra, in this order.
  const big = [e.usize, e.csize, e.offset].filter((v) => v >= U32);
  const extra = big.length ? zip64Extra(big) : Buffer.alloc(0);
  const h = Buffer.alloc(46);
  h.writeUInt32LE(CEN_SIG, 0);
  h.writeUInt16LE(45, 4);
  h.writeUInt16LE(big.length ? 45 : 20, 6);
  h.writeUInt16LE(0x0800, 8);
  h.writeUInt16LE(e.method, 10);
  h.writeUInt16LE(e.time, 12);
  h.writeUInt16LE(e.date, 14);
  h.writeUInt32LE(e.crc, 16);
  h.writeUInt32LE(Math.min(e.csize, U32), 20);
  h.writeUInt32LE(Math.min(e.usize, U32), 24);
  h.writeUInt16LE(e.name.length, 28);
  h.writeUInt16LE(extra.length, 30);
  h.writeUInt32LE(e.dir ? 0x10 : 0, 38); // MS-DOS directory attribute
  h.writeUInt32LE(Math.min(e.offset, U32), 42);
  return Buffer.concat([h, e.name, extra]);
}

function endRecords(count, cdOffset, cdSize) {
  const out = [];
  if (count >= 0xffff || cdOffset >= U32 || cdSize >= U32) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(EOCD64_SIG, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12);
    z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(count), 24);
    z.writeBigUInt64LE(BigInt(count), 32);
    z.writeBigUInt64LE(BigInt(cdSize), 40);
    z.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(EOCD64_LOC_SIG, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cdSize), 8);
    loc.writeUInt32LE(1, 16);
    out.push(z, loc);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(EOCD_SIG, 0);
  e.writeUInt16LE(Math.min(count, 0xffff), 8);
  e.writeUInt16LE(Math.min(count, 0xffff), 10);
  e.writeUInt32LE(Math.min(cdSize, U32), 12);
  e.writeUInt32LE(Math.min(cdOffset, U32), 16);
  out.push(e);
  return Buffer.concat(out);
}

/*
 * Write `items` — [{ name, abs, dir, mtime }] with posix-style names — to a new
 * zip at `dest`. A file that can't be read (a lock the running server holds,
 * one deleted since the walk) is skipped rather than failing the archive, and
 * its name comes back so the caller can say so. `onEntry(done, total)` reports
 * progress. Returns { files, bytes, skipped }.
 */
async function writeZip(dest, items, { onEntry = () => {} } = {}) {
  const out = await fsp.open(dest, "w");
  let pos = 0;
  const put = async (buf) => {
    for (let off = 0; off < buf.length; ) {
      const { bytesWritten } = await out.write(buf, off, buf.length - off, pos);
      off += bytesWritten;
      pos += bytesWritten;
    }
  };
  const central = [];
  const skipped = [];
  let files = 0, bytes = 0;

  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const { time, date } = dosStamp(it.mtime || new Date());
      const name = Buffer.from(it.dir ? it.name.replace(/\/?$/, "/") : it.name, "utf8");

      if (it.dir) {
        const e = { name, time, date, dir: true, method: 0, crc: 0, csize: 0, usize: 0, offset: pos };
        await put(localHeader(e));
        central.push(e);
        onEntry(i + 1, items.length);
        continue;
      }

      let fh;
      try {
        fh = await fsp.open(it.abs, "r");
      } catch {
        skipped.push(it.name);
        onEntry(i + 1, items.length);
        continue;
      }
      try {
        const size = (await fh.stat()).size;
        if (size <= BUFFER_LIMIT) {
          let raw;
          try {
            raw = await fh.readFile();
          } catch {
            skipped.push(it.name);
            continue;
          }
          const packed = await deflateRaw(raw);
          const stored = packed.length >= raw.length; // already-compressed data
          const e = {
            name, time, date, method: stored ? 0 : 8, crc: zlib.crc32(raw),
            csize: stored ? raw.length : packed.length, usize: raw.length, offset: pos,
          };
          await put(localHeader(e));
          await put(stored ? raw : packed);
          central.push(e);
          bytes += raw.length;
        } else {
          const e = { name, time, date, method: 0, crc: 0, csize: size, usize: size, offset: pos };
          await put(localHeader(e));
          // Past this point a short read would leave a broken archive behind.
          // The CRC is taken from the very bytes written: a running server keeps
          // changing big files (Distant Horizons' database, say), so a separate
          // CRC pass would describe a different file than the one stored.
          const buf = Buffer.alloc(CHUNK);
          let crc = 0;
          for (let at = 0; at < size; ) {
            const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - at), at);
            if (!bytesRead) throw new Error(`${it.name} shrank while being backed up`);
            const chunk = buf.subarray(0, bytesRead);
            crc = zlib.crc32(chunk, crc);
            await put(chunk);
            at += bytesRead;
          }
          e.crc = crc;
          // The local header went out with a placeholder; fill in the real CRC.
          const crcBytes = Buffer.alloc(4);
          crcBytes.writeUInt32LE(crc, 0);
          await out.write(crcBytes, 0, 4, e.offset + 14);
          central.push(e);
          bytes += size;
        }
        files++;
      } finally {
        await fh.close();
        onEntry(i + 1, items.length);
      }
    }

    const cdOffset = pos;
    for (const e of central) await put(centralHeader(e));
    await put(endRecords(central.length, cdOffset, pos - cdOffset));
  } finally {
    await out.close();
  }
  return { files, bytes, skipped };
}

/* -------------------------------------------------------- file-based reader */
/*
 * The buffer reader above is fine for a modpack; a world backup can be bigger
 * than Node will read into one Buffer. This one works through a file handle,
 * reads only the central directory up front, and pulls each member as it goes.
 */

async function readAt(fh, pos, len) {
  const buf = Buffer.alloc(len);
  for (let got = 0; got < len; ) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) throw new Error("Unexpected end of zip file.");
    got += bytesRead;
  }
  return buf;
}

async function listHandle(fh) {
  const size = (await fh.stat()).size;
  const tailLen = Math.min(size, 0xffff + 22 + 20);
  const tail = await readAt(fh, size - tailLen, tailLen);
  const eocd = findEOCD(tail);
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === U32 || cdOffset === U32) {
    const loc = eocd - 20;
    if (loc >= 0 && tail.readUInt32LE(loc) === EOCD64_LOC_SIG) {
      const z = await readAt(fh, Number(tail.readBigUInt64LE(loc + 8)), 56);
      if (z.readUInt32LE(0) !== EOCD64_SIG) throw new Error("Broken zip64 directory.");
      count = Number(z.readBigUInt64LE(32));
      cdSize = Number(z.readBigUInt64LE(40));
      cdOffset = Number(z.readBigUInt64LE(48));
    }
  }

  const cd = await readAt(fh, cdOffset, cdSize);
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CEN_SIG) throw new Error("Broken zip directory.");
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const e = {
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      local: cd.readUInt32LE(p + 42),
      name: cd.toString("utf8", p + 46, p + 46 + nameLen),
    };
    // Overflowed fields live in the zip64 extra, in usize/csize/offset order.
    const end = p + 46 + nameLen + extraLen;
    for (let x = p + 46 + nameLen; x + 4 <= end; ) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let f = x + 4;
        for (const k of ["usize", "csize", "local"])
          if (e[k] === U32) { e[k] = Number(cd.readBigUInt64LE(f)); f += 8; }
      }
      x += 4 + len;
    }
    e.dir = e.name.endsWith("/");
    out.push(e);
    p = end + commentLen;
  }
  return out;
}

// Member names in a zip on disk, without extracting anything.
async function listZip(file) {
  const fh = await fsp.open(file, "r");
  try {
    return (await listHandle(fh)).map(({ name, dir, usize }) => ({ name, dir, size: usize }));
  } finally {
    await fh.close();
  }
}

// Where a member's bytes start: past its local header, whose name/extra
// lengths can differ from the central directory's.
async function dataStart(fh, e) {
  const lh = await readAt(fh, e.local, 30);
  if (lh.readUInt32LE(0) !== LOC_SIG) throw new Error(`Broken entry ${e.name}`);
  return e.local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
}

// One small member of a zip on disk (a manifest, say), or null if it has none.
async function readMember(file, name, { limit = 4 * 1024 * 1024 } = {}) {
  const fh = await fsp.open(file, "r");
  try {
    const e = (await listHandle(fh)).find((x) => x.name === name);
    if (!e) return null;
    if (e.usize > limit || e.csize > limit) throw new Error(`${name} is too big to read.`);
    const raw = e.csize ? await readAt(fh, await dataStart(fh, e), e.csize) : Buffer.alloc(0);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflateRaw(raw);
    throw new Error(`Unsupported zip compression method ${e.method} for ${name}`);
  } finally {
    await fh.close();
  }
}

/*
 * Extract a zip on disk into destDir, checking every member's CRC — a backup
 * that restores silently corrupted is worse than one that refuses to.
 * `prefix` (e.g. "server/") limits it to one subtree, stripped from the
 * written paths. A member that fails its CRC aborts the extract, unless
 * `expendable(name)` says it can be rebuilt from nothing: that one is left out
 * and handed to `onDropped(name)` instead. Returns the number of files written.
 */
async function extractFile(file, destDir, { onEntry = () => {}, prefix = "", expendable = () => false, onDropped = () => {} } = {}) {
  const fh = await fsp.open(file, "r");
  try {
    const list = (await listHandle(fh)).filter((e) => !prefix || (e.name.startsWith(prefix) && e.name !== prefix));
    let written = 0;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      onEntry(i + 1, list.length);
      const full = safeTarget(destDir, e.name.slice(prefix.length));
      if (!full) continue; // path traversal attempt — skip it
      if (e.dir) {
        await fsp.mkdir(full, { recursive: true });
        continue;
      }
      if (e.method !== 0 && e.method !== 8)
        throw new Error(`Unsupported zip compression method ${e.method} for ${e.name}`);
      const start = await dataStart(fh, e);
      await fsp.mkdir(path.dirname(full), { recursive: true });

      let crc = 0;
      if (e.csize <= BUFFER_LIMIT) {
        const raw = e.csize ? await readAt(fh, start, e.csize) : Buffer.alloc(0);
        const data = e.method === 8 ? await inflateRaw(raw) : raw;
        crc = zlib.crc32(data);
        await fsp.writeFile(full, data);
      } else {
        const tally = new Transform({
          transform(chunk, _enc, cb) { crc = zlib.crc32(chunk, crc); cb(null, chunk); },
        });
        const src = fs.createReadStream(file, { start, end: start + e.csize - 1 });
        const steps = e.method === 8 ? [src, zlib.createInflateRaw(), tally] : [src, tally];
        await pipeline(...steps, fs.createWriteStream(full));
      }
      if (crc >>> 0 !== e.crc >>> 0) {
        if (!expendable(e.name)) throw new Error(`${e.name} is corrupt in the archive (CRC mismatch).`);
        await fsp.rm(full, { force: true });
        onDropped(e.name);
        continue;
      }
      written++;
    }
    return written;
  } finally {
    await fh.close();
  }
}

module.exports = { entries, readEntry, extractTo, writeZip, listZip, readMember, extractFile };

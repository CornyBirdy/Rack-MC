/*
 * zip.js — a tiny read-only ZIP reader built on zlib alone.
 *
 * Modrinth ships modpacks as ".mrpack" files, which are ordinary zips with a
 * different extension. Node has no zip support and this project has no
 * dependencies, so rather than shell out to tar/Expand-Archive (which key off
 * the file extension and behave differently per platform) we parse the central
 * directory ourselves. Deflate and store are the only methods zips in the wild
 * use, and both are covered.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

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

module.exports = { entries, readEntry, extractTo };

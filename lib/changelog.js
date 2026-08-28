/*
 * changelog.js — what build is this, and what changed in it.
 *
 * The panel has no version number: it is deployed by pulling `main`, and
 * CHANGELOG.md is grouped by the day work landed. So "the version" is the
 * newest heading in that file, and the precise build identity is whatever
 * commit the checkout is sitting on — read straight out of .git, since Rack's
 * update button is a `git pull` and there is no build step to stamp anything.
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FILE = path.join(ROOT, "CHANGELOG.md");

// Re-reading a few KB per request would be fine, but the mtime check keeps a
// pinned changelog modal from touching the disk on every poll.
let cache = { mtime: 0, text: "", version: null };

function readText() {
  let stat;
  try {
    stat = fs.statSync(FILE);
  } catch {
    return { text: "", version: null };
  }
  if (stat.mtimeMs === cache.mtime) return cache;
  let text = "";
  try {
    text = fs.readFileSync(FILE, "utf8");
  } catch {
    return { text: "", version: null };
  }
  // The first "## …" line is the newest entry, and its heading is the version.
  const heading = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("## "));
  cache = { mtime: stat.mtimeMs, text, version: heading ? heading.slice(3).trim() : null };
  return cache;
}

// Short commit hash of the checkout, or null when this is not a git working
// copy (a zip download, say). Resolves the ref HEAD points at by hand rather
// than shelling out to git, which may not be on PATH.
function commit() {
  const git = path.join(ROOT, ".git");
  try {
    const head = fs.readFileSync(path.join(git, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 7) || null;
    const ref = head.slice(4).trim();
    try {
      return fs.readFileSync(path.join(git, ref), "utf8").trim().slice(0, 7) || null;
    } catch {
      // Packed refs: the loose file is gone once git has gc'd.
      const packed = fs.readFileSync(path.join(git, "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(" " + ref));
      return line ? line.slice(0, 7) : null;
    }
  } catch {
    return null;
  }
}

// { version, commit } — the cheap half, for the bootstrap payload.
function stamp() {
  return { version: readText().version, commit: commit() };
}

// The whole thing, for the modal.
function full() {
  const { text, version } = readText();
  return { version, commit: commit(), text };
}

module.exports = { stamp, full };

/*
 * net.js — tiny zero-dependency HTTP client.
 * Only Node built-ins. Handles JSON/text fetches and file downloads with
 * redirect-following and a friendly User-Agent (PaperMC's "fill" API rejects
 * requests without one).
 */
const https = require("https");
const http = require("http");
const fs = require("fs");
const { URL } = require("url");

const UA = "MC-Hoster/1.0 (+multiapp-controller)";

function libFor(u) {
  return u.protocol === "http:" ? http : https;
}

// Low-level request that resolves with the live response stream. Follows up to
// `redirects` 3xx hops (Mojang/Maven/Paper all redirect to CDNs). `body` is an
// optional request payload (playit's API is POST-only).
function request(url, { method = "GET", headers = {}, body = null, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error(`Bad URL: ${url}`));
    }
    const req = libFor(u).request(
      u,
      { method, headers: { "User-Agent": UA, Accept: "*/*", ...headers } },
      (res) => {
        const status = res.statusCode || 0;
        const loc = res.headers.location;
        if (status >= 300 && status < 400 && loc && redirects > 0) {
          res.resume(); // drain
          const next = new URL(loc, url).toString();
          resolve(request(next, { method, headers, body, redirects: redirects - 1 }));
          return;
        }
        resolve({ status, headers: res.headers, res });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("Request timed out")));
    req.end(body || undefined);
  });
}

async function getText(url, opts) {
  const { status, res } = await request(url, opts);
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf8");
  if (status >= 400) throw new Error(`HTTP ${status} for ${url} — ${body.slice(0, 160)}`);
  return body;
}

async function getJson(url, opts) {
  return JSON.parse(await getText(url, opts));
}

// POST a JSON body and parse the JSON reply. Unlike getText this hands 4xx/5xx
// bodies back to the caller: playit answers with a JSON error envelope and a
// non-2xx status, and the message inside it is the useful part.
async function postJson(url, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body ?? {}));
  const { status, res } = await request(url, {
    method: "POST",
    body: payload,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(payload.length),
      ...headers,
    },
  });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    throw new Error(`HTTP ${status} for ${url} — ${text.slice(0, 160) || "empty reply"}`);
  }
}

// Download to a file, reporting progress via onProgress(bytesDone, bytesTotal).
async function download(url, destPath, onProgress) {
  const { status, headers, res } = await request(url);
  if (status >= 400) {
    for await (const _ of res) {
      /* drain */
    }
    throw new Error(`HTTP ${status} downloading ${url}`);
  }
  const total = Number(headers["content-length"] || 0);
  let done = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.on("data", (c) => {
      done += c.length;
      if (onProgress) onProgress(done, total);
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", () => out.close((e) => (e ? reject(e) : resolve())));
    res.pipe(out);
  });
  return { bytes: done, total };
}

module.exports = { getText, getJson, postJson, download, request, UA };

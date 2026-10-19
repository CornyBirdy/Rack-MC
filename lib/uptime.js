/*
 * uptime.js — the time arithmetic behind scheduled uptime. Pure functions, no
 * timers: manager.js asks "should this server be up right now?" and "when does
 * that next change?", and acts on the answers.
 *
 * A schedule is a list of windows, each a set of weekdays plus a from/to time
 * on the panel computer's own clock:
 *
 *   { on: true, windows: [{ days: [1,2,3,4,5], from: "16:00", to: "23:00" }],
 *     players: "warn" | "wait", warnMins: 5 }
 *
 * Days are JavaScript's (0 = Sunday). A window whose `to` is at or before its
 * `from` runs past midnight into the next day, and the day it belongs to is
 * the one it starts on — "Fri 20:00 to 02:00" is Friday night. Equal times
 * mean the whole 24 hours. Windows that touch or overlap are merged, so two
 * back-to-back windows never stop and start the server in between — and so
 * are ones a minute apart, so a window typed as ending at 23:59 runs on into
 * one starting at 00:00.
 */
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const MAX_WINDOWS = 14;
const DAY = 86400000;

const minutesOf = (t) => {
  const m = TIME.exec(String(t || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const pad = (n) => String(n).padStart(2, "0");

// Whatever the browser sent, made into a schedule that can't misbehave.
function normalize(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const windows = (Array.isArray(src.windows) ? src.windows : [])
    .map((w) => {
      const from = minutesOf(w && w.from);
      const to = minutesOf(w && w.to);
      const days = [...new Set((Array.isArray(w && w.days) ? w.days : []).map(Number))]
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
        .sort((a, b) => a - b);
      if (from == null || to == null || !days.length) return null;
      return { days, from: `${pad(Math.floor(from / 60))}:${pad(from % 60)}`, to: `${pad(Math.floor(to / 60))}:${pad(to % 60)}` };
    })
    .filter(Boolean)
    .slice(0, MAX_WINDOWS);
  return {
    on: !!src.on && windows.length > 0,
    windows,
    players: src.players === "wait" ? "wait" : "warn",
    warnMins: Math.min(60, Math.max(1, Math.round(Number(src.warnMins)) || 5)),
  };
}

// Every stretch of scheduled uptime that touches [from, to], merged, as
// [start, end] millisecond pairs. Dates are built from local calendar fields
// so a daylight-saving change moves the clock, not the window.
function intervals(sch, from, to) {
  const out = [];
  const first = new Date(from - DAY * 2);
  for (let d = new Date(first.getFullYear(), first.getMonth(), first.getDate()); d.getTime() <= to; d.setDate(d.getDate() + 1)) {
    for (const w of sch.windows) {
      if (!w.days.includes(d.getDay())) continue;
      const a = minutesOf(w.from), b = minutesOf(w.to);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(a / 60), a % 60).getTime();
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + (b <= a ? 1 : 0), Math.floor(b / 60), b % 60).getTime();
      if (end >= from && start <= to) out.push([start, end]);
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 60000) last[1] = Math.max(last[1], iv[1]);
    else merged.push(iv.slice());
  }
  return merged;
}

// Is the server meant to be up at `now`? Only meaningful while `on`.
function inside(sch, now = Date.now()) {
  // A day either side, so a neighbour that merges into this stretch is seen.
  return intervals(sch, now - DAY, now + DAY).some(([a, b]) => a <= now && now < b);
}

// The next moment the answer changes, within the coming week: { at, kind }
// with kind "start" or "stop", or null for a schedule that never changes
// (every window 24 hours, every day).
function next(sch, now = Date.now()) {
  if (!sch.on) return null;
  let best = null;
  for (const [a, b] of intervals(sch, now, now + DAY * 8)) {
    if (a > now && (!best || a < best.at)) best = { at: a, kind: "start" };
    // Uptime running past the end of the week we looked at never stops.
    if (b > now && a <= now && b < now + DAY * 7 && (!best || b < best.at)) best = { at: b, kind: "stop" };
  }
  return best;
}

// What the panel computer calls its time zone, for the settings screen.
function zone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

module.exports = { normalize, inside, next, zone };

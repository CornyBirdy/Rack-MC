/* ================================================================== icons.js
 * One 16x16 stroked icon set, inlined as SVG so it themes with currentColor
 * and needs no font or network fetch. Everything is drawn on the same grid
 * with the same 1.5 stroke, which is what keeps the panel from looking like a
 * pile of borrowed glyphs.
 *
 * Loaded before app.js; exposes ico(), loaderTile() and initialTile().
 * ======================================================================== */

const ICON_PATHS = {
  // The mark: an isometric block. Doubles as the brand and the empty state.
  cube: "M8 1.7 13.9 5v6L8 14.3 2.1 11V5z M2.1 5 8 8.3 13.9 5 M8 8.3v6",

  plus: "M8 3.2v9.6 M3.2 8h9.6",
  grid: "M2.6 2.6h4.6v4.6H2.6z M8.8 2.6h4.6v4.6H8.8z M2.6 8.8h4.6v4.6H2.6z M8.8 8.8h4.6v4.6H8.8z",
  // A hex nut rather than a cogwheel - fewer teeth to go muddy at 14px.
  gear: "M8 1.9 13.3 5v6L8 14.1 2.7 11V5z M8 6.1a1.9 1.9 0 1 0 0 3.8 1.9 1.9 0 0 0 0-3.8z",
  sliders: "M2.6 5.2h10.8 M2.6 10.8h10.8 M5.9 3.6v3.2 M10.3 9.2v3.2",

  rotate: "M13.4 8a5.4 5.4 0 1 1-1.7-3.9 M13.4 2.6v3.6h-3.6",

  play: "M4.9 3.3 12.3 8l-7.4 4.7z",
  stop: "M4.4 4.4h7.2v7.2H4.4z",
  bolt: "M8.9 1.8 3.5 9.1h4l-.4 5.1 5.4-7.4H8.4z",

  folder: "M2.2 4.3c0-.6.5-1.1 1.1-1.1h2.6l1.4 1.7h5.4c.6 0 1.1.5 1.1 1.1v6c0 .6-.5 1.1-1.1 1.1H3.3c-.6 0-1.1-.5-1.1-1.1z",
  file: "M9 1.9H4.7c-.6 0-1.1.5-1.1 1.1v10c0 .6.5 1.1 1.1 1.1h6.6c.6 0 1.1-.5 1.1-1.1V5.4z M9 1.9v3.5h3.5",
  box: "M13.4 10.9V5.1L8 2.1 2.6 5.1v5.8L8 13.9z M2.6 5.1 8 8.1l5.4-3 M8 8.1v5.8",
  archive: "M2.4 3.2h11.2v2.5H2.4z M3.5 5.7v7.1h9v-7.1 M6.6 8.4h2.8",
  image: "M3.3 2.9h9.4c.5 0 .9.4.9.9v8.4c0 .5-.4.9-.9.9H3.3a.9.9 0 0 1-.9-.9V3.8c0-.5.4-.9.9-.9z M6.1 6.6a1 1 0 1 1-2 0 1 1 0 0 1 2 0z M13.6 10.3 10.4 7.1 3.6 13.1",
  search: "M7.2 12.1a4.9 4.9 0 1 0 0-9.8 4.9 4.9 0 0 0 0 9.8z M13.6 13.6 10.7 10.7",
  layers: "M8 1.9 2.3 5 8 8.1 13.7 5z M2.4 8.1 8 11.1l5.6-3 M2.4 11.1 8 14.1l5.6-3",
  upload: "M8 12.1V3.5 M4.6 6.9 8 3.4l3.4 3.5 M2.6 13.5h10.8",
  download: "M8 3.4V12 M4.6 8.5 8 12l3.4-3.5 M2.6 13.5h10.8",
  trash: "M2.9 4.3h10.2 M6.2 4.3V3.2c0-.4.3-.8.7-.8h2.2c.4 0 .7.4.7.8v1.1 M4.2 4.3l.6 8.4c0 .5.4.8.9.8h4.6c.5 0 .9-.3.9-.8l.6-8.4",
  copy: "M6.3 6.3h6.1c.5 0 .9.4.9.9v6.1c0 .5-.4.9-.9.9H6.3a.9.9 0 0 1-.9-.9V7.2c0-.5.4-.9.9-.9z M3.6 9.8h-.3a.9.9 0 0 1-.9-.9V2.8c0-.5.4-.9.9-.9h6.1c.5 0 .9.4.9.9v.3",
  external: "M9.5 2.6h3.9v3.9 M13.4 2.6 7.4 8.6 M11.6 9.2v3.3c0 .5-.4.9-.9.9H3.5a.9.9 0 0 1-.9-.9V5.4c0-.5.4-.9.9-.9h3.3",

  globe: "M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4z M1.9 8h12.2 M8 1.8c1.6 1.7 2.5 3.9 2.5 6.2S9.6 12.5 8 14.2C6.4 12.5 5.5 10.3 5.5 8S6.4 3.5 8 1.8z",
  map: "M1.9 4.3 5.8 2.7v9.1L1.9 13.4z M5.8 2.7l4.4 1.7v9.1L5.8 11.8 M10.2 4.4l3.9-1.7v9.1l-3.9 1.6",
  users: "M10.8 13.6v-1.2a2.5 2.5 0 0 0-2.5-2.5H4.5a2.5 2.5 0 0 0-2.5 2.5v1.2 M6.4 7.6a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8z M14.1 13.6v-1.2a2.5 2.5 0 0 0-1.9-2.4 M10.4 2.9a2.4 2.4 0 0 1 0 4.6",
  gauge: "M13.3 11.5a6.1 6.1 0 1 0-10.6 0 M8 8.1l2.8-2.8",
  flask: "M6.4 1.9v3.6L3 11.6c-.6.9.1 2 1.1 2h7.8c1 0 1.7-1.1 1.1-2L9.6 5.5V1.9 M5.5 1.9h5 M4.5 9.2h7",
  coffee: "M2.9 5.5h8.6v3.9a3 3 0 0 1-3 3H5.9a3 3 0 0 1-3-3z M11.5 6.7h.9a1.8 1.8 0 0 1 0 3.6h-.9 M5.2 2v1.7 M8.2 2v1.7",
  plug: "M6 2.2v3.4 M10 2.2v3.4 M4.4 5.6h7.2v2.2A3.6 3.6 0 0 1 8 11.4 3.6 3.6 0 0 1 4.4 7.8z M8 11.4v2.4",
  moon: "M13.2 9.5A5.7 5.7 0 0 1 6.5 2.8a5.9 5.9 0 1 0 6.7 6.7z",

  lock: "M4 7.2h8c.6 0 1 .4 1 1v4.3c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V8.2c0-.6.4-1 1-1z M5.4 7.2V5.3a2.6 2.6 0 0 1 5.2 0v1.9",
  unlock: "M4 7.2h8c.6 0 1 .4 1 1v4.3c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V8.2c0-.6.4-1 1-1z M5.4 7.2V5.3a2.6 2.6 0 0 1 5-1",
  eye: "M1.6 8S4.2 3.7 8 3.7 14.4 8 14.4 8 11.8 12.3 8 12.3 1.6 8 1.6 8z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  alert: "M8 2.4 14.4 13.3H1.6z M8 6.5v3.1 M8 11.4h.01",
  check: "M3.1 8.3 6.4 11.8 12.9 4.7",
  terminal: "M3.5 4.4 6.7 7.6l-3.2 3.2 M8.3 11.6h4.2",
  clock: "M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4z M8 4.5V8l2.4 1.5",
  chat: "M13.6 9.5c0 .8-.7 1.5-1.5 1.5H5.4L2.4 13.6V4.3c0-.8.7-1.5 1.5-1.5h8.2c.8 0 1.5.7 1.5 1.5z",
  star: "M8 2.2l1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.6l-3.6 1.9.7-4.1-3-2.9 4.1-.6z",
  list: "M5.5 4.3h7.9 M5.5 8h7.9 M5.5 11.7h7.9 M2.7 4.3h.01 M2.7 8h.01 M2.7 11.7h.01",
};

// A handful read better filled than stroked.
const ICON_FILLED = new Set(["play", "stop", "bolt", "moon"]);

/**
 * Inline icon. `name` must exist in ICON_PATHS - an unknown name renders
 * nothing rather than a broken box.
 */
function ico(name, cls) {
  const d = ICON_PATHS[name];
  if (!d) return "";
  const filled = ICON_FILLED.has(name);
  return (
    `<svg class="i${cls ? " " + cls : ""}" viewBox="0 0 16 16" aria-hidden="true" ` +
    `fill="${filled ? "currentColor" : "none"}" stroke="${filled ? "none" : "currentColor"}" ` +
    `stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`
  );
}

/* --------------------------------------------------------------- loaders */
/* Two-letter monospace tiles. Monochrome SVG can't tell Fabric from Quilt, and
 * emoji flags were the thing we were getting away from - so each loader gets
 * an initial pair in its own (desaturated) brand colour instead. */
const LOADER_TILES = {
  vanilla:  ["VA", "#7f8a6a"],
  paper:    ["PA", "#9aa3ab"],
  purpur:   ["PU", "#9070b0"],
  fabric:   ["FA", "#b09a68"],
  quilt:    ["QU", "#8f7bc0"],
  forge:    ["FO", "#5b7f9c"],
  neoforge: ["NE", "#bb7a4c"],
  modrinth: ["MR", "#57a75f"],
};

/** Loader chip. `size` is the tile edge in px. */
function loaderTile(id, size = 22) {
  const [txt, color] = LOADER_TILES[id] || ["--", "#7d848c"];
  return (
    `<span class="ltile" style="--lt: ${color}; width:${size}px; height:${size}px;` +
    `font-size:${Math.max(8, Math.round(size * 0.42))}px">${txt}</span>`
  );
}

/**
 * Fallback avatar for a server with no icon set: its first letter. Servers
 * only carry an emoji when the user picks one in Settings.
 */
function initialTile(name) {
  const ch = String(name || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="itile">${ch === "<" || ch === "&" ? "?" : ch}</span>`;
}

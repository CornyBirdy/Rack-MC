# Changelog

Everything notable that has changed in MC Hoster, newest first. The panel is
not versioned — it is deployed by pulling `main` — so entries are grouped by
the day the work landed.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 2026-08-29

### Added

- **Batch select in the file explorer.** Every row carries a checkbox, the
  header row ticks the whole folder, and shift-click extends the selection from
  the last row touched. With anything selected the header turns into a toolbar:
  **Delete**, which confirms against a list of exactly what is about to go, and
  **Move to…**, which opens a folder picker rooted at the server directory.
  The picker hides any folder that is itself part of the selection, since
  dropping a folder inside itself would orphan its subtree, and it won't offer
  to move things into the folder they already sit in. Batches run entry by
  entry on the server, so a locked file no longer takes the other eleven down
  with it — the toast says how far it got and why the rest stayed.
- **Search in the file explorer.** The box in the toolbar filters the open
  folder as you type; Enter widens it to a recursive walk of everything below,
  with each match showing the folder it was found in. Deleting or moving from
  a set of search results re-runs the search rather than dumping you back at
  the top. The walk is capped at 300 matches and 12 levels and says when it
  stopped early — a world folder is tens of thousands of region files, and it
  is not fired on every keystroke for the same reason.
- **Drag and drop into the file explorer.** Files and whole folders can be
  dragged in from the desktop. Drop them anywhere in the file pane to land in
  the folder you have open, or drop them on a folder row to go straight inside
  it — the row highlights and a label names the destination before you let go.
  Directory trees only reach the browser through the drag-and-drop entry API,
  which is drained a hundred children at a time and goes empty the moment the
  drop handler returns, so the tree is walked from handles taken synchronously.
- **Upload folders, not just files.** A second picker beside Upload takes a
  directory and keeps its structure, empty sub-folders included. Both pickers
  and the drop zone share one runner: four uploads in flight, a single progress
  bar for the batch rather than a toast per file, and a count of anything that
  failed at the end. A batch over 50 files or 250 MB says what it is about to
  send and asks first — a dropped world folder is tens of thousands of files.
- **Filter the installed mod list.** The Mods tab had a search box for
  Modrinth but none for what is already installed. There is one now, matching
  on title, filename and version, and the update badges survive it — they are
  held in state rather than written straight into the row, so filtering
  redraws them instead of losing them.

### Changed

- **Retheme.** The panel had drifted into the default dark-SaaS look — violet
  accent, radial gradient blobs behind the page, gradient buttons, glowing
  status dots, capsule badges everywhere and emoji standing in for icons. It
  now reads as an infrastructure console: flat near-neutral graphite surfaces
  with hairline borders, a single desaturated green accent used only for
  chrome, rectangular badges and tags, and no gradient or glow anywhere. The
  status colours (running / warning / failed) are the only saturated things
  left on screen. Every palette value still comes from the tokens in
  `:root`, so a future retheme is one block.
- **A real icon set.** `public/icons.js` draws every panel icon as a 16×16
  stroked SVG on `currentColor` — one grid, one stroke weight, no font and no
  network fetch — replacing the emoji that were doing the job. Loaders keep
  their identity as outlined two-letter tiles in their own colour, since a
  monochrome glyph can't tell Fabric from Quilt.
- **Servers no longer get an emoji assigned to them.** A new server starts with
  no icon and shows its initial; the Settings field is still there if you want
  to give it one.
- **Native controls follow the theme.** `color-scheme: dark` covers selects and
  checkboxes; the memory sliders are painted by hand because Chrome keeps the
  unfilled half of a range track light whatever you tell it.

### Fixed

- Banners no longer break their own sentence. `.banner` was a flex row, so a
  `<span class="mono">` mid-paragraph became its own flex item and the text
  around it split into separate columns. Only banners carrying an action row
  lay out as a row now.

## 2026-08-28

### Added

- **Sleep when empty** (per server, off by default). Drives Minecraft's own
  `pause-when-empty-seconds`: the server parks its tick loop once it has been
  empty for the number of seconds you set, dropping CPU to almost nothing while
  staying up, so rejoining is instant. Needs Minecraft 1.21.2+ — on older
  versions the switch is disabled and the key is never written.
- **Deep sleep** (per server, off by default). After a server sits empty for a
  set number of minutes the panel stops it outright, giving the RAM back. Uses
  the same graceful `stop` as the Stop button, so the world is saved. Works on
  every Minecraft version. The countdown arms when the last player leaves and
  is cancelled the moment anyone joins.
- **Wake on join** (per server, off by default). While a server is stopped the
  panel holds its port with a stand-in listener that speaks enough of the
  Minecraft protocol to answer the server-list ping as "💤 Sleeping" and to
  notice a join attempt, which starts the real server. Any loader, any version.
  It is not a proxy — the port is handed straight back so Java can bind it, so
  nobody can join *during* the boot.
- **Paused** and **Sleeping** are now first-class states. Sidebar dots,
  dashboard pills, the server header and the status tile all distinguish an
  idle server from one you stopped by hand, live over SSE.
- **Editable quick commands.** The buttons beside every console can be added
  to, renamed, reordered and removed, with an optional label per button. The
  list is global, and **Reset to defaults** restores the stock five.
- **Modrinth compatibility filters are now locks.** Loader, Minecraft version
  and server-side are on by default but each can be opened individually to
  widen a search, with anything that no longer fits marked as such.
- **The Properties tab is a real settings UI.** `server.properties` was a bare
  textarea; it is now a form of typed, described fields grouped into Gameplay,
  Players, World, Performance, Resource pack, Network and Advanced — switches
  for the booleans, dropdowns for difficulty, game mode and world type, number
  fields carrying their units and clamped to the range Minecraft accepts, and a
  masked field for the RCON password. Every key keeps its real name beside a
  plain-English line explaining it, a search box filters the lot, and the motd
  has a live preview that renders its `§` colour codes. The file stays the
  source of truth: only keys you actually touch are rewritten, so comments,
  ordering and keys the panel has never heard of survive a save — unrecognised
  keys are listed in their own group rather than hidden. A server that has not
  booted yet shows the vanilla defaults with its own port and slots filled in,
  and saving writes the file early. The old textarea is still there behind a
  **Raw file** toggle.
- **Build badge and in-panel changelog.** A small pill in the bottom-right
  corner shows what this checkout is — the newest changelog heading, plus the
  commit read straight out of `.git` — and clicking it opens this file in a
  modal, rendered. There is no version number to show because the panel is
  deployed by pulling `main`, so the date and the commit are the honest
  answer to "what am I running".
- `worktree.bat`, for giving each parallel session its own checkout.

### Fixed

- The sleep switch and the Properties tab no longer fight over
  `pause-when-empty-seconds`. Editing the value in Properties used to be
  silently reverted the next time the server started; the file is now read back
  and the switch follows it, so the two are views of one value.

## 2026-08-27

### Added

- **Modrinth support** — a content browser for mods, plugins and datapacks with
  one-click installs and dependency resolution, plus whole modpacks as servers.
  Clicking a project row opens its Modrinth page.
- **playit.gg tunnels**, so a server gets a public address without port
  forwarding. Servers can adopt tunnels already on the linked account.
- **Whole-machine resource monitor** — CPU, RAM and disk as a permanent sidebar
  strip and an expanded card with rolling history on the dashboard.
- **Per-player ping** in the player list, read from the server's own `ping`
  command where the loader supports it (Paper, Purpur and friends).
- **Automatic Java provisioning.** The panel reads the Java major version Mojang
  pins for each Minecraft release, matches an installed runtime — including the
  JREs Minecraft launchers ship — and otherwise downloads a Temurin JRE. This
  removed the panel's most common failure, a version mismatch showing up as
  `UnsupportedClassVersionError`.
- Support for the **year-based Minecraft versions** (`26.1`, `26.1.2`) alongside
  the classic `1.x` line, including NeoForge's two ways of encoding them.
- Loaders: vanilla, Paper, Purpur, Fabric, Quilt, Forge and NeoForge.

### Changed

- Re-pinned playit to v0.17.1.
- Dropped `"dir": "."` from `rack.json` so Rack resolves `run.bat` properly.
- Clarified the installer's no-Java error now that runtimes are provisioned
  automatically.

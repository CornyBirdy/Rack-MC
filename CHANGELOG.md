# Changelog

Everything notable that has changed in MC Hoster, newest first. The panel is
not versioned — it is deployed by pulling `main` — so entries are grouped by
the day the work landed.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

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

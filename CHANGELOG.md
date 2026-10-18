# Changelog

Everything notable that has changed in MC Hoster, newest first. The panel is
not versioned — it is deployed by pulling `main` — so entries are grouped by
the day the work landed.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## 2026-10-18

### Added

- **Drag jars onto the Mods tab.** Drop `.jar` files (or `.zip` datapacks on
  a vanilla server) onto the installed list, or use **Add files**, and they go
  straight into `mods/` (`plugins/`, `datapacks/`). Anything else in the drop
  is skipped and named. A dropped jar that's a newer build of a mod already
  installed replaces the old one, since two copies stop the server starting.
- **Jars from Modrinth are recognised.** A jar you downloaded from Modrinth
  yourself and dropped in (on the tab or in Files) used to show as a nameless
  "added by hand" file with no icon and no updates. The panel now looks each
  one up on Modrinth by its SHA-1 — one request for the whole folder — and the
  ones Modrinth knows get their name, icon, version and **Check for updates**
  like anything installed from the panel. Only files Modrinth genuinely
  doesn't know say "not on Modrinth", and those aren't asked about again for
  a day.

## 2026-10-16

### Changed

- **A calmer Stats tab.** The two rows of chart controls are now a range
  picker, a **● Live** pill (click to pause) and one **Charts** menu holding
  which charts to show, layout, smoothing, lag spike markers and the CSV
  download. **Reset zoom** appears beside the time window only while zoomed,
  the separate zoom-out button and each chart's enlarge button are gone
  (**Large** layout covers it), and the lag spike count moved from its own
  tile into the Lag spikes list's header. **Clear** only shows when there is
  something to clear.

### Added

- **Update without stopping your servers.** Each Minecraft server now runs
  under a small host process of its own (`lib/host.js`) instead of being a
  child of the panel, so Rack's ⟳ Update, closing the panel or the panel
  crashing no longer takes the servers down. When the panel comes back it
  reconnects to every server that is still running: the console is as it was,
  anything printed while the panel was away (joins, leaves, chat) is caught up
  into the player log, the player list is checked with `list`, and a player's
  session carries on instead of being split in two. The playit agent is kept
  the same way, so friends on a public address aren't dropped either. A switch
  in **Settings → Updating the panel** turns this off, and **Stop all
  servers** is there for when you do want everything down.
- **Phone support.** Below tablet width the sidebar becomes a drawer behind a
  top bar showing the server you're on and how many players are online; the
  header tiles, tabs, console, file list, modals and Stats charts reflow, and
  nothing depends on hovering. **Settings → On your phone** lists the address
  to open on the same Wi-Fi, and the panel can be added to the home screen as
  an app.
- **More interactive Stats.** New 6-hour and 7-day ranges (the week is kept at
  10-minute resolution). Hovering, or dragging a finger, over any chart shows
  that moment on every chart at once. Drag across a chart to zoom in, then
  reset or double-click to go back. Pick which charts to show, choose
  Grid or Large layout, smooth noisy lines, hide the
  lag spike markers, pause live updates, and download what's on screen as a
  CSV. Each chart shows the min, average and max of the window, and the TPS
  chart how much of it was healthy. The 15-minute and hour charts now survive
  a panel restart too.
- **Disk usage moved to Files**, where it belongs. A **Disk usage** button
  shows what's taking the space in whichever folder is open, as bars you can
  click into, and folders in the list show their size. **Sort: largest first**
  orders the list by size.

### Fixed

- **TPS stopped reporting on a 26.3 Fabric server, saying it needs 1.20.3+.**
  If a command typed into the console failed ("Unknown or incomplete
  command") while the panel was quietly asking the server for its TPS, the
  panel took the error as the answer to its own question, decided the server
  couldn't report TPS, and stopped asking until the next restart. It now
  checks Minecraft's echo of the failed command to see whose it was. And if a
  server really does stop answering, the question is set aside for a few
  minutes and asked again, instead of being given up on for good. The Stats
  tab says when that is happening.

## 2026-10-14

### Added

- **Voice chat.** A per-server **Voice chat** switch in Settings sets up
  [Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat). It is off
  by default and nothing is installed until you turn it on. Turning it on
  installs the mod (Fabric, Quilt, Forge, NeoForge) or plugin (Paper, Purpur)
  from Modrinth for the server's exact Minecraft version, gives the server its
  own UDP port (24454, then 24455 for the next server, and so on) and writes
  that port into `voicechat-server.properties`.
- **Voice chat through playit.gg.** Simple Voice Chat uses its own UDP port,
  which a Minecraft Java tunnel doesn't carry, so voice chat never connected
  for friends joining through playit. While a server's public address is on,
  voice chat now gets a second, UDP-only playit tunnel, and its address is
  written into the mod's `voice_host` setting so players' mods connect to it.
  Turning the public address off pauses the voice tunnel too. If playit won't
  make another tunnel (free accounts only get a few), the Settings tab says
  so.
- **Tunnel counting.** Settings → playit.gg shows how many TCP ports (game
  addresses) and UDP ports (voice chat) the playit account has and how many
  are used. A server's Voice chat section shows the UDP ports left, and
  **Turn on** checks again first: with none left it says so and offers to turn
  voice chat on for your own network only, rather than asking playit for a
  tunnel it can't have. If playit switches a voice tunnel off (over the port
  limit, or because it needs Premium), the reason is shown.
- **Use a tunnel made at playit.gg.** playit now refuses some tunnels the
  panel creates itself (`TunnelTypeRequiresDescription`). The panel sends a
  description with its request, and the Voice chat section has **Use a playit
  tunnel…**: make a tunnel at playit.gg with the **Simple Voice Chat** type,
  pick it, and the panel points it at the server's voice port and writes its
  address into the mod's config. Picking another server's voice tunnel moves
  it.
- Turning voice chat off removes the mod again if the switch installed it,
  and pauses its tunnel. A copy installed by hand or by a modpack stays.
  Deleting a server deletes its voice tunnel too.

## 2026-10-13

### Added

- **World backups.** A new **Backups** tab makes a zip of the world (the level
  folder plus its Nether and End) or of the whole server, with an optional
  note. Backing up a running server is safe and kicks nobody: autosave is
  paused with `save-off`, the world flushed with `save-all flush`, and
  autosave turned back on afterwards. Backups can be downloaded as ordinary
  `.zip` files, deleted, or restored.
- **Restore.** Only with the server stopped. The backup is unpacked into a
  scratch folder and every file CRC-checked before anything is swapped in, so
  a damaged zip leaves the current world alone. By default the world that's
  there now is backed up first, so a restore can be undone. The server can't
  be started — by hand or by wake-on-join — while a backup or restore is
  running.
- **Automatic backups.** Per server: every N hours while it is running,
  keeping the newest N automatic backups. Backups you make yourself are never
  pruned. Backups live in `data/backups/<server>/` and are deleted with the
  server.

### Fixed

- **Choosing a public address.** The playit.gg picker was hard to follow and
  did not always do what it said:
  - Turning an address off didn't tell playit, so the tunnel kept forwarding
    and friends could still join. It's now paused at playit.gg too.
  - A server whose address was switched off kept its tunnel hidden from every
    picker, its own included — so turning it back on, or giving that address
    to a newer server, was impossible. The picker now lists every tunnel on
    the account, grouped as *This server*, *Not in use*, *Other servers* and
    *New*, and taking one from another server (after a confirmation) moves it.
  - **Create a new address** quietly reused the server's old tunnel. It now
    really creates one.
  - New tunnels were named `MC Hoster · <server>`, and playit rejects the dot
    (and emoji, accents) with `InvalidTunnelName`. Names are now plain ASCII,
    such as `MC Hoster - Survival`.
  - The Settings section is now explicit: **Off** with **Turn on** (bringing
    back the previous address) and **Different address…**, or **On** with the
    address, **Change address…** and **Turn off**.

## 2026-10-03

### Added

- **Restart on crash.** A server that crashes is started again 10 seconds
  later, with a countdown and a **Cancel** button on its page. It's on by
  default and can be switched off per server in Settings. After 3 crashes
  within 10 minutes the panel stops trying and leaves it down, so a broken mod
  can't leave it restarting forever.
- **Start with panel.** A per-server switch that starts the server when MC
  Hoster starts, if it was running when the panel last went away. A server
  you stopped yourself stays stopped. Several servers start 20 seconds apart.
- **Restart on poor performance.** A per-server switch: if TPS stays below a
  threshold for a set number of minutes, the server is restarted, with a
  30-second warning in chat if anyone is on. It ignores the first 5 minutes
  after a start and time spent paused, and gives up after 3 restarts in 3
  hours.

### Changed

- Force-killing a server from the panel now leaves it **Stopped** rather than
  **Crashed**, and the player log says it stopped. Closing the panel does the
  same for the servers it shuts down.

## 2026-10-02

### Added

- **A live playit agent console.** Settings → playit.gg → **Agent console**
  (or click the playit chip in the sidebar) shows everything the playit agent
  prints, as it prints it, alongside the panel's own playit messages. Errors
  and warnings are red, **Hide routine output** cuts it down to just those,
  and **Restart agent** gets a stuck agent going again, including one the
  retry loop has given up on. Your agent key is blanked out if it ever shows
  up in the output.

### Changed

- The panel used to throw away the agent's routine output and keep only its
  last 200 error lines. It now keeps the last 1000 lines of everything. The
  terminal window still only prints the panel's messages and agent errors, so
  run.bat doesn't fill up with agent chatter.

## 2026-10-01

### Added

- **A Stats tab: how the server is actually running.** Up to now the panel
  knew a server was up and roughly how much RAM it held; CPU was a hard-coded
  zero. Each server now has a Stats tab with **TPS** (labelled Healthy,
  Struggling or Lagging), **tick time** against the 50 ms budget (with
  P95/P99 or min/max where the server gives them), **CPU** as a share of the
  machine and in cores, **memory** against the heap limit, **loaded
  entities**, **players** with this run's peak, and a count of **lag
  spikes**. Forge and NeoForge also get TPS per dimension.
- **History charts.** One small chart per measure — TPS, tick time, CPU,
  memory, players, entities — over the last 15 minutes, hour (5-second
  points) or 24 hours (one-minute averages). Hover for exact values; lag
  spikes are marked on the TPS chart. The 24-hour history is saved in
  `data/stats/`, so a panel restart doesn't wipe it.
- **A lag log.** Every "Can't keep up!" the server prints is recorded with
  how far behind it fell, listed on the tab and kept across restarts.
- **This run and disk usage.** Start time, boot time, in-game day and Java
  threads, plus a breakdown of what is taking space in the server folder.
- **TPS and CPU in the server header, TPS on dashboard cards.**

### Changed

- **CPU is real now.** Linux reads it from `/proc`; Windows keeps one small
  PowerShell helper running and asks it about every server at once — cheaper
  than the `tasklist` call per server every few seconds it replaces, and the
  only built-in way to get CPU time precisely. If PowerShell won't start the
  panel falls back to `tasklist` for memory.
- **Player ping probes share the new console queue.** Every console question
  the panel asks — ping, TPS, entities — now goes out one at a time, so each
  reply (and each "Unknown command") is paired with the command that caused
  it, and none of them leak into the Console tab.

### Notes

- Nothing to install. TPS comes from commands the server already has: `tps`
  and `mspt` on Paper/Purpur, `forge tps` / `neoforge tps`, and vanilla's
  `tick query` on 1.20.3+ (which covers Fabric and Quilt). Older vanilla,
  Fabric and Quilt servers can't report TPS; the tab says so and still tracks
  CPU, memory, players and lag spikes.
- The panel won't nudge a resting server: nothing is asked while it's paused,
  or while it's empty with *sleep when empty* on, so polling never stops it
  from pausing.

## 2026-09-11

### Added

- **A player log, on a Players tab of its own.** Minecraft narrates every join,
  leave, chat line and death to its console, but that console is a 400-line
  ring buffer that dies with the process — so the panel now keeps its own
  durable copy per server and puts it behind a tab. The **roster** is everyone
  who has ever joined, newest activity first, with total time played, how many
  sessions that took and when they were last seen; anyone online right now has
  their current session ticking up in place. The **activity feed** beside it is
  what happened: joins and leaves carrying the length of the session and why it
  ended, chat, deaths, advancements, the commands players ran, and the server's
  own starts, stops and sleeps for context. Filter it by kind, search it, or
  click any name — in the feed or the roster — to narrow it to that person.
- **A card per player.** Clicking someone in the roster opens their history
  with this server: the totals, then the sessions behind them — joined at, left
  at, how long, and what ended it — plus the last address they connected from
  and their UUID, both learned from the login lines the server prints.
- **Export and clear.** The whole log downloads as CSV for anyone who wants it
  in a spreadsheet, and a single button clears a server's history (the world is
  untouched) and starts tracking again from that moment.

### Notes

- Everything is parsed from what the server prints, so vanilla, Paper, Purpur
  and modded servers all work with nothing installed. Each pattern anchors on
  the console's own line prefix, which is what stops a player typing "joined
  the game" in chat from writing itself into the log as a join.
- Deaths are the one fuzzy case: they are matched against the stems of the
  vanilla English death messages *and* only when the line starts with somebody
  who is actually online, so a translated server may log fewer of them rather
  than log the wrong thing.
- History lives in `data/playerlog/<id>/`, written in batches rather than per
  line, and the last 20,000 events per server are kept. Sessions left open by a
  crash — of the server or of the panel — are closed at the last thing the log
  actually saw, so playtime totals never run on while nothing is running.

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

# MC Hoster 🎮⛏️

A local **game-panel style front end for hosting Minecraft servers** — vanilla and
modded — that looks and feels like a paid host (Pterodactyl / Aternos vibe), but
runs everything on your own machine from a terminal. Built to drop straight into
**Rack** (the local app manager, formerly the Multiapp Controller).

Each Minecraft server you create is a real Java process the panel starts, stops,
and streams the live console for. Zero npm dependencies — just Node.js.

## Modloaders & flavours

| Type | What it is | Runs |
|---|---|---|
| **Vanilla** | Official Mojang server | nothing extra |
| **Paper** / **Purpur** | High-performance Bukkit forks | **plugins** |
| **Fabric** | Lightweight modloader | **mods** |
| **Quilt** | Fabric-compatible modloader | **mods** |
| **Forge** | The classic modloader, biggest modpacks | **mods** |
| **NeoForge** | Modern Forge fork (1.20.1+) | **mods** |
| **Modrinth Modpack** | A curated pack that brings its own loader | **mods** |

Version lists are fetched live from the official sources (Mojang, PaperMC's
`fill` API, Purpur, FabricMC/QuiltMC meta, Forge & NeoForge Maven), so the
newest builds show up automatically. Forge/NeoForge run their `--installServer`
step for you and the panel figures out how to launch the result.

Minecraft's new year-based versioning (`26.1`, `26.1.2`, `26.2`) sits alongside
the classic `1.x` line, and NeoForge encodes it in its own version number two
different ways (`21.1.248` → MC 1.21.1, `26.1.2.99` → MC 26.1.2). The panel
understands both, so every version shows up and sorts newest-first.

## Modrinth built in

The panel talks to [Modrinth](https://modrinth.com) directly, so mods, plugins,
datapacks and whole modpacks install from inside it — no downloading jars by
hand, no hunting for the build that matches your version. Nothing needs an
account or an API key.

### Install a modpack as a server

Pick **Modrinth Modpack** in the create wizard and step 2 becomes a search over
Modrinth's packs instead of the usual version dropdowns. Choose a pack, choose a
version, and the panel:

1. reads the pack's `modrinth.index.json`,
2. installs the modloader the pack pins — Fabric, Quilt, Forge or NeoForge, at
   the exact version it asks for, through the same install path a hand-built
   server uses,
3. downloads every file the pack lists (six at a time, each checked against its
   published SHA-1), **skipping the client-only ones** so the server isn't
   carrying mods that do nothing or crash it,
4. and lays down the pack's `overrides/` and `server-overrides/` configs.

`.mrpack` files are just zips, and `lib/zip.js` reads them with nothing but
`zlib` — no shelling out to `tar` or `Expand-Archive`, and no path-traversal
surprises from a hostile archive.

### Mods / Plugins / Datapacks tab

Every server gets a content tab, and what it offers follows the loader:

| Server | Installs into | Searches for |
|---|---|---|
| Fabric / Quilt / Forge / NeoForge | `mods/` | mods for that loader (Quilt also gets Fabric mods) |
| Paper / Purpur | `plugins/` | Bukkit / Spigot / Paper plugins |
| Vanilla | `world/<level>/datapacks/` | datapacks |
| Modrinth modpack | whatever its real loader uses | ditto |

Searches are scoped to the loader **and** the Minecraft version, so results are
things this server can actually load, and client-only projects are filtered out
by default. **Install** takes the newest compatible build and pulls required
dependencies with it; **⋯** opens the full version list when you need one exact
build.

The panel keeps a small manifest at `data/servers/<id>/.mchoster/modrinth.json`
recording what it installed, which is what makes the tab able to list, update
and remove things later. A modpack's own mods are recorded there too — by name,
not filename — so you can update or drop individual mods out of a pack.
**Check for updates** compares everything in one request (Modrinth answers for a
whole folder of file hashes at once) and offers a one-click update per mod.

Jars can also come from your computer: drag them onto the installed list (or
**Add files**). Anything that lands in `mods/` by hand — dropped on the tab, in
the Files tab, or copied in outside the panel — is looked up on Modrinth by its
SHA-1 when the tab opens, so a jar downloaded from a Modrinth page gets its
name, icon and update checks as if the panel had installed it. Dropping a newer
build of a mod you already have replaces the old jar. Files Modrinth doesn't
know (your own builds, CurseForge-only mods) stay listed as "added by hand".

Content installs while the server is running are fine; the panel reminds you to
restart to apply them.

## Run it

### Under Rack (recommended)
1. Run **`setup.bat`** once (it only checks Node and reports the Java it finds —
   there is nothing to build or install).
2. Rack → **+ Add app** → point it at this `MC_hoster` folder → **Save**.
3. It reads `rack.json` and imports the **Panel** process on port **8100** with
   an **Open panel** link. Press **▶ Run**.

Rack injects `RACK_PORT` / `MC_PORT`; `run.bat` reads them and the panel serves
its dashboard there. The port is declared **fixed** (`"managed": false`) on
purpose: Rack's managed-port path rewrites a process's arguments to
`serve --http=…`, which is PocketBase-shaped and would break a plain Node app.

`multiapp.json` is kept alongside `rack.json` so older controller installs keep
working.

### Updating without stopping your servers

Rack's **⟳ Update** stops the panel (with a hard kill), pulls, and starts it
again. That no longer stops your Minecraft servers. Each server runs under a
small host process of its own (`lib/host.js`), started detached and with no
living parent, so killing the panel's process tree can't reach it. The
host holds the server's console and keeps its recent output on a local
socket (a named pipe on Windows).

When the panel starts again it reconnects to every server that is still running:

- the console comes back as it was,
- whatever the server printed while no panel was listening is read as if it had
  just happened, so joins, leaves and chat still reach the player log,
- the player list is checked against the server's own `list`, and players who
  stayed on keep one continuous session,
- autosave is turned back on if a backup was cut off halfway.

The playit agent is kept the same way, so tunnels stay up and friends who
joined through a public address aren't dropped. Servers that stopped while the
panel was away are reported in their console.

**Settings → Updating the panel** has the switch (on by default) and a **Stop
all servers** button for when you do want everything down; with the switch
off, servers are children of the panel again and stop with it. The first
update *to* this version still restarts servers that were already running,
because they were started the old way.

### On your phone

The panel works on a phone. Below tablet width the sidebar becomes a drawer
behind a top bar. **Settings → On your phone** lists the address to open from
another device on the same Wi-Fi (Windows may ask to let Node.js through the
firewall the first time), and the browser's *Add to Home screen* gives it an
app icon. The panel has no login, so keep it to your home network. For checking
in from elsewhere, use a private network such as Tailscale, not a port forward.

### Standalone
Double-click **`run.bat`** — it starts on <http://localhost:8100> and opens your
browser. That's it. (Under Rack it never opens a browser; Rack provides links.)

## Java is handled for you

Minecraft servers run on Java — Node runs the *panel*, Java runs the *servers* —
and every Minecraft version pins a **specific Java major**:

| Minecraft | Java |
|---|---|
| 1.16 and older | 8 |
| 1.17 | 16 |
| 1.18 – 1.20.4 | 17 |
| 1.20.5 – 1.21.x | 21 |
| 26.x | **25** |

Getting this wrong is what produces `UnsupportedClassVersionError: … class file
version 69.0` before the server prints anything useful. The panel asks Mojang
which major each version wants, then picks the matching runtime — and if the
machine has none, it downloads an **Eclipse Temurin JRE** into
`data/runtimes/` (nothing is installed system-wide).

It auto-detects Adoptium/Temurin, Oracle, Microsoft, Corretto, Zulu, `JAVA_HOME`
and `PATH`, plus the JREs your Minecraft launchers already ship (Modrinth App,
Prism, ATLauncher, CurseForge, the vanilla launcher). The create wizard tells
you which Java a version needs before you build the server, and **Settings** can
fetch any major on demand. You can still override the Java path globally or per
server.

## Play with friends — playit.gg tunnels

Most home networks won't let anyone in: CGNAT, a router you can't touch, or a
port-forward you'd rather not open. MC Hoster can hand a server a **public
address** instead, using [playit.gg](https://playit.gg) — a free relay where an
agent on this machine holds an outbound connection and playit forwards a domain
to your local port.

1. **Settings → Public access · playit.gg → Connect playit.gg.** The panel
   downloads the official agent (pinned to `v0.17.1`, ~5 MB) into
   `data/playit/` and shows a `playit.gg/claim/…` link.
2. Open the link, sign in (a free account is enough) and approve the agent. The
   panel notices, stores the key in `data/playit/playit.toml`, and brings the
   agent online.
3. On any server, **Settings → Public address → toggle it on.** Pick one of your
   existing tunnels — it keeps its address and moves to this panel — or let it
   make a fresh Minecraft tunnel.

The address (something like `crispy-fox.gl.at.ply.gg`) then shows up on the
server's card, its header, and in Settings — click it to copy. Minecraft Java
tunnels come with an SRV record, so friends type the bare domain, no port.

Details worth knowing:

- **One agent, many tunnels.** A single agent process serves every tunnel
  assigned to it. Routing lives on the tunnels themselves — the panel sets each
  one's local address through playit's API (the same call their website's
  "transfer tunnel" screen makes) — so its port settings always win and nothing
  restarts when you change a port or add a server.
- The agent stays connected while **the panel** runs, not while a server runs;
  starting and stopping Minecraft servers never disturbs the tunnels. Staying
  connected is also what makes playit.gg show a real agent version, which its
  tunnel-transfer screen refuses to work without.
- **Version matters.** playit's control server rejects old agents (`Agent
  version is unknown … no longer supported`). `v0.17.1` is the newest release
  that is still a single self-contained executable; 1.x splits into a daemon, a
  service and a tray app, which a portable panel has no business installing.
  Bumping the pin re-downloads the agent and deletes the superseded one.
- **Agent console.** Settings → playit.gg → **Agent console**, or click the
  playit chip in the sidebar, shows the agent's output live. Errors and
  warnings are red, and it has a **Restart agent** button. Your agent key is
  blanked out if the agent ever prints it.
- Deleting a server removes its tunnel from your playit account too. Unlinking
  only forgets the key here — tunnels stay on the account.
- Nothing is installed system-wide: no service, no tray app, no daemon. The
  agent binary and the key live in `data/playit/`, which is git-ignored.
- playit publishes agent binaries for Windows and Linux only, so the feature
  hides itself on macOS.

## Voice chat

Each server has a **Voice chat** switch in **Settings**, built on
[Simple Voice Chat](https://modrinth.com/plugin/simple-voice-chat). It is
**off by default**, and the mod isn't installed until you turn it on.

Simple Voice Chat doesn't use the game connection. It opens its own **UDP
port**, and every player's mod connects to that port separately. That's why it
needs some setup:

1. **Install.** Turning the switch on installs Simple Voice Chat from Modrinth
   into `mods/` (Fabric, Quilt, Forge, NeoForge) or `plugins/` (Paper,
   Purpur), using a build for the server's exact Minecraft version, along
   with anything it requires (Fabric API, for example). If it's already
   there, it is configured instead. Vanilla can't load mods, so the switch is
   unavailable on vanilla servers.
2. **A port of its own.** Two servers on one machine can't share a voice
   port, so each gets the first free one from **24454** (24454, 24455, …).
   It's written as `port` in `config/voicechat/voicechat-server.properties`
   (`plugins/voicechat/` on Paper and Purpur).
3. **A playit.gg tunnel.** A Minecraft Java tunnel only carries TCP, so voice
   traffic never reaches the server through it. While the server's
   **public address** is on, voice chat gets a second, **UDP** playit tunnel
   pointed at its port. Its address (like `abc.ply.gg:41234`) is written as
   `voice_host`, which is what the server tells players' mods to connect to.
   Players never type it.

The voice tunnel follows the public address: with the address off, voice chat
works for players on your network only, and its tunnel is paused.

### If playit won't make the tunnel

playit doesn't let apps create every kind of tunnel (it can answer
`TunnelTypeRequiresDescription`). When that happens, make the tunnel yourself
and let the panel set it up:

1. At **playit.gg → Tunnels**, press **Add tunnel** and choose the **Simple
   Voice Chat** type (plain UDP works too). The local port doesn't matter.
2. In the server's **Voice chat** section, press **Use a playit tunnel…**,
   then **Refresh**, and pick it.

The panel points the tunnel at the server's voice port, hands it to its agent
and writes the address into `voice_host`, exactly as with a tunnel it made.

### Counting tunnels

playit limits how many **ports** an account can have, and counts TCP and UDP
separately. Each tunnel the panel makes is one port: a game address uses a
**TCP** port, voice chat a **UDP** port. So voice chat doesn't eat into the
ports your game addresses need, but each server with voice chat on takes one
UDP port.

- **Settings → Public access · playit.gg** shows both pools, such as
  *TCP ports 2 of 4 used* and *UDP ports 4 of 4 used · full*, read from your
  playit account.
- A server's **Voice chat** section says how many UDP ports are left before
  you turn it on, and warns when there are none.
- **Turn on** checks with playit again first. If the account is full, it
  explains and offers **Turn on for my network only** instead of asking
  playit for a tunnel it can't have.
- If playit makes the tunnel but then switches it off (over the port limit, or
  because plain UDP tunnels need Premium on the account), the Voice chat
  section shows why, with **Try again**.

Players need Simple Voice Chat installed in their own game too, and press
**V** in game to open its settings. The mod reads its config only at startup,
so restart the server after turning voice chat on, or when its address changes
(the console says when that happens). Turning voice chat off removes the mod
if the switch installed it. A copy you installed by hand or that came with a
modpack stays.

## Using the panel

- **Create Server** — pick a loader, a Minecraft version, (a loader build for
  modded), then name / port / RAM. Or pick **Modrinth Modpack** and search
  Modrinth instead. The panel downloads & installs, streaming progress into the
  console.
- **Accept the EULA** — one click, required by Mojang before first start.
- **Console** — live output, a command box (with ↑/↓ history), quick commands,
  and a live player list.
- **Stats** — how the server is actually running: TPS, tick time, CPU,
  memory, loaded entities and lag spikes, with interactive history charts.
  See below.
- **Players** — the log of who has been on: sessions with times and durations,
  chat, deaths, advancements and commands. See below.
- **Quick commands** — the buttons beside the console are yours to change. Hit
  **✎ Edit** on that box to add, rename, reorder or remove them; a label is
  optional (blank shows the command itself). The list is global — every server
  gets the same buttons — and **Reset to defaults** puts the stock five back.
- **Mods / Plugins / Datapacks** — search Modrinth and install into this server
  in one click, with dependencies; list, update and remove what's there.
- **Files** — browse the server folder, upload `.jar` mods/plugins, edit
  text configs, make folders. Mods go in `mods/`, plugins in `plugins/`.
  **Disk usage** shows what's taking the space in the open folder (click a
  bar to go into it), folders show their size, and the list can be sorted
  largest first.
- **Properties** — edit `server.properties` directly.
- **Settings** — rename, change RAM/port/max-players, custom JVM args (Aikar's
  flags), Java override, the **public address** switch, **voice chat**, the
  two **sleep** switches, the three **auto-restart** switches, **scheduled
  uptime**, or delete the server.

## Server stats

Every server gets a **Stats** tab, and its header shows **TPS** and **CPU**
next to memory and players. The dashboard cards show TPS too, coloured by how
the server is coping.

- **TPS** — ticks per second. 20 is a server keeping up; below ~18 players
  feel it. Labelled *Healthy*, *Struggling* or *Lagging*.
- **Tick time (MSPT)** — milliseconds of work per tick, against the 50 ms
  budget a tick gets at 20 TPS, with P95/P99 (vanilla) or min/max (Paper).
- **CPU** — share of the whole machine the server's Java process is using,
  and how many cores' worth that is.
- **Memory** — what the process actually holds, against its heap limit.
- **Loaded entities** — mobs, items and the rest in loaded chunks, all
  dimensions. Thousands of dropped items is the classic cause of lag.
- **Lag spikes** — every "Can't keep up! … 3120ms behind" the server prints,
  timestamped, listed with a count for this run, and marked on the TPS chart.
- **This run** — start time, boot time, in-game day, Java threads.

Charts cover the last **15 minutes** or **hour** at 5-second resolution, the
last **6** or **24 hours** at one point a minute, or the last **7 days** at one
point every 10 minutes (averages, with the worst TPS of each in the tooltip and
as a faint amber tick under the line). All of it, and the lag log, is kept in
`data/stats/` so it survives a panel restart.

The charts are interactive:

- **Read across.** Hover over any chart, or drag a finger across it on a
  phone, and every chart shows its value at that moment.
- **Zoom.** Drag across a chart to zoom into that stretch; **Reset zoom**
  (beside the time window) or a double-click goes back.
- **Pause** by clicking the **● Live** pill, to look at something without it
  scrolling away. Readings keep being collected.
- **Charts** menu — tick which charts to show, pick **Grid** or **Large**
  layout, smooth noisy lines (**Light** / **Heavy**), hide the lag spike
  markers, or download what the charts show as a **CSV**. These are remembered
  in your browser.

Under each chart are the min, average and max for the window. The TPS chart
also shows how much of the window was healthy.

### Where the numbers come from

No plugins or mods are needed. CPU and memory are read from the process
(`/proc` on Linux; on Windows one small PowerShell helper stays running and is
asked about every server at once, falling back to `tasklist` for memory if
PowerShell is unavailable). Everything else is asked of the server's own
console, quietly — the replies never show up in the Console tab:

| Server | TPS / tick time from |
|---|---|
| Paper / Purpur | `tps` and `mspt` |
| Forge | `forge tps` (plus per-dimension TPS) |
| NeoForge | `neoforge tps` (`forge tps` on 1.20.1) |
| Vanilla / Fabric / Quilt, 1.20.3+ | `tick query` |
| Vanilla / Fabric / Quilt, older | not available — CPU, memory and lag spikes still work |

Entity counts come from `execute if entity @e` (1.13+), the in-game day from
`time query day`. When a server answers one of these with "Unknown command",
the panel checks Minecraft's echo of the failed command (`tick query<--[HERE]`)
to be sure it was the panel's question and not something you typed. A question
a server refuses or keeps ignoring is set aside, then asked again after 5
minutes, doubling up to an hour. The Stats tab says when TPS is being retried. The questions are only asked while the server is running
and awake: a paused server is left alone, and so is an empty one with
*sleep when empty* on, so the polling never keeps it from pausing. With nobody
online they are asked a third as often, to keep `latest.log` quiet.

## The player log

Every server gets a **Players** tab: a permanent record of who has been on it,
kept by the panel rather than by the console, so it survives restarts of the
server *and* of the panel.

- **Roster** — everyone who has ever joined, newest activity first, with total
  time played, how many sessions that took, and when they were last seen.
  Anyone online right now shows their current session ticking up.
- **Activity** — the feed: joins and leaves (with how long the session lasted
  and why it ended), chat, deaths, advancements and the commands players ran,
  plus the server's own starts, stops and sleeps for context. Filter it by kind
  with the chips, search it, or click any name to see just that person.
- **Player card** — click someone in the roster for their totals and the
  sessions behind them: joined at, left at, how long, and what ended it. Their
  last known address and UUID are there too.
- **CSV** — the whole log downloads as a spreadsheet. **🗑** clears the history
  for that server (the world is untouched) and starts again from now.

It all comes from what the server prints, so it works on vanilla, Paper,
Purpur and modded alike with nothing to install. Deaths are the one fuzzy
case — they are matched against the vanilla English death messages, so a
server running a translation may log fewer of them. The last 20,000 events per
server are kept; older ones roll off.

## Letting idle servers rest

Two independent switches, both off by default, for a server nobody is on.

| | Sleep when empty | Deep sleep |
|---|---|---|
| What happens | Minecraft parks its tick loop | the panel stops the server |
| CPU | ~0% | none — the process is gone |
| **RAM** | **still reserved** | given back |
| Getting back in | instant | a full boot |
| Needs | Minecraft 1.21.2+ | any version |

Run both and they ladder: the server pauses after seconds, then shuts down
after minutes. The dashboard, the sidebar dots and the server page all show
**Paused** and **Sleeping** as states of their own, so an idle server never
looks the same as one you stopped by hand.

A third switch, **wake on join**, closes the loop: while the server is stopped
the panel holds its port itself, so the server still shows up in the Minecraft
server list — as "💤 Sleeping" — and trying to join starts it.

### Sleep when empty

Off by default. Turn it on and the server pauses its tick loop once it has been
empty for the number of seconds you set — CPU falls to almost nothing while the
process stays up, so rejoining is instant and the RAM stays reserved.

This drives Minecraft's own `pause-when-empty-seconds`, so it needs **1.21.2 or
newer**; on older versions the switch is disabled and the key is never written.
Leaving it off writes `-1` rather than nothing, so a server never silently
inherits Minecraft's built-in 60-second default.

Nothing ticks while paused — crops, furnaces, redstone, mob spawning and the
daylight cycle all stop, **including in spawn chunks and force-loaded chunks**.
Those are the only chunks that ran with nobody online in the first place, so if
you keep an offline farm there, leave this off.

### Deep sleep

Set a number of minutes and the panel stops the server itself once it has been
empty that long, freeing the RAM. It saves the world on the way out — this is
the same graceful `stop` the Stop button sends, not a kill.

The countdown is armed when the last player leaves and cancelled the moment
someone joins, so a busy evening never trips it. A server that put itself to
sleep is badged **Sleeping** rather than **Offline**; one you stopped yourself
still reads **Offline**.

### Wake on join

With this on, a stopped server is not really gone: the panel parks a stand-in
listener on its port that speaks just enough of the Minecraft protocol to be
useful. In the server list it answers the ping as **💤 Sleeping**, and a join
attempt boots the real server, disconnecting the player with a note to
reconnect in a moment. Any server, any version — this is the panel's own doing,
not Minecraft's.

It is **not a proxy**. Once someone knocks the port goes straight back so Java
can bind it, which means nobody can join *during* the boot — the player who
woke it waits out the startup like everyone else, and a big modpack is still a
couple of minutes. Holding those connections open across a boot would mean
proxying every packet, which is a different and much larger job.

The port is only held while the server is stopped, and it is handed back before
launch, when you switch the toggle off, when the server is deleted, and when
the panel shuts down. If something else already has the port, the console says
so once and the listener stays out of the way.

Pair it with deep sleep and an idle server costs nothing but still looks online
to anyone who opens their server list.

## Keeping a server up on its own

Three switches in **Settings** for a server nobody is babysitting, such as one
on an always-on PC.

- **Restart on crash** (on by default): 10 seconds after a crash the panel
  starts the server again. The server page shows the countdown with a
  **Cancel** button. If it crashes 3 times within 10 minutes it stays down, so
  a broken mod or a corrupt chunk can't leave it restarting forever. Press
  Start once you've fixed it. Stopping it yourself, including a force kill,
  never counts as a crash.
- **Start with panel** (off by default): when MC Hoster starts, it starts
  every server with this on that was running when the panel last went away.
  A server you stopped yourself (or that went into deep sleep) stays stopped.
  They start 20 seconds apart so a small machine isn't swamped. To get this
  after a PC reboot, MC Hoster itself has to start on boot too, for example
  with autostart switched on in Rack.
- **Restart on poor performance** (off by default): if TPS stays below a
  threshold (say 12) for a number of minutes (say 10), the panel restarts the
  server. If players are online they get a 30-second warning in chat first,
  and the banner on the server page has a **Cancel** button. The first 5
  minutes after a start don't count, and neither does time spent paused. A
  reading that goes missing in the middle of a low streak keeps the streak
  going, since a badly lagging server can be too slow to answer. After 3
  performance restarts in 3 hours it stops trying and leaves the server
  running, because restarts aren't what that server needs. This needs a server
  that reports TPS: Minecraft 1.20.3 or newer, or Paper, Purpur, Forge or
  NeoForge on any version.

## Scheduled uptime

**Settings → Scheduled uptime** gives a server opening hours, for one that only
needs to be up when people actually play (evenings and weekends, say) so the
machine gets its RAM and CPU back the rest of the time.

- **Windows.** Each window is a set of weekdays plus a from/to time. Add as many
  as you need, or start from a quick fill (*Evenings & weekends*, *Weekends
  only*, *Every day*). A window whose end is before its start runs past
  midnight, so *Fri 20:00 to 02:00* is Friday night; equal times mean the whole
  day. Windows that meet are joined, so the server isn't stopped and started
  again at midnight between two of them.
- **The panel acts at the edges.** When a window opens it starts the server;
  when it closes it stops it. In between, **Start** and **Stop** work as normal:
  stopping it mid-evening, or starting it at 3 am for a friend, sticks until
  the next opening or closing time.
- **Players still on at closing time** are either warned in chat and given a
  few minutes (reminders at one minute and ten seconds), or the server waits
  until the last one leaves. A banner on the server page shows it, with **Keep
  it running** to call it off. If everyone leaves early it stops straight away.
- **Saving a new schedule applies it now**: a stopped server inside its new
  hours starts, a running one outside them gets its closing time. Saving the
  same hours again changes nothing.
- **The panel being closed doesn't lose an edge.** The panel remembers which
  side of the schedule it last acted on, so a window that opened or closed
  while it was down is acted on when it comes back. *Start with panel* leaves
  a scheduled server alone outside its hours.

Times are on the panel computer's clock. If the device you're using is in a
different time zone, the settings say so. Wake on join still works outside the
hours, so a sleeping server can be woken by someone knocking.

## System monitor

The sidebar carries a permanent CPU / RAM / disk strip — a bar plus a number
for each, so the health of the whole machine is visible from any screen. The
dashboard expands the same three meters into a card with a rolling ~3-minute
CPU + RAM sparkline, a per-thread load strip, and a line comparing the RAM
you've handed to running servers against what the box actually has (it warns
once you're past 80% — over-committing is what turns a full modpack into a
swap-thrash).

Bars turn amber past 75% and red past 90%. Sampling is `lib/sysmon.js`: pure
Node built-ins on a 2-second timer — `os.cpus()` tick deltas, `os.freemem()`,
and `fs.statfs()` on the data drive every ~30s. No `wmic`, no PowerShell, no
child processes, so watching the meters costs a running server nothing. Samples
ride the SSE stream the panel already keeps open; there is no polling.

## Where things live

```
MC_hoster/
├─ server.js            HTTP API + SSE + static host
├─ lib/
│  ├─ net.js            zero-dep HTTP client + downloader
│  ├─ java.js           Java discovery, version matching, JRE downloads
│  ├─ loaders.js        per-loader version lists + install logic
│  ├─ modrinth.js       Modrinth search/install, content manifest, .mrpack packs
│  ├─ zip.js            read-only zip reader (zlib only) for .mrpack files
│  ├─ playit.js         playit.gg agent, account link, per-server tunnels
│  ├─ voicechat.js      Simple Voice Chat switch: install, voice port, config
│  ├─ manager.js        server lifecycle, console, players
│  ├─ host.js           keeper process that holds one server across panel restarts
│  ├─ hosted.js         the panel's side of host.js: launch, reconnect, talk
│  ├─ uptime.js         scheduled uptime: opening-hours windows and their edges
│  ├─ perf.js           per-server TPS / CPU / memory / lag stats + history
│  ├─ playerlog.js      durable per-server player history (sessions, chat…)
│  ├─ sysmon.js         host CPU / RAM / disk sampling for the meters
│  └─ store.js          persistence
├─ public/              the panel UI (index.html / style.css / app.js)
├─ data/                created at runtime — git-ignored, never travels
│  ├─ servers/<id>/     each server's folder (world, jars, mods, configs)
│  │  └─ .mchoster/     what the panel installed from Modrinth, for this server
│  ├─ playerlog/<id>/   that server's player history (events + roster)
│  ├─ stats/<id>.json   that server's stats history (1 h / 24 h / 7 d) + lag spikes
│  ├─ run/              live server hosts: state, last exit, host logs
│  ├─ runtimes/         Java runtimes the panel downloaded for you
│  └─ playit/           playit agent binary + your agent key
├─ rack.json            Rack manifest
├─ multiapp.json        legacy controller manifest
├─ setup.bat            one-time check, run by hand
└─ run.bat              launcher (reads RACK_PORT / MC_PORT)
```

Everything a server owns lives under `data/servers/<id>/`, so deleting a server
in the UI removes just that folder.

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
Anything you dropped into `mods/` by hand still shows up, labelled as such.

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
- Deleting a server removes its tunnel from your playit account too. Unlinking
  only forgets the key here — tunnels stay on the account.
- Nothing is installed system-wide: no service, no tray app, no daemon. The
  agent binary and the key live in `data/playit/`, which is git-ignored.
- playit publishes agent binaries for Windows and Linux only, so the feature
  hides itself on macOS.

## Using the panel

- **Create Server** — pick a loader, a Minecraft version, (a loader build for
  modded), then name / port / RAM. Or pick **Modrinth Modpack** and search
  Modrinth instead. The panel downloads & installs, streaming progress into the
  console.
- **Accept the EULA** — one click, required by Mojang before first start.
- **Console** — live output, a command box (with ↑/↓ history), quick commands,
  and a live player list.
- **Mods / Plugins / Datapacks** — search Modrinth and install into this server
  in one click, with dependencies; list, update and remove what's there.
- **Files** — browse the server folder, upload `.jar` mods/plugins, edit
  text configs, make folders. Mods go in `mods/`, plugins in `plugins/`.
- **Properties** — edit `server.properties` directly.
- **Settings** — rename, change RAM/port/max-players, custom JVM args (Aikar's
  flags), Java override, the **public address** switch, the two **sleep**
  switches, or delete the server.

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
│  ├─ manager.js        server lifecycle, console, players, stats
│  ├─ sysmon.js         host CPU / RAM / disk sampling for the meters
│  └─ store.js          persistence
├─ public/              the panel UI (index.html / style.css / app.js)
├─ data/                created at runtime — git-ignored, never travels
│  ├─ servers/<id>/     each server's folder (world, jars, mods, configs)
│  │  └─ .mchoster/     what the panel installed from Modrinth, for this server
│  ├─ runtimes/         Java runtimes the panel downloaded for you
│  └─ playit/           playit agent binary + your agent key
├─ rack.json            Rack manifest
├─ multiapp.json        legacy controller manifest
├─ setup.bat            one-time check, run by hand
└─ run.bat              launcher (reads RACK_PORT / MC_PORT)
```

Everything a server owns lives under `data/servers/<id>/`, so deleting a server
in the UI removes just that folder.

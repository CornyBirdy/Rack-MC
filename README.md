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

Version lists are fetched live from the official sources (Mojang, PaperMC's
`fill` API, Purpur, FabricMC/QuiltMC meta, Forge & NeoForge Maven), so the
newest builds show up automatically. Forge/NeoForge run their `--installServer`
step for you and the panel figures out how to launch the result.

Minecraft's new year-based versioning (`26.1`, `26.1.2`, `26.2`) sits alongside
the classic `1.x` line, and NeoForge encodes it in its own version number two
different ways (`21.1.248` → MC 1.21.1, `26.1.2.99` → MC 26.1.2). The panel
understands both, so every version shows up and sorts newest-first.

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
  modded), then name / port / RAM. The panel downloads & installs, streaming
  progress into the console.
- **Accept the EULA** — one click, required by Mojang before first start.
- **Console** — live output, a command box (with ↑/↓ history), quick commands,
  and a live player list.
- **Files & Mods** — browse the server folder, upload `.jar` mods/plugins, edit
  text configs, make folders. Mods go in `mods/`, plugins in `plugins/`.
- **Properties** — edit `server.properties` directly.
- **Settings** — rename, change RAM/port/max-players, custom JVM args (Aikar's
  flags), Java override, the **public address** switch, or delete the server.

## Where things live

```
MC_hoster/
├─ server.js            HTTP API + SSE + static host
├─ lib/
│  ├─ net.js            zero-dep HTTP client + downloader
│  ├─ java.js           Java discovery, version matching, JRE downloads
│  ├─ loaders.js        per-loader version lists + install logic
│  ├─ playit.js         playit.gg agent, account link, per-server tunnels
│  ├─ manager.js        server lifecycle, console, players, stats
│  └─ store.js          persistence
├─ public/              the panel UI (index.html / style.css / app.js)
├─ data/                created at runtime — git-ignored, never travels
│  ├─ servers/<id>/     each server's folder (world, jars, mods, configs)
│  ├─ runtimes/         Java runtimes the panel downloaded for you
│  └─ playit/           playit agent binary + your agent key
├─ rack.json            Rack manifest
├─ multiapp.json        legacy controller manifest
├─ setup.bat            one-time check, run by hand
└─ run.bat              launcher (reads RACK_PORT / MC_PORT)
```

Everything a server owns lives under `data/servers/<id>/`, so deleting a server
in the UI removes just that folder.

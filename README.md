# Quotum

**English** · [Русский](README.ru.md)

[![Release](https://img.shields.io/github/v/release/padurets/quotum)](https://github.com/padurets/quotum/releases/latest)
[![npm](https://img.shields.io/npm/v/quotum)](https://www.npmjs.com/package/quotum)
[![CI](https://github.com/padurets/quotum/actions/workflows/ci.yml/badge.svg)](https://github.com/padurets/quotum/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/padurets/quotum)](LICENSE)

Quotum shows how much of your coding-agent subscriptions is left — Claude Code, Codex
and Antigravity — on every machine you work on, in one place: for you alone or for a
whole team. You host it yourself, and it never touches your provider tokens.

![The Quotum dashboard](docs/dashboard.png)

**Quick start**

```sh
# The hub; `docker logs quotum` shows the setup code of the first account
docker run -d --name quotum -p 8080:8080 -v quotum:/data ghcr.io/padurets/quotum-hub

# On every machine: confirm the code in the browser, then keep measuring in the background
npx quotum connect http://<the hub>:8080
npx quotum start
```

`npx quotum` alone prints this machine's limits without any hub. More in
[Getting started](#getting-started).

## Why I made it

I pay for several coding agents at once, and each has its own limits: a five-hour
window, a weekly one, sometimes a separate weekly window for a particular model. To know
where I stood I had to open each tool, type `/usage` and do the maths in my head: at
this pace, will the weekly limit last until the weekend? On top of that I don't work on
one machine. There is a laptop, a few remote dev environments and some containers, and
the same subscriptions are signed in on several of them.

I wanted one page that answers the questions I actually have:

- how much is left in each window, and when does it reset;
- am I spending faster than I planned for this week;
- what did the last few days look like.

I looked around first. What I found either lives on a single machine (the dashboard
started out reading from [CodexBar](https://github.com/steipete/CodexBar), a nice macOS
menu-bar app), or wants your provider tokens or browser cookies so it can call the
providers' APIs for you. The first didn't match how I work, and I didn't want to do the
second. So I wrote Quotum.

## How it works

There are two parts:

- **The agent** is a small native program (Rust, a single binary of about 3 MB). It
  runs on each machine where you use coding agents and asks their own command-line
  clients for the limits, the same numbers you see when you type `/usage`. It doesn't
  read tokens, make model requests or call provider APIs itself: the client does
  exactly what it does when you use it.
- **The hub** is a small web service (Node.js and SQLite) with the dashboard. Agents
  send it what they measured; it keeps the history and draws it.

```
 laptop ──┐
 dev VM ──┼── quotum agent ── HTTPS ──►  hub  ──►  dashboard
 box    ──┘   claude · codex · agy       SQLite
```

If one subscription is signed in on several machines, they don't all measure it. The hub
puts one machine on duty per subscription (preferably the one you're working on), the
others wait, and duty moves on when that machine goes quiet.

The agent also works on its own: `npx quotum` prints the limits of this machine and the
coding agents running on it, working or idle.

```
$ npx quotum
                                   left  resets
Codex pro     weekly                 4%  in 3d 16h
              free resets            1   expires in 29d 23h
Claude max    5 hours               98%  in 4h 27m
              weekly                89%  in 5d 9h
              Fable weekly         100%  in 5d 9h
Antigravity   Gemini 5 hours       100%  in 4h 59m
              Gemini weekly         96%  in 1d 3h

running here: 3 · 2 working
Claude        quotum               working  started 3h 39m ago
Claude        quotum · quotum.feat-18 working  started 52m ago
Codex         api                  idle     started 25m ago · editor
```

## What the dashboard shows

- **A card per subscription**, one meter per window: green above 30%, amber at 30% and
  below, red under 10%. A tick on the meter shows where your spending plan expects you
  to be right now. The dot on the provider's logo says whether the numbers are fresh.
- **Which agents run on it, and which of them work.** Under the limits, a mark per
  Claude Code, Codex or Antigravity session spending the subscription, grouped by
  machine: filled while it works, outlined while idle; its project, its folder (a
  worktree, a folder inside the repository) and how long it runs in the tooltip. Terminals, editors and the Codex app alike.
- **Free resets.** When a provider grants resets of the limits (Codex does now and
  then), the card shows how many you have and until when.
- **A weekly spending plan.** By default you spend 30 / 25 / 15 / 15 / 10 / 5% on the
  six days after the reset and nothing on the seventh. Each subscription can have its
  own plan: a day at 0 is a day you don't spend, and it can be any day of the week.
- **A chart of the weekly or the 5-hour windows** over the last hour up to the last 30
  days. Ahead of now it draws the plan, where each window is going at its pace and the
  next resets, as far as you choose; behind, it marks when limits came back early and
  when free resets were granted. Drag across it to zoom into a burst of work (on a
  phone, hold a finger on it first); ‹ and ›, or a swipe sideways, move it back and
  forth through time by half its length.
- **A table with a forecast:** what the period spent and, at each window's pace since
  it started, whether it runs out before its reset (or before your plan ends, following
  the plan's shape) and when, or roughly how much will be left. The forecast is the
  same whatever period you look at. Over a range dragged on the chart it shows what
  that range cost: what was left at its start and end, what it spent and how fast.
- **Reset announcements** from the community trackers [Codex Resets](https://codex-resets.com)
  and [Claude Resets](https://claude-resets.com), with a link to the source. You
  can turn them off.
- **Boards made of widgets** (a card per subscription, the chart, the table, and a
  list of every running agent to turn on), like a dashboard in Grafana: the cards show
  what is left now, the chart and the table under them share one set of filters. The owner of a board drags them around, makes them wider or
  narrower, names the cards, hides the ones they don't need (the data keeps coming) and
  sets the plans; everyone on the board sees it arranged the same way. Once it's set,
  a lock keeps the widgets from moving under a passing pointer.
- **Your data, shared when you choose.** Everything your machines measure is on your
  personal board. On a shared board a team sees the limits its members share with it:
  each person decides which of their subscriptions it shows. A team subscription
  measured by several people is one card.

The interface is available in English and Russian.

## What I paid attention to

It's a pet project, but I wanted a tool I'd be comfortable running on every machine all
day, not a script thrown together over a weekend. In practice that meant:

- **It stays out of the way.** The agent idles at about 5 MB of memory. The expensive
  part is starting an agent's client (around a second of CPU and 100–230 MB of memory
  for that second), so Quotum starts as few of them as it can. They run one at a time,
  and only one machine measures each subscription, as often as the hub says, since it
  sees the subscription on every machine: every two minutes while it is in use anywhere
  or its numbers change; when little is left, every minute while it is active, every two
  and then every five as it stays quiet for hours; and less often while nothing happens,
  down to once every 15 minutes. The machine on duty asks the hub every 15 seconds, which
  starts nothing.
- **Your credentials stay where they are.** Quotum never reads, stores or sends provider
  tokens or cookies. What leaves the machine: percentages and reset times, plan names,
  a one-way hash of each account id (so the hub can tell two machines share one
  account), the machine's name and random id, the short message of a client that
  failed, and which coding agents run on the machine: working or idle, since when, and
  the names of their project (the git repository their folder is in, else the folder)
  and folder (`sessions = false` and `projects = false` turn that off). With each
  question to the hub, whether its client is in use on the machine: a card tells the
  members of its boards that the subscription is in use right now, whatever those
  settings say. A board shows
  them, with the name of the machine they run on, to its members only where the person
  whose agents they are shows that subscription, each project under the name that person
  gave it. The hub keeps when each agent worked,
  with its machine, project and folder names, for 90 days, and the names you give your
  projects until you undo them; you see and correct your projects in *My machines*. The full list is in the [spec](spec/ingest-v1.md#privacy).
- **The numbers mean what they say.** Only a real increase inside one reset window
  counts as spending. Resets, corrections and gaps in the data never show up as
  consumption. The agent says when its next measurement is due, so a sparse series isn't
  mistaken for a gap.
- **Few moving parts.** The agent has nine direct dependencies. The hub is Fastify and
  the SQLite built into Node, and the UI is plain React with about 100 KB of gzipped
  JavaScript. There is no telemetry; the only requests the hub makes on its own are to
  the two reset trackers (or the mirror you name), every ten minutes, and
  `QUOTUM_RESETS=off` turns them off.
- **Written down and tested.** The protocol between the agent and the hub is a spec
  ([spec/ingest-v1.md](spec/ingest-v1.md)). About 180 tests cover the spending rules,
  resets, duty, scheduling, permissions, sharing, device pairing, the clients' answers and the
  translations. The TypeScript is strict and the Rust passes `clippy`.

## Status

It works: I use it every day. The agent installs with one command, or runs through npm
as `quotum`, with prebuilt binaries for Linux (x64 and arm64, any distribution), macOS
and Windows; the hub is a Docker image (`ghcr.io/padurets/quotum-hub`, amd64 and arm64).
A [desktop app](#desktop-app) for Windows and Linux is built and tested by CI but not
released yet; autostart of the agent is next ([roadmap](#roadmap)).

- Clients: Claude Code, Codex CLI, Antigravity CLI (`agy` 1.1.11 or newer).
- Platforms: I run it on Linux. The macOS and Windows binaries are cross-compiled and
  haven't had much use yet — issues are welcome.

## Getting started

**1. Start the hub.**

```sh
docker run -d --name quotum --restart unless-stopped -p 8080:8080 -v quotum:/data ghcr.io/padurets/quotum-hub
docker logs quotum            # shows the setup code for the first account
```

Open `http://<this machine>:8080` and create the first account with that code: until a
hub has an account, only whoever can read its log can claim it. Nothing else needs
setting up. For HTTPS on a domain of your own, [deploy/compose.yaml](deploy/compose.yaml)
runs the hub behind Caddy, which gets the certificate by itself:
`QUOTUM_DOMAIN=quotum.example.com docker compose up -d`.

Without Docker: clone the repository, then `cd hub && npm ci && npm run build && npm start` (Node.js 24 or newer),
which listens on `127.0.0.1:8080` and prints the setup code to the terminal.

**2. Install the agent and look at this machine's limits.**

```sh
curl -fsSL https://github.com/padurets/quotum/releases/latest/download/install.sh | sh    # Linux, macOS
irm https://github.com/padurets/quotum/releases/latest/download/install.ps1 | iex         # Windows (PowerShell)
quotum
```

The installer puts `quotum` in `~/.local/bin` (on Windows in
`%LOCALAPPDATA%\Programs\quotum`, added to your PATH), checked against the release's
checksums; `QUOTUM_INSTALL_DIR` and `QUOTUM_VERSION` change where and what. `quotum update`
keeps it up to date: with nothing new it is one small request, so a dev environment can
run it on every start. With Node.js 18 or newer, `npx quotum` works without installing
anything, and npm keeps it up to date.

**3. Connect the machine to the hub and keep it measuring.**

```sh
quotum connect http://127.0.0.1:8080
quotum start
```

`connect` shows a code: confirm it in the browser, and the machine is yours; what it
measures shows on your board. `start` keeps measuring and delivering in the background,
with its log in the state directory; `quotum` shows whether it runs and `quotum stop`
stops it. It does not come back by itself after a restart of the machine: for that,
have your system start `quotum run`, the same in the foreground (a systemd user
service, launchd, Windows autostart). With npx, put `npx` before every command.

**Many machines at once** (images, VMs, containers): create a machine token in the
dashboard (*My machines → Connect*) and start every machine with it. Each one joins as
yours by itself:

```sh
QUOTUM_HUB_URL=https://quotum.example.com QUOTUM_HUB_TOKEN=qt_m_… quotum run
```

In a dev environment that starts often (Coder, Codespaces, a devcontainer), its start
script can bring the agent up to date and start it in the background:

```sh
quotum update || true         # quick when there is nothing new; offline, it gives up in seconds
QUOTUM_HUB_URL=https://quotum.example.com QUOTUM_HUB_TOKEN=qt_m_… quotum start
```

A machine token is one person's: every teammate creates their own. Machines are named
in *My machines*, so an image doesn't need a name per copy.

**Sharing with a team.** Create a shared board, invite people with a link, and share
your subscriptions with it (*People and subscriptions → Subscriptions*). You can take
yours off again at any time; the board's owner can take any card off their board.

**By hand:** every [release](https://github.com/padurets/quotum/releases) has the agent
for Linux, macOS and Windows as an archive (`quotum-cli-<version>-<platform>`, with the
licences) and as a bare binary (`quotum-cli-<platform>`, what the installers and
`quotum update` fetch), with checksums (`SHA256SUMS`) and
[build provenance](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations)
(`gh attestation verify <file> -R padurets/quotum`). **From source:**
`cd agent && cargo build --release` (Rust 1.85 or newer) gives `target/release/quotum`.

## Desktop app

For one machine there is an app for Windows and Linux (macOS comes later): the agent of
this machine, a hub of its own and its board in a window, with a tray icon. No account,
no server. It has no release yet: the [Desktop workflow](.github/workflows/desktop.yml)
builds every commit on `main` and in pull requests and keeps each installer as an
artifact of the run (`quotum-desktop-<version>-<commit>-linux-x64.deb`, `.rpm`,
`.AppImage`, `…-windows-x64-setup.exe` and `…-windows-x64-portable.zip`; downloading
them takes a GitHub account). To build it yourself, see [CONTRIBUTING.md](CONTRIBUTING.md).

- **Windows 10 and 11:** run `Quotum_<version>_x64-setup.exe`. It installs for you
  alone, into `%LOCALAPPDATA%\Quotum`, with no administrator rights, and brings WebView2
  if Windows lacks it. The installer isn't signed yet, so SmartScreen asks first: *More
  info → Run anyway*.
  Or extract the portable ZIP and run `Quotum/quotum-desktop.exe` without installing.
  Keep the whole extracted folder together. It uses the same data and settings in your
  Windows profile as the installed app; nothing is stored beside the executable.
  The portable version needs [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)
  already installed (the setup.exe installs it when needed).
- **Linux** (x64): the system package includes Chromium and works alongside the
  system's `nodejs`. On Debian 12, Ubuntu 22.04 or newer use `sudo apt install
  ./quotum-desktop-<…>.deb`; on Fedora use `sudo dnf install ./quotum-desktop-<…>.rpm`.
  Elsewhere, make the AppImage executable (`chmod +x`) and run it; GTK3 and NSS must
  be available on the system. If FUSE is unavailable,
  add `--appimage-extract-and-run`. The AppImage needs unprivileged user namespaces for
  Chromium's sandbox; use a native package when the system restricts them. NVIDIA
  systems use X11/XWayland when available. If graphics fail, quit completely and try
  `quotum-desktop --software-rendering` (or add that option to the AppImage command).
  It affects that launch only. Closing the window frees Chromium; measuring and the
  tray continue in the small Rust controller.

When trying a new build, choose *Quit* in the old one first: closing its window keeps
it running, and another launch opens that same process. Check the commit in settings;
an AppImage's start-at-login entry also needs to point to the intended file.

The app opens its board, and the first numbers come within a minute. The gear opens its
settings: which providers are measured and how often, running agents, start at login,
the version and *Quit*. These are `quotum`'s own settings ([Configuration](#agent)): the
command and the app share them.

- **Closing the window** leaves it measuring; the tray icon or starting the app again
  opens the window. *Quit* is in the settings and in the tray's menu. GNOME shows tray
  icons only with an extension (AppIndicator); without one, start the app again to open
  its window.
- **Start at login** turns on by itself the first time the app measures and starts it
  without the window. Turn it off in the settings, and do that before uninstalling. The
  entry names the AppImage or Windows portable EXE by its path: keep it where it is
  (after a move, turn start at login off and on again).
- **A newer build** installs over the old one: quit the app first. For the portable
  version, replace the whole extracted folder; your data stays in your Windows profile.
- **With `quotum`.** One agent measures a machine. If `quotum` already does, the app
  asks once whether to take over. A `quotum` of this version then waits and goes on by
  itself when the app quits, so `quotum run` as a service keeps working; an older one
  stops (update it). A hub that `quotum` delivered to gets nothing from this machine
  while the app runs.
- **Its data**, the board's history and the logs, is in
  `%LOCALAPPDATA%\com.padurets.quotum` or `~/.local/share/com.padurets.quotum`.
- **What leaves the machine:** nothing but the reset announcements the board reads from
  Codex Resets and Claude Resets, as every hub does (`QUOTUM_RESETS=off` in the app's
  environment turns that off). Its hub listens on `127.0.0.1` alone, behind a key only
  the window gets.
- **Size:** Linux packages carry both Chromium for the window and Node.js for the hub.
  Windows uses the system WebView2: about 26 MiB for setup.exe or 38 MiB for the ZIP.
  In a Windows 11 VM with five subscriptions, idle working set across the app, Node
  and WebView2 was about 342 MiB with the window open and 47 MiB after closing it;
  CPU was 0.76% and 0.24% of one core over 30 seconds. Memory varies with history,
  WebView2 and Windows; virtual graphics do not establish physical display performance.

## Configuration

### Agent

Everything is optional. On Linux the file is `~/.config/quotum/config.toml`;
`quotum config` shows where it is on your system and what is in effect.

```toml
# interval = 120        # seconds, 60 to 86400: with a hub, the most often a client is measured
                        # (left out, the hub measures as often as needed); without one, how often
eco = true              # without a hub (or while it does not answer): measure less often while nothing changes
sessions = true         # tell the hub which coding agents run here, working or idle
projects = true         # with the names of their projects and folders

[machine]
name = "work-laptop"    # the name the machine reports (default: host name); renaming it on the hub wins

[hub]
url = "https://quotum.example.com"
token = "qt_m_…"

[providers.antigravity]
interval = 300
account = "work"        # tells two Antigravity subscriptions apart (agy doesn't say which one it is)
# enabled = false
# path = "/opt/agy/bin/agy"
```

The environment variables `QUOTUM_HUB_URL`, `QUOTUM_HUB_TOKEN`,
`QUOTUM_INTERVAL`, `QUOTUM_CONFIG` and `QUOTUM_STATE_DIR` override the file. Other
commands: `quotum --json` (one measurement in the ingest format), `quotum --only codex`,
`quotum start` / `quotum stop`, `quotum disconnect`, `quotum update` (`--check` only
says whether there is a newer release; `QUOTUM_RELEASES_URL` points it at a mirror). An
agent running in the background keeps its version until it is started again.

### Hub

| Variable | Default | Meaning |
|---|---|---|
| `QUOTUM_BIND` | `127.0.0.1` (image: `0.0.0.0`) | Address to listen on |
| `QUOTUM_PORT` | `8080` | Port to listen on |
| `QUOTUM_ALLOWED_HOSTS` | `127.0.0.1,localhost` (image: `*`) | Host names the hub answers to, or `*` for any; other hosts get 403. Setting it replaces the default |
| `QUOTUM_PUBLIC_URL` | taken from the request | The address shown to agents and used in invite links |
| `QUOTUM_TRUST_PROXY` | — | Believe a proxy about the client's address and protocol: `true`, a number of hops, or addresses and CIDR ranges |
| `QUOTUM_DATA_DIR` | `hub/data` (image: `/data`) | Where the SQLite database lives |
| `QUOTUM_SETUP_CODE` | random, printed at start | The code the first account needs while the hub has none |
| `QUOTUM_SIGNUP` | `invite` | `open` lets anyone sign up; otherwise only the first person and people with an invite |
| `QUOTUM_RESETS` | on | `off` stops polling the community reset trackers |
| `QUOTUM_RESETS_CODEX_URL`, `QUOTUM_RESETS_CLAUDE_URL` | `https://codex-resets.com/api/v1/status`, `https://claude-resets.com/api/resets` | Where to read Codex Resets and Claude Resets instead, such as a mirror where the tracker's bot check stops your server: the full address of an endpoint that answers the same JSON, without a user name or password |
| `QUOTUM_FRAME_ANCESTORS` | — | Extra origins allowed to embed the dashboard |

**Opening the hub to other machines.** Put it behind HTTPS (sessions are cookies and
tokens are bearer secrets): [deploy/compose.yaml](deploy/compose.yaml) does it with
Caddy. Behind a proxy of your own, tell the hub its address and trust the proxy:
`QUOTUM_PUBLIC_URL=https://quotum.example.com QUOTUM_TRUST_PROXY=true`.

## More

- [docs/architecture.md](docs/architecture.md): how the parts fit, how measuring and
  scheduling work, people, boards and devices.
- [spec/ingest-v1.md](spec/ingest-v1.md): what the agent sends to the hub; anything can
  implement it.
- [CONTRIBUTING.md](CONTRIBUTING.md): checking a change and what to keep in mind;
  [SECURITY.md](SECURITY.md): reporting a vulnerability privately.
- `npm run demo` in `hub/` (after `npm run build`): a live board on throwaway data with
  every state the dashboard knows, no network or account needed; Ctrl+C stops it and
  leaves nothing behind. `npm run demo -- showcase` is the board of the images above.

Project layout:

```
agent/crates/core     adapters for each client, schedule, settings, delivery to the hub
agent/crates/cli      the `quotum` command
npm/                  the npm packages: a launcher and a prebuilt binary per platform
install/              the installers for `curl … | sh` and PowerShell
deploy/               running the hub with Docker Compose behind Caddy (HTTPS)
desktop/              the desktop app (Rust, Electron on Linux, Tauri on Windows): the agent, its own hub and board in a window
.github/workflows     tests on every push; everything released from a version tag
spec/                 the protocol between the agent and the hub
hub/server/domain     the rules: windows, spending, resets, the ingest format
hub/server/store      SQLite: layout, measurements, people and devices
hub/server/routes     HTTP routes for people and for agents
hub/server/*.ts       ingest, duty, device pairing, sessions, the reset trackers
hub/ui                the dashboard (React), translations in hub/ui/i18n
hub/demo              the demo board: a catalogue of every state, kept alive
```

`npm test` and `npm run typecheck` in `hub/`, `cargo test` and `cargo clippy` in
`agent/` and `desktop/` check everything (the app's after `node desktop/prepare.mjs`);
CI runs them on every push. `node npm/build.mjs` builds the
npm packages (it needs cargo-zigbuild and zig; see the script), `docker build hub` the
hub's image.

### Releasing

Set the new version in `agent/Cargo.toml` (`[workspace.package]`), `desktop/Cargo.toml`
and `hub/package.json`, let the lock files follow, push the commit, then tag it with the release notes as the
tag's message. A release that brings a new database layout step also adds its hash to
`RELEASED` in `hub/server/test/schema.test.ts` in that commit: from then on the step
never changes.

```sh
(cd hub && npm version 0.2.0 --no-git-tag-version)   # package.json and package-lock.json
# agent/Cargo.toml and desktop/Cargo.toml: version = "0.2.0"
(cd agent && cargo check)                            # Cargo.lock
(cd desktop && cargo metadata --format-version 1 >/dev/null)   # its Cargo.lock, with no build
git commit -am "Version 0.2.0" && git push origin main
git tag -a v0.2.0 -F notes.md --cleanup=verbatim   # annotated, its message kept whole: the release notes
git push origin v0.2.0
```

[release.yml](.github/workflows/release.yml) refuses a tag that is not annotated or
whose version differs from any of those six files. It checks everything again, builds
the agent for every platform, publishes the hub's image and the npm packages, and
creates the GitHub release with the binaries. npm accepts the packages from that workflow alone,
without a token (trusted publishing). A new npm package, for a new platform, is
published once by hand and then trusted with `node npm/trust.mjs`. npm trusts the
repository by its name: after renaming it, run that again, and it replaces the old trusts.

### Adding a language

The dashboard's text lives in `hub/ui/i18n`. Copy `ru.ts` to a file named after the
language's code (`de.ts`), translate the strings, rename its export, and add it to
`LOCALES` in `index.ts` (an import and one line). The type checker and `npm test` then
make sure every key is translated, the `{placeholders}` match and every plural form the
language has is there.

## Roadmap

1. A team view on shared boards: people × providers at a glance.
2. Autostart: a systemd user service, launchd, Windows.
3. Releases of the desktop app with installers, then the app on macOS.

## Credits and license

Thanks to [CodexBar](https://github.com/steipete/CodexBar) for showing the way and for
being the first data source of this dashboard, and to the people behind
[Codex Resets](https://codex-resets.com) and [Claude Resets](https://claude-resets.com).
Provider icons come from [LobeHub Icons](https://github.com/lobehub/lobe-icons). Quotum
is not affiliated with Anthropic, OpenAI or Google.

MIT, see [LICENSE](LICENSE). Third-party notices are in [NOTICE.md](NOTICE.md).

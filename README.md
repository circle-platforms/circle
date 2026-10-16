<p align="center">
  <img src="docs/images/logo.svg" width="96" height="96" alt="Circle">
</p>

<h1 align="center">Circle</h1>

<p align="center">A coding agent for your own model endpoint, in the terminal and in its own window.</p>

<p align="center">
  <a href="https://circle-platforms.github.io/circle/">Docs</a> ·
  <a href="https://circle-platforms.github.io/circle/quickstart/">Quickstart</a> ·
  <a href="https://circle-platforms.github.io/circle/known-issues/">Known issues</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

---

Circle reads and edits the code in a folder you choose, and runs commands there. It works with any service or gateway that speaks the OpenAI or Anthropic API. It asks before it runs a command or changes a file, and the screen shows at a glance whether it is working or waiting for you. The same agent runs in the terminal and in the desktop application.

**Circle is early software.** There is no operating-system sandbox. Read [Known issues](https://circle-platforms.github.io/circle/known-issues/) and [Run Circle safely](https://circle-platforms.github.io/circle/security/) before you point it at anything you care about.

## Install

Install a prebuilt release. It carries its own Node.js; nothing else needs to be installed first.

**macOS and Linux** (x64 or arm64):

```bash
curl -fsSL https://raw.githubusercontent.com/circle-platforms/circle/main/install.sh | bash
```

**Windows** (x64 or arm64), in PowerShell:

```powershell
irm https://raw.githubusercontent.com/circle-platforms/circle/main/install.ps1 | iex
```

The installers download the latest release for your platform, verify its SHA-256, start it once, and put `circle` on your PATH. macOS and Linux need `bash`, `curl`, `tar`, and `sha256sum` or `shasum`. Windows needs PowerShell 5.1 or newer.

Restart your terminal after installing, then run `circle`. Upgrade with `circle update`. See [Installation and updates](https://circle-platforms.github.io/circle/installation/) and [Releases](https://github.com/circle-platforms/circle/releases).

**Coming from Circle 0.5.0 or older?** Those were written in Python. Run the install command above: it removes the Python version, keeps your settings, keys, skills and sessions, and installs the current release in its place. The old `circle update` cannot install 1.0.0 or later. Python extensions have to be rewritten; see [Extensions](https://circle-platforms.github.io/circle/extensions/).

## Desktop application

Each release also has Circle as a desktop application: the same agent in its own window, with a browser panel you and Circle use together. [The desktop application](https://circle-platforms.github.io/circle/desktop/) says what the window shows. It carries everything it needs and does not use the `circle` command. It keeps its settings, key and sessions in its own data folder, apart from `~/.circle`.

| System | File |
|---|---|
| macOS, Apple silicon | `circle-desktop-<version>-darwin-arm64.dmg` |
| macOS, Intel | `circle-desktop-<version>-darwin-x64.dmg` |
| Windows x64 | `circle-desktop-<version>-windows-x64.msi` |
| Linux x64 | `circle-desktop-<version>-linux-x64.tar.gz` |

Take the file from [Releases](https://github.com/circle-platforms/circle/releases). It is signed ad hoc, not by Apple or Microsoft, so the first launch asks you to confirm. The Windows installer puts Circle in `C:\Program Files\Circle` and on the Start menu. On Linux the sandbox helper needs one root command. The steps are in [Installation](https://circle-platforms.github.io/circle/installation/#the-desktop-application).

On macOS and Windows the application updates itself: settings → about → check now, then update and restart. On Linux, check now opens the release page and the folder is replaced by hand. Releases up to 1.2.0 do not update themselves.

The window follows the system language the first time, and can be English or 简体中文. The terminal stays English. To run it from a checkout, see [apps/desktop](apps/desktop/README.md).

**Does your organization sign its own certificates?** Put the CA's PEM file somewhere readable and list it under `trust_cert_files` in `~/.circle/settings.json`. Start `circle` with no environment variables: it adds those authorities to the ones it trusts, and the commands and tools it starts get one merged bundle through `SSL_CERT_FILE`, the system store included. See [Settings](https://circle-platforms.github.io/circle/settings/) and [Security](https://circle-platforms.github.io/circle/security/).

## Run

```bash
cd ~/code/my-project
circle
```

The first time, Circle asks for a base URL, a key and a model, then asks you to trust the folder. After that, type a task and press `enter`. Type `/` to see the commands and `?` to see the keys.

```bash
circle "fix the failing test"            # start with a message
circle -c                                # go on with the last conversation here
circle -r                                # pick a conversation from a list
circle -p "summarize README.md"          # one prompt, answer on stdout
git diff | circle -p "review this change"
```

While Circle works you can keep typing: `enter` steers the running turn. `esc` twice goes back to an earlier point of the conversation, `ctrl+l` switches models and `ctrl+f` finds text. The [CLI](https://circle-platforms.github.io/circle/cli/) also has a JSON event stream and an RPC mode for scripts and editors.

The terminal interface uses conversation cards, status lamps and an `auto` theme that follows terminal colours. Use `/themes dark` or `/themes light` when your terminal cannot report its colours. See [The interface](https://circle-platforms.github.io/circle/interface/) for the signals and limits.

## The browser, device terminals, variables and secrets

Ask Circle to open a page, such as a device's web interface on your network, and it uses the browser as you would. It reads the page, moves a pointer to click and type, and answers the page's dialogs. It passes a certificate warning only after you approve, and it tells you about downloads, files a page asks for and sign-ins. In the terminal the browser is a Chrome, Edge or Chromium window with a new, empty profile; in the desktop application it is a browser panel you share with Circle and can take over. Control is approved site by site, and some things are always yours to decide: giving a page files, camera or location permissions, and which client certificate identifies you.

Ask Circle to reach a device you administer — a switch, a router, a server's console — and it opens an SSH or Telnet terminal and works it the way you would in SecureCRT: it reads what the device answers and types what you approve, approved device by device, with host keys you trust and passwords kept only as `%NAME%` secrets. In the terminal interface the device screen is a page you can attach to and type on yourself; in the desktop application it is a terminal panel you share. `/terminals` lists the open consoles and your saved sessions. See [Device terminals](https://circle-platforms.github.io/circle/tools/#device-terminals).

Save a password with `/secrets NAME`, or under settings → variables in the desktop application. The model writes `%NAME%` wherever the password is needed, in a browser field or in any other tool, and never sees the value: Circle puts it in when the tool runs and hides it again in what comes back. `/variables NAME=value` keeps plain values the same way. See [The browser](https://circle-platforms.github.io/circle/tools/#the-browser) and [Secrets by name](https://circle-platforms.github.io/circle/security/#secrets-by-name).

## Learn more

| | |
|---|---|
| [Quickstart](https://circle-platforms.github.io/circle/quickstart/) | Install, connect a model, run a first task. |
| [The interface](https://circle-platforms.github.io/circle/interface/) | What the lamps, tints and frame mean. |
| [Run Circle safely](https://circle-platforms.github.io/circle/security/) | What is asked, what is refused, what is not protected. |
| [Choose a model](https://circle-platforms.github.io/circle/models/) | Endpoints, switching, thinking depth. |
| [The browser](https://circle-platforms.github.io/circle/tools/#the-browser) | Web pages Circle and you use together. |
| [Device terminals](https://circle-platforms.github.io/circle/tools/#device-terminals) | SSH and Telnet consoles Circle and you work together. |
| [Skills](https://circle-platforms.github.io/circle/skills/), [Commands](https://circle-platforms.github.io/circle/custom-commands/), [MCP](https://circle-platforms.github.io/circle/mcp/), [Extensions](https://circle-platforms.github.io/circle/extensions/) | Make Circle yours. |
| [The desktop application](https://circle-platforms.github.io/circle/desktop/) | The same agent in its own window. |
| [All documentation](https://circle-platforms.github.io/circle/) | Guides and reference. |

## Development

Circle is written in TypeScript and runs on Node.js 24 or newer. Up to 0.5.0 it was written in Python; that code is at the tag `v0.5.0`.

```bash
git clone https://github.com/circle-platforms/circle
cd circle
npm ci
npm run check                                    # type check, tests, build
CIRCLE_HOME=$(mktemp -d) npm run dev -- ~/code/my-project
```

Code pushes do not publish a new version: the release workflow publishes when a `v*` tag is pushed. See [Releasing](https://circle-platforms.github.io/circle/development/releasing/).

See [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) for coding agents, and the [architecture](https://circle-platforms.github.io/circle/development/architecture/). Report security problems as described in [SECURITY.md](SECURITY.md). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

Circle is one of three repositories. [circle-hub](https://github.com/circle-platforms/circle-hub) is the team hub a Circle signs in to, and [circle-packs](https://github.com/circle-platforms/circle-packs) holds the skill packs and product-line packs installed on it. The [compatibility matrix](https://github.com/circle-platforms/circle-hub/blob/main/docs/compatibility.md) says what each expects of the others.

## License

Circle is released under the [Apache License 2.0](LICENSE). The [NOTICE](NOTICE) file names the copyright holder and reserves the Circle and Circle Hub names, logos and icons: the license covers the code and its documentation, not the marks. The architecture and design specifications listed in [docs/design/README.md](docs/design/README.md) are under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) and must be credited, with a link to the original, when reused. Versions up to 1.2.1 were released under the MIT License. The model catalogs in `src/data/` carry metadata from models.dev, and many prompts in `src/prompts/` come from OpenCode, each under its own MIT license; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Contributions are accepted under the [contributor terms](CONTRIBUTING.md#contributor-terms).

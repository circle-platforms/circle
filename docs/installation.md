---
nav_order: 3
---

# Installation and updates

A release of Circle carries everything it needs, including its own Node.js: nothing else has to be installed first. Releases are built for macOS, Linux and Windows, each on x64 and arm64, as `circle-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows) with a `.sha256` file beside each. The same release has [the desktop application](#the-desktop-application).

The commands below install the newest release on the [Releases page](https://github.com/circle-platforms/circle/releases). They need a release of 1.0.0 or later; until one is published there, they stop with an error and change nothing.

## Install

On macOS and Linux (needs `bash`, `curl`, `tar`, and `sha256sum` or `shasum`):

```sh
curl -fsSL https://raw.githubusercontent.com/circle-platforms/circle/main/install.sh | bash
```

On Windows, in PowerShell 5.1 or newer:

```powershell
irm https://raw.githubusercontent.com/circle-platforms/circle/main/install.ps1 | iex
```

If `install.sh` runs in a Windows shell (Git Bash, MSYS2, Cygwin), it hands over to PowerShell and installs the Windows program.

The installer downloads the release for your system, checks its sha256, refuses an archive with links, special files or paths that leave it, checks every file against the release's own list, and runs the new program once. Only then does it switch to the new version, so a failed step leaves the installed one as it was. It says each step on a line of its own, starting with `[circle-install]`. On a terminal, `install.sh` also shows curl's bar of how far the download has got; `install.ps1` only says that it is downloading.

| Variable         | Effect                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| `CIRCLE_VERSION` | Install this version instead of the newest, for example `CIRCLE_VERSION=1.0.0`.                      |
| `CIRCLE_REPO`    | The GitHub repository to take releases from. Default `circle-platforms/circle`.                      |
| `CIRCLE_PREFIX`  | Where versions are kept. Default `~/.local/share/circle`, or `%LOCALAPPDATA%\circle` on Windows.     |
| `CIRCLE_BIN_DIR` | Where the `circle` launcher goes. Default `~/.local/bin`, or `%LOCALAPPDATA%\circle\bin` on Windows. |
| `CIRCLE_NO_PATH` | `1` leaves your `PATH` alone.                                                                        |

When the launcher's folder is not on your `PATH`, the installer adds it: on Windows to your user `PATH`, on macOS and Linux as one line marked `# circle path` in the startup file of an installed bash or zsh. It tries `$SHELL`, then `$BASH`, then the login shell from the password database, and it writes `~/.bashrc` or `~/.zshrc` only when that shell's program is installed. When none of those is an installed bash or zsh, it leaves the startup files alone and prints the `PATH` line to add by hand. Open a new terminal afterwards, or run the `source` command it prints.

If the installer stops with a certificate error, your network is replacing HTTPS certificates. Export its root certificate as a PEM file and run the installer again with `CURL_CA_BUNDLE=/path/to/ca.pem` (macOS, Linux), or import it into the Windows certificate store, which PowerShell uses. `HTTPS_PROXY` sets a proxy for the download.

## Where it goes

Each version lives in its own folder, `versions/<version>/`, under the prefix. `current.ref` names the version the launcher runs, and `installation.json` records the folders and the repository for `circle update`. An installation keeps the newest three versions and the one it replaced, so a session started from an older one goes on running; other versions are removed.

Your settings, keys, sessions, skills and the rest stay in the data folder, `~/.circle` (or `CIRCLE_HOME`), which installing and updating never touch and `circle uninstall` keeps unless `--purge` deletes it. See [Configuration](configuration.md#where-circle-keeps-things).

## Updates

```sh
circle update --check      # is there a newer release?
circle update              # install it
circle update 1.0.0        # install this one, also an older one
```

`circle update` downloads the release it found itself, on one line that shows how far it has got (percent, megabytes and speed), then runs the installer on that file with the same folders, and the installer says each step. `ctrl+c` during the download stops it and changes nothing. See [Updating](cli.md#updating) for its options and exit codes, and [The reminder](cli.md#the-reminder) for the daily check.

## Uninstall

```sh
circle uninstall           # remove the program, keep the data folder
circle uninstall --purge   # remove the program and the data folder
```

`circle uninstall` removes the launcher, every version under the prefix and the PATH change the installer made. On a terminal it lists what goes and asks first; `--yes` skips the question and is required without one. The data folder, `~/.circle`, stays unless `--purge` deletes it too. See [Uninstalling](cli.md#uninstalling). The desktop application is removed separately: on Windows through Settings → Apps, on macOS and Linux by deleting the application; its own data folder stays in place.

## Replacing the Python circle

Circle 0.5.0 and older were written in Python. Running the one-command installer above is how you upgrade: it removes the Python version before it switches to the new one.

- A copy installed by the old installer: its `versions/` folders, its `current` link and the `circle` link in the launcher folder. On Windows it also takes `<prefix>\current\circle` off your user `PATH`. Unless `CIRCLE_PREFIX` or `CIRCLE_BIN_DIR` say otherwise, the new version goes into the same folders.
- A copy installed with pip whose `circle` command is on your `PATH`, including pipx and `pip install -e` checkouts: the installer runs `<that command's python> -m pip uninstall -y circle`. A checkout itself stays.

The installer first downloads and checks the new release, so a failed download leaves the old copy in place. If a Python circle is still running, it stops before changing anything; close those sessions and run it again. On Windows it lists the running programs only when a program of the old copy is in use. If that list takes longer than 30 seconds, or no process in it runs the program in use, it names the program and stops the same way. If a pip uninstall fails, it stops and names the command that failed.

When the Windows process check stops because an executable is in use and no process was identified, its error includes the last captured query boundary, bounded marker counts, the native exit or timeout code, the signal and process ID the query runner reported, and how much output it returned, in UTF-16 code units and lines; the output itself is not shown. A missing marker or runner value is `unknown`; a count of 32 may be capped. These observations do not identify the operation that stalled: reaching `COMPLETE` does not establish a successful query, a reported process ID does not establish that the query started, and a reported signal does not establish what stopped it.

The data folder is shared and not touched. Settings, keys, MCP servers, skills, custom commands, prompt history and trusted folders carry over; saved sessions are imported on the first start (see [Sessions from 0.5.0](sessions.md#sessions-from-050)). Python extensions do not load in this version and have to be rewritten; see [Coming from 0.5.0](extensions.md#coming-from-050).

`circle update` in a Python version cannot install 1.0.0 or later: it stops with `release v1.0.0 has no circle-<os>-<arch>.tar.gz` (`.zip` on Windows), because release files now carry the version in their names. Run the one-command installer instead.

## The desktop application

Each release also has the Circle desktop application: a window of its own around the same Circle. Take the file for your system from the [Releases page](https://github.com/circle-platforms/circle/releases):

| System               | File                                        |
| -------------------- | ------------------------------------------- |
| macOS, Apple silicon | `circle-desktop-<version>-darwin-arm64.dmg` |
| macOS, Intel         | `circle-desktop-<version>-darwin-x64.dmg`   |
| Windows x64          | `circle-desktop-<version>-windows-x64.msi`  |
| Linux x64            | `circle-desktop-<version>-linux-x64.tar.gz` |

Each has a `.sha256` file beside it, and the release's `SHA256SUMS` lists them all. The application carries everything it needs; it does not use the `circle` command.

- **macOS:** open the `.dmg` and drag Circle to Applications. Circle is signed ad hoc, not by an Apple developer, so the first time macOS says it cannot check it. Open System Settings → Privacy & Security, click Open Anyway beside the line about Circle, and confirm. In a terminal, `xattr -dr com.apple.quarantine /Applications/Circle.app` does the same.
- **Windows:** open the `.msi`. Circle is not signed, so if SmartScreen says it protected your PC, click More info, then Run anyway. Windows asks for administrator permission, then installs Circle for all users into `C:\Program Files\Circle` and adds Circle to the Start menu; there are no setup pages. To remove it, open Settings → Apps → Installed apps (Apps & features on Windows 10), choose Circle and Uninstall: that removes the program and its Start menu entry and leaves the data folder `%APPDATA%\Circle` as it is. An older release's `.msi` does not install over a newer one; it stops with "A newer version of Circle is already installed." Quit Circle before you update or remove it.
- **Linux:** quit Circle if it is running. The archive unpacks as one folder named `Circle-linux-x64` (or `Circle-linux-arm64`). Unpacking it next to a folder of that name collides, and unpacking it onto the old files mixes the two copies and drops the setuid bit on `chrome-sandbox`. Delete the old folder, then unpack. Ubuntu 24.04 and later need `chrome-sandbox` owned by root with the setuid bit; without it Circle stops at once with `The SUID sandbox helper binary was found, but is not configured correctly`. Every new copy needs the two commands again. Then start `Circle`:

  ```sh
  rm -rf Circle-linux-x64
  tar -xzf circle-desktop-<version>-linux-x64.tar.gz
  sudo chown root:root Circle-linux-x64/chrome-sandbox
  sudo chmod 4755 Circle-linux-x64/chrome-sandbox
  ./Circle-linux-x64/Circle
  ```

  To put that folder somewhere else afterwards, move it with `mv`. `cp` drops the setuid bit. Circle refuses `--no-sandbox`. The file `CIRCLE_VERSION` in that folder is Circle's version. Electron also writes a `version` file there; that one is Electron's.

The application updates itself on macOS and Windows: settings → about → check now, then update and restart to update ([Updates](desktop.md#updates) has the details). `circle update` updates only the command line. On Linux, when the application folder can be written, check now downloads the `.tar.gz`, checks it, and quit and replace swaps the folder. If `chrome-sandbox` is setuid, Circle does not start itself again: the about page and a confirm dialog show the `chown` and `chmod 4755` commands before it quits, and the next launch shows them again. The same lines are in the installer log. Run them, then start Circle. When the folder cannot be written, check now opens the release page and leaves those steps on the about page. Circle 1.6.0 and the published 1.7.4 do not include this updater: install one newer release by hand, as above, and the updater is in that copy. Releases up to 1.2.0 do not update themselves on any system: install the newer release over them once by hand (on Windows, open the new `.msi`; it replaces the installed version).

It keeps its settings, key and sessions in a data folder of its own, apart from `~/.circle`: `~/Library/Application Support/Circle` on macOS, `%APPDATA%\Circle` on Windows, `~/.config/Circle` on Linux. The first time, it asks for the API URL, the key and the model. Open a folder and trust it before Circle reads it or runs anything in it. [The desktop application](desktop.md) explains its window.

## From source

A checkout runs on Node.js 24 or newer:

```sh
git clone https://github.com/circle-platforms/circle
cd circle
npm ci
npm run build
node dist/cli.js --version
```

`npm run dev -- <folder>` runs the checkout without building. `circle update` does not work on a checkout: update it with `git pull`, `npm ci` and `npm run build`. To try the release packages locally, run `npm run release:build` and `npm run release:smoke`; the smoke test uses folders and a model endpoint of its own. `CIRCLE_ASSET_DIR` points the installer at a folder of local archives instead of GitHub.

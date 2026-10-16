## Install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/@REPO@/@TAG@/install.sh | CIRCLE_VERSION=@VERSION@ bash
```

Windows, in PowerShell:

```powershell
$env:CIRCLE_VERSION = '@VERSION@'; irm https://raw.githubusercontent.com/@REPO@/@TAG@/install.ps1 | iex
```

Already installed? Run `circle update`.

## Desktop application

| System               | File                                        |
| -------------------- | ------------------------------------------- |
| macOS, Apple silicon | `circle-desktop-@VERSION@-darwin-arm64.dmg` |
| macOS, Intel         | `circle-desktop-@VERSION@-darwin-x64.dmg`   |
| Windows x64          | `circle-desktop-@VERSION@-windows-x64.msi`  |
| Linux x64            | `circle-desktop-@VERSION@-linux-x64.tar.gz` |

It is not signed by Apple or Microsoft. On macOS, drag Circle to Applications; the first time, open System Settings → Privacy & Security and click Open Anyway. On Windows, open the `.msi` (if SmartScreen stops it, click More info, then Run anyway) and allow it to make changes: it installs Circle into `C:\Program Files\Circle` with a Start menu entry, and Settings → Apps → Installed apps removes it again. On Linux, quit Circle, delete the old `Circle-linux-x64` folder, then unpack this archive (it always unpacks as that folder name, so unpacking beside an existing one collides, and unpacking onto the old files drops setuid). Then run `sudo chown root:root Circle-linux-x64/chrome-sandbox && sudo chmod 4755 Circle-linux-x64/chrome-sandbox`, or Circle will not start, and start `Circle-linux-x64/Circle`. The steps are in [Installation](https://circle-platforms.github.io/circle/installation/#the-desktop-application). It keeps its own data folder, apart from `~/.circle`. On macOS and Windows it updates itself: settings → about → check now, then update and restart to update. Versions up to 1.2.0 cannot: install this file over them once. Circle 1.6.0 and the published 1.7.4 need this manual Linux update once; after that, check now replaces a folder it can write, and stops before starting again until `chrome-sandbox` belongs to root. Otherwise it opens this page and shows those steps.

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

| System | File |
|---|---|
| macOS, Apple silicon | `circle-desktop-@VERSION@-darwin-arm64.dmg` |
| macOS, Intel | `circle-desktop-@VERSION@-darwin-x64.dmg` |
| Windows x64 | `circle-desktop-@VERSION@-windows-x64.msi` |
| Linux x64 | `circle-desktop-@VERSION@-linux-x64.tar.gz` |

It is not signed by Apple or Microsoft. On macOS, drag Circle to Applications; the first time, open System Settings → Privacy & Security and click Open Anyway. On Windows, open the `.msi` (if SmartScreen stops it, click More info, then Run anyway) and allow it to make changes: it installs Circle into `C:\Program Files\Circle` with a Start menu entry, and Settings → Apps → Installed apps removes it again. On Linux, after unpacking, run `sudo chown root:root Circle-linux-x64/chrome-sandbox && sudo chmod 4755 Circle-linux-x64/chrome-sandbox` once, then start `Circle-linux-x64/Circle`. It keeps its own data folder, apart from `~/.circle`. On macOS and Windows it updates itself: settings → about → check now, then update and restart to update. Versions up to 1.2.0 cannot: install this file over them once. On Linux, take the new file to update it. See [Installation](https://circle-platforms.github.io/circle/installation/#the-desktop-application).

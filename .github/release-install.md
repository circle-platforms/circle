## Install

macOS and Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/@REPO@/@TAG@/install.sh | CIRCLE_VERSION=@VERSION@ bash
```

Windows, in PowerShell:

```powershell
$env:CIRCLE_VERSION = '@VERSION@'; irm https://raw.githubusercontent.com/@REPO@/@TAG@/install.ps1 | iex
```

Already on 1.0 or later? Run `circle update`.

Coming from Circle 0.5.0 or older, the Python version: its `circle update` cannot install this release and reports a missing file. Run the install command above instead. It removes the Python version, keeps your settings, keys and sessions, and installs this one in its place.

## Desktop application

| System | File |
|---|---|
| macOS, Apple silicon | `circle-desktop-@VERSION@-darwin-arm64.dmg` |
| macOS, Intel | `circle-desktop-@VERSION@-darwin-x64.dmg` |
| Windows x64 | `circle-desktop-@VERSION@-windows-x64.zip` |
| Linux x64 | `circle-desktop-@VERSION@-linux-x64.tar.gz` |

It is not signed by Apple or Microsoft. On macOS, drag Circle to Applications; the first time, open System Settings → Privacy & Security and click Open Anyway. On Windows, if SmartScreen stops `Circle.exe`, click More info, then Run anyway. On Linux, after unpacking, run `sudo chown root:root Circle-linux-x64/chrome-sandbox && sudo chmod 4755 Circle-linux-x64/chrome-sandbox` once, then start `Circle-linux-x64/Circle`. It keeps its own data folder, apart from `~/.circle`, and does not update itself: take the new file to update it. See [Installation](https://qingshanfeihu.github.io/circle/installation/#the-desktop-application).

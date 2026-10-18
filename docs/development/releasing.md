---
parent: Development
nav_order: 2
---

# Releasing

A release is a git tag `vX.Y.Z`. Pushing the tag starts the `release` workflow, which builds the runtime-inclusive package on six targets, smoke-tests each one, and publishes one GitHub Release. Users then get it from the installers and from `circle update`, and Circle tells them once a day when there is one they do not have.

Until a release exists, none of that reaches anyone. Cut one whenever `## Unreleased` in `CHANGELOG.md` holds something a user would want, and always after a fix to the installer or to `circle update`: those cannot reach a user any other way.

## Before you start

- `main` is green: the `release` workflow passed on the last commit of `main`, the one the release commit goes on. Every push to `main` runs the whole check on all six targets and the desktop journeys on all four desktop packages, and only skips publishing. A tag's run verifies the packages it publishes and does not test the code again, so this is where the code is tested.
- You have the admin role: `main` takes other changes only through the merge queue, and only an admin can push the release commit to it directly.
- `## Unreleased` in `CHANGELOG.md` says what changed, in the words a user would use. `npm run release` refuses an empty section.
- `docs/known-issues.md` still describes the current release.

## Cut it

```bash
npm run release -- 1.0.1     # edits package.json, package-lock.json, src/version.ts, CHANGELOG.md
git diff                     # read it
npm run check
git add package.json package-lock.json src/version.ts CHANGELOG.md
git commit -m "Release 1.0.1"
git tag v1.0.1
git push origin main v1.0.1
```

The script sets the version in the three files, renames `## Unreleased` to `## 1.0.1 - <today>` and leaves a new empty `## Unreleased` above it. It refuses when the version is not newer, when the files disagree, when one of the four files has uncommitted changes, or when there is nothing to release. The files may already name a version that has no changelog section yet; that version is accepted once. The script does not commit, tag or push.

The workflow then, on each target:

1. checks that the tag, the version files and the changelog agree (`npm run release -- --check`);
2. builds the program (`npm run build`). The type check, the test suite and the format check ran on `main` before the tag and on your machine before the release commit; a tag's run does not repeat them;
3. builds `circle-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows) with its `.sha256` (`npm run release:build`). The package holds the compiled program, its locked dependencies and a pinned Node.js;
4. runs `npm run release:smoke` against the archive, with a home and PATH of its own: the program starts from a relocated copy, answers a real tool turn against a local model endpoint, installs with `install.sh` or `install.ps1`, upgrades, keeps the data folder, rejects a bad checksum and installs to the default location.

The release exists as a draft from the start. The `draft` job checks the version again, writes the notes from the changelog section and `.github/release-install.md` and creates the draft; when the tag already has a published release it fails at once, and nothing is published. Once the targets are done, `publish` puts every package that passed in the draft, even when another target failed. When all 20 packages and checksums are there, it verifies the checksums again, adds `install.sh`, `install.ps1` and `SHA256SUMS`, compares the draft's names and sizes with what was built, and publishes it. The packages stay artifacts of the run for a week.

| Runner | Asset |
|---|---|
| `ubuntu-24.04` | `circle-<version>-linux-x64.tar.gz` |
| `ubuntu-24.04-arm` | `circle-<version>-linux-arm64.tar.gz` |
| `macos-15-intel` | `circle-<version>-darwin-x64.tar.gz` |
| `macos-15` | `circle-<version>-darwin-arm64.tar.gz` |
| `windows-2025` | `circle-<version>-windows-x64.zip` |
| `windows-11-arm` | `circle-<version>-windows-arm64.zip` |

The `desktop` job packages the desktop application on four more runners (`npm --prefix apps/desktop run package`) and starts each package with `test:launch` (under `xvfb-run` on Linux): the window shows the workbench, the window and the main process answer each other, a turn reaches a local model endpoint and its answer comes back, and quitting ends every process and closes the debugging port. On `main` it then runs the desktop journeys, `test:desktop` and `test:live`, on each package; a tag's run leaves them to `main`. On macOS and Linux `test:update` then packages a newer version beside it, serves it from a local releases page and updates a copy of the package through settings, as a user does; it passes when the copy that starts again is the newer version. On Linux a setuid `chrome-sandbox` does not start Circle again: the check waits until the folder is replaced, then starts that copy itself. On Windows the job does not run it: there the check installs the package's MSI and updates it to a newer MSI through the application (`CIRCLE_DESKTOP_UPDATE_MSI`), and a runner machine that stops answering under it ends the job with no log and no step timeout, as some did while Windows Installer used Restart Manager ([#45](https://github.com/circle-platforms/circle/issues/45)); a release must not wait on that, so the `Desktop workbench` workflow runs it instead. On a person's machine the check removes the MSI again afterwards; a GitHub runner is thrown away with it, so there the uninstall is left out, and the install-and-remove step checks removal. On macOS the application is signed again, ad hoc, after packaging, because packaging breaks the signature Electron's own files came with, and a copy with a broken signature is reported as damaged once downloaded.

On Windows the job also installs the WiX Toolset 5.0.2 as a dotnet tool and its matching UI extension (`wix extension add --global WixToolset.UI.wixext/5.0.2`), then builds the MSI from the packaged folder (`npm --prefix apps/desktop run package:msi`, which runs `wix build` and the ICE checks of `wix msi validate`). `test:msi` reads the compiled database to check the completion checkbox, launch condition and ordering, quoted executable path, and absence of a launch action in the silent execute sequence. The job then installs the MSI with `msiexec /qn`, checks that `C:\Program Files\Circle` holds the packaged folder file for file, that the Start menu entry starts `Circle.exe` with the application's AppUserModelID and that Installed apps lists Circle with the release version, removes it with `msiexec /x` and checks that the folder, the entry and the listing are gone and that `%APPDATA%\Circle` was left alone. The msiexec logs are uploaded when the job fails. The package sets `MSIRESTARTMANAGERCONTROL=Disable`, so Windows Installer's Restart Manager stays out of installing and removing Circle, and out of removing an older version during an upgrade, which reads the older package's value rather than the command line's; on GitHub's Windows runners, machines stopped answering within minutes of an install that went through it: 11 of 22 in a diagnostic run, against none of 22 with it off ([#45](https://github.com/circle-platforms/circle/issues/45)). The MSI takes Circle's version as its own, so a version with a prerelease suffix cannot be released; its UpgradeCode in `apps/desktop/scripts/msi.ts` must never change, or a new version installs beside the old one instead of replacing it. The `Desktop workbench` workflow also builds and validates the MSI on Windows and runs `test:update` on it. Windows gets only the MSI: there is no `.zip` of the desktop application, because only an installed copy can update itself.

| Runner | Desktop asset |
|---|---|
| `macos-15` | `circle-desktop-<version>-darwin-arm64.dmg` |
| `macos-15-intel` | `circle-desktop-<version>-darwin-x64.dmg` |
| `windows-2025` | `circle-desktop-<version>-windows-x64.msi` |
| `ubuntu-24.04` | `circle-desktop-<version>-linux-x64.tar.gz` |

Each has its `.sha256`, so a release has 20 files before `install.sh`, `install.ps1` and `SHA256SUMS` are added. The application takes its version from the root `package.json`.

A target that fails blocks the release: the draft stays unpublished, with the packages of the other targets in it. Do not publish a release by hand with fewer files. Re-run the failed jobs (`gh run rerun <run> --failed`); when they pass, `publish` runs again, puts the rest in the draft and publishes it.

## Rehearse

After changing the release workflow, go through a tag's steps without a tag:

```bash
gh workflow run release.yml --ref <branch> -f rehearse=true
```

It builds and verifies the packages as a tag's run does, with the version in `package.json`, creates a draft named `rehearsal-<run id>`, fills and checks it as `publish` does, and deletes it at the end, whether the run passed or not. It creates no tag and publishes nothing.

## After

- On a clean machine: run the installer from the release notes, then `circle --version`.
- On a machine with the previous version: `circle update`, then restart Circle.
- Fix `docs/known-issues.md` and the install text in `README.md` if they mention the old release.

## A bad release

Do not reuse a version number. People who installed it are "up to date" and will not receive a fix under the same number. Publish `X.Y.(Z+1)` with the fix. To pull the bad one, `gh release delete vX.Y.Z --cleanup-tag`; anyone who already has it can go back with `circle update <good>`.

## How the pieces fit

| Piece | Job |
|---|---|
| `scripts/release.ts` | Sets and checks the version and the changelog. `--notes` prints one version's section for the release page. |
| `scripts/build-release.ts` | Builds the package and its checksum for the current target. |
| `scripts/smoke-release.ts` | Runs the package before it is published. |
| `apps/desktop/test/launch-smoke.mjs` | Starts a packaged desktop application: the window, the bridge to the main process, a turn against a local model, a clean quit. The merge gate and every release run use it. |
| `apps/desktop/scripts/package.mjs` | Packages the desktop application for the current platform, signs it ad hoc on macOS, and writes its archive and checksum. |
| `apps/desktop/scripts/msi.ts` | Holds the WiX package source, builds the Windows MSI from the packaged folder, validates it, and writes its checksum; `apps/desktop/test/msi.test.ts` pins the source and the WiX arguments. |
| `install.sh`, `install.ps1` | Verify the checksum, unpack, and hand the package to `install_manager`. |
| `src/install_manager.ts`, `src/install_layout.ts` | Check and run the new version once, write `versions/<version>`, the launcher, `installation.json` and `current.ref`. |
| `src/update.ts` | `circle update` and the daily check. `circle update` runs the installer that came with the running version. |
| `tests/install-layout.test.ts`, `install-manager.test.ts`, `update-check.test.ts`, `release-script.test.ts`, `version.test.ts` | Pin all of the above without a network. |

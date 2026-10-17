# Circle

Circle's desktop application runs as a native Electron application. It opens its own window, loads bundled local UI resources and provides native menus, folder/file selection, clipboard, export and a sandboxed browser pane. A local web server is not needed to run the application.

The desktop connects to Circle's existing interactive runtime through a bundled Electron utility process. Model/tool execution, approval/question/secret responses, native session branches and import/export, cancellation, jobs and shell commands use the Circle core. The current application contains Circle functionality only.

## Run from source

From the repository root, using Node.js 24:

```sh
npm ci
npm --prefix apps/workbench ci
npm --prefix apps/desktop ci
npm --prefix apps/desktop run dev
```

The default desktop data folder is `Circle` under the operating system's application-data directory. Runtime settings, credentials and SQLite history live in its `runtime-home` subfolder, separate from `~/.circle`. Development or tests can select a dedicated folder with `CIRCLE_WORKBENCH_DATA_DIR`. The default workspace is `runtime-home/workspace`; settings → default workspace saves another folder as `workspace_folder` in `runtime-home/settings.json`, chosen through the native folder dialog and its grant indirection, never a renderer-supplied path. Open a folder and explicitly trust it before Circle loads project context or runs tools. Saving API configuration does not by itself verify an endpoint response.

## Build an application

```sh
npm --prefix apps/desktop run package
```

On Windows, install the pinned UI extension alongside WiX before building the MSI:

```sh
dotnet tool install --global wix --version 5.0.2
wix extension add --global WixToolset.UI.wixext/5.0.2
npm --prefix apps/desktop run package:msi
npm --prefix apps/desktop run test:msi
```

The installer displays Circle's license, the Apache License 2.0, and an unchecked `launch Circle` option on its completion page. Circle starts only when that option is selected and Finish is pressed. Silent installation and the application's updates do not start it through this option. The compiled-MSI check reads its database without installing it or changing system registration.

After a Windows update, Circle restarts with its original arguments. Spaces, literal quotes, trailing backslashes, empty arguments and Unicode paths keep their argument boundaries through the PowerShell installer.

The current host platform is packaged under `apps/desktop/out/` as `circle-desktop-<version>-<os>-<arch>` with a `.sha256` beside it: on macOS `Circle.app`, signed again ad hoc, and a `.dmg` holding it and an Applications-folder link; on Linux a `.tar.gz`. On Windows it leaves the `Circle-win32-x64` folder only: Windows gets the `.msi` alone. The version is Circle's, from the root `package.json`. On Windows, `npm --prefix apps/desktop run package:msi` then builds `circle-desktop-<version>-windows-x64.msi` and its `.sha256` from the packaged `Circle-win32-x64` folder, a per-machine installer for `C:\Program Files\Circle` with a Start menu entry. It needs the WiX Toolset 5.0.2 (`dotnet tool install --global wix --version 5.0.2`), checks the MSI with `wix msi validate`, refuses other hosts and versions with a prerelease suffix, and adds the MSI to `out/artifact-receipt.json`. The `release` workflow builds the same files on four targets, runs each, installs and removes the MSI, and publishes them with every release; these commands do not publish anything or install into Applications or Program Files.

To run a development build beside an installed release, package it as **Circle (beta)**:

```sh
npm --prefix apps/desktop run package:beta
```

It leaves `out/Circle (beta)-<os>-<arch>/` (on macOS `Circle (beta).app`, signed again ad hoc) and no archive. The beta has a bundle id of its own (`com.qingshanfeihu.circle.beta`) and a data folder of its own, `Circle (beta)` under the application-data directory, so it shares no settings, credentials or sessions with the release and both can run at once. It does not update itself, as the release would take its place; check now links to the release page. Copy it where you like, such as `/Applications/Circle (beta).app`.

The desktop package includes the renderer, Circle runtime/dependencies, prompts, model metadata, icon, license and third-party notices. It needs no globally installed Node or Circle executable. Build dependencies are pinned in the repository and application lockfiles.

## Components

- `src/main.ts` owns windows, native menus, the local `circle://workbench` protocol and validated IPC handlers.
- `src/preload.ts` exposes named capabilities rather than an unrestricted IPC or Node API.
- `src/runtime-supervisor.ts` owns the native core process. `src/runtime-controller.ts` translates named commands into existing core APIs and projects actual state; `runtime-worker.ts` hosts it.
- `src/files.ts` reads user-selected files and indexes selected folders. Workspace reads require opaque granted handles and reject unknown handles or symlink escapes.
- `src/browser.ts` keeps one sandboxed native browser per Circle session, which the model drives through the browser tools and the person uses in the panel. It covers dialogs, certificate warnings, downloads, uploads, sign-ins, permissions, client certificates and handoff. The browser identity is stable across inspector switches; capture records its identity, time and content hash.
- `../workbench` provides Circle's session interface and its file/activity/browser components.

Quitting waits for Circle to cancel and close its owned jobs, then waits for its native process to exit. Renderer reload preserves that process. Window close remains separate from future C/D service control. The native browser is shared: the model acts in it with approval, and the person can take it over.

Rejected address input shows `invalid address` and keeps the loaded page. Other navigation errors remain separate from address validation, including when Electron wraps the native error before it reaches the renderer.

`test:mode-tools` exercises the real native runtime with local Anthropic and
OpenAI fixtures. It covers plan transitions inside a three-call tool batch,
plan-to-manual/auto changes and restart, and checks original checkpoint JSON.
`CIRCLE_DESKTOP_EXECUTABLE` selects the packaged executable. The check is also
part of `test:desktop`; it never uses real application data or a paid endpoint.

## Check

```sh
npm --prefix apps/workbench test
npm --prefix apps/desktop test
npm --prefix apps/desktop run test:runtime
npm --prefix apps/desktop run test:mode-tools # Plan transitions, result ordering and restart
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:desktop
npm --prefix apps/desktop run test:interface
npm --prefix apps/desktop run test:live
npm --prefix apps/desktop run test:thinking # API switching and signature recovery; also in test:live
```

The old layout checks explicitly select `CIRCLE_WORKBENCH_MODE=preview`. Ordinary runs use the live adapter. Runtime checks use isolated directories, scripted models and a local HTTP gateway; the live desktop checks also verify actual file/process effects. `CIRCLE_WORKBENCH_TEST_PROFILE` controls development dialog choices, and `CIRCLE_DESKTOP_RUNTIME_FIXTURE` supplies a scripted model only when that test profile is present. Ordinary runs use native dialogs and the configured endpoint.

[Coverage and scope](../../docs/workbench/coverage.md) distinguishes implemented frontend behavior from runtime integration. [Architecture](../../docs/workbench/architecture.md) explains the ownership boundaries and the references used.

[Native validation](../../docs/workbench/validation.md) records the checked source, individual behaviors and development/package receipts.

`test:thinking` drives the restricted native bridge and bundled runtime against a
local Anthropic fixture with isolated settings and checkpoint history. It checks
API switching, legacy signature recovery, unchanged original checkpoints and
restart. Set `CIRCLE_DESKTOP_EXECUTABLE` to a packaged executable to run the same
check on the packaged app; no real API or user data is used.

The native performance check uses twenty real system clipboard pastes of a
600-line original and twenty keyboard clears, reported separately with the same
100 ms feedback budget. It checks trusted paste bytes, the complete attachment
through the existing UI, and restores the original clipboard formats. Earlier
CDP `.fill()` bulk-insert failures remain engineering diagnostics: replacing
that action corrects the paste simulation and does not prove that every raw
multiline insertion meets the event feedback budget.

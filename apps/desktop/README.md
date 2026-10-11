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

The default desktop data folder is `Circle` under the operating system's application-data directory. Runtime settings, credentials and SQLite history live in its `runtime-home` subfolder, separate from `~/.circle`. Development or tests can select a dedicated folder with `CIRCLE_WORKBENCH_DATA_DIR`. Open a folder and explicitly trust it before Circle loads project context or runs tools. Saving API configuration does not by itself verify an endpoint response.

## Build an application

```sh
npm --prefix apps/desktop run package
```

The current host platform is packaged under `apps/desktop/out/`. On macOS this produces `Circle.app` and a `.dmg` containing the application and an Applications-folder link. These are development artifacts; this command does not publish a release or install into Applications.

The desktop package includes the renderer, Circle runtime/dependencies, prompts, model metadata, icon, license and third-party notices. It needs no globally installed Node or Circle executable. Build dependencies are pinned in the repository and application lockfiles.

## Components

- `src/main.ts` owns windows, native menus, the local `circle://workbench` protocol and validated IPC handlers.
- `src/preload.ts` exposes named capabilities rather than an unrestricted IPC or Node API.
- `src/runtime-supervisor.ts` owns the native core process. `src/runtime-controller.ts` translates named commands into existing core APIs and projects actual state; `runtime-worker.ts` hosts it.
- `src/files.ts` reads user-selected files and indexes selected folders. Workspace reads require opaque granted handles and reject unknown handles or symlink escapes.
- `src/browser.ts` keeps one sandboxed native browser per Circle session. The browser identity is stable across inspector switches; capture records its identity, time and content hash.
- `../workbench` provides Circle's session interface and its file/activity/browser components.

Quitting waits for Circle to cancel and close its owned jobs, then waits for its native process to exit. Renderer reload preserves that process. Window close remains separate from future C/D service control. Native browser control is currently by the local operator.

## Check

```sh
npm --prefix apps/workbench test
npm --prefix apps/desktop test
npm --prefix apps/desktop run test:runtime
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:desktop
npm --prefix apps/desktop run test:interface
npm --prefix apps/desktop run test:live
```

The old layout checks explicitly select `CIRCLE_WORKBENCH_MODE=preview`. Ordinary runs use the live adapter. Runtime checks use isolated directories, scripted models and a local HTTP gateway; the live desktop checks also verify actual file/process effects. `CIRCLE_WORKBENCH_TEST_PROFILE` controls development dialog choices, and `CIRCLE_DESKTOP_RUNTIME_FIXTURE` supplies a scripted model only when that test profile is present. Ordinary runs use native dialogs and the configured endpoint.

[Coverage and scope](../../docs/workbench/coverage.md) distinguishes implemented frontend behavior from runtime integration. [Architecture](../../docs/workbench/architecture.md) explains the ownership boundaries and the references used.

[Native validation](../../docs/workbench/validation.md) records the checked source, individual behaviors and development/package receipts.

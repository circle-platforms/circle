---
parent: Development
---

# Native development loop

The desktop application uses the existing `AgentRuntime` with native workspace services. The renderer sends narrow service requests through the preload bridge; it does not choose filesystem roots, subprocess owners or credentials. A selected conversation is a view, not a lock on every other runtime.

## Entry points and ownership

| Area                  | Implementation and entry                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation runtimes | `src/session_manager.ts` and `apps/desktop/src/runtime-controller.ts` retain independent session runtimes and route approvals to their owners.                                                                                                                                                                                                                                                                             |
| Workspace services    | `apps/desktop/src/workspace/workspace-services.ts` owns documents, terminals, Git and delivery for a granted workspace. `workspace-protocol.ts` validates the service/method surface.                                                                                                                                                                                                                                      |
| Development UI        | `App.tsx` retains the original main file/conversation area and resizable Inspector. `FileViewer.tsx` hosts Monaco and versioned saves. `TerminalMode.tsx` and `NativeTerminal.tsx` put shells, background commands and device consoles in the terminal mode, `ChangesMode.tsx` the changed files in the changes mode, and `TaskReviewCard.tsx` a task's review in its own conversation, using existing controls and theme. |
| Collaboration         | `TaskService`, `CollaborationScheduler` and task worktrees bind a task to its baseline, dependencies, session, access and attempt. Default shared limits are eight model requests, two builds, one foreground UI task and one browser resource. Settings can change supported limits; foreground UI remains serialized.                                                                                                    |
| Browser acceptance    | `NativeBrowser` shows the page in a native view and opens Chromium's own developer tools. The model's browser tools, including recording and replay, stay on that controller's ownership and approval path. The native view hides when its tab, the inspector, or a dialog or menu covers it, and resizes with the panel.                                                                                                  |
| GitHub                | `github-connection.ts` holds the account connection that the GitHub plugin details manage. `github-backend.ts` serves the bundled `github` extension's tools: it checks each call against the connected account epoch and the trusted workspace remote, and publishes, reads checks and logs and retries runs through `DeliveryService` (`delivery.ts`).                                                                   |

The GitHub plugin details (`/page/extensions?plugin=github`) are the account connection and management entry. Settings links there and shares the same profile connection. The bundled `github` runtime extension exposes repository tools only with an enabled provider and a connected account. Repository access follows that account's GitHub permissions; operations remain bound to the trusted workspace remote. Once an account is connected, `try in a conversation` prepares a read-only connection example in the original conversation's unsent draft; it does not submit it. Local adapter tests do not establish live authorization, repository permissions or hosted CI for a release.

Node, npm and GitHub CLI are prepared by `apps/desktop/scripts/developer-toolchain.mjs`. Their versions and archive hashes are pinned there. The packaged Node/npm paths are selected by the trusted main process. The PTY binding loads only when a terminal is used, so importing an ordinary model worker does not load optional desktop dependencies. Both ESM worker and CJS main bundles resolve these resources next to the bundle.

## Editing and approval

Human saves and the built-in agent file tools share `WorkspaceDocuments`. Reads return a revision derived from identity, timestamps and content. A save requires the revision it was edited from; a new file requires an explicit null revision. Conflicts retain the developer's buffer and expose the disk version for review. Opening a file, saving another file and navigating a session do not require pausing an agent turn.

File tools prepare read-only snapshots after policy/read-only denial checks and before waiting for approval. Approved writes revalidate those snapshots through the shared document service. Patch plans include deletion and both ends of a move. An approval is not permission to overwrite a later human edit. Arbitrary shell commands and extension code are external writers, not intercepted file transactions.

A batch checks all revisions before staging and again before replacement. It is not a cross-file filesystem transaction: an I/O error, external change or cancellation can leave a committed prefix. `committedPaths`, `failures` and `remaining` describe the actual result; recovery must not replay that prefix. See [Workspace documents](workspace-documents.md) for the API and filesystem race boundary.

## Tasks and evidence

Write tasks get isolated Git worktrees. Read-only task runtimes cannot write a plan, launch commands or gain write tools through child agents. Runtime cleanup precedes candidate capture, and a changed candidate after verification requires another review. Integration checks the candidate patch hash and uses an owned integration worktree rather than staging the developer's source checkout.

The task verifier is cached against an immutable baseline before the writer starts. It runs fixed baseline package scripts and protected oracle inputs against a copy of the candidate, records real exit codes and full logs, and can request an independent read-only source review. A worker's completion message is not a check. Acceptance criteria without suitable command or review evidence remain `needs_review`. See [Independent task verification](task-verification.md).

## Reload and restart

Workspace events carry workspace/session/resource identities, epoch, sequence and a durable recovery cursor. Resource subscriptions support replaying missed events, and model tokens use a separate delta stream. Lifecycle and tool-state changes publish a snapshot, but stored history does not travel with it: `runtime-history-wire.ts` in the worker sends the rows of each session and agent that changed, and the main process and each window put the rest back from what they hold. A window that missed a publication asks for the state, and the main process, which has all of it, answers; if the main process itself loses its place it asks the worker for a publication with every history whole. The controller keeps a row's object while what it was made of is unchanged and does not read history whose head, extent, labels and live state have not moved, so a publication costs what changed. In the window, transcript rows keep their objects across publications and are memoized: `MessageView` and `ToolGroup` read the snapshot through `useRuntimeSelector`, so a publication renders the rows it changed. `apps/desktop/scripts/benchmark-publish.ts` measures the stages in Node and `benchmark-publish-native.mjs` the same store through real Electron. Command acknowledgments avoid an extra state fetch only when the renderer has already received the relevant full publication. Complete terminal output stays in terminal logs; a bounded on-screen ring is not the archive. See [Workspace event streams](workspace-event-stream.md).

Each workspace journal also holds an exclusive SQLite write lease in a separate `.owner.sqlite` file before opening or recovering its JSONL evidence. Another connection, including one in the same process, fails before changing the journal. The lease lasts until close, and the operating system releases it if the writer dies. Recovery therefore does not delete stale PID files or permit two writers to repair the same tail concurrently.

Reloading the renderer reconnects to the running backend. A full application restart restores persisted task/operation records and terminal logs. Unconfirmed old processes are marked interrupted; stored commands are not automatically reexecuted or signalled by their old PID. Operations whose effects cannot be established become `needs_review` and require an explicit human reconciliation. Closing a panel, cancelling an agent and stopping an owned process remain separate actions.

Pending steering and follow-up inputs are stored in `src/input_outbox.ts` in the session checkpoint database, including full text, original display, folded paste payloads and media bytes. A new Harness epoch moves old queued inputs to `recovery_pending` rather than sending them with a new prompt. The conversation's recovered-input panel offers explicit resume, copy to draft and discard choices. Copying appends the full text and media to the current draft without sending or removing the recovery copy; discarding requires the panel's separate confirmation. Resolution checks the session owner, input identities and recovery version, and repeated operation IDs do not start another run. Consuming an input and checkpointing its user message happen in the same transaction, so a consumed input is not automatically replayed after an interrupted model request. Application shutdown preserves unconsumed inputs for recovery; an explicit user cancellation discards the current live queue.

## Isolated verification

Use scratch `CIRCLE_HOME` and `CIRCLE_WORKBENCH_DATA_DIR`, synthetic repositories and `ScriptedModel` or a local gateway. Never run verification against the real Circle home or production credentials. Root CLI checks do not require installing desktop dependencies:

```sh
npm ci
npm run check
```

Desktop checks require the desktop/workbench dependencies. Preparing pinned developer tools may download their archives once; after that a build reuses the tools in `apps/desktop/dist/tools` while their receipts match the folder, and says for each tool whether it reused it or downloads it and why. A download that cannot connect, or gets a busy answer, is tried six times over about a minute; CI keeps the folder between runs. On macOS, `npm --prefix apps/desktop ci` also builds node-pty from source for arm64 and x64 (`scripts/node-pty-macos.mjs`): node-pty 1.1.0 leaks three descriptors each time it starts a terminal there, and the fixes from node-pty#882 and #931 are applied to its source first. This needs the Xcode Command Line Tools and npm's node-gyp, which may download Node's headers once; the script refuses any other node-pty version or source, so an upgrade has to drop or update it. Native UI checks share a foreground desktop and must run serially:

```sh
npm --prefix apps/desktop ci
npm --prefix apps/workbench ci
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:runtime
npm --prefix apps/desktop run test:developer
npm --prefix apps/desktop run test:journey
npm --prefix apps/desktop run test:performance
```

The native journey writes evidence to `apps/desktop/artifacts/native-developer-journey/` by default; `CIRCLE_NATIVE_JOURNEY_EVIDENCE` chooses another output directory. To exercise a packaged candidate, set `CIRCLE_DESKTOP_EXECUTABLE` to its actual executable and `CIRCLE_DESKTOP_APP_PATH` to its packaged application directory before running the same journey. The `Desktop workbench` workflow has path filters for pull requests and pushes to main. Its pull-request jobs run the development journey, `test:desktop` and `test:live` in the development application, and package it and run `test:update` on the package; its non-pull-request jobs also run the packaged journey, `test:desktop` and `test:live` in the packaged application for their configured native targets. Evidence must identify the tested candidate. A development build, a storage microbenchmark or a scripted GitHub adapter does not establish packaged-platform performance or live hosted PR/CI acceptance. Remaining limits are recorded in [Known issues](../known-issues.md#desktop-application).

The publication benchmarks run from the repository root on a scratch home and a scripted model. `benchmark-publish.ts` runs in Node; `benchmark-publish-native.mjs` runs Electron and needs `npm --prefix apps/desktop run build` first. Both take `--sessions` (stored sessions, default 10), `--messages` (messages in each, 300), `--publishes` (idle publications to time, 20) and `--tool-calls` (tool calls of the measured turn, 10); the native one also takes `--profile <file>` for the renderer's CPU profile and `--app <folder>` for another build of `apps/desktop`.

```sh
node --import tsx apps/desktop/scripts/benchmark-publish.ts --sessions 40 --messages 1000
node --import tsx apps/desktop/scripts/benchmark-publish.ts --subagents 8 --subagent-steps 20 --children 60
```

With `--subagents N` the Node benchmark then runs a turn that starts N subagents at once. Each makes `--subagent-steps` tool calls (default 10) before its report and streams `--subagent-tokens` tokens in each model call (default 20). `--children N` first stores N finished subagents of the open session, with `--child-messages` messages each (default 40). For that turn it reports the publications by event, the time each took in the runtime (mean and p95), how often `snapshot()` and `AgentRuntime.stats()` ran, and what the main process's buffer did with each token delta; a delta it could not apply is a resync, a state request the windows wait for.

## Native performance suite

`npm --prefix apps/desktop run test:performance` (`apps/desktop/test/native-performance.mjs`) times a developer's actions in the real development application while it carries load: a stored conversation of 10,000 messages, eight scripted agents streaming as background tasks, and a shell in the terminal mode that prints a line every 50 ms. A sample runs from a trusted input event to the second animation frame that shows its result: the message box's text and send button, the terminal mode open or closed, the conversation with its title, the file in the files mode, the editor saying the change is saved. A terminal line is timed from the moment the program that printed it wrote it. The suite then checks the effects behind them: the stored draft and its pasted text, the reading position, the file on disk, the terminal's own record of its output. It first sizes the window to 1400 by 900 CSS pixels, less in height when the display has no room for that, so that the modes open beside the conversation; in a window 1050 pixels wide or narrower a mode lies over the conversation and its message box, and a CI runner's 1024 by 768 screen would otherwise give it such a window. `report.json` records the size under `viewport`.

| Metric           | What is timed                                                                      | Samples    | p95 budget |
| ---------------- | ---------------------------------------------------------------------------------- | ---------- | ---------- |
| `inputKeystroke` | a key in the message box                                                           | 40         | 100 ms     |
| `inputPaste`     | a system-clipboard paste of 600 lines                                              | 20         | 100 ms     |
| `inputClear`     | deleting the selected draft                                                        | 20         | 100 ms     |
| `click`          | the terminal mode's button, closing and opening                                    | 40         | 100 ms     |
| `eventToFrame`   | a terminal line, from the program that printed it to the xterm frame that shows it | 20 or more | 200 ms     |
| `sessionSwitch`  | a conversation chosen in search                                                    | 24         | 300 ms     |
| `fileSwitch`     | a file link in the conversation                                                    | 24         | 300 ms     |
| `save`           | saving the file in the editor                                                      | 24         | 500 ms     |

The suite starts only with a manifest of the build it is about to run, and checks the main, preload, worker and renderer files the window loaded against it. From the repository root, record the source before the build and the manifest after it:

```sh
perf=$(mktemp -d)
node apps/desktop/scripts/native-build-manifest.mjs capture --root "$PWD" --output "$perf/source-receipt.json"
npm --prefix apps/desktop run build
node apps/desktop/scripts/native-build-manifest.mjs create --root "$PWD" --receipt "$perf/source-receipt.json" --app apps/desktop --output "$perf/build-manifest.json"
CIRCLE_NATIVE_PERF_BUILD_MANIFEST="$perf/build-manifest.json" npm --prefix apps/desktop run test:performance
```

`capture` refuses a tree with uncommitted changes; pass `--allow-working-tree` to both `capture` and `create` to record each file's hash instead of a commit. A build input changed between the two makes `create` fail. A change to the tests alone needs no new manifest.

The suite makes its own workspace, Circle home and data folder in a temporary folder and never opens the real ones. It brings a window to the front and types into it, so leave the keyboard and mouse alone while it runs (about a minute on an Apple M4). It uses the system clipboard: it saves every format before the first paste and puts them back at the end, comparing each byte. When they do not compare, it reports the clipboard as not restored, keeps the application open and waits; creating `retry-clipboard` in the attempt's folder tries again. A file copied in Finder does not come back exactly ([Known issues](../known-issues.md#desktop-application)): copy some text before a run.

Each run writes a folder `attempt-<time>-<id>` under `CIRCLE_NATIVE_PERF_OUTPUT`, or under `evidence` in the suite's temporary folder; the summary it prints at the end names it. `report.json` has every sample, each metric's p95 against its budget, the checks that held, the hashes of the build that ran and any failure; `samples-before-cleanup.json` has the samples alone, and `initial-transcript.png`, `native-performance.png` or `failure.png` show the window. `CIRCLE_NATIVE_PERF_DIAGNOSTICS=1` adds main, renderer and worker timing in `stage-diagnostics.json`, and `CIRCLE_NATIVE_PERF_CPU_PROFILE=1` a renderer profile in `renderer.cpuprofile` and the reading position in `reading-trace.json`.

A run fails when it does not finish, when an effect it waits for does not happen, when the window throws an error, when the stored conversation shows no message on opening, or when the clipboard is not restored. A metric whose p95 is over its budget fails the run too, unless `CIRCLE_NATIVE_PERF_BUDGETS=report` is set: then it is reported and the exit status is left to the other checks.

### In CI

On pushes to main, the `Desktop workbench` workflow's Apple silicon job (`darwin-arm64`) records the manifest around its development build and runs the suite in the development application after its other checks, with `CIRCLE_NATIVE_PERF_BUDGETS=report`. There the budgets are reported, not enforced. A GitHub runner is a shared virtual machine, and how long a key takes on it depends as much on what else the host runs as on the change, so a fixed threshold would fail commits at random ([rule 2 of Writing reliable tests](testing.md)). Everything else still fails the job: an effect that does not happen, an unfinished run, an error in the window.

The numbers are in three places: the job's summary has a table of each metric's samples, p95, budget and result; each metric over its budget adds a warning annotation to the run; and the job's `circle-desktop-darwin-arm64-native` artifact holds the evidence under `apps/desktop/artifacts/native-performance/`, with the source receipt and build manifest beside it. A latency claim needs a local run with the budgets enforced.

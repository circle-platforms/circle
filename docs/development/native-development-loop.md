---
parent: Development
---

# Native development loop

The desktop application uses the existing `AgentRuntime` with native workspace services. The renderer sends narrow service requests through the preload bridge; it does not choose filesystem roots, subprocess owners or credentials. A selected conversation is a view, not a lock on every other runtime.

## Entry points and ownership

| Area                  | Implementation and entry                                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation runtimes | `src/session_manager.ts` and `apps/desktop/src/runtime-controller.ts` retain independent session runtimes and route approvals to their owners.                                                                                                                                                                          |
| Workspace services    | `apps/desktop/src/workspace/workspace-services.ts` owns documents, terminals, language services, debugger, Git and delivery for a granted workspace. `workspace-protocol.ts` validates the service/method surface.                                                                                                      |
| Development UI        | `App.tsx` retains the original main file/conversation area and resizable Inspector. `FileViewer.tsx` hosts Monaco and versioned saves. `WorkspacePanelContents.tsx` places interactive terminals in Terminal, Git and delivery in Changes, and tasks and debugging in Activity, using existing controls and theme.      |
| Collaboration         | `TaskService`, `CollaborationScheduler` and task worktrees bind a task to its baseline, dependencies, session, access and attempt. Default shared limits are eight model requests, two builds, one foreground UI task and one browser resource. Settings can change supported limits; foreground UI remains serialized. |
| Browser acceptance    | `NativeBrowser` and `BrowserDiagnostics` expose console, network, storage, viewport and source/debug actions through the existing browser controller. Browser recording/replay remains on that controller's ownership and approval path.                                                                                |
| Delivery              | `delivery-cycle.ts` coordinates tasks, verification, publication and CI. `cycle-ports.ts` binds it to owned integration worktrees, Git, task verification and the bundled GitHub CLI. The renderer opens these controls in automatic delivery.                                                                          |

The GitHub plugin details (`/page/extensions?plugin=github`) are the account connection and management entry. Settings and automatic delivery link there and share the same profile connection. The bundled `github` runtime extension exposes repository tools only with an enabled provider, a connected account and explicitly allowed repositories. Once an account is connected, `try in a conversation` prepares a read-only connection example in the original conversation's unsent draft; it does not submit it. Local adapter tests do not establish live authorization, repository permissions or hosted CI for a release.

Node, npm, GitHub CLI and the JavaScript debug adapter are prepared by `apps/desktop/scripts/developer-toolchain.mjs`. Their versions and archive hashes are pinned there. The packaged Node/npm paths are selected by the trusted main process. PTY and TypeScript bindings load only when their services are used, so importing an ordinary model worker does not load optional desktop dependencies. Both ESM worker and CJS main bundles resolve these resources next to the bundle.

## Editing and approval

Human saves and the built-in agent file tools share `WorkspaceDocuments`. Reads return a revision derived from identity, timestamps and content. A save requires the revision it was edited from; a new file requires an explicit null revision. Conflicts retain the developer's buffer and expose the disk version for review. Opening a file, saving another file and navigating a session do not require pausing an agent turn.

File tools prepare read-only snapshots after policy/read-only denial checks and before waiting for approval. Approved writes revalidate those snapshots through the shared document service. Patch plans include deletion and both ends of a move. An approval is not permission to overwrite a later human edit. Arbitrary shell commands and extension code are external writers, not intercepted file transactions.

A batch checks all revisions before staging and again before replacement. It is not a cross-file filesystem transaction: an I/O error, external change or cancellation can leave a committed prefix. `committedPaths`, `failures` and `remaining` describe the actual result; recovery must not replay that prefix. See [Workspace documents](workspace-documents.md) for the API and filesystem race boundary.

Language overlays provide unsaved content without writing it to disk. Definitions, references, semantic rename, formatting and diagnostics use the bundled TypeScript service. Opening Markdown or JSON does not add those buffers as extra TypeScript program roots. Project configuration errors remain distinct diagnostics.

Node debugging uses DAP's `runInTerminal` request to create a real session-owned PTY through `WorkspaceServices`, including literal arguments and empty arguments. The existing Terminal Inspector can send stdin and replay the debuggee's output. Launch environment changes come from the trusted debug adapter; their values stay in private in-memory terminal state rather than terminal snapshots or persisted history. A restored terminal with an unavailable launch environment must be relaunched from its debugger or task. Debug stop closes that session's tracked debug terminals; another session cannot write to or stop them through its own terminal identity.

## Tasks, evidence and delivery

Write tasks get isolated Git worktrees. Read-only task runtimes cannot write a plan, launch commands or gain write tools through child agents. Runtime cleanup precedes candidate capture, and a changed candidate after verification requires another review. Integration checks the candidate patch hash and uses an owned integration worktree rather than staging the developer's source checkout.

The task verifier is cached against an immutable baseline before the writer starts. It runs fixed baseline package scripts and protected oracle inputs against a copy of the candidate, records real exit codes and full logs, and can request an independent read-only source review. A worker's completion message is not a check. Acceptance criteria without suitable command or review evidence remain `needs_review`. See [Independent task verification](task-verification.md).

Automatic delivery creates and maintains a draft PR using the configured repository identity and GitHub authorization. It checks the published HEAD before trusting CI, collects failed-check logs and schedules repairs. A repeated failure fingerprint dispatches diagnosis after three occurrences and requires review of the revised plan. Successful verification and CI move the cycle to `pending_human_merge`; this service does not merge the PR.

## Reload and restart

Workspace events carry workspace/session/resource identities, epoch, sequence and a durable recovery cursor. Resource subscriptions support replaying missed events, and model tokens use a separate delta stream. Lifecycle and tool-state changes can still publish full conversation snapshots. Command acknowledgments avoid an extra state fetch only when the renderer has already received the relevant full publication. Complete terminal output stays in terminal logs; a bounded on-screen ring is not the archive. See [Workspace event streams](workspace-event-stream.md).

Each workspace journal also holds an exclusive SQLite write lease in a separate `.owner.sqlite` file before opening or recovering its JSONL evidence. Another connection, including one in the same process, fails before changing the journal. The lease lasts until close, and the operating system releases it if the writer dies. Recovery therefore does not delete stale PID files or permit two writers to repair the same tail concurrently.

Reloading the renderer reconnects to the running backend. A full application restart restores persisted task/operation records and terminal logs. Unconfirmed old processes are marked interrupted; stored commands are not automatically reexecuted or signalled by their old PID. Operations whose effects cannot be established become `needs_review` and require an explicit human reconciliation. Closing a panel, cancelling an agent and stopping an owned process remain separate actions.

Pending steering and follow-up inputs are stored in `src/input_outbox.ts` in the session checkpoint database, including full text, original display, folded paste payloads and media bytes. A new Harness epoch moves old queued inputs to `recovery_pending` rather than sending them with a new prompt. The conversation's recovered-input panel offers explicit resume, copy to draft and discard choices. Copying appends the full text and media to the current draft without sending or removing the recovery copy; discarding requires the panel's separate confirmation. Resolution checks the session owner, input identities and recovery version, and repeated operation IDs do not start another run. Consuming an input and checkpointing its user message happen in the same transaction, so a consumed input is not automatically replayed after an interrupted model request. Application shutdown preserves unconsumed inputs for recovery; an explicit user cancellation discards the current live queue.

## Isolated verification

Use scratch `CIRCLE_HOME` and `CIRCLE_WORKBENCH_DATA_DIR`, synthetic repositories and `ScriptedModel` or a local gateway. Never run verification against the real Circle home or production credentials. Root CLI checks do not require installing desktop dependencies:

```sh
npm ci
npm run check
```

Desktop checks require the desktop/workbench dependencies. Preparing pinned developer tools may download their archives once. Native UI checks share a foreground desktop and must run serially:

```sh
npm --prefix apps/desktop ci
npm --prefix apps/workbench ci
npm --prefix apps/desktop run build
npm --prefix apps/desktop run test:runtime
npm --prefix apps/desktop run test:developer
npm --prefix apps/desktop run test:browser-diagnostics
npm --prefix apps/desktop run test:journey
npm --prefix apps/desktop run test:performance
```

The native journey writes evidence to `apps/desktop/artifacts/native-developer-journey/` by default; `CIRCLE_NATIVE_JOURNEY_EVIDENCE` chooses another output directory. To exercise a packaged candidate, set `CIRCLE_DESKTOP_EXECUTABLE` to its actual executable and `CIRCLE_DESKTOP_APP_PATH` to its packaged application directory before running the same journey. The `Desktop workbench` workflow has path filters for pull requests and pushes to main. Its pull-request jobs run the development journey; its non-pull-request jobs also run the packaged journey for their configured native targets. Evidence must identify the tested candidate. A development build, a storage microbenchmark or a scripted GitHub adapter does not establish packaged-platform performance or live hosted PR/CI acceptance. Remaining limits are recorded in [Known issues](../known-issues.md#desktop-application).

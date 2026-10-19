---
parent: Development
nav_order: 10
---

# Desktop workbench interaction model

The desktop's right-hand side is the overview, a column of view-only cards pinned beside the conversation, and a work drawer beside it whose modes are files, changes, browser, subagents and terminal. A file or change index belongs inside its mode; it is not another application sidebar. The renderer keeps Circle's theme, text-size preferences and bilingual interface words.

This page describes the source in this checkout. It does not establish that an older installed application contains these changes, or that a candidate has passed native or packaged acceptance.

## Layout and ownership

[PanelButtons and Inspector](../../apps/workbench/src/features/Panels.tsx) provide the top bar's icon buttons (named `overview panel`, `files panel` and so on, with the count of running subagents and background commands on theirs) and the drawer, which has no heading of its own. Selecting the active mode, or `esc`, closes the drawer; selecting another mode opens it in the same container. Each mode ends its own toolbar with what [mode-chrome](../../apps/workbench/src/features/mode-chrome.tsx) offers: full view, and for the browser and the terminal a window of their own. The [application shell](../../apps/workbench/src/app/App.tsx) places the overview and the drawer with the rules in [workspace-layout](../../apps/workbench/src/app/workspace-layout.ts): the overview is 380 pixels, the conversation keeps 420, a mode opens at its last width (files and subagents as a 300-pixel list, 760 with a document open), the overview steps aside when the conversation would be squeezed and comes back with the room, and the sidebar folds for a document that needs its room. Full view keeps the composer and pending interactions available.

`InspectorResources` retains visited resource subtrees while switching modes. `DrawerFiles` puts the file index beside the document and hides it when appropriate for the available width. Hiding the index does not recreate the document editor. Closing or hiding a resource surface is a navigation action, not a request to cancel the task or process it displays. Actual resource lifetime is owned by the host and its session, not the position of a tab.

The [overview](../../apps/workbench/src/features/Overview.tsx) has these cards, projected from the active session ([model](../../apps/workbench/src/model/overview.ts)); a card with nothing in it is not drawn, except environment and context:

| Card              | Source and meaning                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs your review | Operations an interrupted run left for the person to settle ([PendingOperations](../../apps/workbench/src/features/PendingOperations.tsx))                  |
| Environment       | This machine, the workspace folder and its branch                                                                                                           |
| Context           | The [context usage](../../apps/workbench/src/model/context-usage.ts) of the last answer, with tokens, cost, cache and the instruction files folded under it |
| In progress       | The current plan step, the subagents at work with what Circle sent each to do, and unfinished tasks                                                         |
| Outputs           | The session's recorded text-tool file changes, M, A or D                                                                                                    |
| Changes           | The repository's lines changed since the last commit, the create or update pull request button and the pull requests, read by the `pulls` service           |

Unavailable context usage is shown as unavailable. It is not a fabricated zero. The outputs card is not the repository's Git status; the two sources have different coverage. The pull request button only asks Circle to run the built-in `create-pr` skill in the conversation.

## Resource indexes and search scopes

The project and Git file trees use the shared [VirtualFileTree](../../apps/workbench/src/components/VirtualFileTree.tsx). It renders the visible window plus the active keyboard row rather than mounting the entire expanded tree. Arrow keys, page navigation, parent/child navigation and selection work against the full flattened tree. Selection, expansion, filtering and scroll restoration remain tied to their resource owner.

Both indexes use [ResizableContextIndex](../../apps/workbench/src/components/ResizableContextIndex.tsx). Dragging its separator resizes the internal index, not the whole work drawer. The same separator accepts keyboard resizing and exposes its orientation, current width and bounds to assistive technology. Width preferences are stored by owner and resource; a failed storage write does not prevent in-memory use. The preferred width is clamped to the available space. In a narrow resource surface the index becomes an internal overlay, and hiding it leaves the document/resource mounted.

The files index filters workspace file paths. It opens a document through the granted workspace and preserves the current document when the index is hidden. Global conversation search, the file filter, editor text search and the Git changed-file locator are separate searches. Local resource search does not send a message to the model.

[ChangesMode](../../apps/workbench/src/features/ChangesMode.tsx) is one list of changed files, M, A or D with their lines, for this session or for everything uncommitted, with the difference of the selected file and **open file**. It reads; the window cannot stage, commit, push or merge, and the [workspace protocol](../../apps/desktop/src/workspace-protocol.ts) refuses those requests from the renderer. The native [Git workspace service](../../apps/desktop/src/workspace/git.ts) supplies the changed files and each file's patch against the last commit; the same patch gives the [change marks](../../apps/workbench/src/model/gutter-marks.ts) beside an open file's line numbers, and the [changed files](../../apps/workbench/src/model/changed-files.ts) colour the files tree. A stale response must not replace the current selection.

Session changes remain a different view from Git changes. Session changes cover the text-tool observations recorded during the running application; Git can also report changes made by commands or another program.

## Incremental native file discovery

The native [Files.open / nextPage](../../apps/desktop/src/files.ts) path discovers metadata incrementally through [discoverWorkspace](../../apps/desktop/src/workspace-discovery.ts). A page contains at most 2,000 file records and an opaque continuation cursor while more discovery remains. Each continuation rechecks the captured workspace root identity and the active grant. A continuation is consumed once; cancellation closes its iterator. File IDs remain host-owned handles, not renderer-supplied filesystem authority.

Discovery is explicitly bounded to 100,000 files, 250,000 visited directory entries and depth 128. Credential names, application-private/build/dependency directories, symbolic links and multiply linked files are excluded. A stopped or inaccessible traversal marks the listing incomplete; the files panel separately shows loaded count, loading, incomplete and error states. Filtering searches the currently discovered records and does not imply that an incomplete repository listing is exhaustive.

These are discovery and renderer bounds. Pagination and a virtualized tree do not establish a 100,000-file live watcher or a complete large-repository performance guarantee. The document service's watcher and transaction limits remain independent.

## One document, multiple presentations

[FileViewer](../../apps/workbench/src/features/FileViewer.tsx) owns the document identity, editor buffer, revision and save/conflict state. Markdown reading renders the same retained buffer through `Markdown`; it does not fetch a separate saved copy. Source, diff and reading are presentation choices. Selecting reading neither saves a draft nor overwrites a file, and the native editor stays mounted while hidden.

Save and conflict controls keep their real meaning. An unsaved buffer is different from disk content. A changed revision is handled as a conflict rather than silently replacing the other writer's version. Workspace paths and document identities remain host-bound even when the selected project or visible panel changes.

## Controls, task states and review evidence

[workbench-unified.css](../../apps/workbench/src/styles/workbench-unified.css) supplies spacing, control height and radius tokens using the existing theme semantics. It does not replace terminal or Monaco syntax colours. Labelled controls are used for resource modes and local tabs; compact icon controls retain accessible names and focused/hovered explanations. English labels remain short and lowercase, and the desktop translations use `t()`.

Tasks are made, started and retried by Circle; the sidebar lists them under their conversation and the overview shows those in progress. A task that needs review shows [TaskReviewCard](../../apps/workbench/src/features/TaskReviewCard.tsx) at the end of its own conversation. [TaskEvidence](../../apps/workbench/src/features/TaskEvidence.tsx) only projects checks for the exact persisted task and attempt. A command failure and its exit code remain visible; a human review is labelled separately from an independent reviewer or command check. Missing checks are not synthesized from a worker's completion answer.

The [independent verifier](../../apps/desktop/src/workspace/task-verification.ts) includes bounded, redacted actual worker process evidence in its request. It retains failures and command execution results and treats the worker answer as an unverified claim. A command returning zero, a test check passing and every task acceptance criterion passing are different facts. The review card requires explicit evidence for every criterion and pins the attempt and patch hash; sending a task back requires a reason and pins the same identity. Viewing an artifact does not by itself record a passing review.

## File undo is a separate, bounded operation

The message's **undo file changes** action uses [SafeFileUndo](../../apps/workbench/src/features/SafeFileUndo.tsx), the controller's `preview-file-undo` / `restore-turn-files` requests, and [FileRewindJournal](../../src/file_rewind.ts). It is separate from `/undo` and conversation-tree navigation.

The journal records before/after versions only for text-tool mutations attached to an actual turn in the current runtime. The user first previews the affected paths, then explicitly confirms restoration. The host checks every current revision again before restoring. External changes, an incomplete journal or an unsupported backend prevent restoration. Plan mode allows preview but refuses restoration.

The journal is in memory and bound to its runtime. It is not reconstructed from historical messages after restart. Shell commands, Git commands, external services and other unrecorded effects are not covered. This is not full historical rollback or general Bash undo. The original conversation remains intact after a file restore.

## Exact external text-file grants

The files index footer's **external files** control and the settings entry open [ExternalFileAccessPanel](../../apps/workbench/src/features/ExternalFileAccess.tsx) for the current conversation. The user chooses read or read/write access, then selects one existing file in the native operating-system picker. A path typed by the renderer or model cannot mint authority. [NativeExternalFilePicker](../../apps/desktop/src/external-file-picker.ts) rechecks the active session after asynchronous picker and worker boundaries; a late selection is rejected or revoked.

The [runtime controller](../../apps/desktop/src/runtime-controller.ts) mints grants only through its private native capability path, binds them to the exact runtime/session owner, and dispatches authorized external reads, mutations and undo to [ExternalFileGrants](../../apps/desktop/src/workspace/external-file-grants.ts). Grants are held in memory. They are not inherited by another conversation, fork or task session, and they do not survive application restart. Archiving/deleting or retiring the owner removes its authority. A read grant does not allow writes; plan mode permits authorized reads but refuses writes.

The core path is `read_file` in [tools.ts](../../src/tools.ts) and `FileMutationTools.authorize / read / snapshot / commit` in [file_mutations.ts](../../src/file_mutations.ts). Native external text reads use the same session-specific version tracker as edits. An ordinary tool approval never creates a file grant or extends its scope. Preparation and commit check authority and expected revisions; the backend rechecks exact-file identity and grant state at its own transaction boundary. Revocation denies new calls immediately and drains already dispatched filesystem work before acknowledging completion. Re-granting a file does not revive an old preview.

Scope remains exact and conservative:

- Only an existing regular text file may be granted. A parent directory, sibling file, new file, symbolic/hard link, credential file or protected application-data path is not covered.
- Native external directory and media reads are unsupported. A shell command, MCP server, editor workspace or external service does not inherit this capability.
- A patch or undo batch cannot mix workspace and external-file transaction domains. Split the work explicitly; rejection occurs before that mixed batch writes files.
- External undo still requires the current grant and the recorded revisions. Revocation, file replacement or changed revisions prevent it.

These checks do not provide a portable filesystem compare-and-swap against an unrelated process that does not participate in Circle's queue. The existing [native multi-file save limitation](../known-issues.md#desktop-application) still applies. CLI tools without the injected native backend retain their existing external-path behavior. This grant flow addresses the native Read/Edit scope mismatch recorded as G06 without claiming generic access to every external operation.

## Validation boundaries

The focused `task-evidence.test.ts` checks exact task/attempt identity, rejected worker claims and the distinction between failure, missing verification and human evidence. The `task-review-ui.mjs` fixture drives the review card and the send-back with their actual outgoing payloads in headless Chrome. This is renderer fixture evidence; it is not a native application or packaged acceptance result.

The core `external-file-mutations.test.ts` and existing `file-mutations.test.ts` passed 15 focused tests during this implementation, including real temporary-file effects, session isolation, a grant revoked during an actual scripted approval, the next model request and balanced stored tool history. Those tests use a scripted model and an injected backend; they do not establish the native picker or packaged bridge by themselves.

Other useful regression entry points include `drawer-shell.test.ts`, `workspace-layout.test.ts`, `workspace-shell-ui.mjs`, `workspace-layout-ui.mjs`, `editor-ui.mjs`, `runtime-file-rewind.test.ts`, `safe-file-undo-ui.mjs` and `task-verification.test.ts`. Their presence does not assert they passed for the current candidate. Consult the candidate's recorded CLI, workbench, native and packaged run results before making a release claim.

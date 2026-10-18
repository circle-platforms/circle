---
parent: Development
nav_order: 10
---

# Desktop workbench interaction model

The desktop uses one work drawer beside the conversation. Overview cards and resource views are modes of that drawer. A file or change index belongs inside the resource view; it is not another application sidebar. The renderer keeps Circle's theme, text-size preferences and bilingual interface words.

This page describes the source in this checkout. It does not establish that an older installed application contains these changes, or that a candidate has passed native or packaged acceptance.

## Layout and ownership

[PanelButtons and Inspector](../../apps/workbench/src/features/Panels.tsx) provide labelled mode controls and a single drawer heading. Selecting the active mode closes the drawer. Selecting another mode opens it in the same container. The [application shell](../../apps/workbench/src/app/App.tsx) uses a narrower overview width and a separately retained resource width. Resource full view uses the existing shell mechanism; it keeps the composer and pending interactions available.

`InspectorResources` retains visited resource subtrees while switching modes. `DrawerFiles` puts the file index beside the document and hides it when appropriate for the available width. Hiding the index does not recreate the document editor. Closing or hiding a resource surface is a navigation action, not a request to cancel the task or process it displays. Actual resource lifetime is owned by the host and its session, not the position of a tab.

The overview has five sections, all projected from the active session:

| Section          | Source and meaning                                                         |
| ---------------- | -------------------------------------------------------------------------- |
| Environment      | Workspace identity/path, recorded branch, model and mode                   |
| Context          | Recorded context input/window, when available, plus attached context count |
| Outputs          | Deduplicated non-user message and tool attachments                         |
| Changes          | The session's recorded text-tool file changes                              |
| Background tasks | Session-owned jobs and their actual states                                 |

Unavailable context usage is shown as unavailable. It is not a fabricated zero. The overview change count is not the repository's Git status; the two sources have different coverage.

## Resource indexes and search scopes

The project and Git file trees use the shared [VirtualFileTree](../../apps/workbench/src/components/VirtualFileTree.tsx). It renders the visible window plus the active keyboard row rather than mounting the entire expanded tree. Arrow keys, page navigation, parent/child navigation and selection work against the full flattened tree. Selection, expansion, filtering and scroll restoration remain tied to their resource owner.

Both indexes use [ResizableContextIndex](../../apps/workbench/src/components/ResizableContextIndex.tsx). Dragging its separator resizes the internal index, not the whole work drawer. The same separator accepts keyboard resizing and exposes its orientation, current width and bounds to assistive technology. Width preferences are stored by owner and resource; a failed storage write does not prevent in-memory use. The preferred width is clamped to the available space. In a narrow resource surface the index becomes an internal overlay, and hiding it leaves the document/resource mounted.

The files index filters workspace file paths. It opens a document through the granted workspace and preserves the current document when the index is hidden. Global conversation search, the file filter, editor text search and the Git changed-file locator are separate searches. Local resource search does not send a message to the model.

[GitPanel](../../apps/workbench/src/components/GitPanel.tsx) separates the file being inspected from the paths selected for an operation. Clicking a file to read its diff does not select it for staging or unstaging. The internal index shows actual file deltas, or a binary label where a numeric delta is unavailable.

Git comparison scopes are unstaged changes, staged changes, a whole branch against its chosen base, and a selected historical commit. Historical commit navigation is read-only: opening a commit does not check it out, stage files or restore them. The native [Git workspace service](../../apps/desktop/src/workspace/git.ts) supplies history and commit details. Working comparisons use revision checks; history uses the requested commit identity. A stale response must not replace the current selection.

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

The task list progressively discloses instructions, verification evidence, original artifacts and explicit review controls. [TaskEvidence](../../apps/workbench/src/features/TaskEvidence.tsx) only projects checks for the exact persisted task and attempt. A command failure and its exit code remain visible; a human review is labelled separately from an independent reviewer or command check. Missing checks are not synthesized from a worker's completion answer.

The [independent verifier](../../apps/desktop/src/workspace/task-verification.ts) includes bounded, redacted actual worker process evidence in its request. It retains failures and command execution results and treats the worker answer as an unverified claim. A command returning zero, a test check passing and every task acceptance criterion passing are different facts. [TaskReviewForm](../../apps/workbench/src/features/TaskReviewForm.tsx) continues to require explicit criterion evidence and pins the attempt and patch hash. Viewing an artifact does not by itself record a passing review.

## File undo is a separate, bounded operation

The message's **undo file changes** action uses [SafeFileUndo](../../apps/workbench/src/features/SafeFileUndo.tsx), the controller's `preview-file-undo` / `restore-turn-files` requests, and [FileRewindJournal](../../src/file_rewind.ts). It is separate from `/undo` and conversation-tree navigation.

The journal records before/after versions only for text-tool mutations attached to an actual turn in the current runtime. The user first previews the affected paths, then explicitly confirms restoration. The host checks every current revision again before restoring. External changes, an incomplete journal or an unsupported backend prevent restoration. Plan mode allows preview but refuses restoration.

The journal is in memory and bound to its runtime. It is not reconstructed from historical messages after restart. Shell commands, Git commands, external services and other unrecorded effects are not covered. This is not full historical rollback or general Bash undo. The original conversation remains intact after a file restore.

## Exact external text-file grants

The overview's **manage external file access** action, the files index footer's **external files** control and the settings entry open [ExternalFileAccessPanel](../../apps/workbench/src/features/ExternalFileAccess.tsx) for the current conversation. The user chooses read or read/write access, then selects one existing file in the native operating-system picker. A path typed by the renderer or model cannot mint authority. [NativeExternalFilePicker](../../apps/desktop/src/external-file-picker.ts) rechecks the active session after asynchronous picker and worker boundaries; a late selection is rejected or revoked.

The [runtime controller](../../apps/desktop/src/runtime-controller.ts) mints grants only through its private native capability path, binds them to the exact runtime/session owner, and dispatches authorized external reads, mutations and undo to [ExternalFileGrants](../../apps/desktop/src/workspace/external-file-grants.ts). Grants are held in memory. They are not inherited by another conversation, fork or task session, and they do not survive application restart. Archiving/deleting or retiring the owner removes its authority. A read grant does not allow writes; plan mode permits authorized reads but refuses writes.

The core path is `read_file` in [tools.ts](../../src/tools.ts) and `FileMutationTools.authorize / read / snapshot / commit` in [file_mutations.ts](../../src/file_mutations.ts). Native external text reads use the same session-specific version tracker as edits. An ordinary tool approval never creates a file grant or extends its scope. Preparation and commit check authority and expected revisions; the backend rechecks exact-file identity and grant state at its own transaction boundary. Revocation denies new calls immediately and drains already dispatched filesystem work before acknowledging completion. Re-granting a file does not revive an old preview.

Scope remains exact and conservative:

- Only an existing regular text file may be granted. A parent directory, sibling file, new file, symbolic/hard link, credential file or protected application-data path is not covered.
- Native external directory and media reads are unsupported. A shell command, MCP server, editor workspace or external service does not inherit this capability.
- A patch or undo batch cannot mix workspace and external-file transaction domains. Split the work explicitly; rejection occurs before that mixed batch writes files.
- External undo still requires the current grant and the recorded revisions. Revocation, file replacement or changed revisions prevent it.

These checks do not provide a portable filesystem compare-and-swap against an unrelated process that does not participate in Circle's queue. The existing [native multi-file save limitation](../known-issues.md#desktop-application) still applies. CLI tools without the injected native backend retain their existing external-path behavior. This grant flow addresses the native Read/Edit scope mismatch recorded as G06 without claiming generic access to every external operation.

## Validation boundaries

The focused `task-evidence.test.ts` checks exact task/attempt identity, rejected worker claims and the distinction between failure, missing verification and human evidence. During this implementation the `tasks-panel-ui.mjs` fixture passed its eight light/dark, English/Chinese and wide/narrow combinations in isolated headless Chrome, including the actual outgoing task creation and explicit review payloads. This is renderer fixture evidence; it is not a native application or packaged acceptance result.

The core `external-file-mutations.test.ts` and existing `file-mutations.test.ts` passed 15 focused tests during this implementation, including real temporary-file effects, session isolation, a grant revoked during an actual scripted approval, the next model request and balanced stored tool history. Those tests use a scripted model and an injected backend; they do not establish the native picker or packaged bridge by themselves.

Other useful regression entry points include `drawer-shell.test.ts`, `native-tools-drawer-ui.mjs`, `editor-ui.mjs`, `runtime-file-rewind.test.ts`, `safe-file-undo-ui.mjs` and `task-verification.test.ts`. Their presence does not assert they passed for the current candidate. Consult the candidate's recorded CLI, workbench, native and packaged run results before making a release claim.

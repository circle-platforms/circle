---
parent: Development
---

# Versioned workspace documents

`WorkspaceDocuments` in `apps/desktop/src/workspace/documents.ts` is a main-process service for an already granted workspace. Selecting an instance does not grant access: IPC callers must first validate the workspace handle. It has no renderer, model or session dependency, so a caller does not need to stop an agent turn to use it.

## Read and save

`read(path, { signal? })` returns `{ id, path, content, revision, mtime, size }`. Paths are workspace-relative, content is complete UTF-8 text, mtime is milliseconds and size is UTF-8 bytes. The revision combines file identity, nanosecond modification/change times and a content hash. File ids remain stable for the same path across saves and refreshes; a rename is reported as removal plus addition.

`save(path, content, expectedRevision, { signal? })` rechecks the disk revision, stages and flushes the replacement in the same directory, rechecks again and atomically renames the staged file. Existing file permissions are preserved. New files require `expectedRevision: null` and an existing parent folder. A revision mismatch throws `DocumentConflictError` with the expected revision and the current complete document (or null for a deleted file). The caller retains its edited buffer and can display both versions; a rejected write never replaces the conflicting version.

Service instances sharing the same canonical root serialize compare-and-save operations within the process. Agent and human writes need to go through the same service or coordinator to participate. External applications do not share that queue: the service detects changes before replacement, but the filesystem does not provide a portable compare-and-swap transaction against an unrelated writer between the final check and rename.

## Multiple files and cancellation

`applyEdits([{ path, content, expectedRevision }], { signal? })` validates every input before staging any replacement, then validates every revision again before committing. A conflict during preflight leaves every target untouched. Duplicate paths are rejected.

Multiple replacements are not a cross-file atomic filesystem transaction. The result explicitly contains `status` (`applied`, `rejected` or `partial`), `applied` documents, `committedPaths`, `failures` and the complete `remaining` inputs. `committedPaths` is authoritative even if a replacement succeeded but reading its resulting document failed. A cancellation between replacements preserves completed writes and returns remaining inputs; it does not roll back over another writer or replay a completed replacement. A signal already aborted before entering the queue rejects with its abort reason.

## Discovery and subscriptions

`refresh()` returns a sorted file list, a monotonic version, added/changed/removed entries and an explicit truncation flag. It discovers external files without reopening the workspace. The default bounds are 2,000 files and depth 12, matching the native workspace catalog.

Discovery has its own queue and does not hold the document mutation queue. A slow catalog reconciliation can continue while another file is saved; a following reconciliation catches replacements during the scan.

`watch(listener, { signal?, onError?, pollIntervalMs? })` returns `{ ready, close }`. Await `ready` for the initial snapshot. Native directory events are debounced; periodic reconciliation also handles missing or unsupported events. Each subscriber receives independent snapshots, including when another subscriber initiated the refresh. Aborting a subscription or closing the service releases its watches and timers. Consumer callback exceptions cannot prevent another subscriber from receiving an update.

## Access boundaries

The service denies absolute paths, traversal, symbolic links, hard links, repository internals and default or additional credential patterns. It rejects a replaced workspace root until the folder is granted again. Discovery excludes dependency/output folders and never returns credential names or staging files. Editable text is limited to 4,000,000 bytes by default; binary, invalid UTF-8 and oversized content is rejected without rewriting it.

Call `setCredentialFiles(patterns)` when saved approval settings change. The service retains the default credential patterns even when the additional list is empty.

The service does not yet replace the runtime's file tools or the native IPC bridge by itself. Those integrations must preserve workspace-handle validation and use the returned revision instead of accepting a renderer's unversioned save.

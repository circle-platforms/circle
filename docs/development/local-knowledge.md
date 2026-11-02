---
parent: Development
nav_order: 11
---

# Local knowledge storage

`src/knowledge/` provides local storage, deterministic qualification, confirmed model writes and explicit personal pack installation. Slash commands, desktop knowledge pages, automatic memory loading and the network sync client remain unfinished. Existing `MEMORY.md` files and skills are unchanged. The unfinished integration is listed in [Known issues](../known-issues.md#local-knowledge-and-personal-sync).

## Protocol mirror

The versioned JSON schemas in `src/data/knowledge-sync/v1/` come from Circle Hub's `personal-sync@1` contracts. The adjacent `provenance.json` records the source repository, committed source `071a61250a1b9f4be67823a5bc9d180163b95e26` and exact file digests. All mirror inputs come from that commit, including `contracts/src/spaces.ts`; no working-tree observation is used. The original sources and local adaptations are separately pinned. Circle imports no Hub service, database or business runtime.

The original shared vectors are copied without modification into `tests/fixtures/knowledge-sync/v1/`. They pin exact canonical UTF-8 bytes, IDs and route definitions. The vectors describe merge and transport expectations; they do not establish live merge, authentication, purge or server atomicity.

```sh
# Check the pinned mirror without a Hub checkout.
npx tsx scripts/verify-knowledge-sync.ts
# Also compare every recorded input with an explicit, read-only upstream checkout.
npx tsx scripts/verify-knowledge-sync.ts --upstream ../circle-hub-sync
```

Run the explicit upstream check at the start of every implementation stage. Refresh only from a committed Hub state and record its commit; a changing, dirty Hub checkout is never a refresh source. A missing or changed explicit upstream fails. Offline mode reports zero upstream comparisons; it cannot detect unseen upstream changes. Do not regenerate expected bytes from the encoder to accept a mismatch. A protocol update must review the contract, refinements, original vectors and provenance together.

Ajv validates the mirrored schemas without coercion, defaults or removal of unknown fields. Additional checks preserve the source contract's Unicode, UTF-16 field lengths, canonical base64, sorted sets, unique batches, registered errors, pack paths/dependencies and checked-purge rules, which JSON Schema alone does not express. This adds no dependency.

Editable strings remove one leading BOM, change CRLF/CR to LF and normalize to NFC. Other whitespace stays significant. Object keys sort by UTF-16 code units; array order changes only when callers explicitly construct a contract-declared set. Duplicate JSON members, normalized key collisions, malformed UTF-8/Unicode, non-JSON values and altered or noncanonical object bytes are refused.

Source and quotation bytes stay in base64 byte objects and are not normalized. The source's `raw_sha256` describes its original assembled bytes; the object ID describes a typed canonical envelope. Neither ID is a Hub `src:`, `tree:` or `rec:` reference or a grant of access.

## Separate local store

`new KnowledgeStore(home)` requires an explicit runtime home. It creates `knowledge/knowledge.sqlite` and private `knowledge/objects/` inside that home, and never opens `circle.sqlite`. Terminal and desktop homes therefore have separate clients. The persistent random client ID survives reopening; item IDs supplied in revisions survive renames and moves.

The database uses its own application ID, append-only migration sequence and `user_version`. A newer version or an unrelated populated database is refused before changing its version or enabling WAL. Files have mode 0600 and directories 0700 on Unix. SQLite runs with foreign keys, WAL and FULL synchronous writes. No existing memory or skills directory is migrated or uploaded.

`put` / `putBatch` validate and stage immutable objects. The writer holds a database write transaction while publishing a same-directory temporary file, syncing it and atomically renaming it, then registering the object. A local batch is bounded to 64 objects and 8 MiB of encoded bytes; source uploads need multiple batches. Sharing violations during rename get at most four retries; other errors fail immediately. This is filesystem recovery, not a retry of a failed sync operation.

Staged objects do not enter search or current browsing. `commit(snapshot, expectedHead)` validates the complete reachable object graph and uses a local compare-and-exchange. Revisions, current projection, FTS and current head change in one transaction. Omission cannot delete an existing item: deletion requires its own revision and parents. Old object bytes remain readable. Conflicting heads have no selected search body, and a resolution must descend from every previous head.

Graph checks cover typed dependencies, revision identity, explicit deletion parents, duplicate item IDs across pages, source size/hash, directory cycles and NFC path collisions. A directory inventory has one current root; canonical empty and pack-only inventories need no invented directory. Source verification streams chunks; the graph keeps at most 8 MiB of object bodies cached. Graph traversal is bounded to 100,000 objects and depth 512. The local whole-source limit is 32 MiB, independently of the protocol's 8 MiB envelope and 1 MiB chunk limits and any smaller Hub deployment limit. These are resource bounds, not verification of a statement's meaning.

Reopening under the database write lock removes only owned temporary files and unregistered orphan object files. A crash after publishing a file cannot make it registered or searchable. A crash before the snapshot transaction commits leaves the old head and old index together. Registered staged objects and committed history are retained. Symlinks cannot redirect object publication or reads to an outside file.

## Search

Search text uses the Hub's deterministic tokenizer: NFKC, lowercase, adjacent Unicode letter/number/underscore pairs within each word, and isolated single characters. It uses neither `Intl.Segmenter` nor FTS trigram. Two-character Chinese words are searchable. This normalization affects only the index and query, never evidence bytes.

FTS5 receives hex-encoded tokens, not user query syntax. Searches include statements, data and UTF-8 quotations, with folder, entry type and status filters. Limits are 4,096 query bytes, 100 results per page, 1 MiB per-entry token budget and 64 MiB of encoded terms per current projection. Continuations bind the query, filters and current snapshot. A changed snapshot or query refuses the old cursor. `rebuildSearch()` derives the current projection again from the immutable snapshot.

## Local qualification and model tools

`text@1`, `json@1` and `markdown@1` are portable adaptations of the pinned Hub parsers, decoding and canonical selector codecs under Apache-2.0. Their upstream test cases and generic Markdown fixture are pinned alongside the implementation; the Hub-only sandbox input-serialization test is outside this client adaptation. `credential-scan@3` scans decoded and encoded views using the same portable scanner. Its HTML character-reference data retains its BSD notice. No other parser is installed or executed by claiming a name in a manifest.

`circle-local-verification@1` checks current conflict-free sources, exact located quotations and qualified local entry dependencies. Whitespace, case and Unicode form remain significant; empty/whitespace-only quotations cannot qualify. Raw originals and quotations retain their bytes, including BOM/CRLF and decomposed Unicode. Parser output follows that declared parser's decoding rules. Unsupported parsers and native Hub references without an authorized resolver remain incomplete, not qualified. Missing/failed reads are incomplete; a located quote mismatch is recorded separately. A verification operation inspects at most 64 MiB, caches parsed documents within that work budget, allows 100,000 nodes per parse and bounds entry-dependency depth to 100. A limit produces an incomplete observation, never success.

Observations live in a migration-2 side table keyed by snapshot, object and local rule version; they record scanner/parser versions, positions and reasons. Immutable revisions contain no local qualification flag. A new snapshot rechecks current entries and rebuilds the search status in the same transaction. The local observation proves deterministic quotation/path conditions only, never statement meaning or Hub share authority. The Hub must independently reverify.

The runtime exposes `knowledge_read` as a bounded address/schema discovery tool. Content requires explicit `snapshot` and `object` IDs. `object: "schema"` returns a paginated copy of the pinned write format without opening a store. Knowledge/memory intent or a knowledge read promotes `knowledge_search`, `knowledge_write`, `memory_write` and the currently unavailable `knowledge_share`; they stay available for that conversation. The existing curated empty-workspace prompt fixture now includes that reader and still enforces its unchanged 7,000-token ceiling; runtime tests separately check actual schema promotion. Runtime configurations with extra local/integration tools have their own additional payload. A trusted host task lock refuses search and personal writes and permits only its explicit snapshot/object allowlist. This stage provides the host port; it does not infer a Hub lock from model text.

`knowledge_write` proposes at most 64 typed revision/byte objects and 8 MiB against `expected_head`; Circle derives inventory pages and the snapshot. Revision parents must continue every current head, so moves, deletions and conflict resolutions cannot silently discard a branch. `memory_write` creates, edits, enables, disables or deletes a stable memory identity. Memory Markdown is limited to 24,000 UTF-8 bytes per document; title, path and Markdown together are limited to 48,000 bytes and 20 enabled documents. Disabled current documents use no context budget. A conflict reserves one document and the largest candidate, using the Hub's 8,000-byte path reservation when its directory is unresolved. Existing MEMORY.md is neither imported nor changed, and structured memories are not yet automatically loaded.

Both writes require a person to approve the exact canonical object preview. Auto/accept-edits modes, saved rules, hook allows and model `confirm: true` cannot authorize them. A headless call cannot write. Rejection/cancellation leaves bodies, current head, search and history unchanged. After approval the database write lock rechecks the expected snapshot, then publishes the validated objects, observations, projection and head together. A changed version requires a fresh proposal and confirmation.

Credentials and bounds are checked before publication, including complete originals whose credentials could cross chunk boundaries. Rejected proposals are reduced to safe reasons before durable tool-call history/events and opaque provider replay; detector positions contain no matched text. No rejected body is put in objects, the index or temporary files. Binary or unsupported scan views have no clean conclusion and are refused by these write tools. Low-level `KnowledgeStore.put/commit` remain trusted storage/transport primitives, not model tools or a credential-acceptance API.

## Personal packs

A `pack_manifest` revision is portable manifest data only. It carries no code. `installPersonalPack` is an explicit host service requiring the current snapshot, selected local folder, existing workspace/user skill scope and a person approval callback. It compares pack.json to the revision, validates allowed/required paths, aggregate size (32 MiB), exact file sizes/hashes and credential scans, refuses symlinks and same-name skills, then installs private files under `knowledge/packs/<manifest-object>`. It never copies a folder into the automatic `skills/` root. The original selected files are unchanged. Code transfer through an authorized MCP pack entry and desktop selection remain later stages.

Installation and enable/disable are separately confirmed and recheck the current snapshot. Only current, conflict-free, enabled installations with all files intact appear in the model skill catalog. Existing built-in/user/project precedence is preserved. Disabled, changed or missing files disappear from the next model request; loading a stale catalog item also refuses. Workflow and skill kinds remain distinct metadata; local installation is not Hub validation of a locked workflow version.

`hooks.json` is not an allowed file in the pinned pack protocol and is never copied from an existing skill folder. Personal pack discovery ignores a manually added hooks sidecar too; installation never fabricates a hook approval hash. Hook import/enable has no new entry point in this stage. Existing standalone skills and their hook behavior remain compatible, with no automatic migration, scan or upload.

Native pages, packaged application validation, sync ownership, HTTP CAS/merge, OAuth refresh, authorized sharing, automatic memory loading and actual test-Hub round trips belong to later stages. In local-only mode, the eventual “分享到团队…” action is disabled with a switch-to-sync explanation and entry point; there is no temporary sync or new Hub endpoint. The model share tool currently returns unavailable and performs no transfer in either mode.

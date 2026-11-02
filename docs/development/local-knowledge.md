---
parent: Development
nav_order: 11
---

# Local knowledge storage

`src/knowledge/` provides the storage and protocol foundation for local knowledge. It is not yet connected to model tools, slash commands, desktop pages, automatic memory loading or a network sync client. Existing `MEMORY.md` files and skills are unchanged. The unfinished integration is listed in [Known issues](../known-issues.md#local-knowledge-and-personal-sync).

## Protocol mirror

The versioned JSON schemas in `src/data/knowledge-sync/v1/` come from Circle Hub's `personal-sync@1` contracts. The adjacent `provenance.json` records the source repository, observed commit and exact file digests. One reference input, `contracts/src/spaces.ts`, was being edited by the Hub owner when inspected: its observed digest and the committed digest are both recorded. The fixed sync contracts, copied schemas and shared fixtures agree with the inspected files. Circle neither imports nor executes Hub modules.

The original shared vectors are copied without modification into `tests/fixtures/knowledge-sync/v1/`. They pin exact canonical UTF-8 bytes, IDs and route definitions. The vectors describe merge and transport expectations; they do not establish live merge, authentication, purge or server atomicity.

```sh
# Check the pinned mirror without a Hub checkout.
npx tsx scripts/verify-knowledge-sync.ts
# Also compare every recorded input with an explicit, read-only upstream checkout.
npx tsx scripts/verify-knowledge-sync.ts --upstream ../circle-hub-sync
```

A missing or changed explicit upstream fails. Offline mode reports zero upstream comparisons; it cannot detect unseen upstream changes. Do not regenerate expected bytes from the encoder to accept a mismatch. A protocol update must review the contract, refinements, original vectors and provenance together.

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

Stage 1 has no deterministic source verifier or credential scanner integration: every projected entry is `unverified` (desktop wording will be “待验证”). It never trusts an imported qualification flag or infers verification from a digest. Missing/disabled/conflicting memory is not automatically loaded, because no memory loader is connected yet. Search is a clue-finding API; it does not create a Hub task input or evidence reference.

Only protocol, file and local transaction tests have been added here. Native interface, packaged application, multi-process sync ownership, remote CAS/merge, OAuth refresh and actual test-Hub round trips belong to later stages. In local-only mode, the eventual “分享到团队…” action is disabled with a switch-to-sync explanation and entry point; there is no temporary sync or new Hub endpoint.

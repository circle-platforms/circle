# Personal sync v1 shared vectors

`encoding.json` pins exact UTF-8 canonical object bytes and SHA-256 identities. The expected forms were authored
independently of the encoder. `scenarios.json` contains synthetic objects and expected merge/transport outcomes for
both implementations. Object IDs and item IDs are protocol fields, never UI labels. No Hub database is required.

Editable text: remove one leading BOM, convert CRLF and CR to LF, then NFC. Preserve all other whitespace. Strict
canonical JSON sorts normalized object keys by UTF-16 code units, preserves array order and refuses duplicate or
normalization-colliding keys, invalid Unicode and non-finite numbers. Objects must match their strict typed schema.
Only schema-declared sets (parents, heads and snapshot pages) use sorted unique IDs; callers must supply that order.

Raw source and quotation bytes use canonical padded standard base64 in a `bytes` object; never normalize these bytes.
The source's raw SHA-256 differs from the typed sync envelope ID. A snapshot ID is not a Hub record or a source address.

The HTTP request/response schemas are generated separately from MCP tools. Route definitions are exported from
`contracts/src/sync.ts`; the contracts tests assert that MCP still has six tools and refuses sync payloads.
Scenario expectations describe protocol requirements; exercising live CAS, authorization, purge and quotas requires
step 3–6 service/acceptance tests and is not established by parsing these fixtures.

`native-links.json` adds fixed canonical objects for a nullable source name, a read-only existing ground and an own
predecessor revision link. `sync-merge.test.ts` executes shared ancestry expectations in both input orders.

## Frozen v1 compatibility suite

The JSON vectors in this directory are frozen for decision 89 step 6. Preserve their existing canonical bytes, IDs and
expected outcomes; an incompatible correction requires a new versioned directory and an explicit compatibility review.
This is a protocol-fixture boundary, not a full-repository checksum or a promise that the Circle client is implemented.
The independent golden encodings remain literal data, not regenerated during tests by the implementation under test.

`exchange.json` completes the live HTTP examples. Its labeled canonical objects use the five existing memory revisions
in `scenarios.json` without changing those bytes. `memory-base`, `memory-left`, `memory-right`, `memory-conflict` and
`memory-resolved` provide inventory/snapshot ancestry for two clients: stale CAS is refused, both heads are retained,
conflicted memory is not auto-loaded, and a child covering both heads resolves it. Source/quote byte objects and the
knowledge snapshots demonstrate exact BOM/CRLF preservation, verified text grounds and a wrong quote becoming
unverified. Expected encodings were assembled independently with sorted JSON keys; tests never regenerate the vectors.

Portable consumers need only JSON, UTF-8, standard padded base64 and SHA-256 for the existing object-ID protocol.
Use actual server epoch/state/session/operation values in HTTP requests; the two client UUIDs are synthetic constants.
On an empty personal space, upload the directory/revisions and the corresponding page/snapshot, commit with the state
returned by the server, and compare the semantic fields in `memory`/`knowledge`. Server timestamps and state hashes
are observations, not portable fixture constants. Use the current state for an intentional merge after a CAS refusal;
retrying the original operation retrieves its frozen receipt instead of performing another write.

`contracts/src/sync.test.ts` checks typed encoding, closure and portable expectations. `sync-merge.test.ts` checks the
pure merge vectors. `tests/acceptance/49-personal-sync.test.ts` runs the exchange through real Bearer HTTP and MCP over
a temporary PostgreSQL; records/server/knowledge tests separately cover quota, credentials, token revocation, admission,
transaction rollback and purge. The fixture parsers alone do not establish authorization or successful deployment.

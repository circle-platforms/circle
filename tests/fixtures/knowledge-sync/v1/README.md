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

# Personal sync v1 capability vectors

Additive vectors for knowledge sync v1 (decision 137). The frozen v1 suite in `../v1/` is unchanged; nothing here alters
its bytes, identities or expected outcomes. The specification is `docs/protocols/knowledge-sync-v1.md`.

- `discovery.json` is the document circle-hub serves at `/.well-known/knowledge-sync` when reached as
  `https://192.0.2.10` (a documentation address, RFC 5737). It parses as `knowledge-sync-discovery@1`. The server's
  answer for another origin differs only in the origin of every URL.
- `errors.json` holds error answers: a v1 answer without the new members, one with `detail` (capability
  `error-detail`), the purge refusal with `confirmation` (capability `purge-confirmation`) and an answer from a newer
  server with an unknown code and an unknown member, which a client must handle as a generic failure showing `detail`.
  `detail` is the registered explanation and next step of the code; timestamps are synthetic.

`contracts/src/sync.test.ts` parses these vectors; `hub/server/sync-discovery.test.ts` compares `discovery.json` with
the server's own document and serves it over HTTP. These vectors establish shapes, not authorization or a deployment.

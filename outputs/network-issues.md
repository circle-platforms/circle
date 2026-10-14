# Network issues #3 and #52

2026-10-14. Work performed only in the isolated `issue-two-end-fixes/circle` worktree. Verification preceded the user-authorized GitHub publication; it used no real Circle data, paid model endpoints or external model/network endpoints. Node 24.19.0; HTTPS servers, proxy tunnels, credentials and workspaces were synthetic.

## Reproduction

- Before the web tool change, `websearch` discarded both endpoint causes and returned `search failed: fetch failed`; `webfetch` returned `fetch failed`. The new per-host TLS/DNS assertions failed on these exact strings, while cancellation already passed.
- The existing desktop runtime worker never called `configureNetwork` or built the child trust bundle. The regression fixture compiled the historical `HEAD` worker with esbuild and copied its real prompts/data beside the bundle. Its real SDK request through a local CONNECT proxy did not finish within the fixture's 30-second bound (exit 1). The updated worker completes the same fixture in under a second.
- A CLI process pointed at a locally signed HTTPS model endpoint fails with a classified TLS error before trust is configured. Adding the signing CA through saved `trust_cert_files`, without certificate environment variables, allows the first actual SDK model request.

## Implementation

- `initializeNetwork(home, env)` is shared by the CLI and desktop runtime worker. It runs before catalog/model/probe/tool construction and reads only the user-level settings supplied by the process.
- `NetworkStatus` records proxy availability, additional certificate count, effective authority count, trust sources, managed bundle path and configuration problems. `currentNetworkStatus()` returns a serializable clone; `networkSummary()` supplies the terminal summary. The parent agent connects the desktop snapshot and visible surfaces.
- Default authorities are retained when settings, `SSL_CERT_FILE`, `SSL_CERT_DIR` or `CIRCLE_TRUST_CERTS` add PEM certificates. The managed private bundle is inherited through `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`; child Node processes also receive `NODE_USE_ENV_PROXY` when the parent enabled proxy support. System trust is not edited and certificate verification is not disabled.
- `networkError(error, host)` retains the original cause and identifies TLS, DNS, proxy, timeout, HTTP, empty-response and connection failures. Displayed messages remove proxy URL credentials, URL queries and authorization values. TLS failures include effective trust information. Model errors are wrapped after the existing guard has completed its retry policy; cancellation and non-network errors keep their original behavior.
- Probes preserve provider, protocol, pagination and model-list behavior while naming the actual failed host. Web search retains both endpoint failures, keeps its fallback and stops before fallback on cancellation. Webfetch's local/private host and redirect checks remain enforced.

## Verification

Executed:

```text
node --import tsx --test tests/network.test.ts tests/trust-cert-files.test.ts tests/web-plan.test.ts tests/network-bootstrap.test.ts tests/probe.test.ts tests/model-guard.test.ts
44 passed, 0 failed, 0 skipped

root TypeScript check: passed
workbench TypeScript check: passed
desktop TypeScript check: passed
```

The five new bootstrap fixtures make real requests:

1. Two separately signed CAs remain usable by child Node HTTPS fetches through CONNECT tunnels; every original default authority fingerprint remains present. A child OpenSSL client also verifies both servers with the inherited managed bundle supplied as its CA file.
2. The actual bundled desktop worker makes its first SDK model request using a CA from saved settings and the configured proxy.
3. A real TLS failure on `lite.duckduckgo.com` and HTTP 503 on `html.duckduckgo.com` both reach the next ScriptedModel request and stored tool history as an error, with the private search query absent from the diagnostic.
4. CLI TLS refuses an untrusted endpoint and succeeds after its CA is saved in settings.
5. Missing/invalid certificate files and a malformed proxy are visible as three configuration problems; a valid `CIRCLE_TRUST_CERTS` source remains usable and proxy credentials are absent from the status.

Existing coverage checks NO_PROXY, source trust merging/restoration, model/probe protocol behavior, retry/cancellation semantics and private redirect refusal. New diagnostic coverage checks aggregate TLS causes, nested cause codes, each failed search host, proxy/DNS/timeout/connection classification and cancellation during an in-flight search.

## Limits

The worker fixture exercises the actual esbuild bundle in a Node subprocess with the native parent-port protocol; development/packaged Electron windows and visible desktop status are verified separately by the parent agent. The bundled/default trust store is proven retained by certificate fingerprints; no public network endpoint was contacted. macOS LibreSSL's `s_client` does not automatically read `SSL_CERT_FILE`, so its verification explicitly supplies that inherited file; the child Node requests read their inherited `NODE_EXTRA_CA_CERTS` naturally. A third-party client must support the trust variable it consumes. No doctor command was added. Windows-specific native verification is not part of these local checks.

## Final native confirmation

The coordinator also ran network-native.mjs against the actual development and packaged Electron applications: 4 checks in each, no errors. Both private signing CAs were accepted on real SDK requests through the local CONNECT proxy. The native websearch tool then contacted only the synthetic proxy, received deliberate failures for both DuckDuckGo hosts, and preserved both diagnostics into stored tool history and the next SDK request without the synthetic query. Packaged receipt records Electron 44.7.0, embedded Node 24.21.0 and app 1.5.0. No public search request was sent. See network-native/development/receipt.json and network-native/packaged/receipt.json.

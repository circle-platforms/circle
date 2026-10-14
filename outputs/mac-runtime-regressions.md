# Mac and Linux regression follow-up

Baseline: PR #65 implementation `7d4ef6e0741b97f97bfd2f594a03bd9b11d7eda5`. This follow-up is an independent stacked PR. PR #76 is synchronized from `6cb4242b67ed2edda59e3764b793a9d362849952`, including its #68 address classification dependency. PR #77 remains network diagnostics only; it is not counted as a certificate-trust fix.

All checks use synthetic workspaces, isolated Circle homes/workbench data and local services or ScriptedModel. No production integration, user-data migration, release tag or installation into this Mac’s Applications directory is performed. Windows MSI checks run only on disposable CI runners. Node is pinned to 24.21.0 in the CLI and native verification workflows.

## Failure evidence and changes

| Category | Evidence and conclusion | Change / remaining work |
| --- | --- | --- |
| Native capture/address readiness | #76 reproduced premature async IPC predicates; URL, title and loading must all match before capture | Reuse its bounded awaited IPC helper; preserve screenshot freshness and invalid-address state assertions, plus #65 late-navigation/session guards |
| Four TLS failures | Both Mac release jobs fail at the four network-bootstrap paths; investigation reproduces them with the system OpenSSL configuration | With `OPENSSL_CONF=/System/Library/OpenSSL/openssl.cnf`, the original fixture reproduced 4 TLS failures: duplicate BasicConstraints made Node report ca=false. The shared explicit-config fixture verifies each CA/leaf chain before startup; the polluted configuration now passes 16/16 network checks. No product trust code is changed |
| Browser handoff | Latest retrieved Mac jobs pass; fixed 800ms waits still permit a delayed navigation race | Use bounded actual navigation confirmation and verify handback ownership and next model context |
| Task saved projection | Mac Check job reads saved as undefined; delivery writes the result before asynchronous status projection finishes | Await the latest view and retain result-file/tasks.json assertions |
| Input pause | Mac x64 release job measures from after final key handling | Start live timing before final key; use controlled-clock 999ms/1000ms/reset assertions |
| Page overlay | Root cause not confirmed; retrieved native job and local baseline pass | Add metadata-only CDP command/response timing, pending contexts, navigation and animation events, plus same-document overlay acknowledgement. Preserve current timeout and safety assertions; no product overlay fix is claimed |

Original CI evidence: [Mac task projection failure](https://github.com/circle-platforms/circle/actions/runs/38533611986/job/115751074212), [Mac ARM64 TLS failures](https://github.com/circle-platforms/circle/actions/runs/38533617958/job/115751454071), [Mac x64 TLS/input failures](https://github.com/circle-platforms/circle/actions/runs/38533617958/job/115751453914). A same-commit [Mac CLI run](https://github.com/circle-platforms/circle/actions/runs/38533618226/job/115751095609) and [native run](https://github.com/circle-platforms/circle/actions/runs/38533617957/job/115751214921) pass; passing runs do not erase the failures.

## Verification

Local host: macOS ARM64; official Node 24.21.0 archive SHA-256 `bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057`, checked against its official SHASUMS256.txt. Electron 44.7.0.

- Browser IPC readiness: 3/3; host/address parsing: 2/2.
- Workbench unit checks: 38/38; desktop unit checks: 46/46; desktop runtime checks: 56/56.
- Full CLI check passed (547 total / 545 passed / 2 Windows skips) before the last handoff cleanup regressions; final full check is running. Development host 12 checks, address 4, page/lifecycle scenarios and live suite 71 checks passed. Packaged validation is running.
- CI matrix covers full CLI on Mac ARM64/x64, Linux x64 and Windows; native development and packaged tests on Mac ARM64/x64 and Linux x64, with Xvfb and the Chromium sandbox on Linux. Results will be recorded after execution.

No Linux-specific defect is currently confirmed. Page-overlay root cause and original intermittent Windows updater hang remain unconfirmed. The user's Windows manual validation is separate from this CI evidence.

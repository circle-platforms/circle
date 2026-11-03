# Knowledge desktop validation

Decision 90 uses synthetic content and scratch homes on macOS arm64. The stage-5 development results below remain historical; stage-6 isolated-Hub and final native results are recorded separately.

## Isolated Hub round trips

[The actual-Hub receipt](validation/knowledge-final/hub-roundtrip.json) records seven effect groups and 69 sync HTTP responses against an untouched `git archive` of Hub `410c9c44fcedef41bd1755bdbd0bef6600cd904e`. The archive digest is `15216cdd772bacf151a57c1273c4438c1338a223a00f52bd4f7e4d3902314bfd`; all 46 mirror and 67 upstream checks passed without changing the committed `eef4ca12` mirror.

The optional runner is `npx tsx scripts/knowledge-hub-acceptance.ts <read-only Hub checkout> <receipt.json>`. It starts the archived Hub's real assembled services with its private test PostgreSQL, temporary FileKeyProvider/vault, two synthetic accounts and a random loopback port. It forbids ports 7420/7443 and non-loopback fetches, reuses Circle's real OAuth password/consent/code-exchange flow, and removes its own temporary resources after closing the runtimes. No owner credentials, live Hub, real model or business source is involved.

The effects cover exact first-sync reads and another account's denial; independent Circle/Hub edits with both conflicting bodies retained; explicit full-field resolution; mapped memory and knowledge sharing with an independently readable team copy; checked local-only purge with an empty personal snapshot and retained local/team copies; explicit resume into a new epoch; and a real revoked-token 401 that cannot launch background login, followed by explicit re-login, re-selection and an exact read after synchronization.

The real server refuses locally uploaded evidence with `SHARE_UPLOAD_UNSIGNED`, despite successful quotation verification. That refusal is asserted and retained. The separate successful knowledge-sharing case follows the Hub's own fixture pattern: `artifacts.ingest` seeds an independently observed **synthetic** team capture of the fixture bytes without changing the upload's provenance. This establishes that qualified synthetic path, not a real connector or an upload-signing capability. Memory sharing does not use evidence references. Circle currently reports the knowledge-share refusal generically; see [known issues](../known-issues.md#local-knowledge-and-personal-sync).

## Final development and packaged acceptance

[checks.json](validation/knowledge-final/checks.json) records command results, every platform/harness skip, first failures, production byte comparisons and the separately failed supplemental terminal check. [Development](validation/knowledge-final/development/receipt.json) and [packaged](validation/knowledge-final/packaged/receipt.json) knowledge receipts each record **13 effect groups, 53 native PNGs and zero page/console/request errors**. All **106** final PNGs were opened and inspected; [visual-review.json](validation/knowledge-final/visual-review.json) lists them and separates visual judgment from scripted effects.

| Command / scope | Actual result |
| --- | --- |
| `npm run check` | 1,800 passed, 10 Windows skips, zero failures; types and CLI build passed |
| `npm run check:apps` | Workbench 343, desktop 163, runtime 820 passed; 17 Windows skips; types and builds passed |
| Three package `format:check` commands | Passed |
| Complete `test:desktop`, development and packaged | Exit 0 in both; 17 helper unit tests and 23 completed main desktop checks; packaged mode reports five legacy-harness skips |
| `test/interface.mjs`, wide and 1,024 px, development and packaged | Four successful runs, each covering all 48 commands and 88 checks |
| `test/live.mjs`, development and packaged | 25 checks in each |
| `test/browser-live.mjs`, development and packaged | 29 checks in each |
| `node --import tsx apps/desktop/test/knowledge-native.mjs`, development and packaged | 13 checks and 53 screenshots in each; real worker request includes escaped team then personal preferences, 851-byte structured block, excluded disabled/conflicted/shared memory and legacy file context afterward |
| `npm --prefix apps/desktop run package:only` | Local `.app` and `.dmg` built; 2,579 artifact hashes checked, 2,645 ASAR build files equal and 50 protocol resource copies equal |
| Supplemental packaged terminal accessibility | **Failed** at 600 actual PTY output lines; existing pre-#405 menu-focus behavior, described below; not counted as a pass |

The ASAR SHA-256 is `f01e3d7a543a44fa0b308a14141a5e2a3b5d1e44b30f9b1c6d803d63adcbb9dd`; [artifact-receipt.json](validation/knowledge-final/artifact-receipt.json) binds it and the local disk image. The app was launched from its output folder, never installed into Applications or published. Stock Electron's select-all helper is explicitly distinguished from packaged-app evidence. The legacy desktop receipt precedes its final home-mode assertion: it records 22 checks, while successful completion prints 23; checks.json records both rather than changing either count.

The five packaged skips are browser-page, browser-lifecycle, browser-key-race, terminal-panel and popout. Their guards select development-only harnesses; the last two print a generic desktop-capability message despite also guarding on `CIRCLE_DESKTOP_EXECUTABLE`. Browser-live and the packaged popout-press checks ran separately. The supplemental terminal accessibility command failed because this branch's `NativeTerminal.tsx` is byte-identical to the pre-`d2e31542` version (Git blob `2365c4d0`), with `ee7466ed` as the shared workbench base. Menu exit returns focus to the trigger and the first Enter reopens the menu instead of running the command. The reviewed fix is on the separate workbench branch; it has not been merged here. The failed result, restored clipboard and closed application are retained in checks.json. No test, timeout, input or output assertion was relaxed.

Latest packaged samples: [Chinese dark knowledge](validation/knowledge-final/packaged/zh-CN-dark-1440-knowledge.png), [Chinese light narrow knowledge](validation/knowledge-final/packaged/zh-CN-light-1024-knowledge.png), [Chinese memory](validation/knowledge-final/packaged/zh-CN-dark-1440-memory.png), [Chinese workflow](validation/knowledge-final/packaged/zh-CN-light-1024-workflows.png), [local-only settings](validation/knowledge-final/packaged/zh-CN-light-1024-sync.png) and [dangerous mode confirmation](validation/knowledge-final/packaged/en-dark-1440-local-mode-impact.png). The receipts list the complete English/Chinese × dark/light × wide/narrow matrix and additional states.

Packaged native knowledge uses the synthetic contract peer; actual-Hub round trips use AgentRuntime and DesktopKnowledge against the real isolated services. These are separate evidence. Native results cover macOS arm64, with generated scratch picker selections; production deployment, real connectors, manual OS pickers and other native platforms are not established.

## Commands and effects

| Command | Result |
| --- | --- |
| `npm run check` | 1,799 passed, 10 existing platform skips, no failures; typecheck and build passed |
| `npm run check:apps` | Renderer 342, desktop 163 and runtime 820 passed, with 17 existing platform skips; details recorded in [checks.json](validation/knowledge/checks.json); no failures; typechecks and native build passed |
| Three package `format:check` commands | Passed |
| `verify-knowledge-sync.ts --upstream <committed archive>` | 46 mirror checks and 67 upstream comparisons passed against the opening `eef4ca12` and closing `410c9c44` commits; mirror remains pinned to `eef4ca12` |
| `node --import tsx apps/desktop/test/knowledge-native.mjs` | 12 effect groups, 53 native screenshots, no page/console/request errors |
| `settings-dialog-ui.mjs` and `settings-navigation-ui.mjs` | Passed with the new sync section and unchanged containment/visibility requirements |

[checks.json](validation/knowledge/checks.json) names every skip, describes first failures and records copied-resource equality. [receipt.json](validation/knowledge/receipt.json) binds source files, built bytes, actual Electron versions, every screenshot hash and its actual viewport. No dependency, lockfile, protocol mirror or shared vector changed. No timeout or assertion was relaxed.

The native path uses the real renderer, restricted preload, main process, worker and knowledge database. It checks Chinese two-character search; exact original bytes including BOM/CRLF/whitespace; confirmed folder/entry/memory edits, moves, deletion and conflict resolution; canceled previews; recent history; read-only team memory; separately confirmed manifest registration and matching file installation; real mode pre-check data from the loopback peer; disabled local-only sharing and its tooltip/switch entry; mapped sharing only after confirmation; a second runtime process reading the same journal; and reopening Electron with saved revisions and installed files intact. The model is scripted. Picker automation supplies only the scratch files created by the test, so this is not a manual OS-picker receipt.

Host regressions additionally check stale/single-use/session-bound capabilities, current credential refusal before publication and at the return boundary, unknown or native-path IPC rejection, real pre-check drift, state-only purge completion, actual bounded memory loading and shared memory exclusion from the next model request. The 4,005-entry regression checks that paging does not evict the returned rows’ capabilities. Model sharing in auto mode still asks the person; rejection and “always” dispatch nothing. Prompt-budget limits and frozen shared fixtures are unchanged.

## Visual review corrections

Claude approved stage-5 function and boundaries, then requested hierarchy paths, Inspector fact lines, compact actions, accessible local-only guidance and explicit dangerous mode confirmation. The follow-up evidence is in [the review receipt](validation/knowledge-review/receipt.json) and [checks](validation/knowledge-review/checks.json), with 53 retaken and inspected PNGs; the original stage-5 receipt below remains historical. Local revision times are recorded only for actual local commits in an appended database migration; older and remote revisions without a supplied update time show unknown.

## Native matrix

Every PNG in [the receipt’s screenshot list](validation/knowledge/receipt.json) was opened and inspected. The matrix is English/Simplified Chinese × dark/light × 1,440/1,024 CSS pixels across knowledge, memory, workflows and sync settings. The narrower samples include both list/table and returnable detail pages. Additional frames cover source expansion, the disabled-share tooltip, share and local-mode previews, conflicts, history, installation, empty results and 700 px keyboard navigation with reduced motion. The receipt records first-frame containment separately from the settled screenshots; finite animations and fonts settle before capture.

| View | Dark / wide | Light / narrow |
| --- | --- | --- |
| Knowledge | [中文](validation/knowledge/zh-CN-dark-1440-knowledge.png), [English](validation/knowledge/en-dark-1440-knowledge.png) | [中文详情](validation/knowledge/zh-CN-light-1024-knowledge.png), [English list](validation/knowledge/en-light-1024-knowledge-list.png) |
| Memory | [中文](validation/knowledge/zh-CN-dark-1440-memory.png), [English](validation/knowledge/en-dark-1440-memory.png) | [中文](validation/knowledge/zh-CN-light-1024-memory.png), [English list](validation/knowledge/en-light-1024-memory-list.png) |
| Workflows | [中文](validation/knowledge/zh-CN-dark-1440-workflows.png), [English](validation/knowledge/en-dark-1440-workflows.png) | [中文表格](validation/knowledge/zh-CN-light-1024-workflows-list.png), [English details](validation/knowledge/en-light-1024-workflows.png) |
| Sync settings | [中文](validation/knowledge/zh-CN-dark-1440-sync.png), [English](validation/knowledge/en-dark-1440-sync.png) | [中文](validation/knowledge/zh-CN-light-1024-sync.png), [English](validation/knowledge/en-light-1024-sync.png) |

[Local-only impact preview](validation/knowledge/en-dark-1440-local-mode-impact.png), [share tooltip](validation/knowledge/en-dark-1440-local-share-tooltip.png), [conflict editor](validation/knowledge/en-dark-1440-conflict-editor.png), [source expansion](validation/knowledge/en-dark-1440-source-expanded.png) and [700 px keyboard focus](validation/knowledge/zh-CN-light-700-keyboard-reduced-motion.png) show the additional states.

Observed corrections include an inherited 19 px footer button, textarea/select labels, root-folder empty-string handling, fresh capabilities after confirmed writes, an entry animation that replaced dialog centering, workflow availability colour and keyboard movement that depended on a delayed route update. Centering now uses the independent CSS `translate` property; fast navigation follows the focused row, and narrow details return focus to the selected row. The exact failures and fixture corrections are recorded in checks.json and the task page.

The original stage-5 client checks establish local effects against the pinned protocol and the synthetic peer. They do not substitute for the separate stage-6 actual-Hub and packaged receipts above. Visual approval remains Claude’s.

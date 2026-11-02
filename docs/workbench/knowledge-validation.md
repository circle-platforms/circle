# Knowledge desktop validation

Decision 90, stage 5, checked on macOS arm64 with synthetic content, scratch homes and a loopback protocol peer. This records the development Electron application. Packaged application acceptance and real isolated Hub round trips remain stage 6.

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

These client checks establish local effects against the pinned protocol and the synthetic peer. They do not establish the Hub’s real authorization, accounting, purge or server transaction behavior, other platforms, manual OS pickers, a packaged app or a deployed service. Visual review remains Claude’s.

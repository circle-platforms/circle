# Knowledge desktop validation

Decision 90 was validated with synthetic content and scratch homes on macOS arm64. The retained evidence lives only in [validation/knowledge](validation/knowledge/receipt.json): 15 representative PNGs at 1x CSS pixels and compact receipts. Product, test and dependency bytes are unchanged by the evidence slimming. The unpushed pre-slim head is preserved locally as `knowledge-sync-pre-slim` (`7c4a1079`); its oversized evidence history is excluded from this PR's ancestry.

## Post-rebase native acceptance

The knowledge commits were rebased onto #405 head `169bd3cc37f62cb7d5001561fecf46c0247e6d33`. [The native receipt](validation/knowledge/receipt.json) records 13 effect groups, zero page/console/request errors, and aggregate digests for 1,140 source files, 2,645 build files and the original 53 screenshot layouts. The original first-frame and settled-frame containment assertions passed. Eleven retained images come from that approved run; the Chinese impact dialog was captured afterward with the same product and build bytes, using an untracked copy of the native harness and the original localized controls. The supplemental capture passed with synthetic scratch data and no page errors; it does not claim another full acceptance run. One later packaged unsigned-upload refusal frame replaces the old tooltip sample; its separate [follow-up receipt](validation/knowledge/share-refusal.json) binds the changed code and fresh checks. Two unbound-Hub images replace the original expanded-source and empty-state samples; their [separate receipt](validation/knowledge/no-hub.json) records the narrowed follow-up.

All retained PNGs were opened after downsampling. [visual-review.json](validation/knowledge/visual-review.json) separates that visual judgment from scripted checks. Each PNG is the original viewport at one pixel per CSS pixel, uniformly averaged from its device pixels without cropping or content changes. The receipt records the saved digest, original digest, pixel dimensions and source run for each image.

| View | Retained samples |
| --- | --- |
| Knowledge and Inspector | [中文深色 1440](validation/knowledge/zh-CN-dark-1440-knowledge.png), [中文浅色 1440](validation/knowledge/zh-CN-light-1440-knowledge.png), [English dark 1440](validation/knowledge/en-dark-1440-knowledge.png), [中文浅色 1024](validation/knowledge/zh-CN-light-1024-knowledge.png) |
| Memory and workflows | [中文记忆](validation/knowledge/zh-CN-dark-1440-memory.png), [中文工作流](validation/knowledge/zh-CN-light-1440-workflows.png) |
| Local-only sync settings | [中文浅色](validation/knowledge/zh-CN-light-1440-sync.png), [English dark](validation/knowledge/en-dark-1440-sync.png) |
| Destructive mode confirmation | [中文](validation/knowledge/zh-CN-dark-1440-local-mode-impact.png), [English](validation/knowledge/en-dark-1440-local-mode-impact.png) |
| Local-only share guidance | The Chinese Inspectors above show the accessible note and settings link; [Hub refusal](validation/knowledge/zh-CN-light-1024-share-refusal.png) shows the separate unsigned-upload refusal and uploader action |
| Additional states | [Conflict editor](validation/knowledge/en-dark-1440-conflict-editor.png), [700 px keyboard and reduced motion](validation/knowledge/zh-CN-light-700-keyboard-reduced-motion.png) |

The native flow uses the real renderer, restricted preload, main process, worker and separate knowledge database with a loopback contract peer. It verifies exact source bytes and Chinese search; confirmed edits, moves, deletion and conflict resolution; canceled previews and history; separately confirmed workflow registration and file installation; actual sync impact data; disabled local-only sharing; mapped sharing after confirmation; another runtime process reading the journal; and restart persistence. Picker automation selects only scratch originals and is not a manual OS-picker receipt.

The real worker request retained escaped team-then-personal preferences in 851 bytes, with legacy file context afterward and disabled/conflicted/shared memory excluded. The 48,000-byte limit and prompt-budget tests remain unchanged.

## Checks and first failures

[checks.json](validation/knowledge/checks.json) preserves final results, every platform skip, initial failures and the distinct pre-rebase acceptance summary. These commands ran after the rebase integration corrections, before the storage-only history rewrite:

| Command | Result |
| --- | --- |
| `npm run check` | 1,800 passed, zero failed, 10 Windows skips; types and CLI build passed |
| `npm run check:apps` | Renderer 343, desktop 163, runtime 820 passed; zero failed, 17 Windows skips; types and application build passed |
| Three package `format:check` commands | Passed |
| `knowledge-native.mjs`, development | 13 effect groups, 53 original screenshots, zero errors; no skipped steps |
| `native-terminal-accessibility.mjs`, rebuilt package | Both effect groups passed; no skipped steps |
| Upstream contract drift check | 46 mirror / 67 upstream comparisons passed against a clean Hub `410c9c44` archive |

Two first failures during that integration remain recorded. The terminal AX driver first clicked a sidebar session behind open modal Settings after the former 600-line failure had passed; it now closes Settings through the existing visible control. The knowledge conflict editor first moved outside the window during entry because its independent CSS `translate` compounded #405's animated centring `transform`; the integrated stylesheet uses the exact #405 base rule. Both corrected native flows passed with the original timeouts, visibility and first-frame assertions intact.

[terminal-ax.json](validation/knowledge/terminal-ax.json) binds the new package to actual AX text, trusted system accessibility switches, original AUTO/ALWAYS controls, the same DOM/PID, retained selection/scroll and complete 600-line CJK copying. The clipboard was restored and the application closed. [artifact-receipt.json](validation/knowledge/artifact-receipt.json) records ASAR SHA-256 `6135a20046b8f44da9b6981728b3f75eb611e65685b62ee70363542f0652eb10`, the disk image digest and the aggregate of 2,579 artifacts; 2,645 ASAR build files and 50 protocol resource copies were compared. Nothing was installed into Applications or published.

The evidence rewrite reruns the three format checks, the locked production Jekyll build and local documentation/receipt integrity checks. The full CLI/application suites are not rerun for this storage-only change. No test or script reads the removed committed evidence directories; the native harness continues to emit regenerable full manifests into ignored artifacts. The final storage checks are recorded in checks.json.

## Earlier real-Hub and packaged acceptance

[hub-roundtrip.json](validation/knowledge/hub-roundtrip.json) is retained unchanged from the approved pre-rebase stage-6 run: seven effect groups and 69 sync HTTP responses against an untouched archive of Hub `410c9c44fcedef41bd1755bdbd0bef6600cd904e`. It used real OAuth password/consent/code exchange through Circle, temporary PostgreSQL and FileKeyProvider/vault, two synthetic accounts and a random loopback port; ports 7420/7443 were excluded. No owner credentials, live Hub, real model or business source was used.

The effects cover exact first sync and another account's denial; edits on both sides with both conflicting bodies preserved; explicit resolution; exact accepted-mapping sharing to an independently readable team copy; checked local-only purge with retained local/team copies; resume into a new epoch; and a revoked-token 401 that pauses without background login, followed by explicit re-login and an exact synchronized read.

The real Hub refuses locally uploaded knowledge with `SHARE_UPLOAD_UNSIGNED` despite quotation verification. The refusal is retained. A separate successful case uses `artifacts.ingest` to seed an independently observed **synthetic** team capture, without changing the upload's provenance. This establishes that qualified synthetic path, not a real connector or upload signing. Memory sharing has a separate path; the current share dialog preserves the Hub refusal and gives the uploader-signing action, as [known issues](../known-issues.md#local-knowledge-and-personal-sync) records.

The approved pre-rebase development and packaged checks also covered complete desktop acceptance (17 helper unit tests, 23 completed main checks), interface at wide/1024 px (48 commands and 88 groups each), live (25 groups), browser-live (29 groups), and knowledge (13 groups with 53 screenshots each). Both 53-image knowledge matrices were inspected then; only the post-rebase representative set is stored in Git now. The legacy desktop receipt was written before its final assertion and recorded 22 groups; completed stdout recorded 23. Packaged browser-page, browser-lifecycle, browser-key-race, terminal-panel and popout were skipped by existing harness guards; browser-live and packaged popout-press ran separately. The original pre-rebase terminal AX supplement failed at the real 600-line assertion because #405's focus fix was absent. That historical failure is distinct from the passing post-rebase AX above.

## Compact manifests and regeneration

The native and artifact receipts contain manifest counts and aggregate SHA-256 digests instead of per-file lists. The aggregate encoding is UTF-8 `JSON.stringify(records)` plus one LF, with records sorted by `path` (or screenshot `file`) in JavaScript code-unit order and their original fields/order preserved. Full receipts and manifests remain outside Git in ignored local artifacts. Individual retained PNG and ASAR/disk-image digests remain directly reviewable.

Rebuild the desktop, then run the existing native harness with isolated directories to regenerate full source/build/layout manifests and synthetic screenshots:

```sh
CIRCLE_HOME="$(mktemp -d)" CIRCLE_WORKBENCH_DATA_DIR="$(mktemp -d)" \
  node --import tsx apps/desktop/test/knowledge-native.mjs
```

It writes to ignored `apps/desktop/artifacts/knowledge/development` by default; `CIRCLE_KNOWLEDGE_EVIDENCE_DIR` selects another local destination. `sourceEvidence()` and `rendererEvidence()` in the existing evidence helper can regenerate just the source/build manifests. Packaging regenerates the full artifact manifest in its output folder. A new native run naturally produces new timestamps, identities and image hashes; aggregate receipts bind the recorded run rather than asserting that later screenshots will be byte-identical.

These results cover macOS arm64, scripted models and synthetic resources. They do not establish production deployment, business correctness, manual OS pickers or other native platforms. Post-rebase development knowledge and packaged terminal AX remain separate from pre-rebase real-Hub round trips and full packaged knowledge acceptance.

## Unsigned-upload refusal follow-up

The published PR receives a new commit, without rewriting its approved history. `SHARE_UPLOAD_UNSIGNED` now remains in the share dialog as a Hub business refusal: both interface languages show its `message` and `fix` unchanged, plus a localized instruction for the uploader to sign the upload in the Hub console and share again. Raw unrelated host errors stay hidden. Existing credential checks apply before server text crosses IPC; refusing a share leaves local revisions unchanged and consumes the confirmation ticket. Checking and confirming again remain explicit actions; there is no automatic retry.

The follow-up used only the synthetic selected MCP connection. Its development and packaged runs each passed 15 effect groups with 55 captures and zero page/console/request errors, including the exact two fields in Chinese and English. Both fresh refusal screenshots were inspected at 1x. Only the Chinese narrow frame is committed, replacing one earlier image so the set remains at 15 PNGs. Full manifests and the English frame remain in ignored artifacts; this is client presentation evidence, not another real-Hub round trip.

## Personal pages before binding a Hub

When the saved Hub binding is empty, knowledge and memory show only mine; even a team-scope URL requests the personal list. The sidebar reads “未连接 Hub” / “Hub not connected” and opens the existing sync settings. Bound connections retain their previous scopes and behavior, including in local-only mode. No additional offline/login states, workflow views, shared listing, session-memory or cache changes are part of this follow-up.

Each page has a dedicated regression in both interface languages, also checking that a bound local-only connection retains all three scopes. Development and packaged native runs each passed 18 effect groups with 57 captures and zero page/console/request errors. The native checks verify an actually empty saved binding, loaded personal rows on both pages, no remote tool read or load error, and the original sidebar control opening settings in both languages. [Chinese light](validation/knowledge/zh-CN-light-1440-no-hub-knowledge.png) and [English dark](validation/knowledge/en-dark-1440-no-hub-knowledge.png) were inspected at 1x; they replace two existing images so the set remains 15 PNGs. The first in-flight-disconnect observation and the completed-action barrier are recorded in no-hub.json; no timeout or assertion was relaxed.

## PR CI fixture and terminal text-reading corrections

The Windows check in run 41561578080 exposed knowledge fixtures that registered scratch removal before SQLite closure. Node runs `t.after` hooks in registration order; Windows refuses deletion while those database handles are open. The fixtures now register owned resources through the existing `cleanup()` helper, which closes them before removing directories. A regression checks that the real SQLite database closes while its file still exists. Frozen exchange objects and store snapshot fixtures use batch admission; memory quota setup creates one populated snapshot rather than many irrelevant revision histories. Independent account homes remain separate beneath a shared scratch root. Production code, `synchronous=FULL`, object fsyncs, timeouts, Windows coverage and protocol mirror bytes are unchanged.

Linux native run 41561578064 attempt 1 identified a test text-reading defect: the shell echo was split as `ab` then `c` at a soft wrap, and `innerText` inserted a newline at that visual row boundary. All three characters reached the shell and the composer draft remained intact; the check incorrectly required the echo to fit on one rendered row. Claude reported that attempt 2 passed, by chance of the prompt width avoiding that split. The identical test at #405 (`169bd3cc`) has the same latent issue. The original log excerpt is:

```text
2026-11-03T01:52:32.8998286Z Error: timed out: the keys after the click reached the shell
```

The correction reads `textContent` over the same visible xterm rows, preserving the exact `abc` expectation, real keyboard input, forced composer-focus competition, unchanged draft assertion and original timeout. It corrects how the real effect is read rather than weakening the check. After a temporary restoration of the old test in `d8923e71`, Claude confirmed the cause and directed reapplying the exact `6494ac02` change in a new commit. This is a latent harness defect, not a knowledge focus or input-routing regression; the short source review found no plausible knowledge-specific delay after the click. The earlier GPU results keep their historical source attribution; the fresh GPU on/off rerun is recorded separately in `ci-follow-up.json`. Windows fixture fixes and measurements are unchanged.

The fresh local development rerun completed both GPU on and GPU off flows, with two `popout: ok` results, exit 0 and no skipped steps. It used synthetic fixtures and isolated Circle/workbench data. Its exact test bytes, code commit and aggregate log digest are recorded under `freshNativeRun`; the full CLI/application suites and other native platforms were not rerun for this test-reading-only reapplication.

[ci-follow-up.json](validation/knowledge/ci-follow-up.json) records checks and per-file resource measurements, with aggregate digests for the ignored raw observations. The earlier screenshots and packaged/Hub receipts retain their original provenance; no PNG is added or replaced for these test-only changes.

To reproduce Node-level counters and the strict open-database cleanup guard from the repository root:

```sh
knowledge_metrics_dir="$(mktemp -d)"
CIRCLE_HOME="$(mktemp -d)" CIRCLE_WORKBENCH_DATA_DIR="$(mktemp -d)" \
  CIRCLE_KNOWLEDGE_TEST_METRICS="$knowledge_metrics_dir" \
  CIRCLE_KNOWLEDGE_TEST_STRICT_CLEANUP=1 \
  NODE_OPTIONS="--import=$PWD/scripts/knowledge-test-metrics.mjs" \
  node --import tsx --test --test-concurrency=1 tests/knowledge*.test.ts
```

Each process emits counters and a basename, without arguments, credentials or local paths. BEGIN counts include read transactions; prepared autocommit DML is separate. Scratch counts are `mkdtemp` roots, not every private subdirectory. Explicit fixture children are counted separately from the runner, file workers and transpiler processes. An owned helper deliberately killed after readiness retains its announced startup counters.

The optional macOS `scripts/knowledge-test-fsync.c` companion can be compiled with `clang -dynamiclib` into the scratch directory and loaded through `DYLD_INSERT_LIBRARIES` for that same command. It records native fsync calls and process ancestry, including compiler helpers. Calibration separates Node/libuv fsyncSync calls (JS counter) from SQLite's native calls, so the receipt reports both rather than mistaking the JS count for all disk synchronization. The tracer never links into the application or changes its durability settings. Full metric files and before-change test snapshots stay in ignored artifacts.

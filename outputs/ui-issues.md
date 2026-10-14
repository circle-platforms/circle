# Issues #5, #22 and #60: implementation and isolated verification

Worktree: `/Users/qingshanfeihu/.codex/worktrees/issue-two-end-fixes/circle`.
All runtime verification uses scratch Circle data/workspaces, scripted models or local fixtures. Verification used no real Circle data or paid endpoint. It finished before the user authorized publishing the issue/PR update.

## Reproduced before the change

- #5: a real `write_todos` completion still rendered `Plan 1/1`; the new expectation failed. `alt+p` did not establish plan focus; the new focus expectation failed.
- #22: the baseline `strip_rows.ts` from Git HEAD returned `old task` despite a current `Read(notes.txt)` activity. This was reproduced from a temporary baseline module. The first draft of the runtime regression lacked a model usage fixture and was corrected before judging the activity behavior.

## Changes

- Both interfaces hide completed plans, retain the runtime/stored steps, emit one notice per completion transition, and keep a completed plan visible during a plan-exit decision. Restored completed state seeds the completion tracker without emitting a new notice.
- Terminal: remappable `plan.focus` defaults to `alt+p`; clicking the plan also focuses it. Focused arrows scroll its steps, Escape returns without cancelling or clearing the draft, and typing returns to input. Cards and pickers retain their keys.
- Desktop: the plan is a focusable region, with arrow scrolling and Escape back to the composer. Unrelated native snapshots do not reset manual scrolling. Completion notices and activity state words have Chinese translations; tool text remains unchanged.
- Both interfaces use real subagent tool events for current activity; approval waiting takes priority. No synthetic assistant introduction or raw argument JSON is added.
- Coordinated wiring: the terminal welcome and `/session` show current network trust; coordinate clicks offer `allow once` / `reject`; the desktop archived-conversation banner exposes restore and hides the composer.
- Existing busy-time decimal precision and integer summary precision remain unchanged.

## Verification actually executed

- Terminal focused regression set: **62/62 passed**, including new UI issues, plan queue, subagent UI, status surfaces, slash commands, palette guard and cross-interface number formatting.
- The UI issue file was subsequently expanded with a real `plan_exit` question through the Harness: **8/8 passed**.
- Workbench tests: **37/37 passed** after the coordinator's archive regression was added, including English/Chinese activity text, completion visibility, shortcut coverage and all interface translation checks.
- Workbench and desktop type checks passed in this task. The coordinating agent completed the final root check: **542 total, 540 passed, 2 Windows-only skips, no failures**, with the CLI build succeeding. Desktop controller runtime tests were reported **56/56 passed** by the coordinating agent; these are distinct from this task's own runs.
- New full-screen connection regressions and shared probe tests: **9/9 passed** (4 connection tests, 5 probe tests). Root TypeScript checking was rerun and passed after these test additions.
- Native trust verification was reported by the coordinating agent as **3 development checks and 3 packaged checks passed**. These are the coordinator's separate TLS/proxy fixtures, not executions by this UI task.
- Native development/packaged validation is recorded below when each run completes. Unit/helper checks alone do not prove the native renderer/worker path.

## Native UI evidence

The first native development run passed focus/arrow/Escape checks in both themes and the completed-plan hiding/one-notice checks. It exposed a real controller projection bug: an empty assistant tool turn had no projected assistant row, and a tool-result row used a different checkpoint id, so the notice was appended after the final answer. Parent-id anchor matching was repaired by the coordinating agent and the next native run passed the unchanged assertion.

That run also exposed a second actual interface issue: native `plan_exit` comes through the ordinary core question interaction, while the old renderer condition only recognized the preview-only `plan-exit` kind. The renderer now also recognizes the actual question's implementation choice. The saved `ui-issues/development/plan-exit-state.json` recorded the failing state. A new terminal regression verifies the actual core question, rather than only a handcrafted card.

The first language-switch trial used a renderer reload; the test profile intentionally forces English on startup, so that trial was corrected to use the real Settings language control without treating it as a product defect.

A stricter native check also verified the default Alt+P itself, before issuing an arrow through a locator that would focus automatically. It exposed a missing default-key branch: the desktop remap matcher intentionally handles only user mappings. The ordinary Alt+P branch was added while preserving remap and modal priority. This expectation remains in the native test.

The dark and light `plan-focus-*.png` screenshots were visually inspected: the focused border, four complete visible rows and unchanged composer were clear in both palettes.

Final development validation passed **6/6 native checks**, `packaged: false`, with no page errors. The successful receipt is `ui-issues/development/receipt.json`. Completion screenshots were visually inspected in Chinese under dark/light themes: the notice precedes the next tool/answer, and model text remains English. The actual agent-step screenshot also shows the real Bash event summary.

The coordinator's first packaged run passed **6/6 native UI checks**, `packaged: true`, with no page errors. Its `ui-issues/packaged/receipt.json` was inspected, as were the dark/light focused-plan and actual-step screenshots. After the browser safety corrections, the final packaged chain again passed all 6 UI checks with no page errors.

`apps/desktop/test/ui-issues.mjs` drives the sandboxed renderer, restricted preload and real worker/Harness, verifies actual child process/file effects and the next model request, and saves theme screenshots and a receipt under `outputs/ui-issues/`. The packaged test uses only system directories on PATH; its synthetic child program is an explicitly quoted absolute test Node executable, rather than a PATH lookup.

## Limits

No real Windows Terminal/IME, Linux desktop, or operating-system clipboard verification was performed by this UI task. Synthetic native inputs are not reported as platform clipboard tests. These checks run on the current macOS host.

## #60 / PR #61 coverage review and added end-to-end evidence

The live GitHub PR metadata was read; no remote state was changed. Current source/test inspection shows shared pagination/array/failure handling and both entry adapters wired to the same helper. Existing terminal full-screen setup and `/login` integrations verify custom discovery, saving and the subsequent local SDK request. Preset protocol/id saving is tested through SetupFlow/line init; desktop controller preset tests also verify actual OpenAI/Anthropic SDK requests. Native live UI checks prove preset no-discovery, manual-id choices, page-21 visibility and Together selection/requests.

The additional coverage was implemented in independent test files without further product changes:

- `tests/connection-issues.test.ts` drives real keys and paste events through both first-run SetupCard and `/login` Picker. Each entry selects explicit OpenAI and Anthropic presets, edits the endpoint and model id, saves only after model selection, and sends the exact id/key/protocol through the actual local SDK. Presets make zero discovery requests.
- Both terminal entries also receive a real second-page HTTP 503 and a repeated cursor. They expose no truncated model list, cannot save an empty model, and leave both saved files byte-for-byte unchanged. After cancellation, an actual request still uses the original endpoint, model and key.
- `apps/desktop/test/connection-issues.mjs` actually chooses and saves Anthropic model 21, then checks the exact id in the native worker's SDK request. A second-page HTTP 503 exposes no partial choices, keeps the saved settings/credentials unchanged after empty submission and cancellation, and the following SDK request still uses the saved connection.

The independent native connection development run passed **3/3 checks**, `packaged: false`, with no page errors. Its receipt is `connection-issues/development/receipt.json`; model 21 was visually reviewed under both themes, and the failed discovery form was inspected. The final packaged connection run also passed 3/3 checks with no page errors; its receipt is connection-issues/packaged/receipt.json. A repeated-cursor scenario is exercised through both terminal forms and the shared probe; it was not separately driven through the native form.

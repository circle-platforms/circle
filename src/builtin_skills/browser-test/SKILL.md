---
name: browser-test
description: Test a web user flow with Circle's browser tools and observable results. Use when asked to exercise a page or validate frontend behavior.
---

# Test a browser flow

Read the task, expected result and existing test setup. Confirm the target URL and that the session exposes Circle's browser tools. A browser is available in the desktop application and, with a supported installed browser, the full-screen terminal. Line and print modes do not supply these tools. If they are unavailable, report the missing capability and any checks still possible; do not claim a browser test passed.

For a local application, use its documented startup command and synthetic data. Start a server with `execute` in the background, retain its job id and confirm readiness before navigation. Use the intended runtime configuration rather than a separate imitation page.

Navigate with `browser_navigate`, inspect `browser_snapshot`, and act using the current snapshot's element refs with `browser_click`, `browser_type`, `browser_select` or `browser_press`. Inspect the new snapshot after a navigation or material state change. Follow the tool descriptions for dialogs, secrets and uploads. Use `browser_screenshot` when appearance is part of the acceptance criteria.

For each requested flow, check its actual visible result and any corresponding navigation, stored state or server effect that matters. Cover the relevant error path as well as success. A clicked button, an HTTP success code or a screenshot alone does not establish that the user's task succeeded. Use snapshots for page assertions and existing server or application observations for effects that the browser tools do not expose.

When asked to save or repeat the flow, use `browser_record` to create a `.circle-browser.json` file. Read that recording, remove exploratory detours, parameterize changing values and add `expect` and `absent` steps. Run it with `browser_replay`. Use its existing `circle: "browser-script/1"` format and wait behavior; do not create another recorder, runner or arbitrary sleep loop. A failed replay identifies its step: investigate it rather than repeating the whole flow until green.

Stop only servers this task started. Report the URL, steps exercised, actual results and untested conditions. State separately which browser checks, visual inspections and backend effects were observed.

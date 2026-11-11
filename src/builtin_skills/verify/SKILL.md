---
name: verify
description: Verify a change against the requested behavior using tests and actual runtime effects. Use when asked to validate work or before reporting it complete.
---

# Verify a change

Read the user's acceptance criteria, the change, project instructions and existing validation commands. Decide what observation would establish each requested behavior. Use the smallest set of checks that covers the change and any required project checks.

Run the relevant tests. When the change affects running behavior, start the real entry point and exercise it: inspect the next request, saved state, generated file, process result or rendered interaction that establishes the outcome. A successful build or a line saying "done" does not establish those effects.

Use synthetic inputs and an isolated data directory for development checks. Use the project's scripted model or local gateway for agent behavior. For a service or watcher, use `execute` with `background: true` and retain the returned job id. Wait for a readiness event or observable state before exercising it; do not replace that with a fixed sleep or retry a failing check until it passes.

For browser flows, use `browser-test` when available. For native desktop changes, run the development application and the packaged application if the project requires both. Include relevant failure, cancellation and existing-behavior cases; avoid adding tests that merely repeat implementation wording.

Compare the observed effects with the acceptance criteria. A failure needs its actual output and cause investigated; an unavailable dependency leaves that part unverified. Stop only the processes this verification started, using their job ids or known process identities.

Report what changed, the commands and interactions actually run, their results, and any acceptance criteria still unverified. Separate automated tests, synthetic integration checks, real application observations and external-system results. Do not claim a deployment or real-model result from a local scripted run.

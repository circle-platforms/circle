---
name: debug
description: Investigate errors and regressions with a reproduction and runtime evidence. Use when asked to diagnose or fix unexpected behavior.
---

# Investigate a failure

Read the exact error, expected behavior, reproduction steps and relevant project instructions. Inspect the existing code, logs and tests before editing. Distinguish what was observed from what is only suspected.

Reproduce with the smallest representative input using the actual entry point. Keep development data isolated; for an agent use a scripted model or local gateway. When reproduction is blocked, identify the missing input, environment condition or observation instead of making speculative changes.

Follow the failing operation across its callers and state boundaries. Form a specific explanation and check the evidence that could confirm or disprove it. Prefer existing logging and inspection facilities. If instrumentation is necessary, collect only what the hypothesis needs and keep secrets out of the trace.

Once the cause is supported and repair is within the user's request, add a regression that reproduces the original failure, then make the smallest change at the owning boundary. Run the regression and relevant surrounding checks. Do not weaken assertions, add retries or increase timeouts to hide the symptom.

If the user asked only for diagnosis, report it without changing the product. Remove temporary instrumentation and stop any processes you started. Report the symptom, evidence, cause or remaining hypotheses, changed behavior and actual validation results. Separate provider responses, Circle's handling and interface display when the fault crosses those boundaries.

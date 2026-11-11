---
name: code-review
description: Review a working diff, branch or pull request for evidence-backed correctness issues. Use when asked to review code; report before fixing.
---

# Review code

Establish the target: current working changes, a named branch and base, or a specified pull request. Read project instructions and inspect the actual diff. For GitHub use the installed `gh` when available; determine the PR and base rather than guessing them.

Read affected callers, contracts and tests, not just changed lines. Trace concrete inputs through the changed behavior, including error paths, state changes and concurrency where relevant. Run an existing focused check or construct a small reproduction when it can resolve a suspected issue.

Report actionable problems introduced by the change. Each finding needs a file and line, a concrete trigger, the incorrect effect, and the evidence connecting them. State prerequisites that limit its impact. Distinguish a confirmed defect from a question that still needs evidence; keep optional cleanup suggestions separate. Follow the project's conventions rather than imposing a preferred style.

A request to review produces findings first. When the user has also asked for fixes, apply the supported fixes and verify them without asking again. Do not treat a review request as authorization to commit or publish comments. If the task is to address existing PR feedback or failing PR checks, use `pr-review` for that workflow; use `security-review` for a requested security assessment.

Return findings in order of impact. If none are supported, say so and identify any relevant coverage gaps. Name the tests actually run and the material you did not inspect. Do not call an untested area correct simply because the diff looks plausible.

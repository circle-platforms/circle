# Windows update issue #45: diagnostic hardening

2026-10-14. This change does not establish the cause of the intermittent Windows update hang and is not presented as its fix. Work was confined to the isolated worktree; no real application, MSI, existing installation or Circle user data was used.

## Changes

- The update harness writes every real stage synchronously to `progress.log` before printing it. Heartbeats have their own record kind and cannot postpone a stalled-stage deadline.
- Immediately before requesting restart, the harness starts an independent Node observer and waits for its readiness. After 180 seconds without a new stage, that process captures evidence even if the test's event loop or output is blocked.
- The observer records the actual test Node PID, parent PID, executable and creation stamp, captures its thread states, and saves stage/application/installer/MSI logs with explicit missing-file information. Available ProcDump collects a full dump before interruption; discovery uses the existing executable or `CIRCLE_DESKTOP_PROCDUMP`, with no automatic installation. A missing or failed dump is recorded as `unavailable`.
- Only processes with confirmed test ancestry are eligible for termination. Every identity is checked again. Windows uses a retained process handle and exact creation FileTime plus executable before killing a process, so a reused PID cannot authorize killing its replacement. ProcDump/thread capture use the same identity check and pinned target handle. An installer whose transient parent disappeared may be recorded by its unique scratch path, but that evidence alone never authorizes termination. No process-name kill or `taskkill /T` is used.
- If the owner identity cannot be verified, evidence records that limitation and no uncertain process is killed. Native queries, dump collection and observer shutdown are bounded.
- Windows CI puts retained evidence under `${RUNNER_TEMP}/circle-update-evidence/` and uploads it with `always()`, including after a failed update check. The packaged artifact upload also uses `always()`.
- The #43 `installationAttempted` ownership guard remains intact. A rejected preflight or failed initial install never starts the restart observer. Existing installations remain outside this test's cleanup authority.

## Local verification

Executed on macOS with Node 24.19.0:

```text
node --test apps/desktop/test/update-harness.test.mjs apps/desktop/test/update-observer.test.mjs
8 passed, 0 failed, 0 skipped
```

The five observer fixtures exercise real independent Node processes:

1. The target blocks its JavaScript event loop with `Atomics.wait`, while an external producer keeps appending heartbeats. The observer still saves the original stalled stage and process/thread evidence, then ends the owned Node and its child. An unrelated live sentinel remains running.
2. An older apparent child and a child of a reused foreign parent are excluded from the owned process tree.
3. Real stage changes postpone the deadline, and a healthy target finishes normally.
4. A deliberately different creation stamp for a live PID yields `owner identity changed` and an empty termination list; the live target exits normally.
5. A normal stop request shuts down the observer without terminating its owner.

All three existing fake-native #43 regression cases also passed. They verify existing installation preservation, cleanup of this test's own partial install, and the GitHub runner cleanup exception. Each now additionally asserts that no observer plan was created during preflight or failed initial installation.

## Remaining Windows evidence

This machine has neither Windows nor a PowerShell interpreter. The Windows process-handle/CIM/thread/ProcDump branch was reviewed statically but was not executed, and no real MSI update was attempted. Its native validation belongs on a disposable Windows runner with the original per-machine/admin path. A Windows run should confirm creation stamps, thread JSON, bounded dump capture or its explicit absence, scoped termination and retained artifact upload before calling the diagnostic path verified there. The historical per-user fixture successes do not substitute for that check, and absence of a new stall does not prove the original root cause.

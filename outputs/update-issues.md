# Windows update issue #45: diagnostic hardening

2026-10-14. This change does not establish the cause of the intermittent Windows update hang and is not presented as its fix. Local work was confined to the isolated worktree and synthetic processes, without using an existing installation or Circle user data. The subsequent GitHub Windows runner performed a real MSI install and update on its disposable machine.

## Changes

- The update harness writes every real stage synchronously to `progress.log` before printing it. Heartbeats have their own record kind and cannot postpone a stalled-stage deadline.
- Immediately before requesting restart, the harness starts an independent Node observer and waits for its readiness. After 180 seconds without a new stage, that process captures evidence even if the test's event loop or output is blocked.
- The observer records the actual test Node PID, parent PID, executable and creation stamp, captures its thread states, and saves stage/application/installer/MSI logs with explicit missing-file information. Available ProcDump collects a full dump before interruption; discovery uses the existing executable or `CIRCLE_DESKTOP_PROCDUMP`, with no automatic installation. A missing or failed dump is recorded as `unavailable`.
- Only processes with confirmed test ancestry are eligible for termination. Every identity is checked again. Windows uses a retained process handle and exact creation FileTime plus executable before killing a process, so a reused PID cannot authorize killing its replacement. ProcDump/thread capture use the same identity check and pinned target handle. An installer whose transient parent disappeared may be recorded by its unique scratch path, but that evidence alone never authorizes termination. No process-name kill or `taskkill /T` is used.
- If the owner identity cannot be verified, evidence records that limitation and no uncertain process is killed. Native queries, dump collection and observer shutdown are bounded.
- PowerShell subprocess stdin is closed, and the isolated fixtures preserve the Windows shell/module/application paths needed by native process queries. A plain .NET file trace records script entry, plan loading, process-handle acquisition, CIM, executable and creation-time reads. A bounded native failure includes that trace in its error; the ordinary 15-second subprocess bound remains in place, with a five-second CIM operation bound.
- Windows CI puts retained evidence under `${RUNNER_TEMP}/circle-update-evidence/` and uploads it with `always()`, including after a failed update check. The packaged artifact upload also uses `always()`.
- The #43 `installationAttempted` ownership guard remains intact. A rejected preflight or failed initial install never starts the restart observer. Existing installations remain outside this test's cleanup authority.

## Local verification

Executed on macOS with Node 24.19.0:

```text
node --test apps/desktop/test/update-harness.test.mjs apps/desktop/test/update-observer.test.mjs
9 passed, 0 failed, 0 skipped
```

The six observer fixtures exercise independent Node processes:

1. The target blocks its JavaScript event loop with `Atomics.wait`, while an external producer keeps appending heartbeats. The observer still saves the original stalled stage and process/thread evidence, then ends the owned Node and its child. An unrelated live sentinel remains running.
2. An older apparent child and a child of a reused foreign parent are excluded from the owned process tree.
3. Real stage changes postpone the deadline, and a healthy target finishes normally.
4. A deliberately different creation stamp for a live PID yields `owner identity changed` and an empty termination list; the live target exits normally.
5. A normal stop request shuts down the observer without terminating its owner.
6. An intercepted Windows native query proves stdin is closed and a simulated `ETIMEDOUT` retains its original error code and the last native trace. This fault injection supplements the real Windows fixtures; it does not replace them.

All three existing fake-native #43 regression cases also passed. They verify existing installation preservation, cleanup of this test's own partial install, and the GitHub runner cleanup exception. Each now additionally asserts that no observer plan was created during preflight or failed initial installation.

## Windows CI verification

The first PR #65 Windows job failed four real observer fixtures at their initial `powershell.exe` identity query after the existing 15-second bound, with no stdout or stderr. That evidence alone did not distinguish native process querying from PowerShell startup. Closing stdin, preserving required Windows environment paths, and adding native trace points resolved this fixture failure in the subsequent real runner without skipping cases or extending that bound.

[Run 38531936374, Windows job 115745979813](https://github.com/circle-platforms/circle/actions/runs/38531936374/job/115745979813), revision `38027513b892fbc45eb7c729cd42ea29c76c99e0`, recorded:

- Desktop runtime: 56 tests total, 55 passed, 0 failed, 1 skipped (the macOS installer case).
- Observer isolation and #43 ownership regression: 9 passed, 0 failed, 0 skipped. The blocked Node fixture completed in 6.6 seconds, recorded the owned child in its process tree, terminated the owner, and left the unrelated sentinel alive. Native identity/CIM ancestry, creation-stamp rejection and normal shutdown therefore executed on Windows.
- Package, MSI compilation and MSI inspection succeeded.
- A real per-machine MSI installed 1.5.0 under `C:\Program Files\Circle`, then updated to 1.5.1 through settings. All six update checks passed: discovery, download validation, old-process exit, restarted version, installed-state display, and replacement/cleared download. The installer log recorded `msiexec exited with 0`.

The successful harness deleted its scratch folder as designed. The `always()` evidence upload step therefore reported no files and produced no update-evidence artifact in this run. The retained job log is the evidence for this successful path; a failed harness keeps its folder for upload. The local downloaded job log is `/tmp/circle-pr65-windows-success.log`.

## Remaining evidence

This macOS machine still cannot execute native Windows MSI or PowerShell. The Windows runner passed the normal update path and observer isolation, but did not reproduce the original intermittent hang. The current blocked fixture checks process ownership, stage evidence, termination, sentinel survival and dump status; it does not assert that the thread JSON is a nonempty array or that ProcDump captured a dump. Its temporary fixture files were removed, so those contents cannot be independently inspected from this successful run. A future real stall should retain that evidence, including an explicit dump absence when ProcDump is unavailable. User-machine Windows validation remains distinct from this disposable runner, and absence of a new stall does not prove the original root cause.

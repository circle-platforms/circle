# Windows command Job adapter candidate

This slice supplies a **trusted opt-in candidate**, not enabled Windows desktop support. `createTerminalCommandLauncher({windowsJobObject:true,...})` selects the Windows Job adapter. The ordinary Windows launcher continues to fail closed until native Windows and packaged acceptance passes. No renderer option enables it.

The implementation reuses root `koffi` 3.3.3. It creates an unnamed, non-inheritable Job with `KILL_ON_JOB_CLOSE` and no breakaway flags. A quiescent Node supervisor is started in the original ConPTY with Node preload variables cleared. Its authenticated private-pipe PID must match the returned PTY identity; a retained native process handle must have the expected executable, creation time within this launch, and a live wait status. The actual shell starts only after successful assignment and `IsProcessInJob` confirmation.

An actual root exit, a native empty Job, and original PTY/log closure are independent facts. Root exit is persisted before its acknowledgement. Natural completion requires the only remaining member to be the retained supervisor before requesting its exit. Stop first requests the actual root's exit, then terminates the retained Job to end remaining associated members. A missing root exit stays failed; wrapper exit and successful termination never synthesize a command result. Descendant coverage remains `unknown`: external brokers can launch processes outside the Job.

`windows-command-job.test.ts` includes portable handle-boundary tests and a Windows-only native inherited-child test. `workspace-command-windows.test.ts` includes Windows-only original ConPTY input, actual port release, full original output, natural completion and preload isolation. The existing runtime test runner discovers both files automatically, including on the existing Windows CI job. Skips on macOS do not validate these native cases.

Before enabling the ordinary worker:

- Run these actual Windows tests and preserve failed process/Job/output evidence.
- Verify Koffi native payload loading in the shipped Electron utility process and packaged application. The current desktop tool-copy list does not yet establish this payload, so a successful source import or bundle is insufficient.
- Add native nested-job assignment-denial, control-loss, host-crash kill-on-close, and concurrent Stop acceptance with actual handle/port effects.
- Keep default fail-closed behavior if assignment, ABI, authenticated identity, native querying or original log closure cannot be confirmed.

Win32 references: [Job objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [assignment](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject), [native query](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject). Job membership and accounting refer to associated members, not arbitrary descendants launched through external services.

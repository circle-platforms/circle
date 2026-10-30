---
parent: Development
nav_order: 9
---

# Windows acceptance on a real machine

What has actually been tried by hand on Windows, what it showed, and what still has no
evidence. The rows here back the Windows bullets in [Known issues](../known-issues.md).
The desktop application's own command adapter, which is a different layer, has its page:
[Windows command Job adapter](windows-command-job.md).

## The machine and the run

Windows 11 Pro 10.0.26300, Node.js 24.21.0, PowerShell 7.6.9 as the host shell, and a
console whose code page is **936 (GBK)**: `chcp` reports 936 and the system ACP is 936.
Circle 1.13.1 from source through `npm run dev`, with `CIRCLE_HOME` and the workspace in
throwaway folders under `%TEMP%`, and a local scripted gateway on `127.0.0.1` in place of
a model endpoint: no real endpoint, no real data, no account. Run October 30, 2026.

## The full-screen interface in a console

Tried by hand in a PowerShell console — not Windows Terminal's own window, and not the
packaged build:

- startup: the welcome block, the recent-session list, the header, the composer frame and
  the footer's token line all drew;
- typing, `enter`, the slash-command completion (`commands · 1/44`), and commands running;
- an approval card for `del /q note.txt`: `This deletes or overwrites data.` with the
  reason `destructive operation`, and only **Allow once / Reject and explain** — the
  "for this session" answer an ordinary command gets is absent, as
  [Security](../security.md) says it should be;
- `1` answered that card and the command ran;
- a command started with `background: true` returned at once, its row in the strip showed
  its live tail, and `/jobs` listed it, then showed it as `done`;
- `/reload` after the saved connection had changed on disk answered `✖ /reload failed:
  saved connection changed in another Circle runtime; reconnect before continuing`.

Not covered here: window resizing, the mouse, `esc` and the `alt+…` chords (my driver
dropped those bytes; Circle never saw them), and the packaged `.msi` install, its PATH
change and `/copy`. Those stay open in [Known issues](../known-issues.md).

## What a command leaves running

The command was

```
cmd /c start /b cmd /c "powershell -WindowStyle Hidden -Command Start-Sleep 400" & ping -n 25 127.0.0.1
```

While it ran, the detached `powershell` was alive — one process — although the `cmd` that
started it had already ended, which is the case `src/windows_stranded.ts` describes: the
Job holds a command's whole tree "even after the processes between have ended". Then:

| How Circle went away | the detached child afterwards |
| --- | --- |
| a clean print-mode exit, exit code 0 | gone |
| the Circle process ending | gone |

So the promise in [Known issues](../known-issues.md) that what a command leaves running is
ended when you leave Circle holds on this machine, and the process-list fallback was not
needed: the Job itself held the orphan.

## Reading command output in a 936 console

`chcp 936 >nul & echo 小` reached the model correctly as `小`: on that path the bytes in
the pipe were already UTF-8, which is what the code-page note expects.

The harder case was then forced. A command wrote the two bytes `0xD0 0xA1`, which are
`小` in code page 936 **and** a valid two-byte UTF-8 sequence for U+0421 `С`. The model
was told `С`. So the documented rule — output that decodes as UTF-8 is read as UTF-8 —
is real, measured rather than inferred: on a GBK machine a program that writes correct
GBK can reach the model as the wrong Cyrillic letter. Only a program writing genuine
UTF-8, or bytes that are not valid UTF-8, gets the code-page reading.
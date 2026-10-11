---
nav_order: 23
---

# Known issues

This page lists what does not work as you might expect in the current version, with a way around each where there is one. It is written from the code and from running it, and it is updated as things are fixed.

## Install and release

- **Very old sessions can lose their installed files after several updates.** An installation keeps the newest three versions and the one it replaced. It does not track every other open session. Close sessions from older versions before repeatedly updating or reinstalling.
- **The Windows build has not been tried in a real console.** The release workflow builds it for x64 and arm64 and tests installing it, starting it and a scripted run. The full-screen interface, keys, window resizing, `/copy` and the user `PATH` change still need checking in Windows Terminal, PowerShell and cmd. A terminal window that is not a Windows console, such as the mintty window of Git Bash or MobaXterm, may not count as a terminal; use Windows Terminal, PowerShell or cmd.
- **Stopping commands on Windows has not been tried on a real machine.** `esc`, `ctrl+b`, a timeout, `/jobs` and leaving end a command with `taskkill /T /F`. Processes a command leaves running are not turned into a [background job](background-jobs.md) on Windows: Circle cannot see them.
- **On Windows the model's commands run in `cmd.exe`**, not in bash. The approval rules recognise the common Windows delete, format and elevation commands, but they were written for a POSIX shell and are less tested against `cmd.exe` and PowerShell syntax. Read each command on the card.

## Sessions

- **Going back with `/tree` does not undo file changes.** It changes what the model remembers, not your files.
- **`/undo` does not make the model forget, and does not revert files.**
- **`/yolo` turns itself off** on `/new`, `/fork`, `/clone`, `/import` and restart.
- **`projects/` in the data folder is mostly not cleaned up.** It keeps the messages that summaries replaced, very long tool results, pasted pictures and screenshots, for every project; only command and job output is removed, a day after its run ended. Delete old folders by hand.
- **Circle 0.5.0 cannot import the JSONL exports of this version.** This version imports 0.5.0's.

## Safety

These are gaps to know about before you trust Circle with a repository or a machine you do not fully control. The complete list is in [Security](security.md#what-is-not-protected).

- **`/yolo` also skips the questions Circle always asks**, such as `rm -rf` and force-push.
- **Custom commands can run shell snippets without asking**, and a trusted folder's commands, skills and instruction files apply at once. Read a repository's `.circle/`, `.opencode/`, `.pi/`, `.claude/` and `.agents/` folders before you trust it.
- **The credential-file check reads names, not contents.** File tools and commands refuse the listed names, but `ls` and `glob` show them, and a command that reaches a file without naming it (a script, a variable, a copy under another name) is not refused.
- **A secret can be written to any path the model names.** Check the file on the card before you enter the value.

## Subagents and tools

- **Tool calls other than `task` in one reply run one after another.** 0.5.0 asked every approval first and then ran all the calls of a reply at the same time; here only `task` calls next to each other run together. To run subagents side by side, the model can start them with `background: true`.
- **`grep` searches for literal text, not regular expressions.** Its description says so and points the model to `rg` in the shell for a regular expression, which asks for approval like any command.

## Images and screenshots

- **Pasting a picture and `screenshot` have not been tried on a real Windows or Linux machine.** They use PowerShell on Windows, and `wl-paste`, `xclip` and the screenshot programs on Linux; the tests run them against stand-ins. On macOS, pasting a picture from the clipboard has been checked by tests only.
- **On macOS a missing Screen Recording permission is guessed** from whether other applications' window titles can be read. When the guess is wrong the picture shows only the desktop. The model is told why that may be when the other windows' titles are hidden, but not when only the terminal's windows are on screen.
- **Without `app`, `screenshot` takes the main display only on macOS and Windows**; other displays are left out. On Linux the screenshot programs take every display.
- **On Windows a minimized window cannot be taken.** The model is told to ask you to restore it.
- **Only PNG files are scaled down.** JPEG, GIF and WebP pictures, and pictures an MCP server returns, are sent at the size they are; an endpoint may refuse one that is very large.
- **After upgrading from 1.0.4, which models read images is known once models.dev is fetched again**, within a day unless `CIRCLE_NO_MODELS_REFRESH` is set. Until then pictures go to every model, as in 1.0.4.
- **A model models.dev does not list is assumed to read images.** If its endpoint refuses them, the request fails; set `"images": false` for the model under `models` in the settings.

## Background jobs

- **A process that leaves its process group is not tracked.** `setsid`, a daemon that detaches, or a program that starts a service elsewhere is not part of the job: stopping the job, or leaving Circle, does not stop it.
- **If Circle is killed with `SIGKILL`, or crashes, its jobs keep running.** Find them with `ps` and stop them yourself.
- **Jobs do not outlive Circle.** A reopened session has none running; the note Circle leaves names the ones that were stopped (not after `SIGTERM`, `SIGHUP` or a closed terminal window).
- **A background subagent keeps the agent it started with.** After `/reload`, `/models` or a change of extensions it still uses the old tools and model until it ends; `/plan` reaches it.
- **The output a dev server prints may not show on its row**: many programs keep their output in a buffer when it does not go to a terminal (`python3 -u` and `PYTHONUNBUFFERED=1` help for Python).

## Read-only mode

Any file whose name is `plan.md` or `plan` can be written, edited or deleted in any folder, with the usual approval. Everything else that changes something is refused.

## Slow failures

If your endpoint is slow or never answers, a turn can take a long time to give up. A timeout is retried 10 times, and each try waits longer for the answer, up to 5 minutes, so an endpoint that accepts the connection and then sends nothing takes about 50 minutes. Press `esc` to stop sooner. An endpoint that refuses the connection gives up within about five minutes.

## Desktop frontend preview

- **The desktop app refuses to start with `--no-sandbox`.** The app enables Chromium's sandbox for every child process; the switch contradicts that and crashed the main process with an access violation when the first child process started. The app now exits with an explanation instead. See [electron#54838](https://github.com/electron/electron/issues/54838).
- **The desktop model runtime is not connected yet.** The app currently uses isolated preview sessions and platform data. Model/tool, MCP, extension and remote-operation actions have local request records; they do not run those operations.
- **UI components are not paired with live runtime plugin packages yet.** B/C/D/E share the workbench component API, but their service calls and Circle runtime entries are not installed by that API. The [integration audit](workbench/integration-audit.md) identifies the existing core interfaces and the remaining acceptance gates.
- **Workspace grants expire with the host process.** Reopen a selected folder after restarting the app to refresh its native read handles. Conversations and pinned input remain in the app's own data folder.
- **The desktop development package is not a signed public release.** macOS native behavior is checked locally and in its native workflow; other-platform packaging has separate CI jobs. Do not treat a build as full native behavior validation on every operating system.

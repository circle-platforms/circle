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
- **`auto` and `accept edits` turn themselves off** on `/new`, `/fork`, `/clone`, `/import` and restart; the session falls back to the `default_mode` saved in the settings, or asks again (`manual`) without one. `read-only` stays with the conversation.
- **`projects/` in the data folder is mostly not cleaned up.** It keeps the messages that summaries replaced, very long tool results, pasted pictures and screenshots, for every project; only command and job output is removed, a day after its run ended. Delete old folders by hand.
- **Circle 0.5.0 cannot import the JSONL exports of this version.** This version imports 0.5.0's.

## Safety

These are gaps to know about before you trust Circle with a repository or a machine you do not fully control. The complete list is in [Security](security.md#what-is-not-protected).

- **`/yolo` also skips the questions Circle always asks**, such as `rm -rf` and force-push.
- **An `allowed_commands` pattern skips them too** for the commands it matches: `git *` covers a force-push, and patterns match text, not what a command reaches. Keep them narrow.
- **Custom commands can run shell snippets without asking**, and a trusted folder's commands, skills and instruction files apply at once. Read a repository's `.circle/`, `.opencode/`, `.pi/`, `.claude/` and `.agents/` folders before you trust it.
- **The credential-file check reads names, not contents.** File tools and commands refuse the listed names, but `ls` and `glob` show them, and a command that reaches a file without naming it (a script, a variable, a copy under another name) is not refused.
- **A secret can be written to any path the model names.** Check the file on the card before you enter the value.

## Subagents and tools

- **Tool calls other than `task` in one reply run one after another.** 0.5.0 asked every approval first and then ran all the calls of a reply at the same time; here only `task` calls next to each other run together. To run subagents side by side, the model can start them with `background: true`.
- **The diff on an `edit_file` card assumes its text appears once.** When the text to replace appears more than once, the card shows the change at the first place, but the tool refuses such an edit unless it replaces every one. The model is told and usually tries again with more context.
- **`grep` searches for literal text, not regular expressions.** Its description says so and points the model to `rg` in the shell for a regular expression, which asks for approval like any command.
- **Native web search depends on the endpoint and model.** A provider preset is not a guarantee that your model, subscription or gateway supports its search API. Custom compatible endpoints that silently ignore search tools fall back to DuckDuckGo because Circle cannot confirm execution. If native search is unavailable and both DuckDuckGo endpoints are blocked or serving challenges, `websearch` fails; `webfetch` can still read a known URL when that site is reachable. Hosted search fees are not included in known token prices and remain unpriced.

## Images and screenshots

- **Pasting a picture and `screenshot` have not been tried on a real Windows or Linux machine.** They use PowerShell on Windows, and `wl-paste`, `xclip` and the screenshot programs on Linux; the tests run them against stand-ins. On macOS, an isolated native test uses the actual system clipboard for both the terminal and development/packaged desktop, checks the image bytes sent to the model and restored from history, and restores the original clipboard. The terminal's drawing is stubbed in that test.
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

## Desktop application

- **Linux file dialogs stay in English without GTK's Chinese catalog.** Cancel, Open, Recent and Home are GTK's strings, not Circle's. `locale-gen zh_CN.UTF-8` and launching with `LANG=zh_CN.UTF-8` `LC_ALL=zh_CN.UTF-8` do not translate them when `gtk30.mo` is missing. Ubuntu installs that catalog with `language-pack-gnome-zh-hans`; it lives at `/usr/share/locale-langpack/zh_CN/LC_MESSAGES/gtk30.mo` (Debian often uses `/usr/share/locale/zh_CN/LC_MESSAGES/gtk30.mo`). Electron initializes GTK before this script runs, so a language change inside the app cannot relabel a dialog the C locale already drew. When the interface starts in Chinese and `LANGUAGE` is unset, Circle sets `LANGUAGE=zh_CN`, which gettext honors once the catalog is installed. This check has no `gtk30.mo`, so a live Chinese dialog was not verified.
- **It is not signed by Apple or Microsoft.** macOS asks once whether to open it (System Settings → Privacy & Security → Open Anyway), and Windows SmartScreen may stop it the first time (More info → Run anyway). See [Installation](installation.md#the-desktop-application).
- **On Linux, its sandbox helper needs root once.** Where unprivileged user namespaces are restricted, as on Ubuntu 24.04 and later, Chromium's sandbox needs `chrome-sandbox` owned by root with the setuid bit; until then the application stops at start. [Installation](installation.md#the-desktop-application) has the two commands.
- **On Linux it does not update itself.** Check now links to the release page: an update cannot keep `chrome-sandbox` owned by root, so the folder is replaced by hand. Releases up to 1.2.0 do not update themselves on any system; install the newer release over them once by hand.
- **Updating the Windows installation asks for administrator permission**, as installing did, because the `.msi` installs for all users. Declining it leaves the old version, and settings say that the update was not installed.
- **A waiting steering message cannot be sent at once yet.** The terminal's `enter` on an empty box has no counterpart in the application: the message is read before the model's next step. Waiting messages can be removed one by one, or all put back in the box.
- **It refuses to start with `--no-sandbox`.** The application enables Chromium's sandbox for every child process; the switch contradicts that and crashed the main process with an access violation when the first child process started. It now exits with an explanation instead. See [electron#54838](https://github.com/electron/electron/issues/54838).
- **Workspace grants expire with the application.** The files panel lists the folder of the open session again by itself when the folder is trusted; another folder has to be opened again with open folder after a restart. Conversations and pinned input stay in the application's own data folder.
- **Only the default workspace can move; the rest of the data folder stays on the system drive.** Session history, the `projects/` offload folders and updates keep growing in the data folder wherever the default workspace lives.
- **Changing the default workspace moves no files.** The old folder — including the built-in `runtime-home/workspace` and its `projects/<name>-<id>` offload folder — keeps its sessions and stays until you delete it by hand. While the built-in `workspace` folder holds files the settings page names it; another folder chosen before is not named.
- **A default workspace that is missing at start falls back to the built-in scratch folder**, as when its drive is unplugged, and the app keeps resuming that scratch folder after the drive returns until the folder is chosen again.
- **The changes panel shows only what file tools changed while the application ran.** Each file is compared with its version before the session's first change in this run. After a restart the panel starts empty, and a file a command changed is not listed.
- **Windows shows no count of waiting requests on the taskbar,** only a busy bar. macOS shows the count on the Dock icon, and Linux where the desktop supports it. Windows notifications need the Start menu shortcut the installer makes.
- **Some words come from Circle's core in English** in the Chinese interface: slash command descriptions, the shortcut list, error messages and reasons for an approval other than the common ones. The terminal interface is English only.
- **A failed turn's line lasts only while the application runs.** It is shown in the conversation, but not saved with it.
- **Browser snapshots cannot read a frame from another site.** Same-origin frames and open shadow roots are included; a cross-origin frame's contents are not. Open the frame's address as the main page when you need Circle to read it.
- **Coordinate browser clicks require a current screenshot.** Scrolling, changing tabs, resizing, navigation and page changes invalidate it. A target inside a cross-origin frame is refused; open the frame's address as a main page or take over the browser. Coordinate clicks are not included in recorded scripts.
- **A certificate allowed once is forgotten when Circle exits**, and one trusted for good can be reviewed only in `browser-certificates.json` in the application's data folder (delete an entry there to forget it). Circle cannot tell when Chrome would refuse to let anyone proceed, as for sites that require HTTPS: Electron does not say.
- **Circle cannot answer a page's own file picker** (`showOpenFilePicker` and the like) when one of its clicks opens one; the result says so, and you can choose in the browser. Dropping files onto a page is not possible either.
- **In the terminal's browser a click of yours while Circle acts races Circle's**: there is no layer over the page and no take over. Stop the turn first, or let the model hand you the browser. In the desktop panel the layer takes clicks, not keys: keys you press in the page during an action still reach it.
- **Downloads cannot be paused or cancelled from Circle.** In the terminal's browser a download still arriving when Circle exits is lost.
- **A system download integration can take an attachment before the terminal browser downloads it.** With IDM Advanced Integration on Windows, a first navigation from a blank tab to a local HTTP attachment was replaced by an HTTP 204 response. Chrome reported an aborted navigation and started no download; Circle reports the response it received. Opening the site's ordinary page before navigating to the attachment worked in that local check. Circle does not change the system integration or browser security policy.
- **The terminal has a browser only with Chrome, Edge or Chromium installed**, and only in the full-screen interface. `CIRCLE_BROWSER` names one Circle does not find. The terminal's browser shows permission requests and the choice of a client certificate to you in its window; the model does not see them.
- **In the terminal's browser an HTTP sign-in that Circle's action meets has no prompt for you** until the model answers it or hands you the browser; the tab keeps loading meanwhile. A sign-in that a page's own requests meet (an image, a script, a fetch) is left to the browser, and the model does not see it.
- **A replayed script finds a field without a name by its order** among the unnamed fields of its role (`{ "role": "textbox", "name": "", "nth": 2 }`), as a form without labels gives no other name; a change to the form can move it onto another field. Text next to the field is not used to find it.
- **The desktop browser draws nothing while the screen is not shown**, as over a remote desktop nobody is watching: a page's animations do not end, so an overlay that fades out stays and Circle's clicks find elements covered or time out. Keep Circle's window shown while it uses the browser.
- **Secrets are stored unencrypted** in `secrets.json`, protected by your user's file permissions only.
- **A secret's value is hidden wherever it shows in output, even inside other text.** A password that is a common word, such as `admin`, turns that word into `%NAME%` in tool results, also inside a longer word, which can confuse the model and tells it where the password appears. It stays as written where it is also a plain variable's value, or where it stands as a word in what you or the model wrote in the conversation, since the model knows it already.
- **A model that writes its tool call as text in its thinking ends the turn** with "model returned an empty response", as step-3.7-flash sometimes does. Circle does not resend it on its own; send "continue" to have it try again.
- **In the desktop browser, a page's prompt() is answered through a request to its own address.** A page whose content security policy forbids requests to its own origin, or a page without an origin (`about:blank`, `data:`), gets no answer: prompt() returns nothing there. Circle takes over Electron's private dialog event to show dialogs in the tab; a test checks alert, confirm and prompt on every Electron upgrade.
- **The platform pages show what hub returns, not more.** Knowledge, work, execution and methods are paired with the hub extension and read the server's own records; they hold nothing of their own. They have been checked against hub's local development stack only, not a deployed server. The [integration audit](workbench/integration-audit.md) records what remains.

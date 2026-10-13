---
nav_order: 10
---

# Run Circle safely

Circle can read your files, run commands as you, and change anything you can change. It asks before it does most of that, and it refuses a few things outright. **This is a safety net, not a sandbox.** A command you approve runs with your full user rights and network access.

Read this page before you point Circle at anything you cannot restore, and before you use it on files or repositories you do not trust.

## What Circle asks about

| Action | What happens |
|---|---|
| Run a command (`execute`) | Asks. Some commands are always refused, and some always ask (see below). |
| Write, edit or patch a file | Asks. |
| Delete a file (`delete`) or a patch that deletes | Always asks. |
| Read, list, search, `webfetch`, `websearch`, `lsp` | Does not ask. |
| Take a screenshot (`screenshot`) | Asks: the picture can show any window on the screen. "Allow for this session" covers every screenshot. |
| Read the desktop browser (`browser_snapshot`, `browser_screenshot`) | Does not ask. The screenshot covers only this conversation's browser viewport. |
| Operate the browser | Asks, site by site. "Allow on *site* for this session" covers all browser actions on that site in this conversation. Passing a certificate warning and giving a page files ask every time, also in `auto` mode; a certificate you trusted on that host for good is passed without asking. Keeping a file the model's action downloaded asks once per site, except in `auto` mode. |
| Tools from MCP servers | Asks. |
| Tools from extensions | Asks, unless the extension marks the tool read-only or turns approval off. |
| Custom-command shell snippets | Do not ask. |
| A command you type with `!` | Does not ask: you ran it. The refusals below still apply. |

Circle does not ask before it reads. It can read any file you can, including files outside the workspace, except the [credential files](#credential-files) by name. Do not put secrets in a place you would not want the model to see.

## Approvals

When Circle needs approval it shows a card:

1. **Allow once** runs this call.
2. **Allow ... for this session** runs it, and stops asking for calls of the same kind in this conversation. The label says what "the same kind" means (below).
3. **Allow "python3 -m pytest …" for this session**, for a command that is one program with its arguments: runs it, and stops asking for commands that start with the same words.
4. **Reject and explain** does not run it. Your explanation goes to the model with the rejection.

`esc` rejects. Rejecting never ends the turn; the model is told and carries on.

For a file change the card shows what would change: the lines added and removed against the file as it is now, with line numbers, or the change as the model sent it when the file cannot be read. Long changes are cut after 40 lines.

What "the same kind" means for option 2:

| Call | Option 2 covers |
|---|---|
| A command | That exact command text. A `cd` into the workspace in front (`cd /your/project && make test`) is left out, since commands run there anyway. |
| A command that only reads | Every command that only reads (see below), such as `ls`, `cat`, `rg`, `git status` and `git diff`. |
| A file change inside the workspace | All changes of that tool inside the workspace. Allowing `write_file` does not allow `edit_file`. |
| A file change outside the workspace | Not offered. It asks every time. |
| Deleting anything, and the risky commands below | Not offered. It asks every time. |
| An MCP or extension tool | Every call to that tool. |
| A browser operation | All browser actions on that site (scheme, host and port): navigate, click, type, select, press, dialog and tabs. A navigation counts for the site it goes to; other actions for the site the shown tab is on. Not passing a certificate warning, giving a page files or keeping a download. A rule saved before sites were told apart covers every site. |

Option 3 keeps the program and what names the work: the script or module of an interpreter (`python3 todo.py`, `python3 -m pytest`, `node build.js`), the subcommand of tools such as `git`, `npm`, `pnpm`, `yarn`, `cargo`, `go`, `uv`, `pip`, `make`, `docker` and `gh` (`git add`, `npm run build`), or the program alone (`pytest`). It is offered only for a command with no pipe, `&&`, `;`, redirection, `$`, backtick or wrapper such as `env` or `timeout`, and it covers only such commands. It is not offered for an interpreter with no script (`python3 -c ...`), for the commands that only read (option 2 covers them), or for programs where it would allow nearly anything: `curl`, `wget`, `ssh`, `scp`, `rsync`, `chmod`, `chown`, `kill`, `mv`, `cp`, `ln`, `open`, `eval`, `source`, `sed`, `awk`, `tee` and the elevation commands. The commands that always ask still ask.

The rules are kept per conversation in `approvals/` in the data folder. Exact commands are stored as hashes, not text; a rule from option 3 keeps its words. `/approvals` lists the rules and the last five decisions, and lets you revoke one. A revoked rule asks again from the next call. A rule revoked by a Python release (which keeps it with a mark) stays revoked here.

### Command patterns in settings

`allowed_commands` in [settings](settings.md) is a list of wildcard patterns (`*` and `?`) for commands that run without a card, in every conversation, in every mode — including print, line and RPC runs and the calls the model makes in the background. `/approvals add <pattern>` writes one to your settings and it takes effect at once; `/approvals remove <pattern|number>` takes it back; `/approvals` lists what is in force. `/reload` re-reads them.

A command is covered only when **every segment** of it matches a pattern (the segments a shell would run: split at `;`, `&&`, `||`, `|`, `&`, parentheses and newlines). Quotes come off and runs of whitespace become one space before matching, a leading `cd` into the workspace is left out as on the card, and a command that does not parse is never covered. On Windows the match ignores case. `npm *` covers `npm run build` but not plain `npm`; `npm ci && rm -rf dist` needs both `npm *` and `rm -rf *`.

A pattern you wrote is treated as your explicit intent: it also covers the commands that always ask (`rm -rf`, a force push, `find -delete`), which a card answer never does. Refused commands stay refused — a pattern cannot allow `sudo` or a command that names a credential file. Patterns match the command text only, not what it reaches: `git *` covers `git push --force`, and `bash *` covers anything inside `bash -c`, so keep them narrow. Subagents share the list with the main conversation.

A trusted folder's `.circle/settings.json` may add patterns to yours (never remove one); they apply while Circle works in that folder. Trusting a folder is therefore also trusting the command patterns it ships — see [Workspace trust](#workspace-trust).

### How commands are sorted

Circle reads the command text; it does not run it first.

**Always refused.** No card, and `auto` mode does not change it:

- Any command that names a [credential file](#credential-files).
- `sudo`, `su`, `doas`, `pkexec`, and on Windows `runas` and `gsudo`.

**Always asks, without "for this session".**

- Removing and destroying: `rm`, `rmdir`, `unlink`, `shred`, `srm`, `trash`, `trash-put`, `dd`, `truncate`, `wipefs`, `fdisk`, `parted`, `mkfs*`, `find ... -delete`, and `find ... -exec` with a command that deletes. On Windows also `del`, `erase`, `rd`, `Remove-Item`, `format`, `diskpart`, `cipher`, `sdelete`, `Clear-Disk` and `Format-Volume`.
- Git operations that lose work: `reset --hard`, `reset --merge`, `clean -f`, `push --force` and its variants, `push --delete`, `push --mirror`, a push of `+ref` or `:ref`, `branch -D`, `stash drop`, `stash clear`, `checkout -f`, `checkout -- ...`, `checkout .`, `restore` without `--staged`, `rm`, `filter-branch`, `filter-repo`.
- `python -c` code that deletes (`shutil.rmtree`, `os.remove`, `os.unlink`, `os.rmdir`, `.unlink(`, `.rmdir(`).
- A PowerShell `-EncodedCommand`.
- Anything Circle cannot parse, such as unbalanced quotes, or nesting deeper than three levels.

Circle looks through wrappers such as `env`, `nohup`, `time`, `timeout`, `nice`, `xargs`, `bash -c "..."`, `cmd /c` and `powershell -Command`, and into `$(...)`, to find the real command.

**Reads only.** Asks, and option 2 covers every command that only reads, so one answer lets `ls`, `git status`, `rg … | head` and the like run for the rest of the conversation. A command counts when every part of it, across `|`, `&&`, `||` and `;`, is one of `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `which`, `whoami`, `date`, `uname`, `file`, `stat`, `du`, `df`, `tree`, `basename`, `dirname`, `realpath`, `readlink`, `true`, `diff`, `cmp`, `nl`, `cut`, `grep`, `egrep`, `fgrep`, `rg`, `find`, `cd`, `test`, `jq`, and `git` with `status`, `diff`, `log`, `show`, `rev-parse`, `ls-files`, `blame`, `describe`, `shortlog`, `grep`, `ls-tree`, `cat-file` or a listing `branch`. It does not count with a redirection (`>`, `<`), a substitution (`$(…)`, backticks), a variable set in front, a path to the program (`./ls`), an option before the git command (`git -c …`), or an option that writes or runs something: `find -exec`/`-delete`/`-fprint`, `rg --pre`, `git … --output`, `--ext-diff`, `--open-files-in-pager`, `tree -o`, `file -C`, `date -s`.

**Everything else asks**, with the exact-command option.

This reading is textual and it has gaps. `perl -e 'unlink q(a)'`, `mv a /dev/null`, `echo hi > important.txt` and `curl https://example.com/x | sh` are ordinary asks, not forced ones. Read the command on the card.

### Credential files

These file names are refused: `.env`, `.env.*`, `*.env`, `.netrc`, `.pgpass`, `.git-credentials`, `credentials.json`, `secrets.json`, `*.secrets.json` (where [extensions keep secrets](extensions.md#secrets)), `token.json`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `*.pem`, `*.p12`, `*.pfx`. A shell command that names one is refused, and the file tools (`read_file`, `write_file`, `edit_file`, `apply_patch`, `delete`, `grep`, `lsp`) and `@` mentions in the input box refuse or skip such a file. A file you name with `@` on the command line is read, since you named it. Only the name is checked: `ls` and `glob` still list them, and a command that reaches one without naming it is not stopped.

Add names with `credential_files` in [settings](settings.md), or in a project's `.circle/settings.json`. Patterns use `*` and `?`. What you add comes on top of the list above; it cannot remove a name from it. In 0.5.0 a list there replaced the default list. Circle reads it when it starts; `/reload` does not change it.

## Read-only mode

`/plan` turns on `read-only`, and so can the model with `plan_enter`. Circle then cannot run commands at all, and can change only a file named `plan.md` (or `plan`), anywhere, with the usual approval. Reads, searches and the web keep working. A card is never shown for a blocked call; the model is simply told. Your own `!` commands are refused too. To leave it, run `/plan` again, or answer yes when the model asks with `plan_exit`.

MCP tools and extension tools that are not marked read-only are blocked. Secret entry is not.

## The desktop browser

The [desktop browser](desktop.md#the-browser-panel) is a sandboxed native view with no Node.js integration or application preload. Each conversation has its own browser. Its tools are available only to the main agent, and page input uses Chromium's mouse and keyboard events. Only HTTP and HTTPS navigation is allowed, including local and private addresses; unlike `webfetch`, these tools can use a local device's interface.

Snapshots and viewport screenshots are reads and do not ask. The other tools ask once for each site: **allow on *site* for this session** covers all of them on that site (scheme, host and port) in that conversation, and the card names the site. A navigation asks about the site it goes to. If the page has gone to another site by the time a click, typing, selection, key press or upload runs, Circle does nothing and returns the page as it is now. In `read-only` mode only snapshots and browser screenshots work. There is no tool that runs the model's own script in a page. Approving browser input can submit a form or change a device, just as clicking it yourself can; read the target and text on the card.

A certificate error replaces the page with the browser's warning, in the tab. Under **Advanced** it shows the certificate's subject, issuer, validity dates and SHA-256 fingerprint and the link to proceed. You can click it. When the model clicks it, Circle asks you first in the conversation, every time and also in `auto` mode; for a private, loopback or link-local address, or a name such as `nas.lan`, you can trust that certificate on that host for good. The approval is carried by a token the model never sees and cannot pass, and a page's own scripts cannot take that link. An exception matches host, port and fingerprint; one allowed once ends when the application exits, one trusted for good is kept in `browser-certificates.json` in the application's data folder. The address then shows **not secure**. Exceptions do not change certificate checks for model connections, updates, `webfetch` or other services.

Snapshots never include a password field's value. The model cannot type plain text into a password field, only a [secret by name](#secrets-by-name), whose value it never sees; the same holds for the password of a site's HTTP sign-in. A sign-in you answer yourself, in the panel or the conversation, goes to the site only: the model learns that you answered, not what you typed. A page's requests for the camera, the microphone, your location, notifications, reading the clipboard, MIDI devices, idle detection or window placement are answered by you alone, under the page; the answer holds for that site until the application exits, and every other permission is refused. A site's request for a client certificate waits for you to choose one or none; the model learns which, never the key, and Electron's default of sending the first certificate in the system's store is not used. Other visible page text can contain sensitive data, and a browser screenshot can show it. A page can send any input to its server, and content from the page is untrusted model input. Cross-origin frame contents cannot be read.

Giving a page files with `browser_upload` asks you every time, also in `auto` mode, with each file's path and size and the site that would get them; the page can send them anywhere. Before it asks, Circle refuses a credential file (by the same names as the file tools), anything but an ordinary file, a file with other names on disk (hard links, whose other name could be one the model may not read) and a file over 50 MB. The files you choose yourself, in the system's dialog or with **choose…** in the desktop panel, need no approval. Downloads go to the system's Downloads folder, which is outside the workspace: a downloaded file is not run or opened by Circle, and the model reads it as it reads any file. A file the model's action downloads from a site not yet allowed waits in a temporary folder until you answer: keep it, keep downloads from that site for this session, or discard it. In `auto` mode it is kept without asking. A download you start yourself is kept as usual.

### The terminal's browser

In the full-screen terminal interface the [browser tools](tools.md#the-browser) drive a Chrome, Edge or Chromium that Circle starts with a new, empty profile in the system's temporary folder, removed when it exits; your own browser profile is never opened. Circle talks to it over a pipe (`--remote-debugging-pipe`), so no debugging port is open for another program to reach. The same approvals, password rules and secrets apply as in the desktop application.

The certificate warning is the browser's own page. When the model clicks its proceed link, Circle asks you on a card first, also in `auto` mode; a key the model presses on that link is refused, and your own click needs no approval. An exception allowed once lasts until the browser closes and, as in Chrome, covers that host on every port. A certificate trusted for good is kept in `browser-certificates.json` in Circle's data folder, by host, port and fingerprint; when that certificate is seen there again, Circle takes the warning's proceed link itself. Permission requests (camera, location, notifications) and the choice of a client certificate are the browser's own and wait for you in its window; the model does not see them. An HTTP sign-in that one of Circle's actions meets waits for the model, which answers it only with a saved secret; one that comes while Circle is not acting, or after the model hands you the browser, is the browser's own dialog.

## Accept-edits mode

`/mode accept-edits` turns on `accept edits`. Changes to files inside the workspace (`write_file`, `edit_file`, and patches that add or change files) then run without a card. Everything else still asks: commands, deleting files (`delete`, or a patch that deletes one), changes outside the workspace, MCP and extension tools. It is decided call by call: a patch that touches one file outside the workspace asks. The model can also leave `read-only` into this mode, when you answer its `plan_exit` question with "implement plan, accept edits". Like `auto`, it applies to the current conversation only.

## Auto mode

`/yolo` (or `/auto`) turns on `auto`. In auto mode Circle stops asking, **including for the calls that always ask**: `rm -rf`, force pushes, `delete`, patches that delete files, and writes outside the workspace. Credential files and `sudo` are still refused. `/yolo off` turns it off.

Auto mode applies to the current conversation only and is not saved. `/new`, `/fork`, `/clone`, `/import` and restarting turn it off — unless you set `default_mode` to `auto` in [settings](settings.md), which starts every new session (and every print, line and RPC run) in auto. That is a standing decision to never be asked; only set it where you would run `--yolo` every time anyway. Use auto for work you could throw away.

## Print mode and line mode

`circle -p`, `--line` and `--mode` cannot show a card. A call that would ask is not run, and the model is told why, unless you pass `--yolo`. With `--yolo` such calls run, except the ones that always ask, which are still not run. A command that matches an [`allowed_commands`](#command-patterns-in-settings) pattern runs whether or not you pass `--yolo`, including one that always asks. Refused commands stay refused. The same rule decides for [background subagents](background-jobs.md#background-subagents). See [CLI](cli.md#print-mode).

## The shell environment

Commands run with your user rights, in the workspace folder, with no input. Standard output and error are joined, in the order they were written. A command still running after 120 seconds goes on as a [background job](background-jobs.md); the model can instead give a timeout of up to 600 seconds, after which the command is ended. The model gets the first 80,000 bytes of output and the path of the rest. Each command runs in its own process group: when you press `esc`, or its own timeout passes, the command and every process it started are ended (`SIGTERM`, then `SIGKILL`). Processes a command leaves running become a background job; a background job runs until it ends, you or the model stop it, or Circle ends, which stops every job. On Windows a command runs in `cmd.exe` and is ended with `taskkill /T /F`; this has not been tried on a real Windows machine (see [Known issues](known-issues.md#install-and-release)).

Circle removes secrets from the command's environment: any variable whose name has a word such as `KEY`, `TOKEN`, `SECRET`, `PASS`, `PASSWORD`, `CREDENTIAL`, `COOKIE` or `PRIVATE` in it, or ends in `TOKEN`, `SECRET` or `APIKEY`. The API key Circle uses for the model is never in the environment: Circle reads it from `credentials.json` and hands it to the model client only. MCP servers Circle starts get the same filtered environment.

Nothing restricts the network, other processes, or which files a command can reach.

## The workspace boundary

Relative paths and paths that start with `/` inside the project are resolved under the workspace. Real system paths such as `/Users/...`, `/home/...`, `/etc/...`, `/tmp/...`, `C:\...` and `~/...` are taken as they are, so Circle can read outside the workspace without asking. Writes outside the workspace ask every time, with no "for this session" option. A file tool's path with `..` in it is refused.

Circle writes nothing of its own into your workspace. Older messages after a summary, very long tool output and the output of commands and background jobs are kept in the data folder under `projects/`; the model reads them at `/conversation_history/`, `/large_tool_results/` and `/background_jobs/`, and cannot change the jobs' output.

## Workspace trust

Circle works only in folders you have trusted: the first time, it asks, and it does not start until you say yes. Trusting a folder lets Circle use what the folder supplies: its instruction files, skills, custom commands, `.circle/settings.json` and extensions, which run their own code. It is an exact match: trusting `/a` does not trust `/a/b`. Trust does not limit what the model does in the folder.

Instruction files and `.agents/skills` in the folders above the workspace, up to the git root, are read too, without being trusted on their own. Do not trust a folder you have not read.

## Secrets

The model asks for a secret with the `question` tool, naming a variable such as `API_TOKEN` and the file to write it to. A card shows both. You type the value with `ctrl+s`, masked. Circle writes it straight to that file as `NAME=value`, keeping the file's other lines, at mode `0600`, and tells the model only that it was collected. The value never enters the conversation, and a value that could not be collected is never asked for in chat. The model chooses the file: read the card before you enter a value. See [Secrets](usage.md#secrets).

### Secrets by name

A secret is a [variable](settings.md#keys) whose value the model never sees, such as a password or a token: it knows only the name. Save one in the desktop settings under **variables** → **secrets** or with `/secrets NAME` in the terminal, or answer the model's secret question with no `target_file`, which keeps the value as a secret named by its `key`. Secrets are in `secrets.json` in Circle's data folder, readable only by you (mode `0600`; on Windows, where file modes do not apply, the folder's own permissions protect it, as for `credentials.json`). Values are stored as they are, not encrypted. The file's name is on the [credential list](#credential-files), so the model's tools cannot read it by name.

The model's instructions list the names. It writes `%NAME%` in any tool's arguments, as Windows writes an environment variable: a command, a browser field, an MCP or extension tool's input. Circle puts the values in once, before it decides anything, and runs exactly what it checked: whether a call asks, is refused, or is covered by a rule goes by the values, so a variable that turns `ls %TAIL%` into a command that deletes asks as that command does. The approval card shows plain variables' values and secrets as `%NAME%`, and a rule you allow keeps the same; a command with a secret in it is asked about each time. Wherever a secret's value appears in a tool's output or error, or in a background job's notice, the model reads `%NAME%` instead, also for a value the secret had before you changed it. Tools whose text goes to a model or into the conversation (a subagent's `task`, `question`, `write_todos`, the plan tools, `skill`, `compact_conversation`) keep a secret as `%NAME%`; a subagent puts the value in when one of its own tools runs. Plain variables are put in the same way, but their values are not hidden; a secret whose value is also a plain variable's is not hidden either, since the model knows that value. A name that is neither stays as written, so `%PATH%` in a Windows command still means the system's own variable unless you keep one named `PATH`. The tools that write files (`write_file`, `edit_file`, `apply_patch`) keep `%NAME%` as text, so a reference never puts a secret on disk; to write one into an env file, the model asks with a `target_file`.

A secret can go wherever a tool sends it: a command can pass it to any program or host. In `manual` mode read the command on the card; in `auto` mode such a command runs without asking. Output a command writes to its own files or a job's output file on disk is not changed.

## The update check and downloads

Circle makes two kinds of request of its own that have nothing to do with your model. Once a day, in the full-screen interface, a `HEAD` request to `github.com/<repo>/releases/latest` learns whether a newer release exists (see [The reminder](cli.md#the-reminder)); turn it off with `update_check` or `CIRCLE_NO_UPDATE_CHECK`. And once a day it fetches the model list of [models.dev](https://models.dev) for context windows and prices; turn it off with `CIRCLE_NO_MODELS_REFRESH`. Nothing about your files, prompts or settings is sent.

`circle update` and the installers download a program and run it. They check its sha256 against a file published in the same release. That catches a damaged or truncated download; it does not help if the release itself were replaced, because the checksum comes from the same place. They use HTTPS and verify certificates. If your network breaks that, give them the certificate to trust (`CURL_CA_BUNDLE` for the installer, `SSL_CERT_FILE` for Circle); do not switch verification off.

## What is not protected

- There is no operating-system sandbox. A command can read any file you can, use the network, and start background processes. A process that leaves its process group (`setsid`, a daemon) is not a [background job](background-jobs.md#what-is-not-tracked): Circle does not stop it.
- A background subagent works while you do other things. Its approvals appear as cards of their own, named after its job; "allow for this session" there applies to its whole conversation.
- **`!` snippets in custom commands run without asking.** See [Custom commands](custom-commands.md).
- An MCP server or an extension runs with your rights, outside the approval of any single call: what it does when it starts, or in a tool you allowed for the session, is up to it.
- `webfetch` refuses local and private addresses only. Any URL can carry data out in its query string.
- The credential-file check reads names, not contents (see [Credential files](#credential-files)).
- Text files that Circle loads as instructions (`AGENTS.md`, `CLAUDE.md`, skills) can tell the model what to do. Read them in a repository you do not trust.

## Report a vulnerability

See [SECURITY.md](https://github.com/qingshanfeihu/circle/blob/main/SECURITY.md).

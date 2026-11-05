Run a shell command in the workspace.

Prefer specialized file tools over shell for reading, writing, editing, searching, or finding files (`read_file`, `write_file`, `edit_file`, `glob`, `grep`, `ls`).

Use this tool for terminal work such as git, package managers, builds, tests, and process control.

For a command in the user's own terminal tab or "my terminal", use `terminal_sessions` to find that tab, then `terminal_send` and `terminal_wait`. This tool runs in Circle's own shell and does not type into theirs.

Use background: true for a server, watcher or long-running command: the call returns a job id and output path at once, and a notice arrives when it ends — do not poll or sleep. Ctrl+B and the default 120-second timeout also move a foreground command to the background without restarting it. An explicit foreground timeout ends it instead; a background timeout is its maximum lifetime.

Give a background command a `description`: what it does, in a few words ("Run the gateway test suite"). It names the job in the background jobs list; without one, the command itself does.

# Git and GitHub

- Only commit, amend, push, or create PRs when the user explicitly asks.
- Before committing, inspect `git status`, `git diff`, and recent log; stage only intended files and never commit secrets.
- Do not update git config, skip hooks, use interactive `-i`, force-push, or create empty commits unless explicitly requested.
- Prefer `gh` for GitHub tasks when available.

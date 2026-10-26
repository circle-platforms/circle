---
nav_order: 12.5
---

# Hooks

A hook is a shell command Circle runs at a fixed point in a turn. The model decides what to try; a hook decides whether that attempt is allowed. A deny from a hook stands in every approval mode, including accept-edits and auto.

Hooks are code execution. Circle shows which ones are active, runs a project's hooks only after you trust the folder and approve that version of the file, and appends one JSON line per run to `hooks.log` in the data folder.

## Where hooks live

| File                                                            | When it runs                                                                                                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hooks.json` in the data folder (`~/.circle`, or `CIRCLE_HOME`) | Every session. These are your own hooks.                                                                                                                      |
| `<workspace>/.circle/hooks.json`                                | After the folder is trusted, and after you approve this version of the file.                                                                                  |
| `hooks.json` next to a skill's `SKILL.md`                       | With that skill. A project skill's hooks also wait for the folder trust and for approval of that file. See [A skill can ship hooks](#a-skill-can-ship-hooks). |

Hooks are not a key in `settings.json`. A project settings file has a closed list of keys, and a bad `settings.json` stops Circle; a hooks file is separate so a mistake there does not.

Trusting the folder is not enough for a project hooks file. See [Approving a project hooks file](#approving-a-project-hooks-file).

Circle reads the files when a session starts, on `/new`, when you switch or import a session, and on `/reload`. `/reload` applies the new files to later events in the same session. It does not run `session_start` again, and it resets each `before_stop` hook's block count.

A file whose `version` is present and is not `1` is skipped. A file can hold at most 100 hooks; further entries are left out and named in a notice. An entry without a command, an unknown event, or JSON that cannot be read is reported the same way, and the valid hooks in that file still load.

## Approving a project hooks file

A project hooks file (`.circle/hooks.json`, or a `hooks.json` next to a project skill) runs only in a version you approved. `hook-trust.json` in the data folder keeps, for each approved file by its real path, the SHA-256 digest of its bytes and the name, event and command of each hook in that version. A file that has never been approved, or whose bytes changed since, does not load. Circle reads the file once for the digest, for what it shows you and for the hooks that load, so what runs is the version you were shown. A file with no hooks in it has nothing to approve. Your own `hooks.json` in the data folder, and a `hooks.json` next to a skill that is not the project's, are never asked about.

**In the terminal**, when a turn starts and such a file waits, a card asks first: the file, then each hook in that version with its event and command, marked new, changed or removed against the version you approved last; unchanged hooks share one line. Like every card, it waits while you are typing. The choices are `skip` and `approve these hooks`, and the focus starts on `skip`: enter, `1` and esc leave the hooks off, and letters do nothing. `2`, or down and enter, approves. The hooks then run from that turn on, `session_start` included, and the transcript says `project hooks approved`. After a skip they stay off for the session: the transcript says `project hooks need approval · <file>`, `/hooks` lists the file as needing approval, and the card comes back after `/reload` or in a new session. `circle --approve-hooks` approves the waiting files when the session opens, without the card.

**In the desktop**, the same card appears in the conversation when a turn starts, with `approve these hooks` and `skip`. After a skip the transcript says the hooks need approval, and a new conversation asks again. Settings names each file that waits.

**In print, line and rpc mode** nobody can answer a card. A file that waits does not run. Standard error says so once for the run, naming the file and how to approve it: with `circle` in a terminal in that folder, or with `--approve-hooks`, which approves the waiting files as they are now and lists each hook it approved. The transcript keeps the same notice, so a later session shows it.

Releases up to 1.9.1 ran a trusted folder's hooks without this approval and kept no `hook-trust.json`. After an upgrade, such a file waits as a new one: the terminal and the desktop ask on the next turn, and print mode says so on standard error until it is approved once, for example with `--approve-hooks`.

## The file

```json
{
  "version": 1,
  "hooks": {
    "before_tool": [
      {
        "name": "no secrets",
        "command": "node .circle/hooks/no-secrets.mjs",
        "timeout_ms": 30000,
        "tools": "write_file|edit_file",
        "paths": ["**/*.env", "**/*secret*"]
      }
    ],
    "after_tool": [],
    "before_stop": [],
    "session_start": [],
    "permission_request": []
  }
}
```

| Field        | Meaning                                                                                                                                                                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`    | Required. The shell command, at most 4,000 characters. Circle starts it with `shell: true` in the workspace, so `/bin/sh` runs it on macOS and Linux and `cmd.exe` on Windows (write `node script.mjs` for a hook that runs on every system), with the [filtered environment](security.md#the-shell-environment) used for other commands.                                 |
| `name`       | Optional, at most 80 characters. The transcript and the desktop settings use it. Without one, the command is the name.                                                                                                                                                                                                                                                    |
| `timeout_ms` | Optional. Default 30 seconds. Clamped between 100 milliseconds and 10 minutes. On timeout the process group is stopped (on Windows, `taskkill /T /F`, the same stop Circle uses for other commands).                                                                                                                                                                      |
| `loop_limit` | Optional, only for `before_stop`. Default 5, clamped from 1 to 20. After this many blocks the hook is not run again for that session, until `/reload` or a new session.                                                                                                                                                                                                   |
| `tools`      | Optional. A tool name, a list, or several names separated by `\|` or a comma. `*` or omitting it matches every tool. `matcher` is the same field. There is no regular expression. `session_start` and `before_stop` ignore it, so a copied matcher does not disable them.                                                                                                 |
| `paths`      | Optional globs. Empty matches every call. A call that names no path does not match a hook that has globs. A call names the paths in its `file_path`, `path`, `file` and `paths` arguments, the files of a patch, and those an MCP tool's [file parameters](mcp.md#files-a-tool-takes) take. See [Path globs](#path-globs). Ignored for `session_start` and `before_stop`. |

## Events

Every matching hook for an event runs. Nothing stops the list early. For the three gating events the strictest decision wins: deny, then ask, then allow, then no opinion.

| Event                | When                                                                   | What a decision does                                                                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before_tool`        | After the approval policy's hard refusal, and before the approval card | `deny` blocks the call. `ask` forces the card, including in auto. `allow` skips an ordinary card only.                                                                                                                                                  |
| `permission_request` | When a card would be shown, or a hook asked                            | Same as `before_tool`. It does not run when nothing would ask and no hook asked, and it does not run after a `before_tool` allow that already skipped an ordinary card. An allow here cannot take back an ask, and cannot skip a call that always asks. |
| `after_tool`         | After a tool returns text                                              | Decisions are ignored. Exit 0 appends standard output to the tool result the model reads. A non-zero exit, a timeout, or a failure to start does not undo the tool: Circle logs it and shows a notice.                                                  |
| `before_stop`        | When the model ends a turn with no tool call and no steering message   | `deny`, exit 2, or `ask` blocks the stop and sends the reason back. The turn continues, and the step still counts toward the turn's step limit.                                                                                                         |
| `session_start`      | Once, before the first model request of the session                    | Decisions are ignored. Output is added to the system prompt for that session and shown as a notice.                                                                                                                                                     |

A subagent runs `before_tool`, `after_tool` and `permission_request`. It does not run `session_start` or `before_stop`.

### What a hook cannot override

These are decided before any hook runs:

- Read-only mode, including plan mode. A hook cannot allow a write, and the hook does not run.
- A hard refusal from the approval policy: `sudo`, `su`, `doas`, `pkexec`, `runas`, `gsudo`, and a command that names a credential file. The hook does not run.

A call that always asks, such as deleting files, still runs the hook. `allow` does not skip that card. A hook can only make the rule stricter: `deny` and `ask` still apply, including in auto, and a later `allow` cannot undo an earlier `ask`.

A file tool still refuses a credential file by name when the tool runs. That check is inside the tool, so a `before_tool` hook does run, and an allow does not make the write succeed.

`allowed_commands` still skips the card, unless a hook asked. A hook deny is already a block by then.

## What the command receives

Circle writes one JSON object to standard input:

```json
{
  "event": "before_tool",
  "session_id": "…",
  "cwd": "/path/to/workspace",
  "hook": "no secrets",
  "source": "project",
  "source_label": "project",
  "tool_name": "write_file",
  "tool_input": { "file_path": "src/app.ts", "content": "…" },
  "paths": ["/path/to/workspace/src/app.ts"],
  "tool_output": "…",
  "tool_status": "success",
  "permission_reason": "…",
  "stop_attempt": 1
}
```

`tool_input` is the arguments after variables are filled in, with one exception: a saved secret's value is written back as `%NAME%` everywhere it appears in the arguments, the paths, the tool output, and the hook's environment. The hook runs as you, but it does not receive the secret. `paths` are canonical (symlinks resolved through `canonicalPath`). `tool_output` and `tool_status` are set for `after_tool`. `permission_reason` is set for `permission_request`. `stop_attempt` is set for `before_stop` and starts at 1.

The command's standard output and standard error are kept up to 100,000 characters. A command that exits before it reads the input is still judged by its exit code. Closing the pipe does not stop Circle.

## How Circle reads the result

| Exit                                                                                 | Gating event (`before_tool`, `permission_request`, `before_stop`)                                                          | `after_tool` and `session_start`                                                                                |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 0 and a JSON object `{"decision":"allow"\|"deny"\|"ask","reason":"…","context":"…"}` | That decision. On `before_stop`, `ask` blocks like `deny`. Empty output, or a JSON object with no decision, is no opinion. | The decision is ignored. `context`, or `additional_context`, is fed back. Plain text is fed back too.           |
| 0 and output that is not a JSON object                                               | Deny. The reason is `hook output is not JSON`.                                                                             | The text is context. The turn is not interrupted.                                                               |
| 2                                                                                    | Deny. The reason is the JSON `reason`, otherwise standard error, otherwise standard output.                                | A notice only. The tool is not undone and the session is not blocked.                                           |
| Any other exit, a timeout, or a failure to start                                     | Deny.                                                                                                                      | A notice only. The tool is not undone and the session is not blocked. The error text is not given to the model. |

Claude Code blocks a command hook only on exit 2. Any other exit is a non-blocking error, and exit 0 with plain text is not a decision. Circle is stricter on `before_tool`, `permission_request` and `before_stop`: any non-zero exit, a timeout, a failure to start, or output that is not a JSON object is a deny. Exit 2 is a deny here too, so a hook written to that convention still blocks in Circle: exit 0 with a JSON decision, or exit 2 to refuse. A hook that prints plain text and exits 0 on a gating event is a deny in Circle, where Claude Code would let the call through. On `after_tool` and `session_start` a non-zero exit does not interrupt the turn. Circle writes it to `hooks.log` and shows a notice. The transcript keeps the hook's error text. The model is told only `hook failed · name`, so it does not quote that text back. In the desktop's 简体中文 that notice is Chinese (`钩子失败`, and Circle's own words such as a timeout); the hook's own text stays as it wrote it. Exit 0 still feeds the output back, which is how a formatter reports what it did.

A deny the model sees starts with `Hook denied this call:`. An ask that you then reject includes `A hook asked:`. After you approve a call a hook asked about, the tool result starts with `Hook asked before this call:`. An allow starts the result with `Hook allowed this call.`. `after_tool` context is appended as `Hook output (name):`.

## Path globs

`*` stays inside one path segment. `**` crosses segments. `?` is one character.

A relative glob matches the path relative to the workspace. An absolute glob matches the canonical absolute path; the part before the first `*` or `?` is canonicalized, so a symlink and its target match the same glob. A pattern of `link/**/*.ts` does not match a file whose real path is `real/App.ts`.

Matching is case-sensitive, except on Windows, where `\` and `/` are the same and case does not matter.

## What you see

The terminal keeps hook lines in the transcript as notices, in English whatever the system language; the hook's own reason, the command and the tool name stay as written. The welcome inventory names `.circle/hooks.json` when that file is present. The approval card adds `hook · <reason>` when a hook asked.

The desktop transcript uses the same notices. In 简体中文 the labels are fully Chinese, and the reason stays as the hook wrote it. Settings lists each hook's name, whether it came from you, the project or a skill (and which skill), the event, the tools when they are not `*`, and the command. A skill hook that this session has not loaded is listed as waiting and does not run. An untrusted project file is named there and is not run, and so is a project file that waits for approval.

The active-hook notice lists names, events and sources. It does not list commands, unless a hook has no name, in which case the name is the command.

## The log

Each run appends one JSON line to `hooks.log` in the data folder. The fields are the time, session, event, source, name, command, tool name, exit code, decision, whether it timed out or failed, duration and the reason (500 characters). The tool's input is not logged, and a secret's value is replaced with `%NAME%` if it would otherwise appear in the line. A failure to write the log does not stop the hook. The file is not rotated.

## A skill can ship hooks

A skill folder may contain `hooks.json` beside `SKILL.md`. Installing the skill does not run those commands. They run only after this session loads that skill, with `/skill` or with the model's `skill` tool, and they stop applying when you switch, import or start another session. A project skill's hooks still require the folder to be trusted, and approval of that file's bytes, the same way as `.circle/hooks.json`. Until then they are not loaded. Settings names the skill and, until it is loaded, that the hook is waiting.

A `session_start` hook in the skill runs with the session when the skill was loaded first, and runs once when the skill is loaded later. The other events apply to tool calls after that moment.

This is optional. A skill with no `hooks.json` is unchanged, and Circle still does not run other scripts bundled in the skill.

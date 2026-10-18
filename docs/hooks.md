---
nav_order: 12.5
---

# Hooks

A hook is a shell command Circle runs at a fixed point in a turn. The model decides what to try; a hook decides whether that attempt is allowed. A deny from a hook stands in every approval mode, including accept-edits and auto.

Hooks are code execution. Circle shows which ones are active, runs a project's hooks only after you trust the folder, and appends one JSON line per run to `hooks.log` in the data folder.

## Where hooks live

| File | When it runs |
|---|---|
| `hooks.json` in the data folder (`~/.circle`, or `CIRCLE_HOME`) | Every session |
| `<workspace>/.circle/hooks.json` | Only after the folder is trusted |
| `hooks.json` next to a skill's `SKILL.md` | With that skill. A project skill's hooks run only in a trusted folder. See [A skill can ship hooks](#a-skill-can-ship-hooks). |

Hooks are not a key in `settings.json`. A project settings file has a closed list of keys, and a bad `settings.json` stops Circle; a hooks file is separate so a mistake there does not.

Circle reads the files when a session starts, on `/new`, when you switch or import a session, and on `/reload`. `/reload` applies the new files to later events in the same session. It does not run `session_start` again, and it resets each `before_stop` hook's block count.

A file whose `version` is present and is not `1` is skipped. A file can hold at most 100 hooks; further entries are left out and named in a notice. An entry without a command, an unknown event, or JSON that cannot be read is reported the same way, and the valid hooks in that file still load.

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

| Field | Meaning |
|---|---|
| `command` | Required. The shell command, at most 4,000 characters. Circle starts it with `shell: true` in the workspace, with the [filtered environment](security.md#the-shell-environment) used for other commands. |
| `name` | Optional, at most 80 characters. The transcript and the desktop settings use it. Without one, the command is the name. |
| `timeout_ms` | Optional. Default 30 seconds. Clamped between 100 milliseconds and 10 minutes. On timeout the process group is stopped (on Windows, `taskkill /T /F`, the same stop Circle uses for other commands). |
| `loop_limit` | Optional, only for `before_stop`. Default 5, clamped from 1 to 20. After this many blocks the hook is not run again for that session, until `/reload` or a new session. |
| `tools` | Optional. A tool name, a list, or several names separated by `\|` or a comma. `*` or omitting it matches every tool. `matcher` is the same field. There is no regular expression. `session_start` and `before_stop` ignore it, so a copied matcher does not disable them. |
| `paths` | Optional globs. Empty matches every call. A call that names no path does not match a hook that has globs. See [Path globs](#path-globs). Ignored for `session_start` and `before_stop`. |

## Events

Every matching hook for an event runs. Nothing stops the list early. For the three gating events the strictest decision wins: deny, then ask, then allow, then no opinion.

| Event | When | What a decision does |
|---|---|---|
| `before_tool` | After the approval policy's hard refusal, and before the approval card | `deny` blocks the call. `ask` forces the card, including in auto. `allow` skips the card, including a call that always asks. |
| `permission_request` | When a card would be shown, or a hook asked | Same as `before_tool`. It does not run when nothing would ask and no hook asked, and it does not run after a `before_tool` allow. |
| `after_tool` | After a tool returns text | Decisions are ignored. Standard output is appended to the tool result the model reads. A non-zero exit does not undo the tool. |
| `before_stop` | When the model ends a turn with no tool call and no steering message | `deny`, exit 2, or `ask` blocks the stop and sends the reason back. The turn continues, and the step still counts toward the turn's step limit. |
| `session_start` | Once, before the first model request of the session | Decisions are ignored. Output is added to the system prompt for that session and shown as a notice. |

A subagent runs `before_tool`, `after_tool` and `permission_request`. It does not run `session_start` or `before_stop`.

### What a hook cannot override

These are decided before any hook runs:

- Read-only mode, including plan mode. A hook cannot allow a write.
- A hard refusal from the approval policy: `sudo`, `su`, `doas`, `pkexec`, `runas`, `gsudo`, and a command that names a credential file.

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

`tool_input` is the arguments after variables are filled in, so a secret's value is in it. The hook runs as you. `paths` are canonical (symlinks resolved through `canonicalPath`). `tool_output` and `tool_status` are set for `after_tool`. `permission_reason` is set for `permission_request`. `stop_attempt` is set for `before_stop` and starts at 1.

The command's standard output and standard error are kept up to 100,000 characters. A command that exits before it reads the input is still judged by its exit code. Closing the pipe does not stop Circle.

## How Circle reads the result

| Exit | Gating event (`before_tool`, `permission_request`, `before_stop`) | `after_tool` and `session_start` |
|---|---|---|
| 0 and JSON `{"decision":"allow"\|"deny"\|"ask","reason":"…","context":"…"}` | That decision. On `before_stop`, `ask` blocks like `deny`. | The decision is ignored. `context`, or `additional_context`, is fed back. |
| 0 and no decision | No opinion. Plain text is context. | The text is context. |
| 2 | Deny. The reason is the JSON `reason`, otherwise standard error, otherwise standard output. | The text is context. The tool is not undone and the session is not blocked. |
| Any other exit, a timeout, or a failure to start | Deny. | The error text is context. The tool is not undone. |

A deny the model sees starts with `Hook denied this call:`. An ask that you then reject includes `A hook asked:`. After you approve a call a hook asked about, the tool result starts with `Hook asked before this call:`. An allow starts the result with `Hook allowed this call.`. `after_tool` context is appended as `Hook output (name):`.

## Path globs

`*` stays inside one path segment. `**` crosses segments. `?` is one character.

A relative glob matches the path relative to the workspace. An absolute glob matches the canonical absolute path; the part before the first `*` or `?` is canonicalized, so a symlink and its target match the same glob. A pattern of `link/**/*.ts` does not match a file whose real path is `real/App.ts`.

Matching is case-sensitive, except on Windows, where `\` and `/` are the same and case does not matter.

## What you see

The terminal keeps hook lines in the transcript as notices. With a Chinese locale the labels are Chinese; the hook's own reason, the command and the tool name stay as written. The welcome inventory names `.circle/hooks.json` when that file is present. The approval card adds `hook · <reason>` when a hook asked.

The desktop transcript uses the same notices. In 简体中文 the labels are fully Chinese, and the reason stays as the hook wrote it. Settings lists each active hook's name, whether it came from you, the project or a skill, the event, the tools when they are not `*`, and the command. An untrusted project file is named there and is not run.

The active-hook notice lists names, events and sources. It does not list commands, unless a hook has no name, in which case the name is the command.

## The log

Each run appends one JSON line to `hooks.log` in the data folder. The fields are the time, session, event, source, name, command, tool name, exit code, decision, whether it timed out or failed, duration and the reason (500 characters). The tool's input is not logged. A failure to write the log does not stop the hook. The file is not rotated.

## A skill can ship hooks

A skill folder may contain `hooks.json` beside `SKILL.md`. Circle loads it whenever it can see that skill, not only after `/skill` loads the skill's text. User skills apply in every folder. Project skills apply once the folder is trusted.

This is optional. A skill with no `hooks.json` is unchanged, and Circle still does not run other scripts bundled in the skill.

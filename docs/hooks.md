---
nav_order: 12.5
---

# Hooks

A hook is a command Circle runs at a fixed point of a session: before a tool call, after one, when a message is sent, when a turn ends, and so on. The model decides what to try; a hook can decide whether that attempt goes ahead, add words for the model, or only watch.

The format and the behavior follow Claude Code's hooks, so a hook written for it runs here with Circle's tool names (`execute`, `write_file`, …) in its matchers. What Circle does differently is said where it comes up, and listed under [Not here yet](#not-here-yet).

Hooks are code execution. Circle shows which ones are active, runs a project's hooks only in a trusted folder, and appends one JSON line per run to `hooks.log` in the data folder.

## Where hooks live

| Where | Scope |
| --- | --- |
| `hooks` in `settings.json` in the data folder (`~/.circle`, or `CIRCLE_HOME`) | Every session. Your own hooks. |
| `hooks` in `<workspace>/.circle/settings.json` | This project, shared with the repository. Runs once the folder is trusted. |
| `hooks` in `<workspace>/.circle/settings.local.json` | This project, for you only. Runs once the folder is trusted. Only `hooks` and `disableAllHooks` are read from this file. |
| `hooks/hooks.json` in an installed pack | Every session while the pack is installed, like an enabled plugin. Its `hooks` key holds the hooks; `description` is optional. |
| `hooks:` in a skill's `SKILL.md` frontmatter | The rest of the session once the skill is loaded, with `/skill` or the `skill` tool. A project's skill waits for the folder to be trusted. |
| `hooks:` in a [subagent definition](agents.md#its-own-hooks)'s frontmatter | That subagent's own calls and its stop, while it runs. A project's definition waits for the folder to be trusted. |

Hooks from every place run together. A folder that is not trusted runs no hook of the project's own, and the transcript says `project hooks need a trusted folder`; yours, your skills' and your installed packs' still run. Circle asks to trust a folder before a session starts there, so in practice every session is in a trusted folder.

`"disableAllHooks": true` turns every hook off. The project's settings come after yours, and its local file after them, so a project that sets `false` turns them back on. A project that is not trusted cannot turn yours off.

Circle reads the hooks when a session starts, on `/new`, when you switch or import a session, and on `/reload`.

An installed pack's files are checked against what was installed before its hooks first run, both those in `hooks/hooks.json` and those in its `SKILL.md` frontmatter. A pack whose files do not match runs none of its hooks, and the transcript says why; a hook of it with `onFailure: "block"` blocks, since the check failed it. A pack lists `hooks/hooks.json` in its `pack.json` like its other files.

## The format

Each event holds matcher groups. A group's `matcher` says which occurrences of the event it is for, and its `hooks` are the handlers that run then:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "write_file|edit_file",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CIRCLE_PROJECT_DIR}/.circle/hooks/no-secrets.mjs"],
            "if": "write_file(**/*.env)",
            "timeout": 30,
            "onFailure": "block"
          }
        ]
      }
    ]
  }
}
```

| Field | Meaning |
| --- | --- |
| `type` | `command`. Other types are reported and do not load; see [Not here yet](#not-here-yet). |
| `command` | Without `args`, a shell command. With `args`, the program, started without a shell. |
| `args` | The program's arguments, each passed as it is written. Use this form for a hook that names a path: no quoting is needed. It runs the same on every system for a real program such as `node`; on Windows an `npx` or `npm` is a `.cmd` file that only a shell runs, so call `node` with the script's path instead, or use the shell form. |
| `shell` | `bash` or `powershell`. On macOS and Linux a shell command runs with `sh -c`. On Windows it runs in Git Bash, or in PowerShell when Git Bash is not installed or `shell` is `powershell`. `CIRCLE_GIT_BASH_PATH` names Git Bash's `bash.exe` when it is somewhere else. In PowerShell the hook's exit code is that of the last program it ran. Without Git Bash, a `PreToolUse` or `PermissionRequest` hook with no `shell` set counts only exit 0 and 2 as its answer: anything else blocks the call, unless the hook says `"onFailure": "continue"`. |
| `timeout` | Seconds. 600 by default; 30 for `UserPromptSubmit`. `SessionEnd` hooks share 1.5 seconds, raised to the longest `timeout` among them, at most 60 (`CIRCLE_SESSIONEND_HOOKS_TIMEOUT_MS` sets it). |
| `if` | One rule the call must match: see [Matching](#matching). |
| `onFailure` | `block` makes a hook that fails stop what it is about, as an exit 2 would. Without it a failure lets the action go ahead. See [When a hook fails](#when-a-hook-fails). |
| `async` | `true` runs the hook in the background: it decides nothing, and what it says reaches the model with its next request. |
| `once` | In a skill's frontmatter only: the hook is gone after its first run that did not fail. |
| `statusMessage` | Accepted; Circle shows the hook's name instead. |

Circle's own fields beside those:

| Field | Meaning |
| --- | --- |
| `name` | What the transcript, `/hooks` and the desktop settings call the hook. Without it, the command is the name. |
| `screenshot` | `true` on a `PostToolUse` hook gives it a PNG of the page the conversation's browser shows. See [A screenshot for the hook](#a-screenshot-for-the-hook). |
| `command_windows`, `command_darwin`, `command_linux` | The command on that system, in place of `command`. |
| `legacy`, `loopLimit` | Set by the move from the format before this one (see [Moving from the format before](#moving-from-the-format-before)): the hook keeps the input fields, shell and meanings it was written for. Remove them when the script is rewritten. |

A file with a mistake loses that entry only: the transcript names the file and the problem, and the other entries still load. An event Circle has no occasion for (`Setup`, `FileChanged`, …) is reported the same way.

### Variables

`${CIRCLE_PROJECT_DIR}` is the workspace. A pack's or a skill's hook also has `${CIRCLE_SKILL_DIR}`, its folder, and a pack's has `${CIRCLE_SKILL_DATA}`, a folder of its own that its updates keep. In `args` and an exec-form `command` they are put in as text. A shell command reads them from the environment: write `"${CIRCLE_PROJECT_DIR}"` with the quotes. In PowerShell Circle writes them as `${env:NAME}`.

## Matching

`matcher` is one of:

- `*`, empty, or no matcher: every occurrence.
- Only letters, digits, `_`, `-`, spaces, commas and `|`: exact names, such as `write_file|edit_file` or `write_file, edit_file`.
- Anything else: a regular expression, tested anywhere in the value, such as `^read_` or `mcp_.*`. A pack's subagent type has a colon (`kit:reviewer`), so it is a regular expression: anchor it with `^` and `$`.

What the matcher is tested against depends on the event:

| Event | The matcher is tested against |
| --- | --- |
| `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure` | The tool's name |
| `SessionStart` | `startup`, `resume`, `clear` or `compact` |
| `SessionEnd` | `clear`, `resume` or `other` |
| `SubagentStart`, `SubagentStop` | The subagent's type: `general-purpose`, `explore`, `plan`, a name of yours, or `<pack>:<name>` |
| `PreCompact`, `PostCompact` | `manual` or `auto` |
| `Notification` | `permission_prompt` or `idle_prompt` |
| `UserPromptSubmit`, `Stop` | Nothing: every group runs |

`if` holds one rule, a tool's name with what its call must match in parentheses. It is read on the four tool events only; a hook with `if` on another event never runs.

- `execute(git *)` runs for a command any part of which matches: `npm test && git push`, `FOO=1 git status`, `if …; then git push; fi`, `time git push` or `/usr/bin/git push`. A command whose part hands a command to another program (`bash -c`, `eval`, `xargs`, `find -exec`, `ssh`, …), or has `$(…)` or backticks, always runs the hook, since what it runs cannot be told.
- A tool that names paths (`write_file(src/**)`) matches when a path it names matches the glob. `*` stays in one folder, `**` crosses folders, `?` is one character; a relative glob is from the workspace, and an absolute one is matched against the real path, symlinks resolved. Case does not matter on Windows. An MCP tool's file parameters count as its paths.
- A tool with neither runs the hook whatever the pattern.

The same handler in more than one settings file runs once for an occurrence. A pack's or a skill's copy runs on its own.

## Events

| Event | When | What a hook can do |
| --- | --- | --- |
| `PreToolUse` | Before a call runs, after read-only mode and the hard refusals | Allow, deny or ask; rewrite the call; add words for the model |
| `PermissionRequest` | When Circle would show an approval card | Answer the card: allow or deny |
| `PostToolUse` | After a call returns | Add words beside the result; put another text in its place |
| `PostToolUseFailure` | After the tool itself failed | Add words beside the error |
| `UserPromptSubmit` | When you send a message, before the model reads it: the message a turn starts with, a queued one, and one that steers a turn | Keep it from the model; add words after it; name the session |
| `Stop` | When the model ends a turn without a tool call | Send it back to work |
| `SubagentStart` | When `task` starts a subagent, before its first request | Add words at the start of its conversation |
| `SubagentStop` | When a subagent has answered | Send it back to work |
| `SessionStart` | Before a session's first request (`startup`, `resume`, `clear`), and after a compaction (`compact`) | Add words at the start of the conversation; name the session |
| `SessionEnd` | On `/new`, when you switch sessions, and when Circle exits | Nothing: for cleanup |
| `PreCompact` | Before a compaction | Stop it; add instructions for the summary |
| `PostCompact` | After a compaction | Nothing: it gets the summary |
| `Notification` | When an approval card has waited about 6 seconds, or a turn ended about a minute ago with no message since | Nothing: for side effects |

A subagent runs the tool events of its own calls, at every depth: a subagent's own subagents too. `SessionStart`, `UserPromptSubmit` and `Stop` are the conversation's; `SubagentStart` and `SubagentStop` are the conversation's hooks about a subagent. A subagent definition's own hooks run beside them for that subagent alone, and its `Stop` hooks run as `SubagentStop` ([Subagents](agents.md#its-own-hooks)).

## What a hook receives

Circle writes one JSON object to standard input:

```json
{
  "session_id": "…",
  "cwd": "/path/to/workspace",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "write_file",
  "tool_input": { "file_path": "src/app.ts", "content": "…" },
  "tool_use_id": "…",
  "paths": ["/path/to/workspace/src/app.ts"]
}
```

- `session_id` is the conversation's session. In a subagent, at any depth, `agent_id` is the subagent's own session and `agent_type` its type.
- `permission_mode` is `default` (manual, and a print, line or rpc run without `--yolo`), `acceptEdits`, `plan` (read-only) or `bypassPermissions` (auto). A subagent whose definition sets [`permissionMode: dontAsk`](agents.md#permission-modes) is `dontAsk`, and one in a mode of its own is told that mode.
- Circle keeps sessions in a database, so there is no `transcript_path`. `Stop` and `SubagentStop` give the last answer as `last_assistant_message`.
- `paths` is Circle's own: the paths the call names, canonical.

The fields of each event:

| Event | Fields |
| --- | --- |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id`, `paths` |
| `PermissionRequest` | `tool_name`, `tool_input`, `paths` |
| `PostToolUse` | Those of `PreToolUse`, `tool_response` (the text the model would read) and `duration_ms` |
| `PostToolUseFailure` | Those of `PreToolUse`, `error`, `is_interrupt` and `duration_ms` |
| `UserPromptSubmit` | `prompt`, the message as you wrote it |
| `Stop` | `stop_hook_active` (true once a Stop hook has sent this turn back to work, whatever the model did since), `last_assistant_message`, `background_tasks` (the jobs still running) and `session_crons` (always empty) |
| `SubagentStart` | `agent_id`, `agent_type`, and Circle's `description`, the task the model wrote |
| `SubagentStop` | `agent_id`, `agent_type`, `stop_hook_active`, `last_assistant_message` |
| `SessionStart` | `source`, `model` |
| `SessionEnd` | `reason` |
| `PreCompact` | `trigger`, `custom_instructions` (what you gave `/compact`, else `null`) |
| `PostCompact` | `trigger`, `compact_summary` |
| `Notification` | `notification_type`, `title`, `message` |

A hook of a skill or a pack also gets `skill_dir`, and a `PostToolUse` hook with `screenshot` gets `files` (see below).

A saved secret's value is written as `%NAME%` everywhere in what a hook gets: the input, the paths, the result and its environment. The hook runs as you, but it does not receive the secret.

The environment is the [filtered environment](security.md#the-shell-environment) other commands get, with `CIRCLE_PROJECT_DIR`, `CIRCLE_SESSION_ID`, in a subagent `CIRCLE_AGENT_ID`, and for a pack's or a skill's hook `CIRCLE_SKILL_DIR` (and a pack's `CIRCLE_SKILL_DATA`). The commands, scripts and MCP requests of a call carry the same session and agent.

## What a hook answers

### Exit codes

| Exit | Standard output | What happens |
| --- | --- | --- |
| 0 | A JSON object | Its fields apply. |
| 0 | Plain text, or nothing | No decision. `UserPromptSubmit`, `SessionStart` and `PreCompact` give the text to the model (`PreCompact`: to the summary); other events keep it in `hooks.log` only. |
| 0 | Starts with `{` and is not a JSON object, or a field has the wrong type | A failure. |
| 2 | Anything | Blocks what the event is about (see the table below). Standard error is the reason. JSON fields are still read, but cannot undo the block. |
| Another | A JSON object | Its fields apply, unless the hook has `onFailure: "block"`: then it is a failure. |
| Another | Anything else | A failure. The notice gives the first line of standard error. |

| Event | Exit 2 |
| --- | --- |
| `PreToolUse` | Denies the call |
| `UserPromptSubmit` | Keeps the message from the model |
| `Stop`, `SubagentStop` | Sends it back to work, with standard error as the reason |
| `PreCompact` | Stops the compaction |
| `PostToolUse`, `PostToolUseFailure` | Gives standard error to the model beside the result |
| `PermissionRequest` | Nothing: answer with the `decision` object |
| Others | Shows standard error to you |

### JSON fields

Every event reads these, except where the event's own section says otherwise:

| Field | Meaning |
| --- | --- |
| `continue` | `false` ends the turn once the calls under way are done. `stopReason` is shown to you. |
| `systemMessage` | Shown to you, not to the model. `Notification`, `PreCompact`, `PostCompact` and `SessionEnd` do not show it. |
| `suppressOutput`, `terminalSequence` | Accepted; they do nothing here. |

An event's own fields go in `hookSpecificOutput`, with `hookEventName` set to the event; a mismatched name makes the answer a failure. `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SubagentStop` and `PreCompact` also read a top-level `"decision": "block"` with a `reason`.

| Event | Fields |
| --- | --- |
| `PreToolUse` | `permissionDecision` (`allow`, `deny`, `ask`, `defer`), `permissionDecisionReason`, `updatedInput`, `additionalContext` |
| `PermissionRequest` | `decision`: `{ "behavior": "allow" }` or `{ "behavior": "deny", "message": "…", "interrupt": true }`; `updatedInput` inside it |
| `PostToolUse` | `decision: "block"` with `reason` (beside the result), `additionalContext`, `updatedToolOutput` (text the model reads in place of the result) |
| `PostToolUseFailure` | `additionalContext` |
| `UserPromptSubmit` | `decision: "block"` with `reason` (shown to you), `additionalContext`, `sessionTitle`, `suppressOriginalPrompt` |
| `Stop`, `SubagentStop` | `decision: "block"` with `reason`, and `additionalContext`: either sends it back to work |
| `SessionStart`, `SubagentStart` | `additionalContext`; `SessionStart` also `sessionTitle` |
| `PreCompact` | `decision: "block"` with `reason` |

`additionalContext` reaches the model as a reminder: next to the tool result for the tool events, after your message for `UserPromptSubmit`, at the start of the conversation for `SessionStart` and `SubagentStart`. A reminder tag inside it is escaped so it cannot close one. Each text a hook gives is cut at 10,000 characters.

### Several hooks

The matching hooks of an event run at the same time, and Circle waits for all of them. For `PreToolUse` a deny comes before an ask, which comes before an allow; `defer` is ignored with a notice, since Circle cannot hold a call for later. For `PermissionRequest` a deny comes before an allow. Every hook's `additionalContext` reaches the model. Any block blocks.

### When a hook fails

A hook fails when it cannot start, times out, exits with another code than 0 or 2 without a JSON answer, or answers with output that cannot be read. A hook whose own process has ended while something it started still holds its output open is read for 10 more seconds; then its output is not trusted, which blocks a `PreToolUse` or `PermissionRequest` call. A hook that starts something in the background prints its answer first and sends that program's output elsewhere (`> log 2>&1 &`). By default the action goes ahead, and the transcript says `hook failed · name · why`; the model is told only that the hook failed. With `"onFailure": "block"` the failure blocks as an exit 2 would, and on `PermissionRequest` it denies. It has no effect on `Stop`, `SubagentStop` and background hooks.

A hook that guards something should set `onFailure: "block"`, and exit 2 or answer with JSON to refuse.

### The format before this one

A hook that still answers with Circle's earlier fields keeps its effect, and the transcript says once that its format is old. For `PreToolUse` and `PermissionRequest` a top-level `decision` of `allow`, `deny` or `ask` (and `approve` and `block`) with `reason` decides as `permissionDecision` would. `updated_input` is `updatedInput`, `context` and `additional_context` are `additionalContext`, and `user_message` is `systemMessage`.

## Decisions about a call

- **A deny** stands in every approval mode, including accept-edits and auto. The tool result starts with `Hook denied this call:` and the reason.
- **An ask** shows the approval card even in auto. The card says `hook · reason`, and after you approve, the result starts with `Hook asked before this call:`.
- **An allow** skips an ordinary card. It does not skip a call that always asks: one that names a secret the call did not carry, a first write to one of your terminal tabs, or one the policy always asks about.
- **`PermissionRequest`** runs only when a card would show. Its allow answers the card, its deny refuses the call (`interrupt` also ends the turn). An allow with `updatedInput` would run the call in another form: Circle does not apply that, so the card asks you. In a print, line or rpc run nobody can answer a card; a call a hook does not allow does not run.

These are decided before any hook runs, and no hook can undo them:

- Read-only mode, including plan mode. A hook cannot allow a write.
- A hard refusal from the approval policy: `sudo`, `su`, `doas`, `pkexec`, `runas`, `gsudo`, and a command that names a credential file.

A file tool still refuses a credential file by name when it runs, after the hooks. `allowed_commands` still skips the card unless a hook asked.

## Rewrite a call

A `PreToolUse` hook can let a call through in another form. `updatedInput` is the whole input the call runs with instead, not a patch:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "updatedInput": { "command": "example-tool --name value" }
  }
}
```

- The rewrite goes through everything the model's call went through: the tool's schema, variables, read-only mode and the hard refusals; then the rules, `allowed_commands`, the card, an answer you keep for the session, the tool and `PostToolUse`. A rewrite that cannot run stops the call, and the result says `Hook changed this call's input (name), and it cannot run: …`.
- Hooks that give the same rewrite give one. Hooks that each give a different one leave no form the call can run in: it does not run, and the result names them.
- The hook sees each saved secret as `%NAME%` and writes it back that way. A part no hook changed keeps what the model sent. A rewrite that names a secret the call did not carry always shows the card.
- The card shows the call that will run. Nothing on screen marks it as rewritten; the model's own call stays as it sent it, and the tool result starts with what changed, for the model only:

  ```text
  Hook changed this call's input (canon):
  command = "example-tool --name value"
  ```

## A screenshot for the hook

A hook can keep evidence of a page without the model seeing a picture of it. With `"screenshot": true` on a `PostToolUse` hook, Circle captures the page the conversation's browser shows once the tool has returned, before the hook runs, and names the PNG in the hook's `files`: `[{ "kind": "screenshot", "path": "…", "mime_type": "image/png", "sha256": "…", "size": 12345 }]`.

- It is the page as shown, without Circle's marks. The model gets nothing from it.
- It is taken once per call, however many hooks ask, and only when a hook that asks matches the call.
- No browser is started for it. With no page open, a page waiting on a dialog, a page that failed to load, or a browser in your hands, there is no file and no `files`.
- The file is in a folder of its own under the system's temporary folder, readable only by you, and Circle removes it once the call's hooks have finished. A hook that hands it to something that keeps running copies it first.

## Skills and packs

A skill's hooks are written in its `SKILL.md` frontmatter, in the same format, as YAML:

```yaml
---
name: secure-operations
description: Operations with security checks
hooks:
  PreToolUse:
    - matcher: execute
      hooks:
        - type: command
          command: node
          args: ["${CIRCLE_SKILL_DIR}/scripts/check.mjs"]
---
```

They start when this session loads the skill and run for the rest of it. `once: true` removes one after its first run that did not fail. Installing a skill runs nothing.

An installed pack's `hooks/hooks.json` runs in every session while the pack is installed. A pack's hooks that belong to its skill go in the frontmatter instead.

## What you see

The terminal keeps hook notices in English; the hook's own words, the command and the tool name stay as written. A routine allow notice is hidden unless `show_hook_allow` is `true`. Denials, questions, failures, blocks and output notices stay visible.

`/hooks` lists each hook with its name, where it came from, its event and matcher, its `if`, and its command, and a skill hook not loaded yet as waiting. It names a file with a problem. The desktop shows the same in Settings → hooks.

A message a hook blocked is not sent to the model. The conversation shows `hook blocked prompt · reason` with your message under it (`Original prompt:`), unless the hook set `suppressOriginalPrompt`. The model is told only that a message was held back.

## The log

Each run appends one JSON line to `hooks.log` in the data folder: the time, session, event, source, name, command, tool, exit code, decision, whether it timed out or failed, its duration, the reason (500 characters), and plain output that no event reads (2,000 characters). The tool's input is not logged, and a secret's value is written as `%NAME%`. A failure to write the log does not stop the hook. The file is not rotated.

## Moving from the format before

Circle used to read hooks from separate `hooks.json` files with its own event names. When a session starts, Circle moves them, once:

- `hooks.json` in the data folder goes into your `settings.json`.
- A trusted project's `.circle/hooks.json` goes into its `.circle/settings.json`.
- A `hooks.json` beside a skill in Circle's own skill folders (`skills` in the data folder, and a project's `.circle/skills`) goes into its `SKILL.md` frontmatter. A project's skills move once the folder is trusted.

The old file is kept beside, renamed `hooks.json.migrated`, and the transcript says what moved. An installed pack is not changed, since its files are checked against what was installed: its old `hooks.json` is not read, and the transcript says it should move to `hooks/hooks.json` or its frontmatter.

What carries over:

- `before_tool` is `PreToolUse`, `after_tool` `PostToolUse`, `before_stop` `Stop`, `session_start` `SessionStart`, `permission_request` `PermissionRequest`, `user_prompt` `UserPromptSubmit`, `subagent_start` `SubagentStart`.
- `tools` becomes the matcher. Each of `paths` becomes an `if` per tool and glob; a hook whose globs applied to every tool now applies to Circle's file tools (`read_file`, `write_file`, `edit_file`, `apply_patch`, `ls`, `glob`, `grep`, `vision`), and an MCP tool needs an `if` of its own.
- `timeout_ms` becomes `timeout` in seconds; a hook without one gets the old default, 30.
- A `before_tool` or `permission_request` hook gets `onFailure: "block"`.
- `name`, `screenshot` and the per-system commands stay.
- Every moved hook is marked `"legacy": true`, which keeps what it was written for until you rewrite it:
  - its input also has the earlier fields (`event` with the earlier name, `hook`, `source`, `source_label`, `tool_output` and `tool_status` after a tool, `permission_reason`, `stop_attempt`);
  - on Windows its shell command runs in `cmd.exe`, as before, with `${CIRCLE_SKILL_DIR}` read as `%CIRCLE_SKILL_DIR%`;
  - on `PreToolUse`, `PermissionRequest` and `Stop`, plain text with exit 0, any failure, and on `PermissionRequest` exit 2, refuse as they did;
  - its plain text after a tool, at session start, for a message and to a subagent reaches the model as it did;
  - a `before_stop` hook blocks at most `loopLimit` times a session (its `loop_limit`, 5 by default).

What changes all the same:

- `session_start` output was in the system prompt; it now opens the conversation, and comes back after a compaction.
- A project's hooks no longer wait for you to approve each version of the file: trusting the folder is enough. `--approve-hooks` is still accepted and does nothing.
- A `hooks.json` beside a skill in another agent's folder (`.claude/skills`, `.agents/skills`, …) is not changed and not read: the transcript names it, and its hooks belong in that skill's frontmatter. One whose `SKILL.md` frontmatter is not YAML stays where it is too, and the transcript says so.

## Not here yet

- Hook types other than `command`: `http`, `mcp_tool`, `prompt` and `agent` are reported and do not load. So is `asyncRewake`.
- `Elicitation` and `ElicitationResult` hooks, which come with the next MCP changes.
- A `PermissionRequest` allow with `updatedInput` or `updatedPermissions`: the first leaves the card to you, the second is ignored.
- `transcript_path`, `prompt_id`, `effort` and `agent_transcript_path` in the input.
- Events Circle has no occasion for: `Setup`, `InstructionsLoaded`, `UserPromptExpansion`, `MessageDisplay`, `PermissionDenied`, `PostToolBatch`, the task, teammate, config, directory, file, worktree and model-switch events.

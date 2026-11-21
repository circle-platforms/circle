---
nav_order: 12.4
---

# Subagents

A subagent is a second Circle with its own context: `task` starts one, it works alone, and only its report comes back to your conversation. Three ship with Circle — `general-purpose`, and the read-only `explore` and `plan` — [extensions](extensions.md) register more, and **folders of markdown files define the rest**. This page is about those.

Each built-in has a prompt of its own, followed by the conversation's system prompt: `general-purpose` works from a short prompt for general tasks (do what the task asks, report in the format it asks for), `explore` from one for read-only searching, and `plan` from one for research before a plan (how the code works now, and what a change would touch). The built-in `explore` and `plan` get the read-only tools and run in read-only mode; a file that replaces one of them decides its own tools and mode, so give it `permissionMode: plan` if it should only read. A built-in whose prompt file is missing is an error that names the file; it never borrows another agent's prompt.

## A file per agent

One file is one agent: `<name>.md` in one of the folders below. The keys say what it is, and the text under them is the system prompt the agent works from.

```markdown
---
name: migration-checker
description: Checks a migration against the schema before it is committed.
tools: read_file, grep, execute
model: gpt-5.4
---

Read the migration and the schema it changes. Report what would fail, naming
the file and the line. Change nothing.
```

| Key | Needed | What it does |
|---|---|---|
| `name` | no: the file name is used | how `task` calls it: letters, digits, `_` and `-`, up to 64 |
| `description` | yes | the line the model reads to decide when to use the agent |
| `tools` | no | the exact tool names it may use, on one line or as a YAML list; without the key it gets everything a subagent may have. An entry ending in `*` takes every tool whose name starts with what comes before it. `mcp__<server>`, `mcp__<server>__*` and `mcp__*` take an MCP server's tools, found by the server's name, and `mcp__<server>__<tool>` one of them. What an entry says in parentheses is not read: `task(worker)` is `task`. An entry that names no tool, or a server this session does not have, keeps the file from being offered |
| `disallowedTools` | no | tools it never gets, in the same form and checked the same way: an entry that names no tool, such as another program's `Write`, keeps the file from being offered rather than withholding nothing. They are taken out first, and `tools` is read from what is left, so a tool in both is not offered. `execute(git push *)` takes `execute` away entirely: to refuse only some commands, write an [approval rule](security.md) |
| `model` | no | an id on the same endpoint; without it the agent uses the model of the conversation, or of the subagent that started it |
| `effort` | no | its thinking depth, one of `minimal`, `low`, `medium`, `high`, `xhigh` or `max`, sent with each of its requests; without it the agent follows the conversation's depth. `CIRCLE_REASONING_EFFORT` set for the run wins over it. `/agents <name>` shows the depth |
| `permissionMode` | no | how its calls are decided: `default` (or `manual`), `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` or `auto`. See [Permission modes](#permission-modes) |
| `maxTurns` | no | how many model requests it may make, a whole number from 1. When they are spent it stops with what it has written, and `task` returns that under `Partial result:`. With a fifth of them left (twenty at most; a limit under ten gets none) it is told once how many remain |
| `skills` | no | skills loaded into its conversation in full before its task, as if it had loaded them with `skill`, up to 32 names. One that is not installed is left out, and `/agents <name>` names it |
| `mcpServers` | no | MCP servers it gets the tools of, by the names they are configured under, beside what `tools` lists. See [MCP servers](#mcp-servers) |
| `hooks` | no | [hooks](hooks.md) that run only for this subagent, while it runs. See [Its own hooks](#its-own-hooks) |
| `sessionPrompt` | no | `false`: it keeps its own prompt and is not given the conversation's. Without the key a subagent's prompt is followed by everything the conversation is told: how to talk to you and work on code, the project's instructions, your memory, the skills, the servers' notes. That is right for a subagent that does the conversation's kind of work, and it is thousands of tokens with every request of one whose definition already says all it needs. With `false` it is told only how paths are read, where it runs and your variables |
| `background` | no | `true`: it runs as a [background job](background-jobs.md#background-subagents) whenever the conversation starts it, also when the call does not ask for one |
| `memory`, `isolation`, `color` | no | read, and not applied yet: `/agents` lists them under `Not supported yet:`. See [Known issues](known-issues.md#subagents-and-tools) |

A key with a value it does not take — a mode, a scope or a colour that is not one of its list, `maxTurns: 0`, `background: maybe` — means the file is not offered, and `/agents` says why. A key Circle does not know is ignored.

The frontmatter is the lines between a first line of `---` and the next line that starts with `---`, and it is read as YAML, with keys in any case: `Tools:` is `tools`. A frontmatter that is not YAML, such as a description with an unquoted `: ` in it, still loads when it sets only `name`, `description`, `model` and `effort`, read one line each. One that sets any other key is not offered, and `/agents` gives the YAML error, so a guard never goes missing quietly.

### Permission modes

While the conversation is in `manual` mode, `permissionMode` decides how the subagent's calls go:

| Value | Its calls |
|---|---|
| `default`, `manual` | as the conversation's: a write or a command asks you |
| `acceptEdits` | as in `accept-edits` mode: edits in the workspace and read-only commands run without asking |
| `plan` | read-only: it reads, and refuses what would change something |
| `dontAsk` | a call that would ask is refused instead, without a card; what a rule, a setting or a hook allows still runs |
| `bypassPermissions` | as the conversation's: a definition cannot put a subagent in `auto` mode |
| `auto` | as the conversation's: this is a mode in which a separate model decides each call, which Circle does not have |

A subagent without `permissionMode` works in the conversation's mode, not in the mode of the subagent that started it: one started by a `dontAsk` or an `acceptEdits` subagent works in its own `permissionMode`, or else in the conversation's. Read-only is the exception, below. A definition that must not hand work to one that asks or writes, such as a `dontAsk` one, leaves `task` out of its `tools` or puts it in `disallowedTools`.

A project's definition, one in a `<workspace>/…/agents` folder, cannot make Circle ask less: its `acceptEdits`, `bypassPermissions` or `auto` is not applied, the definition is offered without it, and `/agents` lists it under `Not applied:`. Its `default`, `plan` and `dontAsk` apply. This is the rule project approval rules follow too: a repository can tighten what Circle does, never loosen it.

When the conversation is in `accept-edits` or `auto` mode, every subagent works in that mode, whatever its key says. When the conversation is read-only (`/plan`), so is every subagent, and `dontAsk` still holds. The conversation's mode is read again for every call, so a change reaches subagents that are already running. Rules you keep for the conversation, and its deny rules, apply to its subagents too. Hooks hear the mode as `permission_mode`: `default`, `acceptEdits`, `plan`, `dontAsk` or `bypassPermissions`. Its own calls' hooks, and the `SubagentStart` and `SubagentStop` hooks about it, hear the subagent's own mode.

### MCP servers

`mcpServers` names servers that are already configured, as a YAML list or on one line:

```markdown
---
name: issue-triager
description: Sorts new issues.
tools: read_file, grep
mcpServers:
  - github
---
```

The subagent gets the tools of those servers on the same connection the conversation uses, beside its `tools` list; `disallowedTools` still takes them away. A name this session has no server for keeps the file from being offered, and `/agents` names it. A server defined inline in the file (a name with its `command` or `url` under it) is not supported yet: the file is not offered, and `/agents` says so.

### Its own hooks

`hooks` takes the same format as [hooks](hooks.md) in settings, written in YAML:

```markdown
---
name: db-reader
description: Runs read-only database queries.
tools: execute
hooks:
  PreToolUse:
    - matcher: execute
      hooks:
        - type: command
          command: ./scripts/validate-readonly-query.sh
---
```

They run for this subagent's own calls (`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`), beside the configured hooks, and its `Stop` hooks run as `SubagentStop` when it finishes, with no matcher. They do not run for the conversation, for other subagents, or for subagents this one starts, and they are gone when it ends. Other events have nothing to fire at inside a subagent. `once` is a skill's alone and is ignored here.

A project's definition, one in a `<workspace>/…/agents` folder, runs its hooks only once the folder is [trusted](security.md); until then the subagent runs without them, and `/agents <name>` says `not run: this folder is not trusted`. `disableAllHooks` turns them off as well. An entry the file cannot use, such as another `type` than `command` or a matcher that is no regular expression, keeps the file from being offered, so a guard never goes missing quietly.

## Where the files live

Read in this order, lowest first, so a later folder replaces an earlier one of the same name:

| Folder | Who it is for |
|---|---|
| `~/.agents/agents` | shared with other agents |
| `~/.claude/agents` | the same files, kept for Claude Code |
| `~/.circle/agents` | yours, in every folder |
| `<workspace>/.agents/agents` | this project, shared |
| `<workspace>/.claude/agents` | this project, from Claude Code |
| `<workspace>/.circle/agents` | this project, Circle's own |

An **extension** that registers the name wins over a file, and a file wins over a built-in: your `explore.md` replaces the shipped `explore`, and gets the tools and the mode its own keys give rather than the read-only set; set `permissionMode: plan` to keep it read-only.

### A pack can ship subagents

A pack installed with `skill_install` can define subagents in an `agents` folder next to its `SKILL.md`: `agents/reviewer.md`, in the format above. They are in `task`'s list from the session's first request, whether or not the skill is loaded, under the pack's name: `reviewer` in the pack `kit` is `kit:reviewer`. `/agents` lists them as from `Pack <name>`. A skill folder of your own, one without a `pack.json`, is not a pack: an `agents` folder in it defines nothing.

A pack's definition gets no `hooks`, `mcpServers` or `permissionMode` of its own: those keys are not read, and `/agents <name>` lists them as `ignored for a pack`. A pack's hooks belong in its `hooks/hooks.json`.

A name a folder above, an extension or a built-in already gives stays theirs: the pack's definition is not offered, and `/agents` says so. A definition that names a tool that does not exist is not offered either. The packs' folders are read again whenever the others are, and before each `task` call. A pack replaced with a new version therefore offers what the new version has: a definition it renamed or left out is `unknown subagent type` under its old name.

## Subagents of a subagent

A subagent can start subagents of its own with `task`, up to three layers below the conversation. `CIRCLE_MAX_SUBAGENT_SPAWN_DEPTH` sets how many layers there are, and `1` turns nesting off. A subagent in the last layer is not offered `task`, so it does the work itself and returns one report.

- A subagent's own subagents run in the foreground: it waits for each report, and only its own report comes back to your conversation. Its `task` has no `background`, and a definition's `background: true` does not apply there. Several `task` calls in one reply still run side by side.
- Without a `model` of its own, a subagent runs on the model of the one that started it.
- Every layer works for your conversation. Hooks get the conversation's `session_id` and the layer's own session as `agent_id`, with its type as `agent_type`; its commands get `CIRCLE_AGENT_ID`; its cards ask you, and what you allow for the session holds for the whole conversation; what it costs counts in the conversation's total. A card of one that works under a background subagent waits under that subagent's job.
- Each is a session of its own under the one that started it, and what it starts in the background stops when it ends.
- A read-only subagent (the built-in `explore` or `plan`, or one with `permissionMode: plan`) keeps the subagents it starts read-only. Its other modes are its own: a subagent it starts works in that subagent's own `permissionMode`, or the conversation's.
- The built-in `explore` and `plan` have no `task`. A definition that must not delegate leaves `task` out of its `tools` or puts it in `disallowedTools`.

At most 20 subagents run at once for one conversation, in the foreground or the background, at any depth (`CIRCLE_MAX_CONCURRENT_SUBAGENTS`). At the limit `task` fails with `Concurrent subagent limit reached` and tells the model not to retry; it works again once one of them has finished. There is no limit on how many a session starts over its life. The agents a [workflow](workflows.md) starts are not counted here: they keep to the workflow's own limit of 16 at once.

## Seeing them: `/agents`

`/agents` lists what `task` can choose — the built-ins first, then the files and extensions — one line each. Under `Not offered:` it lists every definition that could not be used, with the reason, under `Not supported yet:` the keys Circle reads and does not apply yet, and under `Not applied:` a value a rule keeps from applying, with why:

```
Not offered:
  C:\work\proj\.circle\agents\broken.md: 'not a name' is not a name (letters, digits, _ and -, up to 64)
  ghost names tools that do not exist: no_such_tool · not offered

Not supported yet:
  keeper: memory user, color blue

Not applied:
  editor: permissionMode acceptEdits: a project's definition cannot loosen approvals
```

`/agents <name>` shows one of them: the folder it came from, its model and depth, the tools it names, and each key above that it sets. Nothing is passed over in silence, because a file that did not load is otherwise impossible to find.

The desktop application's `/agents` opens the subagents panel, which lists the agents of this conversation; the definitions above are the terminal's list.

## What holds for every subagent

- `task` runs it to the end and returns its report.
- It never gets `question`, `plan_enter`, `plan_exit` or `compact_conversation`, whatever its `tools` say: those ask you, or act on the conversation itself. It gets `task` while the depth limit allows.
- Approvals apply as they do to the main agent, in the mode [Permission modes](#permission-modes) gives it: a write or a command asks you, `auto` runs it, read-only refuses it. See [Security](security.md).
- Its context is its own. It sees the description `task` gives it, not your conversation, and its work stays in its own record until it answers. See [How Circle works](how-circle-works.md#subagents).
- It starts with the skills the one that started it has loaded, in full, after those its definition names under `skills`: a skill you loaded reaches it, a skill a subagent loaded reaches the subagents that one starts, and a skill a sibling loaded does not. The agents a [workflow](workflows.md) starts take only the skills their definition names. Unless its definition sets `sessionPrompt: false`, its system prompt is the conversation's, so it lists the same skills too.
- Its system prompt ends with a `<subagent_context>` note when something applies to its calls: the session's plan file, a read-only or `dontAsk` mode, the [approval rules](security.md) that deny its tools (for one that can type into your terminal tabs, the `execute` rules that judge those lines too), and the `PreToolUse` and `PermissionRequest` hooks that guard calls, by their matchers alone. It leaves out what a hook runs and what it says. What a `SessionStart` hook said is not passed on; a [`SubagentStart` hook](hooks.md) gives a subagent words of its own.
- With `background: true` it keeps running and its report arrives as a notice. See [Background jobs](background-jobs.md).
- A file naming a tool that does not exist is skipped rather than run with a broken set, so load the MCP server or the extension first.

The folders are read again before each `task` call and with every rebuild of the system prompt: a new or resumed session, a model switch, `/reload`, `/mcp reload`, `/extensions reload`. A file written during a turn can therefore be given to `task` at once, also by a later call in the same reply that wrote it. `task`'s list of names is written again with the tools: when the session starts, when tools change, and when a skill that ships subagents loads.

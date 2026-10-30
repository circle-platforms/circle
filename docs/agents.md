---
nav_order: 12.4
---

# Subagents

A subagent is a second Circle with its own context: `task` starts one, it works alone, and only its report comes back to your conversation. Two ship with Circle — `general-purpose` and the read-only `explore` — [extensions](extensions.md) register more, and **folders of markdown files define the rest**. This page is about those.

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
| `tools` | no | the exact tool names it may use; without the key it gets everything a subagent may have |
| `model` | no | an id on the same endpoint; without it the agent uses the conversation's model |

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

An **extension** that registers the name wins over a file, and a file wins over a built-in: your `explore.md` replaces the shipped `explore`, and gets the tools its own keys name rather than the read-only set.

## Seeing them: `/agents`

`/agents` lists what `task` can choose — the built-ins first, then the files and extensions — one line each, and under `Not offered:` every definition that could not be used, with the reason:

```
Not offered:
  C:\work\proj\.circle\agents\broken.md: 'not a name' is not a name (letters, digits, _ and -, up to 64)
  ghost names tools that do not exist: no_such_tool · not offered
```

`/agents <name>` shows one of them: the folder it came from, its model, and the tools it names. Nothing is passed over in silence, because a file that did not load is otherwise impossible to find.

The desktop application's `/agents` opens the subagents panel, which lists the agents of this conversation; the definitions above are the terminal's list.

## What holds for every subagent

- `task` runs it to the end and returns its report. A subagent cannot start another: no `task`, no `compact_conversation`, no `plan_enter` or `plan_exit`.
- Approvals apply exactly as they do to the main agent: a write or a command asks you, `auto` runs it, `read-only` refuses it. See [Security](security.md).
- Its context is its own. It sees the description `task` gives it, not your conversation, and its work stays in its own record until it answers. See [How Circle works](how-circle-works.md#subagents).
- With `background: true` it keeps running and its report arrives as a notice. See [Background jobs](background-jobs.md).
- A file naming a tool that does not exist is skipped rather than run with a broken set, so load the MCP server or the extension first.

The folders are read again with every rebuild of the system prompt — a new or resumed session, a model switch, `/reload`, `/mcp reload`, `/extensions reload` — so a file you have just written is in the next turn's list.
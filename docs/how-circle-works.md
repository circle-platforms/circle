---
nav_order: 4
---

# How Circle works

Circle coordinates model requests, tool execution, approvals, context assembly and session storage. It is written in TypeScript and runs on Node.js; it talks to your endpoint through the OpenAI and Anthropic client libraries, and adds its own terminal interface, safety policy and reliability layers.

## The agent loop

A message you send starts a turn. Circle builds a request from the system prompt, the conversation so far and the tool definitions, and sends it to your model endpoint. The model streams a reply that can contain text and tool calls.

Circle runs the tool calls one after another, except that `task` calls next to each other run at the same time, and adds the results to the conversation in the order they were made. If the model made tool calls, Circle sends another request. When the model answers without calling a tool, the turn ends and the footer shows what it cost.

Some tool calls wait for you. A command, a file change or a question from the model pauses the turn until you answer the card on screen, and then the turn goes on from there. Every message and result is saved as it happens, so a crash loses at most the step that was running.

`esc` cancels the current turn. Circle checks for the cancel at every model and tool boundary, and a shell command that is running is ended with everything it started. [Background jobs](background-jobs.md) are not touched: they go on, and Circle tells the model when one ends, starting a turn for it when nothing else runs.

## Tools

The main agent has twenty-one built-in tools. See [Built-in tools](tools.md).

- Reading and searching: `ls`, `read_file`, `glob`, `grep`, `lsp`, `webfetch`, `websearch`
- Changing things: `write_file`, `edit_file`, `apply_patch`, `delete`, `execute`
- Working with you: `write_todos`, `question`, `plan_enter`, `plan_exit`
- Background jobs: `list_jobs`, `stop_job`
- Extending itself: `skill`, `task`, `compact_conversation`

In the desktop application, and in the full-screen terminal interface when Chrome, Edge or Chromium is installed, thirteen `browser_*` tools use a browser as a person does: they read pages, click, type, answer dialogs, manage tabs and give pages files, and record what they did as a script that Circle can replay. You see what Circle does in the browser, and you can act in it too. See [The browser](tools.md#the-browser).

MCP servers and [extensions](extensions.md) add more.

## Context

The model sees the conversation history and a system prompt that Circle assembles for every session. The prompt has these parts, in order:

1. Base instructions chosen by the model family (Claude, GPT, Gemini, Kimi and others each get their own).
2. Circle's guidelines and a note on how paths work.
3. Your instruction files: `AGENTS.md` or `CLAUDE.md` from the workspace and its parent folders, then your personal ones. See [Configuration](configuration.md#instruction-files).
4. A short description of the environment: working folder, platform, date, whether it is a git repository, model and protocol.
5. Anything appended with `APPEND_SYSTEM.md` (the project's `.circle/` one, else the data folder's) or `--append-system-prompt`.
6. The names and descriptions of the [skills](skills.md), and of the extension tools.

The full text of a skill is read only when it is needed. The tools themselves are sent with each request, not in the prompt.

When the conversation passes 85% of the model's context window (from models.dev or `models` in settings, else 128,000), or sooner when the room kept for the answer needs it (see [Models](models.md#cost-and-context-in-the-footer)), Circle summarizes older messages automatically and keeps the most recent tenth. The full text of what was summarized is saved in the data folder (`projects/<folder>-<id>/conversation_history/`), not in your project. `/compact` does it on request. Older tool output outside a recent window is also replaced by a short stub in requests, so long sessions stay within budget. The stored conversation keeps the full output. See [Compaction](sessions.md#compaction).

## Subagents

`task` starts a subagent with its own fresh context and returns its answer. Circle has two, and extensions can add more:

| Subagent | What it can do |
|---|---|
| `general-purpose` | The same tools as the main agent, without `task`, `compact_conversation` and the plan-mode tools, plus `wait_jobs`. Approvals apply to it exactly as to the main agent. |
| `explore` | Read-only: list, read and search files, the web and language servers, and load skills. It never asks for approval. |

`task` calls next to each other in one reply run at the same time. While they run, a strip below the input box shows it; `↓` selects it and `enter` opens its full record.

With `background: true` a subagent runs as a [background job](background-jobs.md#background-subagents): the turn goes on, and its report reaches the model when it ends. Several can run at once. Its approvals show as cards of their own.

## Safety

Every session runs in a folder you have trusted. Commands and file changes ask first, and some commands are always refused. There are three modes you can switch on: `accept edits` stops asking for file changes inside the workspace, `read-only` blocks all changes, and `auto` stops asking. None of this is an operating-system sandbox: a command you approve runs with your full user rights. Read [Security](security.md) before you rely on it.

The browser is approved site by site. Passing a certificate warning and giving a page files ask every time, and a page's permissions and client certificates are yours alone. A password reaches a page or a command as a [saved secret](security.md#secrets-by-name): the model writes `%NAME%` and never sees the value.

## Sessions

A session is a conversation with its own history and branches, saved in `circle.sqlite` in your data folder. See [Sessions](sessions.md), including what does not carry over.

## Reliability

Circle protects a turn from the things that go wrong around a model:

- A request that times out is sent again, up to 10 times. A timeout is no answer within `CIRCLE_LLM_TIMEOUT` (45 seconds), a stream with no content for `CIRCLE_LLM_STALL_TIMEOUT` (3 minutes), or a gateway's 408, 504 or 524. Each try waits twice as long as the one before for the answer to start (up to 5 minutes) and for content in the stream (up to 8 times as long). The busy line says so while it happens: `Retrying… · timeout 3/10 · 4m 2s`. After the tenth retry the turn stops with the error and `(gave up after 10 retries)`.
- Other transient endpoint errors are retried with backoff, honouring `Retry-After`: rate limits up to 5 times within 10 minutes, server errors and dropped connections up to 6 times within 5 minutes, errors the endpoint reports inside a stream 3 times. Certificate and TLS errors are not retried: they fail the same way every time.
- A timeout or a dropped connection is retried even when part of the answer had come; that part is dropped, and the answer starts again.
- A parameter your endpoint rejects is dropped for the rest of the session.
- A model stuck repeating itself while thinking is cut and sent again with a reminder; one repeating itself in its answer is stopped.
- A response that ends without a complete finish signal, at its output limit, filtered or empty is kept in history and reported as incomplete, not sent again. Its tool calls are not run.
- A model that keeps repeating the same tool call, or keeps finding nothing, is reminded to change course.
- A tool that crashes returns an error to the model instead of ending the turn.
- A tool call with the wrong name case, argument names or argument shape is repaired when the meaning is clear, and checked against the tool's schema before it runs.

Details and the settings that tune them are in [Choose a model](models.md#when-a-request-fails) and [Environment variables](environment-variables.md).

## Interfaces

The full-screen interface is the main way to use Circle. `circle -p` runs one prompt and prints the answer, line mode reads prompts from a pipe, and RPC mode lets another program drive it; see [CLI](cli.md). All of them use the same agent, the same folders and the same saved sessions.

## Extending Circle

[Skills](skills.md) add instructions on demand. [Custom commands](custom-commands.md) turn a Markdown file into a slash command. [MCP servers](mcp.md) add tools from other programs. [Extensions](extensions.md) are JavaScript or TypeScript modules that add tools, commands, middleware, subagents and result renderers.

---

This document is one of Circle's design specifications, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): quote or build on it with attribution to Circle and qingshanfeihu and a link to the original. See the [design specifications index](https://github.com/circle-platforms/circle/blob/main/docs/design/README.md).

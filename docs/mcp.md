---
nav_order: 14
---

# MCP servers

Circle can load tools from [Model Context Protocol](https://modelcontextprotocol.io) servers and offer them to the model next to its own. Read [what MCP tools are allowed to do](#security) before you rely on them.

## Add a server

Add it to `mcp_servers` in [`settings.json`](settings.md) in the data folder, then run `/reload` or `/mcp reload`. A project's `.circle/settings.json` cannot add servers.

A server started as a program on your machine:

```json
"mcp_servers": [
  {
    "name": "memory",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "env": { "SOME_VAR": "value" }
  }
]
```

A server reached over the network:

```json
"mcp_servers": [
  { "name": "docs", "url": "https://example.com/mcp", "transport": "streamable_http" }
]
```

| Field                    | Meaning                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                   | Prefix for the server's tools. Any name works: characters other than letters, digits, `_` and `-` become `_` in tool names, and a tool name over 64 characters is shortened with a short hash. Falls back to `id`, then `mcp0`, `mcp1`, … When two servers have the same name the later one is used, and `/mcp` lists the earlier one with the reason. |
| `command`, `args`, `env` | Start the server as a program (stdio), in the workspace.                                                                                                                                                                                                                                                                                               |
| `url`, `transport`       | Connect to a server. `transport` is `sse` (the default), `streamable_http` or `websocket`; anything else is treated as `sse`.                                                                                                                                                                                                                          |
| `headers`                | Headers sent with every request to a `url` server over `sse` or `streamable_http`, such as `{ "Authorization": "Bearer ${secret:DOCS_TOKEN}" }`. A value can name a saved secret or an environment variable; see [Tokens in headers](#tokens-in-headers). A `websocket` server cannot be sent headers.                                                 |
| `trust_annotations`      | `true` (the default): what the server says of each tool decides how its calls are approved. `false`: it is ignored, and every tool of that server asks. See [Security](#security).                                                                                                                                                                     |

An entry with neither `command` nor `url` is skipped. A URL may not carry a user name or password; use `headers` instead.

```json
"mcp_servers": [
  {
    "name": "docs",
    "url": "https://example.com/mcp",
    "transport": "streamable_http",
    "headers": { "Authorization": "Bearer ${secret:DOCS_TOKEN}" }
  }
]
```

A program started for a server gets your environment without the variables whose names look secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and the like; see [The shell environment](security.md#the-shell-environment)), plus the `env` you give it. Put a key the server needs in `env`.

### Tokens in headers

A header value can name a saved [secret](security.md#secrets-by-name) as `${secret:NAME}` (save one with `/secrets NAME`, or in the desktop settings under **variables** → **secrets**), and a variable of the environment Circle was started in as `${env:NAME}`, so a token need not be written in `settings.json`. Circle puts the values in when it connects: a secret saved or changed later is used from the next `/mcp reload`. A secret that is not saved, a variable that is not set, a header name that is not a valid token, or a value with a line break stops that server before any request, and `/mcp` names the header and the secret or variable, never a value.

`/mcp` lists the names of the headers a server is sent, not their values. Where a server's answer, error or tool description quotes a value Circle put in, Circle shows `%NAME%` in its place for a secret and `${env:NAME}` for an environment variable: in what the model reads, in the conversation, and in the server's status that `/mcp` and the desktop show. A value written into `settings.json` as it is, without a reference, is not hidden this way.

## What you get

Each tool is offered to the model as `<name>_<tool>`, for example `memory_create_entities`. Circle connects when the full-screen interface starts or the desktop application opens a trusted folder, and again on `/reload`, `/mcp reload` and `/extensions reload`. In [print mode, line mode](cli.md#print-mode) and [RPC mode](rpc.md) it connects only with `--extensions`, before the first prompt. It waits up to 30 seconds for each server. A server that fails is listed by `/mcp` with the reason, and the other servers' tools still load.

A tool call has no time limit, so a tool that waits for a login or a long job can take as long as it needs. `esc` sends the server a cancellation; what the server does with it is up to the server. Images and PDFs a tool returns go to the model as attachments.

## Drive a browser

Circle's own `screenshot` tool only looks at the screen. To let the model open a web app you are building, click and type in it, and read its console and network, add a browser server. Two that run with `npx`:

```json
"mcp_servers": [
  { "name": "browser", "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
  { "name": "devtools", "command": "npx", "args": ["-y", "chrome-devtools-mcp@latest"] }
]
```

[Playwright MCP](https://github.com/microsoft/playwright-mcp) gives the model the page's elements to click and type into, and screenshots of the page. [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) adds the console, network requests and performance traces of a Chrome it starts. Their calls are approved as any MCP tool's (see [Security](#security)), and the pictures they return go to the model as attachments.

## Commands

| Command       | What it does                                                               |
| ------------- | -------------------------------------------------------------------------- |
| `/mcp`        | List the servers, their tools, and why a server failed.                    |
| `/mcp reload` | Re-read `settings.json` and reconnect every server. Not while a turn runs. |

In print mode, line mode and RPC mode MCP servers load only with `--extensions` (`circle --extensions -p "…"`, `circle --mode rpc --extensions`). Closing Circle closes the connections and stops the programs it started.

## Security

An MCP server can be a program that runs with your rights, and its tools can do whatever it does. Circle cannot see what a tool changes. It goes by what the server says of each tool in the tool's annotations: hints from the server you configured, which Circle does not check. Only a value of `true` counts.

- A tool marked `readOnlyHint` is treated as Circle's own reads are: it does not ask, and it keeps working in `read-only` and plan mode.
- A tool marked `destructiveHint` asks on every call, and its card warns that it can delete or overwrite data. "Allow for this session" is not offered for it, and a rule kept for it before covers none of its calls. In `auto` mode it runs without asking, as every call does there. A tool marked both ways counts as destructive.
- Any other tool asks for approval, and `read-only` mode refuses it. "Allow for this session" on the card covers every call to that tool.

With `"trust_annotations": false` a server's annotations are ignored: every one of its tools asks, `read-only` mode refuses them all, and "Allow for this session" covers each. Only add servers you trust. See [Security](security.md).

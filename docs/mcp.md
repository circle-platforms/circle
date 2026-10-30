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

| Field                    | Meaning                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`                   | Prefix for the server's tools. Any name works: characters other than letters, digits, `_` and `-` become `_` in tool names, and a tool name over 64 characters is shortened with a short hash. Falls back to `id`, then `mcp0`, `mcp1`, … When two servers have the same name the later one is used, and `/mcp` lists the earlier one with the reason.                   |
| `command`, `args`, `env` | Start the server as a program (stdio), in the workspace.                                                                                                                                                                                                                                                                                                                 |
| `url`, `transport`       | Connect to a server at that address. `transport` says how: `streamable_http` (Streamable HTTP, MCP's current HTTP transport), `sse` (the older HTTP with server-sent events, which the MCP SDK marks deprecated) or `websocket`. Without `transport`, or with any other value, Circle uses `sse`, so give `"transport": "streamable_http"` for a Streamable HTTP server. |
| `headers`                | Headers sent with every request to a `url` server over `sse` or `streamable_http`, such as `{ "Authorization": "Bearer ${secret:DOCS_TOKEN}" }`. A value can name a saved secret or an environment variable; see [Tokens in headers](#tokens-in-headers). A `websocket` server cannot be sent headers.                                                                   |
| `trust_annotations`      | `true` (the default): what the server says of each tool decides how its calls are approved. `false`: it is ignored, and every tool of that server asks. See [Security](#security).                                                                                                                                                                                       |
| `max_file_bytes`         | The largest file a [file parameter](#files-a-tool-takes) of the server's tools sends, in bytes: 33554432 (32 MiB) unless set. A value that is not a whole number of bytes, 1 or more, stops that server, and `/mcp` says why.                                                                                                                                            |

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

A header value can name a saved [secret](security.md#secrets-by-name) as `${secret:NAME}` (save one with `/secrets NAME`, or in the desktop settings under **variables & secrets** → **secrets**), and a variable of the environment Circle was started in as `${env:NAME}`, so a token need not be written in `settings.json`. Circle puts the values in when it connects: a secret saved or changed later is used from the next `/mcp reload`. A secret that is not saved, a variable that is not set, a header name that is not a valid token, or a value with a line break stops that server before any request, and `/mcp` names the header and the secret or variable, never a value.

`/mcp` lists the names of the headers a server is sent, not their values. Where a server's answer, error, instructions or tool description quotes a secret value Circle put in, Circle shows its reference in its place: `%NAME%` for a saved secret, and `${env:NAME}` for an environment variable whose name looks secret, by the rule of [the shell environment](security.md#the-shell-environment) (`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and the like), or that goes into `Authorization`, `Proxy-Authorization` or a header whose name looks secret by the same rule, such as `X-Api-Key`. That holds in what the model reads, in the conversation, and in the server's status that `/mcp` and the desktop show. Such a value is replaced wherever it stands, also inside a longer word or number, as a secret's value is in other tool output (see [Known issues](known-issues.md#desktop-application)). Any other environment variable's value, such as a region or an API version, is no secret and is not replaced, and neither is a value written into `settings.json` as it is, without a reference. Where a server quotes a file it was sent and a secret value lies inside that file's encoding, the model reads the file's path, size and digest, not the encoding.

## What you get

Each tool is offered to the model as `<name>_<tool>`, for example `memory_create_entities`. Circle connects when the full-screen interface starts or the desktop application opens a trusted folder, and again on `/reload`, `/mcp reload` and `/extensions reload`. In [print mode, line mode](cli.md#print-mode) and [RPC mode](rpc.md) it connects only with `--extensions`, before the first prompt. It waits up to 30 seconds for each server. A server that fails is listed by `/mcp` with the reason, and the other servers' tools still load.

A server can tell its clients how to use its tools, in the instructions it sends when Circle connects. Circle adds them to the model's system prompt in a section of their own for each server, headed "Instructions from MCP server <name>", which says they are the server's words and not yours: where they differ from what you ask, from your or the project's instructions, or from the rest of the prompt, those come first. Circle takes the first 8 KiB of each server's instructions and marks where it cut, keeps line breaks and tabs, takes out other control characters and the bidirectional-text controls, and writes each `<` in them as `&lt;` (and says so in the section), so no tag in them can end the section or pass for a part of the prompt. A server that is not connected, or sent none, has no section. They are read again on every connect, so `/mcp reload` brings changed instructions in. When a program Circle started for a server exits, its section leaves the prompt from the next turn, and `/mcp` says the connection ended. A server reached over the network is not watched between requests: its section stays until the servers are reloaded.

Every request to a `streamable_http` or `sse` server carries a `Circle-Session-Id` header with the id of the Circle session at that moment, which changes when you start or switch sessions (as RPC `new_session` does), and the requests of each tool call, the cancellation `esc` sends included, carry a W3C `traceparent` header, `00-<trace id>-<parent id>-01`, with a new random trace id for every call. A server can use them to group what one session did and to tell calls apart in its logs. Circle sets both itself: a configured header of either name, in any letter case, is not sent and its value is not filled in, so a secret or variable it names need not exist, and `/mcp` lists it as not sent. A `websocket` server and a program started for a server get neither. Circle has sent both since 1.13.0; an install of 1.12.0 or older sends neither, headless runs included.

A tool call has no time limit, so a tool that waits for a login or a long job can take as long as it needs. `esc` sends the server a cancellation; what the server does with it is up to the server. Images and PDFs a tool returns go to the model as attachments.

## Files a tool takes

A tool can take a file as an argument: a top-level property of its input that is a JSON Schema string with `"contentEncoding": "base64"` (with or without `contentMediaType`). Circle shows the model that tool with the same schema, except that the property's description says it takes a local file path, and its `pattern`, `format`, `minLength` and `maxLength`, which describe the encoded text, are left out. The model gives a path. Circle reads the file and sends its bytes, base64-encoded, as that argument.

- The path is taken as `read_file` takes it, by the same code: relative to the workspace or absolute, a path with `..` refused, a [credential file](security.md#credential-files) refused by name, and in the desktop application a file outside the workspace only with the grant you gave the conversation. In the desktop application a workspace file is also refused where its `read_file` refuses one: under `.git` or `.circle`, a credential file name in any letter case on macOS and Windows (whose file systems ignore case), and a file with other names on disk (a hard link).
- Only a regular file of at most `max_file_bytes` is sent. A folder, a missing file, a pipe or a larger file is an error the model reads, with no card, and the server is not called.
- The file is read before the approval card, and the call sends the bytes read then: a file changed while the card is up is sent as it was. Rejecting the call sends nothing.
- The approval card shows the path, the size in bytes and the SHA-256 of what is sent, not the bytes, and the result the model reads starts with a line such as `file: sent data/report.pdf (48213 bytes, sha256 9f2c…)`. Where the server's answer or error quotes the encoded file, the model reads that path, size and digest instead. The conversation keeps the path the model gave and that result, never the bytes.
- A call that sends a file asks, also for a tool its server marks read-only (see [Security](#security)), and read-only mode refuses it.
- [Hook](hooks.md) path globs match the path a file parameter names, whatever the parameter is called.

A tool its server marks `idempotentHint` is not called again for the same thing while nothing has changed it since: when the conversation calls it with files of the same contents (compared by SHA-256, whatever their paths) and the same other arguments as an earlier call that succeeded, and no call that may change what the server holds has gone to that server in between, Circle gives the model that earlier result, starting with `cached (same content)`, and the server is not contacted. MCP's hint only says that the same call repeated has no further effect; any other call can change what the result says. So every call Circle sends to a server, of any of its tools that the server does not mark `readOnlyHint` and whether it then succeeds or fails, forgets the results kept for that server, and so does the end of its connection (a program Circle started that exits). Changes made to the server by anything else, such as another client or the server itself, are not seen: if those can happen, do not rely on a repeated call reaching the server. The call still asks for approval as any other, and its card says, after each file, that it is not sent and the earlier result is given again. Should a call that may change what the server holds reach it while the card is up, the call is not run, nothing is sent, and the model is told to call again. Circle keeps these results in memory for the conversation and its subagents, at most 64 of them and 16 MiB in all, the least recently used going first; a new session starts with none, and reloading the servers forgets them. A failed call is not kept. Calls that send no file, tools without the hint, and every tool of a server with `trust_annotations: false` always reach the server.

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

| Command       | What it does                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp`        | List the servers, the names of the headers each is sent and of the configured ones Circle does not send, their tools, and why a server failed. |
| `/mcp reload` | Re-read `settings.json` and reconnect every server. Not while a turn runs.                                                                     |

In print mode, line mode and RPC mode MCP servers load only with `--extensions` (`circle --extensions -p "…"`, `circle --mode rpc --extensions`). Closing Circle closes the connections and stops the programs it started.

## Security

An MCP server can be a program that runs with your rights, and its tools can do whatever it does. Circle cannot see what a tool changes. It goes by what the server says of each tool in the tool's annotations: hints from the server you configured, which Circle does not check. Only a value of `true` counts.

- A tool marked `readOnlyHint` is treated as Circle's own reads are: it does not ask, and it keeps working in `read-only` and plan mode. A call of it that sends the server a local file ([a file parameter](#files-a-tool-takes)) or a [secret](security.md#secrets-by-name)'s value is no read for Circle, since that leaves your machine whatever the tool then does with it: such a call asks as an unmarked tool does, and its card says why ("Allow for this session" covers its later calls), and `read-only` and plan mode refuse it before the file is read.
- A tool marked `destructiveHint` always asks, as Circle's own deletes do, and its card warns that it can delete or overwrite data. "Allow for this session" is not offered for it, a rule kept for it before covers none of its calls, a hook's allow does not skip its card, and print, line and RPC mode do not run it, even with `--yolo`. In `auto` mode it runs without asking, as every call does there. A tool marked both ways counts as destructive.
- Any other tool asks for approval, and `read-only` mode refuses it. "Allow for this session" on the card covers every call to that tool.

With `"trust_annotations": false` a server's annotations are ignored: every one of its tools asks, `read-only` mode refuses them all, and "Allow for this session" covers each. Only add servers you trust. See [Security](security.md).

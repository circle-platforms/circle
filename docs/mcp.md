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

| Field                    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                   | Prefix for the server's tools. Any name works: characters other than letters, digits, `_` and `-` become `_` in tool names, and a tool name over 64 characters is shortened with a short hash. Falls back to `id`, then `mcp0`, `mcp1`, … When two servers have the same name the later one is used, and `/mcp` lists the earlier one with the reason.                                                         |
| `command`, `args`, `env` | Start the server as a program (stdio), in the workspace.                                                                                                                                                                                                                                                                                                                                                       |
| `url`, `transport`       | Connect to a server at that address. `transport` says how: `streamable_http` (Streamable HTTP, MCP's current HTTP transport), `sse` (the older HTTP with server-sent events, which the MCP SDK marks deprecated) or `websocket`. Without `transport`, or with any other value, Circle uses `sse`, so give `"transport": "streamable_http"` for a Streamable HTTP server.                                       |
| `headers`                | Headers sent with every request to a `url` server over `sse` or `streamable_http`, such as `{ "Authorization": "Bearer ${secret:DOCS_TOKEN}" }`. A value can name a saved secret or an environment variable; see [Tokens in headers](#tokens-in-headers). A `websocket` server cannot be sent headers.                                                                                                         |
| `trust_annotations`      | `true` (the default): what the server says of each tool decides how its calls are approved. `false`: it is ignored, and every tool of that server asks. See [Security](#security).                                                                                                                                                                                                                             |
| `max_file_bytes`         | The largest file a [file parameter](#files-a-tool-takes) of the server's tools sends, in bytes: 33554432 (32 MiB) unless set. A value that is not a whole number of bytes, 1 or more, stops that server, and `/mcp` says why.                                                                                                                                                                                  |
| `placeholders`           | Names under which an entry reached over HTTP gives tool calls its address and token as `%NAME%` placeholders: `url` names a plain variable holding the endpoint, `token` a secret holding the Bearer token its connection sends (its `Authorization` header's, or else the one its sign-in keeps), such as `{ "url": "DOCS_URL", "token": "DOCS_TOKEN" }`. A kept token with an expiry is given only until it expires: the placeholder does not refresh it, the connection does when it next reaches the server (one of its tools, or `/mcp reload`), and until then the name stays as written. See [Secrets by name](security.md#secrets-by-name). |

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

### Signing in to a server

A server reached by `url` over `streamable_http` or `sse` that answers that it needs a sign-in, by the MCP authorization (OAuth 2.1 with PKCE), is signed in to in the system browser, or in the desktop application in its browser panel beside the conversation, also when the sign-in starts before the window has loaded. Circle finds the server's sign-in service from its answer, registers itself there as `Circle on <this computer's name>`, and opens the sign-in page; `/mcp` shows `waiting for sign-in in the browser` with the page's address, in case no browser opens. Other servers connect meanwhile. The browser comes back to Circle on a `127.0.0.1` address; Circle checks that it brings back the state of this sign-in, exchanges the code for tokens, connects the server and offers its tools. If no sign-in comes back within ten minutes, or the server refuses it, `/mcp` says why.

A server whose authorization server offers the device code (RFC 8628: a `device_authorization_endpoint` and the grant `urn:ietf:params:oauth:grant-type:device_code` in its metadata) is signed in to by code instead, so nothing has to come back to this machine. Circle registers asking for that grant too, asks the server for a code, and `/mcp` shows `enter the code XXXX-XXXX on the sign-in page:` with the page, which opens as the browser sign-in's does, with the code filled in when the server gives such an address. Circle then asks the server at the interval it names, five seconds longer after each `slow_down`, until a person approved or refused the code on that page, for at most the code's lifetime and never more than 30 minutes. A server that gives no code is signed in to in the browser. A refused or expired code shows as `sign-in failed: …`; `/mcp reload` starts a new sign-in.

The registration and the tokens are kept per server in `mcp-auth.json` in Circle's home, readable by you only, so the next start connects without a sign-in. A server that stops taking its token is signed in to again at the next connection. An entry whose `headers` send a credential, such as `Authorization` or a header whose name looks secret, is never signed in to: its header is used as written.

## What you get

Each tool is offered to the model as `<name>_<tool>`, for example `memory_create_entities`. Circle connects when the full-screen interface starts or the desktop application opens a trusted folder, and again on `/reload`, `/mcp reload` and `/extensions reload`. In [print mode, line mode](cli.md#print-mode) and [RPC mode](rpc.md) it connects only with `--extensions`, before the first prompt. It waits up to 30 seconds for each server. A server that fails is listed by `/mcp` with the reason, and the other servers' tools still load.

A server that declares its tools can change (`tools.listChanged`) is listed again when it sends `notifications/tools/list_changed`, 300 ms after its last such notice, so several in a row list it once. Its tools are replaced together with the results kept for it: the next turn offers the tools it lists now, and a turn under way keeps the ones it started with. When that listing fails, the earlier tools stay, and `/mcp` and the desktop show `the server changed its tools and listing them again failed; the earlier tools stay until a reload` until a later listing succeeds. A server that declares nothing is listed only when Circle connects, as before, and again when it is reconnected: `/mcp reload`, or `/mcp reload <name>` for it alone.

Circle speaks MCP up to the 2025-11-25 revision, the newest its MCP library can negotiate. The 2026-07-28 revision's `ttlMs`, which tells a client how long a list stays good, comes with a library that speaks that revision.

A server can tell its clients how to use its tools, in the instructions it sends when Circle connects. Circle adds them to the model's system prompt in a section of their own for each server, headed "Instructions from MCP server <name>", which says they are the server's words and not yours: where they differ from what you ask, from your or the project's instructions, or from the rest of the prompt, those come first. Circle takes the first 8 KiB of each server's instructions and marks where it cut, keeps line breaks and tabs, takes out other control characters and the bidirectional-text controls, and writes each `<` in them as `&lt;` (and says so in the section), so no tag in them can end the section or pass for a part of the prompt. A server that is not connected, or sent none, has no section. They are read again on every connect, so `/mcp reload` brings changed instructions in. When a program Circle started for a server exits, its section leaves the prompt from the next turn, and `/mcp` says the connection ended, until a call to one of its tools or `/mcp reload` starts it again (see [When a call's connection fails](#when-a-calls-connection-fails)). A server reached over the network is not watched between requests: its section stays until the servers are reloaded.

Every request to a `streamable_http` or `sse` server carries a `Circle-Session-Id` header with the id of the Circle session at that moment, which changes when you start or switch sessions (as RPC `new_session` does). The requests of a tool call carry the conversation's session, also when a subagent made the call, and then a `Circle-Agent-Id` header with the subagent's own session: the values the call's hooks get as `session_id` and `agent_id`. The requests of each tool call, the cancellation `esc` sends included, also carry a W3C `traceparent` header, `00-<trace id>-<parent id>-01`, with a new random trace id for every call. A server can use them to group what one session did and to tell calls apart in its logs. Circle sets all three itself: a configured header of any of these names, in any letter case, is not sent and its value is not filled in, so a secret or variable it names need not exist, and `/mcp` lists it as not sent. A `websocket` server and a program started for a server get none of them. Circle has sent `Circle-Session-Id` and `traceparent` since 1.13.0; an install of 1.12.0 or older sends neither, headless runs included.

A tool call has no time limit, so a tool that waits for a login or a long job can take as long as it needs. `esc` sends the server a cancellation; what the server does with it is up to the server. Images and PDFs a tool returns go to the model as attachments.

### When a call's connection fails

Circle tells a request that never left this machine from one that may have reached the server, and the model reads which it was:

| What happened                                                                                                                                                                                                                           | What Circle does                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing was sent: the connection was refused, the name did not resolve, the host or network could not be reached, or connecting timed out (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, a connect timeout). | Sends it again after 0.5, 1 and 2 seconds, four tries in all. When the last fails too, the model reads `<server> could not be reached in 4 tries: the request was not sent`.                                                                                                                                                                                                                                                                     |
| The connection ended after the request was sent: the program exited, the connection was cut or reset, or the event stream the answer was to come on ended without it.                                                                   | Sends the call once more, only when the server is trusted with its annotations (`trust_annotations`, on unless set to `false`) and says the tool is read-only (`readOnlyHint`) or idempotent (`idempotentHint`). Any other call is not sent again, and the model reads `the connection to <server> ended after the call was sent: the request may have reached the server, so Circle did not send it again`. The call goes once more on the server's connection while that is still open, as an HTTP one is when only that request's socket was cut, so the other calls on it go on; otherwise on a new one. |
| The connection ended between calls, as when the program Circle started for the server exited or a `websocket` closed.                                                                                                                   | The next call to one of its tools connects the server again first, and then sends it: nothing was sent on the connection that ended. Calls that find it ended at the same time connect it once.                                                                                                                                                                                                                                                                                                             |

`esc` ends the waits as it ends the call. A reset connection (`ECONNRESET`) counts as one that may have reached the server: it may have been cut before or after the server read the request. An error the server sends is its answer, whatever its code or words: the model reads it as sent, and the call is not sent again. A server connected again carries no call's trace or identity on its own requests: those are each call's. An event stream that carried an event id is resumed by the MCP library, as the 2025-11-25 revision has it, and that call is not sent again. Over the older HTTP+SSE transport (`sse`), and when such a stream cannot be resumed, a lost answer is not noticed: see [known issues](known-issues.md#subagents-and-tools).

The model reads a tool's text. A result with no text gives its structured content as JSON instead, and so does an error with no text. Circle never throws a result away because its structured content does not match the output schema the server listed for the tool when Circle connected, as happens when a server adds a field after an upgrade. Such a result arrives whole: its text, then the line `structured result, as the server sent it: it does not match the output schema the server listed for this tool when Circle connected`, then the structured content. That is all Circle says of it; whether the result is right is the server's to say. An error's structured content is not checked at all, and a schema Circle cannot compile is not used. The tools are not listed again for such a result: a server lists them again by saying its tools changed (above), and `/mcp reload` lists them again.

### Progress and tasks

Every tool call asks its server for progress notices (`_meta.progressToken`). While the call runs, its row shows the latest one after the call, as `3/10 · indexing`: how far it has come, the total when the server gives one, and its message. That is so in the terminal and the desktop, and in [JSON mode](cli.md#json-events) each notice is a `tool_progress` event. Circle shows the server's words on one line, without control characters, cut at 160 characters, and without the values it filled in. The model reads none of it: the result is what it would be without them. The terminal shows the progress of the conversation's own calls, not of a subagent's.

A tool its server lists with `execution.taskSupport` `optional` or `required` runs as a task, as the 2025-11-25 revision has it, when the server says it runs tool calls as tasks (`tasks.requests.tools.call`):

1. Circle sends `tools/call` with `task: {}`, and the server answers at once with the task.
2. Circle asks how the task stands with `tasks/get`, as often as its `pollInterval` says (at least 50 ms and at most 30 seconds apart; every second when it says nothing), and shows its state on the call's row: `task working · <its status message>`.
3. Once the task has completed, failed or needs input, `tasks/result` gives the call's result, which reaches the model as any result does. A task that needs input asks for it meanwhile ([Questions from a server](#questions-from-a-server)). A task the server cancelled is an error.

`esc` sends `tasks/cancel`. A tool that must run as a task (`required`) on a server that does not say it runs them is not sent, and the model reads `<tool> runs only as a task, and <server> does not say it runs tool calls as tasks; nothing was sent`. One that may (`optional`) is called there as any other is. Once the server has made the task the call has reached it, so a failure to follow the task counts as a connection that ended after the call was sent ([above](#when-a-calls-connection-fails)). The tasks of the 2026-07-28 revision, an extension there (`io.modelcontextprotocol/tasks`), come with an MCP library that speaks that revision.

### Questions from a server

A server can ask you for input in the middle of a call (`elicitation/create`). Circle takes the form kind of question, where the server names the fields it wants. It does not take the kind that asks you to open a page: the MCP library answers that one with an error (`-32602`), and Circle says it takes forms when it connects (`elicitation: {form: {}}`), where someone can be asked.

The question panel the [`question` tool](tools.md) uses shows the form, headed by the server's name. The first question is the server's message, then a question follows for each field and a last one asks whether to send the answers:

- **Yes or no** is chosen from `yes` and `no`.
- **A list of values** is chosen from (`enum`, or `oneOf` with titles), and a list of several (an `array` of them) takes more than one.
- **Text and numbers** are typed. A number must be one, a whole number when the server asks for one, and inside its bounds. Text must be of the length and kind the server asks for: an email address, an address (`uri`), a date or a date and time.
- **An optional field** says `(optional)` and can be left empty. A field with a default says what an empty answer gives (`empty: …`).

When an answer does not fit, the panel comes back saying what was wrong (`Not sent: …`), and nothing reaches the server until the answers fit. The server gets:

| What you do                     | What the server gets                                       |
| ------------------------------- | ---------------------------------------------------------- |
| Answer **send** (or **accept**) | `accept`, with the answers as the values its form asks for |
| Answer **decline**              | `decline`                                                  |
| Close the panel                 | `cancel`                                                   |
| Press `esc` on the call         | `cancel`                                                   |

The server can also take its question back. A question that came on a stream of the server's own, as a program's questions do, is withdrawn once none of that server's calls is under way, so `esc` on the only call closes it. In print, JSON, line and RPC mode no one can be asked: Circle does not say it takes forms, so a server does not ask, and one that asks anyway is told the method is not found (`-32601`). A task that needs input (`input_required`) asks this way while Circle reads its result. The 2026-07-28 revision asks by a result instead (`input_required` with `inputResponses`), and comes with an MCP library that speaks that revision.

### What the model reads of a result

| A block of the result | What the model gets |
|---|---|
| `text` | its text |
| `image` as PNG, JPEG, GIF or WebP | an attachment, named in the text as `Attachment: <file> (<type>)` |
| `resource` with text | `Resource <uri> (<type>):` and its text |
| `resource` with a PNG, JPEG, GIF or WebP image or a PDF | an attachment, as an image |
| `resource_link` | a line naming it, its URI and type, and that `read_mcp_resource` reads it: the link is not the content |
| anything else, such as `audio` | the block as JSON |

While a connected server declares `resources`, the model also has two tools of Circle's for them:

- `read_mcp_resource` takes the server and a URI. It reads text as text, images and PDFs as attachments, and other binary content as its size. A long result is kept in a file, as any tool's is.
- `list_mcp_resources` lists what one server or every such server publishes, ten pages at most from each. A link a tool returns need not be in that list, as the MCP specification says, so reading one does not ask for it to be listed first.

Both run as reads, without a card, as a read-only tool of the server does. While a server that publishes resources is not trusted with what it says of its tools (`trust_annotations: false`), they ask, as that server's tools do.

Both are reads. A server's own tool of the same name keeps the name.

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

| Command       | What it does                                                                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp`        | List the servers, the names of the headers each is sent and of the configured ones Circle does not send, their tools, the sign-in page a server waits on, and why a server failed. |
| `/mcp reload` | Re-read `settings.json` and reconnect every server. Not while a turn runs.                                                                                                         |
| `/mcp reload <name>` | Re-read `settings.json` and reconnect that one server, listing its tools again. The other servers, and the programs started for them, are left as they are. A server no longer in the settings, or turned off, is closed and its tools go. Not while a turn runs. The desktop's MCP page has **reconnect** on each server for the same. |

In print mode, line mode and RPC mode MCP servers load only with `--extensions` (`circle --extensions -p "…"`, `circle --mode rpc --extensions`). Closing Circle closes the connections and stops the programs it started.

## Security

An MCP server can be a program that runs with your rights, and its tools can do whatever it does. Circle cannot see what a tool changes. It goes by what the server says of each tool in the tool's annotations: hints from the server you configured, which Circle does not check. Only a value of `true` counts.

- A tool marked `readOnlyHint` is treated as Circle's own reads are: it does not ask, and it keeps working in `read-only` and plan mode. A call of it that sends the server a local file ([a file parameter](#files-a-tool-takes)) or a [secret](security.md#secrets-by-name)'s value is no read for Circle, since that leaves your machine whatever the tool then does with it: such a call asks as an unmarked tool does, and its card says why ("Allow for this session" covers its later calls), and `read-only` and plan mode refuse it before the file is read.
- A tool marked `destructiveHint` always asks, as Circle's own deletes do, and its card warns that it can delete or overwrite data. "Allow for this session" is not offered for it, a rule kept for it before covers none of its calls, a hook's allow does not skip its card, and print, line and RPC mode do not run it, even with `--yolo`. In `auto` mode it runs without asking, as every call does there. A tool marked both ways counts as destructive.
- Any other tool asks for approval, and `read-only` mode refuses it. "Allow for this session" on the card covers every call to that tool.

With `"trust_annotations": false` a server's annotations are ignored: every one of its tools asks, `read-only` mode refuses them all, and "Allow for this session" covers each. Only add servers you trust. See [Security](security.md).

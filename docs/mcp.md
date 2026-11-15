---
nav_order: 14
---

# MCP servers

Circle can load tools from [Model Context Protocol](https://modelcontextprotocol.io) servers and offer them to the model next to its own. Read [what MCP tools are allowed to do](#security) before you rely on them.

## Add a server

Servers are written as `mcpServers`, an object of servers by name, as other MCP clients write them. Three places hold it:

| Where | For | Shared |
| ----- | --- | ------ |
| `mcpServers` in [`settings.json`](settings.md) in the data folder | you, in every project | no |
| `projects["<folder>"].mcpServers` in the same `settings.json` | you, in that project only | no |
| `.mcp.json` at the project's root | everyone who opens the project | yes, through version control |

When one name is in more than one place, the entry of the project in your `settings.json` is used, else the project's `.mcp.json`, else yours; the whole entry is taken from that place, its fields are not merged. Run `/reload` or `/mcp reconnect <name>` after you change one. A project's `.circle/settings.json` cannot add servers.

A server started as a program on your machine:

```json
"mcpServers": {
  "memory": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-memory"],
    "env": { "SOME_VAR": "value" }
  }
}
```

A server reached over the network:

```json
"mcpServers": {
  "docs": { "type": "http", "url": "https://example.com/mcp" }
}
```

| Field | Meaning |
| ----- | ------- |
| the name | The key of the entry. Its tools are offered to the model as `mcp__<name>__<tool>`: characters other than letters, digits, `_` and `-` become `_` in tool names, and a tool name over 64 characters is shortened with a short hash. |
| `type` | `stdio` (a program, the default when there is no `type`), `http` (Streamable HTTP, MCP's current HTTP transport; `streamable-http` is read as `http`), `sse` (the older HTTP with server-sent events, which the MCP SDK marks deprecated) or `ws` (WebSocket). An entry with a `url` and no `type` is not connected, and `/mcp` says to add one, since without a `type` it is read as a program. |
| `command`, `args`, `env` | Start the server as a program (stdio), in the workspace. It also gets `CIRCLE_PROJECT_DIR`, the workspace. |
| `url` | The address of an `http`, `sse` or `ws` server. It may not carry a user name or password; use `headers` instead. An entry whose `url` is empty is listed as not configured. |
| `headers` | Headers sent with every request to an `http` or `sse` server, such as `{ "Authorization": "Bearer ${DOCS_TOKEN}" }`. See [Variables in an entry](#variables-in-an-entry). A `ws` server cannot be sent headers yet (see [known issues](known-issues.md#subagents-and-tools)). |
| `headersHelper` | A command run in a shell when Circle connects the server, which prints a JSON object of header names and values; see [Headers from a command](#headers-from-a-command). |
| `enabled` | Only Circle reads it: `false` keeps the server's entry without connecting it. The desktop's MCP page switches it. |
| `max_file_bytes` | Only Circle reads it: the largest file a [file parameter](#files-a-tool-takes) of the server's tools sends, in bytes: 33554432 (32 MiB) unless set. A value that is not a whole number of bytes, 1 or more, stops that server, and `/mcp` says why. |
| `placeholders` | Only Circle reads it, and only in your own `mcpServers`: names under which an entry reached over HTTP gives tool calls its address and token as `%NAME%` placeholders: `url` names a plain variable holding the endpoint, `token` a secret holding the Bearer token its connection sends (its `Authorization` header's, or else the one its sign-in keeps), such as `{ "url": "DOCS_URL", "token": "DOCS_TOKEN" }`. A kept token with an expiry is given only until it expires: the placeholder does not refresh it, the connection does when it next reaches the server (one of its tools, or `/mcp reconnect`), and until then the name stays as written. See [Secrets by name](security.md#secrets-by-name). |

An entry of a `type` Circle does not know, or `"type": "sdk"`, is listed by `/mcp` with the reason and not connected.

A program started for a server gets your environment without the variables whose names look secret (`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and the like; see [The shell environment](security.md#the-shell-environment)), plus the `env` you give it. Put a key the server needs in `env`.

### The project's .mcp.json

A project shares servers in `.mcp.json` at its root, in the same format:

```json
{
  "mcpServers": {
    "shared-server": { "type": "http", "url": "https://example.com/mcp" }
  }
}
```

Circle reads it only in a [trusted folder](security.md#trusted-folders). Since anyone who can change the repository can change it, a server in it connects in an interactive session (the full-screen interface and the desktop application) only once you approved it: Circle asks in the question panel which of the file's servers the project may use, showing all each would run or send as the file writes it — its command and arguments or its address, its `env`, the headers it is sent and its `headersHelper` command — and saying for each `${NAME}` whether your environment or your saved secrets would fill it in, never a value; and keeps your answer for the project in your `settings.json`, as `enabledMcpjsonServers` and `disabledMcpjsonServers` under `projects["<folder>"]`. Until you answer, `/mcp` lists such a server as waiting for your approval; closing the panel decides nothing, in the desktop application too, while choosing none declines them all, and `/mcp reconnect <name>` asks again, also for a server you declined. `enableAllProjectMcpServers: true`, and `enabledMcpjsonServers` or `disabledMcpjsonServers` at the top of your `settings.json`, answer for every project. In [print mode, line mode](cli.md#print-mode) and [RPC mode](rpc.md), where no one can be asked, the file's servers connect unless you declined them.

### Variables in an entry

A server's `command`, `args`, `env`, `url` and `headers` can name a value as `${NAME}`, or as `${NAME:-default}`:

- `${NAME}` is the variable `NAME` of the environment Circle was started in, or else the [secret](security.md#secrets-by-name) saved as `NAME` (save one with `/secrets NAME`, or in the desktop settings under **variables & secrets** → **secrets**), so a token need not be written into a file.
- `${NAME:-default}` is the same, or `default` when neither is set. A variable set to the empty string is set.
- `${secret:NAME}` is the secret saved as `NAME` alone, never a variable of the environment, as Circle has always read it. A secret you name so is sent whatever its name, also one of the names below that a remote server never gets from the environment.
- A name that is neither, without a default, stays as written, and `/mcp` warns which field names it, as `warning: headers.Authorization names ${DOCS_TOKEN}, which is not set`.

A remote server's `url` and `headers` never get the credentials of Circle's own model connection or a common provider's from the environment, whatever an entry names: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `AZURE_OPENAI_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `HTTP_PROXY`, `HTTPS_PROXY` and `NPM_TOKEN` read as empty there, and a default is not used. To give a server such a value, save it as a secret under a name of your own.

Circle puts the values in each time it connects: a secret saved or changed later is used from the next `/mcp reconnect`. A header name that is not a valid token, or a value with a line break, stops that server before any request, and `/mcp` names the header, never a value. `/mcp` shows a server's command line or address as written, with its references, not their values.

`/mcp` lists the names of the headers a server is sent, not their values. Where a server's answer, error, instructions or tool description quotes a secret value Circle put in, Circle shows its reference in its place: `%NAME%` for a saved secret, and `${NAME}` for an environment variable whose name looks secret, by the rule of [the shell environment](security.md#the-shell-environment) (`KEY`, `TOKEN`, `SECRET`, `PASSWORD` and the like), or that goes into `Authorization`, `Proxy-Authorization` or a header whose name looks secret by the same rule, such as `X-Api-Key`. That holds in what the model reads, in the conversation, and in the server's status that `/mcp` and the desktop show. Such a value is replaced wherever it stands, also inside a longer word or number, as a secret's value is in other tool output (see [Known issues](known-issues.md#desktop-application)). Any other environment variable's value, such as a region or an API version, is no secret and is not replaced, and neither is a value written into an entry as it is, without a reference. Where a server quotes a file it was sent and a secret value lies inside that file's encoding, the model reads the file's path, size and digest, not the encoding.

### Headers from a command

`headersHelper` is a command for headers made at connection time, such as a short-lived token:

```json
"internal-api": {
  "type": "http",
  "url": "https://mcp.internal.example.com",
  "headersHelper": "/opt/bin/get-mcp-auth-headers.sh"
}
```

Circle runs it in a shell each time it connects the server, and stops it after 10 seconds. It must print a JSON object of header names and text values, which are sent over the entry's own `headers` of the same names. It runs in the project's folder for a server of `.mcp.json` or of the project in your `settings.json`, and in the data folder for yours, and gets `CIRCLE_MCP_SERVER_NAME` and `CIRCLE_MCP_SERVER_URL`. A helper of `.mcp.json` gets your environment without the variables whose names look secret, since you did not write it. A helper of a project's server runs only in a trusted folder; in another, the server is reached with its own `headers` and `/mcp` says the helper was not run. Its values are never shown: where the server quotes one back, its header's name stands in its place.

### Moved from mcp_servers

Releases before this one kept servers in `mcp_servers`, a list in `settings.json`. The first time a release with `mcpServers` starts, it moves the list into `mcpServers`, keeps a copy of the file as it was as `settings.json.mcp_servers.migrated` beside it, and does not read the list again; `/mcp` says what it did until Circle is started again. An entry is named by its `name`, else its `id`; its `transport` becomes `type` (`streamable_http` is `http`, `websocket` is `ws`, and any other or none `sse`, as it was read); `${env:NAME}` in its headers becomes `${NAME}`, which reads the environment first and then the saved secrets, and `${secret:NAME}` stays as it is, reading the saved secret alone; and `enabled`, `max_file_bytes` and `placeholders` stay; `trust_annotations` is left out, since what a server says of its tools no longer decides whether a call asks. Of two entries with one name the later stays, as it was the one connected; an entry with neither a command nor a url is left out, as it was never connected. A file still in the old format that Circle saves for another reason is moved first, in the same way.

### Signing in to a server

A server reached by `url` over `http` or `sse` that answers that it needs a sign-in, by the MCP authorization (OAuth 2.1 with PKCE), is signed in to in the system browser, or in the desktop application in its browser panel beside the conversation, also when the sign-in starts before the window has loaded. Circle finds the server's sign-in service from its answer, registers itself there as `Circle on <this computer's name>`, and opens the sign-in page; `/mcp` shows `waiting for sign-in in the browser` with the page's address, in case no browser opens. Other servers connect meanwhile. The browser comes back to Circle on a `127.0.0.1` address; Circle checks that it brings back the state of this sign-in, exchanges the code for tokens, connects the server and offers its tools. If no sign-in comes back within ten minutes, or the server refuses it, `/mcp` says why.

A server whose authorization server offers the device code (RFC 8628: a `device_authorization_endpoint` and the grant `urn:ietf:params:oauth:grant-type:device_code` in its metadata) is signed in to by code instead, so nothing has to come back to this machine. Circle registers asking for that grant too, asks the server for a code, and `/mcp` shows `enter the code XXXX-XXXX on the sign-in page:` with the page, which opens as the browser sign-in's does, with the code filled in when the server gives such an address. Circle then asks the server at the interval it names, five seconds longer after each `slow_down`, until a person approved or refused the code on that page, for at most the code's lifetime and never more than 30 minutes. A server that gives no code is signed in to in the browser. A refused or expired code shows as `sign-in failed: …`; `/mcp reconnect` starts a new sign-in.

The registration and the tokens are kept per server in `mcp-auth.json` in Circle's home, readable by you only, so the next start connects without a sign-in. A server that stops taking its token is signed in to again at the next connection. An entry whose `headers` send a credential, such as `Authorization` or a header whose name looks secret, is never signed in to: its header is used as written.

## What you get

Each tool is offered to the model as `mcp__<name>__<tool>`, for example `mcp__memory__create_entities`; a [permission rule](security.md#rules-in-a-file) and a [hook](hooks.md)'s matcher name it so. Circle connects when the full-screen interface starts or the desktop application opens a trusted folder, and again on `/reload`, `/mcp reload` and `/extensions reload`. In [print mode, line mode](cli.md#print-mode) and [RPC mode](rpc.md) it connects only with `--extensions`, before the first prompt. It connects the servers side by side and waits up to 30 seconds for each (`CIRCLE_MCP_TIMEOUT`, in milliseconds, changes that). A server reached over `http` or `sse` whose first connection fails in a way that may pass — a 5xx answer, a refused connection, a connect timeout — is tried three more times, 1, 2 and 4 seconds apart; a program, a `ws` server, an authorization or not-found answer, and a server that used up its 30 seconds are not. Listing a server's tools that fails with a 5xx or a refused connection is tried three more times too. A server that fails is listed by `/mcp` with the reason, and the other servers' tools still load.

A server that declares its tools can change (`tools.listChanged`) is listed again when it sends `notifications/tools/list_changed`, 300 ms after its last such notice, so several in a row list it once. Its tools are replaced together with the results kept for it: the next turn offers the tools it lists now, and a turn under way keeps the ones it started with. When that listing fails, the earlier tools stay, and `/mcp` and the desktop show `the server changed its tools and listing them again failed; the earlier tools stay until a reload` until a later listing succeeds. A server that declares nothing is listed only when Circle connects, as before, and again when it is reconnected: `/mcp reload`, or `/mcp reload <name>` for it alone.

Circle speaks MCP up to the 2025-11-25 revision, the newest its MCP library can negotiate. The 2026-07-28 revision's `ttlMs`, which tells a client how long a list stays good, comes with a library that speaks that revision.

A server can tell its clients how to use its tools, in the instructions it sends when Circle connects. Circle adds them to the model's system prompt in a section of their own for each server, headed "Instructions from MCP server <name>", which says they are the server's words and not yours: where they differ from what you ask, from your or the project's instructions, or from the rest of the prompt, those come first. Circle takes the first 8 KiB of each server's instructions and marks where it cut, keeps line breaks and tabs, takes out other control characters and the bidirectional-text controls, and writes each `<` in them as `&lt;` (and says so in the section), so no tag in them can end the section or pass for a part of the prompt. A server that is not connected, or sent none, has no section. They are read again on every connect, so `/mcp reload` brings changed instructions in. When a program Circle started for a server exits, its section leaves the prompt from the next turn. In the full-screen interface and the desktop application the server is then failed, and `/mcp` says so, until `/mcp reconnect <name>` starts it again; in print, line and RPC mode the next call to one of its tools starts it again. A `ws` server whose connection closes is connected again in the background, after 1, 2, 4, 8 and 16 seconds, five tries in all, and `/mcp` shows it reconnecting; a call meanwhile waits for it. After the fifth try it is failed until `/mcp reconnect`. An `http` or `sse` server is not watched between requests: a request that finds it gone is handled as the table below says.

Every request to an `http` or `sse` server carries a `Circle-Session-Id` header with the id of the Circle session at that moment, which changes when you start or switch sessions (as RPC `new_session` does). The requests of a tool call carry the conversation's session, also when a subagent made the call, and then a `Circle-Agent-Id` header with the subagent's own session: the values the call's hooks get as `session_id` and `agent_id`. The requests of each tool call, the cancellation `esc` sends included, also carry a W3C `traceparent` header, `00-<trace id>-<parent id>-01`, with a new random trace id for every call. A server can use them to group what one session did and to tell calls apart in its logs. Circle sets all three itself: a configured header of any of these names, in any letter case, is not sent and its value is not filled in, so a secret or variable it names need not exist, and `/mcp` lists it as not sent. A `ws` server and a program started for a server get none of them. Circle has sent `Circle-Session-Id` and `traceparent` since 1.13.0; an install of 1.12.0 or older sends neither, headless runs included.

A tool call may take about 28 hours (100,000,000 ms) unless the server's entry gives a `timeout` in milliseconds (1000 or more; less is not read) or `CIRCLE_MCP_TOOL_TIMEOUT` gives another; progress does not extend it. A call also ends when the server sends neither an answer nor a progress notice for 5 minutes, for a server reached over the network, or 30 minutes, for a program: each progress notice starts that wait again, and a server's own `timeout` is the least it can be. `CIRCLE_MCP_TOOL_IDLE_TIMEOUT` changes it, in milliseconds, and `0` turns it off. `esc` sends the server a cancellation; what the server does with it is up to the server. Images and PDFs a tool returns go to the model as attachments.

### When a call's connection fails

Circle tells a request that never left this machine from one that may have reached the server, and the model reads which it was:

| What happened                                                                                                                                                                                                                           | What Circle does                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nothing was sent: the connection was refused, the name did not resolve, the host or network could not be reached, or connecting timed out (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`, a connect timeout). | Sends it again after 0.5, 1 and 2 seconds, four tries in all. When the last fails too, the model reads `<server> could not be reached in 4 tries: the request was not sent`.                                                                                                                                                                                                                                                                     |
| The connection ended after the request was sent: the program exited, the connection was cut or reset, or the event stream the answer was to come on ended without it.                                                                   | Sends the call once more, only when the server says the tool is read-only (`readOnlyHint`) or idempotent (`idempotentHint`). Any other call is not sent again, and the model reads `the connection to <server> closed before the call was answered: the tool may have run, so Circle did not send it again; check whether it did before calling it again`. The call goes once more on the server's connection while that is still open, as an HTTP one is when only that request's socket was cut, so the other calls on it go on; otherwise on a new one. |
| The connection ended between calls, as when the program Circle started for the server exited or a `ws` connection closed.                                                                                                                   | The next call to one of its tools connects the server again first, and then sends it: nothing was sent on the connection that ended. Calls that find it ended at the same time connect it once. A `ws` server is already being connected again in the background, and the call waits for that; a program that exited in the full-screen interface or the desktop is not started again by a call: the model reads `the program of <server> exited; /mcp reconnect <server> starts it again`.                                                                                                                                                                                                                                                                                                             |
| An `http` server answered 404 to a request that named its session: it forgot the session, as after a restart.                                                                                                           | Starts a new session and sends the call once more, whatever the server says of the tool: the server refused the request, so it did not run it. A second 404 is the model's to read. A 404 to a request that follows a task the call made (`tasks/get`, `tasks/result`) is not sent again: the task may have run, and the model reads `the server lost the session while task <id> was running: the tool may have run, so check whether it did before calling it again`. |

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

A server can ask you for input in the middle of a call (`elicitation/create`), with a form, where it names the fields it wants, or by asking you to open a page, as a sign-in does. Circle says it takes both when it connects (`elicitation: {form: {}, url: {}}`).

The question panel the [`question` tool](tools.md) uses shows a form, headed by the server's name. The first question is the server's message, then a question follows for each field and a last one asks whether to send the answers:

- **Yes or no** is chosen from `yes` and `no`.
- **A list of values** is chosen from (`enum`, or `oneOf` with titles), and a list of several (an `array` of them) takes more than one.
- **Text and numbers** are typed. A number must be one, a whole number when the server asks for one, and inside its bounds. Text must be of the length and kind the server asks for: an email address, an address (`uri`), a date or a date and time.
- **An optional field** says `(optional)` and can be left empty. A field with a default says what an empty answer gives (`empty: …`).

When an answer does not fit, the panel comes back saying what was wrong (`Not sent: …`), and nothing reaches the server until the answers fit.

A page to open is asked about first: the panel shows the server's message and the address, and asks `open` or `decline`. Only `open` opens it, in the system browser or the desktop's browser panel, and the server is told you accepted; an address that is not `http` or `https` is declined without asking. The server gets:

| What you do                     | What the server gets                                       |
| ------------------------------- | ---------------------------------------------------------- |
| Answer **send** (or **accept**), or **open** a page | `accept`, with the answers as the values its form asks for |
| Answer **decline**              | `decline`                                                  |
| Close the panel                 | `cancel`                                                   |
| Press `esc` on the call         | `cancel`                                                   |

[Hooks](hooks.md) can answer for you: an `Elicitation` hook, whose matcher is the server's name, runs before you are asked and can accept with values, decline or cancel, and an `ElicitationResult` hook runs after you answered and can change or block the answer. The server can also take its question back. A question that came on a stream of the server's own, as a program's questions do, is withdrawn once none of that server's calls is under way, so `esc` on the only call closes it. In print, JSON, line and RPC mode no one can be asked: a question no hook answers is cancelled. A task that needs input (`input_required`) asks this way while Circle reads its result. The 2026-07-28 revision asks by a result instead (`input_required` with `inputResponses`), and comes with an MCP library that speaks that revision.

### Long calls and large results

A call the conversation makes (not a subagent's) that is still running after 2 minutes goes on as a [background job](background-jobs.md) in the full-screen interface and the desktop application: the model is told the job's id at once and goes on, and reads the call's result in the job's notice when it ends. The job shows the latest progress the server reported, and stopping it cancels the call at the server, which may already have done some of the work. A call the server holds up with an open question moves once the question is answered. The call's time limits still apply. `CIRCLE_MCP_AUTO_BACKGROUND_MS` changes the 2 minutes, in milliseconds; `0` turns it off. In print, line and RPC mode a call stays where it was made until it ends, since the run can end before it does.

A result of a call that ends where it was made, longer than 50,000 characters or than 25,000 tokens (`CIRCLE_MAX_MCP_OUTPUT_TOKENS` changes the tokens), is kept in a file in Circle's data folder, and the model reads `The result of <tool> is too large to give here (<n> characters, about <m> tokens), so it was kept in full in /large_tool_results/<file>.txt` and reads the parts it needs with `read_file`. A result with a picture is given as it is.

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

Both run as reads, without a card, in every mode, as Circle's own reads do.

Both are reads. A server's own tool of the same name keeps the name.

## Files a tool takes

A tool can take a file as an argument: a top-level property of its input that is a JSON Schema string with `"contentEncoding": "base64"` (with or without `contentMediaType`). Circle shows the model that tool with the same schema, except that the property's description says it takes a local file path, and its `pattern`, `format`, `minLength` and `maxLength`, which describe the encoded text, are left out. The model gives a path. Circle reads the file and sends its bytes, base64-encoded, as that argument.

- The path is taken as `read_file` takes it, by the same code: relative to the workspace or absolute, a path with `..` refused, a [credential file](security.md#credential-files) refused by name, and in the desktop application a file outside the workspace only with the grant you gave the conversation. In the desktop application a workspace file is also refused where its `read_file` refuses one: under `.git` or `.circle`, a credential file name in any letter case on macOS and Windows (whose file systems ignore case), and a file with other names on disk (a hard link).
- Only a regular file of at most `max_file_bytes` is sent. A folder, a missing file, a pipe or a larger file is an error the model reads, with no card, and the server is not called.
- The file is read before the approval card, and the call sends the bytes read then: a file changed while the card is up is sent as it was. Rejecting the call sends nothing.
- The approval card shows the path, the size in bytes and the SHA-256 of what is sent, not the bytes, and the result the model reads starts with a line such as `file: sent data/report.pdf (48213 bytes, sha256 9f2c…)`. Where the server's answer or error quotes the encoded file, the model reads that path, size and digest instead. The conversation keeps the path the model gave and that result, never the bytes.
- A call that sends a file asks as any call of the tool does (see [Security](#security)); a rule that allows the tool allows the calls that send files too.
- [Hook](hooks.md) path globs match the path a file parameter names, whatever the parameter is called.

A tool its server marks `idempotentHint` is not called again for the same thing while nothing has changed it since: when the conversation calls it with files of the same contents (compared by SHA-256, whatever their paths) and the same other arguments as an earlier call that succeeded, and no call that may change what the server holds has gone to that server in between, Circle gives the model that earlier result, starting with `cached (same content)`, and the server is not contacted. MCP's hint only says that the same call repeated has no further effect; any other call can change what the result says. So every call Circle sends to a server, of any of its tools that the server does not mark `readOnlyHint` and whether it then succeeds or fails, forgets the results kept for that server, and so does the end of its connection (a program Circle started that exits). Changes made to the server by anything else, such as another client or the server itself, are not seen: if those can happen, do not rely on a repeated call reaching the server. The call still asks for approval as any other, and its card says, after each file, that it is not sent and the earlier result is given again. Should a call that may change what the server holds reach it while the card is up, the call is not run, nothing is sent, and the model is told to call again. Circle keeps these results in memory for the conversation and its subagents, at most 64 of them and 16 MiB in all, the least recently used going first; a new session starts with none, and reloading the servers forgets them. A failed call is not kept. Calls that send no file, and tools without the hint, always reach the server.

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
| `/mcp reload` | Re-read the settings and reconnect every server. Not while a turn runs.                                                                                                         |
| `/mcp reconnect <name>` (or `/mcp reload <name>`) | Re-read the settings and reconnect that one server, listing its tools again. The other servers, and the programs started for them, are left as they are. A server no longer configured, or turned off, is closed and its tools go; a server of the project's `.mcp.json` that waits for approval, or that you declined, is asked about again. Not while a turn runs. The desktop's MCP page has **reconnect** on each server for the same. |
| `/mcp reconnect all` | Reconnect every server that failed or waits for a sign-in; the others are left as they are. Not while a turn runs. |

In print mode, line mode and RPC mode MCP servers load only with `--extensions` (`circle --extensions -p "…"`, `circle --mode rpc --extensions`). Closing Circle closes the connections and stops the programs it started.

## Security

An MCP server can be a program that runs with your rights, and its tools can do whatever it does. Circle cannot see what a tool changes, so whether a call asks does not depend on what the server says of the tool:

- In `manual`, `accept-edits` and read-only (plan) mode every call of a server's tool asks, unless a [rule](security.md#rules-in-a-file) in your `approvals.json` allows it: `{"tool": "mcp__docs__search", "effect": "allow"}` for one tool, `mcp__docs__*` (or `mcp__docs`) for every tool of the server `docs`. "Allow for this session" on the card covers every call to that tool. Plan mode asks rather than refusing, also when `auto` is on beneath it.
- In `auto` mode they run without asking, except a call an `ask` rule names and a tool the server marks as below.
- A `deny` rule refuses in every mode, and an `ask` rule asks in every mode.
- In print, line and RPC mode a call that would ask is not run; with `--yolo` the calls that ask in `auto` mode are still not run.

A server marks a tool whose every call a person must approve, such as a consent or access-grant step, with `_meta` `{"circle/requiresUserInteraction": true}` in its `tools/list` entry; only the JSON `true` counts. Its card shows on every call, in `auto` mode too; no rule, setting or hook's allow skips it, the card offers no "allow for this session", and print, line and RPC mode do not run it, `--yolo` or not.

What a server says of its tools in their annotations still counts for the rest, and only a value of `true` does:

- `readOnlyHint` (and not also `destructiveHint`): the calls of one reply to such tools run side by side, and a call cut off after it was sent is sent once more ([When a call's connection fails](#when-a-calls-connection-fails)).
- `idempotentHint`: such a call is sent once more as well, and [a call that sends files](#files-a-tool-takes) may get an earlier result again.

Only add servers you trust. See [Security](security.md).

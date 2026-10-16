---
nav_order: 15
---

# Build extensions

An extension is a JavaScript or TypeScript module that adds to Circle without changing Circle itself. It can register tools, slash commands, middleware, subagents, and renderers for tool results, and it can react to events.

Extensions run inside the Circle process with your full user rights. Install only extensions you wrote or have read.

## Write one

Each extension is a folder with an `extension.mjs`, `extension.js` or `extension.ts` that exports a `register(api)` function:

```js
// ~/.circle/extensions/sample/extension.mjs
export function register(api) {
  const schema = {
    type: 'object',
    properties: { why: { type: 'string' }, x: { type: 'integer' } },
  };

  // An object is sent to the model as JSON.
  api.registerTool('echo_ro', 'Echo the arguments back. Read-only.', schema,
    (args) => ({ ok: true, echo: args }), { readOnly: true });
  api.registerTool('always_fails', 'Fails on purpose.', schema,
    (args) => { throw new api.ToolError('boom: ' + (args.why ?? '')); }, { readOnly: true });
  api.registerTool('writer', 'Changes something.', schema, () => 'written');
  api.registerCommand('hello', 'Say hello', (args, ctx) => ctx.toast('hello ' + args));
  api.registerRenderer('tool_result:echo_ro', (update) => ['ECHO ' + update.output]);
  api.on('turn_start', (payload) => {});
}
```

Start Circle and run `/extensions`. You should see the extension with its tool and command counts. `/hello world` prints `hello world`.

`register` may be `async`. If a folder has more than one of the three files, `extension.ts` is used first, then `extension.mjs`, then `extension.js`. Write it as an ES module (`export`, `import`). An `extension.ts` is loaded by Node's built-in type stripping: type annotations and interfaces work, but syntax that needs compiling, such as `enum`, `namespace` or constructor parameter properties, does not.

## Where extensions live

| Folder | When it loads |
|---|---|
| Shipped with Circle (`dist/extensions/` in a release) | Only once you turn it on with `/extensions enable <name>` |
| `~/.circle/extensions/<name>/` | Always |
| `<project>/.circle/extensions/<name>/` | When the project is [trusted](security.md#workspace-trust), which it must be for Circle to work in it |

A project extension replaces one of yours with the same name, and yours replaces one shipped with Circle. Folder names use letters, digits, `_` and `-` (up to 64 characters, starting with a letter or digit); other folders, and folders without one of the three files, are skipped without a message.

Extensions are loaded at start, on `/reload` and on `/extensions reload`. Each load reads `extension.*` again, so an edit takes effect; a file it imports itself is not read again until Circle restarts. Extensions are not loaded in print mode, line mode or RPC mode.

To turn one off, set it in `settings.json`, or run `/extensions disable sample`:

```json
"extensions": { "sample": { "enabled": false } }
```

An extension shipped with Circle is off until `"enabled": true`, which `/extensions enable <name>` saves for you. `/extensions` lists it with `off · /extensions enable <name>`.

A folder may have an `extension.json` beside the entry file, `{ "version": "1.2.0", "description": "...", "commands": ["hello"] }`. `/extensions` and the desktop application show the version and description. `commands` names slash commands the folder will register, so a bundled extension that is still off can say `/extensions enable <name>` instead of treating the command as a typo. It is optional, and an unreadable one is ignored.

## An interface in the desktop application

An extension shipped with Circle can have an interface half in the desktop application: a page or panel built into the application under the same name and version. The two are one plugin. The interface shows only while its extension is installed, loaded without error, of the same version and turned on; turning it on or off under **extensions → interface components** turns the extension on or off, saved in `settings.json`, and the card says why it is off. The extension feeds it with `api.setView(data)`, and the page acts by running the extension's own commands, whose lines go to the conversation.

The desktop starts loading integrations for its trusted startup workspace without a prompt or a manual reload. The first window remains available while configured MCP servers connect; discovery failures appear in the runtime status and an explicit reload can retry. An untrusted workspace is not initialized until you trust it. Closing the application cancels pending integration startup, including an extension still registering.

Interfaces are built into the application; an extension cannot add one by itself. The hub extension has five, all paired with it:

| Page | What it shows | What it does |
|---|---|---|
| **hub** | The connection, the tasks handed over from here and their latest lines. | Sign in, follow a task, save its results again. |
| **work** | Tasks the server lets you read: their phase, questions they wait on, approvals bound to an input revision. | Answer a question, approve or reject an open approval. |
| **execution** | Operations the server's workers ran: the worker and the fencing token that held the lease. | Reconcile an operation whose outcome is unknown. |
| **knowledge** | Each task's source, artifacts and evidence by revision and SHA-256, and the server's own read-back check. | Save the results. |
| **methods** | The server's capability packs, at the versions it runs. | Hand a pack a file of the workspace. |

What these pages show is what the server last returned to `/hub refresh`, which also runs after signing in, after a decision and when a followed task ends. The server decides what you may read; nothing on them is kept by Circle.

## Extensions shipped with Circle

### hub

Connects Circle to a [circle-hub](https://github.com/circle-platforms/circle-hub), which keeps work for a team: it takes a task with your files, runs it on its own, and delivers results. Turn it on with `/extensions enable hub`.

This extension's own version is **0.1.0**. That number is the Circle plugin version: the desktop pages pair with it and show only while it matches. It is not the hub server's version. The extension speaks circle-hub **client API 1.0.0**, which **circle-hub 0.2.0** serves. The two version lines are different series; 0.1.0 here does not mean the server is old, and a server 0.2.0 does not mean this extension is behind. The range a client should declare is described in the hub's [compatibility matrix](https://github.com/circle-platforms/circle-hub/blob/main/docs/compatibility.md).

| Command | What it does |
|---|---|
| `/hub` | Where you are signed in: the address, user and scope, and whether a token is held. `/hub help` lists the commands. When the system language is Chinese, every `/hub` reply, error, help line and status word is Simplified Chinese. Commands, ids, paths and the server's own status words stay as the server sent them. |
| `/hub help` | Every `/hub` command, including the bot commands below. |
| `/hub login [url] [user]` | Sign in. With no address, the saved one is used, or `http://127.0.0.1:7410` when nothing is saved. With no user, the saved user is used, or you are asked on a card that is not masked. The password is asked on a masked card (or taken from the desktop hub page) and is not kept; the token the server issues is kept with [`api.secrets`](#secrets). The address is written to `extensions.hub.url` in `settings.json` and to the extension's own config, so the next sign-in can omit it. A program that runs Circle for the server does not write either. |
| `/hub logout` | Revoke the whole token family at the server, then forget the token locally. |
| `/hub packs` | What the server can do, as capability packs. |
| `/hub submit <pack> <file>…` | Upload the file and hand the server the work, then follow it: each event is a line in the conversation, and what it delivers is saved under `tasks/<taskId>/` in the workspace once its SHA-256 matches the server's. The upload sends `x-capability-pack-id`, which the hub checks before it stores the bytes, so an unknown pack does not leave a source behind. Sending the same pack and file again finds the same task; add `--again` for a new one. For the hub's generic execution flow, hand over the flow itself: `/hub submit module-execute <input-json>` with the flow input (`flowId`, `methodPin`, `resources`, `sources`, `value`, `controlledBytes`) and no file. |
| `/hub task <id>` | Show a task and follow it until it ends. Closing Circle does not stop a task; this picks it up again. An event cursor that fell out of the server's retained window restarts at the window. |
| `/hub tasks` | Tasks this window handed over, each with its current phase. `seen to N` is the last event number this window has shown for that task. It is not the count `/hub refresh` prints. |
| `/hub respond <id> <answer>` | Answer a clarification, or replace the bound input when the server marks it `repair`. Anything else, including an approval, is not posted: the server would answer `DECISION_CONFLICT`. The line names `/hub approve` and `/hub inbox`. |
| `/hub get <id>` | Save a delivered task's results again under `tasks/<taskId>/`. A file never overwrites one already there: `cases.xlsx` becomes `cases-1.xlsx`. |
| `/hub refresh` | Read work, execution, knowledge and methods from the server for the pages above. The line counts work tasks (at most 20; tool tasks and index tasks are not in that number) and capability packs. That is not the `/hub tasks` list. |
| `/hub inbox` | Approvals waiting for you. A server with the general queue (`GET /v1/approvals/pending`) lists governance requests and change-sets, each with `/hub show`, `/hub approve` and `/hub reject`. An older server falls back to `GET /v1/tasks?view=page&queue=awaitingMyApproval`. `/hub approve` with no ids prints the same list. |
| `/hub reconcile <id> [op]` | Ask the server to check an operation whose outcome is unknown; only naming the operation reconciles, without it the server explains what is missing. The reply's first line is the heading (`reconcile <id>`, or 核对 when the terminal language is Chinese) and the explanation is the next line. With an operation id it is one line, marked done. It does not turn an unknown outcome into success. |
| `/hub tools` | The server's tools the model can use, read again from the server. |
| `/hub trial start` | Start recording which server tools the model calls, for the trial record a skill pack is sent with. Only the tool names, whether each call worked, and a SHA-256 of its arguments are kept. If that record already has calls that were not pushed, they stay and the command says how many; `/hub trial start --force` drops them and records from now. |
| `/hub skill push <folder> [--outputs a,b]` | Send a skill pack: the folder's `skillpack.json`, its `SKILL.md` and other files (not hidden ones, not `node_modules`), with the trial record and the SHA-256 of the output files. `skillpack.json` `outputs` is required (at least one file the pack produces). The trial's tool-call record may be empty. `--outputs` names the trial files and, when left out, defaults to that manifest list; a missing manifest file is reported here instead of as a raw server error. `--outputs` with no file list is an error and does not take the folder as that list. The manifest must also include `id`, `version`, `title`, `owner`, `tools`, `triggers` (`manual`, `schedule` or `event`), `inputs` (an object) and `model`; that is what circle-hub's client API 1.0.0 accepts. The server checks the record against the tools the pack declares and keeps the pack for approval. The reply's `approvalTaskId` is not the approval id. The next line reads the open approval and prints `/hub approve <task> <approval>`. |
| `/hub skill list` | The skill packs on the server. A pack that carries `statusLabel` and `lifecycle` (circle-hub after the connection review) is shown with those words. An older reply that has only `status` still reads the asset: `registered` with an approved asset is that lifecycle, with the server's status word beside it. |
| `/hub skill run <id> [json] [--file <path>]…` | Run a skill pack on the server with these inputs, and follow the task. Each `--file` attaches a file of the workspace as `inputs.files`, which the run finds in its own workspace. |
| `/hub bot list` | The bots you can see. Yours include their runs and results that have not been shown yet. |
| `/hub bot every <pack> <1h>` | A bot that runs a skill pack on a schedule. `--from`, `--inputs`, `--file` and `--name` set the start, the inputs, an attached file and the name. |
| `/hub bot on <pack> <source> <event>` | A bot that runs a skill pack when a connector reports that event. |
| `/hub bot approve <bot>` | Approve someone else's bot and its trigger. |
| `/hub bot start <bot>` / `/hub bot stop <bot>` | Turn your approved bot on or off. |
| `/hub bot runs <bot>` | Its runs, and what each one delivered to Circle. |
| `/hub show <id>` | One approval and its content, before you approve it. A number is a row from the last `/hub inbox`. A governance request is read from `GET /v1/approval-requests/<id>` and its content route; text is printed, and other bytes are saved under `.circle/hub-approvals/`. A task id shows the phase and the open approval. On circle-hub 0.2.0 the general routes are missing and the task view is used. |
| `/hub approve <id> [approval]` | With no ids, the inbox. With a task and an approval id, approve that action, bound to the input revision, target identity and action digest the server states. A governance request id is `POST /v1/approval-requests/<id>/decisions` when that route exists. Afterwards a task approval reads the asset again. A skill pack stays `registered` on the server once the approval has landed; that word is not "still waiting". The line shows the asset lifecycle (`approved`) next to it. |
| `/hub reject <id> <approval> <reason>` | Decline, and the reason is required. It is sent as `reason` on the task approval and on a governance decision. A governance request is `/hub reject <id> <reason>`. A server without the general route keeps the task approval. |
| `/hub review` | The same list as `/hub inbox`. circle-hub 0.2.0 has no browser page for this queue. A knowledge claim is still one id: `GET /v1/knowledge/reviews/<id>`. |
| `/hub audit` | The latest audit rows from `GET /v1/admin/audit`. That route needs `admin.manage`. There is no browser page. `--format json` or `csv`, with `--timezone`, `--action`, `--principal`, `--since` and `--until`, calls `GET /v1/admin/audit/export` when the server has it. |
| `/hub modules` | Skill packs and the assets a module install creates (`GET /v1/skillpacks`, `GET /v1/assets`). There is no `GET /v1/modules` and no browser page. Installing a module stays the server CLI: `node apps/server/src/cli.ts modules install`. |

**When a program runs Circle for the server.** hub's own runner starts Circle without a person, as `circle --mode rpc --extensions`, and hands over the address and a short-lived token in the environment: `CIRCLE_HUB_URL` and `CIRCLE_HUB_TOKEN` (with `CIRCLE_HUB_USER` and `CIRCLE_HUB_SCOPE` if it has them). The extension then reads the server's tools before the first prompt, writes nothing to disk, and does not ask for a password when the token is turned down; `/hub login` and `/hub logout` are refused.

The address can also be set in `settings.json` as `"extensions": { "hub": { "enabled": true, "url": "http://127.0.0.1:7410" } }`. Signing in writes that `url` as well. The desktop hub page starts from it, or from `http://127.0.0.1:7410` when it is empty, and asks for the password on the page. The lines the commands write are notices for you; the model does not see them.

A server error is named and says what to do next: a bad password says to sign in again, a missing id says to check it, and a skill pack the server will not accept names the fields (`INVALID_PAYLOAD`) or the tools the trial used (`SKILLPACK_CHECK_FAILED`). `DECISION_CONFLICT` says whether the task was not waiting for that answer or the decision was already recorded, and which command to use. `/hub tools` after `/hub logout` says you are not signed in. A server you are signed in to that publishes no tool catalog still says it offers no tools.

**The server's own tools.** A server that publishes a tool catalog (`GET /v1/tools`) has its tools offered to the model once you sign in, each as `hub_tool_<name>`, for example `hub_tool_docs_list` for the server's `docs.list`. The server decides which tools you get. A tool that only reads runs without asking. A tool the catalog marks `approval: true` asks first, and so does a write when the catalog omits that flag. A write the catalog marks `approval: false` runs as the signed-in person and does not raise a card for every call. One the server runs as a task is waited for in the background. The list is read again on `/hub refresh`, `/hub tools` and when a session starts, and the model sees changes from its next turn. Signing out removes them. A server without a catalog offers none.

A tool that returns at once also writes the response, exactly as the server sent it, under `.circle/hub-returns/` in the workspace (`<time>-<n>-<tool>.json`, with the tool name, the arguments and the response). The tool result names that path as `savedAs`. The folder is for citing or checking the bytes; it is not sent back to the server. Circle creates it on the first such call. A permission card wraps a long tool name and marks a cut argument (`… (N more characters)`) instead of ending the text in the middle. A short card keeps the start and the end of a command and folds the diff first.

When the process language is Chinese, hub requests send `Accept-Language: zh`. A server error's `messageZh` is what the reply shows; with that header the server's `message` is already Chinese and `messageEn` keeps the English.

It also gives the model tools of its own, so you can ask in words: `hub_packs`, `hub_task`, `hub_evidence` and `hub_source_artifact_status` only read, while `hub_submit` (a pack and a file in the workspace, or the flow input for `module-execute`), `hub_skill_push` and `hub_source_artifact` ask first, since they send files and write results. `hub_submit` returns at once and waits as a [background job](background-jobs.md); when the task is delivered, the results are saved under `tasks/<taskId>/` in the workspace after their SHA-256 is checked, as `/hub submit` does. Sign in with `/hub login` first: the tools never ask for a password themselves, except when the server has signed you out.

Not wired yet: installing modules (`POST /v1/modules/install`), registering providers, submitting a general approval (`POST /v1/approval-requests`) and the notification stream. `/hub inbox`, `/hub show`, `/hub approve` and `/hub reject` use the general queue, content and decision routes when the server has them, and the task approval routes on circle-hub 0.2.0. `/hub modules` and `/hub audit` only list what those HTTP routes already return. circle-hub 0.2.0 does not serve a browser page for them. Role changes and audit export are the same: the client calls them when the route exists.

## Coming from 0.5.0

Circle 0.5.0 and older loaded `extension.py`. This version does not run Python, and a folder with only an `extension.py` is skipped. Rewrite the extension as `extension.mjs` or `extension.ts`:

| 0.5.0 | Now |
|---|---|
| `register_tool(name, description, parameters, execute, read_only=…, approval=…)` | `registerTool(name, description, parameters, execute, { readOnly, approval })` |
| `register_command(name, description, handler)` with `ctx.send_user_message` | `registerCommand(name, description, handler)` with `ctx.sendUserMessage` |
| `register_middleware(middleware, slot)` with LangChain middleware | `registerMiddleware(handler, slot)` with a plain function, see [Middleware](#middleware) |
| `register_subagent(spec, tools)`, where `tools` named only extra tools | `registerSubagent(spec, tools)`, where `tools` is the whole list |
| `register_renderer(kind, renderer)` with `update.tool_output`, `update.is_error` | `registerRenderer(kind, renderer)` with `update.output`, `update.status` |
| `api.Watch(title, poll, interval_s=…, …)` | `new api.Watch(title, poll, { interval_s, … })`, and `poll` gets a cancel signal |

## The `api` object

| Member | Purpose |
|---|---|
| `api.name` | The extension's folder name. |
| `api.ToolError` | Throw it from a tool to report a failed call to the model. |
| `api.Watch` | `new api.Watch(title, poll, options)`: return it from a tool to have Circle wait for something slow. See [Waiting for something slow](#waiting-for-something-slow). |
| `api.setStatus(text, lamp)` | One line at the right of the footer while it holds, such as what the extension is connected to. `lamp` is `running` (yellow), `ok` (green), `error` (red), `wait` (cyan) or `none`. The text is one line of up to 60 characters, with [secrets](#secrets) masked; `null` removes it. The terminal shows it at the right of the footer; the desktop application, above the footer of its sidebar. |
| `api.openUrl(url)` | Open an `http` or `https` address. The terminal opens it in the system's browser, passed to the system's opener as one argument and never through a shell. The desktop application opens it in its own browser panel, beside the session; with that panel turned off, or no window, the system's browser opens it. An address with a user name or password, or of another kind, is refused. |
| `api.setView(data)` | Publish data for the extension's own [interface in the desktop application](#an-interface-in-the-desktop-application): JSON only, up to 64 KB, with [secrets](#secrets) masked. `null` removes it. |
| `api.workspace` | The folder Circle works in, for a tool that reads or saves the user's files there. |
| `api.settings` | A copy of the extension's own entry under `extensions` in `settings.json`, as it was when the extension loaded, such as `{ "enabled": true, "url": "…" }`. Changing the copy saves nothing. |
| `api.saveSettings(patch)` | Merge keys into that entry on disk and into the running copy. `enabled` is left as it is unless the patch sets it. |
| `api.conceal(value)` | Hide a value in status and views, the way a secret from `askSecret` is hidden. |
| `api.dataDir` | A folder of the extension's own, `~/.circle/extension_data/<name>/` (`0700`), made the first time it is read. For what the extension keeps that is not secret. |
| `api.secrets` | Values the extension keeps between runs, such as a token. See [Secrets](#secrets). |
| `api.askSecret(question, options)` | Ask you for a value on a masked card; it goes back to the extension only. See [Secrets](#secrets). |
| `api.signal` | An `AbortSignal` that fires when Circle closes the extension: when Circle leaves, and before extensions are loaded again. Pass it to requests and timers, and end loops on it. |
| `api.background(promise)` | Work that goes on after a tool or command returned, such as following something until it ends. Circle waits for it when it closes the extension, after `api.signal` fired, for up to two seconds; an error in it is shown under the extension in `/extensions`. |
| `registerTool(name, description, parameters, execute, options)` | Add a tool. It can also be called later, for example once a service tells the extension what it offers: the model gets the tool from its next turn, never in the middle of one. |
| `unregisterTool(name)` | Remove a tool this extension added; returns `false` if it has none of that name. The model stops seeing it from its next turn. |
| `registerCommand(name, description, handler)` | Add a slash command. |
| `registerMiddleware(handler, slot)` | Wrap model calls or tool calls. `slot` defaults to `tool_boundary`. |
| `registerSubagent(spec, tools)` | Add a subagent for `task`. |
| `registerRenderer('tool_result:<tool>', renderer)` | Change how a tool's result is shown. |
| `on(event, handler)` | React to `session_start`, `turn_start`, `turn_end` or `tool_result`. |

Any error while an extension loads (a bad name, a duplicate, an exception in `register`) turns that one extension off, removes everything it registered, and shows the reason in `/extensions`. Other extensions are not affected.

### Tools

- `name` uses letters, digits, `_` and `-`, up to 64 characters. It must not be one of Circle's built-in tools, an MCP tool, an earlier extension's tool, or another tool of your own.
- `parameters` is a JSON Schema object (`"type": "object"`). A call whose arguments do not fit it is refused before your code runs.
- `execute(args, context)` gets the arguments as an object and a context with `signal` (an `AbortSignal` that fires when the user presses `esc`), `sessionId` and `emitAttachments(items)`. It may be `async`. A string result is returned as is. Anything else is sent as JSON. Throw `api.ToolError('message')` to report failure; any other exception is reported to the model too, with secrets removed.
- `context.emitAttachments(items)` sends images or PDFs with the result. Each item has `kind` (`image` or `document`), `mime_type` (`image/png`, `image/jpeg`, `image/gif`, `image/webp` or `application/pdf`), `filename`, base64 `data` and the SHA-256 of the bytes as `sha256`. Items are checked and copied; a call that fails or is stopped sends none.
- The description is listed in the system prompt with the tool's name, and is the tool's description.
- `options.readOnly: true` marks a tool that changes nothing: it never asks and keeps working in `read-only` mode. Any other tool asks first, unless `options.approval` is `false`, and is refused in `read-only` mode. "Allow for this session" on its card covers every call to that tool.

### Waiting for something slow

A tool that starts something slow (a run on another machine, a sign-in the user finishes in a browser) can return an `api.Watch` instead of making the model call it again or `sleep`:

```js
api.registerTool('submit_run', 'Start a run and wait for it.', schema, async (args) => {
  const task = await startRun(args.case);
  return new api.Watch(`run ${args.case}`, async (signal) => {
    const status = await checkRun(task, { signal });
    return status.state === 'finished' ? status : null;
  }, { interval_s: 10, deadline_s: 2400, result: { task, state: 'pending' } });
});
```

- The tool call returns at once with `result` (text, or an object sent as JSON) and a note that Circle is watching it as a [background job](background-jobs.md).
- Circle calls `poll(signal)` every `interval_s` seconds (10 by default), off the model's turns. `null` or `undefined` means not yet. Any other value ends the job with that value as its result, and the model gets a notice with it (the last 4 KB; the whole result is in the job's output file). An exception, or `deadline_s` passing (3600 by default), fails the job.
- `signal` fires when the watch is stopped; pass it on to your requests. A `poll` that blocks without awaiting blocks all of Circle.
- `on_stop()` runs once if the job is stopped: by the model's `stop_job`, by `/jobs`, or because Circle is leaving, which waits up to two seconds for it.
- `poll` runs without asking again: the tool call that returned the watch was approved, or needed no approval.
- Watches count toward the 16 jobs that may run at once. A watch started by a subagent belongs to the conversation the subagent works for. Without a job list (an embedding that builds the agent itself), the tool call waits for the result instead.

### Secrets

An extension that signs in somewhere needs to keep a token, and sometimes to ask you for one.

- `await api.secrets.set(name, value)` keeps a value, `await api.secrets.get(name)` returns it (or `undefined`), `await api.secrets.delete(name)` removes it and says whether there was one, and `await api.secrets.names()` lists the names. A name uses letters, digits, `_`, `.` and `-`, up to 64 characters; a value is a non-empty string of up to 4096 bytes without NUL.
- Each extension's values are in `~/.circle/extension_secrets/<extension>.secrets.json`, readable only by you (`0600`, in a `0700` folder). They are not in `settings.json` or `credentials.json`, another extension's `api.secrets` does not see them, and `*.secrets.json` is a [credential file](security.md#credential-files) name, so the model's file tools and commands refuse it.
- `await api.askSecret(question, { mask, signal })` shows the card a secret question from the model shows (`alt+k` in the terminal, a card in the desktop application), saying the value goes to your extension. The value is returned to the extension and goes nowhere else: not into the conversation, the session or a file. It returns `null` when you cancel or enter nothing within ten minutes. `signal` stops it, and so does Circle closing the extension, which the extension sees as an error; `mask: false` shows what you type. It throws where no card can be shown.
- Values that passed through `api.secrets` or `api.askSecret` are replaced with `***` in what the extension hands Circle: tool results and errors, watch results, and the text of `ctx.toast`, `ctx.append` and `ctx.sendUserMessage`. Values shorter than four characters are left. This guards against accidents only: an extension runs with your rights and can still send a value anywhere.

### Commands

- `name` uses lowercase letters, digits, `_` and `-`, up to 32 characters, starting with a letter or digit, and must not be a built-in command or alias, a custom command, or another extension's.
- `handler(args, ctx)` gets the argument text and a context with `ctx.workspace`, `ctx.toast(text)` and `ctx.append(text)` (a line in the conversation that the model does not see), and `ctx.sendUserMessage(text)` (send a message as if you had typed it). It may be `async`. Something it starts and does not wait for, such as following a task after the command returned, goes to `api.background(promise)`, so that Circle can wait for it when it leaves.
- Extension commands do not run while a turn is running, are listed in `/help`, and are completed in the command list. An exception in the handler shows as `✖ /name failed: …`.

### Middleware

| Slot | Handler | What it can do |
|---|---|---|
| `model_call` | `async (request, next) => response` | Change the request (`request.system`, `request.messages`, `request.tools`) before calling `next(request)`, or change what it returns. |
| `tool_boundary` | `async (invocation, next) => text` | Run code around a tool call, after it was approved, and change the text it returns. `invocation` has `tool`, `args` and `context`; passing a different tool, arguments or context to `next` is refused. |
| `after_model` | `(response, request) => response \| undefined` | Look at each response; return a new one to replace it. |

Handlers of one slot run in the order they were registered, the first outermost. They apply to the main agent and its subagents.

### Subagents

`spec` is an object with a non-empty `name`, `description` and `system_prompt`, and an optional `model`, a model id on the same endpoint. `name` uses letters, digits, `_` and `-`. A subagent with the name of a built-in one (`general-purpose`, `explore`) or an earlier extension's replaces it.

`tools` lists the tools it gets, by name: built-in tools, MCP tools and extension tools. It gets exactly those, never `task`, `compact_conversation`, `plan_enter` or `plan_exit`. A name that does not exist skips that subagent, and `/extensions` says so. Its calls ask for approval like any other, and its system prompt is yours followed by the main agent's.

### Renderers

`renderer(update)` gets an object with `tool_name`, `tool_call_id`, `status` (`success` or `error`) and `output` (a string), and returns a list of lines. They replace the default result lines for that tool in the conversation. If it throws, or does not return a list of strings, the default is used and a red line says so. If two extensions register a renderer for the same tool, the first one loaded wins.

### Events

| Event | Payload |
|---|---|
| `session_start` | `{ workspace, session_id }`. Fires when extensions load (start, `/reload`, `/extensions reload`), and after `/new` and `/import`. |
| `turn_start` | `{ message, session_id }`. A turn Circle started for finished [background jobs](background-jobs.md) has no `message`. |
| `turn_end` | `{ answer, session_id, usage }`. Not sent for a turn that failed or was stopped. |
| `tool_result` | `{ id, name, status, output, session_id }`. |

Subagents' turns and tool results fire the same events. Handlers may be `async`. An exception is shown under the extension in `/extensions` and does not stop anything.

## Commands

| Command | What it does |
|---|---|
| `/extensions` (`/ext`) | List extensions with their tool and command counts, load errors and handler errors. |
| `/extensions reload` | Re-read settings, reconnect MCP servers and reload every extension. Not while a turn runs. |
| `/extensions enable <name>`, `/extensions disable <name>` | Save `enabled` for that extension in `settings.json` and reload, so the choice holds in later sessions too. Not while a turn runs. |

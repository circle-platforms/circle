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

Extensions are loaded at start, on `/reload` and on `/extensions reload`. Each load reads `extension.*` again, so an edit takes effect; a file it imports itself is not read again until Circle restarts. In print mode, line mode and RPC mode extensions load only with `--extensions` (`circle --extensions -p "…"`, `circle --mode rpc --extensions`), before the first prompt, together with the [MCP servers](mcp.md).

An extension is gone once its folder is: you deleted it, or a Circle release no longer ships it. What it kept stays, and Circle neither reads, lists nor deletes it: its entry under `extensions` in `settings.json`, its [secrets](#secrets) in `~/.circle/extension_secrets/<name>.secrets.json` and its folder `~/.circle/extension_data/<name>/`. `/extensions` and the desktop application list only the extensions that are there. A token kept that way stays valid at the service that issued it: revoke it there, with the extension's own command for it before you remove the extension when it has one, and delete those files yourself.

To turn one off, set it in `settings.json`, or run `/extensions disable sample`:

```json
"extensions": { "sample": { "enabled": false } }
```

An extension shipped with Circle is off until `"enabled": true`, which `/extensions enable <name>` saves for you. `/extensions` lists it with `off · /extensions enable <name>`.

A folder may have an `extension.json` beside the entry file, `{ "version": "1.2.0", "description": "...", "commands": ["hello"] }`. `/extensions` and the desktop application show the version and description. `commands` names slash commands the folder will register, so a bundled extension that is still off can say `/extensions enable <name>` instead of treating the command as a typo. It is optional, and an unreadable one is ignored.

## An interface in the desktop application

An extension shipped with Circle can have an interface half in the desktop application: a page or panel built into the application under the same name and version. Interfaces are built into the application; an extension cannot add one by itself. Each page is switched on by itself under **extensions → interface components**. It shows only while that switch is on and its extension is installed, loaded without error, of the same version and turned on. Turning a page on turns the shared extension on if it was off, and does not turn the other pages on. Turning the last page off turns the extension off. The choice is saved in `settings.json`, and the card says why a page is hidden. The extension feeds the page with `api.setView(data)`, and the page acts by running the extension's own commands. What those commands write shows in the conversation, in the terminal and on the desktop alike. A session that has not loaded the extension yet shows the view and status that another session has already published.

The desktop build compiles each shipped extension to `extension.js` and emits `extension_error.js` beside the runtime worker. The worker and an extension that imports `../../extension_error.js` share that one file, so a failure the host raises is the same error the extension catches. The terminal still loads `extension.ts` by type stripping.

The desktop starts loading integrations for its trusted startup workspace without a prompt or a manual reload. The first window remains available while configured MCP servers connect; discovery failures appear in the runtime status and an explicit reload can retry. An untrusted workspace is not initialized until you trust it. Closing the application cancels pending integration startup, including an extension still registering.

## The `api` object

| Member | Purpose |
|---|---|
| `api.name` | The extension's folder name. |
| `api.ToolError` | Throw it from a tool to report a failed call to the model. |
| `api.Watch` | `new api.Watch(title, poll, options)`: return it from a tool to have Circle wait for something slow. See [Waiting for something slow](#waiting-for-something-slow). |
| `api.setStatus(text, lamp)` | One line at the right of the footer while it holds, such as what the extension is connected to. `lamp` is `running` (yellow), `ok` (green), `error` (red), `wait` (cyan) or `none`. The text is one line of up to 60 characters, with [secrets](#secrets) masked; `null` removes it. The terminal shows it at the right of the footer; the desktop application, above the footer of its sidebar. |
| `api.openUrl(url)` | Open an `http` or `https` address. The terminal opens it in the system's browser, passed to the system's opener as one argument and never through a shell. The desktop application opens it in its own browser, beside the session, or in the browser's window when the browser is in [a window of its own](desktop.md#in-a-window-of-its-own); with that browser turned off, or no window, the system's browser opens it. An address with a user name or password, or of another kind, is refused. |
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
| `registerSubagent(spec, tools)` | Add a subagent for `task`. A [subagent file](agents.md) of the same name is replaced by it. |
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
- Extension commands do not run while a turn is running, are listed in `/help`, and are completed in the command list. An exception in the handler shows as `✖ /name failed: …`. On the desktop, the bundled GitHub connection verbs (`status`, `connect`, `configure`, `cancel`, `disconnect`) may still run while a turn is running; they only talk to the connection backend.

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

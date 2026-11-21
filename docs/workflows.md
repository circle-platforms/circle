---
nav_order: 12.45
---

# Workflows

A workflow is a JavaScript script that starts [subagents](agents.md) and decides itself what runs next: which agents, how many, in what order, and what to do with what they return. The model writes one for your task, or runs one that you or a pack saved. Circle runs it in the background as a [background job](background-jobs.md), and the model gets one result when it ends, not every agent's report.

The script format follows Claude Code's workflows, so a script written for them runs here, as far as the parts Circle has go (see [What is not here](#what-is-not-here)).

## Ask for one

Say so in your message: "use a workflow to audit every route handler under `src/routes/`, and check each finding before you report it". The model writes the script and calls `workflow` with it. To run a saved one, name it: "run the release-audit workflow on 1.18.0". The model starts a workflow only when you ask for one or name a saved one; otherwise it works as before, by itself or with `task`.

The call returns at once. The conversation shows `⎿ in background · j3`, and the model is told the run's id and where its script is. When the run ends, its result reaches the model as a background-job notice, and starts a turn if nothing else runs, as any job's notice does.

## Approve the run

Before a run starts, the card shows the workflow's name and description, its phases, where the script comes from (a saved file, a path, or written in the call), the `args` it is given, and the first 40 lines of the script. It offers to allow it once or to reject it. A workflow run by its name, saved or from a pack, can also be allowed for the rest of the conversation (**Allow the workflow *name* for this session**). A script written in the call is new each time, so no yes covers the next one.

| Mode | When you are asked |
|---|---|
| `manual`, `accept-edits` | before every run, unless you allowed that workflow for this session |
| `auto` | never: the run starts at once |
| read-only (`/plan`) | before every run, in `auto` mode too, unless a rule allows it. A hook's allow alone does not start it. The run's agents work in read-only mode as well, so they read and plan and change nothing |
| print, line and RPC mode (`-p`, `--line`, `--mode rpc`) | never: nobody can answer a card, so a run starts only with an allow rule, a `PreToolUse` hook that allows it, or `--yolo`. In read-only mode only a rule starts it |

A rule in your `approvals.json` decides as it does for any tool:

```json
{ "rules": [
  { "tool": "workflow", "pattern": "*", "effect": "allow" },
  { "tool": "workflow", "pattern": "release-audit", "effect": "allow" }
] }
```

`*` allows every workflow; a name allows that saved workflow when it is run by name, and no script written in the call. A rule that denies `workflow` refuses it in every mode, `auto` included. A `PreToolUse` hook on `workflow` hears the call and can allow, ask or deny it; in read-only mode its allow does not start the run.

The run's agents ask for their own calls as any subagent does: their cards appear while the run goes on, titled with the run's job and the agent's type (`j3 workflow · Bash needs your permission`). To keep a long run from waiting on you, allow the commands its agents need first.

## A script

```js
export const meta = {
  name: 'audit-routes',
  description: 'Audit every route handler for missing auth checks',
  phases: [{ title: 'Find' }, { title: 'Audit' }],
}

phase('Find')
const found = await agent('List every .ts file under src/routes/.', {
  schema: {
    type: 'object',
    required: ['files'],
    properties: { files: { type: 'array', items: { type: 'string' } } },
  },
})

phase('Audit')
const audits = await pipeline(found.files, (file) =>
  agent(`Audit ${file} for missing authentication checks.`, { label: file }),
)

return audits.filter(Boolean)
```

`meta` is the first statement, and a plain literal: no variables, calls, spreads or `${…}`. It needs a `name` (letters, digits, `_` and `-`, up to 64) and a one-line `description`; `phases` lists the titles the script passes to `phase()`, each `{ title, detail, model }` or a bare string, and `whenToUse` says when a saved workflow fits. A phase's `model` is the model of its agents that name none.

The body is plain JavaScript, not TypeScript, run as an async function: it can `await` and `return` at its top level. What it returns is the run's result: a string as it is, anything else as JSON.

| Name | What it is |
|---|---|
| `agent(prompt, options)` | Starts one subagent and resolves to its final text, or, with `schema`, to the object it returned. Resolves to `null` when you stopped the agent or its model failed for good. |
| `execute(command, options)` | Runs a shell command in the workspace and resolves, once it has ended, to `{ code, output }`: its exit code and what it printed. One stopped when its seconds were over has a non-zero code, and its output ends with `Command ended: timeout`. See [Commands of the script](#commands-of-the-script). |
| `parallel(tasks)` | Runs a list of functions at once and resolves when all have ended, to their results in order; one that throws gives `null`. A value that is not a function is taken as it is. |
| `pipeline(items, stage1, stage2, …)` | Runs each item through the stages without waiting for the other items. A stage gets the previous stage's result, the item and its index; one that throws gives `null` for that item and skips its later stages. |
| `phase(title)` | The agents started after it are grouped under that title. |
| `log(message)` | A line for `/workflows` and the run's output. `console.log` does the same. |
| `args` | The `args` the call gave, as data, or `undefined`. A list or an object the model wrote as JSON text is read as that list or object: some models write a tool argument that has no type as text. |
| `budget` | `budget.spent()` is the output tokens this run's agents have used; `budget.total` is `null` and `budget.remaining()` is `Infinity`. |

The options of `agent()`:

| Option | What it does |
|---|---|
| `label` | the name it has in `/workflows`; without it, the start of the prompt |
| `phase` | the group it belongs to, whatever `phase()` last said; use it inside `parallel()` and `pipeline()` |
| `schema` | a JSON Schema whose root is `type: 'object'`: the agent returns an object that fits it. See [Results with a schema](#results-with-a-schema) |
| `model` | the model it uses, on the same endpoint |
| `effort` | its thinking depth: `minimal`, `low`, `medium`, `high`, `xhigh` or `max` |
| `agentType` | a subagent type `task` takes, such as `explore` or one of [yours](agents.md); without it, a workflow agent |
| `stallMs` | how long its model may send nothing before it starts over; see [When an agent stalls](#when-an-agent-stalls) |

A run is meant to be repeatable: `Date.now()`, `Math.random()`, `Date()` and `new Date()` without an argument throw, and so does formatting the current time with `Intl`. Pass a time in through `args`. A script cannot read or write files, reach the network, `import` anything or make code from strings: its agents do that work, and `execute()` runs a command for it. A script that imports is refused before it runs, and so is one that does not parse, with the line.

### Commands of the script

`execute(command, options)` is for the script's own bookkeeping: a tool that keeps the state of a long job and says what to start next, a check of what an agent wrote. Work that needs judgment stays with agents. With it a script can run a loop that needs no model between its steps: ask the tool, start the agents it names, ask again when one ends.

A command runs as the conversation's own `execute` call would. The same rules, hooks and approval mode decide it, `%NAME%` takes its value from your variables and secrets the same way, and a secret's value in what it printed is shown as its name. It is not shown in the conversation and its result is not kept there: the run's log has a line when it starts and when it ends, and the run's journal has what it gave. What a `PostToolUse` or `PostToolUseFailure` hook adds to the output, or puts in its place, does not reach the script.

The call rejects when the command did not run: a rule or a hook refused it, or you did. A command that ran and failed is a result, with its exit code. A command takes no agent's place, so it runs while every place is taken. It has 120 seconds unless `timeout` names others, 600 at most, and is stopped when they are over; a job that takes longer is an agent's to start in the background, or the conversation's.

| Option | What it does |
|---|---|
| `label` | the name it has in the run's log; without it, `$` and the start of the command |
| `phase` | the group it belongs to |
| `timeout` | the seconds it may take, from 1 to 600 |

A [relaunch](#relaunch-a-run) hands back a command's saved result as it does an agent's, without running it again, as long as the command and its seconds are the same. A script whose commands change something outside the run, such as a state file, is better started anew than relaunched: the saved results are of the state as it was.

## How a run goes

Each `agent()` call starts a subagent on the path `task` takes. It is a session of its own under your conversation, your hooks hear it (`SubagentStart` and `SubagentStop`, with `agent_type` set to `workflow` or the `agentType`), its calls are decided by your rules and the conversation's mode, and commands and MCP servers are told your conversation's session with the agent's own as `CIRCLE_AGENT_ID`. A workflow agent works from a prompt that tells it its final text is data for the script: no greeting and no account of its steps. With `agentType`, the agent has that type's prompt and tools, as with `task`.

- **Order.** Agents start in the order the script calls `agent()`. At most 16 run at once, fewer on a machine with fewer processors (two fewer than it has, at least one); the others wait their turn. `CIRCLE_WORKFLOW_MAX_CONCURRENT_AGENTS` sets the number, from 1 to 256. A run's agents do not count toward the 20 subagents `task` may run at once.
- **Size.** A run starts at most 1,000 agents; the next `agent()` call fails with why. One `parallel()` or `pipeline()` call takes at most 4,096 items, and a longer list fails the call.
- **Failure.** An agent whose model failed after its retries, or that you stopped, gives `null`. A call that cannot be made fails: an option it cannot take (an unknown `agentType` or `effort`, `isolation`), a schema that contradicts itself, a schema still not met, an agent that stalled every time. Inside `parallel()` or `pipeline()` that is a `null` too; a call the script awaits directly ends the run with the error, unless the script catches it.
- **No questions.** A run asks you nothing in the middle: the script has no way to, and its agents have no `question` tool. Only their approval cards wait for you.
- **No workflows within.** A subagent, a workflow's agents included, cannot start a workflow: it is not offered `workflow`, and `workflow()` in a script fails with a note.
- **Agents the script did not wait for** stop when it returns.

### Results with a schema

With `schema`, the agent gets a `structured_output` tool whose arguments are the schema, and is told to call it once with its result. A call that does not fit is refused before it runs, with the reason, and the agent tries again; ending without calling it counts as a try too. After 5 tries (`CIRCLE_MAX_STRUCTURED_OUTPUT_RETRIES`) the `agent()` call fails with the last reason. The call that fits ends the agent's turn.

A schema that cannot be met as written fails the call before any agent starts: one whose root is not `type: 'object'`, one that is not valid JSON Schema, a `required` key that `additionalProperties: false` rules out, a minimum above its maximum, or an empty `enum`.

### When an agent stalls

An agent whose model sends nothing for 10 minutes while a request is out (`CIRCLE_ASYNC_AGENT_STALL_TIMEOUT_MS`, or `stallMs` on the call) starts over from its prompt, in a new session without the stalled attempt's conversation. Time spent on its tool calls, and waiting for your approval, does not count. A stream the model layer itself gave up on (`CIRCLE_LLM_STALL_TIMEOUT`, after its retries) also starts the agent over. Files the stalled attempt changed stay changed. `/workflows` shows `(retry 1)` after its label.

An agent starts over five times at most. When its sixth attempt ends the same way, its call fails with `agent stalled on all 6 attempts`, `agent lost its reply on all 6 attempts`, or, when the attempts ended in different ways, `agent abandoned after 6 attempts:` and the list.

### The result

When the script returns, the model's notice carries the result, up to 32 KB; a longer one is in `/workflow_runs/<run>/result.txt`, which the notice names. A run that failed ends with `failed · script error` and the reason; one you stopped ends `stopped`.

## Watch a run

- **Below the input box**, the run is a job row, `j3 workflow audit-routes`, with its phase and how its agents stand: `Audit · 3 running · 5 done`.
- **`/workflows`** lists this conversation's runs, newest first; with one run, or `/workflows <id or name>`, it opens that run. A run shows where it stands, its last three `log()` lines, then each phase with its agents. `enter` on an agent opens its conversation, as a subagent's page; `enter` on a phase lists that phase alone. `ctrl+k` on an agent stops it after asking (the script gets `null`), and on the first row stops the whole run.
- **`/jobs`** and `stop_job` treat the run as any job: its output file holds the progress lines and, at the end, the result.
- **In the desktop application** the run is a row of the background jobs card; `/workflows` opens that card.

Stopping a run stops its agents and the commands they started. Leaving Circle stops it too, as it stops every job.

## Relaunch a run

`workflow` with `resume_from_run_id` relaunches an earlier run of this conversation, with its own script (`/workflow_runs/<run>/script.js`, which you or the model may have edited) or with `script_path` or `script`. The relaunch replays the earlier run in the order things happened then:

- An agent called as it was then returns its saved result at once.
- The first agent whose call differs, because the script was edited or an earlier result differs, runs, and so does every agent started after it.
- An agent that failed then, or that you stopped on its own, runs again, and so does every agent started after it.
- An agent that was still running when the run stopped starts over; the others keep their saved results.

Results come back in the order they came in the earlier run, so agents started side by side that ended in another order than they started are all handed back when nothing changed. A call counts as the same when its prompt, `schema`, `model`, `effort` and `agentType` are; a new `label` or `phase` does not make it differ.

A relaunch is refused while the run is still running or its agents are still stopping, and fails with `nothing to resume` for a run this conversation does not have or one that saved no results. A run's files stay in the project's data folder, so a conversation you reopen later can relaunch its runs.

## Saved workflows

A saved workflow is a `.js` file with its `meta` at the top, in one of these folders:

| Folder | Runs as |
|---|---|
| `<workspace>/.circle/workflows/` | its `meta.name`, for this project |
| `workflows/` in the [data folder](configuration.md#where-circle-keeps-things) | its `meta.name`, in every project |
| `workflows/` in an installed pack | `<pack>:<meta.name>` |

A project's workflow replaces one of yours with the same name. A file whose `meta` cannot be read is not offered. The model sees each saved workflow's name, description and `whenToUse` in the `workflow` tool's description, read when the session starts and when it reloads (`/reload`); the folders are read again whenever a workflow is run by name, so one saved since can be run at once. To save a run's script, copy `/workflow_runs/<run>/script.js` into one of these folders, or ask the model to.

## A run's files

Each run has a folder in the project's data folder, `projects/<folder>-<id>/workflow_runs/<run>/`, which the model reads as `/workflow_runs/<run>/`:

| File | What it holds |
|---|---|
| `script.js` | the script as the run started it |
| `journal.jsonl` | each agent's start and end, with what it returned: what a relaunch replays |
| `run.json` | the run as `/workflows` shows it after Circle restarts |
| `result.txt` | the result, once the run has returned one |

These folders are not removed; delete old ones by hand.

## How far the script is kept apart

The script runs in a worker thread of its own, inside a `node:vm` context made without any of Node's objects: no `require`, `process`, `fs`, timers or network, and code generation from strings is off. Values pass between the script and Circle as JSON text, so the script holds nothing of Circle's. The worker has its own heap, of at most 256 MB, and a stretch of script that runs for 5 seconds without waiting for an agent ends the run, as does running out of memory; neither stops Circle.

This keeps a script from doing anything but orchestrate by accident or by mistake. It is not a security boundary: Node says of `node:vm` that it is not a security mechanism, and a flaw in Node or V8 could let a script out of its context into the worker, which has Node's APIs. Treat a workflow script as code you run: read a saved or a pack's workflow before you allow it, as you would a pack's scripts. What a run changes, it changes through its agents and its commands, and their calls ask as any call does.

## What is not here

- **Refusing calls that go outside a declaration** ([#558](https://github.com/circle-platforms/circle/issues/558)'s second request) is not built. A workflow decides the order itself, so there is nothing of the model's to refuse; nothing checks the model's own calls in the conversation against a workflow.
- `workflow()` inside a script, which would run another workflow as a step, fails with a note. Run the other workflow on its own.
- `isolation: 'worktree'` fails the `agent()` call: agents work in the workspace, side by side.
- `/workflows` cannot pause a run, restart a running agent or save a run's script; there is no `ultracode` setting or keyword, no size guideline, no bundled workflow such as a deep-research one, no `/<name>` command for a saved workflow, and no setting that turns workflows off. Ask the model to run a saved workflow by name.

See [Known issues](known-issues.md#workflows).

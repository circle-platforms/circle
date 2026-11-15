---
parent: Development
---

# Declared orchestration

A design record for [#558](https://github.com/circle-platforms/circle/issues/558). The earlier version of this note described two ways to hold a session to a declared order and recommended the second. On 2026-11-14 the owner chose the first, way A, taken as Claude Code's workflows have it. That is what is built; [Workflows](../workflows.md) describes it for people who use it.

## What #558 asked for

1. One declaration of the phases in order, the subagent of each phase, how many per item, how many more tries after a failure, and where to stop and ask. The same declaration run twice with a scripted model gives the same phases, the same number of subagents and the same stops.
2. A call outside the declaration is refused on the path a `PreToolUse` deny takes, and the reason names the place in the declaration.
3. The docs say which comes first: the declaration or the model's own choice.

## Way A, as built

A workflow is a JavaScript script. Circle runs it, and the script decides what runs next: each `agent()` call starts a subagent, `parallel()` and `pipeline()` fan out, and `phase()` groups what follows. The model in the conversation writes the script or names a saved one, and gets the result when the run ends.

- **Where the code is.** `src/workflow_script.ts` reads `meta` and runs the body in a worker thread inside a `node:vm` context; `src/workflows.ts` is the run: limits, stall restarts, the journal and the replay; `src/workflow_files.ts` finds saved workflows; the runtime starts each agent on the path `task` takes (`runTask` with a workflow launch) and the run as a background job.
- **Point 1.** The script is the declaration. Order and counts are its own; a run is repeatable because `Date.now()`, `Math.random()` and an argumentless `new Date()` throw, and a relaunch replays an earlier run's journal in the order things happened. Further tries are the stall restarts (five) and the schema tries (five); a script that wants more tries writes its own loop.
- **Stops.** A run asks nothing in the middle, as in Claude Code: there is no `ask()`, and agents have no `question` tool. The stop is before the run: the person approves it, every time in `manual` and `accept-edits` mode and the first time in `auto` mode. A sign-off between stages is a run per stage.
- **Point 2 is not built.** The model in the conversation takes no part in a run's order, so there is nothing of its own to refuse, and nothing checks the model's own calls against a workflow. A guard on the `PreToolUse` path, as way B described, would still be possible later.
- **Point 3.** [Workflows](../workflows.md) says that the script decides the order and the model decides only to start it.

## What differs from the first sketch

- The sketch had a `default export` function taking `agent`, `ask` and `parallel` as arguments, `retries` with a `check` command, and `ask()` to stop midway. The built format is Claude Code's: `export const meta`, a top-level body with globals, no `ask()`, and no `check`.
- The sketch had no way back into a stopped run. A run keeps a journal, and `resume_from_run_id` replays it.
- The sketch named the trust of an extension for the script. The script has much less: no Node objects at all, values crossing as JSON, its own heap, and a time limit on each stretch that does not wait for an agent. `node:vm` is still not a security boundary; [Workflows](../workflows.md#how-far-the-script-is-kept-apart) says how far it goes.

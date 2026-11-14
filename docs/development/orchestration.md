---
parent: Development
---

# Declared orchestration

A design note for [#558](https://github.com/circle-platforms/circle/issues/558), written before any code. The owner chose on 2026-11-14 that this batch delivers the note only. **Nothing in it works yet.** Two ways are described below, with a recommendation, for the owner to choose between. The code follows that choice in a pull request of its own.

## What is missing

Today the model decides everything a skill says about order:

- which subagent `task` starts and when;
- how many it starts for a batch;
- whether to try again after a failure;
- whether to stop and ask.

`SKILL.md` can say "first A, then B, one subagent per item, at most two more tries", but nothing checks it. A hook sees one call at a time and has no idea which phase the work is in, unless it keeps that in a file of its own (as the scope example in [Hooks](../hooks.md#keep-what-you-said-for-this-session) does). An extension can do it in code, through `model_call` and `tool_boundary`, but each would write its own, and nothing declares it.

What #558 asks for:

1. One declaration of the phases in order, the subagent of each phase, how many per item, how many more tries after a failure, and where to stop and ask the person. The same declaration run twice with a scripted model gives the same phases, the same number of subagents and the same stops.
2. A call outside the declaration is refused on the path a `before_tool` deny takes, and the reason names the place in the declaration.
3. The docs say which comes first: the declaration or the model's own choice.

## What others do

- **Claude Code's workflows.** A workflow is a JavaScript script in `.claude/workflows/`. The harness runs it, and the script calls subagents with `agent()`, `parallel()` and `pipeline()`. The script decides what comes next, not the model. The person approves a workflow before it starts, and a running script does not stop to ask.
- **Goose's recipes.** A recipe is a declared task. It can name sub-recipes, and its `retry` block sets the number of further tries (`max_retries`) and the shell commands that check each one.
- **Nobody refuses a call** that goes outside a declaration. Each either runs the declaration itself, or leaves the order to the model.

## Way A: Circle runs the declaration

A workflow is a file in `.circle/workflows/` (or a skill's own `workflows/`), started with `/workflow <name>`. Circle runs it, and the model inside each subagent does the work of one step.

```js
// .circle/workflows/fix-batch.mjs
export const meta = { name: 'fix-batch', phases: ['survey', 'fix', 'review'] };
export default async function ({ items }, { agent, ask, parallel }) {
  const found = await parallel(items.map((item) => () => agent('explore', `Survey ${item}`)));
  if (!(await ask(`Fix ${found.length} items?`, ['fix', 'stop'])).startsWith('fix')) return;
  for (const item of items)
    await agent('fixer', `Fix ${item}`, { retries: 2, check: 'npm test' });
  return agent('reviewer', 'Review the fixes');
}
```

- **Order and counts** are the script's. A subagent runs through the same path `task` takes: its approvals, its hooks (`subagent_start`, `before_tool`) and its definition (`agents/*.md`, [Subagents](../agents.md)).
- **A stop** is `ask()`, the question panel of the `question` tool. Unlike Claude Code, a workflow can stop and ask midway.
- **Further tries** are `retries`, judged by a `check` command or by the subagent's result being an error.
- **Before it starts**, the person sees the phases and approves them, like a project hooks file.
- **Nothing is refused**: the model in the conversation does not take part in the order, so there is no call of its own to refuse.

Run twice with a scripted model, the same script gives the same sequence, as #558 asks. But it does not do #558's second point: it has nothing to refuse. It is a subsystem of its own: a script runner with the trust of an extension, a progress view in the terminal and in the desktop, and resumption after a restart.

## Way B: the model works inside the declaration

A declaration says what may happen, and the model still makes each call. Circle refuses a call that does not fit, with the place in the declaration.

```json
{
  "phases": [
    { "id": "survey", "agent": "explore", "per_item": 1 },
    { "id": "fix", "agent": "fixer", "per_item": 1, "retries": 2, "ask_before": true },
    { "id": "review", "agent": "reviewer", "per_item": 1 }
  ]
}
```

- **Where it lives.** It sits in `.circle/orchestration.json`, approved like a project hooks file, or as `orchestration.json` in a skill's folder, armed when the session loads the skill, as the skill's hooks and subagents are.
- **What is counted.** `task` gets an optional `item` argument, and Circle counts the calls of each phase and item.
- **The guard** sits beside the hooks, on the same path as a `before_tool` deny (#543's `reason` and `user_message`). It refuses:
  - a phase started before the one before it has every item done: `fix comes after survey (.circle/orchestration.json, phases[0])`;
  - a second subagent for one item;
  - a try past `retries`;
  - an `agent` the phase does not name.
- **A stop** (`ask_before`) is an `ask`: the approval card shows `phase fix starts` before its first call, and a refusal there is a deny with that reason.
- **The phase reached** is kept with the session, so resuming the session goes on from it.
- **Which comes first.** The declaration is the boundary, and the model chooses within it: the wording of each task and which item comes next. Without a declaration nothing changes.

Each of #558's three points has a test: the same phases and counts twice with a scripted model; a skipped phase refused with its place; and the docs. It reuses `task`, the deny path and the approval card, and adds a guard with per-session state.

## Recommendation

**Way B first.** It is what #558 asks for, point by point, and the smaller change. It keeps the model in charge of the work while Circle holds it to the order, which is how a skill's text is meant to be read today. Way A can come later, as a runner for declarations people want to run without a model choosing at all. It would read the same phases, so a declaration written for B would not have to be written again.

## For the owner to decide

1. Way A, way B, or B now and A later.
2. Where a declaration lives: a project file approved like hooks, a skill's folder, or both.
3. How an item is named: an `item` argument on `task` (proposed), or the task's description.
4. What a failure is, for `retries`: the subagent's result being an error (proposed), or a check command as in Goose.
5. Whether background subagents (`background: true`) count toward a phase before they end.

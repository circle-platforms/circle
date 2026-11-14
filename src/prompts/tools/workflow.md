Run a workflow: a JavaScript script that starts subagents and decides itself what runs next.
Start one when the user asks for a workflow, or names a saved one; otherwise do the work
yourself, or delegate it with task. The run goes on in the background: the call returns at
once with the run id and the script's path, and the result arrives as a notice when the run
ends. Do not poll or sleep. The user approves a run before it starts, unless a rule allows it.

Give one of name (a saved workflow listed below, with args when it takes input), script (a
script written for this task) or script_path (a script file, such as an earlier run's script
after you edited it). resume_from_run_id relaunches an earlier run of this conversation: the
agent() calls made as before return that run's saved results at once; the first call that
differs, failed or did not finish, and every call after it, runs again.

A script:

    export const meta = {
      name: 'audit-routes',
      description: 'Audit route handlers for missing auth checks',
      phases: [{ title: 'Find' }, { title: 'Audit' }],
    }
    phase('Find')
    const found = await agent('List every .ts file under src/routes/.', {
      schema: { type: 'object', required: ['files'],
        properties: { files: { type: 'array', items: { type: 'string' } } } },
    })
    phase('Audit')
    const audits = await pipeline(found.files, (file) =>
      agent(`Audit ${file} for missing auth checks.`, { label: file }))
    return audits.filter(Boolean)

meta is the first statement and a plain literal: a name (letters, digits, _ and -), a
one-line description, and the phase titles the script uses. The body is plain JavaScript,
not TypeScript, with top-level await and return. What it returns is the run's result.

- agent(prompt, options) starts one subagent and resolves to its final text. With schema, a
  JSON Schema whose root is type 'object', it resolves to an object that fits it. It resolves
  to null when the agent was stopped or its model failed. Options: label, phase (its progress
  group; use it inside parallel work instead of phase()), schema, model, effort, agentType (a
  subagent type task takes; the default is a workflow agent whose final text is data), stallMs.
- parallel(tasks) runs a list of functions at once and waits for all of them; one that throws
  gives null in its place.
- pipeline(items, stage1, stage2, ...) runs each item through the stages without waiting for
  the other items; a stage gets (previous result, item, index); one that throws gives null for
  its item. Prefer it to parallel() between stages unless a stage needs every earlier result.
- phase(title), log(message), args (the args of this call, as given) and budget.spent().

Date.now(), Math.random() and new Date() without an argument throw, so that a relaunch repeats
the same calls: pass a time in through args. The script cannot read or write files, run
commands or import; its agents do that. At most 16 agents run at once, 1000 in a run, and 4096
items go to one parallel() or pipeline(). An agent whose model sends nothing for a long time
starts over, five times at most; a schema still not met after five tries fails the call. A run
asks the user nothing, though its agents' calls can wait for approval.

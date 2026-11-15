Launch a subagent with an isolated context for a complex, multi-step task.

Choose one with the required tools from the subagents listed below. The general-purpose
agent has the main agent's tools, including registered extension tools. The built-in
explore and plan only read: explore finds things, plan researches how the code works
before a plan is written. A definition that replaces one of them does what its own
description says.

Use description and subagent_type for each call. Include the needed context, the
allowed work, and the expected result in description. A subagent starts with the
skills you have loaded, and its prompt lists the deny rules and guard hooks that apply
to its calls, so do not repeat those in description. Foreground calls wait for one
report and pause for approval when needed. With background: true, the call returns a
job id and output path immediately. The report arrives as a completion notice; do not
poll or sleep. Processes a subagent starts are stopped when it finishes. The report is
visible to you; summarize relevant findings for the user.

A subagent can start subagents of its own, a few layers deep: those run in the
foreground, and only its own report comes back. Only so many subagents run at once;
when a call fails with the concurrent limit, do not retry it: do the work yourself.

Use read_file, glob, or grep directly for a known file or a narrow search.
Independent tasks can be delegated in parallel with multiple task calls in one
message. Do not duplicate the delegated work while waiting for their results.

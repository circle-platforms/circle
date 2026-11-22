---
nav_order: 9
---

# Background jobs

A command or a subagent can keep running while you and the model go on: a dev server, a file watcher, a long build, a test run, a subagent doing research. Circle keeps each as a job: it shows it below the input box, keeps its output in a file, and tells the model when it ends, starting a turn for that if nothing else is running. The model does not have to poll or `sleep`.

## How a job starts

- **The model asks for one.** `execute` with `background: true` runs a command as a job, and so do a pack's script run with `skill_run` and a pack's [typed tool](skills.md#how-a-packs-script-runs); `task` with `background: true` runs a [subagent](#background-subagents) as one. The call returns at once with the job's id (`j1`, `j2`…) and the file its output goes to.
- **The model starts a workflow.** A [workflow](workflows.md) runs as one job, `workflow <name>`; its row shows its phase and how its agents stand, its output file holds its progress, and its notice carries the script's result.
- **A command takes longer than expected.** A command or a pack's script still running at the default timeout (120 seconds) goes on as a job instead of being ended. One the model gave its own `timeout` is still ended at that time.
- **You press `ctrl+b`.** The command being waited on goes on as a job: the model's, a subagent's, or your own `!command`.
- **A command leaves something running.** When a command ends but processes it started are still running (`server &`, `nohup … &`), those processes become a job, marked `left running`. Not on Windows; see [Known issues](known-issues.md#background-jobs).
- **An extension waits for something.** An extension tool can hand Circle a [watch](extensions.md#waiting-for-something-slow): Circle checks it every few seconds, off the model's turns, and the result becomes a notice.

An [MCP tool call](mcp.md#long-calls-and-large-results) of the conversation that is still running after 2 minutes goes on as a job too: its row shows what the server last said of its progress, its result is the job's output, and stopping it cancels the call.

## While a job runs

- **Below the input box**, one row per running job, under the strip's header (`Jobs · 2`): its id and command, the last line it printed (or a subagent's current step, or `waiting for you`), and how long it has run.
- **Its output** goes to `/background_jobs/<run>/run-<n>.log`, which the model reads with `read_file`. It is kept in the [data folder](configuration.md#where-circle-keeps-things) (`projects/<folder>-<id>/background_jobs/`), not in your project, and the model cannot change it. Standard output and standard error are kept together, in the order they were written. The file keeps the bytes the command wrote; Circle reads them as UTF-8, and on Windows, output that is not UTF-8 in the console's code page (see [Known issues](known-issues.md#install-and-release)). Each run of Circle has its own folder; it is removed when Circle next starts in that project, once that run has ended and a day has passed.
- **`/jobs`** (`/tasks`) lists the jobs, running ones first. `enter` opens a job's page: a band with its lamp, id and command, state and time, and the file its output goes to, then its output, refreshed while it runs; `esc` goes back. `ctrl+k` stops a running job after asking, or removes one that has ended from the list.
- **The model** has `list_jobs` and `stop_job`. A subagent also has `wait_jobs`, because only the main agent can be woken by a notice.

Limits: 16 commands and watches at once (processes left running by a command are never refused), 20 subagents at once in the background and the foreground together ([`CIRCLE_MAX_CONCURRENT_SUBAGENTS`](agents.md#subagents-of-a-subagent)), and 1 GiB of output per job; a job that writes more is stopped (`CIRCLE_JOB_OUTPUT_LIMIT_MB`). A background command's `timeout` can be up to a day.

## When a job ends

The model gets a notice: how the job ended, the exit code, how long it ran, and the last 20 lines of its output as plain text (a subagent's report, a watch's result).

- **During a turn**, the notice reaches the model before its next step, and the conversation shows a row for it: `◆ j3 done · npm test · 12s`. A job ends `done`, `failed` or `stopped`.
- **When nothing runs**, Circle starts a turn with the notice. The turn opens with the job's row instead of a message of yours, and you can steer it or stop it like any turn. Notices that arrive within a second of each other go in one turn.

Circle does not start such a turn:

- after you press `esc` or `ctrl+c` to stop a turn, or at the input box with no turn running (`ctrl+c` then clears what you typed or says how to leave): finished jobs wait until you send a message, and the model reads their notices with it;
- while a card waits for you, you are typing, a list such as `/jobs` is open, or `/tree` has taken the conversation back;
- for a job you stopped, or one that was your own `!command`. A `!command` you moved to the background shares its output with the model when it ends, as one in the foreground does;
- for a job of another conversation: its notice waits until that conversation is open again;
- more than twenty times in a row: then it waits for you. Work that runs many jobs by design, one for each item of a long list, sets `CIRCLE_JOB_WAKES` to a higher number before Circle starts.

When a notice waits like this and nothing else holds the conversation, the terminal says so as the job ends, with a dim line: `j21 done · download returns · 7m 38s · waits for your message after 20 turns in a row started by jobs`. After `esc` or `ctrl+c` the line ends at `waits for your message`. The desktop application shows the same line as a notice in the conversation, under its last message, with what follows the job's line in the interface language, and [RPC mode](rpc.md#events) writes a `job_notice_waiting` record. The line is not part of the conversation's history: the model reads the notice itself with your next message, and the terminal draws its row, `◆ j21 done · …`, then. Turns that jobs start count from your last message, however long the jobs run, so a long run of jobs, each started in the turn the one before started, reaches the limit.

A turn that failed, because the model did not answer, its service broke off or a compaction was running, is tried again after fifteen seconds, a minute and four minutes. The failed turn has usually read the notice already, so the retry asks the model about the conversation as it stands. After the third it waits for you.

The [desktop application](desktop.md) starts such a turn too, with these differences:

- The conversation has no row for the notice, except the line above when it waits for your message. The job's row in the overview's [background jobs card](desktop.md#the-overview) says how it ended.
- The stop button counts as `esc`, and going back with the session tree counts as `/tree`.
- Each open conversation wakes by itself, selected or not, so a job of a conversation you are not looking at starts a turn in that conversation.
- Typing holds nothing back: what you send during the turn waits in the queue, as it does during any turn.

The model is told not to poll. If it runs a bare `sleep` anyway (`sleep 30`), the sleep ends as soon as one of its jobs ends; if it keeps sleeping or re-reading a job's output while jobs run, Circle reminds it that a notice will come. After older messages are summarized, Circle reminds it of the jobs it started that still run.

## Background subagents

`task` with `background: true` runs a subagent as a job, and so does `task` for a definition with `background: true`. It works with a context of its own, as in the foreground, and its report becomes the notice; its steps go to the job's file, so `read_file` (or the job's page) shows its progress.

- **Approvals.** When it needs your approval, its card appears whether a turn is running or not. A subagent asks no questions: it has no `question` tool. The card's title starts with the job: `j3 general-purpose · Bash needs your permission`. A card of the running turn goes first; the background card waits behind it, and both wait while you are typing. Rejecting tells the subagent (and why, if you explain). "Allow … for this session" adds a rule to the conversation the subagent belongs to, and `auto` mode lets it run without asking, as it does the main agent. `ctrl+c` does not answer a background card.
- **Sending it something.** `send_to_job` tells one running subagent of this conversation one thing, and the subagent reads it before its next model request - never in the middle of one, and never as an answer to a card. At most eight messages wait for one job, and a message is at most 4000 characters, on one line. The refusal says which of these stopped it. A message the subagent never reached stays in that subagent's own queue, where its conversation shows it: nothing pretends it was delivered. There is no way to type into a job from the keyboard in this version: the person's route to a running subagent is still its cards and `stop_job`.
- **Read-only.** `/plan` reaches subagents that are already running.
- **What it costs** counts in the conversation's total.
- **What it starts** (a server, a watcher) is stopped when it ends.
- The subagents it starts run in the foreground: it waits for their reports, and their cards wait under its job. One that is already running keeps the model it started with when you switch models or `/reload`.

## When Circle ends

Leaving (`/exit`, `ctrl+d`) stops every job, each command with everything it started: `SIGTERM`, then `SIGKILL` a second later. Each conversation that had jobs running gets a note listing the ones that were stopped, so the model knows when you open it again.

Closing the terminal window, `SIGTERM` and `SIGHUP` stop every job too, but leave no note.

Without the full-screen interface:

- **Print mode** (`circle -p`) waits after its answer while jobs the model started run, and lets the model answer again when they end, up to twenty times and for up to `CIRCLE_JOB_WAIT` seconds (1800 by default; `0` does not wait). Processes a command left running, usually servers, are stopped at once. What still runs at the end is stopped. Notices that the twenty left unread are named on standard error.
- **Line mode** prints `Background job j3 ended.` to standard error when a job ends; the model reads its notice with your next line.
- **RPC mode** reports jobs as events, starts a turn when one ends while nothing runs, and writes a `job_notice_waiting` record when its notice waits for the next prompt, or is left unread when its input ends; see [RPC mode](rpc.md).

## What is not tracked

- A process that leaves its process group (`setsid`, a daemon that detaches) is not part of the job: stopping the job, or leaving Circle, does not stop it.
- If Circle itself is killed with `SIGKILL`, its jobs keep running.
- Jobs do not outlive Circle: a reopened session has none running.

See [Known issues](known-issues.md#background-jobs).

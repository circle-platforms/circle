---
parent: Development
---

# Messages to a running subagent

A design note that came before the code, written while none of it worked. Issue #373, box 7. The rule is that this note is agreed first and the code follows it, so the boxes stay unchecked until both halves exist.

This is a working note under the same Apache License 2.0 as the code and the rest of `docs/`, not one of the four documents indexed in [Design specifications](../design/README.md).

**Agreed, and built.** The owner's answer on 2026-10-31 was to take the recommendations in this note, including the three at the foot of it. The code is [#395](https://github.com/circle-platforms/circle/pull/395); where it ended up differing from this text, the three corrections are marked below and the code is what the rest of `docs/` describes.

## What exists today

`task` with `background: true` starts a subagent as a job (`src/runtime.ts`). The child is a `Harness` of its own with its own session id, and the parent records who owns it in `childJobOwners`: the child session id mapped to `{ sessionId: <parent session>, parent: <job id>, startedBy }`. It works with a context of its own, writes its steps to the job's output file, and its report becomes a notice when it ends. That is the whole channel today: one answer, at the end.

Three mechanisms already cover most of what a message needs:

| Mechanism | Where | What it already does |
| --- | --- | --- |
| Steering queue | `src/harness.ts` (`queuedMessages`, `steering`, `followUp`) | A message stored against a session, consumed at the next model request of that session, never in the middle of one. It survives a restart, can be edited away, and carries a `display` form for the transcript. |
| Job notices | `src/jobs.ts` (`takeNotices`, `jobNotice`, `noticeLine`) | A `user` message wrapped in `<system-reminder data-source="circle-jobs">`, marked `internal: job_notice`, redacted for the conversation that receives it, with a one-line form the transcript shows. |
| Job tools | `src/tools.ts` (`list_jobs`, `stop_job`, `wait_jobs`) | The job id (`j3`) is the address. The owner of the calling conversation is resolved with `jobOwner`, so a call is read against the jobs that belong to it. |

A background subagent already reaches the person while it runs: its approval card appears whether a turn is running or not, titled after the job (`j3 general-purpose · Bash needs your permission`), and `ctrl+c` does not answer it (`docs/background-jobs.md`).

## The rule

**A message goes to a running subagent and is read by it before its next model request.** Nothing preempts a request already sent, nothing answers an approval card, nothing starts a turn by itself. A message is input to one agent from another, and it is input only: it cannot carry an effect, a permission or a decision.

## Who may send to whom

| From | To | Allowed | Why |
| --- | --- | --- | --- |
| The person | a running job of this conversation | yes | They can already answer its cards; typing to it is the same authority, less. |
| A parent model | one of its own running subagents | yes | It started the job; this is the correction the box asks for. |
| A subagent | its parent conversation | **not in this slice** | Its report already arrives at the end, and mid-run arrival would wake a conversation that may be idle. Decided again with the notice path below. |
| A subagent | a sibling | no | A subagent cannot start another one, so it has no legitimate way to know a sibling id, and the ids are guessable. |
| Any model | a job of another conversation | no | Addresses are per conversation, as `list_jobs` already treats them. |
| Any model | a subagent of its own | no | A child has no `task` tool; nothing to check, but the tool must not be added to a child for this. |

The authorization is the owner check, and it has to be checked before the message is queued: the same rule the box for approvals says in miniature - a repository or another conversation must not be able to widen what Circle does. While writing this note, one existing gap turned up: `stop_job` takes any `job_id` and calls `jobs.stop(id)` with no owner check, while `list_jobs` and `wait_jobs` both resolve one. A message tool that checked its owner would sit beside a call that does not; the slice should close that too, in the same PR, rather than leave the pair inconsistent.

## What a message is

- Text, one message per call, at most 4 KB, at most eight waiting for one job. The refusal says both numbers.
- No slash command, no variable or secret expansion (`%NAME%` stays literal text), no attachments. A message is what a person typed to another agent, and the receiving model must not be able to lift a secret value it was never given into it.
- Redacted on the way in, the way a notice is on the way out: `redact(text, sessionId)`, so a value the sender was shown is not handed over whole.
- Order is the order received. Two messages that arrive while a request is open are delivered together at the next boundary, as two separate user messages, in that order, so the child can tell a correction from a follow-up.

## Where it shows

| Surface | What appears |
| --- | --- |
| The child's model request | A queued user message wrapped in `<system-reminder data-source="circle-jobs" about="msg-…">`, naming the sender as the agent that started it. **As built, this differs from the first draft of this note:** there is no `internal: job_message` kind. The queue is store-backed input that becomes the child's user message with its own display row, and the special handling of `internal` belongs to notices. The `about` mark is what lets "read" mean *in the request that went to the model*, which the store cannot say: the row exists from the moment a message is queued. |
| The child's transcript | A row in the transcript with the text, marked as an incoming message, so a resumed conversation shows what it was told. |
| The parent's transcript | The `send_to_job` call's result: `Sent to j3; it reaches the subagent before its next request.` Nothing else: the child's steps are already in its output file. |
| The job strip | Its row keeps its shape (`src/tui/strip_rows.ts`: lamp, name, what it is doing, a meter). A waiting count goes in the activity column, which is the one that gives way first: `1 message waiting`, `2 messages waiting`. The row is text and the strip already caps what it shows (`JOB_ROWS`), so no new line, no new colour, and nothing may hold a colour past a repaint (`docs/development/tui-contract.md`, `src/ink/theme_watch.ts`). |
| The person's queue editor | Not there. The editor lists the steering queue of the conversation being read; a message to a child belongs to the child's session and is listed with the child. |

The desktop window shows none of this in the first slice: it has the job's page and its output file already, and the events for a message would be a second piece of work. That goes in `docs/known-issues.md` unless the owner wants it in the same PR.

## What it does to a blocked approval card

Nothing. A card is the person's decision about an effect, and text cannot make it, widen it or take it back.

The mechanics agree with the rule: the approval gate is inside the tool loop of the current request, and a message is consumed only at the next request boundary, so a message sent while a card is open waits behind it. A child blocked for twenty minutes on a card still gets the message when the person answers - and the person is likely answering knowing what they typed, which is the point.

What must not happen, and is what a careless implementation does: a message cancelling, dismissing or auto-answering a card. It also means `send_to_job` never waits for anything, so a stuck child cannot be un-stuck by the parent's model - only by the person, at the card, or by `stop_job`. The refusal to send to a job that has ended says exactly that: `j3 ended; nothing was sent. Its report is already in your notices.`

## How it dies with the job

- A message is queued against the child's session, in the same store the steering queue uses, so it survives a crash of the *parent turn* - the job is what owns it, not a turn.
- A message that arrives while the subagent is still running is read before it ends: the queue drains first, and the subagent answers once more with the message in front of it - which a test now shows on the requests rather than on a hope. **As built, this differs from the first draft:** the promised `2 messages you sent were not read.` line in the report is not there, because the case it described does not happen. What is true: a message that is never reached stays in that subagent's own queue and is shown in its conversation, and a message sent to a job that has ended is refused at the call, saying so.
- Ending the conversation, `stop_job`, the parent session ending (`stopOwned(..., 'parent ended')`), and leaving Circle all take the job down; undelivered messages go with it and are never replayed to a later job, because ids are per run.
- The waiting count goes with the job: `send_to_job` clears it, the child's request that carries the text clears it, and the job ending clears it, so no row keeps saying a message is wanted after the fact. **As built, this differs from the first draft:** nothing is deleted at load. A message the child never took into a request stays where the queue put it, in that subagent's session, where opening that conversation shows it like any other queued row. Dropping it there would hide the one trace that it was sent.

## The API

| Tool | Effect | Asks | Arguments |
| --- | --- | --- | --- |
| `send_to_job` | `write` | no | `job_id`, `text` |

No card, as `stop_job` has none: the person already allowed the job to exist, the message carries no effect, and a card per correction would train people to click through it. The audit is the transcript row and the child's own record. `write` rather than `unknown` because it changes what another agent will read, and read-only mode must refuse it: a `/plan` session can look at a job (`list_jobs`, `wait_jobs` are reads) but cannot steer one.

Names: `send_to_job` over `job_send`, to keep the read tools (`list_jobs`, `wait_jobs`) and this one saying what happens to what.

## The one piece that does not exist yet

The queue and the store are there, but nothing today maps a job id back to the child's `Harness` once the `task` call has returned: the child object lives inside that call's closure. The slice needs a registry for the run, `job id -> { harness, owner }`, written when a background child starts and cleared when it ends, plus one delivery call: `harness.queue(text, 'steer')` is already public and already lands at the next model request. The child has a session of its own (`store.create` in `src/runtime.ts`), so its queue is stored and read like any other. Two of its details carry over and are wanted: `options.display` is the wording the transcript row gets, so the child's row can say who sent it, and the store keeps this queue exactly as it keeps the person's. One is not: identical text is not refused - `queue` only uses its `duplicate` flag to decide whether earlier attachments carry over, so the same line may sit in the queue twice. The cap is therefore a count, and the tool's answer quotes what went in, so a parent that sends the same correction twice is told it queued twice rather than being left to count on its own.

The message does not go through the notice queue. A notice is pulled by the owner's harness at a boundary and says a job ended; putting input to a child in the same channel would make a correction look like an ending, and the two would fight over ordering. The notice queue stays what it is, and answers the question nobody has asked yet: how the child's report arrives.

## What stays out of this slice

- A subagent speaking to its parent mid-run. The parent's notices are pulled at a boundary by its own harness; a child pushing one would mean waking an idle conversation, which is a different decision with a cost of its own. Its report is the channel until that is decided.
- Sibling messages, messages across conversations, and any address a child may resolve for itself.
- The window: no panel to type into a job, no events for messages.
- Attachments, slash commands, variables, secrets in a message body.
- Anything that lets a message answer a card, change an approval mode or set a rule.

## What decides it is done

The box asks for one thing - a test showing a message sent to a running background subagent arriving before its next model request. #395 has that, and these beside it:

1. Done: a parked child, a message sent, the queue released - the child's next request carries the reminder, worded as input that answers no card. The row that says who sent it is in the child's own session, and the waiting count comes back to zero.
2. Done: sent while its approval card is open - one card, one request so far, and the message waits behind it; after the person answers, it is in the next request.
3. Done: the refusals each say which rule stopped them - an empty line, 4104 characters, an id that is not this conversation's, a job that is not a subagent, a subagent addressing itself, and read-only mode.
4. Done: eight waiting and a ninth refused, with nothing written for the refused ones.
5. Done: `stop_job` resolves an owner now, like `list_jobs` and `wait_jobs` did, and a job of another conversation cannot be stopped by id.
6. Done: read-only mode refuses `send_to_job`, because its effect is a write.
7. Not done: the strip text is tested as a string (`jobActivity`, singular and plural, and not for a command), not as a rendered frame at 80 columns on both palettes. It uses no colour of its own, so the contract is met by construction, but the render check is still owed.
8. Changed, as written above: no message is dropped at load, so there is no test of a drop. What is tested instead is that a late message is read before the child ends, and that the count does not outlive the job.

## The owner's answers (2026-10-31)

The three questions this note ended with were answered by taking what the note recommended:

1. `stop_job`'s owner check went into the same pull request as the message tool, because a message tool that checks its owner next to a stop that does not is worse than two open issues.
2. `send_to_job` is card-free, with the transcript row as the audit and a `write` effect so `/plan` refuses it. The first-message-asks variant was not taken: it would ask once per job for something that carries no effect.
3. The person's keyboard route is out of this slice. The mechanism takes a message from a person as easily as from a model - the queue does not care who filled it - so the affordance and the window can be designed together, once there is a place in the window to put it.

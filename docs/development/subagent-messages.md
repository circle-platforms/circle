---
parent: Development
---

# Messages to a running subagent

A design note, not documentation of a feature: nothing here works yet. Issue #373, box 7. The rule is that this note is agreed first and the code follows it, so the boxes stay unchecked until both halves exist.

This is a working note under the same Apache License 2.0 as the code and the rest of `docs/`, not one of the four documents indexed in [Design specifications](../design/README.md).

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
| The child's model request | A `user` message, `internal: job_message`, content wrapped in `<system-reminder data-source="circle-jobs">` with the sender named as `job <id> of this conversation` or `you, the parent agent`. Same shape as a notice, so nothing new has to be taught to a model. |
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
- A job that ends with messages waiting loses them, and the sender is told in the report it already gets: `2 messages you sent were not read.` A message that arrives after the end is refused at the call.
- Ending the conversation, `stop_job`, the parent session ending (`stopOwned(..., 'parent ended')`), and leaving Circle all take the job down; undelivered messages go with it and are never replayed to a later job, because ids are per run.
- A restart does not offer them again. A message whose job is gone is dropped at load, saying why in the transcript row it left behind. This is the deliberate difference from the person's steering queue, which does survive a restart: a steering message is input to a conversation that continues; a message to a dead child is input to nothing.

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

The box says: a test shows a message sent to a running background subagent arriving before its next model request. Held as:

1. A child whose first request is parked, a message sent, the request released: the child's second request carries the message as a `user` message with `internal: job_message`, and it carries it **before** anything else the child would see. `ScriptedModel`, a local gateway, scratch `CIRCLE_HOME`.
2. A card open when the message arrives: the card is still open, the message is still waiting, and after the person answers, the message is in the next request. Rejecting the card tells the child both, in the order the person chose them.
3. A job that ended, a job of another conversation, a job id nobody owns: refused, with the refusal naming which, and no store row left behind.
4. The caps: a ninth message and a 5 KB message are refused before anything is written.
5. `stop_job` gains the owner check, and a test shows a job of another conversation cannot be stopped by id.
6. Read-only mode refuses `send_to_job`.
7. A render test at 80 columns for the strip line and the transcript row, on both palettes, using `palette()` only.
8. A restart while a message waits: nothing is delivered later and the row says so.

## For the owner to answer

1. Is closing `stop_job`'s missing owner check part of this slice, or a separate issue?
2. Is `send_to_job` card-free as proposed, or should the first message to a job ask once and the rest go through for that job?
3. Does typing into a running job belong to the person in this slice (a key on the job's row), or is the model tool enough until the window has a place for it?
---
nav_order: 8
---

# Sessions and context

A session is one conversation: its messages, tool calls and results. Circle keeps every session in `circle.sqlite` in the data folder, saved after every message, so the model's memory of a conversation survives a crash and a restart. The same file lists each folder's sessions with their titles, so they can be reopened.

This page also lists what the current version does not do. Read [What does not carry over](#what-does-not-carry-over) before you rely on it.

## Start, name and switch

| Command | What it does |
|---|---|
| `/new` (`/clear`) | Start a new session. The old one stays in the folder's list once it has a message. A session with no messages yet is kept only in this terminal, and it is written when the first message is sent. |
| `/resume` (`/sessions`) | Pick a session from a list. See [Pick a session](#pick-a-session). |
| `/resume <n or id>` | Open a session by its place in that list or by the end of its id. |
| `/continue` | Switch back to the previous session. With none remembered and this session still empty, open the latest saved session in this folder. |
| `/name <title>` | Give the session a title. `/rename` does the same. Until you do, Circle uses a short title from the first message (a leading "please" is dropped, `@file` mentions are left out, and a long line is cut without splitting a number such as `1500`). A model may replace that title when the message is long. The title request disables thinking, wraps the message in `<conversation>` tags, asks for the title in the user's language, and uses only the answer text; reasoning is never the title. A Chinese sentence is counted by characters, so a prompt without spaces is still sent. A reply that answers the person, asks a question, is more than one sentence, or runs past 10 words or 60 characters is discarded and the short title stays. A reply that is only digits, or that cuts a longer number from the message (`150` from `1500`), is discarded too. A prompt that is too short to title keeps that short title and says nothing; the skip is logged only when debugging. Every other skip or rejection says `title failed` and the reason. The title names the request as a noun phrase, not an outcome. A stopped turn is still titled. Opening a session replaces a stored title that is reasoning text (`The user wants me to generate a title…`, `The user is asking…`) or a bare number such as `150` with the short title from the first message. Opening one whose title is still that short title, after a turn has been answered, asks the model for a title once. |
| `/session` | Show the session's id and title, its folder and model, where it is kept, how many messages and tool calls it holds, and the tokens this run has used. |

Session ids look like `circle-3f9a1c2e`. `circle --session-id <id>` opens or starts a session with an id you choose, `--name` gives it a title from the start, and `--no-session` keeps a conversation in memory only. See [CLI](cli.md#arguments-and-options).

## Pick a session

`/resume` and `circle -r` open a list of this folder's sessions, newest activity first, with how long ago each was used. Renaming a session does not move it in that list. A session that was never sent a message, or whose only turn failed before any reply, is not listed. Type to narrow the list: the search matches titles and the text of your messages and the model's replies. When nothing matches, the list says `No matches`. When the folder has no sessions, it says so. The marked row starts with `>`.

| Key | What it does |
|---|---|
| `enter` | Open the session. |
| `tab` | Switch between this folder's sessions and every folder's. The hint under the title changes with the switch, and every folder's rows name the folder. |
| `ctrl+r` | Rename the session. The old name is selected, so typing replaces it. |
| `ctrl+k` | Delete the session and its messages after confirmation, stopping its turn and tasks first. |
| `esc` | Clear the search, or close the list. |

A session from another folder is not moved. Picking one copies it into a new session in this folder, and the original stays where it was.

## Concurrent conversations

In the full-screen terminal, `/new`, `/resume` and `/continue` switch the view while other conversations keep running. `alt+s` opens the session list even while an approval card is waiting. The list marks running conversations and requests waiting for you. Switching back restores the draft, attachments, scroll position and pending card. Interrupt stops the selected conversation; leaving Circle stops every conversation and job owned by that terminal.

Changing the connection or signing out waits for every session and background task in that terminal to finish. A completed connection change refreshes the clients of all its open conversations; signing out prevents their next request. Work already running in other terminals keeps its existing client; their next turn, model change or manual compaction requires reconnecting when the saved endpoint or credentials changed.

Several Circle terminals can use the same data folder and workspace with different conversations. One conversation has one executable owner: another terminal can read its stored history, but cannot resume execution, change its history or delete it while owned. Release it in the original terminal, or fork it. Ownership uses heartbeat locks; after an abrupt process death, allow up to 30 seconds before resuming. A normal exit releases ownership after cleanup.

Deleting a running conversation requires confirmation to stop its turn, subagents and tasks. History is deleted only after cleanup succeeds; a failed cleanup keeps it for retry. Deleting the selected conversation chooses another available conversation in the same folder or creates an empty one. Deleting a background conversation leaves the current view alone. Actual files in the workspace remain shared, and deleting a conversation does not revert or delete them.

## Reopen a session after a restart

When you leave the full-screen interface, Circle prints the command that reopens the session, for example `To resume this session: circle --session circle-3f9a1c2e` (with the folder when you started Circle somewhere else), unless nothing was said in it.

```bash
circle -c                      # the most recent session in this folder
circle -r                      # pick one from the list
circle --session 3f9a1c2e      # a session by its id, or the end of it
circle --fork 3f9a1c2e         # a copy of it, as a new session here
circle -p -c "and now the tests"   # go on with it in print mode
```

A reopened session is drawn again from its saved messages: your messages, the answers, thinking and tool calls, folded as they were, and `ctrl+o` and `ctrl+t` work on them. A thought line keeps the seconds it took. Tools are never run again. A turn cut off while the assistant was still writing, or that ended on your message with no reply, is marked `✖ Interrupted` when the session is opened again. A tool call that was cut off before its result was saved (Circle was killed, or the terminal closed) gets the result `Interrupted before a tool result was saved`, so the model knows it did not finish. Sessions from `circle -p`, line mode and RPC mode are in the list too, so `circle -c` can pick up a scripted run in the full-screen interface.

## Undo and redo

`/undo` removes your last message and Circle's reply from the screen and puts the screen back as it was. `/redo` brings them back. You can undo up to 40 turns.

`/undo` only changes what the screen shows. **The model still remembers the turn**, and files it changed stay changed. Use it to tidy the view.

## Branches

You can go back to an earlier point of a session and continue from there. Nothing is lost: the earlier continuation stays in the session as another branch, and you can go back to it.

`/tree`, or `esc` twice on an empty input box, lists every message of the session, all branches, oldest first. `/tree <words>` opens the list searching for those words. Going back stops a running turn first.

| Key | What it does |
|---|---|
| `enter` | Go back to that message. |
| `L` | Give the message a label, shown as `[label]`. An empty label removes it. |
| `ctrl+u` | Show only your messages. |
| type | Search. |

Going back to one of Circle's answers shows the conversation up to that answer. Going back to one of your messages shows the conversation before it and puts the message back in the input box, so you can change it and send it again. Your next message starts a new branch from that point, and the model sees only the history up to it.

Circle remembers the point you went back to. Reopen the session after a restart and it is still there; send a message and the branch continues from it.

A point where a turn stopped on an approval card cannot be gone back to. Choose the message before it.

`/fork` and `/clone` make a new session instead:

- `/fork` lists your messages. Pick one and a new session starts with everything before it; the message is put back in the input box. `/fork <words>` opens the list searching for those words.
- `/clone` starts a new session with the current branch, up to the point you went back to if you did.

A fork or clone takes the branch with what Circle knows about it: an earlier compaction, the plan and the subagents' records. The original session stays in `/resume`. `esc` twice opens `/fork` instead of `/tree`, or nothing, when you set `double_escape` in [settings](settings.md#keys).

## Compaction

Long conversations are summarized automatically when they pass 85% of the model's context window, the number the footer shows after `ctx`, or sooner when the room kept for the answer needs it (see [Models](models.md#cost-and-context-in-the-footer)). Older messages are replaced by a summary and the most recent tenth of the window is kept. The originals are saved in the data folder, under `projects/<folder>-<id>/conversation_history/`; the model can still read them at `/conversation_history/`. The stored conversation itself is never rewritten.

While a compaction runs, automatic or not, a row above the input box shows it with a progress bar, the step and the time, for example `auto-compacting · ████████░░░░ summarizing · 12s`. `esc` stops an automatic one with its turn: the older messages stay as they were, and it runs again on the next request that is over the threshold. When it is done, one faint line stays in the conversation: `auto-compacted · ~171.0k → ~18.0k tokens · summarized 40 messages, kept 6 · 34s · history: /conversation_history/….jsonl` (the token counts are estimates of the whole request, on the scale of the footer's `ctx`). When it fails, a red line says why. A summary that was stopped, came back cut off, or no longer matches the conversation is not used.

`/compact [hint]` does it now, with the same row and closing line, reading `compacting` and `compacted`. The hint is added to the summarizer's instructions, for example `/compact keep the API decisions`. When everything still fits in the part that is kept, the footer says `Nothing to compact yet`. A compaction cannot start while a turn runs.

The footer shows how full the context is: `ctx 12.5k/1.0M (1%)`.

Circle also trims what it sends, without touching the stored conversation:

- A tool result over 80,000 characters is saved in the data folder (`large_tool_results/`), and the model gets its first 1,600 characters and a path to read the rest with `read_file`.
- Once the tool output older than the most recent 40,000 tokens adds up to at least 20,000 tokens, it is shortened to its first 160 characters and a note, in one batch. Answers to questions, loaded skills, results that are a whole JSON document, attachments and the latest plan are kept. Images and PDFs are left out of requests by their own rule: see [Images and screenshots](usage.md#images-and-screenshots). `CIRCLE_PRUNE_TOOL_OUTPUTS=0` stops new batches; `CIRCLE_PRUNE_PROTECT_TOKENS` changes the 40,000.

Reminders Circle adds for the model (about the plan, a loop, waiting jobs) are kept apart from your messages and are not shown in the conversation or in Markdown and HTML exports.

## Export and import

| Command | What it does |
|---|---|
| `/export [path]` | Write the conversation as Markdown, as it is on screen. Default: `exports/` in the data folder. A relative path is inside the workspace. |
| `/export html`, `/export <file>.html` | Write it as one web page: your messages, the answers, and thinking and tool calls folded. It follows the browser's light or dark setting, and shows images. |
| `/export jsonl`, `/export <file>.jsonl` | Write the whole session for `/import`: every branch, the point you are at, labels, compactions, costs and the subagents' records. A checksum at its end detects a changed file. Not while a turn or a background subagent runs. |
| `/import <file>.jsonl` | Start a new session from a JSONL export. The model remembers it exactly, and `/tree`, `/fork` and `ctrl+o` work on it. Nothing runs: no model call, tool or job. |
| `/import <file>` | Any other text file starts a new session with its text on screen; the first 8,000 characters are given to the model as earlier context. |
| `/share` | Write a Markdown copy under `shares/` in the data folder and copy its path. Nothing is uploaded. |
| `/unshare` | Delete that copy. |

`circle --export <id> [file]` writes a saved session without opening it: HTML by default, as `<id>.html` in the current folder, or a JSONL bundle when the file name ends in `.jsonl`.

`/import` also reads the JSONL exports of Circle 0.5.0 and older. Those versions cannot read the exports of this one.

## Sessions from 0.5.0

Circle 0.5.0 and older kept sessions in `sessions.sqlite` and `checkpoints.sqlite` in the same data folder. Each time Circle starts it imports the ones it has not imported yet into `circle.sqlite`, with their titles, branches, labels and the subagents' records, and they show in `/resume` as before. The old files are read, never changed, and a copy of what was read is kept in `migration-backups/`. A session that cannot be imported is named in a red line (on standard error without the full-screen interface), and the others still come over. A session you delete is not imported again. Details are in [Session data migration](development/migration-data.md).

## Prompt history

Your messages are saved in `history` in the data folder (last 1,000). `↑` and `↓` walk through them and `ctrl+r` searches. `CIRCLE_HISTORY_PATH` keeps it somewhere else.

## Subagent records

While subagents run, a strip below the footer lists them. Press `↓` in an empty prompt to select one, `enter` to open its record, `←` `→` to switch between subagents and `esc` to go back. Clicking a subagent's row in the conversation opens its saved record, also after a restart. A record only shows what the subagent did; it does not start it again.

## What does not carry over

These are limits of the current version:

- **Going back does not undo file changes.** `/tree` and `/fork` change the conversation, not your files.
- **`/undo` and `/redo` do not change the model's memory or your files.** Use `/tree` to go back for the model.
- **The undo history is kept in memory only.** The tree is read from the saved messages, so it survives a restart; `/undo` does not.
- **A session closed while a card was waiting** reopens without the card. Send a message to go on.
- **`auto` mode is not saved** with the session. See [Security](security.md#auto-mode).
- **Background jobs end with Circle.** A reopened session has none running; when you left normally, the conversation has a note naming the jobs that were stopped. A job of another session goes on while you switch with `/resume` or `/new`. Its completion stays with the originating session and can continue that session in the background when its queue and input permit; it does not switch the view. See [Background jobs](background-jobs.md).

---
name: pr-review
description: Work through a pull request review: its checks, diff, reviews and comments, then answer the threads. Use when a PR is reviewed or a check is red.
---

# Work through a pull request review

Run each command on its own. The commands here work the same in PowerShell, cmd and POSIX shells; keep yours that way, with double quotes and without `&&`, `$(...)` or redirection.

This skill reads a pull request and answers what it finds. It does not open one: that is create-pr. It does not push, merge or approve unless the person asks in this conversation.

## 1. Find the pull request

`gh` must be installed and signed in. If it is not, stop and tell the person to install it from https://cli.github.com and run `gh auth login` in their own terminal. Do not guess and do not work around it.

- `git branch --show-current` names the branch you are on.
- `gh pr view --json number,state,url,isDraft,reviewDecision,mergeable` shows the pull request for that branch, its state and its review verdict.

If no open pull request belongs to the branch, say so and ask which one to read: never invent a number. If the person gave a number, pass it: `gh pr view 217 --json number,state,url,reviewDecision`.

## 2. Read all four things before you change anything

| Look at | Command | What the answer means |
|---|---|---|
| CI | `gh pr checks` | exits non-zero while a check fails or is pending: that is the answer, not your error. Read which check, what state, how long |
| A failing check's log | `gh run view <run-id> --log-failed` | the failing line is the evidence, not the check's name. Quote what it actually said |
| The diff | `gh pr diff` | the whole patch. If it is large, say what you skipped rather than pretending to have read it |
| The review | `gh pr view --json reviews,comments` | reviews and comments; a thread that is unresolved is a question or a request nobody has answered. `reviewDecision` says whether a review blocks the merge |

Sort what you found into three lists and tell the person what is on each:

1. checks that are red;
2. review requests that need a code change;
3. review questions that need an answer and nothing else.

Do not start editing files while the checks are still pending and no reviewer has asked for anything: there is nothing to fix yet.

## 3. Fix what the review and the checks asked for

- A red check: get the command that failed out of its log and run it yourself. Fix the cause. Never silence a check to make it green — no skipping, no deleting the assertion, no loosening it, no rerunning a queued run. That is the failure this skill exists to catch. Follow the repository's own rules on failing tests (AGENTS.md, CONTRIBUTING.md), and if a check fails only sometimes, say so with the evidence rather than retrying it until it passes.
- A review request that means a change: make it, run what you can run, and commit it the way the repository does. Do not amend or force-push a commit a reviewer has already read: add a commit, so the review stays readable.
- A review question, or a reviewer who disagrees with the person: answer it on the pull request. You may say what you did and why; you may not decide for the reviewer. Where the person's instructions and a reviewer's request conflict, show the conflict to the person instead of picking a side quietly.

Stage explicit paths, as create-pr says. Never `git add -A`, never `git commit -a`, never `--no-verify` unless the person said so.

## 4. Answer where the thread is

Answer each item with one comment per thread, not one comment that bundles everything, and answer in the thread the comment was made in:

- `gh pr comment <number> --reply-to <comment-id> --body-file <file>` replies to a comment thread.
- `gh pr review <number> --comment --body-file <file>` answers a review that asked for changes without approving it.
- Write the body with your file tool to a file outside the repository, such as in the system's temporary folder, and pass that path, so no shell has to quote it.

Say what you changed and where: the commit, and the file and line it now reads at, so the reviewer does not have to re-read the diff. Where you did not do what they asked, say why and leave it for them. Resolving a thread is the reviewer's call: do not resolve it yourself unless the repository says otherwise.

## 5. Report

End with what you did and what you did not:

- the commands you ran and what each showed, and plainly the ones you did not run;
- the threads you answered, with the URLs each `gh` call returns;
- what is still on the three lists;
- the state now: `gh pr view --json state,mergeable,reviewDecision` and `gh pr checks` again.

Never merge the pull request, approve it, turn on auto-merge or mark it ready for review unless the person asked in this conversation. A review that blocks the merge is theirs to lift.
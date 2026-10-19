---
name: create-pr
description: Commit the work, push the branch and open or update a draft pull request with the GitHub CLI. Use when asked to create, open or update a pull request.
---

# Create or update a pull request

Run each command on its own. The commands here work the same in PowerShell, cmd and POSIX shells; keep yours that way, with double quotes and without `&&`, `$(...)` or redirection.

## 1. Look first

- `git status` shows the changes; `git branch --show-current` names the branch.
- `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name` names the default branch.
- `gh auth status` says whether the GitHub CLI is installed and logged in.

If `gh` is not installed, stop and tell the user to install it from https://cli.github.com and then run `gh auth login`. If it is not logged in, stop and tell the user to run `gh auth login` in their own terminal. Do not guess and do not work around it. If there is no remote to push to, or gh asks which repository to use, ask the user.

If the working tree is clean and `git log --oneline origin/<default>..HEAD` lists no commits, there is nothing to open a pull request for: say so and stop.

## 2. Use a branch of its own

Never commit to, push or open a pull request from the default branch. If you are on it, create a branch first with a short name that says what the change is, in the form the repository's branches use, for example `git switch -c fix/login-timeout`. Uncommitted changes come along.

## 3. Commit only what belongs to the work

- Read `git diff` and decide which files are part of this work. Stage them by path with `git add -- <path> <path>`. Never `git add -A`, `git add .` or `git commit -a`.
- Never commit secrets (`.env` files, keys, tokens, credentials) or files that are not part of the work, such as changes the user did not make or ask for. Leave them out and say so.
- If there are many changes unrelated to the task, list them and ask before including them.
- Check `git diff --staged` before you commit.
- Write the message in the repository's style: read AGENTS.md and CONTRIBUTING.md if they exist and the recent commits (`git log --oneline -10`), and follow them, including a sign-off (`git commit -s`) or trailer they ask for. Use one `-m "..."` per paragraph.
- If a hook rejects the commit, fix the cause. Do not skip hooks (`--no-verify`) unless the user says so.

## 4. Push

Push with upstream tracking: `git push -u origin <branch>` the first time, `git push` after. If the push is rejected, stop and tell the user why. Never force-push (`--force`, `--force-with-lease`) or rewrite pushed commits without asking.

## 5. Open or update the pull request

Run `gh pr view --json number,state,url,isDraft`.

- If it shows an OPEN pull request, the push has updated it: do not create another. If the user asked for a new title or description, use `gh pr edit --title "<title>" --body-file <file>`.
- Otherwise (no pull request, or only a closed or merged one), create a draft: `gh pr create --draft --title "<title>" --body-file <file>`.

The title is short and specific, in the style of the commits. The body says:

- what changed and why;
- how it was checked: the commands you ran and what they showed, and plainly what you did not run;
- anything a reviewer should look at closely.

If the repository has a pull request template (`pull_request_template.md` in `.github/`, `docs/` or the root, any case, or a `PULL_REQUEST_TEMPLATE` folder), use its headings and fill in its checklist honestly. Write the body with your file tool to a file outside the repository, such as in the system's temporary folder, and pass that path, so no shell has to quote it.

Never merge the pull request, turn on auto-merge or mark it ready for review unless the user asks.

## 6. Report

End with the pull request's number and URL, and whether you created or updated it. If CI is already running, give its state from `gh pr checks`; it exits non-zero while checks fail or are pending, so read its output rather than treating that as your error. A draft may have no checks yet; say so.

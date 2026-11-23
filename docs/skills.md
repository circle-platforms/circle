---
nav_order: 12
---

# Skills

A skill is a folder with a `SKILL.md` file: instructions Circle loads only when a task needs them. Skills keep the system prompt small while giving Circle specialised knowledge, such as how to use a tool or how your team writes a changelog.

Circle uses the common Agent Skills format, so skills written for other agents work.

## Write a skill

Create `<name>/SKILL.md` in one of the [skill folders](#where-skills-live):

```markdown
---
name: changelog
description: Write a changelog entry in this project's format. Use when asked to update CHANGELOG.md or prepare a release.
---

# Changelog entries

Add entries under `## Unreleased`, newest first, one line each ...
```

- Give it a `name` and a `description`. Without a `name`, or with one that is not lowercase letters, digits and hyphens, the folder name is used; without a `description`, the model sees only `Skill from <folder>`.
- The name should match the folder name.
- The description is what Circle reads to decide whether the skill applies, so say **what it does and when to use it**. Descriptions are cut at 1,024 characters.
- Put scripts, templates and references next to `SKILL.md` and mention them in the text by relative path. When the skill is loaded, the model is told the skill's folder, so it can find them. Circle never runs bundled scripts by itself. Hooks in the `SKILL.md` frontmatter are the exception: after this session loads the skill, Circle runs those commands at the hook events. See [Skills and packs](hooks.md#skills-and-packs). An installed pack can also define subagents in an `agents` folder, offered as `<pack>:<name>` from the start of a session. See [A pack can ship subagents](agents.md#a-pack-can-ship-subagents).

A skill is a folder below the skills folder, `skills/changelog/SKILL.md`, or one level deeper inside a folder that has no `SKILL.md` of its own, `skills/team/changelog/SKILL.md`.

Circle reads these keys of the frontmatter:

| Key                | Needed                      | What it does                                                                                                                                                                                                                        |
| ------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`             | no: the folder name is used | lowercase letters, digits and hyphens                                                                                                                                                                                               |
| `description`      | no, but write one           | what the skill does and when to use it, cut at 1,024 characters                                                                                                                                                                     |
| `allowed-tools`    | no                          | tools that run without an approval card in the turn that loads the skill. A string with commas or spaces between the names, or a YAML list. See [Tools a skill pre-approves or withholds](#tools-a-skill-pre-approves-or-withholds) |
| `disallowed-tools` | no                          | tools the model is not offered in that turn. The same forms                                                                                                                                                                         |

Any other key, such as Claude Code's `model` or `context`, is left alone, so a skill written for another agent still loads.

## How Circle uses skills

Circle puts each skill's name and description in the system prompt. When a task matches, the model calls the `skill` tool (or reads the file), and follows it. Skills load only what a task needs.

The `skill` tool can also read a supporting file with `reference`, relative to the selected skill's `references/` directory: `{ "name": "circle-help", "reference": "docs/configuration.md" }`. It reads that file without granting access to other files. Absolute paths, parent traversal, links outside the skill's references directory and configured credential files are refused. This works in the terminal and desktop, including documents inside the packaged application.

You can also load one yourself:

```text
/skill                     list the skills Circle can see, and where each comes from
/skill changelog           load one for the rest of the conversation
/skill:changelog v0.2.0    load it and pass an argument
```

A skill loaded this way is added to the conversation without starting a turn; the model reads it with your next message and follows it "until the user says otherwise". Typing `/skill:` in the input box lists the skills too. `/skill` shows a skill's `allowed-tools` and `disallowed-tools` under it, and the desktop application's skills page shows them under the file's path.

Circle reads the skill folders again each time it builds the system prompt: when a session starts, on `/new`, `/resume`, `/reload`, a change of model or thinking depth, and `/plan`. The list in the prompt and the model's `skill` tool always come from the same reading. `/skill` reads them each time, so a skill added during a session can be loaded at once.

## Built-in skills

Circle ships with ten skills of its own. Their descriptions are available by default, and their instructions load when used.

| Skill             | When to use it                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `circle-help`     | Questions about Circle usage, configuration or troubleshooting. Builds carry the same version's full docs under this skill's `references/docs/`; source checkouts use the repository docs. |
| `skill-creator`   | Create or improve a skill and check discovery and loading. The default destination is the project's `.circle/skills/`; a global skill goes in the active Circle data folder.               |
| `verify`          | Validate a change against the requested behavior, with tests and relevant runtime effects.                                                                                                 |
| `code-review`     | Review a diff, branch or PR for supported correctness issues.                                                                                                                              |
| `debug`           | Diagnose an error or regression through reproduction and runtime evidence.                                                                                                                 |
| `security-review` | An explicit security review, audit or secure coding request.                                                                                                                               |
| `frontend-design` | Create or improve a web or desktop frontend using the project's own design language.                                                                                                       |
| `browser-test`    | Exercise a web flow with Circle's existing browser tools; save and repeat flows using its recording and replay format when requested.                                                      |
| `create-pr`       | Open or update a draft pull request.                                                                                                                                                       |
| `pr-review`       | Address an existing PR's checks and review feedback.                                                                                                                                       |

Code and security reviews report findings by default; when you also ask for repairs they continue with fixes and verification. A skill is guidance for the model, not an extra execution engine. Browser tests need the [browser tools](tools.md#the-browser): desktop, or the full-screen terminal with a supported browser installed. They are unavailable in line and print mode. A skill reports that missing capability rather than treating another kind of check as browser validation.

**`create-pr`** commits the work, pushes the branch and opens a draft pull request, or updates the one already open for the branch. It first checks `git status`, the branch, the default branch and `gh auth status`, and when `gh` is missing or not logged in it stops and tells you to run `gh auth login`. It never opens a pull request from the default branch, stages only the files that belong to the work, and never merges or force-pushes without asking. It ends with the pull request's number and URL. Ask Circle to open a pull request, or load it with `/skill create-pr`.

**`pr-review`** works through a pull request that has been reviewed. It reads four things before it changes anything: the checks with `gh pr checks`, the failing run's log with `gh run view <run-id> --log-failed`, the whole patch with `gh pr diff`, and the reviews and comments with `gh pr view --json reviews,comments`. It sorts what it finds into red checks, review requests that need a change, and questions that need an answer. It runs the command a red check failed on and fixes the cause instead of silencing the check, adds a commit rather than rewriting one a reviewer has already read, and answers one thread at a time with `gh pr comment --reply-to`, taking the text from a file outside your work. It reports what it did not do, and never merges, approves, turns on auto-merge or marks a draft ready for review unless you ask in the conversation. Ask Circle to address a review, or load it with `/skill pr-review`.

Both run the GitHub CLI (`gh`) as an ordinary command, so every `gh` call asks for approval like any other command, and both stop and say what to install when it is not there. This is the same in the terminal and in the desktop application, where the model's commands see the `gh` of your `PATH`. The window reaches GitHub a second way beside it: its pull request card and the `github_*` tools of the [GitHub connection](extensions.md#an-interface-in-the-desktop-application) use the copy of `gh` Circle installs for itself and the sign-in given in the plugin. Those read a task's checks and failed logs and publish its draft; reading and answering a review is `gh` in a conversation, in either program.

Built-in skills come with the program itself, in its `builtin_skills` folder, so they change when Circle is updated. They are the lowest-priority source: a skill of the same name in any of the folders below replaces one. To change one of them, put your own `create-pr/SKILL.md` or `pr-review/SKILL.md` in one of those folders, starting from a copy of Circle's (under `src/builtin_skills/` in its repository). `/skill` marks a built-in skill `(Built-in)`, and the desktop application's skills page marks it bundled.

## Where skills live

Circle looks in all of these. If two skills have the same name, the one lower in the table wins.

| Folder                                   | Scope                                 |
| ---------------------------------------- | ------------------------------------- |
| Shipped with Circle (`builtin_skills`)   | Built-in, lowest priority             |
| `~/.agents/skills`                       | You, shared with other agents         |
| `~/.claude/skills`                       | You, shared with Claude Code          |
| `~/.config/opencode/skills`              | You, shared with OpenCode             |
| `~/.pi/agent/skills`                     | You, shared with pi                   |
| `~/.circle/skills`                       | You, Circle only (in the data folder) |
| `.agents/skills` in the workspace folder | Project                               |
| `.opencode/skills`                       | Project                               |
| `.pi/skills`                             | Project                               |
| `.claude/skills`                         | Project                               |
| `.circle/skills`                         | Project, Circle only                  |
| `.agent/skills`                          | Project, highest priority             |

Project skills apply once you trust the folder, and only from that folder. A parent folder's `.agents/skills` is not loaded. A skill can tell the model to do anything, so read the skills in a repository before you trust it.

## Install skills

Skills from the [skills.sh](https://skills.sh) ecosystem install with `npx`. Circle is not yet in that tool's list of agents, so install as the `amp` agent, which writes to `.agents/skills`, a folder Circle reads:

```bash
npx skills add <owner/repo> --skill <name> -a amp -y
```

To share a skill with several tools at once, add them to the list: `-a amp,cursor,codex`.

For a skill only you use, copy it into `~/.circle/skills/<name>/`.

## A skill can ship hooks

A skill's hooks are `hooks:` in its `SKILL.md` frontmatter. They do not run because the skill is installed: they start when this session loads the skill, with `/skill` or the `skill` tool, and run for the rest of it. A project skill's hooks also wait until the folder is trusted. An installed pack can also have `hooks/hooks.json`, which runs in every session while it is installed. Their hooks run in the workspace and find the skill's own scripts through `${CIRCLE_SKILL_DIR}`, best as `"command": "node", "args": ["${CIRCLE_SKILL_DIR}/scripts/log.mjs"]`. See [Skills and packs](hooks.md#skills-and-packs).

## Tools a skill pre-approves or withholds

`allowed-tools` and `disallowed-tools` are Claude Code's skill fields of the same names, so a skill written for Claude Code keeps its meaning here.

```markdown
---
name: commit
description: Stage and commit the current changes. Use when asked to commit.
allowed-tools: Bash(git add *) Bash(git commit *) Bash(git status *)
disallowed-tools:
  - AskUserQuestion
---
```

- **`allowed-tools` pre-approves.** The tools it names run without an approval card in the turn that loads the skill. It restricts nothing: every tool stays available, and everything it does not name asks as it always did. Loading the skill again applies it again.
- **`disallowed-tools` withholds.** The tools it names are not offered to the model for the same time. A call to one is answered as a call to any tool that is not there: `tool is not available`.

Both fields hold from the moment the skill is loaded to the next message you send. The skill's instructions stay in the conversation after that, and its [hooks](hooks.md#a-skill-can-ship-hooks) stay for the session; only these two fields end. The model loading a skill with the `skill` tool applies them from its next request. A skill you load yourself, with `/skill` or by adding it to a session in the desktop application, is read with your next message, so the fields apply to the turn that message starts and end with the message after it. A message you send while a turn runs ends them too, when the model reads it (a steering message) or when its turn starts (a follow-up). Switching to another conversation (`/new`, `/resume`, `/fork`, `/clone`, `/import`) drops them.

**What a pre-approval skips.** Only an ordinary approval card, as a [hook's allow](hooks.md#events) does. It does not skip a call that always asks (deleting files, `rm -rf`, a force push, a destructive MCP tool), a command Circle refuses (`sudo`, a credential file) or a rule that denies it, a hook that asked or denied, or [read-only mode](security.md#read-only-mode): a write the skill named is still refused there. Where nobody can answer a card, in print mode, a named tool runs, and a call to anything else that would ask is not run, as without the skill.

**Names.** Circle's tool names work as they are, including MCP and extension tools. Claude Code's names work too, for the tools Circle has under other names:

| Claude Code             | Circle                  |
| ----------------------- | ----------------------- |
| `Bash`                  | `execute`               |
| `Read`                  | `read_file`             |
| `Write`                 | `write_file`            |
| `Edit`                  | `edit_file`             |
| `Glob`, `Grep`          | `glob`, `grep`          |
| `WebFetch`, `WebSearch` | `webfetch`, `websearch` |
| `Task`, `Agent`         | `task`                  |
| `Skill`                 | `skill`                 |
| `TodoWrite`             | `write_todos`           |
| `AskUserQuestion`       | `question`              |

`Edit` does not cover `apply_patch`, which is a tool of its own: name it too. `compact_conversation` is always offered, so a skill cannot withhold it.

**Patterns.** `Bash(git add *)`, or `execute(git add *)`, pre-approves only the commands the pattern covers. It matches as an [`allowed_commands`](security.md#command-patterns-in-settings) pattern does: `*` and `?`, and every part of a command joined with `&&`, `;` or a pipe has to match, so `git add . && git push` is not covered by `git add *`. Claude Code's older spelling `Bash(git add:*)` is read as `git add` and `git add *`. A pattern on another tool that can ask, such as `Write(src/**)`, is not applied. On a tool that only reads, such as `Read(./src/**)` or `WebFetch(domain:example.com)`, a pattern changes nothing, since that tool never asks. `disallowed-tools` withholds whole tools: `Bash(rm *)` there is not applied.

**A name that is not a tool.** Names are checked against the tools the session has when the skill is loaded, so load the MCP server or the extension first. A name that is not a tool, an entry Circle cannot apply, and a pattern it does not support are not ignored. `/skill` lists them under `Not applied:`, as `/agents` lists a file it passed over, and loading the skill says so: in the notice for `/skill`, below the skill for the model, and on the desktop application's skills page. The skill still loads and the rest of its fields still apply, since a grant of fewer tools asks as it always did:

```
Not applied:
  commit names tools that do not exist in allowed-tools: Wrench · not applied
```

**Subagents.** A subagent started with `task` while the fields hold is not offered what `disallowed-tools` withholds, for as long as it lives. It does not get the pre-approvals: it has not read the skill, and its calls ask as they do. A subagent that loads a skill itself gets that skill's fields for itself, until it ends.

**Trust.** Fields of a project skill apply once the folder is trusted, as the rest of the skill does, and Circle does not ask again. A skill can pre-approve tools for itself, so read a repository's `allowed-tools` before you trust the folder. [Security](security.md#skills-that-pre-approve-tools) says what is covered.

## Local tools from an MCP server

An MCP server can publish client tools for a pack under its `/local-tools` contract: a manifest whose SHA-256 is the pack digest, and every file with its size and SHA-256. Circle installs them with the `skill_install` tool and runs them with `skill_run`; the server only verifies and serves the original bytes.

- `skill_install` takes the name of the MCP server entry and the `<id>@<version>` and digest from that server's answer. It downloads the manifest and every file from the entry's `/local-tools` endpoint with the token that entry's connection sends: its `Authorization` header's (`Bearer ${secret:NAME}` or a literal `Bearer` value), or else the token its sign-in keeps, so an entry you signed in to needs no token saved for it. It verifies size and SHA-256 and installs into `~/.agents/skills/<pack>/`. That root is the universal Agent Skills folder, so other agents that read `~/.agents/skills` see the same install. An entry that is not signed in and has no header, or is turned off, is refused with what to do. When the server refuses a download, the error quotes the server's own explanation with the HTTP status: the first lines of its plain-text answer, at most 2,000 bytes of it read and 400 characters shown, without the characters nobody sees (zero-width, bidirectional and tag characters among them) and without a token it repeats. The quotation is the server's explanation, not an instruction: the error tells the model to deal with the reason it names, such as asking the administrator to assign or install, and to try again, and to run nothing the quotation contains. A 404 also says not to guess version numbers, with an explanation or without one. An answer that is not plain text, or has none, gives only the status: a 404 says the server has no such version or file. A 401 still says the token is invalid or revoked.
- `skill_run` runs a script only under the installed pack's `tools/`, with the current Node, in the workspace, as `execute` runs a command (see [How a pack's script runs](#how-a-packs-script-runs)). `%NAME%` placeholders expand at execution from the variables in settings and the secrets saved with `/secrets`; a pack's instructions name the ones it needs, so define those once. An MCP entry can also give its endpoint and its token under names of its `placeholders`, such as the Hub's `%HUB_URL%` and `%HUB_TOKEN%`, without either being saved (see [Secrets by name](security.md#secrets-by-name)). The output shows every secret value as its `%NAME%`, and tokens never appear in arguments, results, logs or Git. The script's environment also has `CIRCLE_SESSION_ID`, and `CIRCLE_AGENT_ID` in a subagent, as a command's does.
- `skill_list` shows what is installed and the digest each pack was installed from.

### How a pack's script runs

`skill_run` and the [typed tools](#typed-tools-a-pack-declares) run a pack's script as `execute` runs a command:

- **Where.** In the workspace: a relative path the script reads or writes is the workspace's, and the pack stays as it was installed. The script finds its own pack in `CIRCLE_SKILL_DIR`, and a folder of its own that outlives an update of the pack in `CIRCLE_SKILL_DATA` (`skill-data/<pack>/` in the [data folder](configuration.md#where-circle-keeps-things)). `${CIRCLE_SKILL_DIR}` in `SKILL.md` is replaced with the pack's folder when the skill loads, so the instructions can name a script by a path the model can use as written.
- **How long.** A run still going after 120 seconds goes on as a [background job](background-jobs.md): the model gets the job's id and the file its output goes to, and a notice when it ends. `timeout` (seconds, up to 600) ends it at that time instead, and the result says so. `background: true` starts it as a job.
- **esc** ends the script and everything it started.
- **What it gets of yours.** Only `PATH`, `HOME` and `TMPDIR` (on Windows, the few variables a program needs to start), the variables in settings, and what the declaration adds. Your other environment variables do not reach it.
- **Its output** comes back as `execute`'s does: standard output and standard error together, then the exit code.

A folder under `~/.agents/skills` without a `pack.json` is a skill of yours, not a pack: loading it says nothing of tools.

### Typed tools a pack declares

A pack can declare its scripts' parameters in a `tools.json` at its root, listed in `pack.json` like its other files, so the pack's digest covers it. When this session loads the pack's skill, each declared script becomes a tool of its own, named `<pack>_<name>`, from the next model request on. Before that, and for a script the pack does not declare, `skill_run` works as above.

```json
{
  "version": 1,
  "tools": [{
    "name": "convert",
    "description": "Convert a text file to PDF or HTML.",
    "script": "tools/convert.mjs",
    "input_schema": {
      "type": "object",
      "properties": {
        "in": { "type": "string" },
        "format": { "enum": ["pdf", "html"] },
        "title": { "type": "string" }
      },
      "required": ["in", "format"]
    },
    "args": ["--in", "{in}", "--format", "{format}", { "flag": "--title", "param": "title" }],
    "env": { "HUB_TOKEN": "%HUB_TOKEN%" }
  }]
}
```

- **The input.** `input_schema` is a small part of JSON Schema: an object whose properties are strings, numbers, integers, booleans or lists of strings, with `enum`, `default`, limits and `required`. `$ref` and other keywords are refused. Circle checks a call against it before the script starts, and a call that does not fit gets the reason, such as a `format` that is not `pdf` or `html`. A property the schema does not name is refused.
- **The arguments.** `args` is a template. A literal string stays as written, with plain variables' `%NAME%` filled in. `"{in}"` is the value of a required property; a list gives one argument per item. `{ "flag": "--title", "param": "title" }` is `--title <value>` when the call gives one, the flag alone for `true`, and nothing when it gives none or `false`. An optional property is only allowed in that form. `"stdin": "json"` also writes the whole input to standard input as JSON. A value that starts with `-` can look like an option to the script: put `"--"` before positional values in `args`, or limit the property with `pattern`.
- **Values the model never sees.** `env` adds variables to the script's environment. `%NAME%` there takes a variable's or a secret's value when the script starts. A secret goes nowhere else: a literal in `args` never takes a secret's value, because a command line is visible to other processes. What the model writes is checked against the schema and runs as written, so `%NAME%` there stays as written, for variables and secrets alike. The script's output shows every secret value as its `%NAME%`. `PATH`, `HOME`, `TMPDIR`, `NODE_OPTIONS`, `CIRCLE_SKILL_DIR` and `CIRCLE_SKILL_DATA` cannot be set, and the input cannot have a property named `timeout` or `background`: every typed tool takes those two as `execute` does.
- **Checks when the skill loads.** The pack must verify against its manifest, and `tools.json` must be valid: unique names, scripts under `tools/` that the pack lists, and a template that names only declared properties. Otherwise the pack offers no tool and the model is told why. A built-in tool, an MCP server's and an extension's keep their names: a pack's tool with the same name is not offered, also when the other tool arrives later.
- **Approval.** A typed tool runs like `skill_run`: its card shows the input by name, the approval rules and hooks match its own name, and `tool_input` is the named input. Once a script has a typed tool in this session, `skill_run` refuses it and names the tool.

A subagent that loads the skill itself gets the pack's tools from its next request, those it may have: `explore`, which only reads, is told the tools are not its own. So does a subagent whose definition [preloads the skill](agents.md) with `skills`. Subagents started after the skill loaded have them from the start.

The tools belong to the session that loaded the skill, like its hooks: switching, importing or starting another session leaves them out until the skill is loaded there. Loading the skill again tells the model again which tools it has. Loading it adds tools to the list, so the next request does not reuse the prompt cache of the requests before.

Installing and running a pack executes the publisher's Node code; a server-side scan is not a sandbox. Read the pack before installing it, and treat what runs locally as a preview: the serving side's recomputation is the evidence.

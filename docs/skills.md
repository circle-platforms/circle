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
- Put scripts, templates and references next to `SKILL.md` and mention them in the text by relative path. When the skill is loaded, the model is told the skill's folder, so it can find them. Circle never runs bundled scripts by itself. A `hooks.json` next to `SKILL.md` is optional and is the exception: after this session loads the skill, Circle runs those commands at the hook events. See [Hooks](hooks.md#a-skill-can-ship-hooks).

A skill is a folder below the skills folder, `skills/changelog/SKILL.md`, or one level deeper inside a folder that has no `SKILL.md` of its own, `skills/team/changelog/SKILL.md`.

## How Circle uses skills

Circle puts each skill's name and description in the system prompt. When a task matches, the model calls the `skill` tool (or reads the file), and follows it. Skills load only what a task needs.

The `skill` tool can also read a supporting file with `reference`, relative to the selected skill's `references/` directory: `{ "name": "circle-help", "reference": "docs/configuration.md" }`. It reads that file without granting access to other files. Absolute paths, parent traversal, links outside the skill's references directory and configured credential files are refused. This works in the terminal and desktop, including documents inside the packaged application.

You can also load one yourself:

```text
/skill                     list the skills Circle can see, and where each comes from
/skill changelog           load one for the rest of the conversation
/skill:changelog v0.2.0    load it and pass an argument
```

A skill loaded this way is added to the conversation without starting a turn; the model reads it with your next message and follows it "until the user says otherwise". Typing `/skill:` in the input box lists the skills too.

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

`hooks.json` in the skill folder does not run just because the skill is installed. Those commands run only after this session loads the skill, with `/skill` or the `skill` tool, and only for that session. A project skill's hooks also wait until the folder is trusted and that file's bytes are approved. A skill without that file is unchanged. A skill's `hooks.json` supports per-platform commands the same way as any other hooks file. Its hooks run in the workspace and find the skill's own scripts through `CIRCLE_SKILL_DIR` (or `skill_dir` in their JSON), written as `node "${CIRCLE_SKILL_DIR}/scripts/log.mjs"`. See [Hooks](hooks.md#a-skill-can-ship-hooks).

## Local tools from an MCP server

An MCP server can publish client tools for a pack under its `/local-tools` contract: a manifest whose SHA-256 is the pack digest, and every file with its size and SHA-256. Circle installs them with the `skill_install` tool and runs them with `skill_run`; the server only verifies and serves the original bytes.

- `skill_install` takes the name of the MCP server entry and the `<id>@<version>` and digest from that server's answer. It downloads the manifest and every file from the entry's `/local-tools` endpoint with the token that entry's connection sends: its `Authorization` header's (`Bearer ${secret:NAME}` or a literal `Bearer` value), or else the token its sign-in keeps, so an entry you signed in to needs no token saved for it. It verifies size and SHA-256 and installs into `~/.agents/skills/<pack>/`. That root is the universal Agent Skills folder, so other agents that read `~/.agents/skills` see the same install. An entry that is not signed in and has no header, or is turned off, is refused with what to do.
- `skill_run` runs a script only under the installed pack's `tools/`, with the current Node. `%NAME%` placeholders expand at execution from the variables in settings and the secrets saved with `/secrets`; a pack's instructions name the ones it needs, so define those once. An MCP entry can also give its endpoint and its token under names of its `placeholders`, such as the Hub's `%HUB_URL%` and `%HUB_TOKEN%`, without either being saved (see [Secrets by name](security.md#secrets-by-name)). The output shows every secret value as its `%NAME%`, and tokens never appear in arguments, results, logs or Git.
- `skill_list` shows what is installed and the digest each pack was installed from.

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
- **The arguments.** `args` is a template. A literal string stays as written, with plain variables' `%NAME%` filled in. `"{in}"` is the value of a required property; a list gives one argument per item. `{ "flag": "--title", "param": "title" }` is `--title <value>` when the call gives one, the flag alone for `true`, and nothing when it gives none or `false`. An optional property is only allowed in that form. `"stdin": "json"` also writes the whole input to standard input as JSON.
- **Values the model never sees.** `env` adds variables to the script's environment. `%NAME%` there takes a variable's or a secret's value when the script starts. A secret goes nowhere else: a literal in `args` never takes a secret's value, because a command line is visible to other processes, and `%NAME%` in what the model writes stays as written. The script's output shows every secret value as its `%NAME%`. `PATH`, `HOME`, `TMPDIR` and `NODE_OPTIONS` cannot be set.
- **Checks when the skill loads.** The pack must verify against its manifest, and `tools.json` must be valid: unique names, scripts under `tools/` that the pack lists, and a template that names only declared properties. Otherwise the pack offers no tool and the model is told why. A tool whose name is already taken is not offered.
- **Approval.** A typed tool runs like `skill_run`: its card shows the input by name, the approval rules and hooks match its own name, and `tool_input` is the named input. Once a script has a typed tool in this session, `skill_run` refuses it and names the tool.

Loading the skill adds tools to the list, so the next request does not reuse the prompt cache of the requests before.

Installing and running a pack executes the publisher's Node code; a server-side scan is not a sandbox. Read the pack before installing it, and treat what runs locally as a preview: the serving side's recomputation is the evidence. Packs and skills are supported on macOS and Linux only.

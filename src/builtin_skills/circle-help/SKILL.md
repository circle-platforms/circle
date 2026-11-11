---
name: circle-help
description: Answer questions about Circle usage, configuration and troubleshooting from its bundled documentation. Use for Circle product help.
---

# Circle help

Read the documentation for the running version before answering. Use the `skill` tool with `name: "circle-help"` and `reference: "docs/<page>"`. The build includes the repository's docs, including development pages, under `references/docs/` beside this file. In a source checkout those copies are absent: read the repository's `docs/` instead (three directories above this skill's base directory); resolve an absolute path before passing it to file tools.

Choose the pages that address the question:

| Topic                        | Pages under docs/                                                  |
| ---------------------------- | ------------------------------------------------------------------ |
| Getting started, commands    | quickstart.md, cli.md, slash-commands.md                           |
| Settings, model connections  | configuration.md, settings.md, models.md, environment-variables.md |
| Permissions and file access  | security.md                                                        |
| Sessions and background work | sessions.md, background-jobs.md, scheduled-tasks.md                |
| Skills and integrations      | skills.md, mcp.md, extensions.md, hooks.md, agents.md              |
| Terminal and desktop         | interface.md, keybindings.md, desktop.md, tools.md                 |
| Reported limitations         | known-issues.md                                                    |

Distinguish the terminal from the desktop and an installed feature from an enabled or connected one. For an error, get its exact message and read the relevant instructions before proposing a change. Inspect only the settings needed for the question; keep credentials out of the answer.

Cite the page and section used. If the local documentation does not establish an answer, say what is missing; do not invent a setting, command or supported feature. Checking online material is useful when available, but identify version differences rather than replacing the installed version's instructions.

A help question calls for an explanation. If the user asks for a configuration change, inspect the existing value, make that change and verify it using the documented mechanism. Preserve unrelated configuration and the current task.

---
nav_order: 1
permalink: /
---

# Circle documentation

Circle is a coding agent. You describe a task, and Circle reads your code, runs commands and edits files in your project, asking before it does anything that changes something. It runs in the terminal, and as a [desktop application](desktop.md).

New here? Start with the [Quickstart](quickstart.md). Coming from Circle 0.5.0? Read [Upgrading from 0.5.0](#upgrading-from-050) first.

## Choose what you want to do

| I want to | Read |
|---|---|
| Install Circle and run my first task | [Quickstart](quickstart.md) |
| Install, update or move from the Python version | [Installation and updates](installation.md) |
| Use Circle in its own window | [The desktop application](desktop.md) |
| Understand what Circle does and why | [How Circle works](how-circle-works.md) |
| Connect a model or switch to another | [Choose a model](models.md) |
| Know what it may do to my machine | [Run Circle safely](security.md) |
| Find out what the screen is telling me | [The interface](interface.md) |
| Let Circle use a web page with me, such as a device's web interface | [The browser](tools.md#the-browser) |
| Give Circle a password or a value without the model seeing it | [Secrets by name](security.md#secrets-by-name) |
| Steer, stop, copy, find | [Use Circle in the terminal](usage.md) |
| Keep, reopen or branch a conversation | [Sessions and context](sessions.md) |
| Run a server, a watcher or a subagent while I keep working | [Background jobs](background-jobs.md) |
| Drive Circle from a script or an editor | [CLI: print mode and JSON events](cli.md), [RPC mode](rpc.md) |
| Teach Circle my project's rules | [Configuration](configuration.md#instruction-files) |
| Add instructions on demand | [Skills](skills.md) |
| Save a prompt as a command | [Custom commands](custom-commands.md) |
| Add tools from other programs | [MCP servers](mcp.md) |
| Add tools, commands or checks in JavaScript or TypeScript | [Build extensions](extensions.md) |
| Work on Circle itself | [Contributing](https://github.com/qingshanfeihu/circle/blob/main/CONTRIBUTING.md) and [Architecture](development/architecture.md) |
| See what does not work yet | [Known issues](known-issues.md) |

## Upgrading from 0.5.0

Circle 0.5.0 and older were written in Python; this version is written in TypeScript and carries its own Node.js. To upgrade, run the one-command installer from the [Quickstart](quickstart.md#1-install): the old `circle update` cannot install this version. The installer removes the Python copy and keeps your data folder, so settings, keys, trusted folders, MCP servers, skills, custom commands and prompt history carry over, and saved sessions are imported on the first start. Python extensions have to be rewritten in JavaScript or TypeScript. See [Replacing the Python circle](installation.md#replacing-the-python-circle), [Sessions from 0.5.0](sessions.md#sessions-from-050) and [Coming from 0.5.0](extensions.md#coming-from-050).

What you may notice afterwards:

- MCP tools ask for approval and are refused in `read-only` mode. See [MCP servers](mcp.md#security).
- `credential_files` adds to Circle's own list instead of replacing it, and file tools refuse those files too. See [Credential files](security.md#credential-files).
- There is no log file.
- Sessions are kept in `circle.sqlite`. 0.5.0 cannot import this version's JSONL exports.
- The rest is in [Known issues](known-issues.md).

## Get started

- [Quickstart](quickstart.md)
- [Installation and updates](installation.md)
- [How Circle works](how-circle-works.md)

## Guides

- [Use Circle in the terminal](usage.md)
- [The interface](interface.md)
- [The desktop application](desktop.md)
- [Choose a model](models.md)
- [Sessions and context](sessions.md)
- [Background jobs](background-jobs.md)
- [Run Circle safely](security.md)
- [Configuration](configuration.md)
- [Skills](skills.md)
- [Custom commands](custom-commands.md)
- [MCP servers](mcp.md)
- [Build extensions](extensions.md)

## Reference

- [CLI](cli.md)
- [RPC mode](rpc.md)
- [Slash commands](slash-commands.md)
- [Keyboard and mouse](keybindings.md)
- [Built-in tools](tools.md)
- [Settings](settings.md)
- [Environment variables](environment-variables.md)
- [Known issues](known-issues.md)

## Development

- [Contributing](https://github.com/qingshanfeihu/circle/blob/main/CONTRIBUTING.md)
- [Architecture](development/architecture.md)
- [Releasing](development/releasing.md)
- [The TUI contract](https://github.com/qingshanfeihu/circle/blob/main/docs/development/tui-contract.md) (in the repository, in Chinese)
- [Desktop application, from a checkout](https://github.com/qingshanfeihu/circle/blob/main/apps/desktop/README.md)
- [Desktop working notes](https://github.com/qingshanfeihu/circle/tree/main/docs/workbench) (in the repository)
- [Registering Circle in skills.sh](development/skills-registry.md)
- [Security policy](https://github.com/qingshanfeihu/circle/blob/main/SECURITY.md)
- [Changelog](https://github.com/qingshanfeihu/circle/blob/main/CHANGELOG.md)

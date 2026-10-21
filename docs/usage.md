---
nav_order: 5
---

# Use Circle in the terminal

This page covers working in a session: sending messages, answering questions, stopping work, and getting output out. For what the screen shows, see [The interface](interface.md).

## Send a message

Type in the box at the bottom and press `enter`. The box grows with your message, up to 30% of the screen, and wraps long lines. To put a line break in a message, press `shift+enter` or `ctrl+j`, or type `\` and then `enter`. For a longer message, press `ctrl+g` (or run `/editor`) to write it in your editor.

A long paste shows as `[Pasted text #1 +39 lines]` so the box stays readable, and the model gets the whole text. Your message in the conversation keeps the short form.

Type `/` and the commands it can become are listed above the input box, each with what it does; typing narrows the list. `↑` `↓` move in it, `tab` takes the marked command, `enter` takes it and runs it, and `esc` closes the list and keeps what you typed. `?` on an empty prompt shows the shortcuts. Everything else you type goes to the model. If what you type looks like a command but is not one, such as `/modles`, it is not sent: the footer says `Unknown command /modles · did you mean /models?` and your text stays in the box. A path such as `/usr/bin/env is missing` is sent as a message, and so is anything that starts with a space.

To point at a file, write `@` and part of its path. The files it can mean are listed above the input box: `@src/st` lists what is in `src/` starting with `st`, and `@stats` finds `stats.py` anywhere in the workspace (skipping `.git`, `node_modules`, build output and virtual environments). `tab` or `enter` takes the marked file; a folder lists what is in it. After `esc` closes the list, `tab` completes as far as the matches agree and lists them in the footer. When you send, each mentioned text file in the workspace of up to 64 KB is attached for the model, so it does not have to read it first, and a mentioned image or PDF goes as an attachment. [Credential files](security.md#credential-files) are left out. Your message on screen keeps the `@path`.

## Images and screenshots

To show the model a picture, put it in your message:

- **Paste it.** `ctrl+v` puts the picture on the clipboard in the box as `[Image #1]`, for example a screenshot taken with `cmd+ctrl+shift+4` on macOS or `win+shift+s` on Windows. Image files copied in Finder or Explorer go in the same way (on macOS, only the first of several). Use `alt+v` where the terminal keeps `ctrl+v` for its own paste, as Windows Terminal does. Circle reads the clipboard with `osascript` on macOS, PowerShell on Windows, and `wl-paste` or `xclip` on Linux. A pasted picture is kept as a PNG in `pasted_images/` in the project's folder in the data folder.
- **Drop the file** on the terminal. Its path arrives as a paste; when a paste is nothing but image or PDF paths, each becomes `[Image #N]` (or `[PDF #N]`).
- **Mention it** with `@`. An image or PDF can be anywhere, not only in the workspace: `@~/Desktop/shot.png`. Put a path with spaces in quotes, `@"~/Desktop/Screenshot 2026-10-11 at 10.15.32.png"`, or write each space as `\ `.

The model gets each picture with its path, so it can look at it again with `read_file`. The conversation shows your message as you saw it; the input history keeps each picture's path, so a message you recall sends the picture again. A file that cannot go (over the size limit, empty, or more than 16 pictures and PDFs in one message) is left out, and both you and the model are told which and why. A PNG larger than about 1,568 pixels on its long side is scaled down before it is sent (models scale larger ones down anyway), and the model is told both sizes.

The model can also take a screenshot itself with the `screenshot` tool: of the main screen, or of the front window of one application, to see how an app it is building looks or the problem you describe. It asks you first each time, unless you allow screenshots for the session, and it does not run in `read-only` mode or over `ssh`. On macOS the terminal needs the Screen Recording permission (System Settings → Privacy & Security → Screen Recording); without it the picture shows only the desktop. An application's window is taken by itself, without the windows over it. On Linux it takes the whole screen with `grim`, `gnome-screenshot`, `spectacle`, ImageMagick's `import` or `scrot`. `esc` stops a screenshot under way, and a model that does not read images is not given one unless a side vision model describes it (below). Screenshots are kept in `screenshots/` in the project's folder in the data folder. The tool only looks: it cannot click or type. To let the model use a web page, add a browser [MCP server](mcp.md#drive-a-browser).

Not every model reads images. When models.dev says the model in use does not, the footer says so as you paste, the model gets the paths only, and a tool that returns a picture tells it so. If models.dev is wrong about your model, set `"images": true` (or `false`) for it under `models` in the [settings](settings.md). A picture sent with a message in the desktop application (pasted, dropped, attached, or taken with **take page screenshot**) has no path of its own: for a model that does not read images Circle writes it to `images/` in the project's folder in the data folder, once for each picture, and the model gets that path.

For a model models.dev does not list, the endpoint itself can say that it takes no pictures, as in `image input is not supported`. That request then fails with the endpoint's words, and until Circle quits the conversation gives the model the pictures' paths instead, so send the message again. Nothing is written to `settings.json`: `"images": false` under `models` keeps it so for good. An error that only mentions pictures, such as one too large, too many in one message, or a context limit that counts image tokens, keeps the endpoint's own words, and pictures still go.

A side vision model can describe pictures for a model that cannot read them. Set `vision` in the [settings](settings.md) — the `base_url` and `model` of an OpenAI-compatible chat/completions endpoint, with the key in `credentials.json` under `api_key_ref` (default `vision_key`) — or give the same three parts as `CIRCLE_VISION_BASE_URL`, `CIRCLE_VISION_MODEL` and `CIRCLE_VISION_KEY` (see [Environment variables](environment-variables.md#side-vision-model)). Then `read_file` on a picture returns its description, the `screenshot` and `browser_screenshot` tools take a picture, save it and describe it, and the model can ask its own question about one with the `vision` tool. Those pictures go to the side vision model's endpoint, not the model's, and the screenshot's card says the side vision model sees the screen. PDFs still go to the model itself. Without a side vision model, the model is told honestly that it cannot look, and a screenshot is not taken.

A conversation can collect many pictures. Once a request would carry more than 8 images or PDFs, or more than 16 MB of their encoded data (about 12 MB of files), the older ones are left out of the requests until only the newest 3 remain (fewer when those are large; the newest message keeps all of its own), and the model is told which were left out. The conversation keeps them all.

## Run a command yourself

Start a message with `!` to run a shell command yourself, without a card: `!git diff`, `!pytest -q`. It is drawn like Circle's own Bash calls, `esc` stops it, and its output becomes part of the conversation, so the model sees it with your next message. No turn starts. `!!command` runs it and shows the output to you only. `ctrl+b` moves it to the background (`/jobs` lists it); its output joins the conversation when it ends.

These commands follow the same refusals as the model's: `sudo` and credential files are refused, and nothing runs in `read-only` mode. A `!` command does not run while a turn runs. Messages you send while one runs are queued.

## Answer a question

When Circle needs a decision, a card takes over the input box and the frame turns yellow and stops moving. The card is either an approval or a question from the model.

- Press the number of the option. For an approval, `y`, `a` and `n` also work, though they are not shown.
- `↑` `↓` move, `enter` confirms, `esc` gives the most cautious answer: reject, or cancel.
- `Reject and explain` turns the last row into an input. Type what Circle should do instead and press `enter`. An empty `enter` is a plain rejection. `esc` returns to the options and keeps what you typed. A `/command` runs, and the card stays.
- Keys you type while a card is up do not go to the input box, so a stray letter cannot answer for you. If you were typing a message, the card waits until you have paused for a second, and it puts your draft back when you are done.

A question from the model can have several questions. `←` and `→` move between them, `space` ticks an answer when several are allowed, and `o` lets you type your own answer.

What each approval option does is explained in [Security](security.md#approvals).

## Interrupt

Press `esc` to stop a turn. Circle marks that reply `✖ Interrupted`, in a dim line, and the mark stays on the reply. A stop before any text was written shows the same mark until the next turn starts. The footer counts text that was already streaming, and estimates the input of that step when the endpoint has not reported it. A stopped step is priced from that estimate when the model has rates, and the total then ends with `~` (`$0.0035~`) so it is not shown as a measured bill. The cache meter says `cache N/A` when cache fields were not reported, on a stop and on a finished call alike. A reported zero still reads `cache 0.0%`. A `$` total that ends in `+` still means some other call had usage and no price. An estimate with no rate does not add that `+`. A shell command that is running is ended, with everything it started, within about a second (on Windows with `taskkill`, not yet tried on a real machine). [Background jobs](background-jobs.md) keep running; a job that ends after you stopped the turn waits for your next message instead of starting a turn. `ctrl+c` also stops a turn. `ctrl+b` moves the command being waited on to the background instead of stopping it. When Circle is idle, `esc` again clears what you typed (`ctrl+y` puts it back) and `ctrl+c` clears it at once (`ctrl+c` keeps it in the history). `ctrl+d` on an empty box leaves.

A fenced code block names its language and colours keywords, strings, numbers and comments. Copying still falls back to a file when the terminal has no clipboard tool.

## Steer a running turn

You can type while Circle works. Press `enter` and the turn goes on; the model reads your message after its current step, before it decides what to do next. The message is listed above the input box as `steering: …` until the model reads it. It then appears in the conversation at the point where the model read it. If the model was about to finish, it reads the message first and goes on.

To have the model read it at once, press `enter` again on the empty input box. The step under way stops: the reply the model was writing is dropped, and a command or subagent that is running is stopped and reported to the model as interrupted. Tool results that were already in stay. A compaction under way finishes first. The model then reads your message and the turn goes on; nothing is marked `✖ Interrupted`.

If you stop the turn with `esc` or `ctrl+c`, the messages still waiting are sent next, one turn each, steering first. Take them back first if you would rather change them.

`ctrl+q` instead of `enter` queues a follow-up: the model does not see it during the turn, and it is sent as a new turn when the turn ends. Waiting messages are listed above the input box as `steering: …` or `follow-up: …`.

To change or drop a waiting message, take it back into the input box. `↑` in an empty box takes back the last one listed; send it again with `enter`, or clear the box with `ctrl+u` to drop it, and `↑` takes back the one before. `alt+↑` takes back all of them at once, ahead of what you were typing. Long pastes stay folded when they come back.

## Modes

Three modes change what Circle is allowed to do. The current one is shown in the bottom-right corner of the input box. Normal mode (`manual`, asking before each change and command) shows nothing.

| Mode | Turn on | What it does |
|---|---|---|
| `accept edits` | `/mode accept-edits` | Circle changes files inside the workspace without asking. Commands, deletes and changes outside the workspace still ask. |
| `read-only` | `/plan` or `/mode plan` | Circle can read and search, and change only a file named `plan.md`. It cannot run commands or change other files. It writes its plan to `plan.md` for you to review. The model can turn it on itself, and asks you before it turns it off: you can answer that it should then accept edits. |
| `auto` | `/yolo`, `/auto` or `/mode auto` | Circle stops asking. Every command and file change runs without a card. Use `/yolo off` to go back. |

`shift+tab` moves to the next mode: manual, accept edits, read-only, auto, and back to manual. `/mode` with no argument does the same, and works while a turn runs; `/mode manual` goes back to asking. Leaving `read-only` returns to manual. Read [Security](security.md#auto-mode) before you use auto.

A mode lives in its conversation: `/new`, `/fork`, `/clone`, `/import` and restarting drop back to manual, unless you save a default. `/settings` → `default mode` (or `default_mode` in [settings](settings.md)) picks the mode every new session starts in — including `-p`, line and RPC runs. A `read-only` state restored from a resumed conversation wins over the saved default, and `--yolo` wins over both in print and line mode.

## Fewer asks for the commands you trust

Instead of a mode, you can allow commands by pattern. `allowed_commands` in [settings](settings.md) holds wildcards (`*` and `?`); a command runs without a card when **every** part of it matches one — so `npm ci && rm -rf dist` needs both `npm *` and `rm -rf *`. A pattern answers even for a command Circle always asks about (`rm -rf`, a force push), and in print and line mode too, but nothing gets past a [refused](security.md#how-commands-are-sorted) command: naming a credential file or `sudo` still stops it. `/approvals add <pattern>` and `/approvals remove <pattern>` edit the list; `/approvals` lists it. A trusted folder's `.circle/settings.json` may add patterns of its own, on top of yours. These are broader than the per-conversation rules an approval card saves — read [Security](security.md#command-patterns-in-settings).

## The plan

When Circle plans with `write_todos`, a box above the input shows the steps: green lamp for done, yellow for the one in progress. It shows five rows and follows the current step, with nothing drawn behind them. Scroll it with the mouse wheel. It stays above a card, so when the model asks to implement the plan you can read it.

## Subagents

While `task` subagents run, a strip below the footer lists them. Press `↓` in an empty prompt to select one, `↑` `↓` to move, `enter` to open its record, `←` `→` to switch between subagents, `esc` to go back. You can also click a subagent's row in the strip; the row under the mouse lights up, and the wheel over the strip scrolls it when more subagents run than it shows. A subagent's approval card names it.

## See more, or less

| Key | Effect |
|---|---|
| `ctrl+o` | Expand or collapse tool output. Long output is folded by default: `… +15 lines · ctrl+o`. |
| `ctrl+t` | Expand or collapse the model's thinking. |
| `/thinking` | Hide or show thinking rows altogether. |
| `alt+l` | Choose a model. `ctrl+l` redraws the screen. |
| `pageup`, `pagedown`, `home`, `end` | Scroll the conversation when the prompt is empty. |
| `ctrl+f` | Find text in the conversation; `enter` goes to the next match. |

## Get text out

- **Select with the mouse.** Dragging selects and copies at once. Double-click selects a word, triple-click a line. Dragging past the top or bottom edge scrolls.
- `/copy` (or `alt+c`) copies the last answer. It uses `pbcopy`, `wl-copy` or `xclip` (`clip` on Windows). The footer says `Copied N chars`. If none works it writes the text to `exports/last-copy.txt` in the data folder and the footer says `Saved to file`.
- `/export` writes the whole conversation as Markdown. `/share` writes a copy under `shares/` and copies its path. Nothing is uploaded.
- `/editor` (or `ctrl+g`) opens the draft in `$VISUAL` or `$EDITOR`, else the first of `nvim`, `vim` and `nano` that is installed (then `notepad` on Windows). The variable may carry arguments, such as `code --wait`. What you save comes back into the input box. It is not sent until you press `enter`.

## Search your history

`↑` and `↓` walk through earlier messages. `ctrl+r` searches them: type to search, `ctrl+r` for the next match, `enter` to send the match, `esc` to put back what you were typing. History holds the last 1,000 messages and is kept between runs, in `history` in the data folder or where `CIRCLE_HISTORY_PATH` says.

## Secrets

When a task needs a password or token, the model can ask for it without it entering the conversation. A card names the variable and the file it will be written to, such as `API_TOKEN → /path/to/.env`. Choose `enter secret` (or press `alt+k` when a request is already waiting), type the value (it is masked), and press `enter`. The value is written straight to that file as `API_TOKEN=…`, keeping the file's other lines. The model is told it was collected, not what it was. `esc` cancels, and the model is told to ask you to put it in the file yourself; it never asks for the value in chat.

The value must fit on one line and in 4,096 bytes. A request nobody answers is dropped after ten minutes, and the model is told. Without the full-screen interface nobody can type it, so such a request waits out those ten minutes. Read the file name on the card before you enter a value: the model chooses it. See [Security](security.md#secrets).

A secret you keep for later has a name instead. `/secrets NAME` saves one on a masked card; `/secrets` or `/variables` alone lists the variables and the secrets, secrets by name only. The model still writes `%NAME%` in a tool's arguments, for example in a browser's password field or a command. Circle puts the value in when the tool runs, and the model only ever reads `%NAME%`. On Windows, `/variables` and `/secrets` say that. Elsewhere those commands describe the name without the `%NAME%` form. `/variables NAME=value` keeps a plain value the same way, which the model may see. See [Secrets by name](security.md#secrets-by-name).

The model can also ask for such a value when a task needs one you have not saved. For a password it asks a secret question with a name and no file, and the value is kept as a secret. For something like a folder path, a device's address or a user name, the question's card shows the name it will be kept under (`%BACKUP_DIR%`), and your answer is kept as a variable in your settings. Either way the model then writes `%NAME%`, and Circle fills in the value wherever it is used.

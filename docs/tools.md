---
nav_order: 20
---

# Built-in tools

The main agent has these twenty-one core tools. The desktop application adds the eleven [browser tools](#the-browser) below, and so does the full-screen terminal interface when Chrome, Edge or Chromium is installed. MCP servers and [extensions](extensions.md) add more.

"Asks" means Circle shows an approval card before the call runs. See [Security](security.md). In `read-only` mode the tools that do not ask keep working; the others are refused, except changes to a plan file (see [Read-only mode](security.md#read-only-mode)).

## Reading and searching

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `ls` | List a folder. Folders end in `/`. | no | |
| `read_file` | Read a text file with line numbers (`12: text`), a folder's entries, or an image or a PDF. Arguments: `file_path`, `offset` (lines to skip), `limit`. | no | 2,000 lines by default. Lines over 2,000 characters are cut. PNG, JPEG, GIF, WebP and PDF files go to the model as attachments, up to 20 MB each and 28 MB in one request; the model and endpoint must accept them. A PNG over 1,568 pixels on its long side or 1.15 million pixels is scaled down first (it may be up to 64 MB before that), and the result gives both sizes. Credential files are refused. |
| `glob` | Find files by pattern. | no | Skips `.git` and `node_modules`. 5,000 results. |
| `grep` | Search file contents for **literal text**, not a regular expression. Modes: files with matches (the default), matching lines, counts. A `glob` argument limits the files searched. | no | 1,000 matches unless the call asks for more. Skips `.git`, `node_modules`, binary files, files over 10 MB and credential files. |
| `lsp` | Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations. Positions are 1-based. | no | Needs `pylsp` (Python), `typescript-language-server` (TypeScript and JavaScript), `gopls` (Go) or `rust-analyzer` (Rust) on your `PATH`. 8 seconds per answer. |
| `webfetch` | Fetch a URL. Formats: `markdown` (the default), `text`, `html`. JSON is pretty-printed. | no | 500,000 bytes, 30 seconds. `http` becomes `https`. Refuses local and private addresses, also after a redirect. |
| `websearch` | Search the web through DuckDuckGo. No API key. | no | 1 to 10 results (5 by default), 20 seconds. |

## Changing things

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `write_file` | Create or overwrite a file. | yes | |
| `edit_file` | Replace exact text in a file. Arguments: `file_path`, `old_string`, `new_string`, `replace_all`. | yes | The file must have been read with `read_file` first. Text that occurs more than once needs `replace_all`. |
| `apply_patch` | Apply a multi-file patch in the `*** Begin Patch` format: add, update, move and delete files. | yes, and always when it deletes | Every part is checked before a file changes; if a write fails, the earlier ones are undone. |
| `delete` | Delete a file or a folder and everything in it. | always | |
| `screenshot` | Take a screenshot of the main screen, or of the front window of the application named in `app`, and send it to the model as an image. See [Images and screenshots](usage.md#images-and-screenshots). | yes | Scaled as `read_file` scales a PNG, and kept in `screenshots/` in the project's folder in the data folder. Only where there is a desktop on this machine: not over `ssh`, and on Linux only with `WAYLAND_DISPLAY` or `DISPLAY` set. Refused in `read-only` mode. On Linux only the whole screen. |
| `execute` | Run a shell command in the workspace. With `background: true` it runs as a [background job](background-jobs.md) and returns at once. Standard output and standard error come back together, in the order they were written. | yes | A command still running at 120 seconds goes on as a background job; one the model gave a `timeout` (up to 600 seconds) is ended at that time. Processes a command leaves running become a job. The model gets the first 80,000 bytes of output and the path of the rest. With `background`, `timeout` is the longest the job may run (up to a day; `0` for no limit). |

The file tools refuse a credential file and a background job's output; `execute` refuses a command that names a credential file. See [Security](security.md#credential-files).

## The browser

These tools use the conversation's browser, which you can use at the same time as Circle. They are available to the main agent only.

- In the desktop application it is the conversation's [browser panel](desktop.md#the-browser-panel). The panel opens when Circle starts using the browser, unless you are on another page of the application.
- In the full-screen terminal interface it is a Chrome, Edge or Chromium window that Circle starts at the first browser action, with a new, empty profile of its own: your own browser's profile, cookies and passwords are never used. Circle looks for Chrome, then Edge, then Chromium where they are usually installed (on Linux, on `PATH`); [`CIRCLE_BROWSER`](environment-variables.md#browser) names another. Without one, and in line and print mode, there are no browser tools. The window closes when Circle exits. A page behind another tab gets no input, so when Circle acts on a tab that is not in front, for example after you chose another tab or after another conversation used the browser, it brings that tab and its window to the front first.

Every result has the same parts: what the action did; the dialogs pages are waiting on, in every tab; what happened since the model last looked (tabs opened or closed, dialogs answered and by whom, a certificate warning passed); the tabs, when there are several or they changed; the shown page; and its snapshot. The snapshot is the page's visible text and the elements the model can act on, each with a ref such as `e12`. A ref stays with its element as long as the page is the same document, and an element that appeared since the last snapshot is marked `[new]`. Same-origin frames and open shadow roots are read, tables row by row; frames from other sites are not. Password fields show only whether they are filled.

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `browser_navigate` | Open `url` in the shown tab, or use `back`, `forward` or `reload`. | yes | HTTP and HTTPS only, including local and private addresses. A site whose certificate is not trusted gets the browser's warning page in the tab, which the result shows; see below. |
| `browser_snapshot` | Read the shown page and the rest of the result. | no | About 30,000 characters. Password values and Circle's pointer are left out. |
| `browser_click` | Move the pointer to `ref`, described by `element`, and click it with real mouse events. | yes | Refuses a covered element and names what covers it. |
| `browser_type` | Replace what `ref` holds with `text`; `submit: true` presses Enter. `%NAME%` in the text puts in a variable or a saved [secret](security.md#secrets-by-name). | yes | A password field takes only text made of secrets' names. |
| `browser_select` | Choose options of a select element at `ref`, by text or value. | yes | |
| `browser_press` | Press `key`: Enter, Tab, Escape, Backspace, Delete, Space, an arrow key, Home, End, PageUp or PageDown. | yes | |
| `browser_screenshot` | Send a PNG of the shown page to the model. | no | Not while the page waits on a dialog or shows an error. The model must accept images. |
| `browser_dialog` | Answer a page's dialog: `accept: true` presses OK (or leaves the page), `false` Cancel (or stays); `text` answers a prompt; `id` picks a dialog in another tab. | yes | |
| `browser_tabs` | `list`, `new` (with an optional `url`), `select` or `close` a tab. | yes | |
| `browser_handoff` | Hand you the browser, saying in `reason` what for, and wait until you hand it back; the result then lists where the tabs went meanwhile and shows the page. | no | The model sees nothing of the page until you hand it back. |
| `browser_upload` | Give `paths` to the file input at `ref`, or, without `ref`, to the file chooser one of Circle's clicks opened; an empty list closes that chooser. Paths are taken as the file tools take them. | always, also in `auto` mode | Up to 50 MB a file. Not a credential file, and not a file with other names on disk (hard links). |

A tool that asks does so once for each site (scheme, host and port): the card names the site, and allowing it for the session covers every browser action there. A navigation asks about the site it goes to. When the page has gone to another site before a click, typing, selection, key press or upload runs, nothing is done and the result shows the page as it is now. See [the approval rules](security.md#approvals).

### Dialogs, warnings and tabs

A page's alert, confirm, prompt or "leave site?" question waits in its tab. In the desktop application it appears over that tab in the browser panel, on a picture of the page as it stopped, with where it came from, and while Circle is working also in the conversation; in the terminal's browser it is the browser's own dialog, in its window. You, or the model with `browser_dialog`, can answer it; the first answer counts, and the next result says who gave it. While a page waits on a dialog, the other tools that act on it refuse and say which dialog to answer.

When a site's certificate is not trusted, as with the self-signed certificate of a device's web interface, the tab shows the browser's privacy warning instead of the site, as Chrome does: in the terminal it is the browser's own page, in the desktop application Circle's page made like it. You and the model see the same page: **Advanced** shows the link to proceed, and in the desktop application the certificate too. When the model clicks that link, Circle first asks you, in the conversation or on a card in the terminal, showing the site, the certificate's subject and issuer, its expiry and its SHA-256 fingerprint. You can allow it once; for a host on this network (a private, loopback or link-local address, or a name like `nas.lan`) you can also trust that certificate on that host for good. Allowing once lasts until Circle closes; in the terminal's browser it covers that host on every port, as the browser's own exception does. A certificate you trust for good is kept in `browser-certificates.json`, in the application's data folder for the desktop and in Circle's data folder for the terminal; delete it there to forget it. Your own click on the link needs no approval. A different certificate on the same host shows the warning again.

A link or script that opens a new window opens a new tab, shown to both of you; one that opens in the background stays behind. The result names new tabs.

One **allow on *site* for this session** choice covers all browser actions on that site in this conversation but two, which are asked every time, also in `auto` mode: passing a certificate warning (unless you trust the certificate for good) and giving a page files. Keeping a download the model started is asked once per site, except in `auto` mode. `read-only` mode allows snapshots and browser screenshots and refuses the other tools. See [The browser panel](desktop.md#the-browser-panel), [Browser safety](security.md#the-desktop-browser) and [The terminal's browser](security.md#the-terminals-browser).

### Taking turns

You and Circle share the browser.

- In the desktop application, while Circle performs an action a clear layer over the page takes your clicks: a click there, or **take over** under the page, gives you the browser as soon as that action ends (meanwhile **waiting for Circle to stop…**).
- While you have it, a band over the page says so and Circle's browser tools wait. When you **hand back**, in the band or on the card in the conversation, the tool that waited does nothing and shows the model the page as you left it.
- The model can hand you the browser itself with `browser_handoff`, for a security key, a CAPTCHA or a choice that is yours. In the terminal the browser window comes to the front and a card waits for **hand back**; to take the browser there yourself, stop the turn with `esc`.
- Either way the model learns where the tabs went while it did not act (`tab t1 went to … while Circle was not acting`), which dialogs and file choosers you answered and what was downloaded; never what you typed, and no picture of the page.

### Downloads and files

A download is kept in the system's Downloads folder, under the name the site gives it, with ` (1)` and so on added when that name is taken, as browsers do. The result names it (`dl1`) when it starts and gives its path when it is done; an address that downloads a file instead of opening a page says so. When the model's action downloads from a site not yet allowed, the file waits in a temporary folder and Circle asks you, after the action, with the site and each file's name and size: keep it, keep downloads from that site for this session, or discard it. In `auto` mode it is kept without asking. The action is not done again; its result says what you decided, and a discarded file is deleted. The desktop panel shows the file as **waiting for approval** meanwhile. Downloads you start yourself are not held. The model can read a finished download with the file tools. The desktop panel lists the latest downloads, each with **show in folder**.

A click of Circle's that opens a page's file chooser does not open the system's dialog: the result shows the chooser waiting, and the model answers it with `browser_upload`, or you do with **choose…** under the page in the desktop panel. A file chooser you open yourself is the system's own. Before a page gets files from the model, Circle asks you, showing the files, their sizes and the site.

## Working with you

| Tool | What it does | Asks |
|---|---|---|
| `write_todos` | Keep the plan shown in the plan box. | no |
| `question` | Ask you one or more questions with options, or ask for a secret. Your answers become the tool result. See [Answer a question](usage.md#answer-a-question) and [Secrets](usage.md#secrets). | no |
| `plan_enter` | Switch to `read-only` mode, as `/plan` does. | no |
| `plan_exit` | Ask you whether to leave `read-only` mode and implement the plan. Only you can say yes, so it fails without the full-screen interface. | no |

Without the full-screen interface, a `question` call returns the questions as text, and the model asks them in its answer.

## Background jobs

See [Background jobs](background-jobs.md).

| Tool | What it does | Asks |
|---|---|---|
| `list_jobs` | List this conversation's jobs: id, kind, state, time, what, and the file their output goes to. | no |
| `stop_job` | Stop a running job with everything it started. | no |
| `wait_jobs` | Wait until one of the given jobs ends (up to 600 seconds), and return how it ended. Only subagents have it: they cannot be woken by a notice. | no |

## Extending itself

| Tool | What it does |
|---|---|
| `skill` | Load the full instructions of a [skill](skills.md) by name. |
| `task` | Run a subagent (`general-purpose`, `explore`, or one an extension adds) and return its answer. Arguments: `description`, `subagent_type`, `background`. With `background: true` the subagent runs as a [background job](background-jobs.md#background-subagents) and its report comes as a notice. See [How Circle works](how-circle-works.md#subagents). |
| `compact_conversation` | Summarize older messages now. See [Compaction](sessions.md#compaction). |

## Limiting the tools

`--tools`, `--exclude-tools` and `--no-tools` choose the main agent's tools for one run; see [CLI](cli.md#arguments-and-options). `compact_conversation` is always kept. Subagents keep their own tools, so leave out `task` too when that matters.

## Calls the model gets wrong

A call to one of the tools that do not ask, with its name in the wrong case or with `-`, `_` or spaces in another place (`Read_File`, `readfile`), goes to the tool it clearly means; a tool that changes something must be named exactly. Argument names are matched the same way, and a JSON string given where a list or an object belongs is read as one. Then the arguments are checked against the tool's schema: a call that does not fit gets an error the model can correct, and nothing runs.

## Display

Tool output in the conversation is shortened to a few lines; `ctrl+o` shows all of it. Very large results (over 80,000 characters) are saved in the data folder (`projects/<folder>-<id>/large_tool_results/`), and the model gets the start and a path, `/large_tool_results/…`, to read the rest. Every command's output is kept the same way, under `background_jobs/`, and the model reads it at `/background_jobs/…`.

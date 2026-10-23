---
nav_order: 20
---

# Built-in tools

The main agent has these twenty-one core tools, and `vision` when a [side vision model](usage.md#images-and-screenshots) is set. The desktop application adds the thirteen [browser tools](#the-browser) below, and so does the full-screen terminal interface when Chrome, Edge or Chromium is installed. The eight [device terminal](#device-terminals) tools come with both. MCP servers and [extensions](extensions.md) add more.

"Asks" means Circle shows an approval card before the call runs. See [Security](security.md). In `read-only` mode the tools that do not ask keep working; the others are refused, except writing the conversation's plan (see [Read-only mode](security.md#read-only-mode)).

## Reading and searching

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `ls` | List a folder. Folders end in `/`. | no | |
| `read_file` | Read a text file with line numbers (`12: text`), a folder's entries, or an image or a PDF. Arguments: `file_path`, `offset` (lines to skip), `limit`. | no | 2,000 lines by default. Lines over 2,000 characters are cut. PNG, JPEG, GIF, WebP and PDF files go to the model as attachments, up to 20 MB each and 28 MB in one request; the endpoint must accept them. For a model that does not read images, a picture goes to the side vision model instead and the result is its description; without one the call fails. A PDF always goes as an attachment. A PNG over 1,568 pixels on its long side or 1.15 million pixels is scaled down first (it may be up to 64 MB before that), and the result gives both sizes. Credential files are refused. |
| `vision` | Have the side vision model describe a picture file, answering `question` (what to look for; without one, a general description). Arguments: `path`, `question`. Offered only when a [side vision model](usage.md#images-and-screenshots) is set. | no | PNG, JPEG, GIF and WebP, read as `read_file` reads them, so a large PNG is scaled down first. PDFs and credential files are refused, and in the desktop application so is a picture outside the workspace (Circle's own screenshots and saved pictures aside), as `read_file` refuses it. A conversation remembers its last 64 descriptions while Circle runs, so the same picture and question are not sent twice. 60 seconds for the whole call (`CIRCLE_VISION_TIMEOUT_MS`). |
| `glob` | Find files by pattern. | no | Skips `.git` and `node_modules`. 5,000 results. |
| `grep` | Search file contents for **literal text**, not a regular expression. Modes: files with matches (the default), matching lines, counts. A `glob` argument limits the files searched. | no | 1,000 matches unless the call asks for more. Skips `.git`, `node_modules`, binary files and credential files. A file over 10 MB, one that is not UTF-8 text, or one the operating system refuses is not looked in, and the result counts them: a match could be in one, so "No matches found" only covers what was read. |
| `lsp` | Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations. Positions are 1-based. | no | Needs `pylsp` (Python), `typescript-language-server` (TypeScript and JavaScript), `gopls` (Go) or `rust-analyzer` (Rust) on your `PATH`. 8 seconds per answer. |
| `webfetch` | Fetch a URL. Formats: `markdown` (the default), `text`, `html`. JSON is pretty-printed. | no | 500,000 bytes, 30 seconds. `http` becomes `https`. Refuses local and private addresses, also after a redirect. |
| `websearch` | Search with the current model provider's native search when supported, otherwise DuckDuckGo. Reuses the saved connection and key; no separate search settings. | no | 1 to 10 results (5 by default). 60 seconds total: at most 30 for native search and 15 for each DuckDuckGo endpoint. |

`websearch` sends a separate request containing the query and search instructions, rather than the conversation, and returns the search provider and source URLs with the result. The provider's model restrictions, access requirements and search charges still apply. Helper model tokens count toward session usage; a hosted search charge whose price Circle does not know stays unpriced.

Circle selects these adapters by the saved endpoint and protocol, not the model name alone. The table describes supported API contracts, not a guarantee that every model or account at those endpoints can search.

| Provider | Native search contract |
|---|---|
| OpenAI, xAI | Responses `web_search`, with a completed search call and structured sources or citations. |
| Anthropic | Messages server-side `web_search`, with linked search result blocks. Anthropic-compatible routes use the same capability check. |
| Bailian / Qwen | Supported models use Responses search. Older Chat models use `enable_search`; without structured search evidence, Circle falls back. |
| Zhipu / GLM | Chat `web_search` with returned search results. |
| Gemini | Native `google_search` grounding with search queries and grounding sources. |
| Moonshot / Kimi | The same API account's independent `/tools/search` endpoint. |
| Volcengine Ark | Responses search on its OpenAI route, Messages search on its Anthropic route. |
| Groq | `browser_search` on the allow-listed GPT-OSS models, requiring structured executed-tool results. |
| Mistral | Conversations `web_search`, requiring completed tool execution and source references. |

Other recognized provider/protocol combinations use DuckDuckGo until Circle has an adapter for their search contract. In particular, the DeepSeek OpenAI route does not enable Responses hosted search. Unknown gateway URLs use compatible-protocol detection below, rather than inheriting a vendor adapter from their model ids.

For custom OpenAI-compatible endpoints, Circle tries the same endpoint's Responses search tool on the first search. For Anthropic-compatible endpoints, it first reads the model's search capability when available, then tries Messages search when the capability is unknown. Accepting a parameter or returning links is not proof of search: Circle requires structured search execution results. Explicit lack of support is remembered for ten minutes in this process; temporary failures pause native attempts for thirty seconds. Different endpoints, protocols, models and credentials have separate capability records.

Native search failure falls back automatically to DuckDuckGo's lite and HTML endpoints. A genuine empty result is returned without another search. Challenge pages and unrecognized HTML are errors rather than empty results. Fallback results include the native failure reason; if every route fails, the tool reports their causes. Cancelling a search stops it without starting a fallback.

## Changing things

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `write_file` | Create or overwrite a file. Overwriting an existing skill-run output still asks in `accept edits`. | yes | |
| `edit_file` | Replace exact text in a file. Arguments: `file_path`, `old_string`, `new_string`, `replace_all`. | yes | The file must have been read with `read_file` first. Text that occurs more than once needs `replace_all`. |
| `apply_patch` | Apply a multi-file patch in the `*** Begin Patch` format: add, update, move and delete files. | yes, and always when it deletes | Every part is checked before a file changes; if a write fails, the earlier ones are undone. |
| `delete` | Delete a file or a folder and everything in it. | always | |
| `screenshot` | Take a screenshot of the main screen, or of the front window of the application named in `app`, and send it to the model as an image; for a model that does not read images, the side vision model gets it and the model gets its description. See [Images and screenshots](usage.md#images-and-screenshots). | yes | Scaled as `read_file` scales a PNG, and kept in `screenshots/` in the project's folder in the data folder. Only where there is a desktop on this machine: not over `ssh`, and on Linux only with `WAYLAND_DISPLAY` or `DISPLAY` set. Refused in `read-only` mode. On Linux only the whole screen. A model that does not read images gets no screenshot without a side vision model. |
| `execute` | Run a shell command in the workspace. With `background: true` it runs as a [background job](background-jobs.md) and returns at once. Standard output and standard error come back together, in the order they were written. | yes | A command still running at 120 seconds goes on as a background job; one the model gave a `timeout` (up to 600 seconds) is ended at that time. Processes a command leaves running become a job. The model gets the first 80,000 bytes of output and the path of the rest. With `background`, `timeout` is the longest the job may run (up to a day; `0` for no limit). |

The file tools refuse a credential file and a background job's output; `execute` refuses a command that names a credential file. See [Security](security.md#credential-files).

## The browser

These tools use the conversation's browser, which you can use at the same time as Circle. They are available to the main agent only.

- In the desktop application it is the conversation's [browser](desktop.md#the-browser). Its mode of the drawer opens when Circle starts using the browser, unless you are on another page of the application, the browser is in a window of its own, or the window is narrow, where it would cover the conversation.
- In the full-screen terminal interface it is a Chrome, Edge or Chromium window that Circle starts at the first browser action, with a new, empty profile of its own: your own browser's profile, cookies and passwords are never used. Circle looks for Chrome, then Edge, then Chromium where they are usually installed (on Linux, on `PATH`); [`CIRCLE_BROWSER`](environment-variables.md#browser) names another. Without one, and in line and print mode, there are no browser tools. The window closes when Circle exits. A greeting does not send the browser tool schemas. They are added on the turn whose message contains an `http` or `https` URL or asks for the browser, and on later turns of a session that has already used them. A page behind another tab gets no input, so when Circle acts on a tab that is not in front, for example after you chose another tab or after another conversation used the browser, it brings that tab and its window to the front first.

Every result has the same parts: what the action did; the dialogs pages are waiting on, in every tab; what happened since the model last looked (tabs opened or closed, dialogs answered and by whom, a certificate warning passed); the tabs, when there are several or they changed; the shown page; and its snapshot. The snapshot is the page's visible text and the elements the model can act on, each with a ref such as `e12`. A ref stays with its element as long as the page is the same document, and an element that appeared since the last snapshot is marked `[new]`. On a certificate warning the advanced button is marked `[warning: advanced]` and the link to proceed `[warning: proceed]`, in any language; a page cannot mark its own elements so. Same-origin frames and open shadow roots are read, tables row by row; frames from other sites are not. Password fields show only whether they are filled.

A click, typing, a choice or a file given to a `ref` names the element it acted on as the snapshot shows it, its role and name read from the page at that moment, never the model's `element` words: `Clicked e28 link "主机设置".`, `Typed secret ROUTER_PASSWORD into e2 password "Password".` An element without a name is named by its role, `Clicked e7 button.` When `element` describes another element, the sentence says so, so that the model looks again: `Clicked e28 link "主机设置" — you described it as "网络菜单"; check the snapshot.` A description fits when it holds the name or the name holds it, ignoring case and spaces, or when every word of it but the kind of control (`link`, `button`, `菜单`, `按钮` and the like) is in the name: "the Proceed link" fits `Proceed to 192.168.1.1 (unsafe)`. A description in another language than the page's does not fit. A field named only by its placeholder ("请输入", "Search…") fits any description: a placeholder says what to type, not what the field is. The pointer's label in the page, and the field in an upload's approval, show the page's name too, or the model's words for an element without one.

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `browser_navigate` | Open `url` in the shown tab, or use `back`, `forward` or `reload`. | yes | HTTP and HTTPS only, including local and private addresses. A site whose certificate is not trusted gets the browser's warning page in the tab, which the result shows; see below. |
| `browser_snapshot` | Read the shown page and the rest of the result. Elements show their state (`checked`, `unchecked`, `mixed`, `pressed`, `selected`, `expanded`, `collapsed`, `disabled`, `required`, `invalid`, from ARIA or the native control, also for a see-through checkbox under a styled switch), an icon-only control its icon's name (`icon=…`), and an element under a dialog, drawer, mask or message is marked `[covered]`. | no | About 30,000 characters. Password values and Circle's pointer are left out. A page cut short keeps the dialogs, drawers and menus on top of it, after the part of the page that fits. |
| `browser_click` | Move the pointer to `ref`, described by `element`, and click it with real mouse events, at a point of the element nothing covers (each line of a link that wraps, a checkbox's label). The result waits for the page to settle: network quiet, then no change or animation still running, up to 1.5 s more. | yes | Waits up to 3 s for what covers the element to go (a loading mask, a message), then refuses and names it; a dialog or drawer is named once the page is still. `browser_type` and `browser_select` wait the same way. |
| `browser_click_at` | Click `x`, `y` in CSS viewport pixels using `screenshotId` from the latest screenshot, for visible controls without a ref. | yes; unknown or destructive targets also ask once in every mode but `auto` | Refuses a stale screenshot: another document, viewport size or scroll position, or a change where it clicks (the element there and its control moved or changed, or what lay over the point gone). Changes elsewhere on the page do not count, and after the pointer moves there only a change of the target's content or role does. Refuses cross-origin frames and certificate warning pages. Not recorded into scripts. |
| `browser_type` | Replace what `ref` holds with `text`; `submit: true` presses Enter. `%NAME%` in the text puts in a variable or a saved [secret](security.md#secrets-by-name). | yes | A password field takes only text made of secrets' names. |
| `browser_select` | Choose options of a select element at `ref`, by text or value. | yes | |
| `browser_press` | Press `key`: Enter, Tab, Escape, Backspace, Delete, Space, an arrow key, Home, End, PageUp or PageDown. | yes | |
| `browser_screenshot` | Send a PNG of the shown page to the model. For a model that does not read images, the PNG is kept in `screenshots/` in the project's folder in the data folder, and the model gets its path and the side vision model's description. | no | Not while the page waits on a dialog or shows an error. A model that does not read images gets no screenshot without a side vision model; `browser_snapshot` still reads the page. |
| `browser_dialog` | Answer a page's dialog: `accept: true` presses OK (or leaves the page), `false` Cancel (or stays); `text` answers a prompt; `id` picks a dialog in another tab. For a sign-in, `text` is the user name and `password` the password. | yes | A sign-in's `password` is only a saved [secret](security.md#secrets-by-name) written `%NAME%`. |
| `browser_tabs` | `list`, `new` (with an optional `url`), `select` or `close` a tab. | yes | |
| `browser_handoff` | Hand you the browser, saying in `reason` what for, and wait until you are done: you continue or send a message, or in `auto` mode it comes back by itself. The result says which, lists where the tabs went meanwhile and shows the page. | no | The model sees nothing of the page meanwhile. Not for a certificate warning, a dialog or a permission, and refused in plan mode. |
| `browser_upload` | Give `paths` to the file input at `ref`, or, without `ref`, to the file chooser one of Circle's clicks opened; an empty list closes that chooser. Paths are taken as the file tools take them. | always, except in `auto` mode | Up to 50 MB a file. Not a credential file, and not a file with other names on disk (hard links). |
| `browser_record` | Write this conversation's browser actions to a script file at `path`, as steps that find their elements by role and name; `name` names it, `first` and `last` keep part of the steps. The result lists the steps. See [Recording and replaying](#recording-and-replaying). | yes, as writing a file does | The file tools' rules for the path: a credential file or a background job's output is refused. |
| `browser_replay` | Run the script at `path` step by step, without the model in between; `variables` gives values for its `%NAME%`, `from` and `to` run part of it. The result says what each step did; the first step that cannot be done stops it. | yes, for the site it starts on | Acts only on that site. A step waits for its element or text up to 10 seconds unless its `timeout` says otherwise. The file is read as `read_file` reads it, up to 1 MB. |

A tool that asks does so once for each site (scheme, host and port): the card names the site, and allowing it for the session covers ordinary browser control there. Unknown and destructive coordinate targets still need a one-time decision in every mode but `auto`. A navigation asks about the site it goes to. When the page has gone to another site before a click, typing, selection, key press or upload runs, nothing is done and the result shows the page as it is now. See [the approval rules](security.md#approvals).

### Dialogs, warnings and tabs

A page's alert, confirm, prompt or "leave site?" question waits in its tab. In the desktop application it appears over that tab in the browser, on a picture of the page as it stopped, with where it came from, and while Circle is working also in the conversation; in the terminal's browser it is the browser's own dialog, in its window. You, or the model with `browser_dialog`, can answer it; the first answer counts, and the next result says who gave it. While a page waits on a dialog, the other tools that act on it refuse and say which dialog to answer. In the terminal's browser, a dialog a page opens while an action is still reading it ends that action at once, and its result shows the dialog.

A site, or a proxy, that asks for a user name and password (HTTP sign-in) waits the same way, as a dialog the result shows with the site and the realm. In the desktop application it appears over the tab with fields for the user name and password, and while Circle is working also in the conversation; what you type there goes to the site, and the model learns only that you answered. The model answers with `browser_dialog`: `text` is the user name, `password` a saved [secret](security.md#secrets-by-name) written `%NAME%`, never plain text. A user name or password the site does not accept makes it ask again, and the result says so. An answer goes only to the site the action was allowed on: a dialog in another tab, or a sign-in another site asks for, is answered after showing that tab, which asks about its site. In the terminal's browser a sign-in that one of Circle's actions meets waits for the model; when the model hands you the browser it becomes the browser's own dialog, in its window, as is a sign-in that comes while Circle is not acting.

In the desktop application a page that asks for the camera, the microphone, your location, notifications, reading the clipboard, MIDI devices, idle detection or window placement asks under the page in the panel, with **allow** and **block**, as a browser asks. Only you answer; the answer holds for that site until Circle closes. The model sees the request waiting and then your answer, and the page goes on meanwhile. Other permissions are refused. In the terminal's browser these requests are the browser's own, in its window, and the model does not see them.

A site that asks for a client certificate, to know who you are, waits for your choice. In the desktop application the certificates you could send are listed in the page's place in the panel, and while Circle is working also in the conversation, each with its subject, issuer and expiry: choose one, or **send none**. Only you choose; Circle's action waits for your choice and then learns which certificate you chose, by subject and issuer, or that you sent none. A site that asks when you have no certificate gets none, without asking. In the terminal's browser the choice is the browser's own, in its window.

For a navigation that opens a new document, the terminal browser waits for that document to commit before reporting the page. A document that never commits causes the action to fail.

An unexpected protocol closure while the terminal browser starts reports the startup step and any exit code or signal already observed. An unknown exit does not establish that the browser process exited; its captured stderr may be incomplete.

Circle keeps ownership of each browser process it starts until that process exits, including when a lost connection leads to another browser starting. Closing the session waits for those owned processes; a shutdown failure keeps the session from being reported as deleted.

When a site's certificate is not trusted, as with the self-signed certificate of a device's web interface, the tab shows the browser's privacy warning instead of the site, as Chrome does: in the terminal it is the browser's own page, in the desktop application Circle's page made like it. You and the model see the same page: **Advanced** shows the link to proceed, and in the desktop application the certificate too. When the model clicks that link, Circle first asks you, in the conversation or on a card in the terminal, showing the site, the certificate's subject and issuer, its expiry and its SHA-256 fingerprint. You can allow it once; for a host on this network (a private, loopback or link-local address, or a name like `nas.lan`) you can also trust that certificate on that host for good. Allowing once lasts until Circle closes; in the terminal's browser it covers that host on every port, as the browser's own exception does. A certificate you trust for good is kept in `browser-certificates.json`, in the application's data folder for the desktop and in Circle's data folder for the terminal; delete it there to forget it. Your own click on the link needs no approval. A different certificate on the same host shows the warning again.

A link or script that opens a new window opens a new tab, shown to both of you; one that opens in the background stays behind. The result names new tabs. A page may close only a tab it opened itself: in the desktop application, a `window.close()` in a tab you or Circle opened is refused, as Chrome refuses it (`Scripts may close only the windows that were opened by them.`), so a site that ends a side panel by closing its window leaves the tab where it is instead of emptying the panel.

One **allow on *site* for this session** choice covers all browser actions on that site in this conversation but three, which are asked every time, a rule aside, except in `auto` mode: passing a certificate warning (unless you trust the certificate for good), giving a page files, and a click on a control that deletes, clears or resets something, or accepting a dialog that says so. The control's name on the page decides (删除, 清空, Delete, Remove, Reset and the like), not the model's words; that card has no **for this session**. Keeping a download the model started is asked once per site, except in `auto` mode. `read-only` mode allows snapshots and browser screenshots and refuses the other tools. See [The browser panel](desktop.md#the-browser), [Browser safety](security.md#the-desktop-browser) and [The terminal's browser](security.md#the-terminals-browser).

### Taking turns

You and Circle share the browser.

- In the desktop application, while Circle performs an action a clear layer over the page takes your clicks. A blue ring around the page, whose tooltip says **Circle is operating**, stays lit from the turn's first browser tool until the turn ends, you take the browser, or the session stops — including while Circle is thinking between actions. While a browser action waits for your approval the ring is orange and its tooltip says **Waiting for your approval**. A click on the page during an action, or **take over** beside the address, which shows while Circle works, gives you the browser as soon as that action ends (meanwhile the tooltip says **Waiting for Circle to stop…**). While you have it, the ring is the ordinary border and says **you have the browser**, and a card in the conversation says what Circle waits for. The pointer mark on a click still lasts only for that action.
- While you have it, Circle's browser tools wait. You give it back with **continue** on that card or by sending Circle a message. In `auto` mode Circle also takes it back by itself: in the desktop application once you stop for 5 seconds after acting in the page, or 2 seconds after the page moved on; in the terminal 2 seconds after the page moved on. The tool that waited does nothing and shows the model the page as you left it, and says who ended your turn.
- The model can hand you the browser itself with `browser_handoff`, for a security key, a CAPTCHA or a choice that is yours. In the terminal the browser window comes to the front and a card waits for **continue**; to take the browser there yourself, stop the turn with `esc`. It does not hand over for a certificate warning, a page's dialog or a permission, which Circle asks you about on a card, and plan mode hands nothing over.
- Either way the model learns where the tabs went while it did not act (`tab t1 went to … while Circle was not acting`), which dialogs and file choosers you answered and what was downloaded; never what you typed, and no picture of the page.

If no one can receive a terminal handoff, the tool refuses it before starting a browser or bringing a tab to the front.

### Downloads and files

A download is kept in the system's Downloads folder, under the name the site gives it, with ` (1)` and so on added when that name is taken, as browsers do. The result names it (`dl1`) when it starts and gives its path when it is done; an address that downloads a file instead of opening a page says so. When the model's action downloads from a site not yet allowed, the file waits in a temporary folder and Circle asks you, after the action, with the site and each file's name and size: keep it, keep downloads from that site for this session, or discard it. A download a page starts within ten seconds after one of the model's actions counts as the model's, and is asked about with its next action. The site is the download's own, or for a `blob:` file the page's that made it; files from two sites are asked about one site at a time. In the desktop panel a file **waiting for approval** also has **keep** and **discard**, for when Circle's turn ended before it asked. In `auto` mode it is kept without asking. The action is not done again; its result says what you decided, and a discarded file is deleted. The desktop panel shows the file as **waiting for approval** meanwhile. Downloads you start yourself are not held. The model can read a finished download with the file tools. The desktop panel lists the latest downloads, each with **show in folder**.

A click of Circle's that opens a page's file chooser does not open the system's dialog: the result shows the chooser waiting, and the model answers it with `browser_upload`, or you do with **choose…** under the page in the desktop panel. A file chooser you open yourself is the system's own. Before a page gets files from the model, Circle asks you, showing the files, their sizes, the site and the file input as the page names it.

### Recording and replaying

When you ask Circle to record what it did in the browser, or to do it again, it writes the conversation's browser actions to a script file with `browser_record` and runs one with `browser_replay`, in this conversation or another. The file is Circle's own format, JSON, by convention named `*.circle-browser.json`; scripts run only in Circle.

```json
{
  "circle": "browser-script/1",
  "name": "SLB list cases",
  "description": "optional",
  "steps": [
    { "navigate": "https://%APV_HOST%/login" },
    { "proceed": "certificate" },
    { "type": { "role": "textbox", "name": "用户名" }, "text": "%APV_USER%" },
    { "type": { "role": "password", "name": "密码" }, "text": "%APV_PASSWORD%", "submit": true },
    { "click": { "role": "link", "name": "服务器负载均衡" } },
    { "click": { "role": "button", "name": "删除", "nth": 2 }, "note": "the second 删除 on the page" },
    { "select": { "role": "combobox", "name": "类型" }, "values": ["TCP"] },
    { "press": "Enter" },
    { "dialog": "accept" },
    { "expect": "The virtual service ip address list is in use" },
    { "absent": "Error" },
    { "wait": 2 }
  ]
}
```

The steps:

- `navigate` opens an address, or goes `back`, `forward` or `reload`, as `browser_navigate` does. A page that cannot be loaded stops the replay.
- `proceed`, always `"certificate"`, passes the certificate warning the tab shows: it opens **Advanced** if needed and clicks the link to proceed, and you are asked as when the model clicks it. Without a warning it does nothing.
- `click`, `type` and `select` act on an element, as `browser_click`, `browser_type` (with `text` and `submit`) and `browser_select` (with `values`) do.
- `press` presses a key, as `browser_press` does.
- `dialog` is `"accept"` or `"dismiss"` for the page's dialog, with `text` for a prompt or a sign-in's user name and `password` for a sign-in's password, as `browser_dialog` takes them. It waits for the dialog to open.
- `tabs` is `"new"`, with an optional `url`, or `"close"` for the shown tab.
- `expect` and `absent` wait until the page's text, as a snapshot reads it, shows or no longer shows the text. What fields hold is left out, so text the script typed is not taken for the page's answer.
- `wait` waits that many seconds.

An element is `{ "role", "name", "nth" }`: its role and name exactly as a snapshot prints them (`[e5] button "删除"`), compared with runs of spaces as one, and `nth` (from 1) for the second, third… of the elements with that role and name in the snapshot's order. Any step may have a `note`, which is not used, and a `timeout`: how long, in seconds, it waits for its element, dialog or text (10 unless given, up to 600).

**Recording.** `browser_record` reads the conversation's stored messages: each browser call as the model wrote it, with its refs and `%NAME%`, never a secret's value, and its result. A ref becomes the element the browser result before the call showed under it, with `nth` when that snapshot had several of the same role and name; when it did not show that element there, the element the call's own result names. A click on a certificate warning's link to proceed becomes a `proceed` step; when you passed a warning yourself, or a page was reached past a certificate accepted earlier in the conversation or trusted for good, a `proceed` step is added too, which does nothing in a run without the warning. Snapshots, screenshots, hand-overs, uploads, tab lists, calls that failed or did nothing, other clicks on a warning, choosing a tab and closing a tab that is not shown are left out, and the result says how many of each. Tab ids (`t1`, `t2`) differ between runs, so a script has no step that chooses a tab. Values the model typed as plain text stay plain text. The file has one step a line; the result lists them, and the model then cleans the file up with `read_file` and `edit_file`: it drops detours, adds `expect` steps and writes values that change between runs as `%NAME%`. The path is taken and approved as `write_file` takes it.

**Replaying.** `browser_replay` reads the file as `read_file` does and checks it; an error names the step and what is wrong. `%NAME%` anywhere in a step but its `note` takes the replay's `variables`, then Circle's [variables](security.md#secrets-by-name), then its secrets; a name none of them sets stops the replay before any step, naming it. Text made only of secrets' names is typed as a secret, so a password field takes it, and a variable given to the replay as a secret's `%NAME%` counts as that secret. Wherever a secret's value appears in the result, the model reads `%NAME%`. Each step looks for its element in a new snapshot until it shows or the step's time is up, and tries a click, typing or choice again while the element is covered, hidden, disabled or out of view, or its ref went stale. The approval is the browser's, for the site the replay starts on: where its first navigation goes when no step acts on the page before it, else the page shown; **allow on *site* for this session** covers it as any browser action there. Every step acts on that site only: a navigation elsewhere, or a page that went to another site, stops the replay, and calling it again from that step asks about the new site. A certificate warning asks you as an action's would (every time, except in `auto` mode), and a download from a site not yet allowed asks as usual. In manual and accept-edits mode a script with a step that clicks a control that deletes, clears or resets something asks every time before it runs, and the card names those steps. In the desktop application, taking the browser while a replay runs stops it: its next request to the browser waits until you hand the browser back, does nothing, and the replay ends there, showing the page as you left it. The first step that cannot be done stops the replay; the error gives its number, the step as written, why, the steps done before it, and the page as it is with its snapshot, and the model fixes the file and calls again with `from` at that step. A finished replay says what each step did, what happened meanwhile (downloads, dialogs answered) and the page it ended on. `esc` stops it between steps and during one.

## Device terminals

These tools drive device consoles over SSH and Telnet, the way you would in SecureCRT: switches, routers, servers, a console server's serial port reached over the network. They are available to the main agent only, in the desktop application and in the full-screen terminal interface alike. Each conversation owns its terminals, up to six; a person can watch every screen and take one over.

A conversation's terminals are numbered `t1`, `t2`…; the saved profiles are the person's, named like SecureCRT's session list. Every result starts with the state line of the terminal it acted on (`t1 · LAB-DEVICE-01 · ssh sw1.lan:22 · quiet 4s`), and what the person did with the devices since the model last looked comes once as **Events**.

| Tool | What it does | Asks | Limits |
|---|---|---|---|
| `terminal_sessions` | List this conversation's terminals with their state, and the saved profiles. | no | |
| `terminal_connect` | Open a console, by a saved `profile` — the way to reach an SSH device, since a profile carries how to sign in — or by a plain `host` with `transport` (`ssh` or `telnet`), `port` and `user`. | yes, per device | SSH sign-in comes only from a profile: a password from a saved [secret](security.md#secrets-by-name), a key from a path taken as the file tools take it. A Telnet console answers its own login, so the device prompts are typed with `terminal_send`. The first login to a device whose host key is new stops and asks you; see below. |
| `terminal_send` | Type `text` to the device; `enter` presses Enter after it. `%NAME%` puts in a variable or a secret, whose value you never see back. | yes; a line carrying a word that can destroy device state is asked every time | The result shows the end of the screen once it rests; a device that keeps printing says so. |
| `terminal_read` | Read the screen's last lines (`lines`, 50 by default, up to 2000 of the scrollback) and the line the cursor sits on — the prompt. | no | Colours and cursor moves are read as the plain text they left. |
| `terminal_wait` | Wait for the screen: quiet for `idle_ms` (600 by default), or a `pattern` (a regular expression over the screen's last lines); bounded by `timeout_ms` (30000, up to 300000), and waited again after a timeout up to `retries` times (0 by default, up to 5). `absent`, a regular expression over what the device prints after the wait begins, ends the wait as a failed check. `changed` adds what the device printed during the wait, its last 200 lines. On one of your terminal tabs, quiet finishes a wait without a `pattern` only once the shell is back at its prompt, so a command that prints nothing, such as `sleep`, is waited out. On macOS and Linux that is known from the process in front of the shell, whatever the prompt looks like; on Windows, and while a program the shell started holds the tab (`ssh`, a REPL), from the line at the cursor ending in `$`, `#`, `%`, `>` or `❯`. | no | A timeout answers, it does not fail: the result says which it was, and how many attempts it took. A matched or `absent` pattern names the newest line it hit. `absent` and `changed` read a screen of their own that starts empty with the wait, so what was printed before, such as an earlier step's error or what `terminal_send` already showed, is in neither. Prefer it over sleeping between sends. |
| `terminal_press` | Press one key: `Enter`, `Tab`, `Escape`, `Backspace`, `Delete`, `Ctrl_C`, `Ctrl_D`, `Ctrl_Z`, the arrows, `Home`, `End`, `PageUp`, `PageDown`. | yes | |
| `terminal_disconnect` | Close the device's console. | yes | `terminal_read` can still show its last screen until the conversation ends. |
| `terminal_handoff` | Hand the console to the user with a `reason` and wait: the page opens so they can type on the device; your next action on it waits for them and shows where they left it. | no | Refused in plan mode. The events say that they typed, never what. |

Approval is per device: the card names the `host:port`, and **allow for this session** on it covers connect, send, press and disconnect there; another device asks again. A sent line carrying a whole word that can wipe what a device holds (`reboot`, `erase`, `format`, `shutdown`, `reset`, `delete`, `destroy`, `wipe`, `reload`) asks every time, rule aside, and the card names only the matched word, never the line — which also keeps a secret that expands to such a word off the card. `terminal_sessions`, `terminal_read` and `terminal_wait` ask nothing and work in plan and `read-only` modes; `terminal_handoff` asks nothing but plan and `read-only` refuse it, as the browser's does.

### Trusting a device

The first SSH login to a device whose host key nobody has trusted stops before anything is sent and asks you: the card shows the key's type and its SHA-256 fingerprint. **connect once** lets this login and asks again next time; **trust for good** appears only for devices on this network (a private, loopback or link-local address, or a name like `sw1.lan`) and keeps that exact key in `terminal-host-keys.json` in Circle's data folder. A public device is asked about every time, as its browser's certificate warning would be. A device that answers with a different key than the one you trusted is asked about again. `auto` mode answers once by itself and never trusts for good.

### Saved sessions

Profiles are like SecureCRT's session list, and a person's to edit — in the file itself, and the desktop application's terminal lists them under its **+**; the model only names them. `terminal-sessions.json`, in the same folder as `settings.json`:

```json
{ "sessions": [
  { "name": "LAB-DEVICE-01", "transport": "ssh", "host": "sw1.lan",
    "user": "operator", "auth": { "password": "LAB_PASSWORD" } },
  { "name": "rack console", "transport": "telnet", "host": "10.0.0.5", "port": 3001 }
] }
```

`auth.password` and `auth.passphrase` name saved [secrets](security.md#secrets-by-name) — never values; a worded like a value is dropped, not trusted. `auth.key` is a private key's path, taken as the file tools take it, and a credential file is refused. Ports default to 22 for SSH and 23 for Telnet; `cols` and `rows` to 80×24, which is where a console starts: while its page is open the device takes the page's size, as a terminal window gives its own. A device's password never stays in the transcript: values saved as secrets come back as `%NAME%` wherever they appear, including in what the device showed.

Serial ports and file transfer (SFTP, Zmodem) are not in this version; see [Known issues](known-issues.md).

### Taking turns

`/terminals` lists the conversation's terminals, running first, then the profiles not open: `enter` opens a console's page or connects a profile, `ctrl+d` cuts a console after asking. The page shows the device's screen as the device drew it, colours and all, with its band above: lamp, name, state, quiet time, and on its second line the transport and the size the device is laid out at. Opening the page, or resizing the window, gives the device that size, so a switch lays its tables out for the width you have instead of an 80-column one cut in half at 62. `pageup`, `pagedown`, `home` and `end` scroll back; `esc` leaves the page. `enter` attaches: from then on every key goes to the device — its Ctrl-C, its Esc, its arrows — and only **ctrl+]** gives the keys back to Circle, the page staying open. While you hold a console the model's actions on it wait, and its next result tells it that you typed, never what. `terminal_handoff` opens the page attached and waits for the card's **continue**, which gives the console back to the model; any other card that needs you takes the frame and drops the page until it is answered. In the desktop application the same sharing lives in the [terminal panel](desktop.md#the-terminal).

### Your terminal tabs

In the desktop application the same tools also reach the shells you open as terminal tabs: `terminal_sessions` lists each running one as `local:<id>` with its tab's name (`local:… · terminal 1 · local zsh in /path/to/project · quiet 3s`), never a background command, a service or a closed shell. Reading and waiting ask nothing. The first thing the model types in a tab asks you in every mode, and the card says it will type that command into the tab; once you allowed it, a line it runs there (`terminal_send` with `enter` or a line break, `terminal_press` of `Enter` or `Ctrl_D`) is approved as the same `execute` command would be, under the same rules; typing without Enter and other keys ask nothing, and plan mode refuses every write. Text for a tab takes no control characters. When you take a tab over, the model's read or wait on it ends at once and its typing is refused until you hand it back; `terminal_disconnect` refuses a tab, which only you close. See [Circle in your terminal tabs](desktop.md#circle-in-your-terminal-tabs). The terminal interface has no terminal tabs.

## Working with you

| Tool | What it does | Asks |
|---|---|---|
| `write_todos` | Keep the plan shown in the plan box. | no |
| `question` | Ask you one or more questions with options, or ask for a secret. Your answers become the tool result. A question with a `key` keeps your answer as a variable, a secret question as a secret, both written `%KEY%` afterwards. See [Answer a question](usage.md#answer-a-question) and [Secrets](usage.md#secrets). | no |
| `plan_enter` | Switch to `read-only` mode, as `/plan` does. | no |
| `plan_exit` | Ask you what to do with the finished plan: implement it in `auto` mode or with manual approval, which leaves `read-only` mode; change it, and the model gets what you write; or save it and change nothing. Only you can answer, so it fails without the full-screen interface or the desktop application. | no |

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

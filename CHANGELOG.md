# Changelog

All notable changes to Circle are listed here, newest first. Circle follows [Semantic Versioning](https://semver.org) from 1.0 on.

## Unreleased

Circle 1.7.0, 1.7.1, 1.7.2 and 1.7.3 were tagged but never published, so this is the first release since 1.6.0 and it includes all of their changes. Coming from 1.6.0, one of them needs you to act: since 1.7.0 the bundled hub extension is named `hub`, with `/hub` commands and `hub_*` tools, and the former `circle-server` extension and `/server` commands no longer work. Enable `hub` and sign in again; [1.7.0](https://github.com/circle-platforms/circle/blob/main/CHANGELOG.md#170---2026-10-15) has the details.

### Changed

- **Several terminal keys moved.** `alt+l` chooses a model, and `ctrl+l` only redraws the screen. `alt+m` switches to the next model, and `ctrl+p` and `ctrl+n` now go through earlier prompts, as `↑` and `↓` do. `alt+c` copies the last answer, where it was `ctrl+x`. `alt+k` enters a secret a task waits for, where it was `ctrl+s`, which many terminals take as a signal to freeze. In `/models`, `/effort` and the default-mode list `alt+d` saves the choice as the default, where it was `ctrl+s`; `ctrl+k` deletes a session in `/resume` and stops or removes a job in `/jobs`, where it was `ctrl+d`. `ctrl+u` deletes back to the start of the line instead of clearing the box, and `ctrl+y` puts that text back. See [Keybindings](docs/keybindings.md).
- **Project instruction files and skills come from the workspace folder only.** `AGENTS.md`, `CLAUDE.md` and project skills in the folders above it are no longer read, so a session opened in a subfolder of a checkout does not get the checkout's `AGENTS.md`. Your own files in the data folder and your home folder still apply everywhere. Only the first 24,000 bytes of each instruction file go into the prompt, with a note when the rest was left out. See [Instruction files](docs/configuration.md#instruction-files).
- **Anthropic models think at `medium` by default**, where it was `xhigh`. `/effort` sets another depth, and `alt+d` there keeps it as your default. The system prompt and the tool descriptions sent with every request are shorter. See [Thinking depth](docs/models.md#thinking-depth).
- **`esc` no longer throws a draft away at once.** With text in the box, a first `esc` keeps it and a second clears it; `ctrl+y` brings it back.
- **`websearch` uses your model provider's own web search when it has one.** It sends only the query, not the conversation, over the endpoint and key you already use: OpenAI, xAI, Anthropic, Bailian (Qwen), Zhipu (GLM), Gemini, Kimi, Volcengine Ark, Mistral and Groq's GPT-OSS models, and a compatible endpoint that shows the search really ran. Otherwise, or when that search fails, it searches DuckDuckGo as before, and the result says why. There is nothing to set up, but the provider's model limits and search charges apply: the search request's tokens count toward the session, and a search fee Circle has no price for is not counted. A DuckDuckGo challenge page is now an error rather than an empty result, and the other DuckDuckGo address is tried. A search can take up to 60 seconds, where it was 20. See [Reading and searching](docs/tools.md#reading-and-searching).
- **A model response that ends incomplete stops the turn, and its tool calls do not run.** A response cut off at its output limit, filtered, paused, ended without a complete finish signal or for an unknown reason, or empty, stays in the conversation with what it said, and Circle names the cause, such as `model output limit reached; response incomplete`. None of its tool calls run, even those that look complete; send a message to go on. Before, an empty response without a finish signal was sent again once, and the tool calls of a cut-off response could run. `CIRCLE_LLM_VERIFY_FINISH` no longer changes anything. With `--mode json`, `assistant` events carry the finish reason as `completion` and `error` events the cause as `completion_failure`. See [When a request fails](docs/models.md#when-a-request-fails).
- **New session in the desktop application opens a home page instead of creating an empty session.** New session in the sidebar, the + beside a folder, the sessions page and the file menu show a message box with a session's attach, mode, model and thinking depth controls, and a project menu listing every folder Circle knows, the default `circle` workspace included. The menu starts on the project you were just in, and can open another folder or choose no project; a session with no project works in `unscoped` inside the data folder and has no folder group in the sidebar. The first message creates one session in the project the menu shows. Until then nothing is saved: the draft and the choices stay while you look at other sessions, and empty sessions no longer fill the sidebar. An untrusted project asks for trust first and then sends the message. See [Organizing sessions](docs/desktop.md#organizing-sessions).
- **The desktop sidebar starts with recent sessions.** Recent lists the newest sessions from every folder and from no project, five until you ask for more. A row shows only the title; hovering or focusing it shows the folder and when the last message came. `↑` and `↓` move between sessions, `tab` moves to the next folder, and `→` or `shift+F10` reaches a row's menu. Search finds Circle's replies as well as yours.
- **Renaming a session, or going back to an earlier message, no longer moves it to the top** of the desktop sidebar or of the terminal's `/resume` list: sessions are ordered by their last message. In the desktop application the open folder no longer jumps to the top either.
- **Browser clicks wait for what covers their target.** `browser_click`, `browser_type` and `browser_select` wait up to 3 seconds for a loading mask or a message over the element to go, then refuse and name it; a dialog or drawer is named as soon as the page is still. A click aims at a part of the element nothing covers, such as one line of a link that wraps or a checkbox's label, and its result comes once the page stops changing, at most 1.5 seconds after the network is quiet. `browser_click_at` no longer calls a screenshot stale because something elsewhere on the page changed, such as a clock; it still does when the page scrolled or resized, or changed where it clicks. In the desktop application and in the terminal's browser. See [The browser](docs/tools.md#the-browser).
- **A conversation open in one Circle terminal is read-only in another.** Several terminals can use the same data folder and project with different conversations, but a conversation runs in only one of them at a time. Another can read its saved history but cannot continue, change or delete it, and says `session is in use by another Circle runtime; stop and release it there, or fork it`; the desktop application shows such a conversation view only. A normal exit releases it; after a crash, allow up to 30 seconds. See [Concurrent conversations](docs/sessions.md#concurrent-conversations).

### Added

- **`circle uninstall` removes an installed Circle.** It takes out the launcher, every version under the prefix, the receipt and the PATH change the installer made; the data folder stays unless `--purge` deletes it too. On a terminal it lists what goes and asks — `--yes` skips the question and is required without one. See [Uninstalling](docs/cli.md#uninstalling).
- **Sessions are named by the model.** After the first turn, the terminal and the desktop application ask the session's model, in one short request without thinking, for a title that sums up the first message. Until it comes the terminal shows a short title cut from the message and the desktop shows new session. When the request fails, `title failed` says why and the short title stays. A name you give with `/name`, its new alias `/rename`, or a rename in the sidebar is kept.
- **Code blocks name their language and are coloured**, in the terminal and in the desktop application, where a code block also has a copy button.
- **More keyboard in the desktop application.** `ctrl+k` searches from anywhere, `ctrl+b` hides or shows the sidebar, `F2` renames the open session in place in the sidebar, `alt+c` copies the last answer, `ctrl+shift+m` opens the model list and `alt+m` switches to the next model. Settings lists the shortcuts, and each can be changed and reset. See [Keybindings](docs/keybindings.md).
- **`/resume` finds a session by what was said in it**, your messages and Circle's replies, not only by its title. Sessions that share a title show the start of their first reply to tell them apart.
- **`/continue` in a fresh terminal opens the latest session in the folder** when there is no previous session to switch back to.
- **Conversations keep running while you switch to another one.** In the desktop application, starting or opening a conversation leaves the others running, now also in the same folder; each keeps its draft, attachments, scrolling, queue and approvals, and stop stops only the one you are in. In the full-screen terminal, `/new`, `/resume` and `/continue` switch while a turn runs, where they said `a turn is running`; `alt+s` opens the session list even while an approval waits, the list marks the conversations that run or wait for you, and switching back brings back the draft and the waiting card. A background job's result goes to the conversation that started it. Deleting a running conversation, in the desktop or with `ctrl+d` in the session list, asks to stop it with its subagents and jobs, and deletes its history only once they have stopped. Leaving the terminal stops every conversation it runs, and `/login` and `/logout` are refused while any of them or a job still runs. Conversations in one folder share its files. See [Concurrent conversations](docs/sessions.md#concurrent-conversations).
- **Full view for the desktop browser and terminal panels.** **full view** in the panel's header takes the panel across the whole workspace, so a wide device web interface fits. The conversation's input box, plan, requests and jobs stay usable below it, and the sidebar still switches sessions. Click it again, or press `esc` in the view, to get the split back with the conversation as you left it. A window too narrow to split does not offer it. See [The window](docs/desktop.md#the-window).
- **Browser snapshots show the state of controls and what is covered.** After an element the snapshot says `checked`, `unchecked`, `mixed`, `pressed`, `selected`, `expanded`, `collapsed`, `disabled`, `required` or `invalid`, read from the page's ARIA attributes, the native control or a UI kit's switch, also for a see-through checkbox under a styled switch. An icon-only button gets its icon's name (`button "" icon=delete`), and an element under a dialog, drawer, mask or message is marked `[covered]`. On a page too long for the snapshot, the dialogs, drawers and menus on top of it are kept. In the desktop application and in the terminal's browser.

### Fixed

- **Starting Circle and every `/new` saved an empty session**, which then filled `/resume` and the desktop sidebar. A session is now saved when its first message is sent.
- **An absolute path such as `/srv/app` or `/data/logs` was taken as a folder inside the workspace.** Every absolute path is now used as it is, and on Windows drive paths and `\\server\share` paths are too.
- **Stopping a turn while the answer was streaming lost what had been written.** The partial answer now stays in the conversation, marked interrupted, and the footer counts its tokens, estimated where the endpoint did not report them; a cost from an estimate starts with `~`. The footer says `cache N/A` when the endpoint does not report cache use.
- **A model id the endpoint did not know showed its raw error response.** `/models <id>` now says `model set to <id>`, adds `not listed by this endpoint` when the list can be read and lacks it, and a turn the endpoint rejects for the model shows a short message.
- **In a short desktop window the input box could be pushed off screen**, and keys typed right after `ctrl+n` could be lost. The box stays in view at any height, and those keys go into it.
- **The desktop application loaded MCP servers and extensions, such as `hub`, only when the first message was sent**, so the hub pages stayed empty after a fresh start until a reload. They now load as soon as the application starts in a trusted folder. The window stays usable while MCP servers connect, a failure shows in the runtime status and reload tries again; an untrusted folder waits until you trust it, and closing the application while they load stops them. See [An interface in the desktop application](docs/extensions.md#an-interface-in-the-desktop-application).
- **The desktop hub pages could lag behind `/hub refresh`, or go back to older records.** `/hub refresh` now returns once the pages show what it read. When reads overlap, as a refresh, an approval and a followed task ending can, one that started earlier no longer replaces the records of one that started later.
- **A large hub history emptied the desktop hub pages.** They now show the records that fit in the 64 KiB the application allows for the view, shared between the lists, with a note of how many were shown and left out and how many texts were shortened; full task details stay on the hub. The hub's address and your user name are never shortened.
- **Continuing a conversation after changing the Anthropic endpoint, key or model could fail** with an error about an invalid signature in a `thinking` block. Circle now leaves earlier thinking out of the request when the endpoint, key or model differs from the one that wrote it, keeping the text, tool calls and results. For a conversation saved before this release, or imported, it tries once more without that thinking after such a refusal. The saved conversation is not changed, and thinking stays on.
- **After the model entered or left plan mode in a reply that also called other tools, the next request could fail.** Anthropic answered `tool_use ids were found without tool_result blocks immediately after`, and strict OpenAI-compatible endpoints refused it too. Circle now sends the tool results before the mode change, also for conversations already saved that way; the saved history is not changed.
- **Newer Claude models showed their tool calls but no thinking.** For the Claude models documented to give thinking summaries, Circle now asks for them (`display: "summarized"`); an endpoint that refuses the field is asked once more without it. Hiding thinking still changes only what is shown, not the request. See [Thinking depth](docs/models.md#thinking-depth).
- **An error from an earlier turn could move below later replies.** In the terminal and in the desktop application an error now stays after the response it belongs to, also when the session is opened again, and the desktop's notice of the last error goes away when you continue.
- **The model looked for `AGENTS.md` and other instruction files that did not exist**, and the failed `read_file` showed in the conversation. Circle now tells it that the instruction files that exist are already in its prompt. See [Instruction files](docs/configuration.md#instruction-files).
- **Two Circle terminals on one data folder could lose each other's prompt history**: each saved its own list over the file. Circle now adds an entry to the file as it stands at that moment, keeps an entry it could not save and tries again, and `↑` and `ctrl+r` also find what another terminal added since you started.
- **Opening a site with an untrusted certificate in the terminal's browser could report a loaded, empty page** before the browser's warning appeared, so the model found no **Advanced** button. `browser_navigate` now waits for the page it asked for, the warning included, and fails when it never comes.
- **A page that closed its own window emptied the desktop browser's tab**, as a device's web interface can when it closes a side panel. As in Chrome, a page can now close only a tab it opened itself; a tab you or Circle opened stays.
- **Going back to a certificate warning already answered showed a dead page** in the desktop browser, with the site's address still in the bar. An answered warning now leaves the tab's history, as in Chrome, so going back, from the panel or from the page, returns to a real page.
- **Closing the terminal's browser could leave Chrome running, report a failure, or keep Circle from ending.** Circle now waits for the Chrome it started to exit and stops it by force when it does not, also when Windows' `taskkill` refuses the plain stop. A Chrome whose connection was lost is still stopped after another one starts, a Chrome that has already exited no longer counts as a failure to stop, and a helper process Chrome leaves behind no longer keeps Circle running. When Chrome really cannot be stopped, deleting its session fails and keeps the history, so you can try again.
- **`browser_handoff` started Chrome before refusing** where no one can take the browser, as with `-p`, `--line` or `--mode`. It now refuses before starting anything.
- **Open folder on Linux could show a file chooser, close at once, or open nothing** after you chose a folder. The desktop application now uses a folder chooser that returns the folder, and says `folder could not be opened` when none comes back. On every system, a folder holding a subfolder Circle cannot read now opens.
- **The desktop application named its own workspace `workspace` instead of `circle`** when its data folder was reached through a symbolic link.
- **Replacing the Python circle on Windows was slow, and could go ahead while one of its programs was still in use**, then fail halfway. The installer now looks for running processes only when a program of the old copy is in use, asks Windows directly instead of through PowerShell, and gives up after 30 seconds. When it cannot tell which process holds the program, it names the program and stops without changing anything; close those sessions and run it again. See [Replacing the Python circle](docs/installation.md#replacing-the-python-circle).

## 1.7.0 - 2026-10-15

### Changed

- The bundled hub extension is named `hub`, uses `/hub` commands, `hub_*` model tools and `CIRCLE_HUB_*` injected run variables. The former `circle-server`, `/server` and tool/protocol names are no longer supported; enable `hub` and sign in again. Generic module flows, result artifacts, expired cursors and token rotation use the current hub contract.

## 1.6.0 - 2026-10-14

### Changed

- **The busy word counts whole seconds**, as the line under each turn and the strip do: `Brewing… · 12s · ↓ 1.9k`, where it said `12.4s`.

### Added

- **Organize sessions from the desktop sidebar.** The ⋯ beside a folder starts a session in it, shows it in Finder or the file manager, collapses the folders or archives all of its sessions; a session's ⋯ pins, renames, archives, restores or deletes it. Archiving hides a session without deleting its history or touching the folder: all sessions → archived sessions lists it, it stays readable, and restoring it lets the conversation go on. A session that is running, waits on a request or runs a background job cannot be archived or deleted, and archive all changes nothing while one of the folder's sessions is busy. See [Organizing sessions](docs/desktop.md#organizing-sessions).
- **The desktop default workspace can live outside the data folder.** Settings → default workspace → change… picks another folder, such as one on another drive. It is saved as `workspace_folder`, needs trust like any folder you open, and moves no files. See [The default workspace](docs/desktop.md#the-default-workspace).
- **Choose your provider when you connect.** Setup, `/login` and the desktop connection form start with a list of providers that fills in the API URL, which stays editable, and the protocol; `custom` finds the protocol for any other endpoint, as before. A provider without a model list Circle can read offers its released model ids, unverified, and you can type another; the desktop form marks them `preset` under the date of the list, and asks Azure OpenAI and Foundry for your deployment name. See [Models](docs/models.md#connect-an-endpoint).
- **Clicking where the screenshot shows.** `browser_click_at` clicks a point of the latest screenshot, for a control the snapshot gives no ref, such as a "…" button drawn without a role. An unknown or destructive target asks once in every mode but `auto`, a screenshot that scrolling, another tab or the page itself made stale is refused, and the click is not recorded into scripts. In the desktop application and in the terminal's browser.
- **`alt+p` focuses the plan in the terminal**; `↑` and `↓` then scroll its steps and `esc` returns to the input. Clicking the plan focuses it too. The key is `plan.focus` in [keybindings](docs/keybindings.md).
- **`CIRCLE_TRUST_CERTS`** adds certificate files for one run, separated like `PATH`, on top of `trust_cert_files`.

### Fixed

- **The desktop application left out `trust_cert_files`, `SSL_CERT_FILE` and the proxy variables** for the model and its tools. Its runtime now sets up the network as the terminal does: it keeps the default authorities and adds yours, and the commands and Node.js tools Circle starts get the same authorities through `SSL_CERT_FILE` and `NODE_EXTRA_CA_CERTS`. The terminal's welcome and session report, and the desktop settings' network trust section, say which authorities and proxy are in force.
- **`websearch` and `webfetch` said only "fetch failed"** when the network failed. They, model requests and model discovery now name the host and its cause (DNS, TLS, proxy, timeout, connection or the HTTP answer), without proxy credentials or the query, and point to `HTTPS_PROXY` when the endpoint could not be reached. See [Web access](docs/environment-variables.md#web-access).
- **Reading past the end of a file was an error.** `read_file` with an `offset` at or past the last line now says how many lines the file has, and the model reads on from a valid offset.
- **Anthropic model lists stopped after 20 models, and Together's list was refused.** Circle now follows every page of an Anthropic list and fails rather than keep part of one, and reads a list given as a bare array.
- **A download could be reported as a loaded page without asking** when the browser announced it late. Navigation now waits for the download, which asks as usual. When a download manager's integration takes the file before the terminal's browser does, the result shows the HTTP response the browser received.
- **A page that closed its own tab crashed the desktop application.** The tab closes and the browser goes on.
- **After a failed address the desktop address bar kept it** when you changed tabs or sessions, and a late result could land on the wrong tab. It now shows the address of the tab you are on.
- **The desktop address bar refused an address without `https://`** and called every address it could not read a failed navigation. `example.com`, `localhost:8080` and `10.4.2.90:8443` now open over HTTPS, and an address that is not a web address shows `invalid address` and keeps the loaded page.
- **A finished plan stayed on screen.** Completing every step hides the plan in the terminal and in the desktop application, with one notice; a restored session does not notify again, and the plan-exit question still shows the plan.
- **A subagent that only ran tools showed nothing of what it did.** Its current step, and that it waits on an approval, now show while it runs.
- **Going back to a desktop session that waited on an approval failed** with "a turn is running" once you had opened another folder, so the approval could not be answered.
- **A Windows update restarted Circle with its arguments split** at spaces and quotes. Paths with spaces, quotes, trailing backslashes, empty arguments and Unicode now keep their boundaries.
- **After a Windows update the desktop application could miss that it had been updated** when it started while the installer was still exiting and held its output files. It now reports the new version, and removes what the installer left then or at the next update.

## 1.5.0 - 2026-10-14

### Changed

- **Auto mode asks nothing in the browser either.** Passing a certificate warning and giving a page files no longer ask in `auto` mode, and the model's result names the certificate it passed; in the desktop application a page's permission request and a site's request for a client certificate are refused without asking. Turning `auto` on says what it lets through.
- **The Windows installer leaves other programs alone.** Installing, updating and removing Circle no longer go through Windows' Restart Manager, which closes programs that hold files the installer replaces; Circle's own update already waits for Circle to end. Quit Circle before you remove it, or Windows removes the files it holds at the next restart. Updating from 1.4.1 or earlier still removes the old version through it once.
- **You give the browser back by going on in the conversation.** The desktop panel's **hand back** button is gone: **continue** on the card in the conversation, or any message to Circle, returns the browser, and in `auto` mode Circle takes it back by itself once you stop or the page moves on. The model no longer hands you the browser for a certificate warning, a dialog or a stale element, and plan mode hands nothing over.

### Added

- **Record what Circle did in the browser as a script, and replay it.** Asked to save a browser session for reuse, a model had no way but to rebuild it from the site's HTTP requests or to install another browser tool. `browser_record` now writes the conversation's browser actions to a file in Circle's own format (`"circle": "browser-script/1"`), each element kept by its role and name as the snapshot shows it, with `nth` among equals, values as `%NAME%`, and a certificate warning passed as a `proceed` step; the model then cleans it up and adds `expect` checks. `browser_replay` runs such a file step by step without the model in between, waiting for each element, typing secrets as secrets, asking once for the site it starts on and acting on no other, and stops at the first step that cannot be done with the page as it is, so that the model fixes the file and goes on `from` that step. In the desktop application and in the terminal's browser. See [Recording and replaying](docs/tools.md#recording-and-replaying).
- **A click that deletes on a page asks every time** in manual and accept-edits mode, though the site is allowed for the session: a control named 删除, 清空, Delete, Remove, Reset and the like, or accepting a dialog that says so. `auto` mode does not ask.
- **A saved secret goes into no page on a public address whose certificate was not trusted**, typed or given to a sign-in, in every mode; on this network it is typed as before.

### Fixed

- **The terminal's browser forgot who passed a certificate warning when the site sent its page on**, as a device sends `/` to `/login`: the model was not told whether the user or Circle proceeded. It is told now for any page on that host.
- **A browser action's result repeated the model's own words for the element instead of naming the one it acted on.** A model that took ref `e28` for the network menu was told `Clicked e28 "网络菜单".` when it had clicked the host settings link, and went on believing it. A click, typing, a choice or a file given to a ref now names the element as the snapshot shows it, read from the page at that moment (`Clicked e28 link "主机设置".`), and says when the model described another one: `— you described it as "网络菜单"; check the snapshot`. The pointer's label and the field in an upload's approval show the page's name too. In the desktop application and in the terminal's browser. See [Tools](docs/tools.md#the-browser).
- **A user name that is also the password showed to the model as the secret's name.** With a password such as `admin` saved as a secret, a sign-in page's user name field read `value="%NAME%"` after the model typed `admin` into it, so the model took the name for text typed by mistake, deleted part of the user name and failed to sign in; it also told the model what the password was. A secret's value now stays as written where it stands as a word in what you or the model wrote in the conversation, in a tool's result and in a background job's notice.
- **The desktop browser panel left a blank band under its footer** in a tall window: the page had a fixed height. It now fills the panel under the bars.
- **The desktop plan showed three and a half rows**, cutting the fourth in half, and the step under way could be scrolled out of sight. It now shows whole rows and keeps the step under way, or else the next one, in sight.

## 1.4.1 - 2026-10-13

### Fixed

- **The terminal's browser gave up on Chrome after 20 seconds** with "browser action timed out"; a first start with a new profile on a busy Windows machine can take that long. It now waits a minute, and says the browser did not start.
- **A click that led to the browser's certificate warning could be reported as a page whose certificate was accepted** on a slow machine, when the warning arrived while the result was being put together. The terminal's browser now reads the page first and describes the page it read.

## 1.4.0 - 2026-10-13

### Added

- **Extensions are told when Circle closes them.** `api.signal` fires when Circle leaves and before extensions are loaded again, and Circle waits for work an extension handed to `api.background`, so nothing of an extension loaded before goes on running after `/extensions reload`.

### Fixed

- **The circle-server extension went on following a task after Circle left it**, reading its secrets file and the server after `/extensions reload` or after Circle ended; it now stops at once, and `/server task` picks the task up again.
- **A screenshot on a slow Windows machine failed after 20 seconds** with "PowerShell did not take the screenshot". PowerShell builds a small window helper for each screenshot, which on a busy machine can take longer than that; it now has a minute, and when it runs out of time the error says so.

## 1.3.1 - 2026-10-13

### Fixed

- **The desktop update check leaves a Circle installed on the machine alone.** `npm --prefix apps/desktop run test:update` refuses to run beside a Circle in `C:\Program Files`, but then stopped that installation's processes and removed it; now it removes only what it installed itself, a partially failed install of its own included.

## 1.3.0 - 2026-10-13

### Added

- **The browser: web pages Circle and you use together.** Ask Circle to open a page, such as a device's web interface on your network, and it uses the browser as you would: it reads the page, moves a visible pointer to click and type, follows new tabs, and answers the page's alert, confirm, prompt and "leave site?" questions, which wait in their tab and show in the conversation. A certificate warning shows in the tab like any page; passing it asks you first, also in `auto` mode, and on a private host you can trust that certificate for good. Downloads, and the file chooser a page opens, reach the model and you. In the desktop application the browser is the browser panel; in the terminal's full-screen interface the same tools drive the Chrome, Edge or Chromium installed on the machine, in a window of its own with a temporary profile (`CIRCLE_BROWSER` names another), and the approvals are cards. See [Tools](docs/tools.md#the-browser).
- **Taking turns in the browser.** The model can hand you the browser (`browser_handoff`) for a security key, a CAPTCHA or a choice that is yours, and waits until you hand it back; it then learns where the tabs went, never what you typed. In the desktop application a clear layer over the page while Circle acts lets you take over once the action ends.
- **Browser approvals by site.** Reading a page never asks. Acting on a page is allowed site by site, "allow on *site* for this session", and an action that finds the page on another site by then does nothing. A download that Circle's action starts from a site not yet allowed waits until you keep it, keep that site's downloads for the session, or discard it; `auto` mode keeps it. Giving a page files asks every time, also in `auto` mode. See [Security](docs/security.md#the-desktop-browser).
- **HTTP sign-in, page permissions and client certificates in the browser.** A site or proxy that asks for a user name and password waits as a dialog: you answer it in the panel or the conversation, or the model answers with a saved secret as the password. Camera, microphone, location, notifications, clipboard reading, MIDI, idle detection and window management are yours alone to allow, from a bar under the page; everything else a page asks for is refused. A client certificate is chosen by you, or none is sent; the desktop application used to send the first certificate in the store without asking.
- **Variables and secrets, for every tool.** `/variables NAME=value` in the terminal, or settings → variables in the desktop application, keeps a value the model writes as `%NAME%` in any tool's arguments, as Windows writes environment variables; Circle puts the value in when the tool runs. `/secrets NAME` asks for the value on a masked card: a secret's value never reaches the model, is hidden as `%NAME%` in every result, and is the only thing a password field in the browser takes. A `question` with a `key` keeps your answer as a variable, or a secret question as a secret, written `%KEY%` afterwards. See [Security](docs/security.md#secrets-by-name).
- **Commands allowed by pattern.** `allowed_commands` in `settings.json` holds wildcard patterns (`*`, `?`); a command runs without a card when every part of it matches one, so `npm ci && rm -rf dist` needs both `npm *` and `rm -rf *`. `/approvals add <pattern>` and `/approvals remove <pattern|n>` manage the list, `/reload` re-reads it, and a trusted folder's `.circle/settings.json` can add to it. See [Usage](docs/usage.md#fewer-asks-for-the-commands-you-trust).
- **`default_mode` in `settings.json`**: the mode new sessions start in, `manual`, `accept-edits`, `plan` or `auto`. `ctrl+s` in the `default mode` list of `/settings` saves it. A project cannot set it.
- **Extensions can keep secrets.** `api.secrets` keeps values in `extension_secrets/<extension>.secrets.json`, readable only by you, and `api.askSecret` asks for one on a masked card in the terminal and in the desktop application. A secret an extension holds is masked in its tool results, command lines and errors, and the file tools refuse `*.secrets.json`. See [Extensions](docs/extensions.md#secrets).
- **Extensions can show a status line, open a link and know where they are.** `api.setStatus` puts a line at the right of the footer and in the desktop's sidebar; `api.openUrl` opens a web address in the browser, or in the desktop's browser panel; `api.settings`, `api.dataDir` and `api.workspace` give an extension its settings, a folder of its own and the workspace.
- **Extensions shipped with Circle**, off until you turn one on with `/extensions enable <name>`; `/extensions disable <name>` turns it off again.
- **The circle-server extension.** `/server login`, `submit`, `task`, `respond`, `get`, `approve`, `reconcile` and the rest hand work to a [circle-server](docs/extensions.md#circle-server) and follow it; delivered files are saved in the workspace once their SHA-256 matches the server's. The model gets `circle_server_packs`, `circle_server_task` and `circle_server_submit`, which asks first.
- **Desktop pages paired with an extension.** A page shows only while its extension is installed, loaded, of the same version and turned on, and turning it on or off turns the extension on or off. The circle-server extension has five: circle-server, knowledge, work, execution and methods.
- **An extension can add and remove tools while Circle runs.** `registerTool` works after loading too, and `api.unregisterTool` removes one; the model gets the new list from its next turn, so an extension can offer what a service makes available once you sign in.
- **`--extensions` loads extensions and MCP servers in print, line and rpc mode**, which leave them out otherwise; their tools are there from the first turn.
- **Skill packs go from Circle to the server.** `/server trial start` records which server tools a trial uses; `/server skill push <folder>` sends the skill pack with that record, `/server skill run` runs it on the server.
- **The circle-server extension offers the server's tools to the model.** After you sign in, each tool in the server's catalog becomes `srv_<name>`; read-only ones run at once, the others ask first, task tools are waited for in the background, and `/server tools` lists them.
- **MCP servers can be sent headers** over `sse` and `streamable_http`, with `${env:NAME}` read from Circle's environment, so a token need not be written in `settings.json`. See [MCP](docs/mcp.md).
- **`trust_cert_files` in `settings.json` trusts an organization's certificate authorities without an environment variable.** Each entry is a PEM file, `~/` allowed: Circle adds what they hold to the authorities it trusts itself, and starts commands, extensions and their tools with one merged `SSL_CERT_FILE` bundle written under the data folder, the system store included, so a lab CA and the public internet work at the same time. The start says the count and the bundle path, and a certificate failure names what is in force instead of only pointing at `SSL_CERT_FILE`. A machine with nothing configured keeps its environment exactly as it is. See [Settings](docs/settings.md) and [Security](docs/security.md#the-shell-environment).

### Changed

- **Circle moved to the circle-platforms organization**, with circle-hub and circle-packs. The repository is <https://github.com/circle-platforms/circle> and the documentation is at <https://circle-platforms.github.io/circle/>. The old repository address redirects; the old documentation address does not. Installed copies keep updating: the installer and `circle update` follow the redirect, and new installations record the new repository.
- **Circle is licensed under the Apache License 2.0** from this version on; versions up to 1.2.1 were released under the MIT License and stay available under it. A `NOTICE` file names the copyright holder and reserves the Circle and Circle Hub names, logos and icons; the release package and the desktop application carry it next to `LICENSE`, and the Windows installer shows the new license. The architecture and design specifications listed in `docs/design/README.md` are under CC BY 4.0 and must be credited, with a link to the original, when reused. Contributors sign off their commits and accept the contributor terms in `CONTRIBUTING.md`; `docs/open-source-readiness.md` records the licensing state.
- **The documentation site is the English guides.** The TUI contract is in Chinese, and the desktop working notes live under `docs/workbench/`; both stay in the repository and are not pages on the site. The README describes the desktop application with the terminal.
- **`shift+tab` switches the session mode in the terminal** — manual, accept edits, read-only, auto — as it does in the desktop application; the thinking depth moved to `alt+t`. Both stay remappable in `keybindings.json` (`mode.cycle`, `thinking.cycle`), and `/mode` works while a turn runs.
- **The desktop application's connection form asks as the terminal's setup does**: the URL, the key, then a model from the endpoint's list. The kind of API is found by asking the endpoint, refresh models asks it again, and a saved key is kept only for its own host.
- **The desktop input box is one line**, with its frame in the colour of the session's mode; the turn's time shows on its latest tools row, and its total time and tokens once it ends.
- **The Windows installer's last page offers to start Circle**, unchecked; a silent installation never starts it. Installed apps lists Circle with a link to the releases.

### Fixed

- **Approval rules that Circle 0.5.0 had revoked counted as active again.** They are left out now and dropped from the shared `approvals/` files on the next save.

## 1.2.1 - 2026-10-12

### Added

- **The desktop application updates itself** on macOS and Windows. Settings → about → check now asks GitHub for the newest release; update downloads it and checks its checksum (and on macOS its signature), and restart to update puts it in place of the running copy and starts it. A newer version also shows at the foot of the sidebar, with how far the download is. On Windows the installed `.msi` is updated with the new `.msi`. On Linux, check now links to the release page. Versions up to 1.2.0 cannot update themselves: install this one over them by hand once.

### Fixed

- **Check now in the desktop settings did nothing** but say that it needed a connected host, also when the runtime was connected.

### Removed

- **The Windows desktop `.zip`.** Windows gets the `.msi` alone, which installs Circle and updates it; a copy run from an unpacked folder could not update itself.

## 1.2.0 - 2026-10-12

### Added

- **Accept edits, a mode between asking and auto.** File changes inside the workspace run without a card; commands, deletes and changes outside the workspace still ask. `/mode` moves through manual, accept edits, plan and auto, or sets one: `/mode accept-edits`. When the model finishes a plan you can answer "implement plan, accept edits". The desktop application has the four modes in a menu under the input box, and `shift+tab` moves to the next one.
- **The desktop application in Simplified Chinese.** It follows the system language the first time; settings → appearance → language switches between English and 简体中文. Menus, system dialogs and notifications follow. The terminal stays English.
- **A Windows installer for the desktop application**, `circle-desktop-<version>-windows-x64.msi`: it installs Circle for all users into `C:\Program Files\Circle`, adds it to the Start menu and removes it from Installed apps. The `.zip` stays for use without installing.
- **The desktop application tells you when it needs you** while its window is in the background: a system notification for an approval or a question and when a turn ends, a count of waiting requests on the Dock icon on macOS, and a busy bar on the taskbar on Windows and Linux.

### Changed

- **The desktop application is laid out like Claude's.** Folders and their sessions in the sidebar, with customize for skills, commands, MCP servers, extensions, tools and approvals; the session's title and folder in the top bar, with the side panels (terminal, files, changes, activity, browser, context) opening on the right; tool calls folded to one line, such as `ran 2 commands, edited calc.py +1 −1`; and under the input box the mode, the model, the thinking depth and a ring for the context, whose popover has the tokens, cost and cache.
- **Approvals and questions appear in the desktop conversation**, under the call that waits, with the change as a diff, instead of behind a button. A finished file change shows its diff, and the changes panel lists what the session changed.
- **The desktop input box has the terminal's frame**: the rainbow turns while the model works, with the busy word, time and tokens on its edge, and it is orange while Circle waits for you.
- **Text size in the desktop application is one setting of four sizes**, and the default is larger: 14 px instead of 13.

### Fixed

- **The desktop application asks for the API URL, key and model the first time**, as the documentation said; it opened on an empty conversation that could not answer.
- **The desktop footer showed `cost N/A` and a context share summed over every answer.** It now shows the session's cost as the terminal does and the context of the last answer.
- **Tool calls keep their order in the desktop conversation** while one waits for approval; a finished call moved below the waiting one.
- **The desktop files panel lists the folder Circle works in** when it is trusted, including the application's own folder, without opening it again.
- **Changing only the URL or the model in the desktop connection form keeps the saved key**; it had to be entered again.

## 1.1.1 - 2026-10-11

### Fixed

- **`esc` and a letter typed quickly after it are two keys.** Within a quarter of a second they were read together as `alt` and the letter: the turn went on, the letter was lost, and `esc` then `v` pasted the clipboard picture.
- **The desktop application sends pictures larger than about 750 KB**, which is most screenshots. It refused them as an invalid attachment, and a message of more than 5 MB as an invalid payload; the picture stayed in the box and every later message failed with it. A message may now carry pictures and PDFs of up to 20 MB each and 64 MB together, and the core scales large pictures down as in the terminal.
- **The desktop's attach button takes pictures and PDFs up to 20 MB**, not 4 MB, and **a chosen PDF goes to the model**. A placeholder text was sent in its place, and the message failed.

## 1.1.0 - 2026-10-11

### Added

- **The Circle desktop application.** A window of its own around the same Circle that runs in the terminal: conversations and their history, approvals, questions and secrets as cards, files and diffs, background jobs, subagents, models, MCP servers, extensions and skills. Pictures and PDFs go with a message by the attach button, by pasting or by dropping them on the box. It keeps its own data folder, apart from `~/.circle`, and asks for the API URL and key the first time. Each release has it for macOS (Apple silicon and Intel, as a `.dmg`), Windows x64 (`.zip`) and Linux x64 (`.tar.gz`), as `circle-desktop-<version>-<os>-<arch>`. It is not signed by Apple or Microsoft; see [Installation](docs/installation.md#the-desktop-application) for the first start.

### Fixed

- **`/login` shows its first question at once.** It opened on a bare `type to search` line, and the base URL with the saved one filled in appeared only after the first key.
- **A large picture you paste, drop or mention tells the model both sizes**, as one read with `read_file` does: `[Scaled down to send: shot.png 3000×2000, sent as 1313×875]`. It was scaled down without a word, so the model could take positions on the smaller picture for the real ones.
- **On Windows, an `AGENTS.md` or memory file is no longer skipped as a copy of another.** Files were told apart by their file id as a number, and Windows file ids are too large for that: two files made one after the other could round to the same id, and the second was left out of the model's instructions.
- **A scaled-down picture stays within 1.15 million pixels.** Its sides were rounded to the nearest pixel, so a 3000×2000 picture went as 1313×876, just over the limit.

## 1.0.5 - 2026-10-11

### Added

- **Send a steering message at once.** While a steering message waits, `enter` on the empty input box has the model read it now: the step under way stops (the reply it was writing is dropped, a running command or subagent is stopped, finished tool results stay) and the same turn goes on, with no `✖ Interrupted`.
- **Take back one waiting message with `↑`.** In an empty input box, `↑` takes back the last message the model has not read yet, to change it or drop it; `↑` again takes the one before. `alt+↑` still takes back all of them.
- **Show the model a picture.** `ctrl+v` (or `alt+v`, for Windows Terminal) pastes the picture on the clipboard, or image files copied in Finder or Explorer, as `[Image #1]`. Files dropped on the terminal go in the same way, and `@` now takes a quoted path, a path with `\ ` before its spaces, a name with `@` in it, and images or PDFs from outside the workspace.
- **A `screenshot` tool.** The model can take a picture of the main screen, or of one application's window, to see an app it is building or the problem you describe. It asks you first each time unless you allow it for the session, and it does not run in `read-only` mode or over `ssh`.
- **`"images": true` or `false` for a model under `models` in `settings.json`**, where models.dev is wrong about whether it reads images.

### Changed

- **A request that times out is sent again up to 10 times**, instead of ending the turn. A timeout is no answer within `CIRCLE_LLM_TIMEOUT`, a stream with no content for `CIRCLE_LLM_STALL_TIMEOUT`, or a gateway's 408, 504 or 524. Each try waits twice as long for the answer to start (up to 5 minutes) and for content (up to 8 times as long), and the busy line says which try it is: `Retrying… · timeout 3/10`. A timeout or a dropped connection is retried even when part of the answer had come; that part is dropped.
- **Large PNG pictures are scaled down** to at most 1,568 pixels on the long side and 1.15 million pixels before they are sent, and the model is told both sizes. A conversation that collects more than 8 pictures or PDFs (or 16 MB of them) leaves the older ones out of its requests down to the newest 3; the conversation keeps them all.
- **A model known not to read images gets the paths only**, and the screen says so. Whether a model reads images comes from models.dev.
- **The prompts taken from OpenCode carry its MIT notice** in `THIRD_PARTY_NOTICES.md`.
- **The documentation is published at <https://circle-platforms.github.io/circle/>.** The guides and reference in `docs/` are that site. Contributing, the security policy and this changelog stay in the repository.
- **Circle is open source under the MIT License.** The release package carries `LICENSE` next to `README.md`.
- **`/login` asks for the URL straight away.** Circle signs in only with an API URL and key, so the first list, where OAuth sign-in was marked `not available yet`, is gone. `esc` on the key goes back to the URL, and `esc` on the URL leaves. `/login anthropic` and `/login openai` open the same questions as `/login`.
- **`settings.json` no longer has `auth.mode` or `auth.oauth_provider`.** Circle drops them the next time it saves the settings; the Python releases read a missing `mode` as `api_key`.

### Fixed

- **A request that timed out ended the turn without a single retry.** The SDKs' errors are all named `Error`, so their timeout errors were never recognised as such.
- **A long tool call on the Anthropic protocol is no longer cut as stalled** after 3 minutes while its arguments are still streaming.
- **Option+↑ takes back waiting messages in terminals that send option as esc** (Terminal.app's "Use Option as Meta key", iTerm2's Esc+). It used to arrive as `esc` and then `↑`, which stopped the turn.
- **The model chosen in `/login` is used** even when Circle was started with `-m` or the project's settings name a model.
- **Settings marked as set up but without a URL** (an older OAuth sign-in) open setup in the full-screen interface, as they already did in print mode.

## 1.0.4 - 2026-10-09

### Changed

- **`circle update` shows how far the download has got**, on one line that redraws itself: `downloading circle-1.1.0-darwin-arm64.tar.gz  45%  23.6/52.4 MB  9.6 MB/s`. It downloads the release itself and hands the file to the installer, so this works the same on Windows. `ctrl+c` stops it and leaves nothing behind, and a download that gets no data for a minute stops by itself. The update from 1.0.3 or older to this version still downloads without it, because the version you have does the download.
- **The installer says each step**: verifying the download, unpacking, checking the release, copying it, and which old versions it removed. On a terminal, `install.sh` shows curl's progress bar for its own download.

## 1.0.3 - 2026-10-09

### Changed

- **Subagent rows in the strip have no background until you select one or point at it.** The row under the mouse lights up, as in 0.5.0, and so do the buttons on a record's band. The selected row used to sit on a colour almost the same as the others'.
- **A record keeps its keys while a card waits under it.** `esc` leaves the record instead of rejecting the card, `←` `→` move between subagents instead of moving the card's choice, and any other key only leaves the record, so nothing pressed on the page answers the card.
- **A record opened with the mouse goes back to the conversation**, and `main` on its band always does; one opened with `enter` from the strip goes back to the strip.
- **A subagent's card says which subagent asks**: `general-purpose·1a2b3c4d · Bash needs your permission`.
- **The plan box has no background**, and its whole frame is the input box's resting colour. The top edge after the plan's lamp used to turn white.
- **A background subagent's job row shows its tokens and its step as a tool row would**, `Write(notes/a.md)`, instead of the call's raw arguments.
- **Token counts past a million read as `M`**, `7.8M` instead of `7824.0k`.
- **The mouse wheel over the subagent strip scrolls it** when more subagents run than it shows.

### Fixed

- **The mouse wheel stops at the first and last row** of the conversation and of a record. Scrolling past the top used to pile up, so the next scrolls down did nothing.
- **A subagent that ended no longer stays in the strip** because it was once selected, with an empty header above it.
- **Notices stay where they came.** `New session …`, `Signed out` and the like used to sit under everything that came after them.
- **The row of your own `!` command keeps its tint after its lamp.**

## 1.0.2 - 2026-10-09

### Changed

- **Circle keeps up while a turn runs, and long sessions stay quick.** A repaint no longer reads the whole conversation back from the session database or draws every earlier message again, and streamed text is drawn at most every 16 ms instead of once per token. Typing, the wheel and `ctrl+o` answer while the model writes.
- **`/logout` works while a turn runs, and so do `/skill` and `/extensions` when they only list.** `/skill <name>` and `/extensions reload` still wait for the turn to end.
- **The model's answers are marked `●` instead of `⏺`.** Windows draws `⏺` as a blue emoji button. The lamps use the same `●` and are told apart by colour.
- **The terminal's cursor sits where you type**, as in 0.5.0, so input methods open their candidates there.
- **Thinking has no background tint.** A thought, folded or open, and the same line on a subagent's page, sit on the terminal background. The line stays italic blue and the open text stays faint, on a dark theme and on a light one. The plan and questions keep the magenta tint.

### Fixed

- **Circle run in the folder that holds its data folder no longer reads the global `settings.json` as a project's.** `CIRCLE_HOME` was not known where the project's `.circle/settings.json` was looked for, so with `CIRCLE_HOME=~/.circle` and `~` as the folder, the global file was read as a project's and every key only it owns (`version`, `initialized`, `auth`, `trusted_folders`, `mcp_servers`, `extensions`, `update_check`, `models`) was named in red at start and on standard error in print mode. The keys the two files share were also applied as if the project had set them.
- **The input box keeps its right edge on Windows Terminal.** Each changed row was written and then erased to the end of the line, and on Windows Terminal that erase also took the last column.
- **The input method's candidate window opens at the cursor on Windows** instead of at the far right of the screen.
- **The plan stays on screen while the card asks whether to implement it.** It was hidden while the card was up.
- **`✖ Interrupted` leaves when the next turn starts.** Stopping a turn still marks it, and the mark stays while Circle is idle. It no longer sits at the bottom of the transcript after a new turn has begun.

## 1.0.1 - 2026-10-09

### Changed

- **The welcome logo is three rows tall and finer**: the ring of `docs/images/logo.svg` drawn with sextant blocks (two by three sub-cells a cell) instead of six rows of quadrants, with the version, the model and the folder beside it.

## 1.0.0 - 2026-10-09

Circle 1.0 is a rewrite in TypeScript. It works as 0.5.0 did: the same screen, keys, commands, settings and data folder. What changes is underneath and in how it is installed.

### Changed

- **Circle runs on Node.js instead of Python.** The agent loop is Circle's own; LangChain, LangGraph and deepagents are gone. A release package carries its own Node.js, so nothing has to be installed first.
- **Upgrading from 0.5.0 or older takes the one-command installer once.** It removes the Python version, whether the old installer or pip put it there, installs 1.0 in the same place, and keeps the data folder. If a Python circle is still running it stops without changing anything. The old `circle update` cannot make this step: it reports that the release has no file for your platform. See [Installation and updates](docs/installation.md#replacing-the-python-circle).
- **Saved sessions move to `circle.sqlite`.** On the first start Circle imports the conversations in `sessions.sqlite` and `checkpoints.sqlite` without changing those files, and keeps a copy of what it read in `migration-backups/`.
- **Extensions are JavaScript or TypeScript** (`extension.mjs`, `extension.js` or `extension.ts`); `extension.py` no longer loads. The API is the same in camelCase. See [Extensions](docs/extensions.md).
- **Release files carry the version in their name**, `circle-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows), and there are builds for Windows on ARM64.
- **`SSL_CERT_FILE` and `SSL_CERT_DIR` add to the certificate authorities Circle trusts** instead of replacing them, and `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` apply to all of Circle's requests.
- **Only `task` calls run at the same time.** 0.5.0 asked every approval of a reply first and then ran all its calls together; now the other calls run one after another, each asking when its turn comes.

### Added

- **`CIRCLE_CONTEXT_WINDOW`** sets the context window when neither models.dev nor `models` in `settings.json` knows the model.
- **`@file` can name an image or a PDF**: it reaches the model as an attachment, as `read_file` results already did.

## 0.5.0 - 2026-10-08

### Added

- **Background jobs.** A command or a subagent can keep running while you and the model go on. The model starts one with `background: true` on `execute` or `task`; a command still running at the default timeout goes on as a job instead of being ended; `ctrl+b` moves the command being waited on (yours too) to the background; and processes a command leaves running (`server &`) become a job. Each job's output is kept in a file the model reads, rows below the input box show what runs, and `/jobs` opens or stops them. When a job ends the model gets a notice, and Circle starts a turn for it when nothing else runs, so the model no longer polls or sleeps. Leaving Circle, closing the terminal or a `SIGTERM` stops every job. See [Background jobs](docs/background-jobs.md).
- **Background subagents ask in their own cards.** Their approvals and questions appear whether a turn runs or not, named after their job, after the running turn's own cards.
- **The model has `list_jobs` and `stop_job`**, and the `general-purpose` subagent `wait_jobs`.
- **Extensions can wait for something slow** by returning `api.Watch` from a tool: Circle polls it off the model's turns and hands the result over as a notice. See [Build extensions](docs/extensions.md#waiting-for-something-slow).
- **Print mode waits for the model's background jobs** after its answer, up to `CIRCLE_JOB_WAIT` seconds; JSON and RPC modes report jobs as events, and RPC mode has `list_jobs` and `stop_job`.
- **Compaction shows itself while it runs.** A row above the input box follows the automatic compaction and `/compact` step by step with a progress bar, and one line stays when it is done: how many tokens before and after, how many messages were summarized and kept, and where the older messages were saved. A failed compaction leaves a red line. See [Compaction](docs/sessions.md#compaction).
- **`models` in `settings.json` sets a model's context window**, and `CIRCLE_MODEL_CTX` sets every model's.

### Changed

- **Context windows and prices come from [models.dev](https://models.dev).** A snapshot ships with Circle and a newer copy is fetched once a day in the background (`CIRCLE_NO_MODELS_REFRESH` turns that off). Circle takes the entry of the provider your `base_url` points at, and for a gateway or a proxy the model's own vendor's. The footer's cost is in US dollars at pay-as-you-go prices, a subscription's being its vendor's for reference; a window or a price Circle does not know reads `N/A`. The footer and the automatic compaction use the same window. See [Models](docs/models.md#cost-and-context-in-the-footer).
- **A command's standard output and standard error come back together**, in the order they were written, instead of standard error after standard output with a `[stderr]` prefix.
- **A command that runs past the default timeout is no longer ended**: it goes on as a background job. One the model gave its own `timeout` is still ended then.
- **The Gemini prompt no longer tells the model to start servers with `&`.**
- **On Windows, `esc` ends a running command** with everything it started (`taskkill /T`), and `ctrl+b` and the default timeout move it to the background, as elsewhere. This has not been tried on a real Windows machine yet.

## 0.4.0 - 2026-10-08

### Added

- **A welcome block opens every session.** At the top of the conversation: Circle's logo, the version, the model and its endpoint, the folder and its git branch, what the folder brings (its instruction files, skills, commands, extensions and settings) with a lamp each, and the folder's three most recent sessions. It is not saved or exported. Once it scrolls away, the header shows the version, model and folder again. See [The welcome](docs/interface.md#the-welcome).

### Changed

- **Setup and trust are asked on the session's own screen.** Each question is a card in the input box under the welcome, and the session starts in place after the last answer, instead of on a separate screen first. The trust card says what trusting loads from the folder, and warns when the folder has extensions, which run their own code.
- **The screen comes up before Circle has loaded.** While extensions, commands and MCP servers load, the folder's rows in the welcome blink. What you send meanwhile waits and is sent once Circle is ready.
- **Setup's model list is searched by typing**, like the other lists. A model the endpoint does not list can be typed and chosen as `use "<id>"`. In the full-screen setup, numbers no longer pick a model.
- **OAuth sign-in cannot be chosen in setup** while it is not built, as in `/login`.

### Fixed

- **Setup froze while it asked the endpoint for its models.** It now asks in the background and says so on the card.

## 0.3.1 - 2026-10-08

### Changed

- **`/login` asks how to sign in.** Without a word it lists the ways in. **API URL + KEY** asks for the base URL, the key (shown as dots; pasting works) and the model, as setup does, and switches the session to them without a restart; nothing is saved before a model is picked. OAuth is listed as `not available yet`. The endpoint row of `/settings` opens it. See [Change the endpoint or the key](docs/models.md#change-the-endpoint-or-the-key).
- **A turn the endpoint refuses because of the key** (HTTP 401 or 403, such as a wrong key or an account without a plan) ends in `· /login to change the key`.
- **Secondary text reads on every surface it is drawn on.** Dim and faint text keep their contrast on the lists' panel and inside tool, thinking and subagent blocks, not only on the background. On a light terminal they are a little darker; on a dark one faint text is a little brighter.

### Fixed

- **Open lists kept their old colours** when the terminal switched between dark and light under the `auto` theme. They are drawn again at once.
- **Pasting while a list was open put the text in the input box behind it.** It goes into the list's search, or into the line the list asks for.
- `circle --help` said `--init` resets `settings.json`. It replaces the endpoint, key and model and keeps the rest.
- **A secret entered just as its request timed out could still be taken** when the disk was slow, as on some Windows machines. It is now shredded with the request, as a late answer always was.

## 0.3.0 - 2026-10-06

### Added

- **Print, JSON and RPC modes.** `circle -p "prompt"` runs a turn and prints the answer, with piped input put before the prompt. `--mode json` writes every step as one JSON object per line, and `--mode rpc` runs Circle as a child process driven by JSON commands, following pi's RPC mode. Calls that would ask for approval are not run unless you pass `--yolo`. See [Print mode](docs/cli.md#print-mode).
- **Sessions that reopen.** `circle -c` goes on with the most recent conversation in the folder; `circle -r` and `/resume` pick one from a list, where you can also rename, delete and see every folder's sessions. `--session`, `--session-id`, `--fork`, `--no-session` and `--name` choose or start one. Leaving prints the command that reopens the session, and a reopened session is drawn again from its saved messages. See [Sessions](docs/sessions.md).
- **Going back and branching.** `/tree`, or `esc` twice on an empty input box, lists every message of the session and all its branches, with labels. Choosing one goes back there, and your next message starts a branch while the old one stays. `/fork` starts a new session from one of your messages and `/clone` copies the session. `/export` writes Markdown, HTML or JSONL; `/import` reads a JSONL export back.
- **Steering.** A message sent while a turn runs is read by the model after its current step. `ctrl+q` queues a follow-up for after the turn instead, and `alt+↑` takes waiting messages back. Waiting messages are listed above the input box.
- **Models and thinking depth.** `/models` (`ctrl+l`) lists what the endpoint offers: `enter` uses a model for the session, `ctrl+s` also saves it, and `tab` adds it to the models `ctrl+p` switches between (`enabled_models`). `/effort`, `shift+tab`, `--thinking` and `default_thinking` set the thinking depth.
- **Command-line options from pi:** messages and `@file`s after the folder, `-m`, `--thinking`, `--models`, `--list-models`, `--export`, `--system-prompt` and `--append-system-prompt` (and the `SYSTEM.md` and `APPEND_SYSTEM.md` files), `--no-context-files`, `--tools`, `--exclude-tools` and `--no-tools`.
- **Input.** A completion list for `/commands` and `@files` as you type. An input box that grows to several rows. `!command` runs a shell command yourself. `ctrl+f` finds text in the conversation, `ctrl+x` copies the last answer, `ctrl+g` edits the draft in your editor and `ctrl+z` suspends Circle. Your own keys go in `keybindings.json`.
- **`/settings`** lists the settings and changes the marked one with `enter`. `/session` shows the session's id, folder, model, counts and tokens. A project can set a few things in `.circle/settings.json`. Custom commands accept pi's prompt templates (`$1`, `$@`, `${2:-default}`, `${@:2}` …) and are read from pi's folders too.
- **Approval for a kind of command.** For a command that is one program with its arguments, the approval card also offers `Allow "python3 -m pytest …" for this session`, which covers every command that starts with those words. See [Security](docs/security.md#approvals).
- **The approval card shows the diff of a file change**: the lines added and removed, against the file as it is now.
- The header shows the git branch and the thinking depth, the terminal title names the folder and the session, and the context meter turns yellow and then red as the context fills.

### Changed

- **Setup, the trust screen and the installer are in English**, like the rest of the interface.
- **`circle --init` keeps your settings.** It replaces only the endpoint, key and model, and `enter` on an empty line keeps the saved URL and then the saved key. Saving settings also keeps keys Circle does not know.
- **Circle writes nothing into your project.** Trusting a folder no longer creates `.agent/`. The messages a summary replaced, and very long tool results, are kept in the data folder under `projects/` instead of `conversation_history/` and `large_tool_results/` in the workspace.
- **A `cd` into the workspace in front of a command** (`cd /your/project && make test`) no longer stops a "for this session" rule from matching, and the system prompt asks the model not to add it. The system prompt also asks the model to run the project's test runner and not to say tests pass without its output.
- **Commands the model runs no longer use Circle's own virtual environment** when you started Circle from a shell where it was active, so `python3` and `pip` are your project's.
- **`install.sh` starts the new version once before switching to it.** A build that does not start leaves the previous install in place, and the slow first start of a newly downloaded program happens during the install instead of on your first `circle`. `install.ps1` and `circle update` do not do this yet.
- `/tree` and `/fork` show messages without Markdown marks, and in every list a long row is cut so that the column on the right stays visible.

### Fixed

- **Setup could not list models in the prebuilt program on macOS.** Certificate checks failed, so setup showed `connection failed`, did not find the `/v1` path, and the first message got a 404. Model discovery, web fetch and web search now fall back to the CA certificates bundled with Circle, as `circle update` already did, and a certificate failure is named as one.
- **The API key was shown in clear text** while you typed it during setup. It is shown as dots.
- **Endpoints that repeat the running usage total on every streamed chunk** (StepFun and other OpenAI-compatible gateways) were counted once per chunk. The footer showed millions of tokens and a summary started on almost every step. Each answer is now counted once.
- **A summary made during a turn could appear as the answer**, with its words run together, when the model's own reply was empty. The answer is now only the model's last message, and a summary's text never reaches the screen.
- `esc` now stops a running shell command at once, with everything it started. Not on Windows yet.
- `esc` on a setup screen leaves setup, as `ctrl+c` does. A lone `esc` used to be held, waiting for the rest of an escape sequence.
- A long paste reaches the model as the pasted text, not as its placeholder.
- `/fork` and `/clone` give the model the earlier messages, `/tree` goes back for the model as well as on screen, and sessions are listed again after a restart.
- `$10` and beyond work in custom commands, and `/editor` works when `$EDITOR` has arguments.
- On a case-insensitive file system, `AGENTS.md` is put in the prompt once.
- The `grep` tool's description says it searches for literal text.
- `/mcp` and `/extensions` print English.
- `circle --help` describes Circle, tool output such as `ls` is shown as a list instead of raw JSON, and the token meters are hidden on the setup screens.

## 0.2.1 - 2026-10-01

### Fixed

- The first command after initialization or workspace trust now reaches the main interface. The previous screen finishes its input reader before the session takes over the terminal.
- Ctrl+C cancels initialization, and cancellation restores the terminal and stops its input reader.

## 0.2.0 - 2026-10-01

### Added

- **`circle update`.** Installs the newest release: it downloads the file for your system, checks its sha256, unpacks it beside the running version and moves the `current` link. `--check` only reports, `--version X.Y.Z` installs a given release or goes back. See [Updating](docs/cli.md#updating).
- **Update reminder.** Once a day, when the full-screen interface starts, Circle checks GitHub for a newer release and says so in one line. Turn it off with `update_check` in settings or `CIRCLE_NO_UPDATE_CHECK=1`.
- **Windows.** The interface runs in the Windows console (Windows 10 1809 or newer), with an `install.ps1` installer and a Windows build in the release workflow. Interactive console behaviour still needs real-machine testing; see [Known issues](docs/known-issues.md#install-and-release). The approval rules understand `del`, `Remove-Item`, `cmd /c`, `powershell -Command` and `C:\path\.env`, and the system prompt tells the model its commands run in `cmd.exe`.
- **Releases for macOS (Apple silicon and Intel), Linux (x86_64 and arm64) and Windows (x86_64)**, built by a workflow that runs the tests, freezes the program, starts a session in it, and publishes only if every platform passed. `python scripts/release.py X.Y.Z` prepares a release. See [Releasing](docs/development/releasing.md).
- **Interface contract.** One set of rules decides where each piece of information appears: conversation, persistent lines, plan box, the input box that turns into a card, popup, page, or a one-second flash. Lamps show state, tints show the kind of work, and the frame shows whose turn it is. See [The interface](docs/interface.md).
- **Dark and light terminals.** Secondary text and the rainbow frame keep a readable contrast on any background. The `auto` theme follows the terminal while Circle runs, so a switch between a dark and a light theme is picked up without a restart. `/themes auto|dark|light` chooses. See [Dark and light terminals](docs/interface.md#dark-and-light-terminals).
- **Skills.** Agent Skills discovery, the `skill` tool and `/skill`.
- **MCP servers**, plan-mode write gates, more tools and a session tree.
- **Extensions.** Python modules that register tools, commands, middleware, subagents, result renderers and event handlers.
- **Approvals.** Commands are sorted into allow, ask and refuse. "Always allow" is remembered per session and managed with `/approvals`.
- **Auto mode.** `/yolo` (`/auto`) stops asking for the current session.
- **Model guard.** Retries with backoff and `Retry-After`, dropping a parameter the endpoint rejects, detection of stalled or repeating streams, and thinking depth chosen by model family.
- **Reliability middleware.** Tool errors return to the model instead of ending the turn, wrong-case tool names and argument shapes are repaired, loops are interrupted, and old tool output is shortened in requests.
- **Secrets.** The model can ask for a secret with `question`. You enter it masked with `ctrl+s`, and it is written to a file without entering the conversation.
- **Plan box, subagent strip and record, live footer meters, file diffs**, and rendering of GFM tables and task lists.
- `websearch`, and `~` expansion in file paths.
- New documentation in `docs/`, `CONTRIBUTING.md`, `AGENTS.md` and `SECURITY.md`.

### Changed

- **The installer** decides the operating system before it touches the network, finds the newest release without the GitHub API (so no rate limit), checks the sha256 of what it downloaded, and explains a certificate failure, a missing file for your platform and an unreachable network instead of printing curl's error. In a Windows shell (Git Bash, MobaXterm, Cygwin) it installs the Windows program through PowerShell. It keeps the newest versions in `versions/<version>` with a `current` link, so installing or updating never removes the copy that is running (a version that is already installed is left alone). The one exception is moving a `v0.1.0` install to this layout, which has to replace its `current` folder: run the installer once with Circle closed.
- Commands the model runs now inherit your environment with secret-looking variables removed, instead of an empty one.
- Models outside the built-in catalogue get a full output budget, and a reply that used the whole budget for thinking says so.
- Cancelling a turn is checked at every model and tool boundary, and a cancelled turn drains its queue in order.

### Fixed

- Model discovery uses only valid IDs returned by the server, reports empty or failed responses, and supports explicit manual configuration. API paths no longer omit or duplicate `/v1`, and the original host is preserved.
- Timer snapshots and UI actions share a lock, preventing a cancelled turn from deadlocking the next queued message.
- Checkpoints finish writing between agent steps, preventing stalled multi-step turns.
- Windows redirected output remains Unicode-safe in the prebuilt program.
- Windows host drive paths and expanded home paths work with filesystem tools while traversal checks remain enforced. Non-console output uses default terminal dimensions.
- Frozen builds include both provider integrations and package metadata. Native archives are installed and started offline before publication; all five archives must match the release commit and pass checksum verification.

- The release workflow could not succeed: it ran `pytest` without installing it, so no release was ever built by CI and the only release was uploaded by hand. It now installs the test extras and runs on a tag, and can be run by hand to rehearse a release.
- The prebuilt program did not include the prompt files the agent reads at start. The PyInstaller recipe now bundles them, and every module under `circle/`.
- `install.sh` ended with `tmp: unbound variable`: its cleanup ran after the function that owned the variable had returned.
- `/yolo` no longer drops an approval that arrives on the worker thread, and applies only to turns you can see.
- Approval policy is frozen for the length of a paused turn.
- Rebuilds of the MCP connection are refused while a turn is running.
- A stale context meter is cleared after a new session or a compaction.
- Reasoning text keeps its code fences when it is truncated, and expanded reasoning is cached per width and palette.
- Markdown emphasis boundaries and table delimiters render correctly.

## 0.1.0 - 2026-09-22

First release. A prebuilt binary for macOS on Apple silicon, an installer, a full-screen session built on a renderer modelled on Ink, and slash commands aligned with Pi and OpenCode.

---
nav_order: 6.5
---

# The desktop application

The desktop application is a window around the same Circle: the same model connection, tools, approvals, sessions and modes as the terminal. [Installation](installation.md#the-desktop-application) says how to get it. This page says what its window shows and how to use it.

## First start

The first time, Circle opens the connection form by itself: the API URL, the key and the model id your endpoint uses. Later, open it from the connection at the bottom of the sidebar (`connect a model` until one is set), from the top bar's ⋯ menu or from settings. To change only the URL or the model, leave the key empty: the saved key is kept.

## The window

The layout follows Claude's:

- **The sidebar**: search, a new session, customize (skills, commands, MCP servers, extensions, tools and approvals) and all sessions; then your folders, each with its sessions and a + for a new one; open folder; and at the bottom the connection and settings.
- **The top bar**: the session's title, whose menu has rename, details, find, the session tree, fork, clone, compact, export and share; the folder and its git branch; and on the right the side panels — terminal, files, changes, activity, browser and context — and ⋯ for search, theme, connection and help. A click opens a panel on the right, a second click closes it.
- **The conversation**: your messages on the right, Circle's answers as plain text. The tool calls between two answers fold into one line, such as `ran 2 commands, edited calc.py +1 −1`; a click opens them, each with its output and, for a file change, its diff. Thinking folds to one line too. The time, the usage and a copy button show under a message when the pointer is on it.

The app starts in a folder of its own, `workspace` inside its data folder, which it trusts. Open your own project with file → open folder, and trust it before Circle reads it or runs anything in it.

## Asking and answering

When Circle wants to change a file or run a command, the request appears in the conversation, right under the call it is for: the command, or the change as a diff with line numbers. Answer it there:

| Answer | What it does |
|---|---|
| allow once | Runs this call. |
| allow for this session | Runs this call, and in this session does not ask again for the same thing: the same command, or file changes inside the workspace. |
| allow “…” commands | For a command: allows commands starting with the same words, in this session. |
| reject | Does not run it; the model is told. |
| reject and explain | Does not run it, and tells the model what to do instead. |

A question from the model appears the same way, with its choices and a box for your own answer. While a request waits, the frame around the input box is orange and still, and the bar above the box says how many wait; click it to scroll to the first.

## Modes

The button under the input box, on the left, shows how this session asks. Click it to choose, or press `shift+tab` in the input box to move to the next one.

| Mode | What it does |
|---|---|
| manual | Asks before each file change and command. The default. |
| accept edits | Changes files inside the workspace without asking. Commands, deletes and changes outside the workspace still ask. |
| plan | Read-only: Circle researches and writes a plan to `plan.md`, and changes nothing else. When it is done it asks whether to implement the plan, and whether to accept edits while it does. |
| auto | Runs every call without asking, including the ones Circle always asks about. Read [Security](security.md#auto-mode) first. |

The mode belongs to the session, as in the terminal; see [Modes](usage.md#modes).

## While Circle works

The frame around the input box turns through the rainbow while the model works, with a label on its top edge: the word for this turn, the time, and the tokens written so far, as in the terminal. Time spent waiting for you is not counted. When a model request is tried again the label says why and which try. With reduced motion turned on in the system settings the frame stays still.

A finished file change shows its diff when its line is opened. The changes panel lists every file this session changed while the app was open, each against its version before the first change. The files panel lists the open folder when it is trusted.

## The browser panel

Each conversation has its own sandboxed browser, which you and Circle use together: what one does, the other sees. Open the browser panel from the top bar and enter an HTTP or HTTPS address, or ask Circle to use it. The panel has tabs, back, forward and reload. The model's [browser tools](tools.md#the-desktop-browser) open pages, read them, click, type, choose options, press keys, take screenshots, answer a page's dialogs and manage tabs. They can reach local devices and private addresses as well as public sites. They are available to the main agent only.

Before Circle acts on a page, an approval card shows the URL, element or text involved. **Allow for this session** covers all browser actions in that conversation; reading the page and taking a screenshot do not ask. In plan mode those two reads work, and the other browser tools are refused. When Circle starts using the browser the panel opens, unless you are on another page of the application, and shows **Circle is operating** at the bottom. In the page, a pointer moves to what Circle clicks, with a ripple, and a field it types into is outlined, with a label saying what it does. The pointer fades after a few seconds and stays out of snapshots and screenshots.

A page's alert, confirm, prompt or "leave site?" question appears over its tab, on a picture of the page as it stopped, with the site it came from; a tab waiting on one is marked. While Circle is working it appears in the conversation too. You can answer it in either place, or Circle can; the first answer counts, and Circle is told who gave it. No dialog appears over the whole window.

A site whose certificate is not trusted, such as a device with a self-signed certificate, gets the browser's privacy warning in its tab, as in Chrome: **Your connection is not private**, the error code, **Advanced** and **Back to safety**. **Advanced** shows the certificate (who it is issued to and by, its validity and its SHA-256 fingerprint) and **Proceed to … (unsafe)**. You can click it yourself. Circle sees the same page and can click it too, but then asks you first in the conversation; for a host on this network you can also trust that certificate there for good. The address bar says **certificate error** while the warning shows and **not secure** after you proceed. See [Built-in tools](tools.md#dialogs-warnings-and-tabs) for how long each choice lasts. A link or script that opens a new window opens a new tab. Other loading failures show **cannot reach this site** in the panel.

Password values never appear in snapshots; a password field shows only whether it is filled. The model cannot type plain text into one: it writes `%NAME%` for a secret you saved, and never sees the value; with none saved it asks you for one. You can still type it yourself in the panel. See [Secrets by name](security.md#secrets-by-name). Pages can still send whatever you or Circle enter to their server: read the approval card and the address before allowing an action. Contents of frames from another site cannot be read.

The warning page and the pointer follow the application's theme.

## Under the input box

As in Claude: on the left, + to attach files and the mode; on the right, the model and the thinking depth, each a menu, and a ring for the context. The ring fills as the context of the last answer fills the model's window, orange from 70% and red from 90%. Click it for the terminal footer's numbers — tokens sent and received over the whole session, the estimated cost from the model's published prices, the share read from the cache — and to compact the conversation or open the session's details. While jobs run, the ring carries their count. Unknown values read `N/A`.

## Outside the window

While the window is in the background, Circle sends a system notification when a request needs you and when a turn ends or fails. On macOS the Dock icon counts the requests that wait. On Windows and Linux the taskbar shows a busy bar while Circle works.

## Variables

Settings → variables lists names and values as Windows lists environment variables, with **new…**, **edit…** and **delete** under each table; double-click a row to edit it. The model writes `%NAME%` in any tool's arguments and Circle puts the value in when the tool runs. The first table holds plain variables, whose values the model is told; they are `variables` in `settings.json`. The second holds secrets, whose values the model never sees and the page never shows again: to change one, enter a new value, or leave the value empty to keep it when you only rename it. In the dialog, **secret** decides which: it is ticked by itself for a name with a part such as `PASSWORD`, `TOKEN` or `KEY`, and ticking it while you edit a plain variable moves that variable to the secrets in one step. See [Secrets by name](security.md#secrets-by-name).

## Language and text size

Settings → appearance:

- **language**: follow system, English or 简体中文. Following the system, any Chinese system language gives Chinese. Menus, system dialogs and notifications follow. Only the interface is translated: what the model writes, tool output, file names and commands stay as they are.
- **text size**: small, default, large or larger. Interface and code text change together.

The choice of language and text size is kept by the window, not in `settings.json`.

## Updates

Settings → about → check now asks GitHub for the newest release. When there is a newer one, update downloads this system's package into the data folder and checks it: its checksum, on macOS its signature, and that it holds that version. Restart to update then quits Circle; a small installer puts the new copy where the old one was and starts it, and settings say which version it was updated to. The sidebar offers a newer version as well, with how far the download is and the restart. Circle reaches GitHub through the system's proxy settings.

With check for updates on (as in the terminal, `update_check` in `settings.json`), the packaged application also looks once a day when it starts. On macOS the new bundle replaces the old one in place. On Windows, the copy the `.msi` installed is updated with the new `.msi`, which asks for administrator permission as installing did; the installer waits until Circle and its helper processes have ended and starts it again afterwards. On Linux, on Windows outside `C:\Program Files\Circle`, and wherever macOS runs Circle from a folder it may not write, check now links to the release page instead. `CIRCLE_DESKTOP_RELEASES` points the check at another copy of the releases page (https, or a local address for tests).

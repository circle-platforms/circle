Write what this conversation did in its browser as a script file that `browser_replay` can run again, here or in another conversation. Use it when the user asks to record, save or repeat what you did in the browser; do not rebuild it from the site's HTTP requests or with another browser tool.

Usage:
- `path` is the file to write, by convention ending in `.circle-browser.json`. `name` names the script.
- Every navigation, click, typing, choice, key, dialog answer and new tab of this conversation becomes a step, in order; snapshots, screenshots, uploads and actions that failed or did nothing are left out. An element is kept by its role and name as the snapshot showed it, with `nth` when several have the same. Passing a certificate warning becomes `{ "proceed": "certificate" }`. `first` and `last` keep only those steps of the list.
- The result lists the steps. Then clean the file up: read it with `read_file` and, with `edit_file`, drop detours and repeated tries, add `{ "expect": "text" }` steps where the page should show something, and write values that change between runs as `%NAME%`.

The file:
```json
{
  "circle": "browser-script/1",
  "name": "Sign in",
  "steps": [
    { "navigate": "https://%DEVICE_HOST%/login" },
    { "proceed": "certificate" },
    { "type": { "role": "textbox", "name": "User" }, "text": "%DEVICE_USER%" },
    { "type": { "role": "password", "name": "Password" }, "text": "%DEVICE_PASSWORD%", "submit": true },
    { "click": { "role": "button", "name": "Delete", "nth": 2 }, "note": "the second row" },
    { "expect": "Saved" }
  ]
}
```
The other steps are `{ "select": element, "values": ["TCP"] }`, `{ "press": "Enter" }`, `{ "dialog": "accept" }` or `"dismiss"` (with `text`, or `password` as a secret's `%NAME%`), `{ "tabs": "new", "url": … }`, `{ "tabs": "close" }`, `{ "absent": "Error" }` and `{ "wait": 2 }` (seconds). Any step may have a `note` and a `timeout` in seconds (10 unless given).

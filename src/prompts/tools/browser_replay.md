Run a browser script file (`"circle": "browser-script/1"`, as `browser_record` writes it) in this conversation's browser, step by step, without stopping for you in between.

Usage:
- `path` is the script, as `read_file` takes it. `variables` gives values for its `%NAME%`, before Circle's variables and secrets; a name nothing sets stops the replay before any step. Text made only of secrets' names is typed as a secret.
- Each step waits up to its `timeout` (10 seconds) for its element or text, by role and name as a snapshot shows them, and tries again while the element is covered or the page is changing. `{ "proceed": "certificate" }` passes a certificate warning, which the user approves.
- The user allows a replay for the site it starts on, and it acts only there: a step that goes to another site stops it, and calling again with `from` at that step asks about the new site.
- The first step that cannot be done stops the replay. The error gives its number, the step, why, and the page as it is. Fix that step in the file with `edit_file` (another role or name, an `nth`, a longer `timeout`, a step before it), then call again with `from` set to that step.
- When it ends, the result lists what each step did, what happened meanwhile and the page it ended on. Take a snapshot to see the page in full.

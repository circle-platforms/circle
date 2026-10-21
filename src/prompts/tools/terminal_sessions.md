List this conversation's device terminals and the user's saved connection profiles.

Usage:

- Call it before your first connect, and whenever a session name is unclear: it gives each terminal's id (`t1`), its device and state, and the profile names `terminal_connect` takes.
- When the user asks you to use their terminal tab, their shell tab, or "my terminal", this list is where that tab is. Type there with `terminal_send` and wait with `terminal_wait`. Do not also call `execute`: that runs in Circle's own shell, not in their tab. Reading or listing a tab asks nothing.
- An exited desktop tab stays in this list. `terminal_send` to it restarts that shell and then types. Do not ask for a new terminal. Do not use `execute`.
- A terminal the user holds is listed as held; your actions wait until they give it back.

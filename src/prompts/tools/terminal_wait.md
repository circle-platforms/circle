Wait for a device terminal to rest, or for the screen to show what you expect.

Usage:

- With no `pattern`, it answers once the screen has been quiet for `idle_ms` (600 by default): the device is back at its prompt.
- With a `pattern`, a regular expression, it answers as soon as the screen shows it: use it for `Press any key`, a `login:` you have not seen, or a device that takes its time.
- `timeout_ms` bounds the wait, 30000 by default, up to 300000; a timeout is an answer, not an error, and the result says which it was.
- `absent` is a negative assertion: a regular expression that must NOT appear. The wait ends at once, reporting a failed check and the line it hit, so a test learns about `% Invalid input` or a traceback the moment the device prints it.
- `retries` waits again after a timeout, up to 5 times: a device that answers slowly on a busy runner passes on a later attempt, and the result says how many attempts it took.
- `changed` adds a `### During the wait` section with exactly the lines the screen gained while the wait ran: the diff a test asserts on, without the scrollback from before.
- A matched or absent pattern names the screen line it hit, so a result carries its own evidence.
- Reading is free: it asks nothing and works in plan mode. Prefer it over sleeping between sends.

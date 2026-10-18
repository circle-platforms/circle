Wait for a device terminal to rest, or for the screen to show what you expect.

Usage:
- With no `pattern`, it answers once the screen has been quiet for `idle_ms` (600 by default): the device is back at its prompt.
- With a `pattern`, a regular expression, it answers as soon as the screen shows it: use it for `Press any key`, a `login:` you have not seen, or a device that takes its time.
- `timeout_ms` bounds the wait, 30000 by default, up to 300000; a timeout is an answer, not an error, and the result says which it was.
- Reading is free: it asks nothing and works in plan mode. Prefer it over sleeping between sends.

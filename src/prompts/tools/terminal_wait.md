Wait for a device terminal to rest, or for the screen to show what you expect.

Usage:
- With no `pattern`, it answers once the screen has been quiet for `idle_ms` (600 by default): the device is back at its prompt.
- With a `pattern`, a regular expression, it answers as soon as the screen shows it: use it for `Press any key`, a `login:` you have not seen, or a device that takes its time. The result names the newest screen line it matches.
- `timeout_ms` bounds the wait, 30000 by default, up to 300000; a timeout is an answer, not an error, and the result says which it was.
- `retries` waits again after a timeout, up to 5 more times, for a device that answers late; the result says how many attempts it took.
- `absent` is a regular expression the device must not print: a check that fails. It reads only what the device prints after this wait begins, so an earlier step's `% Invalid input` does not fail it. The wait ends as soon as the device prints it, even in the same output as the line `pattern` waits for, and the result names the line.
- `changed` adds `### During the wait`: the lines the device printed while the wait ran, as they stand on a screen that was empty when it began, the last 200 when there are more. What came before, such as the answer terminal_send already showed, is not in it; assert on it rather than on `### Output`, which also holds the screen from before.
- Reading is free: it asks nothing and works in plan mode. Prefer it over sleeping between sends.

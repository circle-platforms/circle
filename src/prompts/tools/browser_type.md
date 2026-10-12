Type text into a field in this conversation's browser. The user sees the field marked and the text typed.

Usage:
- `ref` is the field's ref from the latest snapshot; `element` says in a few words what it is.
- What the field held is replaced. Set `submit` to press Enter afterwards.
- For a password or other secret, write `%NAME%` with the name of a secret the user saved (your instructions list them): Circle puts the value in, and you never see it. A password field takes only text made of secrets' names. With no saved secret, ask for one with the `question` tool (`secret: true`, a `key`, no `target_file`), then use `%KEY%`.
- The result is the page's new snapshot.

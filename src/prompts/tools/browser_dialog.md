Answer a dialog the page opened in this conversation's browser (alert, confirm, prompt, or a sign-in the site or a proxy asks for). While one is open the page waits, and the snapshot says what it asks.

Usage:
- `accept` true presses OK, false presses Cancel. For a prompt, `text` is the answer.
- For a sign-in, `text` is the user name and `password` the password, written `%NAME%` with the name of a secret the user saved (your instructions list them); Circle puts the value in, and you never see it. Plain text is refused as a password. With no saved secret, ask the user to sign in with `browser_handoff`, or to save one.
- The result is the page's new snapshot.

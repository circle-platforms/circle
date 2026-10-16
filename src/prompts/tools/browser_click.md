Click an element in this conversation's browser. The user sees a pointer move to it and click.

Usage:
- `ref` is the element's ref from the latest snapshot; `element` says in a few words what it is, for the user ("the Log in button").
- The result is the page's new snapshot, after it settles. It names the element `ref` clicked as the snapshot shows it (`Clicked e28 link "Settings".`), and says when that is not what `element` described: then look at the snapshot again before you go on.
- When something covers the target, Circle waits up to 3 seconds for it to go (a loading mask, a message, an animation). If it stays, nothing is clicked and you are told what covers it; a dialog or drawer is said at once when the page is still.
- The result comes once the page has settled: its network quiet, and no change or animation still running, for at most 1.5 seconds more.

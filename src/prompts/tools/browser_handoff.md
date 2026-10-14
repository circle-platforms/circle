Hand the user this conversation's browser and wait until they are done.

Usage:
- Use it only for what the user must do themselves in the page: a CAPTCHA, a security key or a code sent to their phone, a password they have not saved as a secret, a choice that is theirs to make.
- Never for a certificate warning, a page's dialog or a permission request: click those yourself, and Circle asks the user where only they decide. Never because a ref was stale or an element covered: take a new browser_snapshot and try again.
- `reason` tells them what to do, in a sentence.
- While they have the browser you see nothing of it. Their turn ends when they continue or send you a message, or, in auto mode, by itself once they stop or the page moves on. The result says which, lists where the tabs went meanwhile and shows the page as it is now; it never shows what they typed.
- The user can also take the browser on their own; your next browser action then waits for them, does nothing, and shows the page as they left it.
- Plan mode does not hand the browser over.

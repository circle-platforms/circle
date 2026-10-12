Open a page in this conversation's browser, the one the user sees in the browser panel of the desktop application.

Usage:
- `url` is an http or https address, or `back`, `forward` or `reload`.
- The result is the page's snapshot: its text and the elements you can act on, each with a ref such as `e3`.
- When the page's certificate is not trusted, the browser shows the user a privacy warning, as other browsers do, and waits for them. Only the user can choose to go on; you are told what they chose.
- The page belongs to the user's session: what they opened or signed into there, you see, and the other way round.

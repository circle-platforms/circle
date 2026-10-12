Open a page in this conversation's browser, the one the user sees: the browser panel of the desktop application, or a Chrome or Edge window in the terminal.

Usage:
- `url` is an http or https address, or `back`, `forward` or `reload`.
- The result is the page's snapshot: its text and the elements you can act on, each with a ref such as `e3`.
- When the page's certificate is not trusted, the tab shows the browser's privacy warning instead, as other browsers do. When the user wants that site, open the warning's advanced part and click its link to proceed: the user is asked to approve it first, and the result says what they chose.
- The page belongs to the user's session: what they opened or signed into there, you see, and the other way round.

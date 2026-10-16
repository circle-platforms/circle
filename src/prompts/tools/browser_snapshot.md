Read the page open in this conversation's browser: its address, title, text, and the elements you can act on, each with a ref such as `e3`.

Usage:
- Take a snapshot before you act on a page you have not seen, or after the user did something in it.
- Refs are valid until the next snapshot; the tools that act return a new one.
- After an element, its state: `checked`, `unchecked` or `mixed` (also for switches and styled checkboxes), `pressed`, `selected`, `expanded` or `collapsed`, `disabled`, `required`, `invalid`. A control drawn with an icon only shows the icon's name as `icon=…`.
- `[covered]` marks an element under something on top of it (a dialog, drawer, mask or message): close or finish that first, or act in it.
- A long page is cut short (`… snapshot truncated`); dialogs, drawers and menus on top of it are kept, after the part of the page that fits.
- Pages in frames from other sites are not readable.

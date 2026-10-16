Read a file or directory from the local filesystem. If the path does not exist, an error is returned.

Usage:
- Give a workspace-relative path, or a real absolute path (`/home/…`, `~/…`, a Windows drive). A leading slash is a host path, not a path inside the workspace.
- Returns up to 2000 lines from the start. `offset` is the number of source lines to skip (0-indexed); displayed line numbers are 1-indexed. Call again with a larger offset to read later. A non-positive limit reads no lines.
- Use `grep` for specific content in a large file, and `glob` when the path is unknown.
- Each line is `<line>: <content>`. Directories list one entry per line, with `/` on subdirectories. A line longer than 2000 characters is truncated.
- Read several known files in parallel. Do not take tiny slices (30 lines) when a larger window fits.
- Image files and PDFs come back as attachments.

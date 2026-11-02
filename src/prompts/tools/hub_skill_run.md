Run one script under an installed pack's `tools/` directory with the current Node.

- `pack` is the installed pack id (the folder under the skills root); `script` is a path relative to the pack, for example `tools/fetch-run.ts`. Paths outside `tools/` are refused.
- `%HUB_URL%` (the Hub MCP endpoint base), `%HUB_TOKEN%` (the Hub token) and configured `%NAME%` variables expand in `args` and `stdin` at execution. Write the placeholders, never the values: the output writes every secret value back as its `%NAME%`.
- The process runs with the pack directory as its working directory, has a timeout and an output cap, and returns `exit_code`, `stdout`, `stderr` and `truncated`.
- This is a client preview: what the Hub recomputes is evidence, not this output. A failing script is reported with its exit code and stderr; fix the plan or the pack, do not retry blindly.

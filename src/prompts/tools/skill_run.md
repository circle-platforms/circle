Run one script under an installed pack's `tools/` directory with the current Node.

- `pack` is the installed pack id (the folder under the skills root); `script` is a path relative to the pack, for example `tools/fetch-run.ts`. Paths outside `tools/` are refused.
- `%NAME%` placeholders in `args` and `stdin` expand at execution from the variables configured in settings and the secrets saved with `/secrets`; the pack's instructions name the ones they need. Write the placeholders, never the values: the output writes every secret value back as its `%NAME%`. Configured variables are also in the script's environment; secrets are not.
- The process runs with the pack directory as its working directory, has a timeout and an output cap, and returns `exit_code`, `stdout`, `stderr` and `truncated`.
- This is a client preview: what the serving side recomputes is the evidence, not this output. A failing script is reported with its exit code and stderr; fix the input or the pack, do not retry blindly.

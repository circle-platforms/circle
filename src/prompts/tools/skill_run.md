Run one script under an installed pack's `tools/` directory with the current Node.

- `pack` is the installed pack id (the folder under the skills root); `script` is a path relative to the pack, for example `tools/fetch-run.ts`. Paths outside `tools/` are refused.
- `%NAME%` placeholders in `args` and `stdin` expand at execution from the variables configured in settings and the secrets saved with `/secrets`; the pack's instructions name the ones they need. Write the placeholders, never the values: the output writes every secret value back as its `%NAME%`. Configured variables are also in the script's environment; secrets are not.
- It runs in the workspace, as `execute` runs a command: the script finds its pack in `CIRCLE_SKILL_DIR` and a folder for data of its own in `CIRCLE_SKILL_DATA`. A run still going after 120 seconds continues as a background job; `timeout` (seconds, up to 600) ends it then, and `background: true` starts it as a job. The output comes back with the exit code.
- A script the pack declares in `tools.json` gets a typed tool of its own once its skill is loaded; use that tool, which checks the input first. `skill_run` refuses such a script then.
- This is a client preview: what the serving side recomputes is the evidence, not this output. A failing script is reported with its exit code and stderr; fix the input or the pack, do not retry blindly.

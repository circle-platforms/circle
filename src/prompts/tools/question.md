Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- Each question takes `question`, optional `header` (a short tag), `options` (strings, or objects with `label` and `description`), `multiple` and `custom`
- When `custom` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- The run pauses while the user answers in a panel. The result lists each question with its `answer`: an array of the chosen labels, plus the user's own text if they typed one; an empty array means they left it unanswered. Set `multiple: true` to allow selecting more than one
- If the user closes the panel, the result says so; don't guess the answer
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" to the end of the label
- Where no panel is available (line mode), the questions come back as text instead: ask them in your reply and wait for the user

Values to keep (paths, addresses, user names):
- When a task needs a value only the user knows and later steps will use it again, such as a
  folder path, a device address or a user name, ask for it at once with a `key` (ENV-style
  name, e.g. `BACKUP_DIR`) and no `secret`. The user's answer is kept as a Circle variable:
  afterwards write `%KEY%` in any tool's arguments. Check the variables already listed in
  your instructions before asking.

Secrets (passwords, tokens, credentials):
- When a task needs a password or token the user has not saved, ask for it at once this way
  rather than stopping or asking in chat.
- For any secret, add `secret: true` plus `key` (ENV-style name, e.g. `JUMPHOST_PASS`).
- Without `target_file`, the value is kept as a Circle secret: afterwards write `%KEY%` in any
  tool's arguments (a command, a browser field, an MCP tool's input) and Circle puts the value in
  when the tool runs. Check the secrets already listed in your instructions before asking.
- With `target_file` (the env file the value should land in, e.g. `~/.config/compile-excel/env`),
  the harness writes `KEY=value` there (file mode 600) instead.
- The user types the value in a masked input (Ctrl+S when prompted); the tool result only
  confirms collection — the value NEVER enters this conversation. Do not ask for secrets in
  plain questions.
- If secret collection reports unavailable/failed, tell the user to write the credential
  into the target file themselves; never fall back to collecting it in chat.

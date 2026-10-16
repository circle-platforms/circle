Ask the user when you need a choice or a value only they know. The run pauses until they answer. Do not guess if they close the panel.

Fields: `question`, optional `header`, `options` (`label` and `description`), `multiple`, `custom` (default adds "Type your own answer"; do not add "Other"). Put a recommended option first and end its label with "(Recommended)". The result's `answer` lists chosen labels. An empty array means unanswered. In line mode, ask in your reply and wait.

A value later steps reuse: `key` such as `BACKUP_DIR`, no `secret`. It is kept as a variable. Write `%KEY%` in later tool arguments.

A password or token: `secret: true` and `key`. Without `target_file` it is a Circle secret. With `target_file` Circle writes `KEY=value` there (mode 600). The user types it in a masked input. The value never enters this conversation. Do not ask for secrets in plain questions.

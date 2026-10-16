Performs exact string replacements in files.

Usage:
- Call `read_file` at least once before editing. The tool errors if the file was not read.
- Match the indentation after the line-number prefix (`1: `). Never include that prefix in `oldString` or `newString`.
- Prefer editing an existing file. Do not write a new file unless asked. Do not add emojis unless asked.
- It fails with "oldString not found in content" when the text is absent, and with "Found multiple matches for oldString. Provide more surrounding lines in oldString to identify the correct match." when it occurs more than once. Add surrounding lines, or set `replaceAll` to change every instance (a rename).

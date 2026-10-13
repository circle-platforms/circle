import { t } from '../i18n/index.ts';

// Derived from docs/tools.md at Circle 9b53272. Checked by the coverage test.
// Descriptions are getters so they follow the interface language; tool names stay as they are.
export const BUILTIN_TOOL_INFO = [
  {
    name: 'ls',
    get description() {
      return t('List a folder');
    },
    get detail() {
      return t('List a folder. Folders end in `/`.');
    },
    kind: 'read',
  },
  {
    name: 'read_file',
    get description() {
      return t(
        "Read a text file with line numbers (12: text), a folder's entries, or an image or a PDF",
      );
    },
    get detail() {
      return t(
        "Read a text file with line numbers (`12: text`), a folder's entries, or an image or a PDF. Arguments: `file_path`, `offset` (lines to skip), `limit`.",
      );
    },
    kind: 'read',
  },
  {
    name: 'glob',
    get description() {
      return t('Find files by pattern.');
    },
    get detail() {
      return t('Find files by pattern.');
    },
    kind: 'read',
  },
  {
    name: 'grep',
    get description() {
      return t(
        'Search file contents for **literal text**, not a regular expression',
      );
    },
    get detail() {
      return t(
        'Search file contents for **literal text**, not a regular expression. Modes: files with matches (the default), matching lines, counts. A `glob` argument limits the files searched.',
      );
    },
    kind: 'read',
  },
  {
    name: 'lsp',
    get description() {
      return t(
        'Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations',
      );
    },
    get detail() {
      return t(
        'Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations. Positions are 1-based.',
      );
    },
    kind: 'read',
  },
  {
    name: 'webfetch',
    get description() {
      return t('Fetch a URL');
    },
    get detail() {
      return t(
        'Fetch a URL. Formats: `markdown` (the default), `text`, `html`. JSON is pretty-printed.',
      );
    },
    kind: 'read',
  },
  {
    name: 'websearch',
    get description() {
      return t('Search the web through DuckDuckGo');
    },
    get detail() {
      return t('Search the web through DuckDuckGo. No API key.');
    },
    kind: 'read',
  },
  {
    name: 'write_file',
    get description() {
      return t('Create or overwrite a file.');
    },
    get detail() {
      return t('Create or overwrite a file.');
    },
    kind: 'write',
  },
  {
    name: 'edit_file',
    get description() {
      return t('Replace exact text in a file');
    },
    get detail() {
      return t(
        'Replace exact text in a file. Arguments: `file_path`, `old_string`, `new_string`, `replace_all`.',
      );
    },
    kind: 'write',
  },
  {
    name: 'apply_patch',
    get description() {
      return t(
        'Apply a multi-file patch in the *** Begin Patch format: add, update, move and delete files.',
      );
    },
    get detail() {
      return t(
        'Apply a multi-file patch in the `*** Begin Patch` format: add, update, move and delete files.',
      );
    },
    kind: 'write',
  },
  {
    name: 'delete',
    get description() {
      return t('Delete a file or a folder and everything in it.');
    },
    get detail() {
      return t('Delete a file or a folder and everything in it.');
    },
    kind: 'write',
  },
  {
    name: 'screenshot',
    get description() {
      return t(
        'Take a screenshot of the main screen, or of the front window of one application',
      );
    },
    get detail() {
      return t(
        'Take a screenshot of the main screen, or of the front window of the application named in `app`, and send it to the model as an image. It asks each time unless allowed for the session, and is refused in read-only mode.',
      );
    },
    kind: 'read',
  },
  {
    name: 'execute',
    get description() {
      return t('Run a shell command in the workspace');
    },
    get detail() {
      return t(
        'Run a shell command in the workspace. With `background: true` it runs as a background job and returns at once. Standard output and standard error come back together, in the order they were written.',
      );
    },
    kind: 'write',
  },
  {
    name: 'write_todos',
    get description() {
      return t('Keep the plan shown in the plan box.');
    },
    get detail() {
      return t('Keep the plan shown in the plan box.');
    },
    kind: 'interaction',
  },
  {
    name: 'question',
    get description() {
      return t(
        'Ask you one or more questions with options, or ask for a secret',
      );
    },
    get detail() {
      return t(
        'Ask you one or more questions with options, or ask for a secret. Your answers become the tool result. See Answer a question and Secrets.',
      );
    },
    kind: 'interaction',
  },
  {
    name: 'plan_enter',
    get description() {
      return t('Switch to read-only mode, as /plan does.');
    },
    get detail() {
      return t('Switch to `read-only` mode, as `/plan` does.');
    },
    kind: 'interaction',
  },
  {
    name: 'plan_exit',
    get description() {
      return t(
        'Ask you whether to leave read-only mode and implement the plan',
      );
    },
    get detail() {
      return t(
        'Ask you whether to leave `read-only` mode and implement the plan. Only you can say yes, so it fails without the full-screen interface.',
      );
    },
    kind: 'interaction',
  },
  {
    name: 'list_jobs',
    get description() {
      return t(
        "List this conversation's jobs: id, kind, state, time, what, and the file their output goes to.",
      );
    },
    get detail() {
      return t(
        "List this conversation's jobs: id, kind, state, time, what, and the file their output goes to.",
      );
    },
    kind: 'agent / job',
  },
  {
    name: 'stop_job',
    get description() {
      return t('Stop a running job with everything it started.');
    },
    get detail() {
      return t('Stop a running job with everything it started.');
    },
    kind: 'agent / job',
  },
  {
    name: 'wait_jobs',
    get description() {
      return t(
        'Wait until one of the given jobs ends (up to 600 seconds), and return how it ended',
      );
    },
    get detail() {
      return t(
        'Wait until one of the given jobs ends (up to 600 seconds), and return how it ended. Only subagents have it: they cannot be woken by a notice.',
      );
    },
    kind: 'agent / job',
  },
  {
    name: 'skill',
    get description() {
      return t('Load the full instructions of a skill by name.');
    },
    get detail() {
      return t('Load the full instructions of a skill by name.');
    },
    kind: 'interaction',
  },
  {
    name: 'task',
    get description() {
      return t(
        'Run a subagent (general-purpose, explore, or one an extension adds) and return its answer',
      );
    },
    get detail() {
      return t(
        'Run a subagent (`general-purpose`, `explore`, or one an extension adds) and return its answer. Arguments: `description`, `subagent_type`, `background`. With `background: true` the subagent runs as a background job and its report comes as a notice. See How Circle works.',
      );
    },
    kind: 'agent / job',
  },
  {
    name: 'compact_conversation',
    get description() {
      return t('Summarize older messages now');
    },
    get detail() {
      return t('Summarize older messages now. See Compaction.');
    },
    kind: 'interaction',
  },
] as const;

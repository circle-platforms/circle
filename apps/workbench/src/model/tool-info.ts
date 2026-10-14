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
    name: 'browser_navigate',
    get description() {
      return t('Open a page in the session browser');
    },
    get detail() {
      return t(
        "Open an HTTP or HTTPS page, or go back, forward or reload. An untrusted certificate shows the browser's warning in the tab; passing it needs your approval.",
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_snapshot',
    get description() {
      return t('Read the visible page and its element refs');
    },
    get detail() {
      return t(
        'Read the page, its waiting dialogs, tabs and what happened since the last look. Refs stay with their elements; password values are omitted.',
      );
    },
    kind: 'read',
  },
  {
    name: 'browser_click',
    get description() {
      return t('Click an element in the browser');
    },
    get detail() {
      return t(
        'Click an element by its ref with the visible pointer, then read the updated page. Covered elements cannot be clicked.',
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_click_at',
    get description() {
      return t('Click a visible control without an element ref');
    },
    get detail() {
      return t(
        'Use CSS coordinates from the latest screenshot. Changed screenshots are refused; unknown or destructive targets ask once. Coordinate clicks are not recorded.',
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_type',
    get description() {
      return t('Type text into a browser element');
    },
    get detail() {
      return t(
        'Replace text in an element, optionally submitting with Enter. Password fields require you to type in the browser panel.',
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_select',
    get description() {
      return t('Choose options in a browser element');
    },
    get detail() {
      return t('Choose options in a select element by their text or value.');
    },
    kind: 'browser',
  },
  {
    name: 'browser_press',
    get description() {
      return t('Press a key in the browser');
    },
    get detail() {
      return t(
        'Press Enter, Tab, Escape, an arrow key or another supported browser key.',
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_screenshot',
    get description() {
      return t('Capture the session browser for the model');
    },
    get detail() {
      return t(
        'Send the browser viewport as an image to the model. The operation overlay is hidden during capture.',
      );
    },
    kind: 'read',
  },
  {
    name: 'browser_dialog',
    get description() {
      return t('Answer a browser JavaScript dialog');
    },
    get detail() {
      return t(
        "Accept or dismiss a page's alert, confirm, prompt or leave-page question, as you can in the panel or the conversation.",
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_handoff',
    get description() {
      return t('Hand you the browser and wait for it back');
    },
    get detail() {
      return t(
        'For what only you should do in the page, such as a security key or a CAPTCHA. Circle sees nothing while you have it, and learns only where the tabs went.',
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_upload',
    get description() {
      return t('Give a page files from this computer');
    },
    get detail() {
      return t(
        'For a file input, or for the file chooser one of its clicks opened. Circle asks you every time, with the files and the site.',
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_tabs',
    get description() {
      return t('List, open, show or close browser tabs');
    },
    get detail() {
      return t(
        'Pages that open a new window or tab appear as tabs; you and Circle see the same shown tab.',
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_record',
    get description() {
      return t("Record the conversation's browser actions as a script");
    },
    get detail() {
      return t(
        "Write this conversation's browser actions to a script file in Circle's own format, each element kept by its role and name. Writing the file asks as writing any file does.",
      );
    },
    kind: 'browser',
  },
  {
    name: 'browser_replay',
    get description() {
      return t('Replay a recorded browser script');
    },
    get detail() {
      return t(
        "Run a script's steps in the conversation's browser without the model in between, waiting for each element. It acts only on the site it starts on, which you allow as for other browser actions, and stops at the first step that cannot be done.",
      );
    },
    kind: 'browser',
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

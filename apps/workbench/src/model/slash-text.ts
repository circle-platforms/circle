import { t } from '../i18n/index.ts';

// What each built-in slash command does, in the interface language. The core writes them
// in English (src/tui/slash_commands.ts); a command not listed shows the core's words.
const SLASH_TEXT: Record<string, () => string> = {
  help: () => t('List slash commands'),
  hotkeys: () => t('Show keyboard shortcuts'),
  login: () => t('Sign in or change the endpoint, key and model'),
  logout: () => t('Clear saved credentials'),
  init: () => t('Analyze repo and write AGENTS.md'),
  trust: () => t('Trust this workspace'),
  settings: () => t('Show current settings'),
  themes: () => t('Show or set the theme: /themes [auto|dark|light]'),
  mcp: () => t('List / reload MCP servers and tools'),
  extensions: () => t('List extensions: /extensions [reload]'),
  approvals: () => t('Session approvals: /approvals [revoke N]'),
  jobs: () => t('Background jobs: open one, or stop it'),
  new: () => t('Start a new session'),
  resume: () => t('Choose a session to open: /resume [n|id]'),
  continue: () => t('Resume the previous session'),
  name: () => t('Set session display name: /name <title>'),
  session: () => t('Show the session: id, title, messages, tokens'),
  models: () => t('Choose a model: /models [name]'),
  compact: () => t('Summarize context to free the window'),
  plan: () => t('Toggle read-only (plan) mode: /plan [on|off]'),
  skill: () =>
    t('List or load a skill: /skill [name] [args] or /skill:name [args]'),
  tree: () => t('Go back to an earlier point of the session: /tree [words]'),
  fork: () => t('New session from before one of your messages: /fork [words]'),
  clone: () => t('Clone the active branch into a new session'),
  undo: () => t('Undo the last turn on screen'),
  agents: () => t('List the subagents task can use: /agents [name]'),
  redo: () => t('Restore after /undo'),
  thinking: () => t('Hide or show thinking; /thinking <level> sets the depth'),
  effort: () =>
    t('Choose the thinking depth: /effort [minimal|low|medium|high|xhigh|max]'),
  details: () => t('Toggle tool-detail verbosity in footer'),
  copy: () => t('Copy last assistant message to clipboard'),
  export: () =>
    t('Write the conversation to a file: /export [html|jsonl|path]'),
  import: () =>
    t('Start a session from an export: /import <file.jsonl|file.md>'),
  share: () => t('Write a shareable Markdown copy under ~/.circle/shares/'),
  unshare: () => t('Delete the active local share file'),
  editor: () => t('Compose next message in $EDITOR / $VISUAL'),
  reload: () => t('Reload settings.json and rebuild the model'),
  yolo: () => t('Toggle auto mode: approve every tool call without asking'),
  mode: () => t('Next approval mode, or /mode manual|accept-edits|plan|auto'),
  exit: () => t('Quit Circle'),
  variables: () => t('Named values Circle fills in: /variables [NAME=value]'),
  secrets: () => t('Named values Circle fills in unseen: /secrets [NAME]'),
};
export function slashText(name: string, english: string): string {
  return SLASH_TEXT[name]?.() ?? english;
}

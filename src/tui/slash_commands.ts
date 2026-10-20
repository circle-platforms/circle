// No imports: the desktop window evals this file where there is no module
// loader. locale.ts installs the translator; until then the words stay English.
let t: (text: string) => string = (text) => text;
export function setSlashTranslator(fn: (text: string) => string): void {
  t = fn;
}

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
}
/**
 * The system the words are for. The desktop window and its browser preview
 * load this list too, and they have no `process`.
 */
function hostPlatform(): string {
  if (typeof process !== 'undefined' && process.platform)
    return process.platform;
  const agent = globalThis.navigator?.userAgent ?? '';
  return /Windows/i.test(agent) ? 'win32' : 'browser';
}
/**
 * What /variables and /secrets say. The value is still written `%NAME%` in a tool's
 * arguments; on Windows the commands say so, and elsewhere they do not show that form.
 */
export function variableCopy(platform: string = hostPlatform()): {
  variables: string;
  secrets: string;
  saved(name: string): string;
  secretCard(name: string): string;
} {
  const windows = platform === 'win32';
  return {
    variables: windows
      ? 'Values the model uses as %NAME%: /variables [NAME=value]'
      : 'Named values Circle fills in: /variables [NAME=value]',
    secrets: windows
      ? 'Values the model uses as %NAME% unseen: /secrets [NAME]'
      : 'Named values Circle fills in unseen: /secrets [NAME]',
    saved: (name) =>
      windows
        ? `the model writes %${name}% to use it`
        : `Circle fills ${name} in when a tool runs`,
    secretCard: (name) =>
      windows
        ? `The model knows only the name and writes %${name}% in a tool's arguments; Circle puts this value in when the tool runs.`
        : `The model knows only the name. Circle puts this value in a tool's arguments when the tool runs.`,
  };
}
export const BUILTIN_SLASH: SlashCommand[] = [
  { name: 'help', description: 'List slash commands' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts' },
  {
    name: 'login',
    description: 'Sign in or change the endpoint, key and model',
    aliases: ['connect'],
  },
  { name: 'logout', description: 'Clear saved credentials' },
  { name: 'init', description: 'Analyze repo and write AGENTS.md' },
  { name: 'trust', description: 'Trust this workspace' },
  { name: 'settings', description: 'Show current settings' },
  {
    name: 'variables',
    description: variableCopy().variables,
  },
  {
    name: 'secrets',
    description: variableCopy().secrets,
  },
  {
    name: 'themes',
    description: 'Show or set the theme: /themes [auto|dark|light]',
  },
  { name: 'mcp', description: 'List / reload MCP servers and tools' },
  {
    name: 'extensions',
    description:
      'List extensions: /extensions [reload | enable <name> | disable <name>]',
    aliases: ['ext'],
  },
  {
    name: 'hooks',
    description: 'List hooks: name, source, event, command and trust',
  },
  {
    name: 'approvals',
    description: 'Session approvals: /approvals [add P|remove P|revoke N]',
  },
  {
    name: 'jobs',
    description: 'Background jobs: open one, or stop it',
    aliases: ['tasks'],
  },
  {
    name: 'terminals',
    description: 'Device terminals: open a console, connect a profile, cut one',
  },
  { name: 'new', description: 'Start a new session', aliases: ['clear'] },
  {
    name: 'resume',
    description: 'Choose a session to open: /resume [n|id]',
    aliases: ['sessions'],
  },
  { name: 'continue', description: 'Resume the previous session' },
  {
    name: 'name',
    description: 'Set session display name: /name <title>',
    aliases: ['rename'],
  },
  {
    name: 'session',
    description: 'Show the session: id, title, messages, tokens',
  },
  {
    name: 'models',
    description: 'Choose a model: /models [name]',
    aliases: ['model'],
  },
  {
    name: 'compact',
    description: 'Summarize context to free the window',
    aliases: ['summarize'],
  },
  {
    name: 'plan',
    description: 'Toggle read-only (plan) mode: /plan [on|off]',
    aliases: ['plan-mode'],
  },
  {
    name: 'skill',
    description:
      'List or load a skill: /skill [name] [args] or /skill:name [args]',
    aliases: ['skills'],
  },
  {
    name: 'tree',
    description: 'Go back to an earlier point of the session: /tree [words]',
  },
  {
    name: 'fork',
    description: 'New session from before one of your messages: /fork [words]',
  },
  { name: 'clone', description: 'Clone the active branch into a new session' },
  { name: 'undo', description: 'Undo the last turn on screen' },
  { name: 'redo', description: 'Restore after /undo' },
  {
    name: 'thinking',
    description: 'Hide or show thinking; /thinking <level> sets the depth',
  },
  {
    name: 'effort',
    description:
      'Choose the thinking depth: /effort [minimal|low|medium|high|xhigh|max]',
  },
  { name: 'details', description: 'Toggle tool-detail verbosity in footer' },
  { name: 'copy', description: 'Copy last assistant message to clipboard' },
  {
    name: 'export',
    description: 'Write the conversation to a file: /export [html|jsonl|path]',
  },
  {
    name: 'import',
    description: 'Start a session from an export: /import <file.jsonl|file.md>',
  },
  {
    name: 'share',
    description: 'Write a shareable Markdown copy under ~/.circle/shares/',
  },
  { name: 'unshare', description: 'Delete the active local share file' },
  { name: 'editor', description: 'Compose next message in $EDITOR / $VISUAL' },
  { name: 'reload', description: 'Reload settings.json and rebuild the model' },
  {
    name: 'yolo',
    description: 'Toggle auto mode: approve every tool call without asking',
    aliases: ['auto'],
  },
  {
    name: 'mode',
    description:
      'Next session mode (shift+tab), or /mode manual|accept-edits|plan|auto',
  },
  { name: 'exit', description: 'Quit Circle', aliases: ['quit', 'q'] },
];
const CANONICAL = new Map<string, string>(
  BUILTIN_SLASH.flatMap((command) => [
    [command.name, command.name],
    ...(command.aliases ?? []).map((alias): [string, string] => [
      alias,
      command.name,
    ]),
  ]),
);
export function knownSlashNames(): Set<string> {
  return new Set(CANONICAL.keys());
}
// `/name` or `/name args`: a command, known or not. `/usr/bin/x` is a path, not this.
export function commandWord(text: string): string {
  return text.match(/^\/([A-Za-z][\w:-]*)(?:\s|$)/)?.[1]?.toLowerCase() ?? '';
}
/**
 * A slash token that must not be sent to the model. A leading space, or a
 * sentence such as `/usr/bin/env is missing`, is ordinary text.
 */
export function refusedSlash(raw: string, message: string): boolean {
  if (!message.startsWith('/')) return false;
  if (commandWord(raw)) return true;
  return !/\s/.test(raw) && /^\/[A-Za-z]/.test(raw);
}
// A built-in command (by name or alias), one of `extra` (custom and extension commands), or
// pi's `/skill:name [args]`. Anything else is not a command: undefined.
export function parseSlash(
  text: string,
  extra: Set<string> = new Set(),
): { name: string; rawName: string; args: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return undefined;
  const body = trimmed.slice(1).trim();
  if (!body) return undefined;
  if (body.toLowerCase().startsWith('skill:')) {
    const rest = body.slice(6).trim();
    const skill = rest.split(/\s/, 1)[0]!;
    const skillArgs = rest.slice(skill.length).trim();
    if (skill)
      return {
        name: 'skill',
        rawName: `skill:${skill}`,
        args: skillArgs ? `${skill} ${skillArgs}` : skill,
      };
  }
  const raw = body.split(/\s/, 1)[0]!.toLowerCase();
  const args = body.slice(raw.length).trim();
  const name = CANONICAL.get(raw);
  if (name) return { name, rawName: raw, args };
  if (extra.has(raw)) return { name: raw, rawName: raw, args };
  return undefined;
}
// difflib's ratio: twice the matched characters over both lengths, matching the longest common
// block first and then the parts on either side of it.
function similarity(a: string, b: string): number {
  const matched = (a: string, b: string): number => {
    let best = 0;
    let atA = 0;
    let atB = 0;
    for (let i = 0; i < a.length; i++)
      for (let j = 0; j < b.length; j++) {
        let k = 0;
        while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k])
          k++;
        if (k > best) [best, atA, atB] = [k, i, j];
      }
    return best
      ? best +
          matched(a.slice(0, atA), b.slice(0, atB)) +
          matched(a.slice(atA + best), b.slice(atB + best))
      : 0;
  };
  return a.length + b.length ? (2 * matched(a, b)) / (a.length + b.length) : 0;
}
// The closest name, as difflib.get_close_matches(n=1, cutoff=0.6) picks it.
export function closeMatch(name: string, names: Iterable<string>): string {
  let best = '';
  let score = -1;
  // Sorted, so that of two as close the later one wins, as in difflib.
  for (const candidate of [...names].sort()) {
    const value = similarity(name, candidate);
    if (value >= 0.6 && value >= score) {
      best = candidate;
      score = value;
    }
  }
  return best;
}
export function helpText(custom: [string, string][] = []): string {
  const lines = [t('Available commands:'), ''];
  for (const command of BUILTIN_SLASH) {
    const alias = command.aliases?.length
      ? ' (' + command.aliases.map((alias) => '/' + alias).join(', ') + ')'
      : '';
    lines.push(
      `  /${command.name.padEnd(10)} ${t(command.description)}${alias}`,
    );
  }
  if (custom.length) {
    lines.push('', t('Custom commands:'));
    for (const [name, description] of custom)
      lines.push(`  /${name.padEnd(10)} ${t(description)}`);
  }
  lines.push('', t('Type text without / to chat. Skills also: /skill:name'));
  return lines.join('\n');
}
export const HOTKEY_LINES = [
  '  enter           send; while busy, the model reads it after its current step',
  '                  enter on an empty prompt: the model reads it now',
  '  up              on an empty prompt, take back the last message not read yet',
  '  ctrl+q          queue a follow-up: sent when the turn ends (also alt+enter)',
  '  alt+up          take back messages the model has not read yet',
  '  ctrl+v          paste the picture on the clipboard (also alt+v)',
  '  esc             stop the turn; with a draft, press again to clear (ctrl+y restores)',
  '  esc esc         clear a draft, or the session tree (/tree) when the box is empty',
  '  ctrl+c          abort turn; clear the prompt; on an empty prompt twice to exit',
  '  ctrl+d          exit (with an empty prompt; otherwise delete forward)',
  '  ctrl+z          suspend to the shell; fg comes back',
  '  ctrl+b          move a running command to the background (/jobs lists them)',
  '  \\ enter         line break (also shift+enter, ctrl+j)',
  '  ctrl+t          expand/collapse thinking',
  '  ctrl+o          expand/collapse tool output',
  '  ctrl+r          reverse-i-search history',
  '  ctrl+l          redraw the screen',
  '  alt+l           choose a model (/models)',
  '  alt+s           switch sessions, including while an approval waits',
  '  alt+m           next model, for this session',
  '  ctrl+p / ctrl+n earlier / next prompt (also up / down)',
  '  shift+tab       next session mode (manual, accept edits, read-only, auto)',
  '  alt+t           next thinking depth, for this session',
  '  ctrl+g          edit the draft in $VISUAL / $EDITOR (/editor)',
  '  alt+c           copy the last answer (/copy)',
  '  alt+k           enter a secret a task left waiting',
  '  ctrl+f          find in the conversation; enter next, esc closes',
  '  alt+left/right  move by word (also ctrl+left/right, alt+b / alt+f)',
  '  ctrl+w          delete the word before the cursor (also alt+backspace)',
  '  alt+d           delete the word after the cursor',
  '  ctrl+k / ctrl+u delete to the end / back to the start of the line; ctrl+y restores',
  '  in a list       alt+d saves a default · ctrl+k deletes or stops · ctrl+r renames',
  '  up/down         prompt history; with an empty prompt and no more history,',
  '                  scroll the transcript',
  '  down (empty)    select a running subagent; up/down move, enter opens it',
  '  left/right      previous/next subagent on its detail page; esc goes back',
  '  pageup/pagedown scroll transcript (or the detail page) when the prompt is empty',
  '  home/end        top / bottom of the transcript when the prompt is empty',
  '  mouse drag      select and copy; dragging to the top or bottom edge scrolls',
  '  tab             complete a /command or an @path',
  '  ?               this list (with an empty prompt)',
  '  /               slash commands (/help)',
  '  1-9, up/down    answer a permission or question card; enter confirms, esc rejects,',
  '                  y / a / n also work on permission cards',
  '  mouse wheel     over the plan box scrolls it; elsewhere it scrolls the transcript',
];
export function hotkeysText(): string {
  return [
    t('Keyboard shortcuts:'),
    ...HOTKEY_LINES.map((line) => t(line)),
  ].join('\n');
}

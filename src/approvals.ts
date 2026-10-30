import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalPath, circleHome, normalizeWorkspace } from './paths.js';
import { isRecord, readJson, writePrivateJson } from './settings.js';
import { DEFAULT_CREDENTIAL_FILES, matchPattern } from './file_patterns.js';

export type Verdict = 'DENY' | 'ASK' | 'ASK_FORCED';
export interface Review {
  verdict: Verdict;
  reason: string;
  message: string;
  pattern: string;
  scope: string;
  warn_delete: boolean;
  prefix: string[];
  covered_by: string[];
}
const review = (
  verdict: Verdict,
  reason: string,
  extra: Partial<Review> = {},
): Review => ({
  verdict,
  reason,
  message: '',
  pattern: '',
  scope: '',
  warn_delete: false,
  prefix: [],
  covered_by: [],
  ...extra,
});
// The names live in src/file_patterns.ts, where a module with no Node.js import
// can read them: the desktop settings page lists and checks them the same way.
export { DEFAULT_CREDENTIAL_FILES };
const READERS = new Set(
  'ls cat head tail wc pwd which whoami date uname file stat du df tree basename dirname realpath readlink true diff cmp nl cut grep egrep fgrep rg find cd test jq git'.split(
    ' ',
  ),
);
const PRIVILEGED = new Set('sudo su doas pkexec runas gsudo'.split(' '));
const DELETES = new Set(
  'rm rmdir unlink shred srm trash trash-put del erase rd remove-item ri'.split(
    ' ',
  ),
);
const DISK = new Set(
  'dd truncate wipefs fdisk parted format diskpart cipher sdelete clear-disk format-volume'.split(
    ' ',
  ),
);
const SEPARATORS = new Set([
  ';',
  '&&',
  '||',
  '|',
  '&',
  '|&',
  '(',
  ')',
  '{',
  '}',
]);
const READ_GIT = new Set(
  'status diff log show rev-parse ls-files blame describe shortlog grep ls-tree cat-file branch'.split(
    ' ',
  ),
);
export function wildcard(
  pattern: string,
  value: string,
  insensitive = process.platform === 'win32',
): boolean {
  return matchPattern(pattern, value, insensitive);
}
export function commandTokens(
  command: string,
  platform: string = process.platform,
): string[] | null {
  const out: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  // A POSIX shell escapes whatever follows a backslash. cmd.exe has no such rule: there
  // a backslash separates folders, and only a quote is escaped (the rule PowerShell and
  // the C runtime use). So `C:\proj\.env` names the file `.env` here, and is not read as
  // the single word `C:proj.env`.
  const escapes = (next: string | undefined): boolean =>
    next === undefined
      ? false
      : platform === 'win32'
        ? next === '"' || next === "'"
        : true;
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (char === '\\' && quote !== "'" && escapes(command[i + 1])) {
      if (++i >= command.length) return null;
      word += command[i];
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      started = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char) || /[;&|<>(){}]/.test(char) || char === '`') {
      if (started) {
        out.push(word);
        word = '';
        started = false;
      }
      if (char === '\n' || char === '`') out.push(';');
      else if (!/\s/.test(char)) {
        const next = command[i + 1];
        if (next === char && ['&', '|', '<', '>'].includes(char)) {
          out.push(char + next);
          i++;
        } else out.push(char);
      }
    } else {
      word += char;
      started = true;
    }
  }
  if (quote) return null;
  if (started) out.push(word);
  return out;
}
function program(token: string, platform: string = process.platform): string {
  const name = basename(token.replace(/\\/g, '/'));
  return platform === 'win32'
    ? name.toLowerCase().replace(/\.(exe|com|cmd|bat)$/, '')
    : name;
}
function unwrap(words: string[], platform: string): string[] {
  let i = 0;
  while (i < words.length) {
    const head = program(words[i]!, platform);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
    else if (head === 'env') {
      i++;
      while (
        i < words.length &&
        (/^-/.test(words[i]!) || /^[A-Za-z_]\w*=/.test(words[i]!))
      )
        i++;
    } else if (
      [
        'nohup',
        'time',
        'command',
        'builtin',
        'exec',
        'stdbuf',
        'caffeinate',
      ].includes(head)
    )
      i++;
    else if (['nice', 'timeout', 'ionice', 'xargs'].includes(head)) {
      i++;
      while (words[i]?.startsWith('-')) {
        const flag = words[i++]!;
        if (
          ['-n', '-I', '-L', '-P', '-d', '-s', '-a', '-E', '-c'].includes(flag)
        )
          i++;
      }
      if (head === 'timeout') i++;
    } else break;
  }
  return words.slice(i);
}
function segments(tokens: string[]): string[][] {
  const out: string[][] = [[]];
  for (const token of tokens) {
    if (SEPARATORS.has(token)) out.push([]);
    else out.at(-1)!.push(token);
  }
  return out.filter((words) => words.length);
}
function flag(args: string[], short: string, long: string): boolean {
  return args
    .slice(0, args.includes('--') ? args.indexOf('--') : undefined)
    .some(
      (word) =>
        Boolean(long && (word === long || word.startsWith(long + '='))) ||
        Boolean(
          short &&
          word.startsWith('-') &&
          !word.startsWith('--') &&
          word.slice(1).includes(short),
        ),
    );
}
function destructiveGit(args: string[]): boolean {
  let i = 0;
  const valueFlags = new Set([
    '-C',
    '-c',
    '--config-env',
    '--git-dir',
    '--namespace',
    '--super-prefix',
    '--work-tree',
  ]);
  while (args[i]?.startsWith('-')) i += valueFlags.has(args[i]!) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === 'reset')
    return flag(rest, '', '--hard') || flag(rest, '', '--merge');
  if (sub === 'clean') return flag(rest, 'f', '--force');
  if (sub === 'push')
    return (
      flag(rest, 'f', '--force') ||
      flag(rest, '', '--force-with-lease') ||
      flag(rest, '', '--mirror') ||
      flag(rest, 'd', '--delete') ||
      rest.some((word) => /^[+:].+/.test(word))
    );
  if (sub === 'branch')
    return (
      flag(rest, 'D', '') ||
      (flag(rest, 'd', '--delete') && flag(rest, 'f', '--force'))
    );
  if (sub === 'stash') return ['drop', 'clear'].includes(rest[0] ?? '');
  if (sub === 'checkout')
    return flag(rest, 'f', '--force') || rest.includes('--') || rest[0] === '.';
  if (sub === 'restore')
    return !flag(rest, 'S', '--staged') || flag(rest, 'W', '--worktree');
  return ['rm', 'filter-branch', 'filter-repo'].includes(sub ?? '');
}
const SYSTEM_STATE: Record<string, string[]> = {
  reg: ['delete'],
  sc: ['delete'],
  vssadmin: ['delete', 'delete-shadows'],
  wevtutil: ['cl', 'clear-log'],
};

/** Deleting registry keys, services, scheduled tasks, shadow copies or the event log. */
function destroysSystemState(head: string, args: string[]): boolean {
  // An own lookup: a program named `toString` must not reach Object.prototype here.
  const verbs = Object.hasOwn(SYSTEM_STATE, head)
    ? SYSTEM_STATE[head]
    : undefined;
  if (verbs) return verbs.includes((args[0] ?? '').toLowerCase());
  return head === 'schtasks' && args.some((word) => /^\/delete$/i.test(word));
}

export function classifyCommand(
  command: string,
  patterns = DEFAULT_CREDENTIAL_FILES,
  depth = 0,
  platform: string = process.platform,
): Review {
  if (depth > 3) return review('ASK_FORCED', 'nested too deep to read');
  const tokens = commandTokens(command, platform);
  if (!tokens) return review('ASK_FORCED', 'command could not be parsed');
  let forced: Review | undefined;
  let readOnly = tokens.length > 0 && !/\$\(|`|[<>]/.test(command);
  for (const raw of segments(tokens)) {
    for (const token of raw) {
      for (const candidate of [
        token,
        token.includes('=') ? token.split('=').slice(1).join('=') : '',
      ]) {
        const name = basename(candidate.replace(/\\/g, '/'));
        if (
          patterns.some((pattern) =>
            wildcard(pattern, name, platform === 'win32'),
          )
        )
          return review('DENY', `credential file ${name}`, {
            message: `Denied by approval policy: '${name}' is a credential file; commands may not read, copy or change it.`,
          });
      }
    }
    const words = unwrap(raw, platform);
    const head = program(words[0] ?? '', platform);
    const args = words.slice(1);
    if (PRIVILEGED.has(head))
      return review('DENY', 'privilege escalation', {
        message: `Denied by approval policy: '${head}' is not allowed.`,
      });
    const codeAt = args.findIndex((word) => /^-[^-]*c/.test(word));
    if (
      ['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish'].includes(head) &&
      codeAt >= 0 &&
      args[codeAt + 1]
    ) {
      const nested = classifyCommand(
        args[codeAt + 1]!,
        patterns,
        depth + 1,
        platform,
      );
      if (nested.verdict === 'DENY') return nested;
      if (nested.verdict === 'ASK_FORCED') forced = nested;
    }
    if (/^python\d*(?:\.\d+)*$/.test(head) && codeAt >= 0) {
      const code = args[codeAt + 1] ?? '';
      for (const match of code.matchAll(/['"]([^'"\n]+)['"]/g))
        if (
          patterns.some((pattern) =>
            wildcard(pattern, basename(match[1]!), platform === 'win32'),
          )
        )
          return review('DENY', 'credential file in Python code');
      if (
        /\b(?:shutil\.rmtree|os\.(?:remove|unlink|rmdir|removedirs))\s*\(|\.(?:unlink|rmdir)\s*\(/.test(
          code,
        )
      )
        forced = review('ASK_FORCED', 'python code deletes files', {
          warn_delete: true,
        });
    }
    if (
      DELETES.has(head) ||
      DISK.has(head) ||
      head.startsWith('mkfs') ||
      (head === 'git' && destructiveGit(args)) ||
      (head === 'find' && args.includes('-delete')) ||
      destroysSystemState(head, args)
    )
      forced = review('ASK_FORCED', 'destructive operation', {
        warn_delete: true,
      });
    if (head === 'find')
      for (const action of ['-exec', '-execdir', '-ok', '-okdir']) {
        const index = args.indexOf(action);
        if (index >= 0) {
          const nested = classifyCommand(
            args
              .slice(index + 1)
              .filter((word) => word !== '{}')
              .join(' '),
            patterns,
            depth + 1,
            platform,
          );
          if (nested.verdict === 'DENY') return nested;
          if (nested.verdict === 'ASK_FORCED') forced = nested;
        }
      }
    if (head === 'cmd') {
      const index = args.findIndex((word) => /^\/[ckr]/i.test(word));
      if (index >= 0) {
        const nested = classifyCommand(
          [args[index]!.slice(2), ...args.slice(index + 1)].join(' '),
          patterns,
          depth + 1,
          platform,
        );
        if (nested.verdict === 'DENY') return nested;
        if (nested.verdict === 'ASK_FORCED') forced = nested;
      }
    }
    if (head === 'pwsh' || head === 'powershell') {
      const index = args.findIndex((word) =>
        /^-(?:c|comm|command)$/i.test(word),
      );
      if (args.some((word) => /^-(?:ec|encodedcommand)$/i.test(word)))
        forced = review('ASK_FORCED', 'encoded command');
      else if (index >= 0) {
        const nested = classifyCommand(
          args.slice(index + 1).join(' '),
          patterns,
          depth + 1,
          platform,
        );
        if (nested.verdict === 'DENY') return nested;
        if (nested.verdict === 'ASK_FORCED') forced = nested;
      }
    }
    if (
      !READERS.has(head) ||
      words[0] !== head ||
      raw.length !== words.length ||
      raw.some((word) => /^[A-Za-z_]\w*=/.test(word))
    )
      readOnly = false;
    if (
      head === 'git' &&
      (!READ_GIT.has(args[0] ?? '') ||
        args.some((word) =>
          /^--(?:output|ext-diff|open-files-in-pager)/.test(word),
        ) ||
        (args[0] === 'branch' &&
          args
            .slice(1)
            .some(
              (word) =>
                ![
                  '-a',
                  '-r',
                  '-v',
                  '-vv',
                  '--list',
                  '--all',
                  '--remotes',
                  '--show-current',
                  '--no-color',
                ].includes(word),
            )))
    )
      readOnly = false;
    if (
      (head === 'find' &&
        args.some((word) =>
          /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(
            word,
          ),
        )) ||
      (head === 'rg' && args.some((word) => word.startsWith('--pre'))) ||
      (head === 'tree' && args.some((word) => word.startsWith('-o'))) ||
      (head === 'file' && args.includes('-C')) ||
      (head === 'date' &&
        args.some((word) => word.startsWith('-s') || word.startsWith('--set')))
    )
      readOnly = false;
  }
  for (const match of command.matchAll(/\$\(([^()]*)\)/g)) {
    const nested = classifyCommand(match[1]!, patterns, depth + 1, platform);
    if (nested.verdict === 'DENY') return nested;
    if (nested.verdict === 'ASK_FORCED') forced = nested;
  }
  if (forced) return forced;
  return readOnly && depth === 0
    ? review('ASK', 'only reads', {
        pattern: 'read-only',
        scope: 'read-only commands (ls, cat, rg, git status, git diff …)',
      })
    : review('ASK', 'runs a shell command');
}
export function commandPrefix(
  command: string,
  platform: string = process.platform,
): string[] {
  const words = commandTokens(command, platform);
  if (
    !words?.length ||
    /\$|`|[;&|<>\n(){}]/.test(command) ||
    unwrap(words, platform).length !== words.length
  )
    return [];
  const head = program(words[0]!, platform);
  const rest = words.slice(1);
  if (/^python\d*(?:\.\d+)*$/.test(head))
    return rest[0] === '-m' && rest[1]
      ? words.slice(0, 3)
      : rest[0] && !rest[0].startsWith('-')
        ? words.slice(0, 2)
        : [];
  if (
    [
      'node',
      'ruby',
      'perl',
      'php',
      'bash',
      'sh',
      'zsh',
      'pwsh',
      'powershell',
    ].includes(head)
  )
    return rest[0] && !rest[0].startsWith('-') ? words.slice(0, 2) : [];
  if (
    [
      'git',
      'npm',
      'pnpm',
      'yarn',
      'bun',
      'deno',
      'npx',
      'uv',
      'pip',
      'cargo',
      'go',
      'make',
      'docker',
      'gh',
    ].includes(head)
  )
    return /^[A-Za-z][\w:-]*$/.test(rest[0] ?? '')
      ? words.slice(
          0,
          [
            'run',
            'exec',
            'compose',
            'x',
            'dlx',
            'tool',
            'mod',
            'workspace',
          ].includes(rest[0]!) && rest[1]
            ? 3
            : 2,
        )
      : [];
  if (
    READERS.has(head) ||
    [
      'curl',
      'wget',
      'ssh',
      'scp',
      'rsync',
      'chmod',
      'chown',
      'kill',
      'mv',
      'cp',
      'ln',
      'open',
      'eval',
      'source',
      '.',
      'sed',
      'awk',
      'tee',
    ].includes(head) ||
    PRIVILEGED.has(head)
  )
    return [];
  return words.slice(0, 1);
}
// The leading `cd <folder> &&` (or `;`) of a command, when the folder is the
// workspace itself; what remains is the command that rules and hashes see.
function stripLeadingCd(command: string, workspace: string): string {
  const leading = command.match(
    /^\s*cd\s+(?:--\s+)?("[^"$`]*"|'[^']*'|[^\s;&|<>()$`'"]+)\s*(?:&&|;)\s*/,
  );
  if (
    leading &&
    normalizeWorkspace(
      resolve(workspace, leading[1]!.replace(/^['"]|['"]$/g, '')),
    ) === normalizeWorkspace(workspace)
  )
    return command.slice(leading[0].length);
  return command;
}
/**
 * Whether `allowed_commands` patterns from the settings cover a command:
 * every segment of it, after a leading workspace `cd` is stripped, matches
 * one of the patterns as a wildcard. A command that does not parse, or parses
 * to nothing, is never covered.
 */
export function commandAllowed(
  command: string,
  patterns: readonly string[],
  workspace: string,
): boolean {
  if (!patterns.length) return false;
  const tokens = commandTokens(stripLeadingCd(command, workspace));
  if (!tokens) return false;
  const parts = segments(tokens);
  if (!parts.length) return false;
  return parts.every((words) =>
    patterns.some((pattern) => wildcard(pattern, words.join(' '))),
  );
}
interface Rule {
  tool: string;
  pattern: string;
  label: string;
  at: number;
}
interface StoreData {
  rules: Rule[];
  log: (Rule & { kind: string })[];
}
export class ApprovalStore {
  constructor(readonly root: string) {}
  private path(thread: string): string {
    return join(
      this.root,
      createHash('sha256').update(thread).digest('hex').slice(0, 32) + '.json',
    );
  }
  private load(thread: string): StoreData {
    try {
      const raw = readJson(this.path(thread));
      if (isRecord(raw))
        return {
          // The Python releases revoked a rule by marking it instead of removing
          // it. A conversation of theirs may still have such a file: a marked rule
          // stays revoked, and the next save drops it.
          rules: (Array.isArray(raw.rules) ? (raw.rules as Rule[]) : []).filter(
            (rule) =>
              isRecord(rule) && !(rule as { revoked?: unknown }).revoked,
          ),
          log: Array.isArray(raw.log) ? (raw.log as StoreData['log']) : [],
        };
    } catch {
      /* No rules yet. */
    }
    return { rules: [], log: [] };
  }
  private save(thread: string, data: StoreData): void {
    mkdirSync(this.root, { recursive: true });
    writePrivateJson(this.path(thread), { ...data, log: data.log.slice(-200) });
  }
  rules(thread: string): Rule[] {
    return this.load(thread).rules;
  }
  // Decisions in this session, oldest first: once, always, reject or revoke.
  log(thread: string): StoreData['log'] {
    return this.load(thread).log;
  }
  remove(thread: string): void {
    rmSync(this.path(thread), { force: true });
  }
  matchesAny(thread: string, tool: string, patterns: string[]): boolean {
    return this.rules(thread).some(
      (rule) =>
        rule.tool === tool &&
        Boolean(rule.pattern) &&
        patterns.includes(rule.pattern),
    );
  }
  record(
    thread: string,
    kind: string,
    tool: string,
    pattern: string,
    label: string,
  ): void {
    const data = this.load(thread);
    const entry = { tool, pattern, label, at: Date.now() / 1000 };
    if (
      kind === 'always' &&
      !data.rules.some((rule) => rule.tool === tool && rule.pattern === pattern)
    )
      data.rules.push(entry);
    data.log.push({ ...entry, kind });
    this.save(thread, data);
  }
  revoke(thread: string, index: number): Rule | undefined {
    const data = this.load(thread);
    const [entry] = data.rules.splice(index, 1);
    if (entry) {
      data.log.push({ ...entry, kind: 'revoke', at: Date.now() / 1000 });
      this.save(thread, data);
    }
    return entry;
  }
}
// How a session answers approvals. Plan mode is not one of these: it lives
// on the harness, because it removes tools rather than answering for them.
export type ApprovalMode = 'manual' | 'accept-edits' | 'auto';
export const APPROVAL_MODES: readonly ApprovalMode[] = [
  'manual',
  'accept-edits',
  'auto',
];
// What a person picks: the approval modes plus plan, in cycling order.
export type SessionMode = ApprovalMode | 'plan';
export const SESSION_MODES: readonly SessionMode[] = [
  'manual',
  'accept-edits',
  'plan',
  'auto',
];
export const isSessionMode = (value: unknown): value is SessionMode =>
  SESSION_MODES.includes(value as SessionMode);
// browser_record writes a script file as write_file writes any file
const EDIT_TOOLS = ['write_file', 'edit_file', 'apply_patch', 'browser_record'];
// The browser tools that act on a page. "Allow for this session" covers them on one site,
// the one the action acts on (`site`, which the tools add): another site asks again. A rule
// for every site, from before sites were told apart, still covers them all.
const BROWSER_ACTIONS: Record<string, string> = {
  browser_navigate: 'opens a page in the browser',
  browser_click: 'clicks in the browser',
  browser_click_at: 'clicks in the browser',
  browser_type: 'types in the browser',
  browser_select: 'chooses an option in the browser',
  browser_press: 'presses a key in the browser',
  browser_dialog: 'answers a dialog in the browser',
  browser_tabs: "manages the browser's tabs",
  // Every step of the script, on the site it starts on: it acts on no other
  browser_replay: 'runs a recorded browser script',
};
// The terminal tools that act on a device. "Allow for this session" covers them on one
// device, the `host` the action acts on (the `host:port` the tools add): another device
// asks again. A rule for every terminal covers them all.
const TERMINAL_ACTIONS: Record<string, string> = {
  terminal_connect: 'opens a terminal session on a device',
  terminal_send: 'types to the device',
  terminal_press: 'sends a key to the device',
  terminal_disconnect: 'closes a device session',
};
/** The tool name an approval rule is kept under: `browser` for every browser action. */
export const ruleTool = (tool: string): string =>
  Object.hasOwn(BROWSER_ACTIONS, tool)
    ? 'browser'
    : Object.hasOwn(TERMINAL_ACTIONS, tool)
      ? 'terminal'
      : tool;
/**
 * A write to one of the person's own terminal tabs in the desktop application, as the
 * terminal tools describe it (they add `terminal`, `first_use` and, when the write runs
 * a line, `command`, read from the values the line runs with): the shell runs that line
 * as `execute` would run it, so it is judged by the same rules, and the same rules cover
 * it. A write that runs nothing, such as text without Enter or an arrow key, does not
 * ask once the tab is in use. `uncertain` marks a line read off the screen where Circle
 * could not tell where the prompt ends: it may carry the prompt, so no rule judges or
 * keeps it, and it asks every time, as a first use does.
 */
interface TerminalTabWrite {
  firstUse: boolean;
  command?: string;
  uncertain: boolean;
  exited: boolean;
}
const TERMINAL_TAB_WRITES = new Set(['terminal_send', 'terminal_press']);
function terminalTabWrite(
  tool: string,
  args: Record<string, unknown>,
): TerminalTabWrite | undefined {
  if (
    !TERMINAL_TAB_WRITES.has(tool) ||
    typeof args.terminal !== 'string' ||
    !args.terminal.startsWith('local:')
  )
    return undefined;
  return {
    firstUse: args.first_use === true,
    ...(typeof args.command === 'string' ? { command: args.command } : {}),
    uncertain: args.uncertain === true,
    exited: args.exited === true,
  };
}
/** Where a call's "allow for this session" rule is kept: a tab's lines with commands. */
const ruleToolFor = (tool: string, args: Record<string, unknown>): string =>
  terminalTabWrite(tool, args)?.command !== undefined
    ? 'execute'
    : ruleTool(tool);
/**
 * What a tool's server says of it: `destructive`, it can delete or overwrite data;
 * `read-only`, it only reads.
 */
export type ToolHint = 'destructive' | 'read-only';
export class ApprovalPolicy {
  private modes = new Map<string, ApprovalMode>();
  // What tools say of themselves, such as an MCP tool its server marks destructive (every
  // call asks, and no "allow for this session" covers one) or read-only (it asks only when a
  // call sends the server a local file or a secret, and the card says so)
  private hints: (tool: string) => ToolHint | undefined = () => undefined;
  constructor(
    readonly store: ApprovalStore,
    readonly workspace: string,
    readonly credentialFiles = DEFAULT_CREDENTIAL_FILES,
    private readonly resolvePath?: (path: string) => string,
    private allowed: readonly string[] = [],
  ) {}
  get allowedCommands(): readonly string[] {
    return this.allowed;
  }
  /** What tools say of themselves; read for every call. */
  declareHints(hints: (tool: string) => ToolHint | undefined): void {
    this.hints = hints;
  }
  setAllowedCommands(patterns: readonly string[]): void {
    this.allowed = patterns;
  }
  // A command the settings' patterns cover runs without asking, in every mode
  // and even when it always asks; a DENY still wins, decided before this.
  // A line for a terminal tab is such a command too, once the tab is in use.
  allowedBySettings(tool: string, args: Record<string, unknown>): boolean {
    const tab = terminalTabWrite(tool, args);
    if (tab)
      return (
        !tab.firstUse &&
        !tab.uncertain &&
        tab.command !== undefined &&
        commandAllowed(tab.command, this.allowed, this.workspace)
      );
    return (
      tool === 'execute' &&
      commandAllowed(String(args.command || ''), this.allowed, this.workspace)
    );
  }
  /**
   * A write to one of the person's terminal tabs that the person always sees: the first in
   * a conversation, and a line Circle could not read for sure. The person allows it in
   * every mode, auto included, and no rule, setting or hook's allow skips it.
   */
  tabAlwaysAsks(tool: string, args: Record<string, unknown>): boolean {
    const tab = terminalTabWrite(tool, args);
    return tab?.firstUse === true || tab?.uncertain === true;
  }
  setMode(thread: string, mode: ApprovalMode): void {
    if (mode === 'manual') this.modes.delete(thread);
    else this.modes.set(thread, mode);
  }
  mode(thread: string): ApprovalMode {
    return this.modes.get(thread) ?? 'manual';
  }
  setYolo(thread: string, enabled: boolean): void {
    this.setMode(thread, enabled ? 'auto' : 'manual');
  }
  yoloEnabled(thread: string): boolean {
    return this.mode(thread) === 'auto';
  }
  review(tool: string, args: Record<string, unknown>): Review {
    // Always asks, as Circle's own deletes do: no rule is kept or covers it, a hook's allow
    // does not skip the card, and a run that cannot show one does not run it. The card is
    // headed with the tool's name, so the reason is the same words for every tool.
    const hint = this.hints(tool);
    if (hint === 'destructive')
      return review(
        'ASK_FORCED',
        'its MCP server says it can delete or overwrite data',
        { warn_delete: true },
      );
    // The harness asks for such a tool only when a call sends it a local file or a secret
    if (hint === 'read-only')
      return review(
        'ASK',
        'its MCP server says it only reads; the call sends it a local file or a secret',
        { pattern: '*', scope: `every ${tool} call` },
      );
    const tab = terminalTabWrite(tool, args);
    if (tab) {
      if (tab.exited && tab.command === undefined)
        return review('ASK', 'restarts this terminal and types into it');
      if (tab.command === undefined)
        return review('ASK', 'types in your terminal');
      const judged = this.review('execute', { command: tab.command });
      // A line that may carry its prompt: refused if it reads as refused, otherwise shown
      // to the person as it is, with no rule to keep from it
      if (tab.uncertain) {
        if (judged.verdict === 'DENY') return judged;
        return review('ASK_FORCED', 'runs the line on the screen', {
          warn_delete: judged.warn_delete,
        });
      }
      // The first write types into the person's own tab. Listing the tab asks nothing;
      // a read-only line is still that typing, so the card says so instead of "only reads".
      // The execute pattern and prefix stay, and a forced warning (a delete) stays too.
      // An exited shell is started again and then the line is typed; a delete still warns.
      if (tab.exited && judged.verdict === 'ASK')
        return {
          ...judged,
          reason: 'restarts this terminal and types this command into it',
        };
      if (tab.firstUse && judged.verdict === 'ASK')
        return { ...judged, reason: 'types this command into your terminal' };
      return judged;
    }
    if (tool === 'execute') {
      let command = String(args.command || '');
      const found = classifyCommand(command, this.credentialFiles);
      if (found.verdict !== 'ASK' || found.pattern === 'read-only')
        return found;
      command = stripLeadingCd(command, this.workspace);
      const prefix = commandPrefix(command);
      const words = prefix.length ? (commandTokens(command) ?? []) : [];
      return {
        ...found,
        pattern: 'sha256:' + createHash('sha256').update(command).digest('hex'),
        scope: 'this exact command',
        prefix,
        covered_by: words.map(
          (_, index) => 'prefix:' + JSON.stringify(words.slice(0, index + 1)),
        ),
      };
    }
    if (
      tool === 'delete' ||
      (tool === 'apply_patch' &&
        /^\*\*\* Delete File:/m.test(String(args.patchText || '')))
    )
      return review('ASK_FORCED', 'deletes files', { warn_delete: true });
    if (EDIT_TOOLS.includes(tool)) {
      const paths =
        tool === 'apply_patch'
          ? [
              ...String(args.patchText || '').matchAll(
                /^\*\*\* (?:Add File|Update File|Move to):\s*(.+)$/gm,
              ),
            ].map((match) => match[1]!)
          : [String(args.file_path || args.path || '')];
      const root = canonicalPath(this.workspace);
      const inside =
        paths.length > 0 &&
        paths.every((path) => {
          const rel = relative(
            root,
            canonicalPath(
              this.resolvePath
                ? this.resolvePath(path)
                : resolve(this.workspace, path),
            ),
          );
          return (
            Boolean(path) &&
            !isAbsolute(rel) &&
            rel !== '..' &&
            !rel.startsWith('..' + sep)
          );
        });
      return review(
        'ASK',
        inside
          ? 'changes files in the workspace'
          : 'changes files outside the workspace',
        inside
          ? { pattern: 'workspace', scope: 'file changes inside the workspace' }
          : {},
      );
    }
    if (tool === 'screenshot') {
      // The tool says when the side vision model sees the picture in the model's place
      const viewer =
        args.seen_by === 'side vision model'
          ? 'the side vision model'
          : 'the model';
      return review(
        'ASK',
        typeof args.app === 'string' && args.app.trim()
          ? `shows ${viewer} the window of ${args.app.trim()}`
          : `shows ${viewer} the whole screen`,
        { pattern: '*', scope: 'every screenshot' },
      );
    }
    if (Object.hasOwn(BROWSER_ACTIONS, tool)) {
      const site = typeof args.site === 'string' ? args.site : '';
      // A click on a control that deletes, clears or resets something, or accepting a dialog
      // that says so, asks every time, as a deleting command does: a rule for the site does
      // not cover it, and only auto mode stops asking (the tools add `deletes`)
      if (typeof args.deletes === 'string' && args.deletes)
        return review(
          'ASK_FORCED',
          `${BROWSER_ACTIONS[tool]}, which can delete: ${JSON.stringify(args.deletes)}`,
          { warn_delete: true },
        );
      return review('ASK', BROWSER_ACTIONS[tool]!, {
        pattern: site ? 'site:' + site : '*',
        scope: site ? `browser control on ${site}` : 'browser control',
        covered_by: site ? ['*'] : [],
      });
    }
    if (Object.hasOwn(TERMINAL_ACTIONS, tool)) {
      const host = typeof args.host === 'string' ? args.host : '';
      // A sent line carrying a word that can wipe what a device holds asks every time,
      // as a deleting command does: a rule for the device does not cover it, and only
      // auto mode stops asking (the tools add `deletes`, one word, never the line)
      if (typeof args.deletes === 'string' && args.deletes)
        return review(
          'ASK_FORCED',
          `${TERMINAL_ACTIONS[tool]}, which can destroy what the device holds: ${JSON.stringify(args.deletes)}`,
          { warn_delete: true },
        );
      return review('ASK', TERMINAL_ACTIONS[tool]!, {
        pattern: host ? 'host:' + host : '*',
        scope: host ? `terminal control on ${host}` : 'terminal control',
        covered_by: host ? ['*'] : [],
      });
    }
    return review('ASK', 'can change state', {
      pattern: '*',
      scope: `every ${tool} call`,
    });
  }
  needsApproval(
    tool: string,
    args: Record<string, unknown>,
    thread: string,
    allowYolo = true,
  ): boolean {
    const found = this.review(tool, args);
    if (found.verdict === 'DENY') return false;
    const tab = terminalTabWrite(tool, args);
    if (tab?.firstUse || tab?.uncertain) return true;
    if (tab && tab.command === undefined) return false;
    if (this.allowedBySettings(tool, args)) return false;
    const mode = this.mode(thread);
    if (allowYolo && mode === 'auto') return false;
    if (found.verdict === 'ASK_FORCED') return true;
    // accept-edits answers only for file changes that stay in the workspace;
    // deletes are ASK_FORCED above, and commands still ask.
    if (
      allowYolo &&
      mode === 'accept-edits' &&
      EDIT_TOOLS.includes(tool) &&
      found.pattern === 'workspace'
    )
      return false;
    return !this.store.matchesAny(thread, ruleToolFor(tool, args), [
      found.pattern,
      ...found.covered_by,
    ]);
  }
  remember(
    thread: string,
    tool: string,
    args: Record<string, unknown>,
    decision: string,
  ): boolean {
    const found = this.review(tool, args);
    const pattern =
      decision === 'prefix' && found.prefix.length
        ? 'prefix:' + JSON.stringify(found.prefix)
        : found.pattern;
    if (['always', 'prefix'].includes(decision)) {
      if (found.verdict !== 'ASK' || !pattern) return false;
      this.store.record(
        thread,
        'always',
        ruleToolFor(tool, args),
        pattern,
        found.scope,
      );
      return true;
    }
    this.store.record(
      thread,
      decision === 'approve' ? 'once' : 'reject',
      tool,
      pattern,
      found.scope,
    );
    return decision === 'approve';
  }
}
export function defaultPolicy(
  workspace: string,
  home = circleHome(),
  credentials = DEFAULT_CREDENTIAL_FILES,
  resolvePath?: (path: string) => string,
  allowedCommands: readonly string[] = [],
): ApprovalPolicy {
  return new ApprovalPolicy(
    new ApprovalStore(join(home, 'approvals')),
    workspace,
    credentials,
    resolvePath,
    allowedCommands,
  );
}

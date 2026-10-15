// The slash commands of the full-screen interface, as the Python releases had them (up to
// 0.5.0). SessionApp keeps /models, /login, /reload and /editor, which use its own state, and
// routes every command through runCommand.
import { randomUUID } from 'node:crypto';
import { networkSummary } from '../net.js';
import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { AgentRuntime } from '../runtime.js';
import { sessionSearchText } from '../session_search.js';
import {
  clearCredentials,
  defaultAuth,
  isFolderTrusted,
  loadSettings,
  saveSettingsChange,
  VARIABLE_NAME,
  settingsForRun,
  withConnectionLock,
  type CircleSettings,
} from '../settings.js';
import { removeSecret, saveSecret, secretNames } from '../secrets.js';
import type {
  Picker,
  PickerItem,
  PickerOptions,
} from '../ink/components/picker.js';
import { palette } from '../ink/theme.js';
import { stripAnsi } from '../ink/string_width.js';
import {
  isSessionMode,
  SESSION_MODES,
  type SessionMode,
} from '../approvals.js';
import { transcriptRows, type ScreenState } from './render.js';
import { elapsed, type Job } from '../jobs.js';
import { emptyUsage } from '../types.js';
import { EFFORT_LEVELS } from '../model.js';
import { exportKind, toHtml } from '../session_export.js';
import { discoverCustomCommands, expandCommandTemplate } from '../commands.js';
import { discoverSkills, loadSkillBody } from '../skills.js';
import { readPrompt } from '../system_prompt.js';
import { helpText, hotkeysText, variableCopy } from './slash_commands.js';
import type { ScreenSnapshot, UndoHistory } from './undo_history.js';
import {
  conversationTree,
  pathTo,
  rowText,
  treeRow,
  walk,
} from './conversation_tree.js';

export interface CommandHost {
  readonly runtime: AgentRuntime;
  /** False when the current session is still empty, so /new does not open another. */
  createSession?(): Promise<boolean | void>;
  openSession?(id: string): Promise<void>;
  deleteSession?(id: string): Promise<void>;
  selected?(): boolean;
  refreshConnection?(): void;
  sessionStatus?(id: string): string | undefined;
  importSession?(text: string): Promise<void>;
  readonly home: string;
  readonly workspace: string;
  settings: CircleSettings;
  readonly state: ScreenState;
  readonly undo: UndoHistory;
  // The local share copy /share wrote, which /unshare deletes.
  shared?: string;
  previousSession: string;
  notice(text: string): void;
  flash(text: string, ttl?: number): void;
  fail(error: unknown): void;
  repaint(): void;
  picker(
    title: string,
    items: PickerItem[],
    choose: (item: PickerItem) => Promise<void> | void,
    options?: PickerOptions,
  ): void;
  closePicker(): void;
  // The box's text, with the long pastes its placeholders stand for.
  setDraft(text: string, pastes?: Record<string, string>): void;
  // A finished job does not start a turn of its own until you send something.
  snoozeJobs(): void;
  // A message for the model, never read as a command.
  send(text: string): Promise<void>;
  command(name: string, args: string): Promise<void>;
  setTheme(mode: CircleSettings['theme']): void;
  trustWorkspace(): void;
  clipboard(text: string): Promise<boolean>;
  // While `list` is open it takes `rows()` again whenever a job starts, changes or ends.
  followJobs(list: Picker, rows: () => PickerItem[]): void;
  // The footer's ctx is unknown until the next answer (after /undo and /redo, as in 0.5.0).
  clearContextMeter(): void;
  // A value typed on a masked card, never in the input box; null when cancelled.
  secretValue(body: string): Promise<string | null>;
}
type Handler = (host: CommandHost, args: string) => Promise<void> | void;

// What may run while a turn is running; the rest wait for it to end. Read-only views,
// credentials and busy-aware toggles are in: they touch neither the session nor the model.
const BUSY_OK = new Set([
  'yolo',
  'mode',
  'approvals',
  'settings',
  'session',
  'themes',
  'mcp',
  'copy',
  'export',
  'share',
  'unshare',
  'thinking',
  'details',
  'name',
  'tree',
  'jobs',
  'logout',
  'new',
  'resume',
  'continue',
  'fork',
  'clone',
]);
// These only show a list when they have no argument. With one they change what the turn
// works with: `/skill <name>` writes into the conversation the turn is writing, and
// `/extensions reload` replaces the tools it may be calling. That form waits.
const BUSY_OK_BARE = new Set(['skill', 'extensions']);
const BUSY_WORDS: Record<string, string> = {
  models: 'Busy · switch models when the turn has finished',
  skill: 'Busy · load the skill when the turn has finished',
  extensions: 'Busy · reload extensions when the turn has finished',
  effort: 'Busy · change the thinking depth when the turn has finished',
  resume: 'Busy · switch sessions when the turn has finished',
};
const THEMES = ['auto', 'dark', 'light'] as const;
const DOUBLE_ESCAPE = ['tree', 'fork', 'none'] as const;
const DEPTH_NOTES: Record<string, string> = {
  minimal: '~1k tokens',
  low: '~2k',
  medium: '~8k',
  high: '~16k',
  xhigh: '~32k',
  max: 'as much as the model allows',
};

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
export function shortPath(path: string): string {
  const home = homedir();
  return path === home ||
    path.startsWith(home + '/') ||
    path.startsWith(home + '\\')
    ? '~' + path.slice(home.length)
    : path;
}
// The folder name. The session row is already dim, so the full path is not repeated.
// `https://gateway.example/v1` as `gateway.example/v1`: short enough for a list.
export function endpointName(url: string): string {
  return url
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/+$/, '');
}
export function pathTail(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) || path;
}
// `3m`, `5h`, `2d`: how long ago, for lists.
export function sessionAge(updated: number, now = Date.now()): string {
  const gone = Math.max(0, (now - updated) / 1000);
  for (const [unit, size] of [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
  ] as const)
    if (gone >= size) return `${Math.floor(gone / size)}${unit}`;
  return 'now';
}
function expandHome(path: string): string {
  return path === '~' || path.startsWith('~/') || path.startsWith('~\\')
    ? join(homedir(), path.slice(1))
    : path;
}
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
// The time in UTC as the Python releases wrote it into export names: 20261009-142501.
function stamp(now = new Date()): string {
  const two = (value: number): string => String(value).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${two(now.getUTCMonth() + 1)}${two(now.getUTCDate())}-` +
    `${two(now.getUTCHours())}${two(now.getUTCMinutes())}${two(now.getUTCSeconds())}`
  );
}
function sessionTitle(host: CommandHost): string {
  return host.runtime.store.get(host.runtime.session.id)?.title || 'new';
}

// Help, hotkeys and exit first; then custom commands, which may replace a built-in one and
// are queued like any message; then the turn check, then extension commands. Returns false
// for a built-in command that is not handled here.
export async function runCommand(
  host: CommandHost,
  name: string,
  args: string,
  exit: () => void,
): Promise<boolean> {
  if (name === 'exit') {
    exit();
    return true;
  }
  if (name === 'help' || name === 'hotkeys') {
    HANDLERS[name]!(host, args);
    return true;
  }
  const runtime = host.runtime;
  const custom = discoverCustomCommands(host.workspace, host.home).find(
    (command) => command.name === name,
  );
  if (custom) {
    const prompt = await expandCommandTemplate(
      custom.template,
      args,
      runtime.sandbox,
      new AbortController().signal,
    );
    await host.send(prompt);
    return true;
  }
  if (
    runtime.busy &&
    !BUSY_OK.has(name) &&
    !(BUSY_OK_BARE.has(name) && !args.trim())
  ) {
    host.flash(
      BUSY_WORDS[name] ?? 'Busy · wait for the current turn to finish',
    );
    return true;
  }
  const extension = runtime.extensions.commands().get(name);
  if (extension) {
    try {
      await extension.handler(args, {
        workspace: host.workspace,
        toast: (message) => host.notice(message),
        // A line on screen; the model does not see it.
        append: (message) => host.notice(message),
        sendUserMessage: (message) => {
          void host.send(message).catch((error) => host.fail(error));
        },
      });
    } catch (error) {
      host.fail(`/${name} failed: ${reason(error)}`);
    }
    return true;
  }
  const handler = HANDLERS[name];
  if (!handler) return false;
  try {
    await handler(host, args);
  } catch (error) {
    host.fail(`/${name} failed: ${reason(error)}`);
  }
  return true;
}

function help(host: CommandHost): void {
  const custom: [string, string][] = discoverCustomCommands(
    host.workspace,
    host.home,
  ).map((command) => [
    `${command.name} ${command.argument_hint}`.trim(),
    command.description,
  ]);
  for (const command of host.runtime.extensions.commands().values())
    custom.push([command.name, command.description]);
  host.notice(helpText(custom));
}

function plan(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const token = args.trim().toLowerCase();
  let want: boolean;
  if (['on', '1', 'true', 'enable'].includes(token)) want = true;
  else if (['off', '0', 'false', 'disable'].includes(token)) want = false;
  else if (!token) want = !runtime.harness.planMode;
  else {
    host.flash('Usage: /plan [on|off]');
    return;
  }
  if (want === runtime.harness.planMode) {
    host.flash(`Read-only is already ${want ? 'on' : 'off'}`);
    return;
  }
  runtime.setPlanMode(want);
  host.notice(
    want
      ? 'Read-only on · writes and shell are blocked, /plan.md is allowed'
      : 'Read-only off',
  );
}

function yolo(host: CommandHost, args: string): void {
  const enabled = !['off', '0', 'false', 'no'].includes(
    args.trim().toLowerCase(),
  );
  host.runtime.policy.setYolo(host.runtime.session.id, enabled);
  host.notice(
    enabled ? MODE_NOTICES.auto : 'Auto off · asking for each call again',
  );
}

const MODE_NOTICES: Record<SessionMode, string> = {
  manual: 'Manual · asking before each change and command',
  'accept-edits':
    'Accept edits · workspace file edits run without asking, commands and deletes still ask',
  plan: 'Read-only on · writes and shell are blocked, /plan.md is allowed',
  // Turning it on says what it lets through
  auto: 'Auto on · nothing asks: commands that delete, certificate warnings and uploads go ahead · use it where that is safe',
};
// The modes as the frame's corner word spells them.
const MODE_WORDS: Record<SessionMode, string> = {
  manual: 'manual',
  'accept-edits': 'accept edits',
  plan: 'read-only',
  auto: 'auto',
};
const MODE_META: Record<SessionMode, string> = {
  manual: 'asking before each change and command',
  'accept-edits': 'workspace edits run without asking',
  plan: 'writes and shell are blocked · plan.md is allowed',
  auto: 'nothing asks · deletes, certificate warnings and uploads included',
};

// /mode with no argument moves to the next mode; shift+tab does the same.
function mode(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const token = args
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  const current = runtime.mode;
  let want: SessionMode;
  if (!token)
    want =
      SESSION_MODES[
        (SESSION_MODES.indexOf(current) + 1) % SESSION_MODES.length
      ]!;
  else if (isSessionMode(token)) want = token;
  else if (token === 'yolo') want = 'auto';
  else {
    host.flash(`Usage: /mode [${SESSION_MODES.join('|')}]`);
    return;
  }
  if (want === current) {
    host.flash(`Mode is already ${want.replace('-', ' ')}`);
    return;
  }
  runtime.setMode(want);
  host.notice(MODE_NOTICES[want]);
}
// The mode list from /settings: enter uses a mode in this session, alt+d
// also writes default_mode, as /effort does for the thinking depth.
function modePicker(host: CommandHost): void {
  const now = host.runtime.mode;
  let saved: SessionMode | '' = '';
  try {
    saved = loadSettings(host.home).default_mode;
  } catch {
    /* An unreadable settings.json marks no default. */
  }
  const apply = (want: SessionMode, asDefault: boolean): void => {
    if (asDefault) {
      saveSettingsChange(host.home, (file) => {
        file.default_mode = want;
      });
      host.settings.default_mode = want;
    }
    if (!asDefault && host.runtime.mode === want) {
      host.flash(`Mode is already ${MODE_WORDS[want]}`);
      return;
    }
    host.runtime.setMode(want);
    host.notice(
      MODE_NOTICES[want] + (asDefault ? ' · saved as the default' : ''),
    );
  };
  host.picker(
    'Session mode',
    SESSION_MODES.map((mode) => ({
      key: mode,
      label: MODE_WORDS[mode],
      current: mode === now,
      meta: [MODE_META[mode], mode === saved ? 'default' : '']
        .filter(Boolean)
        .join(' · '),
    })),
    (item) => apply(item.key as SessionMode, false),
    {
      hint: 'enter uses it in this session · alt+d also makes it the default',
      focusKey: now,
      keys: {
        'alt+d': (item) => {
          if (!item) return;
          host.closePicker();
          apply(item.key as SessionMode, true);
        },
      },
    },
  );
}

function thinking(host: CommandHost, args: string): void {
  if (args.trim()) {
    effort(host, args);
    return;
  }
  host.state.showThinking = !host.state.showThinking;
  host.flash(`Thinking ${host.state.showThinking ? 'shown' : 'hidden'}`, 1200);
}

function details(host: CommandHost): void {
  host.state.showTools = !host.state.showTools;
  host.flash(
    `Tool output ${host.state.showTools ? 'expanded' : 'collapsed'}`,
    1200,
  );
}

function themes(host: CommandHost, args: string): void {
  let name = args.trim().toLowerCase();
  if (name === 'terminal') name = 'auto'; // the old name of auto
  const available = THEMES.join(', ');
  if (!name) {
    host.notice(`Theme: ${host.settings.theme} · available: ${available}`);
    return;
  }
  if (!(THEMES as readonly string[]).includes(name)) {
    host.fail(`Unknown theme '${name}' · available: ${available}`);
    return;
  }
  const theme = name as CircleSettings['theme'];
  host.settings.theme = theme;
  saveSettingsChange(host.home, (saved) => {
    saved.theme = theme;
  });
  host.setTheme(theme);
  host.notice(
    theme === 'auto'
      ? `Theme → auto (${palette().is_dark ? 'dark' : 'light'})`
      : `Theme → ${theme}`,
  );
}

function name(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const title = args.trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!title) {
    host.notice(`Session name: ${sessionTitle(host)}`);
    host.flash('/name <title> renames it', 4000);
    return;
  }
  runtime.store.rename(runtime.session.id, title, true);
  host.notice(`Session name → ${title}`);
}

function session(host: CommandHost): void {
  const runtime = host.runtime;
  const messages = runtime.harness.messages;
  const mine = messages.filter(
    (message) => message.role === 'user' && !message.internal,
  ).length;
  const answers = messages.filter((message) => message.role === 'assistant');
  const calls = answers.reduce(
    (sum, message) => sum + (message.tool_calls?.length ?? 0),
    0,
  );
  const results = messages.filter((message) => message.role === 'tool').length;
  const depth = runtime.thinkingLevel;
  const model =
    runtime.harness.model.model +
    ((EFFORT_LEVELS as readonly string[]).includes(depth) ? ` • ${depth}` : '');
  const kept = runtime.runOptions.no_session
    ? 'in memory only (--no-session)'
    : shortPath(join(host.home, 'circle.sqlite'));
  const used = host.state.usage;
  const cached =
    used.input_tokens && used.cache_read_tokens
      ? ` · ${Math.round((used.cache_read_tokens / used.input_tokens) * 100)}% cached`
      : '';
  const title = runtime.store.get(runtime.session.id)?.title;
  const rows = [
    `session  ${runtime.session.id}${title ? ` · ${title}` : ''}`,
    `folder   ${shortPath(host.workspace)}`,
    `model    ${model}`,
    `kept     ${kept}`,
    `messages ${messages.length} · ${mine} yours · ${answers.length} from the model · ` +
      `${calls} tool calls · ${results} results`,
    `tokens   ↑ ${used.input_tokens.toLocaleString('en-US')}${cached} · ` +
      `↓ ${used.output_tokens.toLocaleString('en-US')} in this run`,
    networkSummary(),
  ];
  if (host.shared) rows.push(`shared   ${host.shared}`);
  host.notice(rows.join('\n'));
}

const APPROVAL_WORDS: Record<string, string> = {
  once: 'allowed once',
  always: 'allowed for session',
  reject: 'rejected',
  revoke: 'revoked',
};
// The merged pattern list from disk (the user's file plus a trusted
// project's), live on the policy at once; /reload refreshes it too.
function refreshAllowedPatterns(host: CommandHost): void {
  const merged = settingsForRun(host.home, host.workspace).settings
    .allowed_commands;
  host.settings.allowed_commands = merged;
  host.runtime.policy.setAllowedCommands(merged);
}
// /approvals add <pattern>: a wildcard rule in the user's settings.json;
// matching commands run without asking, in every session.
function approvalsAdd(host: CommandHost, pattern: string): void {
  if (!pattern) {
    host.flash('Usage: /approvals add <pattern>');
    return;
  }
  if (host.settings.allowed_commands.includes(pattern)) {
    host.flash(`"${pattern}" is already allowed`);
    return;
  }
  saveSettingsChange(host.home, (file) => {
    file.allowed_commands = [...new Set([...file.allowed_commands, pattern])];
  });
  refreshAllowedPatterns(host);
  host.notice(`Allowed · commands matching "${pattern}" run without asking`);
}
// /approvals remove <pattern|number>: drops it from the user's settings; a
// trusted project's copy of the same pattern survives, and says so.
function approvalsRemove(host: CommandHost, target: string): void {
  if (!target) {
    host.flash('Usage: /approvals remove <pattern|number>');
    return;
  }
  const merged = host.settings.allowed_commands;
  let pattern = target;
  if (/^\d+$/.test(target)) {
    const found = merged[Number(target) - 1];
    if (!found) {
      host.flash(`No pattern number ${target}`);
      return;
    }
    pattern = found;
  } else if (!merged.includes(pattern)) {
    host.flash(`No pattern "${pattern}"`);
    return;
  }
  saveSettingsChange(host.home, (file) => {
    file.allowed_commands = file.allowed_commands.filter(
      (entry) => entry !== pattern,
    );
  });
  refreshAllowedPatterns(host);
  host.notice(
    host.settings.allowed_commands.includes(pattern)
      ? `Removed from your settings · the project still allows "${pattern}"`
      : `Removed · commands matching "${pattern}" ask again`,
  );
}
function approvals(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const store = runtime.policy.store;
  const thread = runtime.session.id;
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (!parts.length) {
    approvalsList(host);
    return;
  }
  if (parts[0] === 'add') {
    approvalsAdd(host, trimmed.slice(3).trim());
    return;
  }
  if (parts[0] === 'remove') {
    approvalsRemove(host, trimmed.slice(6).trim());
    return;
  }
  if (parts[0] === 'revoke') {
    if (parts.length !== 2 || !/^\d+$/.test(parts[1]!)) {
      host.flash('Usage: /approvals revoke <number>');
      return;
    }
    const rule = store.revoke(thread, Number(parts[1]) - 1);
    if (!rule) {
      host.flash(`No rule number ${parts[1]}`);
      return;
    }
    host.notice(`Revoked · ${rule.tool} · ${rule.label}`);
  }
  const rules = store.rules(thread);
  const lines = [
    rules.length
      ? 'Always-allow rules this session:'
      : 'No always-allow rules this session.',
    ...rules.map(
      (rule, index) =>
        `  ${index + 1}. ${rule.tool} · ${rule.label || rule.pattern}`,
    ),
  ];
  const patterns = host.settings.allowed_commands;
  if (patterns.length)
    lines.push(
      'Command patterns from settings:',
      ...patterns.map((pattern, index) => `  ${index + 1}. ${pattern}`),
    );
  const recent = store.log(thread).slice(-5);
  if (recent.length)
    lines.push(
      'Recent approvals:',
      ...recent.map(
        (entry) =>
          `  ${APPROVAL_WORDS[entry.kind] ?? entry.kind} · ${entry.tool}`,
      ),
    );
  if (rules.length) lines.push('Revoke one: /approvals revoke <number>');
  if (patterns.length)
    lines.push('Remove one: /approvals remove <pattern|number>');
  host.notice(lines.join('\n'));
}
// /approvals with nothing after it: the rules as a list; enter on one revokes it.
function approvalsList(host: CommandHost): void {
  const runtime = host.runtime;
  const store = runtime.policy.store;
  const thread = runtime.session.id;
  const rules = store.rules(thread);
  const recent = store.log(thread).slice(-5);
  const patterns = host.settings.allowed_commands;
  const items: PickerItem[] = rules.map((rule, index) => {
    const label = rule.label || rule.pattern;
    return {
      key: `revoke:${index}`,
      label: `${index + 1}. Revoke: ${label.slice(0, 40)}`,
      meta: `always · ${rule.tool}`,
    };
  });
  patterns.forEach((pattern, index) => {
    items.push({
      key: `pattern:${index}`,
      label: `${rules.length + index + 1}. Allow: ${pattern}`,
      meta: 'settings · execute',
    });
  });
  items.push({ key: 'close', label: `${items.length + 1}. Close` });
  const choose = (item: PickerItem): void => {
    if (item.key.startsWith('revoke:')) {
      const rule = store.revoke(thread, Number(item.key.slice(7)));
      if (rule)
        host.notice(
          `Revoked · ${rule.tool} · ${rule.label || rule.pattern} · the next call like it will ask again`,
        );
      return;
    }
    if (item.key.startsWith('pattern:')) {
      const pattern = patterns[Number(item.key.slice(8))];
      if (pattern) approvalsRemove(host, pattern);
    }
  };
  const move = (step: number) => (): void => {
    const picker = host.state.picker;
    const shown = picker?.matches().length ?? 0;
    if (picker && shown) picker.focus = (picker.focus + step + shown) % shown;
  };
  // As 0.5.0's approvals page: j k (and tab) move, a digit picks; nothing searches, so the
  // other keys go on to the input box.
  const keys: PickerOptions['keys'] = { j: move(1), k: move(-1), tab: move(1) };
  items.slice(0, 9).forEach((item, index) => {
    keys[String(index + 1)] = () => {
      host.closePicker();
      choose(item);
    };
  });
  host.picker('Session approvals', items, choose, {
    hint: [
      rules.length ? '' : 'No always-allow rules this session.',
      recent.length
        ? 'recent: ' +
          recent
            .map(
              (entry) =>
                `${APPROVAL_WORDS[entry.kind] ?? entry.kind} ${entry.tool}`,
            )
            .join(' · ')
        : '',
      '/approvals add <pattern> allows commands by pattern',
    ]
      .filter(Boolean)
      .join(' · '),
    keys,
    search: false,
  });
}

async function mcp(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  if (['reload', 'refresh', 'connect'].includes(args.trim().toLowerCase())) {
    if (runtime.busy) {
      host.flash('Busy · reload MCP after the current turn');
      return;
    }
    try {
      await runtime.reloadIntegrations();
    } catch (error) {
      host.fail(`MCP reload failed: ${reason(error)}`);
      return;
    }
    host.notice(`MCP reloaded · ${runtime.mcp.tools.length} tools`);
    return;
  }
  host.notice(runtime.mcp.describe());
}

async function extensions(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  const [verb = '', name = ''] = args.trim().split(/\s+/);
  if (['enable', 'disable'].includes(verb.toLowerCase())) {
    const enable = verb.toLowerCase() === 'enable';
    if (!name) {
      host.fail(`Usage: /extensions ${enable ? 'enable' : 'disable'} <name>`);
      return;
    }
    // The list is complete once integrations have loaded at start.
    await runtime.initialize().catch(() => {});
    if (!runtime.extensions.extensions.some((ext) => ext.name === name)) {
      host.fail(`No extension named ${name}`);
      return;
    }
    // Saved, so it stays on (or off) in the next session too.
    saveSettingsChange(host.home, (saved) => {
      saved.extensions[name] = { ...saved.extensions[name], enabled: enable };
    });
    host.settings.extensions[name] = {
      ...host.settings.extensions[name],
      enabled: enable,
    };
    try {
      await runtime.reloadIntegrations();
    } catch (error) {
      host.fail(`Extension reload failed: ${reason(error)}`);
      return;
    }
    host.notice(`${name} ${enable ? 'enabled' : 'disabled'}`);
    host.notice(runtime.extensions.describe());
    return;
  }
  if (['reload', 'refresh'].includes(args.trim().toLowerCase())) {
    try {
      await runtime.reloadIntegrations();
    } catch (error) {
      host.fail(`Extension reload failed: ${reason(error)}`);
      return;
    }
    host.notice(
      `Extensions reloaded · ${runtime.extensions.tools().length} tools`,
    );
  }
  host.notice(runtime.extensions.describe());
}

function trust(host: CommandHost): void {
  if (!isFolderTrusted(host.settings, host.workspace)) host.trustWorkspace();
  host.notice(`Trusted ${host.workspace}`);
}

function current(host: CommandHost): ScreenSnapshot {
  return host.undo.snapshot(
    host.runtime.session.id,
    host.runtime.harness.messages,
    host.state.notices,
    host.state.noticeAnchors,
  );
}
async function showSnapshot(
  host: CommandHost,
  snapshot: ScreenSnapshot,
): Promise<void> {
  const runtime = host.runtime;
  if (snapshot.sessionId !== runtime.session.id) {
    host.previousSession = runtime.session.id;
    await runtime.switchSession(snapshot.sessionId);
  }
  host.undo.restore(snapshot, runtime.harness.messages);
  host.state.notices = [...snapshot.notices];
  host.state.noticeAnchors = [...(snapshot.noticeAnchors ?? [])];
}
// The screen as it was before the last turn. Only the screen: the model still has the turn.
async function undo(host: CommandHost): Promise<void> {
  const previous = host.undo.undo(current(host));
  if (!previous) {
    host.flash('Nothing to undo');
    return;
  }
  await showSnapshot(host, previous);
  host.clearContextMeter();
  host.notice('Undid the last turn');
}
async function redo(host: CommandHost): Promise<void> {
  const next = host.undo.redo(current(host));
  if (!next) {
    host.flash('Nothing to redo');
    return;
  }
  await showSnapshot(host, next);
  host.clearContextMeter();
  host.notice('Redid the turn');
}

async function init(host: CommandHost, args: string): Promise<void> {
  let template: string;
  try {
    template = readPrompt('commands', 'initialize.md');
  } catch {
    host.fail('Missing prompts/commands/initialize.md');
    return;
  }
  await host.send(template.replaceAll('$ARGUMENTS', args.trim() || '(none)'));
}

// The conversation as Markdown, as it is on screen, under a few lines that say what it is.
function screenMarkdown(host: CommandHost): string {
  const runtime = host.runtime;
  const rows = transcriptRows(
    {
      ...host.state,
      messages: host.undo.visible(runtime.harness.messages),
      welcome: [],
      streaming: '',
      thinking: '',
    },
    process.stdout.columns || 80,
  ).map((row) => stripAnsi(row).trimEnd());
  return (
    [
      `# Circle session \`${runtime.session.id}\``,
      '',
      `- workspace: \`${host.workspace}\``,
      `- model: \`${runtime.harness.model.model}\``,
      `- title: \`${sessionTitle(host)}\``,
      `- exported: \`${stamp()}\``,
      '',
      '---',
      '',
      ...rows,
    ].join('\n') + '\n'
  );
}
function write(host: CommandHost, path: string, text: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return true;
  } catch (error) {
    host.fail(`Could not write ${path}: ${reason(error)}`);
    return false;
  }
}
// /export [html|jsonl|md|path]: Markdown of the screen by default, HTML to read in a
// browser, JSONL with every message for /import.
function exportSession(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const raw = args.trim();
  const kind = raw ? exportKind(raw) : 'md';
  const path =
    raw && raw.toLowerCase() !== kind
      ? resolve(host.workspace, expandHome(raw))
      : join(
          host.home,
          'exports',
          `circle-${runtime.session.id}-${stamp()}.${kind}`,
        );
  let text: string;
  if (kind === 'md') text = screenMarkdown(host);
  else {
    const messages = runtime.harness.messages;
    if (!messages.length) {
      host.flash('Nothing to export yet');
      return;
    }
    text =
      kind === 'html'
        ? toHtml(messages, {
            thread_id: runtime.session.id,
            title: runtime.store.get(runtime.session.id)?.title ?? '',
            workspace: host.workspace,
            model: runtime.harness.model.model,
          })
        : runtime.exportSession();
  }
  if (write(host, path, text)) host.notice(`Exported ${path}`);
}

async function share(host: CommandHost): Promise<void> {
  const path = join(host.home, 'shares', `${host.runtime.session.id}.md`);
  if (!write(host, path, screenMarkdown(host))) return;
  host.shared = path;
  const copied = await host.clipboard(path);
  host.notice(`Local share copy: ${path}${copied ? ' · path copied' : ''}`);
}

function unshare(host: CommandHost): void {
  let path = host.shared;
  if (!path) {
    const candidate = join(
      host.home,
      'shares',
      `${host.runtime.session.id}.md`,
    );
    path = isFile(candidate) ? candidate : undefined;
  }
  if (!path || !isFile(path)) {
    host.flash('No active share file');
    return;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    host.fail(`Delete failed: ${reason(error)}`);
    return;
  }
  host.shared = undefined;
  host.notice(`Unshared ${path}`);
}

async function importSession(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  const raw = args.trim();
  if (!raw) {
    host.flash('Usage: /import <file.jsonl or file.md>');
    return;
  }
  let path = resolve(host.workspace, expandHome(raw));
  if (!isFile(path)) {
    const saved = join(host.home, 'exports', raw);
    if (isFile(saved)) path = saved;
  }
  if (!isFile(path)) {
    host.fail(`No such file: ${raw}`);
    return;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    host.fail(
      error instanceof TypeError
        ? `${basename(path)} is not a text file`
        : `Could not read ${path}: ${reason(error)}`,
    );
    return;
  }
  const previous = runtime.session.id;
  if (extname(path).toLowerCase() === '.jsonl') {
    try {
      if (host.importSession) await host.importSession(text);
      else await runtime.importSession(text);
    } catch (error) {
      host.fail(
        `${basename(path)} is not a Circle JSONL export: ${reason(error)}`,
      );
      return;
    }
    host.previousSession = previous;
    host.undo.showAll();
    host.state.notices = [];
    host.state.noticeAnchors = [];
    host.notice(`Imported ${path} → ${host.runtime.session.id}`);
    return;
  }
  // Any other file: its text on screen, and the start of it for the model.
  host.undo.push(current(host));
  if (host.createSession) await host.createSession();
  else await runtime.newSession();
  const imported = host.runtime;
  host.previousSession = previous;
  imported.store.rename(
    imported.session.id,
    basename(path, extname(path)).slice(0, 60),
  );
  imported.store.append(imported.session.id, [
    {
      id: randomUUID(),
      role: 'user',
      content:
        'Imported prior transcript for continuity.\n' + text.slice(0, 8000),
      display: text,
    },
  ]);
  host.undo.showAll();
  host.state.notices = [];
  host.state.noticeAnchors = [];
  host.notice(`Imported ${path}`);
}

async function copy(host: CommandHost): Promise<void> {
  let text = (
    host.undo
      .visible(host.runtime.harness.messages)
      .filter((message) => message.role === 'assistant' && message.content)
      .at(-1)?.content ?? ''
  ).trim();
  // no answer yet: the last line of the transcript that is not yours, as 0.5.0 did
  if (!text)
    text =
      transcriptRows(
        { ...host.state, welcome: [] },
        process.stdout.columns || 80,
      )
        .map((row) => stripAnsi(row).trim())
        .findLast(
          (row) => row && !row.startsWith('>') && !row.startsWith('›'),
        ) ?? '';
  if (!text) {
    host.flash('No assistant message to copy');
    return;
  }
  if (await host.clipboard(text)) {
    host.flash(`Copied ${Array.from(text).length} chars`);
    return;
  }
  const path = join(host.home, 'exports', 'last-copy.txt');
  if (write(host, path, text + '\n')) {
    host.flash('Saved to file');
    host.notice(`Saved to file · ${path}`);
  }
}

// A list of the settings, as pi's /settings: enter changes the marked one, and the change is
// saved at once, that key alone. Rows that open their own list say so.
function settingsList(host: CommandHost, focusKey?: string): void {
  const runtime = host.runtime;
  const following = <T extends string>(options: readonly T[], value: T): T =>
    options[(options.indexOf(value) + 1) % options.length] ?? options[0]!;
  const auth = host.settings.auth;
  const items: PickerItem[] = [
    { key: 'theme', label: 'theme', meta: host.settings.theme },
    {
      key: 'thinking',
      label: 'show thinking',
      meta: host.state.showThinking ? 'on' : 'off',
    },
    {
      key: 'double_escape',
      label: 'esc esc opens',
      meta: host.settings.double_escape,
    },
    {
      key: 'model',
      label: 'model',
      meta: `${runtime.harness.model.model} · /models`,
    },
    {
      key: 'depth',
      label: 'thinking depth',
      meta: `${runtime.thinkingLevel || 'default'} · /effort`,
    },
    {
      key: 'default_mode',
      label: 'default mode',
      meta: MODE_WORDS[host.settings.default_mode || 'manual'],
    },
    {
      key: 'endpoint',
      label: 'endpoint',
      meta: `${auth.protocol} · ${auth.base_url || '—'}`,
    },
    {
      key: 'trusted',
      label: 'trusted folders',
      meta: String(host.settings.trusted_folders.length),
    },
    {
      key: 'mcp',
      label: 'mcp servers',
      meta: `${host.settings.mcp_servers.length} · /mcp`,
    },
    { key: 'home', label: 'data folder', meta: shortPath(host.home) },
  ];
  const change = async (item: PickerItem): Promise<void> => {
    const opens: Record<string, [string, string]> = {
      model: ['models', ''],
      depth: ['effort', ''],
      mcp: ['mcp', ''],
      endpoint: ['login', ''],
    };
    if (opens[item.key]) {
      await host.command(...opens[item.key]!);
      return;
    }
    if (item.key === 'default_mode') {
      modePicker(host);
      return;
    }
    if (item.key === 'theme')
      themes(host, following(THEMES, host.settings.theme));
    else if (item.key === 'thinking') {
      const show = !host.state.showThinking;
      host.state.showThinking = show;
      host.settings.hide_thinking = !show;
      saveSettingsChange(host.home, (saved) => {
        saved.hide_thinking = !show;
      });
    } else if (item.key === 'double_escape') {
      const next = following(DOUBLE_ESCAPE, host.settings.double_escape);
      host.settings.double_escape = next;
      saveSettingsChange(host.home, (saved) => {
        saved.double_escape = next;
      });
    }
    // The list stays open on the row, showing the new value.
    settingsList(host, item.key);
  };
  host.picker('Settings', items, change, {
    hint: 'enter changes it, saved at once · esc closes',
    focusKey,
  });
}

function setThinking(host: CommandHost, level: string, saved = false): void {
  host.runtime.setThinkingLevel(level);
  const shown = host.runtime.thinkingLevel || level;
  host.flash(
    `Thinking depth → ${shown}` +
      (shown === level
        ? ''
        : ` (the closest this model supports to ${level})`) +
      (saved ? ' · saved as the default' : ''),
    3000,
  );
}
// alt+t: the next depth, for this session.
export function cycleThinking(host: CommandHost): void {
  if (host.runtime.busy) {
    host.flash(BUSY_WORDS.effort!);
    return;
  }
  const levels = EFFORT_LEVELS as readonly string[];
  const at = levels.indexOf(host.runtime.thinkingLevel);
  setThinking(host, levels[(at + 1) % levels.length]!);
}
function effort(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const level = args.trim().toLowerCase();
  if (level) {
    if (!(EFFORT_LEVELS as readonly string[]).includes(level)) {
      host.fail(
        `Unknown depth '${level}' · choose ${EFFORT_LEVELS.join(', ')}`,
      );
      return;
    }
    setThinking(host, level);
    host.notice(`Thinking depth → ${runtime.thinkingLevel || level}`);
    return;
  }
  const now = runtime.thinkingLevel;
  let saved = '';
  try {
    saved = loadSettings(host.home).default_thinking;
  } catch {
    /* An unreadable settings.json marks no default. */
  }
  host.picker(
    'Thinking depth',
    EFFORT_LEVELS.map((level) => ({
      key: level,
      label: level,
      current: level === now,
      meta: [DEPTH_NOTES[level] ?? '', level === saved ? 'default' : '']
        .filter(Boolean)
        .join(' · '),
    })),
    (item) => setThinking(host, item.key),
    {
      hint: 'enter uses it in this session · alt+d also makes it the default · alt+t cycles',
      focusKey: now || undefined,
      keys: {
        'alt+d': (item) => {
          if (!item) return;
          host.closePicker();
          saveSettingsChange(host.home, (file) => {
            file.default_thinking = item.key;
          });
          host.settings.default_thinking = item.key;
          setThinking(host, item.key, true);
        },
      },
    },
  );
}

function logout(host: CommandHost): void {
  withConnectionLock(host.home, () => {
    clearCredentials(host.home);
    host.settings.auth = defaultAuth();
    host.settings.initialized = false;
    saveSettingsChange(host.home, (saved) => {
      saved.auth = defaultAuth();
      saved.initialized = false;
    });
  });
  host.refreshConnection?.();
  host.notice(
    'Signed out · credentials cleared · /login or `circle --init` before the next turn',
  );
}

// `done`, `failed · exit 1`, `failed · timeout`, `stopped`.
function outcome(job: Job): string {
  if (job.status === 'done') return 'done';
  if (job.status === 'failed')
    return job.reason && job.reason !== 'exit'
      ? `failed · ${job.reason}`
      : job.exitCode !== undefined
        ? `failed · exit ${job.exitCode}`
        : 'failed';
  return job.status || 'ended';
}
// /jobs: every background job, running ones first; enter opens one's page, ctrl+k stops a
// running one (after asking) or removes one that has ended.
function jobs(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  if (args.trim()) {
    const job = runtime.jobs.get(args.trim());
    if (!job) {
      host.fail(`No job ${args.trim()} · /jobs lists them`);
      return;
    }
    host.state.jobDetail = job;
    host.repaint();
    return;
  }
  const rows = (): PickerItem[] => {
    const all = runtime.jobs.list();
    const running = all.filter((job) => job.status === 'running');
    const ended = all.filter((job) => job.status !== 'running').reverse();
    return [...running, ...ended].map((job) => ({
      key: job.id,
      label: `${job.id} ${job.title}`,
      meta:
        (job.status === 'running'
          ? job.detail === 'waiting for you'
            ? 'waiting for you'
            : `running · ${elapsed(job)}`
          : `${outcome(job)} · ${elapsed(job)}`) +
        (job.sessionId !== runtime.session.id ? ' · other session' : ''),
      search: `${job.kind} ${job.source ?? ''}`,
    }));
  };
  // A running job is stopped after a question asked in the list; esc keeps it running.
  const stop = (item: PickerItem | undefined): void => {
    const job = item ? runtime.jobs.get(item.key) : undefined;
    const list = host.state.picker;
    if (!job || !list) return;
    if (job.status !== 'running') {
      runtime.jobs.remove(job.id);
      list.setItems(rows());
      return;
    }
    list.confirm(`Stop ${job.id} ${job.title.slice(0, 40)}?`, async () => {
      await runtime.jobs.stop(job.id, 'user');
      list.setItems(rows());
    });
  };
  host.picker(
    'Background jobs',
    rows(),
    (item) => {
      host.state.jobDetail = runtime.jobs.get(item.key);
    },
    {
      hint: 'enter opens · ctrl+k stops',
      empty: 'No jobs',
      keys: { 'ctrl+k': stop },
    },
  );
  if (host.state.picker) host.followJobs(host.state.picker, rows);
}

function skill(host: CommandHost, args: string): void {
  const runtime = host.runtime;
  const skills = discoverSkills(host.workspace, host.home);
  const token = args.trim();
  if (!token) {
    host.notice(
      skills.length
        ? [
            'Skills:',
            '',
            ...skills.map(
              (skill) =>
                `  ${skill.name.padEnd(20)} ${skill.description.slice(0, 80)}${skill.source_label ? ` (${skill.source_label})` : ''}`,
            ),
            '',
            'Load with /skill <name>',
          ].join('\n')
        : 'No skills found. Install with `npx skills add … -a amp` (writes .agents/skills), or add SKILL.md under ~/.circle/skills / .agent/skills.',
    );
    return;
  }
  const name = token.split(/\s/, 1)[0]!;
  const skillArgs = token.slice(name.length).trim();
  let body: string;
  try {
    body = loadSkillBody(name, skills);
  } catch (error) {
    host.fail(`Error: ${reason(error)}`);
    return;
  }
  // Into the conversation without a turn: the model reads it with your next message.
  runtime.store.append(runtime.session.id, [
    {
      id: randomUUID(),
      role: 'user',
      internal: 'skill',
      content:
        `[Circle system] Skill \`${name}\` loaded via /skill.` +
        (skillArgs ? `\nUser arguments: ${skillArgs}\n` : '\n') +
        `Follow it for subsequent requests until the user says otherwise.\n\n${body}`,
    },
  ]);
  host.notice(
    `Loaded skill \`${name}\`` + (skillArgs ? ` args='${skillArgs}'` : ''),
  );
}

async function compact(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  if (runtime.harness.messages.length < 2) {
    host.flash('Nothing to compact yet');
    return;
  }
  let result: string;
  try {
    result = await runtime.compact(args.trim());
  } catch (error) {
    host.fail(`Compact failed: ${reason(error)}`);
    return;
  }
  if (result === 'Nothing to compact yet')
    host.flash(
      'Nothing to compact yet · the conversation fits in the context',
      4000,
    );
  host.repaint();
}

// The screen is drawn again from the saved messages of the session now open.
function redrawn(host: CommandHost, note: string): void {
  host.undo.showAll();
  host.state.notices = [];
  host.state.noticeAnchors = [];
  host.notice(note);
}
async function newSession(host: CommandHost): Promise<void> {
  const runtime = host.runtime;
  const previous = runtime.session.id;
  const created = host.createSession
    ? await host.createSession()
    : (await runtime.newSession(), true);
  if (created === false) return;
  host.previousSession = previous;
  host.state.usage = emptyUsage();
  redrawn(host, `New session ${host.runtime.session.id}`);
}
async function continueSession(host: CommandHost): Promise<void> {
  const runtime = host.runtime;
  const previous = host.previousSession;
  const current = runtime.session.id;
  const empty = !runtime.harness.messages.some(
    (message) => !message.internal || message.internal === 'job_notice',
  );
  // After a restart nothing is remembered in this process. An empty home opens
  // the latest saved session in this folder instead of flashing and staying put.
  const resumed = !previous || previous === current;
  const target = !resumed
    ? previous
    : empty
      ? runtime.store
          .list(host.workspace)
          .find((session) => session.id !== current)?.id
      : undefined;
  if (!target) {
    host.flash('No previous session');
    return;
  }
  if (host.openSession) await host.openSession(target);
  else await runtime.switchSession(target);
  host.previousSession = current;
  const title = (host.runtime.store.get(target)?.title || target).slice(0, 40);
  host.notice(
    resumed ? `Resumed ${target} · ${title}` : `Continued ${target} · ${title}`,
  );
}
// Open a saved session. One from another folder is copied into this one; the original stays.
async function openSession(host: CommandHost, id: string): Promise<void> {
  const runtime = host.runtime;
  const source = runtime.store.get(id);
  const previous = runtime.session.id;
  if (host.openSession) await host.openSession(id);
  else await runtime.switchSession(id);
  host.previousSession = previous;
  host.notice(
    host.runtime.session.id === id
      ? `Resumed ${id} · ${(source?.title || id).slice(0, 40)}`
      : `Forked ${id} from ${shortPath(source?.workspace ?? '')} → ${host.runtime.session.id}`,
  );
}
// /resume [n|id]: a list of this folder's sessions, or one by its number there or the end of
// its id.
async function resume(host: CommandHost, args: string): Promise<void> {
  const runtime = host.runtime;
  const target = args.trim();
  if (!target) {
    sessionList(host, false);
    return;
  }
  const sessions = runtime.store.list(host.workspace);
  if (!sessions.length) {
    host.flash('No earlier session in this folder');
    return;
  }
  const number = /^\d+$/.test(target) ? Number(target) : 0;
  const chosen =
    number >= 1 && number <= sessions.length
      ? sessions[number - 1]
      : sessions.find(
          (session) => session.id === target || session.id.endsWith(target),
        );
  if (!chosen) {
    host.fail(`No session '${target}' in this folder · /resume lists them`);
    return;
  }
  if (chosen.id === runtime.session.id) {
    host.flash('Already in that session');
    return;
  }
  await openSession(host, chosen.id);
}
// Type to search titles and message text; tab shows every folder's sessions, ctrl+r renames
// one (the old name is selected), ctrl+k deletes one. ctrl+d stays the exit key.
function sessionList(
  host: CommandHost,
  everywhere: boolean,
  query = '',
  focusKey?: string,
): void {
  const runtime = host.runtime;
  const again = (focus?: string): void =>
    sessionList(host, everywhere, host.state.picker?.query ?? query, focus);
  const here = runtime.store.get(runtime.session.id)?.workspace;
  const sessions = everywhere
    ? runtime.store.list()
    : runtime.store.list(host.workspace);
  host.picker(
    everywhere ? 'Sessions · every folder' : 'Sessions · this folder',
    sessions.map((session) => ({
      key: session.id,
      label: session.title || '(untitled)',
      meta:
        sessionAge(session.updated) +
        (host.sessionStatus?.(session.id)
          ? ` · ${host.sessionStatus(session.id)}`
          : '') +
        (everywhere || session.workspace !== here
          ? ` · ${pathTail(session.workspace)}`
          : ''),
      search: sessionSearchText(session, runtime.store.messages(session.id)),
      current: session.id === runtime.session.id,
    })),
    async (item) => {
      if (item.key !== runtime.session.id) await openSession(host, item.key);
    },
    {
      hint: everywhere
        ? 'enter opens · tab this folder · ctrl+r renames · ctrl+k deletes'
        : 'enter opens · tab every folder · ctrl+r renames · ctrl+k deletes',
      empty: (_typed, total) =>
        total === 0
          ? everywhere
            ? 'No sessions saved'
            : 'No sessions in this folder'
          : 'No matches',
      focusKey: focusKey ?? runtime.session.id,
      keys: {
        tab: () => sessionList(host, !everywhere, host.state.picker?.query),
        // Both ask in the list; esc there leaves the session as it was.
        'ctrl+r': (item) => {
          if (!item) return;
          host.state.picker?.ask(
            'Rename',
            item.label === '(untitled)' ? '' : item.label,
            (text) => {
              const title = text.trim().replace(/\s+/g, ' ').slice(0, 80);
              if (!title) return;
              runtime.store.rename(item.key, title, true);
              again(item.key);
            },
            {
              replace: true,
              keys: 'typing replaces the name · enter saves · esc cancels',
            },
          );
        },
        'ctrl+k': (item) => {
          if (!item) return;
          const label = item.label.slice(0, 40);
          host.state.picker?.confirm(
            `${host.sessionStatus?.(item.key) ? 'Stop and delete' : 'Delete'} “${label}” and its messages?`,
            async () => {
              if (host.deleteSession) await host.deleteSession(item.key);
              else runtime.store.delete(item.key);
              if (host.previousSession === item.key) host.previousSession = '';
              if (host.selected?.() !== false) again();
              host.flash(`Deleted ${label}`);
            },
          );
        },
      },
    },
  );
  if (query && host.state.picker) host.state.picker.query = query;
}
// /tree goes back to a message of this session; /fork starts a new session from before one of
// your messages. Your message comes back to the box to change and send again.
async function tree(
  host: CommandHost,
  args: string,
  fork: boolean,
): Promise<void> {
  const runtime = host.runtime;
  host.snoozeJobs();
  const branches = conversationTree(runtime.store, runtime.session.id);
  const order = walk(branches);
  const go = async (key: string, named = false): Promise<void> => {
    const checkpoint = runtime.store.checkpoint(key)!;
    if (!checkpoint.message) throw new Error('selected entry has no message');
    const user = checkpoint.message.role === 'user';
    if (!fork && key === branches.leaf && !user) {
      host.flash('Already here');
      return;
    }
    if (
      !fork &&
      (runtime.busy ||
        runtime.jobs.list().some((job) => job.status === 'running'))
    )
      throw new Error(
        'change this branch after the current turn and background jobs finish',
      );
    const point = user ? checkpoint.parent : checkpoint.id;
    if (fork) {
      const session = runtime.store.fork(
        runtime.session.id,
        host.workspace,
        point,
      );
      const previous = runtime.session.id;
      if (host.openSession) await host.openSession(session.id);
      else await runtime.switchSession(session.id);
      host.previousSession = previous;
    } else runtime.store.select(runtime.session.id, point);
    if (user)
      host.setDraft(
        checkpoint.message.display || checkpoint.message.content,
        checkpoint.message.pastes,
      );
    redrawn(
      host,
      !fork
        ? `Back ${user ? 'before your message' : 'after that answer'} · ` +
            'your next message starts a new branch · /tree shows them all'
        : named
          ? `Forked from ${key} → ${host.runtime.session.id}`
          : `Forked → ${host.runtime.session.id} · your message is back in the box`,
    );
  };
  // /fork <id>: straight from that message.
  const target = args.trim();
  if (
    fork &&
    target &&
    runtime.store
      .tree(runtime.session.id)
      .some(
        (checkpoint) =>
          checkpoint.id === target && !checkpoint.message.internal,
      )
  ) {
    await go(target, true);
    return;
  }
  // Yours in the order /tree shows them, the last one marked: as 0.5.0's fork list.
  const yours = order
    .map(([key]) => branches.entries.get(key)!)
    .filter((entry) => entry.role === 'user');
  if (fork) {
    if (!yours.length) {
      host.flash('No message to fork from yet');
      return;
    }
    host.picker(
      'Fork from a message',
      yours.map((entry, index) => ({
        key: entry.key,
        label: rowText(entry.text),
        meta: `${index + 1}/${yours.length}`,
      })),
      (item) => go(item.key),
      {
        hint: 'a new session with everything before it; the message comes back to edit',
        focusKey: yours.at(-1)!.key,
      },
    );
    if (args.trim() && host.state.picker) host.state.picker.query = args.trim();
    return;
  }
  if (!order.length) {
    host.flash('Nothing in this session yet');
    return;
  }
  let mine = false;
  let marks = runtime.store.labels(runtime.session.id);
  // Every branch: indented where it splits, `here` at the point the conversation is at and
  // `·` on the way to it.
  const rows = (): PickerItem[] => {
    const onPath = new Set(pathTo(branches, branches.leaf));
    return order
      .filter(([key]) => !mine || branches.entries.get(key)!.role === 'user')
      .map(([key, depth]) => {
        const mark = marks[branches.entries.get(key)!.message.id];
        return {
          key,
          label: treeRow(branches, key, depth, mark),
          meta: key === branches.leaf ? 'here' : onPath.has(key) ? '·' : '',
          search: mark ?? '',
          current: key === branches.leaf,
        };
      });
  };
  host.picker('Session tree', rows(), (item) => go(item.key), {
    hint: 'enter goes back there · L labels · ctrl+u only your messages',
    focusKey: branches.leaf,
    keys: {
      'ctrl+u': () => {
        mine = !mine;
        host.state.picker?.setItems(rows());
      },
      // Asked in the list: enter sets it (empty removes it), esc leaves it as it was.
      L: (item) => {
        const message = item && branches.entries.get(item.key)?.message;
        const list = host.state.picker;
        if (!message || !list) return;
        list.ask(
          'Label (empty removes it)',
          marks[message.id] ?? '',
          (text) => {
            runtime.store.setLabel(runtime.session.id, message.id, text);
            marks = runtime.store.labels(runtime.session.id);
            list.setItems(rows());
          },
        );
      },
    },
  });
  if (args.trim() && host.state.picker) host.state.picker.query = args.trim();
}
// Variables as Windows writes them: `NAME=value` sets one, `NAME=` removes it, and the model
// writes %NAME% in a tool's arguments. A secret is a variable whose value it never sees.
const MAX_VARIABLE = 2000;
const assignment = (text: string) => {
  const match = text.match(/^([^=\s]+)\s*(?:=(.*))?$/s);
  return match ? { name: match[1]!.toUpperCase(), value: match[2] } : undefined;
};
const NAME_RULE =
  'a name is capital letters, digits and _, starting with a letter';
function variablesList(host: CommandHost): void {
  const saved = host.settings.variables;
  host.picker(
    'Variables',
    [
      ...Object.entries(saved).map(([name, value]) => ({
        key: 'variable:' + name,
        label: `${name}=${value}`,
        meta: 'variable',
      })),
      ...secretNames(host.home).map((name) => ({
        key: 'secret:' + name,
        label: `${name}=••••••••`,
        meta: 'secret',
      })),
      {
        key: 'new-variable',
        label: 'new variable',
        meta: '/variables NAME=value',
      },
      { key: 'new-secret', label: 'new secret', meta: '/secrets NAME' },
    ],
    (item) => {
      const [kind, name = ''] = item.key.split(':');
      host.setDraft(
        kind === 'variable'
          ? `/variables ${name}=${saved[name] ?? ''}`
          : kind === 'secret'
            ? `/secrets ${name}`
            : item.key === 'new-variable'
              ? '/variables '
              : '/secrets ',
      );
    },
    {
      hint: 'enter puts the command in the input box · NAME= removes',
      empty: 'no variables',
    },
  );
}
/** The model's next request is told the variables and the secrets' names anew. */
function variablesChanged(host: CommandHost, next: Record<string, string>) {
  host.settings.variables = next;
  host.runtime.options.settings.variables = next;
  saveSettingsChange(host.home, (saved) => {
    saved.variables = next;
  });
  host.runtime.refreshPrompt();
}
function variables(host: CommandHost, args: string): void {
  const text = args.trim();
  if (!text) return variablesList(host);
  const parsed = assignment(text);
  if (!parsed || !VARIABLE_NAME.test(parsed.name)) {
    host.fail(`Usage: /variables NAME=value · ${NAME_RULE}`);
    return;
  }
  const { name, value } = parsed;
  const saved = host.settings.variables;
  if (value === undefined) {
    host.notice(
      name in saved
        ? `${name}=${saved[name]}`
        : secretNames(host.home).includes(name)
          ? `${name} is a secret · /secrets ${name} sets it`
          : `No variable ${name}`,
    );
    return;
  }
  if (secretNames(host.home).includes(name)) {
    host.fail(`${name} is a secret · /secrets ${name} sets it`);
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (!(name in saved)) {
      host.flash(`No variable ${name}`);
      return;
    }
    const { [name]: _removed, ...rest } = saved;
    variablesChanged(host, rest);
    host.notice(`Removed variable ${name}`);
    return;
  }
  if (trimmed.length > MAX_VARIABLE) {
    host.fail('A variable is at most 2,000 characters');
    return;
  }
  variablesChanged(host, { ...saved, [name]: trimmed });
  host.notice(`${name}=${trimmed} · ${variableCopy().saved(name)}`);
}
async function secrets(host: CommandHost, args: string): Promise<void> {
  const text = args.trim();
  if (!text) return variablesList(host);
  const parsed = assignment(text);
  if (!parsed || !VARIABLE_NAME.test(parsed.name)) {
    host.fail(`Usage: /secrets NAME · ${NAME_RULE}`);
    return;
  }
  const { name, value } = parsed;
  if (value !== undefined) {
    if (value.trim()) {
      // The value would be on the screen and in the input box's history
      host.fail(
        `Type a secret's value on its masked card: /secrets ${name}, then enter`,
      );
      return;
    }
    if (!removeSecret(host.home, name)) host.flash(`No secret ${name}`);
    else {
      host.runtime.refreshPrompt();
      host.notice(`Removed secret ${name}`);
    }
    return;
  }
  if (name in host.settings.variables) {
    host.fail(`${name} is a variable · /variables ${name}= removes it first`);
    return;
  }
  const typed = await host.secretValue(
    `${name}\n${variableCopy().secretCard(name)}`,
  );
  if (!typed) {
    host.flash('No secret saved');
    return;
  }
  saveSecret(host.home, name, typed);
  host.runtime.refreshPrompt();
  host.notice(`Saved secret ${name} · ${variableCopy().saved(name)}`);
}
async function clone(host: CommandHost): Promise<void> {
  const runtime = host.runtime;
  const previous = runtime.session.id;
  const session = runtime.store.fork(runtime.session.id, host.workspace);
  if (host.openSession) await host.openSession(session.id);
  else await runtime.switchSession(session.id);
  host.previousSession = previous;
  redrawn(host, `Cloned this branch → ${session.id}`);
}

const HANDLERS: Record<string, Handler> = {
  new: newSession,
  continue: continueSession,
  resume,
  tree: (host, args) => tree(host, args, false),
  fork: (host, args) => tree(host, args, true),
  clone,
  help,
  hotkeys: (host) => host.notice(hotkeysText()),
  plan,
  yolo,
  mode,
  thinking,
  details,
  themes,
  name,
  session,
  approvals,
  mcp,
  extensions,
  trust,
  undo,
  redo,
  init,
  export: exportSession,
  share,
  unshare,
  import: importSession,
  copy,
  settings: (host) => settingsList(host),
  variables,
  secrets,
  effort,
  logout,
  jobs,
  skill,
  compact,
};

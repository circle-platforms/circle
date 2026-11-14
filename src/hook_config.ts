// Where hooks are written and what a definition says. Hooks live under a `hooks` key: in your settings.json, in a
// project's .circle/settings.json and .circle/settings.local.json, in an installed pack's hooks/hooks.json, and in a
// skill's SKILL.md frontmatter. Each event holds matcher groups, and each group the handlers that run when it matches.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { discoverSkills } from './skills.js';
import { isRecord } from './settings.js';
import { SKILL_DATA_FOLDER } from './local_skills.js';

/** The events Circle runs hooks at. */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'PreCompact',
  'PostCompact',
  'Notification',
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events other agents define that have nothing to fire on in Circle: a hook for one loads nowhere and says so. */
const NOT_RUN_HERE = new Set([
  'Setup',
  'InstructionsLoaded',
  'UserPromptExpansion',
  'MessageDisplay',
  'PermissionDenied',
  'PostToolBatch',
  'TaskCreated',
  'TaskCompleted',
  'StopFailure',
  'TeammateIdle',
  'ConfigChange',
  'CwdChanged',
  'DirectoryAdded',
  'FileChanged',
  'WorktreeCreate',
  'WorktreeRemove',
  'PreModelSwitch',
  'PostModelSwitch',
  'Elicitation',
  'ElicitationResult',
]);

/** Events about a tool call: the matcher names the tool, and only these read `if`. */
export const TOOL_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
]);
/** Events without a matcher: every group runs, whatever its matcher says. */
export const NO_MATCHER = new Set<HookEvent>(['UserPromptSubmit', 'Stop']);

/** Where the configuration writes hooks: your settings, the project's, its local file, a pack and a skill. */
export type ConfiguredHookSource =
  'user' | 'project' | 'local' | 'pack' | 'skill';
/** And a subagent definition, whose hooks run only for that subagent, while it runs. */
export type HookSource = ConfiguredHookSource | 'agent';

export type HookMatcher =
  | { kind: 'all' }
  | { kind: 'names'; names: string[] }
  | { kind: 'regex'; re: RegExp };

/** `if`: one rule, a tool's name with what its call must match in parentheses. */
export interface HookCondition {
  text: string;
  tool: string;
  pattern?: string;
}

export interface HookDefinition {
  /** Stable for one read of the configuration. */
  id: string;
  event: HookEvent;
  matcher: HookMatcher;
  /** As written: empty for a group that matches everything. */
  matcherText: string;
  type: 'command';
  /** The command for this platform: its `command_<os>` when it has one. */
  command: string;
  /** Exec form: `command` is the program, run without a shell. */
  args?: string[];
  shell?: 'bash' | 'powershell';
  /** Seconds as written. Unset takes the event's default. */
  timeout?: number;
  condition?: HookCondition;
  statusMessage?: string;
  /** A skill's hook only: it is removed after its first successful run. */
  once: boolean;
  async: boolean;
  onFailure?: 'continue' | 'block';
  /** What notices and lists call it: its `name`, else its command. */
  name: string;
  source: HookSource;
  /** `user`, `project`, `local`, `pack:<name>`, `skill:<name>` or `agent:<name>`. */
  sourceLabel: string;
  /** The file it was read from. */
  file: string;
  /** A skill's hook: it runs only once this session has loaded that skill. */
  skill?: string;
  /** An installed pack's hook. Its files are checked before the first run. */
  pack?: string;
  /** The folder of the skill or pack it ships with: `CIRCLE_SKILL_DIR`. */
  skillDir?: string;
  /** A pack's folder of its own that its updates keep: `CIRCLE_SKILL_DATA`. */
  skillData?: string;
  /** PostToolUse only: the hook also gets a PNG of the page the conversation's browser shows, as a file. */
  screenshot?: boolean;
  /**
   * Moved from the format before this one: the hook keeps the input fields it was written for, the shell it ran in
   * (cmd.exe on Windows), its plain-text and failure meanings, and a Stop hook its limit of blocks (`loopLimit`).
   */
  legacy?: boolean;
  loopLimit?: number;
}

/** A hook the configuration defines: what `/hooks` and the settings list. */
export type ConfiguredHook = HookDefinition & { source: ConfiguredHookSource };

export interface HookLoadError {
  file: string;
  message: string;
}

export interface LoadedHooks {
  hooks: HookDefinition[];
  errors: HookLoadError[];
  /** The project has hooks, and this folder is not trusted: they do not run. */
  untrusted: boolean;
  /** `disableAllHooks` is on. */
  disabled: boolean;
  /** What moving hooks files of the format before this one did, said once. */
  notes: string[];
}

/** Commands are text a shell or a program gets: a NUL cannot be passed, and a page of text is not a command. */
const MAX_COMMAND = 4000;
/** At most this many hooks from one file. */
const MAX_HOOKS = 1024;

/**
 * A matcher as written. `*`, empty or none matches everything. Only letters, digits, `_`, `-`, spaces, commas and
 * `|` is a list of exact names. Anything else is a regular expression, tested anywhere in the value.
 */
export function compileMatcher(text: unknown): HookMatcher | string {
  if (text === undefined || text === null) return { kind: 'all' };
  if (typeof text !== 'string') return 'matcher must be a string';
  const trimmed = text.trim();
  if (!trimmed || trimmed === '*') return { kind: 'all' };
  if (/^[A-Za-z0-9_\- ,|]+$/.test(trimmed)) {
    const names = trimmed
      .split(/[|,]/)
      .map((part) => part.trim())
      .filter(Boolean);
    return names.length ? { kind: 'names', names } : { kind: 'all' };
  }
  try {
    return { kind: 'regex', re: new RegExp(trimmed) };
  } catch (error) {
    return `matcher is not a regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function matcherMatches(
  matcher: HookMatcher,
  value: string | undefined,
): boolean {
  if (matcher.kind === 'all') return true;
  if (matcher.kind === 'names')
    return value !== undefined && value !== '' && matcher.names.includes(value);
  return matcher.re.test(value ?? '');
}

/** `tool` or `tool(pattern)`: exactly one rule. */
export function parseCondition(text: unknown): HookCondition | string {
  if (typeof text !== 'string' || !text.trim())
    return '`if` must be one rule, such as "execute(git *)"';
  const trimmed = text.trim();
  const match = /^([A-Za-z0-9_.:*-]+)(?:\((.*)\))?$/s.exec(trimmed);
  if (!match) return `\`if\` is not a rule: ${trimmed}`;
  const pattern = match[2]?.trim();
  return {
    text: trimmed,
    tool: match[1]!,
    ...(pattern ? { pattern } : {}),
  };
}

function platformCommand(
  entry: Record<string, unknown>,
  platform: NodeJS.Platform,
): unknown {
  const field =
    platform === 'win32'
      ? 'command_windows'
      : platform === 'darwin'
        ? 'command_darwin'
        : platform === 'linux'
          ? 'command_linux'
          : undefined;
  const override = field ? entry[field] : undefined;
  return typeof override === 'string' && override.trim()
    ? override
    : entry.command;
}

function usableText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !!value.trim() &&
    value.length <= MAX_COMMAND &&
    !value.includes('\0')
  );
}

export interface HookOrigin {
  source: HookSource;
  sourceLabel: string;
  file: string;
  skill?: string;
  pack?: string;
  skillDir?: string;
  skillData?: string;
}

/**
 * The hooks one `hooks` value defines, and what in it cannot be used. A mistake costs that entry only: the rest of
 * the value still loads.
 */
export function parseHooks(
  value: unknown,
  origin: HookOrigin,
  platform: NodeJS.Platform = process.platform,
): { hooks: HookDefinition[]; problems: string[] } {
  const hooks: HookDefinition[] = [];
  const problems: string[] = [];
  if (value === undefined) return { hooks, problems };
  if (!isRecord(value))
    return { hooks, problems: ['hooks must be an object of events'] };
  for (const [event, groups] of Object.entries(value)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      problems.push(
        NOT_RUN_HERE.has(event)
          ? `${event} hooks do not run in Circle`
          : `unknown hook event ${event}`,
      );
      continue;
    }
    if (!Array.isArray(groups)) {
      problems.push(`${event} must be a list of matcher groups`);
      continue;
    }
    groups.forEach((group, groupIndex) => {
      const where = `${event}[${groupIndex}]`;
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        problems.push(`${where} needs a hooks list`);
        return;
      }
      const matcher = compileMatcher(group.matcher);
      if (typeof matcher === 'string') {
        problems.push(`${where}: ${matcher}`);
        return;
      }
      const matcherText =
        typeof group.matcher === 'string' && group.matcher.trim() !== '*'
          ? group.matcher.trim()
          : '';
      group.hooks.forEach((entry, index) => {
        const at = `${where}.hooks[${index}]`;
        if (hooks.length >= MAX_HOOKS) {
          if (hooks.length === MAX_HOOKS)
            problems.push(
              `at most ${MAX_HOOKS} hooks are loaded from one file`,
            );
          return;
        }
        const read = parseHandler(entry, event as HookEvent, at, platform);
        if (typeof read === 'string') {
          problems.push(read);
          return;
        }
        hooks.push({
          ...read,
          id: `${origin.sourceLabel}:${origin.file}:${at}`,
          event: event as HookEvent,
          matcher,
          matcherText,
          ...origin,
        });
      });
    });
  }
  return { hooks, problems };
}

type ParsedHandler = Omit<
  HookDefinition,
  'id' | 'event' | 'matcher' | 'matcherText' | keyof HookOrigin
>;

function parseHandler(
  entry: unknown,
  event: HookEvent,
  at: string,
  platform: NodeJS.Platform,
): ParsedHandler | string {
  if (!isRecord(entry)) return `${at} must be an object`;
  const type = entry.type ?? 'command';
  if (type !== 'command')
    return `${at}: ${String(type)} hooks are not supported in Circle yet; only command hooks run`;
  if (!usableText(entry.command)) return `${at} needs a command`;
  for (const field of ['command_windows', 'command_darwin', 'command_linux'])
    if (entry[field] !== undefined && !usableText(entry[field]))
      return `${at}: ${field} is not usable`;
  const command = platformCommand(entry, platform) as string;
  let args: string[] | undefined;
  if (entry.args !== undefined) {
    if (
      !Array.isArray(entry.args) ||
      !entry.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))
    )
      return `${at}: args must be a list of strings`;
    args = entry.args as string[];
  }
  if (
    entry.shell !== undefined &&
    entry.shell !== 'bash' &&
    entry.shell !== 'powershell'
  )
    return `${at}: shell must be "bash" or "powershell"`;
  let timeout: number | undefined;
  if (entry.timeout !== undefined) {
    if (
      typeof entry.timeout !== 'number' ||
      !Number.isFinite(entry.timeout) ||
      entry.timeout <= 0
    )
      return `${at}: timeout must be a number of seconds`;
    timeout = entry.timeout;
  }
  let condition: HookCondition | undefined;
  if (entry.if !== undefined) {
    const read = parseCondition(entry.if);
    if (typeof read === 'string') return `${at}: ${read}`;
    condition = read;
  }
  for (const field of ['once', 'async'] as const)
    if (entry[field] !== undefined && typeof entry[field] !== 'boolean')
      return `${at}: ${field} must be true or false`;
  if (entry.asyncRewake !== undefined)
    return `${at}: asyncRewake is not supported in Circle yet`;
  if (
    entry.onFailure !== undefined &&
    entry.onFailure !== 'continue' &&
    entry.onFailure !== 'block'
  )
    return `${at}: onFailure must be "continue" or "block"`;
  if (
    entry.screenshot !== undefined &&
    (typeof entry.screenshot !== 'boolean' ||
      (entry.screenshot && event !== 'PostToolUse'))
  )
    return `${at}: screenshot must be true or false, and only PostToolUse takes it`;
  for (const field of ['statusMessage', 'name'] as const)
    if (entry[field] !== undefined && typeof entry[field] !== 'string')
      return `${at}: ${field} must be text`;
  if (entry.legacy !== undefined && typeof entry.legacy !== 'boolean')
    return `${at}: legacy must be true or false`;
  if (
    entry.loopLimit !== undefined &&
    (typeof entry.loopLimit !== 'number' ||
      !Number.isInteger(entry.loopLimit) ||
      entry.loopLimit < 1)
  )
    return `${at}: loopLimit must be a whole number from 1`;
  const shown = [command, ...(args ?? [])].join(' ');
  const named =
    typeof entry.name === 'string' && entry.name.trim()
      ? entry.name.trim()
      : shown.trim();
  return {
    type: 'command',
    command,
    ...(args ? { args } : {}),
    ...(entry.shell ? { shell: entry.shell as 'bash' | 'powershell' } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
    ...(condition ? { condition } : {}),
    ...(typeof entry.statusMessage === 'string' && entry.statusMessage.trim()
      ? { statusMessage: entry.statusMessage.trim() }
      : {}),
    once: entry.once === true,
    async: entry.async === true,
    ...(entry.onFailure
      ? { onFailure: entry.onFailure as 'continue' | 'block' }
      : {}),
    name: named.replace(/\s+/g, ' ').slice(0, 80) || 'hook',
    ...(entry.screenshot === true ? { screenshot: true } : {}),
    ...(entry.legacy === true ? { legacy: true } : {}),
    ...(typeof entry.loopLimit === 'number'
      ? { loopLimit: Math.min(entry.loopLimit, 20) }
      : {}),
  };
}

function readJsonObject(path: string): Record<string, unknown> | string {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return `could not be read: ${error instanceof Error ? error.message : String(error)}`;
  }
  return isRecord(value) ? value : 'must be a JSON object';
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The `hooks` in a SKILL.md's frontmatter, read as YAML. Undefined when it has none. Only this key is read this way:
 * the rest of the frontmatter keeps its plain `key: value` reading.
 */
export function skillFrontmatterHooks(text: string): unknown {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match || !/^hooks\s*:/m.test(match[1]!)) return undefined;
  const value = parseYaml(match[1]!) as unknown;
  return isRecord(value) ? value.hooks : undefined;
}

export interface HookLoadOptions {
  workspace: string;
  home: string;
  userHome?: string;
  trusted: boolean;
  /** Where installed packs are; the universal skills folder under the user's home by default. */
  packsRoot?: string;
  platform?: NodeJS.Platform;
}

/** `disableAllHooks` as the settings leave it: the project's word over yours, the local file's over the project's. */
function hooksDisabled(files: Record<string, unknown>[]): boolean {
  let disabled = false;
  for (const file of files)
    if (typeof file.disableAllHooks === 'boolean')
      disabled = file.disableAllHooks;
  return disabled;
}

/** Every hook the configuration defines, in order: yours, the project's, the project's local file, packs, skills. */
export function loadHooks(options: HookLoadOptions): LoadedHooks {
  const platform = options.platform ?? process.platform;
  const hooks: HookDefinition[] = [];
  const errors: HookLoadError[] = [];
  const settingsFiles: { path: string; source: HookSource }[] = [
    { path: join(options.home, 'settings.json'), source: 'user' },
    {
      path: join(options.workspace, '.circle', 'settings.json'),
      source: 'project',
    },
    {
      path: join(options.workspace, '.circle', 'settings.local.json'),
      source: 'local',
    },
  ];
  const read: Record<string, unknown>[] = [];
  // A project's own hooks wait for the folder to be trusted; yours, your skills' and installed packs' do not
  let held = false;
  const take = (
    value: unknown,
    origin: HookOrigin,
    fromProject = false,
  ): void => {
    const parsed = parseHooks(value, origin, platform);
    if (fromProject && !options.trusted) {
      held ||= parsed.hooks.length > 0;
      return;
    }
    hooks.push(...parsed.hooks);
    if (parsed.problems.length)
      errors.push({ file: origin.file, message: parsed.problems.join('; ') });
  };
  const seen = new Set<string>();
  for (const { path, source } of settingsFiles) {
    // Circle run in the folder that holds its own data reads that settings.json once
    if (seen.has(path) || !isFile(path)) continue;
    seen.add(path);
    const value = readJsonObject(path);
    if (typeof value === 'string') {
      // A settings.json that cannot be read is reported where settings are read
      if (source === 'local') errors.push({ file: path, message: value });
      continue;
    }
    // An untrusted project cannot turn your hooks off either
    if (source === 'user' || options.trusted) read.push(value);
    if (source === 'local' && options.trusted)
      for (const key of Object.keys(value))
        if (key !== 'hooks' && key !== 'disableAllHooks')
          errors.push({
            file: path,
            message: `${key} is not read from settings.local.json; only hooks and disableAllHooks are`,
          });
    take(
      value.hooks,
      { source, sourceLabel: source, file: path },
      source !== 'user',
    );
  }
  const userHome = options.userHome ?? homedir();
  const packsRoot = options.packsRoot ?? join(userHome, '.agents', 'skills');
  let packs: string[] = [];
  try {
    packs = readdirSync(packsRoot).sort();
  } catch {
    /* No packs installed. */
  }
  for (const pack of packs) {
    const directory = join(packsRoot, pack);
    if (!isFile(join(directory, 'pack.json'))) continue;
    const file = join(directory, 'hooks', 'hooks.json');
    if (isFile(file)) {
      const value = readJsonObject(file);
      if (typeof value === 'string') errors.push({ file, message: value });
      else
        take(value.hooks, {
          source: 'pack',
          sourceLabel: `pack:${pack}`,
          file,
          pack,
          skillDir: directory,
          skillData: join(options.home, SKILL_DATA_FOLDER, pack),
        });
    }
    // The format before this one, which a pack cannot be moved out of in place: its files are checked
    if (isFile(join(directory, 'hooks.json')))
      errors.push({
        file: join(directory, 'hooks.json'),
        message: `pack ${pack} has hooks in the old format, which is not read: its hooks belong in hooks/hooks.json or in its SKILL.md frontmatter`,
      });
  }
  let skills: ReturnType<typeof discoverSkills> = [];
  try {
    skills = discoverSkills(options.workspace, options.home, userHome);
  } catch {
    skills = [];
  }
  for (const skill of skills) {
    // A personal knowledge pack carries no hooks
    if (skill.source_label === 'Personal pack') continue;
    let text: string;
    try {
      text = readFileSync(skill.path, 'utf8');
    } catch {
      continue;
    }
    let value: unknown;
    try {
      value = skillFrontmatterHooks(text);
    } catch (error) {
      errors.push({
        file: skill.path,
        message: `the frontmatter could not be read as YAML, so its hooks did not load: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const directory = dirname(skill.path);
    // The format before this one, which Circle moves only out of its own skill folders: elsewhere it is named
    if (
      isFile(join(directory, 'hooks.json')) &&
      !isFile(join(directory, 'pack.json'))
    )
      errors.push({
        file: join(directory, 'hooks.json'),
        message: `skill ${skill.name} has hooks in the format before this one, which is not read: they belong in its SKILL.md frontmatter`,
      });
    if (value === undefined) continue;
    const key = skill.name.toLowerCase();
    // An installed pack's skill: its hooks are the pack's, checked with its files, with its data folder
    const pack = isFile(join(directory, 'pack.json'))
      ? basename(directory)
      : undefined;
    take(
      value,
      {
        source: 'skill',
        sourceLabel: `skill:${skill.name}`,
        file: skill.path,
        skill: key,
        skillDir: directory,
        ...(pack
          ? {
              pack,
              skillData: join(options.home, SKILL_DATA_FOLDER, pack),
            }
          : {}),
      },
      skill.source_label.startsWith('Project'),
    );
  }
  // `once` is honoured in a skill's frontmatter only
  for (const hook of hooks) if (hook.source !== 'skill') hook.once = false;
  // A project hooks file of the format before this one moves once the folder is trusted: until then it waits too
  if (
    !options.trusted &&
    isFile(join(options.workspace, '.circle', 'hooks.json'))
  )
    held = true;
  const disabled = hooksDisabled(read);
  if (disabled)
    return { hooks: [], errors, untrusted: held, disabled, notes: [] };
  return { hooks, errors, untrusted: held, disabled, notes: [] };
}

/** A hooks file next to a skill's SKILL.md: the format before this one. */
export function oldSkillHooksFile(skillPath: string): string | undefined {
  const file = join(dirname(skillPath), 'hooks.json');
  return existsSync(file) ? file : undefined;
}

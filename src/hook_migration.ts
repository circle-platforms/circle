// Hooks files in the format before this one become `hooks` in settings, once. A file of your own goes into your
// settings.json, a trusted project's into its .circle/settings.json, a skill's of your own into its SKILL.md's
// frontmatter. The old file stays beside, renamed `hooks.json.migrated`, and is not read again.
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { stringify as yaml } from 'yaml';
import { skillFrontmatterHooks } from './hook_config.js';
import { isRecord, withPrivateJsonLock, writePrivateJson } from './settings.js';
import { discoverSkills } from './skills.js';

const OLD_EVENTS: Record<string, string> = {
  before_tool: 'PreToolUse',
  after_tool: 'PostToolUse',
  before_stop: 'Stop',
  session_start: 'SessionStart',
  permission_request: 'PermissionRequest',
  user_prompt: 'UserPromptSubmit',
  subagent_start: 'SubagentStart',
};
/** Events that judged a call: a hook that failed there stopped it, so the migrated hook blocks on failure. */
const GATING = new Set(['before_tool', 'permission_request']);
/** Events with no tool, where `tools` and `paths` meant nothing. */
const NO_TOOL = new Set([
  'before_stop',
  'session_start',
  'user_prompt',
  'subagent_start',
]);
/** Circle's tools that name a path, for a hook whose globs applied to every tool. */
export const PATH_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'apply_patch',
  'ls',
  'glob',
  'grep',
  'vision',
];

function names(value: unknown): string[] | '*' {
  if (value === undefined || value === '*' || value === '') return '*';
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[|,]/)
      : [];
  const list = parts
    .map((part) => String(part).trim())
    .filter((part) => part && part !== '*');
  return list.length ? list : '*';
}

/** The hooks of a file in the format before this one, in the current format; and what did not carry over. */
export function convertOldHooks(value: unknown): {
  hooks: Record<string, unknown[]>;
  notes: string[];
} {
  const hooks: Record<string, unknown[]> = {};
  const notes: string[] = [];
  const events = isRecord(value) && isRecord(value.hooks) ? value.hooks : {};
  for (const [event, list] of Object.entries(events)) {
    const target = OLD_EVENTS[event];
    if (!target) {
      notes.push(`unknown hook event ${event} was left out`);
      continue;
    }
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.command !== 'string') continue;
      const handler: Record<string, unknown> = {
        type: 'command',
        command: entry.command,
      };
      for (const field of [
        'command_windows',
        'command_darwin',
        'command_linux',
        'name',
      ])
        if (typeof entry[field] === 'string') handler[field] = entry[field];
      // The old default was 30 seconds; the current one is ten minutes
      const ms =
        typeof entry.timeout_ms === 'number' && entry.timeout_ms > 0
          ? entry.timeout_ms
          : 30_000;
      handler.timeout = Math.max(1, Math.ceil(ms / 1000));
      if (entry.screenshot === true) handler.screenshot = true;
      if (GATING.has(event)) handler.onFailure = 'block';
      if (entry.loop_limit !== undefined)
        notes.push(
          `loop_limit of ${String(entry.name ?? entry.command)} was left out: Stop hooks send a turn back at most 8 times in a row`,
        );
      const tools = NO_TOOL.has(event)
        ? '*'
        : names(entry.tools ?? entry.matcher);
      const globs = NO_TOOL.has(event)
        ? []
        : (Array.isArray(entry.paths) ? entry.paths : [entry.paths])
            .filter((glob): glob is string => typeof glob === 'string')
            .map((glob) => glob.trim())
            .filter(Boolean);
      const group: Record<string, unknown> = {
        ...(tools === '*' ? {} : { matcher: tools.join('|') }),
        hooks: globs.length
          ? // One rule per tool and glob: the same command runs once however many of them match a call
            (tools === '*' ? PATH_TOOLS : tools).flatMap((tool) =>
              globs.map((glob) => ({ ...handler, if: `${tool}(${glob})` })),
            )
          : [handler],
      };
      if (globs.length && tools === '*')
        notes.push(
          `the paths of ${String(entry.name ?? entry.command)} now apply to Circle's file tools (${PATH_TOOLS.join(', ')}); an MCP tool needs an if of its own`,
        );
      (hooks[target] ??= []).push(group);
    }
  }
  return { hooks, notes };
}

function mergeHooks(
  into: Record<string, unknown>,
  hooks: Record<string, unknown[]>,
): Record<string, unknown> {
  const current = isRecord(into.hooks) ? { ...into.hooks } : {};
  for (const [event, groups] of Object.entries(hooks))
    current[event] = [
      ...(Array.isArray(current[event]) ? current[event] : []),
      ...groups,
    ];
  return { ...into, hooks: current };
}

function readOld(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The old file, renamed so it is kept and not read again. */
function retire(file: string): string {
  let target = `${file}.migrated`;
  for (let n = 2; existsSync(target); n++) target = `${file}.migrated.${n}`;
  renameSync(file, target);
  return target;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Moves one old hooks file into a settings file's `hooks`. */
function intoSettings(
  file: string,
  settings: string,
  shown: string,
  privateFile: boolean,
): string[] {
  let old: unknown;
  try {
    old = readOld(file);
  } catch (error) {
    return [
      `${shown}: hooks.json could not be read, so it was not moved into settings: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const { hooks, notes } = convertOldHooks(old);
  const write = () => {
    let current: Record<string, unknown> = {};
    if (isFile(settings)) {
      const value = JSON.parse(readFileSync(settings, 'utf8')) as unknown;
      if (!isRecord(value)) throw new Error(`${settings} is not a JSON object`);
      current = value;
    }
    const merged = mergeHooks(current, hooks);
    if (privateFile) writePrivateJson(settings, merged);
    else writeFileSync(settings, `${JSON.stringify(merged, null, 2)}\n`);
  };
  try {
    if (privateFile) withPrivateJsonLock(settings, write);
    else write();
  } catch (error) {
    return [
      `${shown}: hooks.json could not be moved into settings: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const kept = retire(file);
  return [
    `${shown}: its hooks were moved into ${settings.endsWith('settings.json') ? 'settings.json' : settings} under hooks, in the current format; the old file is ${kept.split(/[\\/]/).at(-1)}`,
    ...notes.map((note) => `${shown}: ${note}`),
  ];
}

/** Moves a skill's old hooks file into its SKILL.md's frontmatter. */
function intoSkill(file: string, skillPath: string, name: string): string[] {
  let old: unknown;
  let text: string;
  try {
    old = readOld(file);
    text = readFileSync(skillPath, 'utf8');
  } catch (error) {
    return [
      `skill ${name}: hooks.json could not be read: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  try {
    if (skillFrontmatterHooks(text) !== undefined)
      return [
        `skill ${name}: its SKILL.md has hooks already, so hooks.json was left as it is and is not read`,
      ];
  } catch {
    return [
      `skill ${name}: its SKILL.md frontmatter is not YAML, so hooks.json was left as it is and is not read`,
    ];
  }
  const { hooks, notes } = convertOldHooks(old);
  const block = yaml({ hooks }).trimEnd();
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  const next = match
    ? `---\n${match[1]}\n${block}\n---\n${text.slice(match[0].length)}`
    : `---\n${block}\n---\n${text}`;
  try {
    writeFileSync(skillPath, next);
  } catch (error) {
    return [
      `skill ${name}: SKILL.md could not be written: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
  const kept = retire(file);
  return [
    `skill ${name}: its hooks were moved into the SKILL.md frontmatter, in the current format; the old file is ${kept.split(/[\\/]/).at(-1)}`,
    ...notes.map((note) => `skill ${name}: ${note}`),
  ];
}

/**
 * Moves every hooks file in the format before this one that is Circle's to move: yours, a trusted project's, and your
 * skills'. An installed pack is left as it is, since its files are checked against what was installed. Returns what
 * was done, for the conversation to say.
 */
export function migrateHookFiles(options: {
  home: string;
  workspace: string;
  trusted: boolean;
  userHome?: string;
}): string[] {
  const notes: string[] = [];
  const own = join(options.home, 'hooks.json');
  if (isFile(own))
    notes.push(
      ...intoSettings(
        own,
        join(options.home, 'settings.json'),
        'your hooks',
        true,
      ),
    );
  const project = join(options.workspace, '.circle', 'hooks.json');
  if (options.trusted && isFile(project))
    notes.push(
      ...intoSettings(
        project,
        join(options.workspace, '.circle', 'settings.json'),
        'the project hooks',
        false,
      ),
    );
  let skills: ReturnType<typeof discoverSkills> = [];
  try {
    skills = discoverSkills(options.workspace, options.home, options.userHome);
  } catch {
    skills = [];
  }
  for (const skill of skills) {
    if (skill.source_label === 'Personal pack') continue;
    // A project's skills are the project's: they move once it is trusted
    if (!options.trusted && skill.source_label.startsWith('Project')) continue;
    const folder = dirname(skill.path);
    // An installed pack: its files are checked, so it is the pack's to change
    if (isFile(join(folder, 'pack.json'))) continue;
    const file = join(folder, 'hooks.json');
    if (isFile(file)) notes.push(...intoSkill(file, skill.path, skill.name));
  }
  return notes;
}

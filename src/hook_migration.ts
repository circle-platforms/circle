// Hooks files in the format before this one become `hooks` in settings, once. A file of your own goes into your
// settings.json, a trusted project's into its .circle/settings.json, and a hooks.json beside a skill in Circle's own
// skill folders into that skill's SKILL.md frontmatter. The old file stays beside, renamed `hooks.json.migrated`, and
// is not read again. A moved hook is marked `legacy`, so it keeps the input fields, shell and meanings it was
// written for until it is rewritten.
import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml, stringify as yaml } from 'yaml';
import { skillFrontmatterHooks } from './hook_config.js';
import { isRecord, withPrivateJsonLock, writePrivateJson } from './settings.js';
import { discoverSkills, splitFrontmatter } from './skills.js';

const OLD_EVENTS: Record<string, string> = {
  before_tool: 'PreToolUse',
  after_tool: 'PostToolUse',
  before_stop: 'Stop',
  session_start: 'SessionStart',
  permission_request: 'PermissionRequest',
  user_prompt: 'UserPromptSubmit',
  subagent_start: 'SubagentStart',
};
/** Events that judged a call: a hook that failed there stopped it, so the moved hook blocks on failure. */
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
/** The skill folders that are Circle's own to change: an agent's or a pack's folder is not. */
const OWN_SKILLS = new Set(['Circle', 'Project Circle']);

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
      // It keeps what it was written for: its input fields, cmd.exe on Windows, its plain-text and failure meanings
      handler.legacy = true;
      if (event === 'before_stop')
        handler.loopLimit =
          typeof entry.loop_limit === 'number' && entry.loop_limit >= 1
            ? Math.min(20, Math.floor(entry.loop_limit))
            : 5;
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

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Moves one old hooks file into a settings file's `hooks`. It holds the settings file's lock and reads the old file
 * again under it, so two Circles that start together move it once.
 */
function intoSettings(
  file: string,
  settings: string,
  shown: string,
  privateFile: boolean,
): string[] {
  try {
    return withPrivateJsonLock(settings, () => {
      // Another Circle moved it meanwhile
      if (!isFile(file)) return [];
      const { hooks, notes } = convertOldHooks(
        JSON.parse(readFileSync(file, 'utf8')),
      );
      let current: Record<string, unknown> = {};
      if (isFile(settings)) {
        const value = JSON.parse(readFileSync(settings, 'utf8')) as unknown;
        if (!isRecord(value))
          throw new Error(`${settings} is not a JSON object`);
        current = value;
      }
      const merged = mergeHooks(current, hooks);
      if (privateFile) writePrivateJson(settings, merged);
      else writeFileSync(settings, `${JSON.stringify(merged, null, 2)}\n`);
      const kept = retire(file);
      return [
        `${shown}: moved into ${settings} under hooks, in the current format, marked legacy; the old file is ${kept}`,
        ...notes.map((note) => `${shown}: ${note}`),
      ];
    });
  } catch (error) {
    return [
      `${shown}: hooks.json could not be moved into settings, so its hooks do not run: ${message(error)}`,
    ];
  }
}

/** Moves a skill's old hooks file into its SKILL.md's frontmatter, if the result still reads as YAML. */
function intoSkill(file: string, skillPath: string, name: string): string[] {
  try {
    const text = readFileSync(skillPath, 'utf8');
    try {
      if (skillFrontmatterHooks(text) !== undefined)
        return [
          `skill ${name}: its SKILL.md has hooks already, so its hooks.json was left as it is and is not read`,
        ];
    } catch {
      /* Checked below, with the hooks added. */
    }
    const { hooks, notes } = convertOldHooks(
      JSON.parse(readFileSync(file, 'utf8')),
    );
    const block = yaml({ hooks }).trimEnd();
    const found = splitFrontmatter(text);
    const front =
      found.block !== undefined ? `${found.block}\n${block}` : block;
    // A frontmatter that is not YAML would lose these hooks: it is left for you to fix, and the hooks stay where
    // they are
    try {
      parseYaml(front);
    } catch (error) {
      return [
        `skill ${name}: its SKILL.md frontmatter is not YAML (${message(error).split('\n')[0]}), so its hooks.json was not moved and does not run; quote the values with a colon in them and start Circle again`,
      ];
    }
    const next =
      found.block !== undefined
        ? `---\n${front}\n---\n${found.body}`
        : `---\n${front}\n---\n${text}`;
    writeFileSync(skillPath, next);
    const kept = retire(file);
    return [
      `skill ${name}: its hooks were moved into the SKILL.md frontmatter, in the current format, marked legacy; the old file is ${kept}`,
      ...notes.map((note) => `skill ${name}: ${note}`),
    ];
  } catch (error) {
    return [
      `skill ${name}: hooks.json could not be moved, so its hooks do not run: ${message(error)}`,
    ];
  }
}

/**
 * Moves every hooks file in the format before this one that is Circle's to move: yours, a trusted project's, and
 * those of skills in Circle's own folders. A pack, and a skill in another agent's folder, are left as they are and
 * named when hooks load. Returns what was done, for the conversation to say. It never throws.
 */
export function migrateHookFiles(options: {
  home: string;
  workspace: string;
  trusted: boolean;
  userHome?: string;
}): string[] {
  const notes: string[] = [];
  try {
    const own = join(options.home, 'hooks.json');
    if (isFile(own))
      notes.push(
        ...intoSettings(
          own,
          join(options.home, 'settings.json'),
          'your hooks.json',
          true,
        ),
      );
    const project = join(options.workspace, '.circle', 'hooks.json');
    if (options.trusted && isFile(project))
      notes.push(
        ...intoSettings(
          project,
          join(options.workspace, '.circle', 'settings.json'),
          "the project's .circle/hooks.json",
          false,
        ),
      );
    for (const skill of discoverSkills(
      options.workspace,
      options.home,
      options.userHome,
    )) {
      if (!OWN_SKILLS.has(skill.source_label)) continue;
      if (!options.trusted && skill.source_label === 'Project Circle') continue;
      const folder = dirname(skill.path);
      if (isFile(join(folder, 'pack.json'))) continue;
      const file = join(folder, 'hooks.json');
      if (isFile(file)) notes.push(...intoSkill(file, skill.path, skill.name));
    }
  } catch (error) {
    notes.push(`hooks files could not all be moved: ${message(error)}`);
  }
  return notes;
}

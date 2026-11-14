import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { EFFORT_LEVELS } from './effort.js';
import { parseHooks, type HookDefinition } from './hook_config.js';
import { isRecord } from './settings.js';
import { parseFrontmatter, splitFrontmatter } from './skills.js';
import type { SubagentSpec } from './extensions.js';

/** The values `permissionMode` takes; `manual` is read as `default`. */
export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
  'plan',
] as const;
export type SubagentPermissionMode = (typeof PERMISSION_MODES)[number];
export const MEMORY_SCOPES = ['user', 'project', 'local'] as const;
export const AGENT_COLORS = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const;
/** At most this many distinct skills are loaded into a subagent before its task. */
export const MAX_PRELOADED_SKILLS = 32;
/** Keys a pack's definition may have that are not read for a pack. */
const NOT_FOR_PACKS = ['hooks', 'mcpServers', 'permissionMode'] as const;

/** One subagent defined by a markdown file. */
export interface SubagentFileInfo {
  spec: SubagentSpec;
  /**
   * The tool names the file lists; undefined means the default set. An entry ending in `*` takes every tool whose
   * name starts with what comes before it.
   */
  tools?: string[];
  /** Tools it never gets, in the same form as `tools`. */
  disallowedTools?: string[];
  permissionMode?: SubagentPermissionMode;
  /** How many model requests it may make before it stops with what it has. */
  maxTurns?: number;
  /** Skills loaded into its conversation before its task. */
  skills?: string[];
  /** Configured MCP servers, by name, whose tools it gets. */
  mcpServers?: string[];
  /** Hooks that run only for this subagent while it runs. Its Stop hooks are SubagentStop hooks. */
  hooks?: HookDefinition[];
  /** It runs as a background job when the conversation starts it. */
  background?: boolean;
  /** Read and shown, and not applied yet. */
  memory?: (typeof MEMORY_SCOPES)[number];
  isolation?: 'worktree';
  color?: (typeof AGENT_COLORS)[number];
  /** Keys a pack's definition has that are not read for a pack. */
  ignored?: string[];
  /** Values read and not applied, each with why: a project's definition cannot loosen approvals. */
  notApplied?: string[];
  path: string;
  source_label: string;
}

/** What was found, and why a file was passed over. */
export interface SubagentSources {
  agents: SubagentFileInfo[];
  problems: string[];
}

// Lowest priority first: a later folder replaces an earlier one of the same name, so a
// project's agent beats your own, as it does for skills. Extensions come last of all and
// are merged by the runtime.
export function subagentSources(
  workspace: string,
  home: string,
  userHome = homedir(),
): [string, string][] {
  const sources: [string, string][] = [
    [join(userHome, '.agents/agents'), 'Agents'],
    [join(userHome, '.claude/agents'), 'Claude'],
    [join(home, 'agents'), 'Circle'],
  ];
  for (const [path, label] of [
    ['.agents/agents', 'Project Agents'],
    ['.claude/agents', 'Project Claude'],
    ['.circle/agents', 'Project Circle'],
  ] as const)
    sources.push([join(workspace, path), label]);
  const unique = new Map<string, string>();
  for (const [path, label] of sources)
    try {
      if (statSync(path).isDirectory()) unique.set(realpathSync(path), label);
    } catch {
      /* No agents folder here. */
    }
  return [...unique];
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The files in one folder, by name, ignoring everything else. */
function markdownFiles(directory: string): string[] {
  let found: string[];
  try {
    found = readdirSync(directory);
  } catch {
    return [];
  }
  return found
    .filter((name) => name.toLowerCase().endsWith('.md'))
    .sort((a, b) => a.localeCompare(b));
}

/** `a, b(x, y) c` as its entries: commas, semicolons and spaces part them, except inside parentheses. */
function splitEntries(text: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let word = '';
  for (const char of text) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;\s]/.test(char)) {
      if (word.trim()) entries.push(word.trim());
      word = '';
    } else word += char;
  }
  if (word.trim()) entries.push(word.trim());
  return entries;
}

/** A list as written: a YAML list, or one line of names. Undefined when it is neither. */
function listOf(value: unknown): string[] | undefined {
  if (typeof value === 'string') return splitEntries(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return value.map((item) => item.trim()).filter(Boolean);
  return undefined;
}

/** A tool entry without what its parentheses say: `task(worker)` is `task`, `execute(git push *)` is `execute`. */
function toolName(entry: string): string {
  return entry.replace(/\(.*\)$/s, '').trim();
}

/** The keys this version reads beyond name, description, model and effort. They are read from YAML only. */
const KEYS = [
  'tools',
  'disallowedTools',
  'permissionMode',
  'maxTurns',
  'skills',
  'mcpServers',
  'hooks',
  'memory',
  'background',
  'isolation',
  'color',
] as const;
type Key = (typeof KEYS)[number];
/** Modes that would let a subagent ask less than the conversation: a project's definition cannot set them. */
const LOOSENING = new Set<SubagentPermissionMode>([
  'acceptEdits',
  'bypassPermissions',
  'auto',
]);

/** A value that is text: a string, or a number or a word YAML read as one. Undefined when there is none. */
function textOf(value: unknown, key: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  throw new Error(`${key} must be text`);
}

/**
 * A definition's frontmatter: every key as YAML gives it, by its name in lower case. When it is not YAML, its one-line
 * keys and the reason. A key written twice in different cases is a reason too.
 */
function readFrontmatter(
  text: string,
):
  | { fields: Map<string, unknown> }
  | { plain: Record<string, string>; error?: string } {
  const { block } = splitFrontmatter(text);
  if (block === undefined) return { plain: {} };
  let value: unknown;
  try {
    value = parseYaml(block) as unknown;
  } catch (error) {
    return {
      plain: parseFrontmatter(text).meta,
      error: (error instanceof Error ? error.message : String(error))
        .split('\n')[0]!
        .replace(/:$/, ''),
    };
  }
  const fields = new Map<string, unknown>();
  if (value === null || value === undefined) return { fields };
  if (!isRecord(value))
    return {
      plain: parseFrontmatter(text).meta,
      error: 'it is not a list of keys',
    };
  for (const [key, item] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (fields.has(lower))
      throw new Error(`${key} is written twice, in different cases`);
    fields.set(lower, item);
  }
  return { fields };
}

/**
 * The fields of one definition beyond its name, description, prompt, model and effort, checked. A value a key does
 * not take is a reason, and the file is not offered.
 */
function readFields(
  fields: Map<string, unknown>,
  name: string,
  path: string,
  pack: boolean,
  project: boolean,
): Omit<SubagentFileInfo, 'spec' | 'path' | 'source_label'> | string {
  const written = (key: Key): boolean => fields.has(key.toLowerCase());
  const value = (key: Key): unknown => fields.get(key.toLowerCase());
  const found: Omit<SubagentFileInfo, 'spec' | 'path' | 'source_label'> = {};
  const given = (raw: unknown): boolean =>
    raw !== undefined && raw !== null && raw !== '';
  /** One word of a fixed set; undefined when the key is not there. */
  const word = <T extends string>(
    key: Key,
    allowed: readonly T[],
  ): { value?: T; error?: string } => {
    const raw = value(key);
    if (!given(raw)) return {};
    const text = textOf(raw, key)!.trim();
    return (allowed as readonly string[]).includes(text)
      ? { value: text as T }
      : { error: `${key} '${text}' is not one of ${allowed.join(', ')}` };
  };
  try {
    const ignored = pack ? NOT_FOR_PACKS.filter(written) : [];
    if (ignored.length) found.ignored = [...ignored];
    for (const key of ['tools', 'disallowedTools'] as const) {
      const raw = value(key);
      if (!given(raw)) continue;
      const list = listOf(raw);
      if (!list) return `${key} must be tool names, as a list or on one line`;
      const names = [...new Set(list.map(toolName).filter(Boolean))];
      if (!names.length && key === 'tools') return 'tools lists no tool';
      found[key] = names;
    }
    if (!pack) {
      const mode = value('permissionMode');
      if (given(mode)) {
        const text = textOf(mode, 'permissionMode')!.trim();
        const read = text === 'manual' ? 'default' : text;
        if (!(PERMISSION_MODES as readonly string[]).includes(read))
          return `permissionMode '${text}' is not one of ${PERMISSION_MODES.join(', ')}`;
        // A repository can make Circle ask more, never less
        if (project && LOOSENING.has(read as SubagentPermissionMode))
          found.notApplied = [
            `permissionMode ${text}: a project's definition cannot loosen approvals`,
          ];
        else found.permissionMode = read as SubagentPermissionMode;
      }
    }
    const turns = value('maxTurns');
    if (given(turns)) {
      const count =
        typeof turns === 'number'
          ? turns
          : typeof turns === 'string' && /^\d+$/.test(turns.trim())
            ? Number(turns)
            : NaN;
      if (!Number.isInteger(count) || count < 1)
        return `maxTurns must be a whole number from 1, not ${JSON.stringify(turns)}`;
      found.maxTurns = count;
    }
    const skills = value('skills');
    if (given(skills)) {
      const list = listOf(skills);
      if (!list) return 'skills must be skill names, as a list or on one line';
      if (list.length)
        found.skills = [...new Set(list)].slice(0, MAX_PRELOADED_SKILLS);
    }
    if (!pack) {
      const servers = value('mcpServers');
      if (given(servers)) {
        const named: string[] = [];
        const items = Array.isArray(servers)
          ? servers
          : typeof servers === 'string'
            ? splitEntries(servers)
            : [servers];
        for (const item of items) {
          if (typeof item === 'string' && item.trim()) named.push(item.trim());
          else if (isRecord(item))
            return `mcpServers: ${Object.keys(item).join(', ') || 'a server'} is defined inline, which Circle does not support yet; name a server that is already configured`;
          else return 'mcpServers must be the names of configured servers';
        }
        if (named.length) found.mcpServers = [...new Set(named)];
      }
      const hooks = value('hooks');
      if (given(hooks)) {
        const parsed = parseHooks(hooks, {
          source: 'agent',
          sourceLabel: `agent:${name}`,
          file: path,
        });
        if (parsed.problems.length)
          return `hooks: ${parsed.problems.join('; ')}`;
        // A subagent's Stop is its SubagentStop, which reads no matcher, as Stop does not. `once` is a skill's alone.
        found.hooks = parsed.hooks.map((hook) =>
          hook.event === 'Stop'
            ? {
                ...hook,
                event: 'SubagentStop',
                matcher: { kind: 'all' },
                matcherText: '',
                once: false,
              }
            : { ...hook, once: false },
        );
      }
    }
    const memory = word('memory', MEMORY_SCOPES);
    const isolation = word('isolation', ['worktree'] as const);
    const color = word('color', AGENT_COLORS);
    for (const read of [memory, isolation, color])
      if (read.error) return read.error;
    if (memory.value) found.memory = memory.value;
    if (isolation.value) found.isolation = isolation.value;
    if (color.value) found.color = color.value;
    const background = value('background');
    if (given(background)) {
      if (background === true || background === 'true') found.background = true;
      else if (background !== false && background !== 'false')
        return `background must be true or false, not ${JSON.stringify(background)}`;
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return found;
}

/**
 * The definitions in one folder, and why a file there was passed over: the folders below, and the `agents` folder an
 * installed pack ships (#552). A pack's definition does not get hooks, MCP servers or a permission mode of its own.
 */
export function readSubagentFolder(
  root: string,
  label: string,
  pack = false,
): SubagentSources {
  const agents: SubagentFileInfo[] = [];
  const problems: string[] = [];
  const takenHere = new Set<string>();
  for (const file of markdownFiles(root)) {
    const path = join(root, file);
    let text: string;
    try {
      if (!statSync(path).isFile()) continue;
      text = readFileSync(path, 'utf8');
    } catch (error) {
      problems.push(`${path}: cannot be read (${String(error)})`);
      continue;
    }
    let read: ReturnType<typeof readFrontmatter>;
    let basics: Partial<
      Record<'name' | 'description' | 'model' | 'effort', string>
    >;
    try {
      read = readFrontmatter(text);
      if ('fields' in read) {
        const fields = read.fields;
        basics = Object.fromEntries(
          (['name', 'description', 'model', 'effort'] as const).flatMap(
            (key) => {
              const value = textOf(fields.get(key), key);
              return value === undefined ? [] : [[key, value]];
            },
          ),
        );
      } else {
        // A frontmatter that is not YAML keeps its one-line keys, unless it holds one that needs YAML: a guard is
        // never dropped quietly
        const plain = read.plain;
        const needs = KEYS.filter((key) =>
          Object.hasOwn(plain, key.toLowerCase()),
        );
        if (read.error !== undefined && needs.length)
          throw new Error(
            `the frontmatter is not YAML (${read.error}), so ${needs.join(', ')} cannot be read`,
          );
        basics = {
          name: plain.name,
          description: plain.description,
          model: plain.model,
          effort: plain.effort,
        };
      }
    } catch (error) {
      problems.push(
        `${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const body = splitFrontmatter(text).body;
    const stem = file.replace(/\.md$/i, '');
    const claimed = (basics.name || stem).trim();
    if (!NAME.test(claimed)) {
      problems.push(
        `${path}: '${claimed}' is not a name (letters, digits, _ and -, up to 64)`,
      );
      continue;
    }
    if (takenHere.has(claimed)) {
      problems.push(`${path}: two files in ${root} claim '${claimed}'`);
      continue;
    }
    const description = (basics.description || '').trim();
    if (!description) {
      problems.push(`${path}: no description`);
      continue;
    }
    const prompt = body.trim();
    if (!prompt) {
      problems.push(`${path}: no prompt after the --- lines`);
      continue;
    }
    // A depth of its own; a word that is not one does not load
    const effort = basics.effort?.trim();
    if (effort && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
      problems.push(
        `${path}: effort '${effort}' is not one of ${EFFORT_LEVELS.join(', ')}`,
      );
      continue;
    }
    const real = existsSync(path) ? realpathSync(path) : path;
    const fields = readFields(
      'fields' in read ? read.fields : new Map(),
      claimed,
      real,
      pack,
      label.startsWith('Project'),
    );
    if (typeof fields === 'string') {
      problems.push(`${path}: ${fields}`);
      continue;
    }
    takenHere.add(claimed);
    agents.push({
      spec: {
        name: claimed,
        description: description.slice(0, 1024),
        system_prompt: prompt,
        ...(basics.model?.trim() ? { model: basics.model.trim() } : {}),
        ...(effort ? { effort } : {}),
      },
      ...fields,
      path: real,
      source_label: label,
    });
  }
  return { agents, problems };
}

/**
 * Read the folders of agent definitions. A file that cannot be used is reported in
 * `problems` rather than dropped quietly, so `/agents` can say what is wrong with it.
 */
export function discoverSubagents(
  workspace: string,
  home: string,
  userHome = homedir(),
): SubagentSources {
  const agents: SubagentFileInfo[] = [];
  const problems: string[] = [];
  for (const [root, label] of subagentSources(workspace, home, userHome)) {
    const found = readSubagentFolder(root, label);
    agents.push(...found.agents);
    problems.push(...found.problems);
  }
  // Later folders replace earlier ones, in the order the folders are read.
  const byName = new Map<string, SubagentFileInfo>();
  for (const agent of agents) byName.set(agent.spec.name, agent);
  return { agents: [...byName.values()], problems };
}

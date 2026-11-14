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
import { parseFrontmatter } from './skills.js';
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

/** The frontmatter read as YAML, its keys exactly as written; the reason when it is not YAML. */
function yamlFields(text: string): {
  fields?: Record<string, unknown>;
  error?: string;
} {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { fields: {} };
  try {
    const value = parseYaml(match[1]!) as unknown;
    return { fields: isRecord(value) ? value : {} };
  } catch (error) {
    return {
      error: (error instanceof Error ? error.message : String(error)).split(
        '\n',
      )[0],
    };
  }
}

/** The keys this version reads beyond name, description, model and effort. */
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
/** Keys whose value needs YAML: a list under them or a nested map. */
const NESTED = new Set<Key>(['mcpServers', 'hooks']);

/**
 * The fields of one definition beyond its name, description, prompt, model and effort, checked. A value a key does
 * not take is a reason, and the file is not offered.
 */
function readFields(
  text: string,
  meta: Record<string, string>,
  name: string,
  path: string,
  pack: boolean,
): Omit<SubagentFileInfo, 'spec' | 'path' | 'source_label'> | string {
  const yaml = yamlFields(text);
  const written = (key: Key): boolean =>
    yaml.fields
      ? Object.hasOwn(yaml.fields, key)
      : Object.hasOwn(meta, key.toLowerCase());
  // A value as YAML gives it, else as the simple reading does: a frontmatter that is not YAML keeps working when
  // every key it uses fits on its own line
  const value = (key: Key): unknown => {
    if (yaml.fields) return yaml.fields[key];
    const plain = meta[key.toLowerCase()];
    if (plain === undefined) return undefined;
    if (NESTED.has(key) || !plain.trim())
      throw new Error(
        `${key} could not be read: the frontmatter is not YAML (${yaml.error})`,
      );
    return plain;
  };
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
    const text = String(raw).trim();
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
        const text = String(mode).trim();
        const read = text === 'manual' ? 'default' : text;
        if (!(PERMISSION_MODES as readonly string[]).includes(read))
          return `permissionMode '${text}' is not one of ${PERMISSION_MODES.join(', ')}`;
        found.permissionMode = read as SubagentPermissionMode;
      }
    }
    const turns = value('maxTurns');
    if (given(turns)) {
      const count = typeof turns === 'number' ? turns : Number(turns);
      if (!Number.isInteger(count) || count < 1)
        return `maxTurns must be a whole number above 0, not '${String(turns)}'`;
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
        return `background must be true or false, not '${String(background)}'`;
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
    const { meta, body } = parseFrontmatter(text);
    const stem = file.replace(/\.md$/i, '');
    const claimed = (meta.name || stem).trim();
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
    const description = (meta.description || '').trim();
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
    const effort = meta.effort?.trim();
    if (effort && !(EFFORT_LEVELS as readonly string[]).includes(effort)) {
      problems.push(
        `${path}: effort '${effort}' is not one of ${EFFORT_LEVELS.join(', ')}`,
      );
      continue;
    }
    const real = existsSync(path) ? realpathSync(path) : path;
    const fields = readFields(text, meta, claimed, real, pack);
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
        ...(meta.model?.trim() ? { model: meta.model.trim() } : {}),
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

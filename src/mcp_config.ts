// MCP server configuration in the documented format: `mcpServers`, an object keyed by server name, each entry with its
// `type` (stdio, http, sse, ws) and that type's fields. Three places hold it. Your own servers, for every project, are
// `mcpServers` in settings.json in the data folder; servers of yours for one project are under
// `projects["<folder>"].mcpServers` there; a project shares servers in `.mcp.json` at its root, and in an interactive
// session each of those connects once you approved it. The entries of `mcp_servers`, the list format before this one,
// are moved into `mcpServers` once (settings.ts), with a copy of the file kept.
import { copyFileSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeWorkspace } from './paths.js';

export type McpScope = 'user' | 'local' | 'project';
export type McpServerConfig = Record<string, unknown>;
/** One configured server: its name, where it is written, and its entry as written. */
export interface McpEntry {
  name: string;
  scope: McpScope;
  config: McpServerConfig;
  /** The folder a `headersHelper` runs in: the project's for a project or local server, the data folder for yours. */
  folder: string;
}
export const MCP_JSON = '.mcp.json';
/** The transports an entry's `type` names; `streamable-http` is another name for `http`. */
export const MCP_TYPES = ['stdio', 'http', 'sse', 'ws'] as const;
export type McpType = (typeof MCP_TYPES)[number];

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The servers of an `mcpServers` object: each one's own entry, by name. */
export function mcpServersOf(value: unknown): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  if (!record(value)) return out;
  for (const [name, entry] of Object.entries(value))
    if (record(entry) && name.trim() && name !== '__proto__')
      out[name] = structuredClone(entry);
  return out;
}

/** One server's entry by name, only when that name is one of the object's own. */
export function mcpServer(
  servers: Record<string, McpServerConfig>,
  name: string,
): McpServerConfig | undefined {
  return Object.hasOwn(servers, name) ? servers[name] : undefined;
}

/** An entry's transport: its `type`, or stdio when it has none. Undefined for a type Circle does not know. */
export function mcpType(config: McpServerConfig): McpType | undefined {
  const raw = config.type === undefined ? 'stdio' : String(config.type);
  const type = raw.toLowerCase() === 'streamable-http' ? 'http' : raw;
  return (MCP_TYPES as readonly string[]).includes(type)
    ? (type as McpType)
    : undefined;
}

/** `${env:NAME}` and `${secret:NAME}` of the format before this one, as the `${NAME}` it reads now. */
const oldReferences = (text: string): string =>
  text.replace(/\$\{(?:env|secret):([A-Za-z_][A-Za-z0-9_]*)\}/g, '${$1}');

/**
 * The servers of an `mcp_servers` list, the format before this one, in the current format, and what changed on the
 * way. An entry is named by its `name`, else its `id`, else `mcp<place>`; of two with one name the later one is kept,
 * as it was the one connected. `transport` becomes `type`: `streamable_http` is `http`, `websocket` is `ws`, and any
 * other or none `sse`, as it was read. The fields only Circle has (`enabled`, `max_file_bytes`, `placeholders`) stay.
 */
export function convertOldMcpServers(list: unknown): {
  servers: Record<string, McpServerConfig>;
  notes: string[];
} {
  const servers: Record<string, McpServerConfig> = {};
  const notes: string[] = [];
  if (!Array.isArray(list)) return { servers, notes };
  list.forEach((item, index) => {
    if (!record(item)) return;
    const name = String(item.name || item.id || `mcp${index}`);
    if (name === '__proto__') return;
    const entry: McpServerConfig = {};
    if (item.command) {
      entry.type = 'stdio';
      entry.command = String(item.command);
      if (item.args !== undefined)
        entry.args = Array.isArray(item.args)
          ? item.args.map(String)
          : [String(item.args)];
      if (record(item.env))
        entry.env = Object.fromEntries(
          Object.entries(item.env).map(([key, value]) => [key, String(value)]),
        );
    } else if (item.url) {
      const transport = String(item.transport || 'sse').toLowerCase();
      entry.type =
        transport === 'streamable_http'
          ? 'http'
          : transport === 'websocket'
            ? 'ws'
            : 'sse';
      entry.url = String(item.url);
      if (record(item.headers)) {
        const headers: Record<string, string> = {};
        for (const [key, value] of Object.entries(item.headers)) {
          const text = String(value);
          if (/\$\{secret:/.test(text))
            notes.push(
              `${name}: header ${key} names its secret as \${NAME} now, read from the environment first and then from your saved secrets`,
            );
          headers[key] = oldReferences(text);
        }
        entry.headers = headers;
      }
    } else {
      notes.push(`${name} has neither a command nor a url and was left out`);
      return;
    }
    for (const key of [
      'enabled',
      'max_file_bytes',
      'placeholders',
      'trust_annotations',
    ])
      if (item[key] !== undefined) entry[key] = structuredClone(item[key]);
    if (Object.hasOwn(servers, name))
      notes.push(
        `two servers were named ${name}; the later one was kept, as it was the one connected`,
      );
    servers[name] = entry;
  });
  return { servers, notes };
}

/** `mcpServers` with the entries of an old `mcp_servers` list added: an entry already in `mcpServers` stays. */
export function withOldMcpServers(
  raw: Record<string, unknown>,
): Record<string, McpServerConfig> {
  const current = mcpServersOf(raw.mcpServers);
  const { servers } = convertOldMcpServers(raw.mcp_servers);
  for (const [name, entry] of Object.entries(servers))
    if (!Object.hasOwn(current, name)) current[name] = entry;
  return current;
}

/** A free name for a kept copy of `file`. */
function keptName(file: string, suffix: string): string {
  let target = `${file}.${suffix}`;
  for (let n = 2; existsSync(target); n++) target = `${file}.${suffix}.${n}`;
  return target;
}

/**
 * Moves the `mcp_servers` of one settings file into its `mcpServers`, once: a copy of the file as it was is kept
 * beside it as `settings.json.mcp_servers.migrated`, and the list is not read again. The caller holds the file's lock
 * and writes it with `write`. Returns what was done, nothing when there was nothing to move.
 */
export function migrateMcpServersFile(
  path: string,
  write: (path: string, value: unknown) => void,
): string[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
  if (!record(raw) || !('mcp_servers' in raw)) return [];
  const { servers: old, notes } = convertOldMcpServers(raw.mcp_servers);
  const current = mcpServersOf(raw.mcpServers);
  for (const name of Object.keys(current))
    if (Object.hasOwn(old, name))
      notes.push(
        `${name} was in both mcp_servers and mcpServers; the mcpServers entry was kept`,
      );
  const moved = withOldMcpServers(raw);
  const kept = keptName(path, 'mcp_servers.migrated');
  copyFileSync(path, kept);
  const { mcp_servers: _old, ...rest } = raw;
  try {
    write(path, { ...rest, mcpServers: moved });
  } catch (error) {
    // The file stays as it was: the copy is only a copy
    try {
      renameSync(kept, `${kept}.unused`);
    } catch {
      /* Nothing more to undo. */
    }
    throw error;
  }
  return [
    `your MCP servers were moved from mcp_servers into mcpServers in settings.json, in the current format; the file as it was is ${kept.split(/[\\/]/).at(-1)}`,
    ...notes,
  ];
}

/** A `${VAR}` or `${VAR:-default}` reference in an entry's value. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Where a reference's value came from. */
export interface ReferenceValue {
  value: string;
  from: 'env' | 'secret';
}
export interface Expanded {
  text: string;
  /** References that are not set and have no default: they stay as written. */
  missing: string[];
  /** The values put in, with where each came from. */
  used: { name: string; value: string; from: 'env' | 'secret' }[];
}

/**
 * Credentials of Circle's own and of common providers that a remote server's `url` and `headers` never get from the
 * environment, whatever an entry names: they read as empty, and a default is not used.
 */
export const WITHHELD_VARIABLES = new Set([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AZURE_OPENAI_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NPM_TOKEN',
]);

/**
 * A value with each `${VAR}` replaced by that variable of the environment, else by that saved secret, and each
 * `${VAR:-default}` by the same or, when neither is set, by the default. A variable set to the empty string is set. A
 * reference to something not set and without a default stays as written, and is named in `missing`.
 */
export function expandReferences(
  text: string,
  lookup: (name: string) => ReferenceValue | undefined,
  withheld: (name: string) => boolean = () => false,
): Expanded {
  const missing: string[] = [];
  const used: Expanded['used'] = [];
  const out = text.replace(
    REFERENCE,
    (whole, name: string, fallback: string | undefined) => {
      if (withheld(name)) return '';
      const found = lookup(name);
      if (found) {
        used.push({ name, ...found });
        return found.value;
      }
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return whole;
    },
  );
  return { text: out, missing, used };
}

/** The lookup `expandReferences` takes: the environment first, then the saved secrets. */
export function environmentThenSecrets(
  env: NodeJS.ProcessEnv,
  secrets: Record<string, string>,
): (name: string) => ReferenceValue | undefined {
  return (name) => {
    const fromEnv = Object.hasOwn(env, name) ? env[name] : undefined;
    if (typeof fromEnv === 'string') return { value: fromEnv, from: 'env' };
    const saved = Object.hasOwn(secrets, name) ? secrets[name] : undefined;
    return typeof saved === 'string'
      ? { value: saved, from: 'secret' }
      : undefined;
  };
}

/** The key a project is filed under in settings.json's `projects`. */
export function projectKey(workspace: string): string {
  return normalizeWorkspace(workspace);
}

/** settings.json's entry for one project, if it has one. */
export function projectSettings(
  settings: Record<string, unknown>,
  workspace: string,
): Record<string, unknown> {
  const projects = record(settings.projects) ? settings.projects : {};
  const key = projectKey(workspace);
  // Filed under the folder as Circle names it, or as someone wrote it by hand
  const found = Object.hasOwn(projects, key)
    ? projects[key]
    : Object.entries(projects).find(([folder]) => {
        try {
          return projectKey(folder) === key;
        } catch {
          return false;
        }
      })?.[1];
  return record(found) ? found : {};
}

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];

/** What the person decided of a server in this project's `.mcp.json`. */
export type McpjsonChoice = 'approved' | 'declined' | undefined;
export function mcpjsonChoice(
  settings: Record<string, unknown>,
  workspace: string,
  name: string,
): McpjsonChoice {
  const project = projectSettings(settings, workspace);
  // A server declined anywhere stays out
  if (
    names(project.disabledMcpjsonServers).includes(name) ||
    names(settings.disabledMcpjsonServers).includes(name)
  )
    return 'declined';
  if (
    project.enableAllProjectMcpServers === true ||
    settings.enableAllProjectMcpServers === true ||
    names(project.enabledMcpjsonServers).includes(name) ||
    names(settings.enabledMcpjsonServers).includes(name)
  )
    return 'approved';
  return undefined;
}

/** Writes the person's answer for servers of this project's `.mcp.json` into `settings`, as saveSettingsChange takes it. */
export function recordMcpjsonChoice(
  settings: Record<string, unknown>,
  workspace: string,
  approved: string[],
  declined: string[],
): void {
  const projects = record(settings.projects) ? { ...settings.projects } : {};
  const normalized = projectKey(workspace);
  // The entry the project already has, under whatever spelling of its folder
  const key =
    Object.keys(projects).find((folder) => {
      try {
        return projectKey(folder) === normalized;
      } catch {
        return false;
      }
    }) ?? normalized;
  const project = { ...projectSettings(settings, workspace) };
  const enabled = new Set(names(project.enabledMcpjsonServers));
  const disabled = new Set(names(project.disabledMcpjsonServers));
  for (const name of approved) {
    enabled.add(name);
    disabled.delete(name);
  }
  for (const name of declined) {
    disabled.add(name);
    enabled.delete(name);
  }
  project.enabledMcpjsonServers = [...enabled];
  project.disabledMcpjsonServers = [...disabled];
  projects[key] = project;
  settings.projects = projects;
}

/** Where a server's entry is shown as coming from. */
export function scopeWhere(entry: McpEntry): string {
  return entry.scope === 'project'
    ? MCP_JSON
    : entry.scope === 'local'
      ? 'settings.json, this project'
      : 'settings.json';
}

export interface McpServersForRun {
  /** The servers to connect, one per name: a local entry over the project's over yours. */
  entries: McpEntry[];
  /** Servers of the project's `.mcp.json` that wait for the person's approval. */
  pending: McpEntry[];
  /** Servers of the project's `.mcp.json` the person declined. */
  declined: McpEntry[];
  /** Why `.mcp.json` could not be read. */
  problems: string[];
}

/** The project's `.mcp.json` servers, or why the file could not be read. */
export function readMcpJson(workspace: string): {
  servers: Record<string, McpServerConfig>;
  problem?: string;
} {
  const path = join(workspace, MCP_JSON);
  if (!existsSync(path)) return { servers: {} };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      servers: {},
      problem: `${MCP_JSON} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    !record(value) ||
    (value.mcpServers !== undefined && !record(value.mcpServers))
  )
    return {
      servers: {},
      problem: `${MCP_JSON} should be an object with mcpServers, an object of servers by name`,
    };
  return { servers: mcpServersOf(value.mcpServers) };
}

/**
 * The servers one run uses, from settings as loaded (`mcpServers` and `projects`) and the project's `.mcp.json`. The
 * file is read only in a trusted folder. Its servers connect once the person approved them; a run that cannot ask
 * (`interactive` false) connects those not declined.
 */
export function mcpServersForRun(options: {
  home: string;
  workspace: string;
  settings: Record<string, unknown>;
  trusted: boolean;
  interactive: boolean;
}): McpServersForRun {
  const { home, workspace, settings } = options;
  const byName = new Map<string, McpEntry>();
  const add = (scope: McpScope, servers: Record<string, McpServerConfig>) => {
    for (const [name, config] of Object.entries(servers))
      byName.set(name, {
        name,
        scope,
        config,
        folder: scope === 'user' ? home : workspace,
      });
  };
  add('user', mcpServersOf(settings.mcpServers));
  const pending: McpEntry[] = [];
  const declined: McpEntry[] = [];
  const problems: string[] = [];
  if (options.trusted) {
    const shared = readMcpJson(workspace);
    if (shared.problem) problems.push(shared.problem);
    const usable: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(shared.servers)) {
      const choice = mcpjsonChoice(settings, workspace, name);
      const entry: McpEntry = {
        name,
        scope: 'project',
        config,
        folder: workspace,
      };
      if (choice === 'declined') declined.push(entry);
      else if (choice === 'approved' || !options.interactive)
        usable[name] = config;
      else pending.push(entry);
    }
    add('project', usable);
  }
  add('local', mcpServersOf(projectSettings(settings, workspace).mcpServers));
  return { entries: [...byName.values()], pending, declined, problems };
}

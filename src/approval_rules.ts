import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matchPattern } from './file_patterns.js';
import { isRecord, writePrivateJson } from './settings.js';
import {
  currentMcpRuleTool,
  namePart,
  prefixedToolName,
} from './mcp_config.js';

// A rule names a tool, what it matches, and what to do about it: allow it
// without a card, deny it, or ask every time, in every mode. The layers are the
// person's own file, a file the project carries, and the rules this
// conversation kept from cards it answered.
export type RuleEffect = 'allow' | 'deny' | 'ask';
export type RuleLayer = 'user' | 'project' | 'session';

export interface ApprovalRule {
  tool: string;
  pattern: string;
  effect: RuleEffect;
  label: string;
}

export interface RuleSource {
  layer: RuleLayer;
  path: string;
  rules: ApprovalRule[];
}

export const ruleFileFor = (
  layer: 'user' | 'project',
  home: string,
  workspace: string,
): string =>
  layer === 'user'
    ? join(home, 'approvals.json')
    : join(workspace, '.circle', 'approvals.json');

// Where a rule came from, in the words the screen and the model see.
export const ruleWhere = (layer: RuleLayer): string =>
  layer === 'user'
    ? 'your approvals.json'
    : layer === 'project'
      ? "the project's rule"
      : 'this session';

const one = (entry: unknown): ApprovalRule | undefined => {
  if (!isRecord(entry)) return undefined;
  const tool = typeof entry.tool === 'string' ? entry.tool.trim() : '';
  // A rule for an MCP server's tool is written by its name alone: it covers every call
  const pattern =
    typeof entry.pattern === 'string'
      ? entry.pattern.trim()
      : tool.startsWith('mcp__')
        ? '*'
        : '';
  const effect =
    entry.effect === 'deny' ||
    entry.effect === 'allow' ||
    entry.effect === 'ask'
      ? entry.effect
      : '';
  if (!tool || !pattern || !effect) return undefined;
  const label =
    typeof entry.label === 'string' && entry.label.trim()
      ? entry.label.trim()
      : pattern;
  return { tool, pattern, effect: effect as RuleEffect, label };
};

const readRules = (path: string): ApprovalRule[] => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // No file, unreadable or not JSON: a layer that says nothing.
    return [];
  }
  if (!isRecord(value) || !Array.isArray(value.rules)) return [];
  return value.rules
    .map(one)
    .filter((rule): rule is ApprovalRule => rule !== undefined);
};

/**
 * The rule files, read again for every call. A rule added in another window
 * takes effect on the next call, and a deny is never served from a cache.
 */
export function ruleSources(home: string, workspace: string): RuleSource[] {
  return (['user', 'project'] as const).map((layer) => {
    const path = ruleFileFor(layer, home, workspace);
    return { layer, path, rules: readRules(path) };
  });
}

/**
 * The rules this conversation kept, as one source. Every rule a card wrote is
 * an allow: a card only ever grants what it showed.
 */
export function sessionSource(
  path: string,
  rules: { tool: string; pattern: string; label: string }[],
): RuleSource {
  return {
    layer: 'session',
    path,
    rules: rules.map((rule) => ({ ...rule, effect: 'allow' as RuleEffect })),
  };
}

/**
 * Whether a rule covers one call. `words` is the command in `execute`, one
 * entry per segment: a pattern has to cover every one of them, as
 * `allowed_commands` does. `patterns` is what the card would offer to keep:
 * the call's own pattern and the patterns that cover it, which is how a rule
 * kept from a card matches, by hash or by prefix or by site.
 */
/** The server and the tool an MCP tool's call goes to, by their own names, as the MCP manager knows them. */
export interface McpToolOwner {
  server: string;
  tool: string;
}

export function ruleCovers(
  rule: ApprovalRule,
  tool: string,
  words: string[],
  patterns: string[],
  windows = process.platform === 'win32',
  mcp?: McpToolOwner,
  layer?: RuleLayer,
): boolean {
  if (!ruleNames(rule, tool, mcp, layer)) return false;
  if (patterns.includes(rule.pattern)) return true;
  return (
    tool === 'execute' &&
    words.length > 0 &&
    words.every((segment) => matchPattern(rule.pattern, segment, windows))
  );
}

/** An MCP rule's name read as a server and, when it names one, a tool or a glob of tools. */
function mcpRuleName(
  name: string,
): { server: string; tool?: string } | undefined {
  const rest = name.slice('mcp__'.length);
  // `mcp__<server>__*`: the whole name before the last `__*` is the server's, a `__` in it and all
  if (rest.endsWith('__*')) {
    const server = rest.slice(0, -3);
    return server && !server.includes('*') ? { server } : undefined;
  }
  const at = rest.indexOf('__');
  // `mcp__<server>`: every tool of that server
  if (at < 0) return rest && !rest.includes('*') ? { server: rest } : undefined;
  const server = rest.slice(0, at);
  const tool = rest.slice(at + 2);
  return server && !server.includes('*') && tool ? { server, tool } : undefined;
}
/** A rule's name with `*` as any text, matched against all of `value`. */
function globMatches(glob: string, value: string): boolean {
  const escaped = glob
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(value);
}
/**
 * Whether a rule's tool names this tool: the same name, or `*` for every tool. For an MCP server's tool the server is
 * the one the call goes to, as the MCP manager knows it (`mcp`): `mcp__<server>` and `mcp__<server>__*` name every
 * tool of exactly that server (the latter also a server whose name has `__` in it), and `mcp__<server>__<glob>` its
 * tools that match. That is all an allow names. A deny or an ask also reads its name as text, more widely, so that it
 * covers at least what it names: `mcp__<name>` covers every tool whose name starts with `mcp__<name>__`, and a glob
 * any tool name it matches, such as `mcp__*`. A project's deny written with the name such a tool had before
 * (`<server>_<tool>`) denies it too.
 */
export function ruleNames(
  rule: ApprovalRule,
  tool: string,
  mcp?: McpToolOwner,
  layer?: RuleLayer,
): boolean {
  if (rule.tool === '*' || rule.tool === tool) return true;
  if (
    mcp &&
    layer === 'project' &&
    rule.effect === 'deny' &&
    rule.tool === prefixedToolName(mcp.server, mcp.tool)
  )
    return true;
  if (!rule.tool.startsWith('mcp__')) return false;
  const named = mcpRuleName(rule.tool);
  if (
    mcp &&
    named &&
    namePart(mcp.server) === named.server &&
    (named.tool === undefined || globMatches(named.tool, namePart(mcp.tool)))
  )
    return true;
  if (rule.effect === 'allow' || !tool.startsWith('mcp__')) return false;
  return rule.tool.includes('*')
    ? globMatches(rule.tool, tool)
    : tool.startsWith(`${rule.tool}__`);
}

export interface RuleDecision {
  rule: ApprovalRule;
  layer: RuleLayer;
}

/**
 * The first rule of `effect` that covers the call, with the layer it came from.
 * A deny or an ask is looked for in every layer, and beats an allow: a
 * repository you did not write can tighten what Circle does, never loosen it.
 * So an allow is sought in the person's own file and this conversation only.
 */
export function decideRule(
  effect: RuleEffect,
  tool: string,
  words: string[],
  patterns: string[],
  sources: RuleSource[],
  mcp?: McpToolOwner,
): RuleDecision | undefined {
  const sought =
    effect === 'allow' ? sources.filter((s) => s.layer !== 'project') : sources;
  for (const source of sought)
    for (const rule of source.rules)
      if (
        rule.effect === effect &&
        ruleCovers(rule, tool, words, patterns, undefined, mcp, source.layer)
      )
        return { rule, layer: source.layer };
  return undefined;
}

/** Every rule that covers the call, whichever layer and effect, for the list. */
export function matchingRules(
  tool: string,
  words: string[],
  patterns: string[],
  sources: RuleSource[],
  mcp?: McpToolOwner,
): (RuleDecision & { path: string })[] {
  const found: (RuleDecision & { path: string })[] = [];
  for (const source of sources)
    for (const rule of source.rules)
      if (ruleCovers(rule, tool, words, patterns, undefined, mcp, source.layer))
        found.push({ rule, layer: source.layer, path: source.path });
  return found;
}

/** The rules one file holds, as the person wrote them. */
export const fileRules = readRules;

export function saveFileRules(path: string, rules: ApprovalRule[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateJson(path, { rules });
}

/**
 * Add a rule to a file. The same tool, pattern and effect twice is one rule:
 * the second add says so and changes nothing.
 */
export function addFileRule(
  path: string,
  rule: ApprovalRule,
): { ok: boolean; why: string; count: number } {
  const before = readRules(path);
  const seen = before.find(
    (found) =>
      found.tool === rule.tool &&
      found.pattern === rule.pattern &&
      found.effect === rule.effect,
  );
  if (seen) return { ok: false, why: 'already there', count: before.length };
  saveFileRules(path, [...before, rule]);
  return { ok: true, why: 'written', count: before.length + 1 };
}

/** Drop the numbered rule of the printed list: user file first, then project. */
export function dropFileRule(
  sources: RuleSource[],
  number: number,
): { rule: ApprovalRule; layer: RuleLayer } | undefined {
  let seen = 0;
  for (const source of sources)
    for (const rule of source.rules) {
      seen++;
      if (seen === number) {
        saveFileRules(
          source.path,
          source.rules.filter((found) => found !== rule),
        );
        return { rule, layer: source.layer };
      }
    }
  return undefined;
}

/** Where Circle records the migrations of the data folder it has made, so each is made once. */
const MIGRATIONS = 'migrations.json';
/**
 * Your approvals.json's rules written with the MCP tool names of the format before this one (`<server>_<tool>`),
 * rewritten once with the current ones (`mcp__<server>__<tool>`), for the servers of your own: those in your
 * settings, for every project and for one. An allow is renamed; a deny or an ask keeps its name, so it still applies
 * to whatever it named, and is added under the new one too. The file as it was is kept beside it as
 * `approvals.json.mcp-names.migrated`, and that this ran is recorded in migrations.json in the data folder. A
 * project's approvals.json is not rewritten: its deny written with an old name is read as denying the server's tool
 * too (ruleNames). Returns what was done.
 */
export function migrateMcpRuleNames(options: {
  home: string;
  servers: string[];
  reserved: Set<string>;
}): string[] {
  const record = join(options.home, MIGRATIONS);
  let done: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(readFileSync(record, 'utf8'));
    if (isRecord(value)) done = value;
  } catch {
    // Nothing recorded yet
  }
  if (done.mcpRuleNames !== undefined) return [];
  const notes: string[] = [];
  const file = join(options.home, 'approvals.json');
  if (existsSync(file)) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // A file that cannot be read is a layer that says nothing: it is tried again once it can be
      return notes;
    }
    if (!isRecord(value) || !Array.isArray(value.rules)) return notes;
    const rules: unknown[] = value.rules;
    const next: unknown[] = [];
    let changed = 0;
    const same = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      a.tool === b.tool && a.pattern === b.pattern && a.effect === b.effect;
    for (const entry of rules) {
      next.push(entry);
      if (!isRecord(entry) || typeof entry.tool !== 'string') continue;
      const current = currentMcpRuleTool(
        entry.tool,
        options.servers,
        options.reserved,
      );
      if (!current) continue;
      const renamed = { ...entry, tool: current };
      changed++;
      if (entry.effect === 'allow') next[next.length - 1] = renamed;
      else if (!rules.some((rule) => isRecord(rule) && same(rule, renamed)))
        next.push(renamed);
    }
    if (changed) {
      let kept = `${file}.mcp-names.migrated`;
      for (let n = 2; existsSync(kept); n++)
        kept = `${file}.mcp-names.migrated.${n}`;
      try {
        copyFileSync(file, kept);
        writePrivateJson(file, { ...value, rules: next });
      } catch (error) {
        return [
          `your approvals.json: the MCP tool names of its rules could not be rewritten: ${error instanceof Error ? error.message : String(error)}`,
        ];
      }
      notes.push(
        `your approvals.json: ${changed} rule${changed === 1 ? '' : 's'} now name MCP tools as mcp__<server>__<tool>, a deny under its old name as well; the file as it was is ${kept.split(/[\\/]/).at(-1)}`,
      );
    }
  }
  try {
    mkdirSync(options.home, { recursive: true });
    writePrivateJson(record, {
      ...done,
      mcpRuleNames: new Date().toISOString(),
    });
  } catch {
    // Not recorded: it runs again, and finds nothing left to rename
  }
  return notes;
}

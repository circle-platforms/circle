import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { matchPattern } from './file_patterns.js';
import { isRecord, writePrivateJson } from './settings.js';
import { currentMcpRuleTool } from './mcp_config.js';

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
export function ruleCovers(
  rule: ApprovalRule,
  tool: string,
  words: string[],
  patterns: string[],
  windows = process.platform === 'win32',
): boolean {
  if (!ruleNames(rule, tool)) return false;
  if (patterns.includes(rule.pattern)) return true;
  return (
    tool === 'execute' &&
    words.length > 0 &&
    words.every((segment) => matchPattern(rule.pattern, segment, windows))
  );
}

/**
 * Whether a rule's tool names this tool: the same name, `*` for every tool, or, for an MCP server's tools
 * (`mcp__<server>__<tool>`), the server alone, `mcp__<server>` or `mcp__<server>__*`, or a glob. An allow names a
 * server's tools only after `mcp__<server>__`, so it names a server you configured; a deny or an ask may use any glob,
 * such as `mcp__*`.
 */
function ruleNames(rule: ApprovalRule, tool: string): boolean {
  if (rule.tool === '*' || rule.tool === tool) return true;
  if (!tool.startsWith('mcp__') || !rule.tool.startsWith('mcp__')) return false;
  if (!rule.tool.includes('*'))
    // The server alone: every tool of it
    return (
      !rule.tool.slice(5).includes('__') && tool.startsWith(`${rule.tool}__`)
    );
  const server = /^mcp__(.+?)__/.exec(rule.tool)?.[1];
  if (rule.effect === 'allow' && (!server || server.includes('*')))
    return false;
  const escaped = rule.tool
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`).test(tool);
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
): RuleDecision | undefined {
  const sought =
    effect === 'allow' ? sources.filter((s) => s.layer !== 'project') : sources;
  for (const source of sought)
    for (const rule of source.rules)
      if (rule.effect === effect && ruleCovers(rule, tool, words, patterns))
        return { rule, layer: source.layer };
  return undefined;
}

/** Every rule that covers the call, whichever layer and effect, for the list. */
export function matchingRules(
  tool: string,
  words: string[],
  patterns: string[],
  sources: RuleSource[],
): (RuleDecision & { path: string })[] {
  const found: (RuleDecision & { path: string })[] = [];
  for (const source of sources)
    for (const rule of source.rules)
      if (ruleCovers(rule, tool, words, patterns))
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

/**
 * Rules written with the MCP tool names of the format before this one (`<server>_<tool>`) rewritten with the current
 * ones (`mcp__<server>__<tool>`), for the servers configured now: your approvals.json, the project's in a trusted
 * folder, and the rules each conversation kept. A file changed is first copied beside itself as
 * `<name>.mcp-names.migrated`. Returns what was done.
 */
export function migrateMcpRuleNames(options: {
  home: string;
  workspace: string;
  trusted: boolean;
  servers: string[];
  reserved: Set<string>;
}): string[] {
  const notes: string[] = [];
  if (!options.servers.length) return notes;
  const files = [
    ruleFileFor('user', options.home, options.workspace),
    ...(options.trusted
      ? [ruleFileFor('project', options.home, options.workspace)]
      : []),
  ];
  const sessions = join(options.home, 'approvals');
  if (existsSync(sessions))
    for (const name of readdirSync(sessions))
      if (/^[0-9a-f]{32}\.json$/.test(name)) files.push(join(sessions, name));
  for (const file of files) {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!isRecord(value)) continue;
    let changed = 0;
    const rename = (entry: unknown): unknown => {
      if (!isRecord(entry) || typeof entry.tool !== 'string') return entry;
      const current = currentMcpRuleTool(
        entry.tool,
        options.servers,
        options.reserved,
      );
      if (!current) return entry;
      changed++;
      return { ...entry, tool: current };
    };
    const next = {
      ...value,
      ...(Array.isArray(value.rules) ? { rules: value.rules.map(rename) } : {}),
      ...(Array.isArray(value.log) ? { log: value.log.map(rename) } : {}),
    };
    if (!changed) continue;
    let kept = `${file}.mcp-names.migrated`;
    for (let n = 2; existsSync(kept); n++)
      kept = `${file}.mcp-names.migrated.${n}`;
    try {
      copyFileSync(file, kept);
      writePrivateJson(file, next);
    } catch (error) {
      notes.push(
        `${file}: the MCP tool names of its rules could not be rewritten: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (dirname(file) !== sessions)
      notes.push(
        `${file}: ${changed} rule${changed === 1 ? '' : 's'} now name MCP tools as mcp__<server>__<tool>; the file as it was is ${kept.split(/[\\/]/).at(-1)}`,
      );
  }
  return notes;
}

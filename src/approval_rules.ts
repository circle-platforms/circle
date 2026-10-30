import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { matchPattern } from './file_patterns.js';
import { isRecord, writePrivateJson } from './settings.js';

// A rule names a tool, what it matches, and what to do about it. The layers are
// the person's own file, a file the project carries, and the rules this
// conversation kept from cards it answered.
export type RuleEffect = 'allow' | 'deny';
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
  const pattern = typeof entry.pattern === 'string' ? entry.pattern.trim() : '';
  const effect =
    entry.effect === 'deny' ? 'deny' : entry.effect === 'allow' ? 'allow' : '';
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
  if (rule.tool !== '*' && rule.tool !== tool) return false;
  if (patterns.includes(rule.pattern)) return true;
  return (
    tool === 'execute' &&
    words.length > 0 &&
    words.every((segment) => matchPattern(rule.pattern, segment, windows))
  );
}

export interface RuleDecision {
  rule: ApprovalRule;
  layer: RuleLayer;
}

/**
 * The first rule of `effect` that covers the call, with the layer it came from.
 * A deny is looked for in every layer, and a deny always beats an allow: a
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
    effect === 'deny' ? sources : sources.filter((s) => s.layer !== 'project');
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

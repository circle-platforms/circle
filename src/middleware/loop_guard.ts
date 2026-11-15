import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Message } from '../types.js';
import { envFlag } from '../model_guard.js';
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, ordered(value)]),
    );
  return value;
}
const fingerprint = (name: string, args: unknown): string =>
  createHash('sha1')
    .update(name + '::' + JSON.stringify(ordered(args)))
    .digest('hex')
    .slice(0, 16);
const empty = (content: string): boolean => {
  const low = content.trim().toLowerCase();
  return (
    !low ||
    (low.length <= 200 &&
      [
        '(no matches)',
        'no matches',
        'not found',
        'file empty',
        '(empty)',
        'no files found',
        'no results',
      ].some((marker) => low.includes(marker)))
  );
};
const integer = (name: string, fallback: number): number => {
  const value = Number(process.env[name] || fallback);
  return Number.isInteger(value) ? value : fallback;
};
export interface LoopStats {
  toolCalls: number;
  duplicate: number;
  emptyRounds: number;
  loose: number;
}
const READ_PAGE_KEYS = new Set([
  'offset',
  'limit',
  'head_limit',
  'page',
  'page_size',
  'start_line',
  'end_line',
  'char_offset',
  'char_limit',
]);

const MUTATING_FILE_TOOLS = new Set([
  'write_file',
  'write',
  'edit_file',
  'edit',
  'delete',
  'apply_patch',
]);

function lastRealUserIndex(messages: Message[]): number {
  return messages.findLastIndex(
    (message) =>
      message.role === 'user' &&
      !message.internal &&
      !message.content.trimStart().startsWith('<system-reminder'),
  );
}

function finiteNumber(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return posix.normalize(trimmed.replace(/\\/gu, '/'));
}

function mutatedPaths(name: string, args: Record<string, unknown>): string[] {
  const lower = name.toLowerCase();
  if (!MUTATING_FILE_TOOLS.has(lower)) return [];
  if (lower === 'apply_patch') {
    // The tool's own argument is patchText; patch is the alias a model may still write.
    const given = args.patchText ?? args.patch;
    const patch = typeof given === 'string' ? given : '';
    const found = new Set<string>();
    for (const match of patch.matchAll(
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gmu,
    )) {
      const normalized = normalizePath(match[1] ?? match[2]);
      if (normalized) found.add(normalized);
    }
    return [...found];
  }
  const normalized = normalizePath(args.file_path ?? args.path);
  return normalized ? [normalized] : [];
}

export function analyze(messages: Message[], window = 8): LoopStats {
  const lastUser = Math.max(0, lastRealUserIndex(messages));
  const slice = messages.slice(lastUser);
  const failedCallIds = new Set<string>();
  for (const message of slice)
    if (
      message.role === 'tool' &&
      message.status === 'error' &&
      message.tool_call_id
    )
      failedCallIds.add(message.tool_call_id);
  const calls: string[] = [];
  const loose: {
    key: string;
    path: string;
    offset: number;
    charOffset: number;
  }[] = [];
  const fileRevisions = new Map<string, number>();
  const rounds: boolean[][] = [];
  for (const message of slice) {
    if (message.tool_calls?.length) rounds.push([]);
    for (const call of message.tool_calls ?? []) {
      const lower = call.name.toLowerCase();
      const targetPath = normalizePath(call.args.file_path ?? call.args.path);
      const revision =
        lower.includes('read') && targetPath
          ? (fileRevisions.get(targetPath) ?? 0)
          : 0;
      calls.push(
        revision
          ? fingerprint(call.name, { ...call.args, __rev: revision })
          : fingerprint(call.name, call.args),
      );
      if (lower.includes('read')) {
        const args = Object.fromEntries(
          Object.entries(call.args).filter(([key]) => !READ_PAGE_KEYS.has(key)),
        );
        loose.push({
          key: fingerprint('loose::' + call.name, args),
          path: targetPath,
          offset: finiteNumber(
            call.args.offset || call.args.page || call.args.start_line || 0,
          ),
          charOffset: finiteNumber(call.args.char_offset || 0),
        });
      } else loose.push({ key: '', path: '', offset: 0, charOffset: 0 });
      if (!failedCallIds.has(call.id)) {
        const modified = mutatedPaths(call.name, call.args);
        if (modified.length) {
          const modifiedSet = new Set(modified);
          for (const path of modifiedSet)
            fileRevisions.set(path, (fileRevisions.get(path) ?? 0) + 1);
          for (const entry of loose)
            if (entry.path && modifiedSet.has(entry.path)) entry.key = '';
        }
      }
    }
    if (message.role === 'tool' && rounds.length)
      rounds.at(-1)!.push(empty(message.content));
  }
  const counts = new Map<string, number>();
  for (const key of calls.slice(-window))
    counts.set(key, (counts.get(key) ?? 0) + 1);
  const groups = new Map<string, { offset: number; charOffset: number }[]>();
  for (const call of loose.slice(-16))
    if (call.key)
      groups.set(call.key, [
        ...(groups.get(call.key) ?? []),
        { offset: call.offset, charOffset: call.charOffset },
      ]);
  let looseCount = 0;
  for (const positions of groups.values())
    if (
      positions.length > 1 &&
      !positions
        .slice(1)
        .every(
          (pos, index) =>
            pos.offset > positions[index]!.offset ||
            (pos.offset === positions[index]!.offset &&
              pos.charOffset > positions[index]!.charOffset),
        )
    )
      looseCount = Math.max(looseCount, positions.length);
  let emptyRounds = 0;
  for (const round of rounds.reverse()) {
    if (!round.length) continue;
    if (!round.every(Boolean)) break;
    emptyRounds++;
  }
  return {
    toolCalls: calls.length,
    duplicate: Math.max(0, ...counts.values()),
    emptyRounds,
    loose: looseCount,
  };
}
export function loopReminder(messages: Message[]): Message | undefined {
  if (!envFlag('CIRCLE_LOOP_GUARD') || messages.at(-1)?.role !== 'tool')
    return undefined;
  const window = integer('CIRCLE_LOOP_WINDOW', 8);
  const lastUser = lastRealUserIndex(messages);
  const previous = messages.findLastIndex(
    (message) => message.internal === 'loop-guard',
  );
  const sinceReminder = previous > lastUser;
  if (
    sinceReminder &&
    messages
      .slice(previous + 1)
      .filter((message) => message.role === 'assistant').length < window
  )
    return undefined;
  const stats = analyze(
    sinceReminder ? messages.slice(previous + 1) : messages,
    window,
  );
  const repeated =
    stats.duplicate >= integer('CIRCLE_LOOP_DUP_THRESHOLD', 3) ||
    stats.emptyRounds >= integer('CIRCLE_LOOP_EMPTY_THRESHOLD', 4) ||
    stats.loose >= 6;
  if (
    !repeated &&
    (sinceReminder || stats.toolCalls < integer('CIRCLE_LOOP_SOFT_BUDGET', 25))
  )
    return undefined;
  const content = repeated
    ? `You appear to be going in circles: ${stats.duplicate} duplicate calls, ${stats.emptyRounds} empty rounds, ${stats.loose} unordered reads. Retrying the same thing will not change the outcome. Answer from what you have, search differently or ask the user for the missing information.`
    : `This turn has made ${stats.toolCalls} tool calls without repeated or empty calls. This is not a request to stop. Carry on while each call brings new information.`;
  return {
    id: randomUUID(),
    role: 'user',
    content:
      '<system-reminder data-source="loop-guard">\n' +
      content +
      '\n</system-reminder>',
    internal: 'loop-guard',
  };
}

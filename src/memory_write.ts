import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { CONTEXT_FILE_CAP } from './memory_sources.js';
// The line itself lives in memory_line.ts, which imports no Node.js module so
// the desktop renderer can show the same line the core writes.
import { entryLine, MEMORY_LINE_MAX, today } from './memory_line.js';

/**
 * The memory Circle writes for itself: one dated line per fact, in a file that
 * the system prompt already reads whole. Nothing here runs on its own: a line is
 * written when the person says so, and taken back the same way.
 */
export { MEMORY_LINE_MAX } from './memory_line.js';
const HEADING = '# Memory';

export type MemoryScope = 'project' | 'account';

export interface MemoryTarget {
  scope: MemoryScope;
  path: string;
}

/** The two files `/memory` works on, in the order its list numbers them. */
export const memoryTargets = (
  workspace: string,
  home: string,
): MemoryTarget[] => [
  { scope: 'project', path: join(workspace, 'MEMORY.md') },
  { scope: 'account', path: join(home, 'MEMORY.md') },
];

export interface MemoryEntry {
  /** Which of the two files it came from, and its line there, one-based. */
  scope: MemoryScope;
  path: string;
  line: number;
  date: string;
  note: string;
  text: string;
}

// A line Circle wrote, and nothing else: the person's own text in the same file
// is left out of the list and left alone by a remove.
const ENTRY = /^- (\d{4}-\d{2}-\d{2}) \u00b7 (.+)$/;

const linesOf = (path: string): string[] | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf8').split('\n');
  } catch {
    return undefined;
  }
};

/** One of the two files, named by what it is for. */
export function memoryTargetFor(
  scope: MemoryScope,
  workspace: string,
  home: string,
): MemoryTarget {
  return scope === 'account'
    ? { scope, path: join(home, 'MEMORY.md') }
    : { scope, path: join(workspace, 'MEMORY.md') };
}

/** The entries of one file, with the line they sit on. */
export function memoryEntries(target: MemoryTarget): MemoryEntry[] {
  const lines = linesOf(target.path);
  if (!lines) return [];
  const found: MemoryEntry[] = [];
  lines.forEach((text, index) => {
    const match = ENTRY.exec(text);
    if (match)
      found.push({
        scope: target.scope,
        path: target.path,
        line: index + 1,
        date: match[1]!,
        note: match[2]!,
        text,
      });
  });
  return found;
}

/** The entries of both files, the project's first: the numbering `/memory remove` uses. */
export function allMemoryEntries(
  workspace: string,
  home: string,
): MemoryEntry[] {
  return memoryTargets(workspace, home).flatMap(memoryEntries);
}

/** What a file holds now, and what of it the prompt can read. */
export function memoryState(path: string): {
  exists: boolean;
  bytes: number;
  entries: number;
  overCap: boolean;
} {
  const lines = linesOf(path);
  if (!lines) return { exists: false, bytes: 0, entries: 0, overCap: false };
  const bytes = Buffer.byteLength(lines.join('\n'));
  return {
    exists: true,
    bytes,
    entries: memoryEntries({ scope: 'project', path }).length,
    overCap: bytes > CONTEXT_FILE_CAP,
  };
}

const write = (path: string, text: string): void => {
  mkdirParents(path);
  // The file keeps its own mode; a new one is readable only by you, since it
  // holds notes about your work and the data folder's copy sits beside keys.
  const mode = existsSync(path) ? statSync(path).mode : 0o600;
  const temporary = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, text, { mode });
  if (existsSync(path)) rmSync(path);
  renameSync(temporary, path);
  if (process.platform !== 'win32') chmodSync(path, mode);
};

function mkdirParents(path: string): void {
  // The data folder exists once Circle has run; a workspace's MEMORY.md sits
  // in a folder that is already there. Neither is assumed.
  mkdirSync(dirname(path), { recursive: true });
}

export interface MemoryChange {
  ok: boolean;
  why: string;
  entry?: MemoryEntry;
}

/**
 * Append one dated line. The note stays one line, the whole line stays short, a
 * line already there is not written twice, and the file is never left bigger
 * than the prompt can read: what will not be read should not be written.
 */
export function addMemory(
  target: MemoryTarget,
  note: string,
  at: string = today(),
): MemoryChange {
  const one = note.replace(/\s+/g, ' ').trim();
  if (!one) return { ok: false, why: 'write something to remember' };
  const line = entryLine(at, one);
  if (line.length > MEMORY_LINE_MAX)
    return {
      ok: false,
      why:
        'that line would be ' +
        line.length +
        ' characters; a memory line is at most ' +
        MEMORY_LINE_MAX +
        ' · say one thing, and add another line for the next',
    };
  const existing = linesOf(target.path);
  if (existing?.some((text) => text.trimEnd() === line))
    return { ok: false, why: 'that line is already in ' + target.path };
  // A file of the person's own is kept as it stands, with the line under what
  // is there. A new one starts with its heading and a blank line.
  const current = (existing ?? []).join('\n').replace(/\s+$/, '');
  const grown = current
    ? current + '\n' + line + '\n'
    : HEADING + '\n\n' + line + '\n';
  const bytes = Buffer.byteLength(grown);
  if (bytes > CONTEXT_FILE_CAP)
    return {
      ok: false,
      why:
        target.path +
        ' would hold ' +
        bytes +
        ' bytes, past the ' +
        CONTEXT_FILE_CAP +
        ' the prompt reads · take a line out with /memory remove, or trim the file',
    };
  write(target.path, grown);
  return {
    ok: true,
    why: 'written',
    entry: {
      scope: target.scope,
      path: target.path,
      line: grown.split('\n').indexOf(line) + 1,
      date: at,
      note: one,
      text: line,
    },
  };
}

/**
 * Take the numbered memory line out. The number counts the lines Circle wrote,
 * the project's first, and only those: text the person wrote themselves is
 * theirs to edit.
 */
export function removeMemory(
  workspace: string,
  home: string,
  number: number,
): MemoryChange {
  const entries = allMemoryEntries(workspace, home);
  const entry = entries[number - 1];
  if (!entry)
    return {
      ok: false,
      why:
        number > entries.length
          ? 'there ' +
            (entries.length === 1 ? 'is' : 'are') +
            ' only ' +
            entries.length +
            ' memory ' +
            (entries.length === 1 ? 'line' : 'lines') +
            ' now'
          : 'no memory line ' + number,
    };
  const lines = linesOf(entry.path);
  if (!lines) return { ok: false, why: 'that file is gone: ' + entry.path };
  const kept = [...lines.slice(0, entry.line - 1), ...lines.slice(entry.line)];
  const body = kept.join('\n');
  // A file left with only its heading was made by Circle: take it away again.
  if (body.replace(/\s/g, '') === HEADING.replace(/\s/g, ''))
    rmSync(entry.path, { force: true });
  else write(entry.path, body);
  return { ok: true, why: 'removed', entry };
}

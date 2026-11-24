import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { glob } from 'glob';
import type { Sandbox } from './sandbox.js';
import { MAX_LINE_CHARS } from './file_read.js';

export const GREP_DEFAULT_MAX_COUNT = 1000;
const GREP_WINDOW_CHARS = 240;
const GREP_WINDOWS = 5;
const lowSurrogate = (text: string, at: number): boolean =>
  /[\uDC00-\uDFFF]/.test(text[at] ?? '');
export function matchedLine(line: string, pattern: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  const length = Array.from(line).length;
  if (length <= MAX_LINE_CHARS) return line;
  const windows: string[] = [];
  let hits = 0;
  for (
    let at = line.indexOf(pattern);
    at >= 0;
    at = line.indexOf(pattern, at + Math.max(1, pattern.length))
  ) {
    hits++;
    if (windows.length >= GREP_WINDOWS) continue;
    let start = Math.max(0, at - GREP_WINDOW_CHARS);
    if (lowSurrogate(line, start)) start--;
    let end = Math.min(line.length, at + pattern.length + GREP_WINDOW_CHARS);
    if (lowSurrogate(line, end)) end++;
    const offset = Array.from(line.slice(0, start)).length;
    windows.push(
      `    char_offset ${offset}: ${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`,
    );
  }
  return `[line of ${length} characters with ${hits} match${hits === 1 ? '' : 'es'}${hits > windows.length ? `, the first ${windows.length} shown` : ''}; read_file with char_offset and char_limit reads more of it]\n${windows.join('\n')}`;
}
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESULT_LIMIT = 20000 * 4;
const TRUNCATION_GUIDANCE =
  '... [results truncated, try being more specific with your parameters]';
export const GREP_TRUNCATION_NOTE =
  'Note: the search stopped early at the maximum match count. ' +
  'The matches above are valid but incomplete. Narrow the search (a more specific pattern or a ' +
  'narrower path), or raise max_count, to see the rest.';
const SKIP_REASONS = ['too_big', 'not_utf8', 'unreadable'] as const;
type SkipReason = (typeof SKIP_REASONS)[number];
const SKIP_LABELS: Record<SkipReason, string> = {
  too_big: `over the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit`,
  not_utf8: 'not UTF-8 text',
  unreadable: 'not readable',
};
function notSearchedNote(counts: Record<SkipReason, number>): string {
  const missed = SKIP_REASONS.reduce((sum, reason) => sum + counts[reason], 0);
  if (!missed) return '';
  const parts = SKIP_REASONS.filter((reason) => counts[reason] > 0).map(
    (reason) => `${counts[reason]} ${SKIP_LABELS[reason]}`,
  );
  return (
    `Note: ${missed} ${missed === 1 ? 'file was' : 'files were'} not searched ` +
    `(${parts.join(', ')}). A match could be in one of them: narrow the path or glob, ` +
    'or open the file with read_file.'
  );
}
const REGEX_HINT =
  'Note: grep matches literal text, not regex, so characters like ' +
  '`|`, `.*`, and `\\.` are searched verbatim. Search for the literal ' +
  'text you need instead; for `|` alternation, run a separate search ' +
  'per alternative.';
const OUTPUT_MODES = ['files_with_matches', 'content', 'count'] as const;
type OutputMode = (typeof OUTPUT_MODES)[number];

export const GREP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    pattern: {
      type: 'string',
      description: 'Text pattern to search for (literal string, not regex).',
    },
    path: {
      type: 'string',
      description:
        'Directory to search in. Defaults to current working directory.',
    },
    glob: {
      type: 'string',
      description:
        "File filter, not a regex and not the glob tool. No '/' matches the file name at any depth; '/' matches the path from the search root. Brace expansion is not reliable.",
    },
    output_mode: {
      type: 'string',
      enum: [...OUTPUT_MODES],
      default: 'files_with_matches',
      description:
        "files_with_matches (default): file paths. content: matching lines as '<line>: <text>'. count: '<path>: <n>'.",
    },
    max_count: {
      type: 'integer',
      minimum: 1,
      description:
        'Cap on matches across all files. Unset uses the default. A hit cap truncates and says so.',
    },
  },
  required: ['pattern'],
  additionalProperties: false,
};

function includeMatcher(pattern: string): (rel: string) => boolean {
  if (pattern.replaceAll('\\', '/').split('/').includes('..'))
    throw new Error(`Path traversal not allowed in glob pattern '${pattern}'`);
  const anchored = pattern.includes('/');
  const compiled = pattern.replace(/^\/+/, '');
  return (rel) =>
    posix.matchesGlob(anchored ? rel : posix.basename(rel), compiled);
}

function looksLikeRegex(pattern: string): boolean {
  return /\||\.\*|\.\+|\\[.wWdDsSbB(){}[\]|+*?^$]/.test(pattern);
}

function truncate(text: string): string {
  return text.length > RESULT_LIMIT
    ? text.slice(0, RESULT_LIMIT - TRUNCATION_GUIDANCE.length - 1) +
        '\n' +
        TRUNCATION_GUIDANCE
    : text;
}

function inside(root: string, path: string): string | undefined {
  const rel = relative(root, path);
  return rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)
    ? undefined
    : rel;
}

function pathShower(sandbox: Sandbox): (path: string) => string {
  const roots = [sandbox.offloadRoot, sandbox.workspace]
    .filter((root): root is string => Boolean(root))
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    });
  return (path) => {
    for (const root of roots) {
      const rel = inside(root, path);
      if (rel !== undefined) return '/' + rel.split(sep).join('/');
    }
    return path.split(sep).join('/');
  };
}

type Read = { data: Buffer } | { skip: SkipReason } | { excluded: true };

// Resolve symlinks only for symlink entries: on Windows per-file realpathSync dominates tree scan time.
export function readSearchableFile(
  sandbox: Sandbox,
  file: string,
  root: string,
  directory: boolean,
): Read {
  try {
    const info = lstatSync(file);
    if (sandbox.isCredentialPath(file)) return { excluded: true };
    let data: Buffer;
    if (info.isSymbolicLink()) {
      const real = realpathSync(file);
      if (directory && inside(root, real) === undefined)
        return { excluded: true };
      if (sandbox.isCredentialPath(real)) return { excluded: true };
      const target = statSync(real);
      if (target.isDirectory()) return { excluded: true };
      if (target.size > MAX_FILE_BYTES) return { skip: 'too_big' };
      data = readFileSync(real);
    } else {
      if (info.size > MAX_FILE_BYTES) return { skip: 'too_big' };
      data = readFileSync(file);
    }
    if (data.includes(0)) return { excluded: true };
    return { data };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { excluded: true };
    return { skip: 'unreadable' };
  }
}

export async function grepSearch(
  sandbox: Sandbox,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<string> {
  if (typeof args.pattern !== 'string')
    throw new Error('missing string parameter: pattern');
  const pattern = args.pattern;
  const mode = (args.output_mode ?? 'files_with_matches') as OutputMode;
  if (!OUTPUT_MODES.includes(mode))
    throw new Error(
      `output_mode must be one of ${OUTPUT_MODES.join(', ')}, not ${String(mode)}`,
    );
  const cap =
    args.max_count === undefined || args.max_count === null
      ? GREP_DEFAULT_MAX_COUNT
      : Number(args.max_count);
  if (!Number.isInteger(cap) || cap < 1)
    throw new Error('max_count must be a positive integer');
  const matcher =
    typeof args.glob === 'string' && args.glob
      ? includeMatcher(args.glob)
      : undefined;
  const base = sandbox.resolvePath(
    typeof args.path === 'string' && args.path ? args.path : '.',
  );
  let files: string[] = [];
  let root = base;
  let directory = false;
  try {
    if (statSync(base).isDirectory()) {
      directory = true;
      root = realpathSync(base);
      files = (
        await glob('**/*', {
          cwd: root,
          nodir: true,
          dot: true,
          ignore: ['**/.git/**', '**/node_modules/**'],
          follow: false,
          posix: true,
        })
      ).sort();
      if (matcher) files = files.filter((rel) => matcher(rel));
      files = files.map((rel) => join(root, rel));
    } else files = [base];
  } catch {
    files = []; // a path that does not exist has no matches
  }
  const show = pathShower(sandbox);
  const results = new Map<string, [number, string][]>();
  const counts: Record<SkipReason, number> = {
    too_big: 0,
    not_utf8: 0,
    unreadable: 0,
  };
  // Raw byte pre-filter only works for ASCII patterns because non-ASCII encodings (e.g. GBK) differ from UTF-8 bytes.
  const needle = Buffer.from(pattern, 'utf8');
  const bytesFirst = needle.every((byte) => byte < 0x80);
  let total = 0;
  let truncated = false;
  search: for (const file of files) {
    signal.throwIfAborted();
    const read = readSearchableFile(sandbox, file, root, directory);
    if ('excluded' in read) continue;
    if ('skip' in read) {
      counts[read.skip]++;
      continue;
    }
    if (bytesFirst && !read.data.includes(needle)) continue;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(read.data);
    } catch {
      counts.not_utf8++;
      continue;
    }
    if (!bytesFirst && !text.includes(pattern)) continue;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    const shown = show(file);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.replace(/\r$/, '');
      if (!line.includes(pattern)) continue;
      if (total >= cap) {
        truncated = true;
        break search;
      }
      if (!results.has(shown)) results.set(shown, []);
      results.get(shown)!.push([index + 1, line]);
      total++;
    }
  }
  let body: string;
  const paths = [...results.keys()].sort();
  if (!paths.length) body = 'No matches found';
  else if (mode === 'files_with_matches') body = paths.join('\n');
  else if (mode === 'count')
    body = paths
      .map((path) => `${path}: ${results.get(path)!.length}`)
      .join('\n');
  else
    body = paths
      .flatMap((path) => [
        `${path}:`,
        ...results
          .get(path)!
          .map(([line, text]) => `  ${line}: ${matchedLine(text, pattern)}`),
      ])
      .join('\n');
  body = truncate(body);
  const notes: string[] = [];
  const missed = notSearchedNote(counts);
  if (missed) notes.push(missed);
  if (truncated) notes.push(GREP_TRUNCATION_NOTE);
  if (!paths.length && looksLikeRegex(pattern)) notes.push(REGEX_HINT);
  return notes.length ? `${body}\n\n${notes.join('\n\n')}` : body;
}

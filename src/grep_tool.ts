// The grep tool, as deepagents' filesystem middleware defines it: a
// literal (not regex) search, `output_mode` files_with_matches (the default), content or
// count, and a total cap on matches (`max_count`, 1000 unless the call asks otherwise).
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { glob } from 'glob';
import type { Sandbox } from './sandbox.js';

export const GREP_DEFAULT_MAX_COUNT = 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const RESULT_LIMIT = 20000 * 4;
const TRUNCATION_GUIDANCE =
  '... [results truncated, try being more specific with your parameters]';
export const GREP_TRUNCATION_NOTE =
  'Note: the search stopped early at the maximum match count. ' +
  'The matches above are valid but incomplete. Narrow the search (a more specific pattern or a ' +
  'narrower path), or raise max_count, to see the rest.';
// A file the scan could not look inside is a false "no matches" waiting to happen, so the
// reason is counted and told. Binary content and credential files are declared exclusions
// (docs/tools.md) and stay out of the count, as do .git and node_modules in the walk.
const SKIP_REASONS = ['too_big', 'not_utf8', 'unreadable'] as const;
type SkipReason = (typeof SKIP_REASONS)[number];
const SKIP_LABELS: Record<SkipReason, string> = {
  too_big: `over the ${MAX_FILE_BYTES / (1024 * 1024)} MB limit`,
  not_utf8: 'not UTF-8 text',
  unreadable: 'not readable',
};
/** One line saying what the scan did not cover, or an empty string when it covered the rest. */
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

// A pattern without '/' matches the file name at any depth; one with '/' matches the path
// relative to the search root, and a leading '/' anchors it there.
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

// How a path is shown to the model: '/' and the path inside the folder Circle works in (or
// inside the data folder's offload root), else the real absolute path.
function pathShower(sandbox: Sandbox): (path: string) => string {
  const roots = [sandbox.offloadRoot, sandbox.workspace]
    .filter((root): root is string => Boolean(root))
    .map((root) => {
      try {
        return realpathSync(root);
      } catch {
        return root; // a root that does not exist yet holds nothing
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

// What one file gave the search: its bytes, a reason the model should hear about, or an
// exclusion the rules state up front (a credential file, binary content, a link out of the root).
type Read = { data: Buffer } | { skip: SkipReason } | { excluded: true };

/** Read one file for the search. Only a link pays for path resolution: on Windows a
 * `realpathSync` costs about as much again as reading the file, so a scan of a big tree is
 * floored by it, and the search root is already resolved. */
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
      // A link that leads out of the search root is not followed.
      if (directory && inside(root, real) === undefined)
        return { excluded: true };
      if (sandbox.isCredentialPath(real)) return { excluded: true };
      const target = statSync(real);
      // A link to a folder is not a file to read: the walk does not follow it.
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
    // The walk saw it, the read did not: deleted while the search ran, so there is
    // nothing there to have missed. Anything else is a refusal worth telling the model about.
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
  // An ASCII pattern is the same bytes in any 8-bit encoding, so a byte search for it cannot
  // miss a line a decoded search would have found. A non-ASCII pattern would miss text stored
  // as GBK, so there the decode below is the filter instead.
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
    // The byte search is what makes a full scan cheap: most files in a tree hold nothing the
    // question is about, and decoding and splitting those was the cost.
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
        ...results.get(path)!.map(([line, text]) => `  ${line}: ${text}`),
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

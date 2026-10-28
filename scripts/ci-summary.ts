// Markdown for a CI job's step summary, from files the test runner wrote:
//   tsx scripts/ci-summary.ts timings <junit.xml>   the slowest test files
//   tsx scripts/ci-summary.ts coverage <lcov.info>  line, branch and function coverage
// Both print to stdout; the workflow appends it to $GITHUB_STEP_SUMMARY.
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export interface FileTiming {
  file: string;
  tests: number;
  seconds: number;
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name[0] === '#')
      return String.fromCodePoint(
        name[1] === 'x' || name[1] === 'X'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10),
      );
    return entities[name] ?? whole;
  });
}

function attributes(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of text.matchAll(/([\w:-]+)="([^"]*)"/g))
    found[match[1]!] = unescape(match[2]!);
  return found;
}

/**
 * Test time per file from Node's junit reporter: the sum of each file's
 * top-level tests and suites (their nested tests are already inside those
 * times), so a file's own setup outside any test is not counted. A suite
 * carries no file of its own; it takes the file of the first test in it.
 */
export function fileTimings(junit: string, root = process.cwd()): FileTiming[] {
  const files = new Map<string, FileTiming>();
  let depth = 0;
  let top: { file?: string; seconds: number } | undefined;
  const commit = () => {
    if (top?.file) {
      const name = relative(root, resolve(root, top.file)).replaceAll(
        '\\',
        '/',
      );
      const entry = files.get(name) ?? { file: name, tests: 0, seconds: 0 };
      entry.tests++;
      entry.seconds += top.seconds;
      files.set(name, entry);
    }
    top = undefined;
  };
  // An attribute value may hold '>' unescaped, as Node writes a name like 'a <b>'
  for (const match of junit.matchAll(
    /<(\/?)(testsuites|testsuite|testcase)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g,
  )) {
    const [, closing, tag, body, selfClosing] = match;
    if (tag === 'testsuites') continue;
    if (closing) {
      if (--depth === 0) commit();
      continue;
    }
    const { file, time } = attributes(body!);
    if (depth === 0) top = { file, seconds: Number(time) || 0 };
    else if (top && !top.file) top.file = file;
    if (selfClosing) {
      if (depth === 0) commit();
    } else depth++;
  }
  return [...files.values()].sort((a, b) => b.seconds - a.seconds);
}

export function timingsMarkdown(timings: FileTiming[], limit = 15): string {
  if (timings.length === 0)
    return '### Slowest test files\n\nNo test results.\n';
  const total = timings.reduce((sum, entry) => sum + entry.seconds, 0);
  const rows = timings
    .slice(0, limit)
    .map(
      (entry, index) =>
        `| ${index + 1} | \`${entry.file}\` | ${entry.tests} | ${entry.seconds.toFixed(1)} | ${((entry.seconds / total) * 100).toFixed(1)}% |`,
    );
  return [
    `### Slowest test files`,
    '',
    `${timings.length} files, ${total.toFixed(1)} s of test time in all. Files run in parallel, so the suite takes less wall-clock time than this; one file's time is the floor.`,
    '',
    '| # | File | Top-level tests | Seconds | Share |',
    '|---:|---|---:|---:|---:|',
    ...rows,
    '',
  ].join('\n');
}

export interface FileCoverage {
  file: string;
  lines: [number, number];
  branches: [number, number];
  functions: [number, number];
}

/** Found/hit counts per source file from an lcov tracefile. */
export function lcovFiles(lcov: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: FileCoverage | undefined;
  for (const line of lcov.split(/\r?\n/)) {
    const [key, value = ''] = line.split(/:(.*)/s);
    if (key === 'SF')
      current = {
        file: value.replaceAll('\\', '/'),
        lines: [0, 0],
        branches: [0, 0],
        functions: [0, 0],
      };
    else if (!current) continue;
    else if (key === 'LF') current.lines[0] = Number(value);
    else if (key === 'LH') current.lines[1] = Number(value);
    else if (key === 'BRF') current.branches[0] = Number(value);
    else if (key === 'BRH') current.branches[1] = Number(value);
    else if (key === 'FNF') current.functions[0] = Number(value);
    else if (key === 'FNH') current.functions[1] = Number(value);
    else if (key === 'end_of_record') {
      files.push(current);
      current = undefined;
    }
  }
  return files;
}

function percent([found, hit]: [number, number]): string {
  return found === 0 ? '-' : `${((hit / found) * 100).toFixed(1)}%`;
}

function sum(files: FileCoverage[], key: 'lines' | 'branches' | 'functions') {
  return files.reduce<[number, number]>(
    ([found, hit], file) => [found + file[key][0], hit + file[key][1]],
    [0, 0],
  );
}

export function coverageMarkdown(files: FileCoverage[], limit = 25): string {
  if (files.length === 0) return '### Coverage\n\nNo coverage data.\n';
  const lines = sum(files, 'lines');
  const rows = [...files]
    .sort(
      (a, b) =>
        b.lines[0] - b.lines[1] - (a.lines[0] - a.lines[1]) ||
        a.file.localeCompare(b.file),
    )
    .slice(0, limit)
    .map(
      (file) =>
        `| \`${file.file}\` | ${file.lines[0] - file.lines[1]} | ${percent(file.lines)} | ${percent(file.branches)} | ${percent(file.functions)} |`,
    );
  return [
    '### Coverage',
    '',
    `${files.length} source files loaded by the suite (files no test imports are not listed). Information only; it does not gate a merge.`,
    '',
    '| | Lines | Branches | Functions |',
    '|---|---:|---:|---:|',
    `| All files | ${percent(lines)} (${lines[1]}/${lines[0]}) | ${percent(sum(files, 'branches'))} | ${percent(sum(files, 'functions'))} |`,
    '',
    `Files with the most uncovered lines:`,
    '',
    '| File | Uncovered lines | Lines | Branches | Functions |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    '',
  ].join('\n');
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  const [kind, path] = process.argv.slice(2);
  if (!path || (kind !== 'timings' && kind !== 'coverage')) {
    console.error(
      'usage: ci-summary.ts timings <junit.xml> | coverage <lcov.info>',
    );
    process.exit(2);
  }
  const text = readFileSync(path, 'utf8');
  process.stdout.write(
    kind === 'timings'
      ? timingsMarkdown(fileTimings(text))
      : coverageMarkdown(lcovFiles(text)),
  );
}

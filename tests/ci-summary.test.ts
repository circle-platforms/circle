import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coverageMarkdown,
  fileTimings,
  lcovFiles,
  timingsMarkdown,
} from '../scripts/ci-summary.js';
import { scratch } from './helpers.js';

// Without the parent runner's context, the child runs its own reporters instead of
// reporting to the parent
const { NODE_TEST_CONTEXT: _, ...env } = process.env;

// Node's own reporters write the files, so the parser is held to what CI produces
function runReporters(root: string, reporter: string, extra: string[] = []) {
  const output = join(root, `report.${reporter}`);
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=' + reporter,
      '--test-reporter-destination=' + output,
      ...extra,
      'slow.test.mjs',
      'quick.test.mjs',
    ],
    { cwd: root, encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(output, 'utf8');
}

function fixture(t: Parameters<typeof scratch>[0]): string {
  // Real path: the reporter writes it, and macOS's temporary folder is a link
  const root = realpathSync(scratch(t, 'circle-ci-summary-'));
  writeFileSync(
    join(root, 'slow.test.mjs'),
    `import { test, describe } from 'node:test';
import { half } from './lib.mjs';
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
describe('a suite & its <cases>', () => {
  test('one', async () => { await wait(150); });
  test('two', async () => { await wait(150); });
});
test('alone', async () => { await wait(100); half(2); });
`,
  );
  writeFileSync(
    join(root, 'quick.test.mjs'),
    `import { test } from 'node:test';
test('fast', () => {});
`,
  );
  writeFileSync(
    join(root, 'lib.mjs'),
    `export function half(n) {
  if (n > 0) return n / 2;
  return 0;
}
export function unused() {
  return 1;
}
`,
  );
  return root;
}

test('the slowest files come first, counting each top-level test or suite once', (t) => {
  const root = fixture(t);
  const timings = fileTimings(runReporters(root, 'junit'), root);
  assert.deepEqual(
    timings.map(({ file, tests }) => ({ file, tests })),
    [
      { file: 'slow.test.mjs', tests: 2 },
      { file: 'quick.test.mjs', tests: 1 },
    ],
  );
  const slow = timings[0]!.seconds;
  // 150 + 150 + 100 ms of waiting; nested tests are not added to their suite again
  assert.ok(slow >= 0.39 && slow < 2, `slow.test.mjs took ${slow}s`);
  const markdown = timingsMarkdown(timings, 1);
  assert.match(markdown, /2 files, [\d.]+ s of test time/);
  assert.match(markdown, /\| 1 \| `slow\.test\.mjs` \| 2 \| /);
  assert.doesNotMatch(markdown, /quick\.test\.mjs/);
  assert.match(timingsMarkdown([]), /No test results/);
});

test('coverage sums lcov counts and lists the files with the most uncovered lines', (t) => {
  const root = fixture(t);
  const files = lcovFiles(
    runReporters(root, 'lcov', [
      '--experimental-test-coverage',
      '--test-coverage-include=lib.mjs',
    ]),
  );
  assert.equal(files.length, 1);
  const lib = files[0]!;
  assert.match(lib.file, /lib\.mjs$/);
  assert.deepEqual(lib.functions, [2, 1]);
  assert.ok(
    lib.lines[1] < lib.lines[0],
    'unused() and the fallback are not run',
  );
  assert.ok(lib.branches[0] > 0);

  const markdown = coverageMarkdown([
    { file: 'src/a.ts', lines: [10, 5], branches: [4, 1], functions: [2, 2] },
    { file: 'src/b.ts', lines: [100, 90], branches: [0, 0], functions: [5, 4] },
  ]);
  assert.match(
    markdown,
    /\| All files \| 86\.4% \(95\/110\) \| 25\.0% \| 85\.7% \|/,
  );
  // b.ts has more uncovered lines (10) than a.ts (5), so it comes first
  assert.ok(markdown.indexOf('src/b.ts') < markdown.indexOf('src/a.ts'));
  assert.match(markdown, /\| `src\/b\.ts` \| 10 \| 90\.0% \| - \| 80\.0% \|/);
  assert.match(coverageMarkdown([]), /No coverage data/);
});

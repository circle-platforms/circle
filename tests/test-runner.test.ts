import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  FLAKY_ANNOTATION_LIMIT,
  flakyTests,
  reportFlakyTests,
} from '../scripts/flaky-tests.js';
import { runTests } from '../scripts/test.js';
import { scratch } from './helpers.js';

function suite(t: Parameters<typeof scratch>[0]) {
  const directory = scratch(t, 'circle-test-runner-');
  const runs = join(directory, 'runs.log');
  writeFileSync(
    join(directory, 'flaky.test.ts'),
    `import { describe, test } from 'node:test';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const log = (name: string) => appendFileSync(${JSON.stringify(runs)}, name + '\\n');
test('steady', () => log('steady'));
describe('group', () => {
  test('fails once', () => {
    log('fails once');
    if (!existsSync('failed-once')) {
      writeFileSync('failed-once', '');
      throw Error('first attempt fails');
    }
  });
});
`,
  );
  writeFileSync(
    join(directory, 'broken.test.ts'),
    `import { test } from 'node:test';
test('always fails', () => { throw Error('every attempt fails'); });
`,
  );
  writeFileSync(
    join(directory, 'nested-steady.test.ts'),
    `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
const log = (name: string) => appendFileSync(${JSON.stringify(runs)}, name + '\\n');
test('stable parent', async (t) => {
  await t.test('stable child', () => log('stable child'));
  await t.test('another stable child', () => log('another stable child'));
});
`,
  );
  writeFileSync(
    join(directory, 'nested-flaky.test.ts'),
    `import { test } from 'node:test';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const log = (name: string) => appendFileSync(${JSON.stringify(runs)}, name + '\\n');
test('parent with failure', async (t) => {
  await t.test('stable sibling', () => log('stable sibling'));
  await t.test('flaky child', () => {
    log('flaky child');
    if (!existsSync('nested-failed-once')) {
      writeFileSync('nested-failed-once', '');
      throw Error('first attempt fails');
    }
  });
});
`,
  );
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const lines: string[] = [];
  const summaryFile = join(directory, 'summary.md');
  writeFileSync(summaryFile, '');
  const run = (files: string[], ci = true) =>
    runTests({
      files,
      ci,
      cwd: directory,
      env,
      stdio: 'pipe',
      log: (line) => lines.push(line),
      summaryFile,
    });
  return { directory, runs, lines, summaryFile, run };
}

test('on CI a test that passes only when it runs again is named in a warning and the job summary', (t) => {
  const { runs, lines, summaryFile, run } = suite(t);
  assert.equal(run(['flaky.test.ts']), 0);
  assert.deepEqual(readFileSync(runs, 'utf8').trim().split('\n'), [
    'steady',
    'fails once',
    'fails once',
  ]);
  const warnings = lines.filter((line) => line.startsWith('::warning'));
  assert.deepEqual(warnings, [
    '::warning title=flaky test::flaky.test.ts › group › fails once',
  ]);
  const summary = readFileSync(summaryFile, 'utf8');
  assert.match(summary, /### Flaky tests in the suite/);
  assert.match(summary, /\| flaky\.test\.ts \| group › fails once \|/);
  assert.doesNotMatch(summary, /steady/);
});

test('on CI a test that fails every time still fails the run and warns of nothing', (t) => {
  const { lines, summaryFile, run } = suite(t);
  assert.equal(run(['flaky.test.ts', 'broken.test.ts']), 1);
  assert.ok(
    lines.includes('# the suite failed; running only its failed tests again'),
  );
  assert.deepEqual(
    lines.filter((line) => line.startsWith('::warning')),
    [],
  );
  assert.equal(readFileSync(summaryFile, 'utf8'), '');
});

test('replayed passing subtests in another file are not reported as flaky', (t) => {
  const { runs, lines, summaryFile, run } = suite(t);
  assert.equal(run(['flaky.test.ts', 'nested-steady.test.ts']), 0);
  const executions = readFileSync(runs, 'utf8').trim().split('\n');
  assert.equal(executions.filter((name) => name === 'stable child').length, 1);
  assert.equal(
    executions.filter((name) => name === 'another stable child').length,
    1,
  );
  assert.deepEqual(
    lines.filter((line) => line.startsWith('::warning')),
    ['::warning title=flaky test::flaky.test.ts › group › fails once'],
  );
  assert.doesNotMatch(readFileSync(summaryFile, 'utf8'), /stable child/);
});

test('a failing child is named while its passing sibling stays unreported', (t) => {
  const { runs, lines, summaryFile, run } = suite(t);
  assert.equal(run(['nested-flaky.test.ts']), 0);
  const executions = readFileSync(runs, 'utf8').trim().split('\n');
  assert.equal(
    executions.filter((name) => name === 'stable sibling').length,
    1,
  );
  assert.equal(executions.filter((name) => name === 'flaky child').length, 2);
  assert.deepEqual(
    lines.filter((line) => line.startsWith('::warning')),
    [
      '::warning title=flaky test::nested-flaky.test.ts › parent with failure › flaky child',
    ],
  );
  assert.doesNotMatch(readFileSync(summaryFile, 'utf8'), /stable sibling/);
});

test('outside CI a failing test runs once and fails the run', (t) => {
  const { runs, lines, run } = suite(t);
  assert.equal(run(['flaky.test.ts'], false), 1);
  assert.deepEqual(readFileSync(runs, 'utf8').trim().split('\n'), [
    'steady',
    'fails once',
  ]);
  assert.deepEqual(lines, []);
});

test('only the first ten flaky tests become annotations; the summary lists all', (t) => {
  const { directory, lines, summaryFile } = suite(t);
  const state = join(directory, 'state.json');
  const entries = Object.fromEntries(
    Array.from({ length: 12 }, (_, index) => [
      `tests/many.test.ts:${index + 1}:1`,
      { name: `case ${index + 1}`, children: [], passed_on_attempt: 1 },
    ]),
  );
  writeFileSync(state, JSON.stringify([{}, entries]));
  const flaky = flakyTests(state);
  assert.equal(flaky.length, 12);
  reportFlakyTests(flaky, { log: (line) => lines.push(line), summaryFile });
  assert.equal(
    lines.filter((line) => line.startsWith('::warning')).length,
    FLAKY_ANNOTATION_LIMIT,
  );
  assert.match(lines.at(-1)!, /^# 2 more flaky tests: .*case 11; .*case 12$/);
  assert.equal(
    readFileSync(summaryFile, 'utf8').match(/\| tests\/many\.test\.ts \|/g)
      ?.length,
    12,
  );
});

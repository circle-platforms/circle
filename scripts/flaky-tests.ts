// Name the tests that failed and then passed when a CI run went again with
// --test-rerun-failures. Node's state file holds one object per attempt,
// keyed `<file>:<line>:<column>`; in the last attempt a test that passed only
// on a rerun has `passed_on_attempt` above 0. Used by `npm test`
// (scripts/test.ts) and the desktop runtime stages, which import this file
// with Node's own type stripping.
import { appendFileSync, readFileSync } from 'node:fs';

export interface FlakyTest {
  file: string;
  name: string;
}

interface StateEntry {
  name: string;
  passed_on_attempt: number;
  children?: { line: number; column: number }[];
}

// GitHub keeps at most ten warning annotations of a step.
export const FLAKY_ANNOTATION_LIMIT = 10;

export function flakyTests(stateFile: string): FlakyTest[] {
  let attempts: Record<string, StateEntry>[];
  try {
    attempts = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch {
    return [];
  }
  const last = attempts.at(-1) ?? {};
  const where = (key: string) => {
    const match = /^(.*):\d+:\d+$/.exec(key);
    return match ? match[1]! : key;
  };
  const parent = new Map<string, string>();
  for (const [key, entry] of Object.entries(last))
    for (const child of entry.children ?? [])
      parent.set(`${where(key)}:${child.line}:${child.column}`, key);
  const failed = Object.keys(last).filter(
    (key) => last[key]!.passed_on_attempt > 0,
  );
  // A suite or a test with subtests reruns with the subtest that failed;
  // name the innermost one.
  const outer = new Set(
    failed.map((key) => parent.get(key)).filter((key) => key !== undefined),
  );
  return failed
    .filter((key) => !outer.has(key))
    .map((key) => {
      const names = [];
      for (let at: string | undefined = key; at; at = parent.get(at))
        names.unshift(last[at]?.name ?? '?');
      return { file: where(key), name: names.join(' › ') };
    });
}

// Workflow command data must escape %, CR and LF.
const escape = (text: string) =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Warn about each flaky test (annotations for the first ten) and add a table
 * of all of them to the job summary when `summaryFile` is set.
 */
export function reportFlakyTests(
  tests: FlakyTest[],
  {
    stage,
    log = console.log,
    summaryFile = process.env.GITHUB_STEP_SUMMARY,
  }: { stage?: string; log?: (line: string) => void; summaryFile?: string },
) {
  const what = stage ? `runtime stage ${stage}` : 'the suite';
  if (!tests.length) {
    log(
      `::warning title=flaky test::${escape(`${what} passed only when its failed tests ran again; the failed tests could not be named`)}`,
    );
    return;
  }
  for (const test of tests.slice(0, FLAKY_ANNOTATION_LIMIT))
    log(`::warning title=flaky test::${escape(`${test.file} › ${test.name}`)}`);
  if (tests.length > FLAKY_ANNOTATION_LIMIT)
    log(
      `# ${tests.length - FLAKY_ANNOTATION_LIMIT} more flaky tests: ${tests
        .slice(FLAKY_ANNOTATION_LIMIT)
        .map((test) => `${test.file} › ${test.name}`)
        .join('; ')}`,
    );
  if (summaryFile)
    appendFileSync(
      summaryFile,
      [
        `### Flaky tests in ${what}`,
        '',
        'These failed, then passed when they ran again.',
        '',
        '| File | Test |',
        '|---|---|',
        ...tests.map((test) => `| ${cell(test.file)} | ${cell(test.name)} |`),
        '',
        '',
      ].join('\n'),
    );
}

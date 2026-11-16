import test from 'node:test';
import assert from 'node:assert/strict';
import {
  performanceBudgets,
  performanceBudgetMode,
  performanceBudgetWarnings,
  performanceRunFailed,
  performanceSummary,
} from './helpers/native-performance-budgets.mjs';

const metric = (p95, budgetMs, n = 40, extra = {}) => ({
  n,
  p95,
  budgetMs,
  passed: n >= 20 && p95 <= budgetMs,
  ...extra,
});
const finished = (budgetsPassed, functionalPassed = true) => ({
  complete: true,
  functionalPassed,
  budgetsPassed,
  passed: budgetsPassed && functionalPassed,
});

test('the budgets are the suite budgets', () => {
  assert.deepEqual(performanceBudgets, {
    inputKeystroke: 100,
    inputPaste: 100,
    inputClear: 100,
    click: 100,
    eventToFrame: 200,
    sessionSwitch: 300,
    fileSwitch: 300,
    save: 500,
  });
  assert.ok(Object.isFrozen(performanceBudgets));
});

test('budgets are enforced unless report is asked for', () => {
  assert.equal(performanceBudgetMode({}), 'enforce');
  assert.equal(
    performanceBudgetMode({ CIRCLE_NATIVE_PERF_BUDGETS: 'enforce' }),
    'enforce',
  );
  assert.equal(
    performanceBudgetMode({ CIRCLE_NATIVE_PERF_BUDGETS: 'report' }),
    'report',
  );
  assert.throws(
    () => performanceBudgetMode({ CIRCLE_NATIVE_PERF_BUDGETS: 'warn' }),
    /enforce or report/,
  );
});

test('a budget over its limit fails only an enforced run', () => {
  assert.equal(performanceRunFailed(finished(true), 'enforce'), false);
  assert.equal(performanceRunFailed(finished(true), 'report'), false);
  assert.equal(performanceRunFailed(finished(false), 'enforce'), true);
  assert.equal(performanceRunFailed(finished(false), 'report'), false);
});

test('an unfinished run or a failed functional check fails in either mode', () => {
  for (const mode of ['enforce', 'report']) {
    // A run that threw part-way has no functional or budget verdict at all.
    assert.equal(performanceRunFailed({ complete: false }, mode), true);
    assert.equal(
      performanceRunFailed(
        { complete: false, functionalPassed: true, budgetsPassed: true },
        mode,
      ),
      true,
    );
    assert.equal(performanceRunFailed(finished(true, false), mode), true);
    // The clipboard was not restored after a finished run.
    assert.equal(
      performanceRunFailed(
        { ...finished(true), functionalPassed: false, passed: false },
        mode,
      ),
      true,
    );
  }
});

test('each metric over its budget or short of samples is one warning', () => {
  const warnings = performanceBudgetWarnings({
    inputKeystroke: metric(12.34, 100),
    click: metric(130.25, 100),
    save: metric(80, 500, 7, { partial: true }),
  });
  assert.deepEqual(warnings, [
    '::warning title=native performance::click p95 130.3 ms is over its 100 ms budget (n=40)',
    '::warning title=native performance::save has 7 samples, fewer than 20 in an unfinished run',
  ]);
  assert.deepEqual(performanceBudgetWarnings({ click: metric(99.9, 100) }), []);
});

test('the summary has a row for every budget', () => {
  const report = {
    ...finished(false),
    metrics: {
      inputKeystroke: metric(9.5, 100),
      click: metric(130.25, 100),
    },
  };
  const summary = performanceSummary(report, 'report', '/tmp/evidence');
  const rows = summary
    .split('\n')
    .filter((line) => /^\| [a-zA-Z]+ \| \d/.test(line));
  assert.equal(rows.length, Object.keys(performanceBudgets).length);
  assert.ok(rows.includes('| inputKeystroke | 40 | 9.5 | 100 | pass |'));
  assert.ok(rows.includes('| click | 40 | 130.3 | 100 | over |'));
  assert.ok(rows.includes('| save | 0 | - | 500 | no samples |'));
  assert.match(summary, /every functional check passed/);
  assert.match(summary, /reported here, not enforced/);
  assert.match(summary, /`\/tmp\/evidence`/);
  const unfinished = performanceSummary(
    {
      complete: false,
      failure: 'Error: timed out: a new terminal\n    at stack',
      metrics: {},
    },
    'enforce',
    '/tmp/evidence',
  );
  assert.match(
    unfinished,
    /did not finish: Error: timed out: a new terminal$/m,
  );
  assert.doesNotMatch(unfinished, /at stack/);
  assert.match(unfinished, /over its budget fails the run/);
});

/** p95 budgets of the native performance suite, in milliseconds. */
export const performanceBudgets = Object.freeze({
  inputKeystroke: 100,
  inputPaste: 100,
  inputClear: 100,
  click: 100,
  eventToFrame: 200,
  sessionSwitch: 300,
  fileSwitch: 300,
  save: 500,
});

/**
 * `enforce` (the default) fails a run whose p95 is over a budget. `report` notes it and
 * leaves the exit code to the functional checks: CI sets it, because the latency of a
 * shared virtual machine says more about the machine than about the change.
 */
export function performanceBudgetMode(env = process.env) {
  const mode = env.CIRCLE_NATIVE_PERF_BUDGETS ?? 'enforce';
  if (mode !== 'enforce' && mode !== 'report')
    throw Error('CIRCLE_NATIVE_PERF_BUDGETS must be enforce or report');
  return mode;
}

/** Whether the run fails: unfinished or a missing effect always, a budget only when enforced. */
export function performanceRunFailed(report, mode) {
  return (
    report.complete !== true ||
    report.functionalPassed !== true ||
    (mode === 'enforce' && report.budgetsPassed !== true)
  );
}

const outcome = (metric) =>
  !metric
    ? 'no samples'
    : metric.passed
      ? 'pass'
      : metric.n < 20
        ? 'too few samples'
        : 'over';

/** One GitHub warning annotation for each metric that is over its budget or short of samples. */
export function performanceBudgetWarnings(metrics) {
  return Object.entries(metrics)
    .filter(([, metric]) => !metric.passed)
    .map(([name, metric]) => {
      const what =
        metric.n < 20
          ? `${name} has ${metric.n} samples, fewer than 20`
          : `${name} p95 ${metric.p95.toFixed(1)} ms is over its ${metric.budgetMs} ms budget (n=${metric.n})`;
      return `::warning title=native performance::${what}${metric.partial ? ' in an unfinished run' : ''}`;
    });
}

/** The step summary: whether the run finished, and each metric against its budget. */
export function performanceSummary(report, mode, output) {
  const status = report.complete
    ? report.functionalPassed
      ? 'The run finished and every functional check passed.'
      : 'The run finished, but a functional check failed.'
    : `The run did not finish: ${String(report.failure ?? 'no failure was recorded').split('\n')[0]}`;
  const rows = Object.entries(performanceBudgets).map(([name, budget]) => {
    const metric = report.metrics?.[name];
    return `| ${name} | ${metric?.n ?? 0} | ${metric ? metric.p95.toFixed(1) : '-'} | ${budget} | ${outcome(metric)} |`;
  });
  return [
    '### Native performance',
    '',
    status,
    '',
    '| metric | n | p95 (ms) | budget (ms) | result |',
    '| --- | --: | --: | --: | --- |',
    ...rows,
    '',
    mode === 'report'
      ? 'Budgets are reported here, not enforced.'
      : 'A metric over its budget fails the run.',
    `Evidence: \`${output}\``,
    '',
  ].join('\n');
}

/** Finish all independent cleanup steps; never let evidence I/O skip clipboard recovery. */
export async function finishNativePasteCleanup({
  primaryError,
  observe,
  writeEvidence,
  restore,
}) {
  const failures = [];
  for (const [stage, operation] of [
    ['observe', observe],
    ['evidence', writeEvidence],
    ['clipboard restore', restore],
  ]) {
    try {
      await operation();
    } catch (error) {
      failures.push(
        new Error(`native paste ${stage} failed`, { cause: error }),
      );
    }
  }
  if (failures.length) {
    throw new AggregateError(
      primaryError ? [primaryError, ...failures] : failures,
      'native paste cleanup failed; original operation and cleanup errors are retained',
      primaryError ? { cause: primaryError } : undefined,
    );
  }
}

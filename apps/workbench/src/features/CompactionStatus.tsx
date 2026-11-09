import { useEffect, useRef, useState } from 'react';
import type { CompactionSnapshot } from '../../../../src/compaction';
import { compactionStageText } from '../model/compaction';
import { formatBusyElapsed, nextBusySeconds } from '../model/format';
import './composer.css';

/**
 * Operation state also covers manual compaction, which has no assistant turn. Like the
 * terminal's line, it says what stage the work is at and how long it has run, so a summary
 * that takes a minute to write is seen to be under way.
 */
export function CompactionStatus({ state }: { state?: CompactionSnapshot }) {
  const running = state?.status === 'running';
  const [now, setNow] = useState(Date.now());
  const floor = useRef({ operation: '', seconds: 0 });
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 160);
    return () => clearInterval(timer);
  }, [running, state?.operationId]);
  if (!state || !running) return null;
  if (floor.current.operation !== state.operationId)
    floor.current = { operation: state.operationId, seconds: 0 };
  floor.current.seconds = nextBusySeconds(
    floor.current.seconds,
    Math.max(0, now - state.startedAt) / 1000,
  );
  return (
    <div
      className="compaction-progress"
      data-testid="compaction-progress"
      data-operation-id={state.operationId}
    >
      <span role="status" aria-live="polite">
        {compactionStageText(state)}
      </span>
      <span className="compaction-clock" aria-live="off">
        {' · ' + formatBusyElapsed(floor.current.seconds)}
      </span>
    </div>
  );
}

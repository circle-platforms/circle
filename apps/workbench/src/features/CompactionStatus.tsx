import { Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CompactionSnapshot } from '../../../../src/compaction';
import { t } from '../i18n';
import { compactionStageText } from '../model/compaction';
import { formatBusyElapsed, nextBusySeconds } from '../model/format';
import './composer.css';

/**
 * A compaction in the conversation, as a line of its own where the next message goes: while
 * it runs, its stage, how far the summary has got and how long it has run; once it ends,
 * the same line says what it did (CompactionOutcome). Manual compaction has no turn of its
 * own, so the line is the compaction's, not a turn's.
 */
export function CompactionRow({ state }: { state?: CompactionSnapshot }) {
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
  const percent = Math.floor((state.progress ?? 0) * 100);
  return (
    <div
      className="line-row compaction-row"
      data-busy
      data-testid="compaction-progress"
      data-operation-id={state.operationId}
    >
      <div className="line-summary">
        <span className="turn-ring" aria-hidden />
        <span role="status" aria-live="polite">
          {compactionStageText(state)}
        </span>
        <span
          className="compaction-bar"
          role="progressbar"
          aria-label={t('compaction progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <i style={{ width: `${percent}%` }} />
        </span>
        <span className="compaction-clock" aria-live="off">
          {`${percent}% · ${formatBusyElapsed(floor.current.seconds)}`}
        </span>
      </div>
    </div>
  );
}

/** What a compaction did, on the line where it ran: a check, or a cross when it failed. */
export function CompactionOutcome({
  state,
  text,
}: {
  state: CompactionSnapshot;
  text: string;
}) {
  const done = state.status === 'succeeded';
  return (
    <div
      className="line-row compaction-row"
      data-state={state.status}
      data-testid="compaction-outcome"
    >
      <div className="line-summary">
        {done ? <Check size={13} aria-hidden /> : <X size={13} aria-hidden />}
        <span>{text}</span>
      </div>
    </div>
  );
}

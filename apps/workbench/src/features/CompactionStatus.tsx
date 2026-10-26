import type { CompactionSnapshot } from '../../../../src/compaction';
import { compactionStageText } from '../model/compaction';
import './composer.css';

/** Operation state also covers manual compaction, which has no assistant turn. */
export function CompactionStatus({ state }: { state?: CompactionSnapshot }) {
  if (!state || state.status !== 'running') return null;
  return (
    <div
      className="compaction-progress"
      data-testid="compaction-progress"
      data-operation-id={state.operationId}
    >
      <span role="status" aria-live="polite">
        {compactionStageText(state)}
      </span>
    </div>
  );
}

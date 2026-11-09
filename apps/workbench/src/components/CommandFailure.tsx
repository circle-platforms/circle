import { useRuntime } from '../app/context';
import { t } from '../i18n';
// The row shares the conversation's words for a wait: both say what is held.
import type { ActionFailure } from '../model/types';
import { Button } from './common';
import { FailureRow } from './FailureRow';

/** What the runtime is holding right now, said where the person asked for it. */
export function RuntimeWaitRow({ sessionId }: { sessionId: string }) {
  const { snapshot } = useRuntime();
  const waiting = snapshot.runtime?.waiting;
  // Said in the conversation that asked, or everywhere when no conversation did
  if (!waiting || (waiting.sessionId && waiting.sessionId !== sessionId))
    return null;
  return (
    <div className="runtime-wait" role="status" data-testid="runtime-wait">
      <i className="attention-dot" />
      <span>
        {t('Circle is still working on {command} · {seconds}s', {
          command: waiting.command,
          seconds: Math.ceil(waiting.waitedMs / 1000),
        })}
      </span>
    </div>
  );
}

/**
 * The card for a command the window asked and never got: what failed, whether it
 * can be asked again.
 */
export function CommandFailureCard({
  sessionId,
  failure,
}: {
  sessionId: string;
  failure: ActionFailure;
}) {
  const { runtime } = useRuntime();
  const timedOut = failure.kind === 'timeout';
  return (
    <FailureRow
      label={t('action failed')}
      testId="command-failure"
      cause={`✖ ${timedOut ? `${t('Circle did not answer')} · ` : ''}${failure.message}`}
      detail={
        failure.detail && failure.detail !== failure.message
          ? failure.detail
          : undefined
      }
      copy={failure.detail ?? failure.message}
      note={
        timedOut ? t('check whether it ran before sending it again') : undefined
      }
      actions={
        <>
          {failure.retry && !timedOut && (
            <Button
              onClick={() => void runtime.retryActionFailure?.(sessionId)}
            >
              {t('retry')}
            </Button>
          )}
          <Button onClick={() => runtime.dismissActionError?.(sessionId)}>
            {t('dismiss')}
          </Button>
        </>
      }
    />
  );
}

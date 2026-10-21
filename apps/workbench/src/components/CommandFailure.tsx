import { useRuntime } from '../app/context';
import { t } from '../i18n';
// The row shares the conversation's words for a wait: both say what is held.
import { copyText } from '../host';
import type { ActionFailure } from '../model/types';
import { Button } from './common';

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
  const { runtime, notify } = useRuntime();
  const timedOut = failure.kind === 'timeout';
  return (
    <section
      className="transcript-notice runtime-failure"
      data-testid="command-failure"
      role="alert"
      aria-label={t('action failed')}
    >
      <strong>
        {timedOut ? t('Circle did not answer') : t('action failed')}
      </strong>
      {/* What Circle said, in the interface language; its own words stay below. */}
      <p className="runtime-failure-cause">{failure.message}</p>
      {timedOut && (
        <p className="panel-note">
          {t('check whether it ran before sending it again')}
        </p>
      )}
      {failure.detail && failure.detail !== failure.message && (
        <details>
          <summary>{t('error details')}</summary>
          <pre>{failure.detail}</pre>
        </details>
      )}
      <div className="runtime-failure-actions">
        {failure.retry && !timedOut && (
          <Button onClick={() => void runtime.retryActionFailure?.(sessionId)}>
            {t('retry')}
          </Button>
        )}
        <Button
          onClick={() =>
            void copyText(failure.detail ?? failure.message).then(
              () => notify(t('copied')),
              () => notify(t('clipboard unavailable')),
            )
          }
        >
          {t('copy error details')}
        </Button>
        <Button onClick={() => runtime.dismissActionError?.(sessionId)}>
          {t('dismiss')}
        </Button>
      </div>
    </section>
  );
}

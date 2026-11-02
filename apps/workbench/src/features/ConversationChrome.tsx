import type { Session, Job } from '../model/types';
import { contextUsage } from '../model/context-usage';
import { formatTokens } from '../model/format';
import { t } from '../i18n';

/** The live plan is projected from runtime todos; completed plans stay in history. */
export function ConversationPlan({ session }: { session: Session }) {
  const todos = session.todos;
  if (!todos?.some((todo) => todo.status !== 'completed')) return null;
  return (
    <section className="conversation-plan" aria-label={t('plan')}>
      <header>
        <strong>{t('plan')}</strong>
        <span>
          {todos.filter((t) => t.status === 'completed').length} /{' '}
          {todos.length}
        </span>
      </header>
      <ol>
        {todos.map((todo) => (
          <li
            key={todo.id}
            data-state={todo.status}
            aria-current={todo.status === 'running' ? 'step' : undefined}
          >
            <i aria-hidden="true" />
            <span>{todo.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Unknown input stays unknown. Background work remains scoped to its source session. */
export function ConversationStatus({
  session,
  jobs,
}: {
  session: Session;
  jobs: readonly Job[];
}) {
  const usage = contextUsage(session);
  const active = jobs.filter(
    (job) =>
      job.sessionId === session.id &&
      ['running', 'waiting', 'stopping'].includes(job.state),
  );
  return (
    <>
      <div className="conversation-status" aria-label={t('usage')}>
        <span>
          ↑{' '}
          {session.meters && !session.meters.inputUnknown
            ? formatTokens(session.meters.input)
            : 'N/A'}
        </span>
        <span>
          ↓ {session.meters ? formatTokens(session.meters.output) : 'N/A'}
        </span>
        <span>
          {t('context')} {usage.fill}
        </span>
        <span>
          {t('cost')} {usage.cost}
        </span>
        <span>
          {t('cache')} {usage.cache}
        </span>
      </div>
      {active.length > 0 && (
        <ul className="conversation-jobs" aria-label={t('background jobs')}>
          {active.map((job) => (
            <li key={job.id} data-state={job.state}>
              <i aria-hidden="true" />
              <span>
                {job.state === 'waiting'
                  ? t('waiting for you')
                  : job.state === 'stopping'
                    ? t('stopping')
                    : t('running')}
              </span>
              <code>{job.id}</code>
              <span className="job-description" title={job.title}>
                {job.title}
              </span>
              <time>{job.elapsed}</time>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

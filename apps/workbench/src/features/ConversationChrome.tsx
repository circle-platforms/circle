import type { Session, Job } from '../model/types';
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

/**
 * Background work still running for this session. Token and cache figures stay in the
 * overview pane; the composer carries no usage line (#433).
 */
export function ConversationJobs({
  session,
  jobs,
}: {
  session: Session;
  jobs: readonly Job[];
}) {
  const active = jobs.filter(
    (job) =>
      job.sessionId === session.id &&
      ['running', 'waiting', 'stopping'].includes(job.state),
  );
  if (active.length === 0) return null;
  return (
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
  );
}

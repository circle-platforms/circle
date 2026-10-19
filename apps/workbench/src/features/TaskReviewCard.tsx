import { ClipboardCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { TaskRecord } from '../../../desktop/src/workspace/task-store';
import { Button } from '../components/common';
import { TaskEvidence } from './TaskEvidence';
import { t, tn } from '../i18n';
import { taskEvidence } from '../model/task-evidence';
import { subscribeWorkspace, workspaceCall } from '../model/workspace-client';
import type { AgentRecord } from '../model/types';

/** The task as the owning conversation lists it, kept current while its card is shown. */
function useTask(ownerSessionId: string, taskId: string) {
  const [task, setTask] = useState<TaskRecord>();
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let current = true;
    void workspaceCall<TaskRecord[]>(ownerSessionId, 'tasks', 'list').then(
      (records) => {
        if (current) setTask(records.find((one) => one.spec.id === taskId));
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [ownerSessionId, taskId, revision]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = subscribeWorkspace((event) => {
      if (event.sessionId !== ownerSessionId || event.service !== 'tasks')
        return;
      clearTimeout(timer);
      timer = setTimeout(refresh, 80);
    });
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [ownerSessionId, refresh]);
  return { task, refresh };
}

/** The patch and the HEAD the person is shown, as the task's result records them. */
function patchIdentity(
  task: TaskRecord,
): { sha256: string; head: string } | null {
  const result = task.result;
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return null;
  const changes = result.changes;
  if (
    !changes ||
    typeof changes !== 'object' ||
    Array.isArray(changes) ||
    typeof changes.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(changes.sha256) ||
    typeof changes.head !== 'string'
  )
    return null;
  return { sha256: changes.sha256, head: changes.head };
}

/**
 * At the end of a task's own conversation, once it has finished and waits for you: each
 * criterion ticked with what you checked and saw, and the review confirmed when all are
 * done, or the attempt sent back with the reason, for Circle to do again.
 */
export function TaskReviewCard({
  agent,
  onChanges,
}: {
  /** The task, as the conversation that owns it lists it. */
  agent: AgentRecord;
  /** Show what the task changed. */
  onChanges: () => void;
}) {
  const taskId = agent.task?.id ?? '';
  const { task, refresh } = useTask(agent.sessionId, taskId);
  if (!task || task.state !== 'needs_review') return null;
  return (
    <ReviewForm
      key={`${task.spec.id}:${task.attempt}`}
      task={task}
      ownerSessionId={agent.sessionId}
      name={agent.name}
      onChanges={onChanges}
      onRefresh={refresh}
    />
  );
}

function ReviewForm({
  task,
  ownerSessionId,
  name,
  onChanges,
  onRefresh,
}: {
  task: TaskRecord;
  ownerSessionId: string;
  name: string;
  onChanges: () => void;
  onRefresh: () => void;
}) {
  const evidence = taskEvidence(task);
  const identity = patchIdentity(task);
  // The attempt and the patch you were shown: a review is of those, not of a later one.
  const [baseline, setBaseline] = useState(() => ({
    attempt: task.attempt,
    sha256: identity?.sha256,
  }));
  const [checks, setChecks] = useState<
    Record<string, { checked: boolean; evidence: string }>
  >({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const criteria = task.spec.acceptanceCriteria;
  const stale =
    task.attempt !== baseline.attempt || identity?.sha256 !== baseline.sha256;
  const shown = !!identity && !stale;
  const ready =
    shown &&
    criteria.length > 0 &&
    criteria.every(
      (criterion) =>
        checks[criterion]?.checked && checks[criterion]!.evidence.trim(),
    );
  const decide = (
    method: 'review' | 'reject',
    body: Record<string, unknown>,
  ) => {
    if (busy) return;
    setBusy(true);
    setError('');
    void workspaceCall(ownerSessionId, 'tasks', method, {
      id: task.spec.id,
      expectedAttempt: baseline.attempt,
      expectedPatchSha256: baseline.sha256,
      ...body,
    })
      .then(onRefresh)
      .catch((failure) => {
        setError(failure instanceof Error ? failure.message : String(failure));
        onRefresh();
      })
      .finally(() => setBusy(false));
  };
  const files = evidence?.paths.length ?? 0;
  return (
    <section
      className="inline-request task-review-card"
      data-kind="review"
      aria-busy={busy}
    >
      <header>
        <ClipboardCheck size={14} />
        <strong>{t('needs review')}</strong>
        <span>{name}</span>
        <small>{t('attempt {n}', { n: task.attempt })}</small>
      </header>
      {files > 0 && (
        <p className="task-review-files">
          <button type="button" className="text-button" onClick={onChanges}>
            {tn(files, '{n} file changed', '{n} files changed')}
          </button>
        </p>
      )}
      <TaskEvidence task={task} />
      {!identity && (
        <p role="status">{t('the changes are not ready to review yet')}</p>
      )}
      {stale && (
        <p role="alert">
          {t('the task changed since you opened it')}{' '}
          <Button
            disabled={!identity}
            onClick={() => {
              setBaseline({ attempt: task.attempt, sha256: identity?.sha256 });
              setChecks((previous) =>
                Object.fromEntries(
                  Object.entries(previous).map(([criterion, value]) => [
                    criterion,
                    { ...value, checked: false },
                  ]),
                ),
              );
            }}
          >
            {t('load the latest changes')}
          </Button>
        </p>
      )}
      {criteria.map((criterion) => {
        const value = checks[criterion] ?? { checked: false, evidence: '' };
        return (
          <label key={criterion} className="task-review-criterion">
            <span className="task-check">
              <input
                type="checkbox"
                checked={value.checked}
                onChange={(event) =>
                  setChecks((previous) => ({
                    ...previous,
                    [criterion]: { ...value, checked: event.target.checked },
                  }))
                }
              />
              {criterion}
            </span>
            <textarea
              aria-label={t('review evidence for {criterion}', { criterion })}
              placeholder={t(
                'describe what you checked and the observed result',
              )}
              value={value.evidence}
              onChange={(event) =>
                setChecks((previous) => ({
                  ...previous,
                  [criterion]: { ...value, evidence: event.target.value },
                }))
              }
            />
          </label>
        );
      })}
      {error && (
        <p role="alert" className="request-failure">
          {error}
        </p>
      )}
      {rejecting ? (
        <form
          className="task-review-reject"
          onSubmit={(event) => {
            event.preventDefault();
            if (shown && reason.trim())
              decide('reject', { reason: reason.trim() });
          }}
        >
          <label>
            <span className="task-review-label">
              {t('reason for sending it back')}
            </span>
            <textarea
              autoFocus
              aria-label={t('reason for sending it back')}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="request-actions">
            <Button
              type="submit"
              className="primary"
              disabled={busy || !shown || !reason.trim()}
            >
              {busy ? t('sending back…') : t('confirm sending back')}
            </Button>
            <Button
              type="button"
              disabled={busy}
              onClick={() => setRejecting(false)}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <div className="request-actions">
          <Button
            className="primary"
            disabled={!ready || busy}
            onClick={() =>
              decide('review', {
                checks: criteria.map((criterion) => ({
                  criterion,
                  evidence: checks[criterion]!.evidence.trim(),
                })),
              })
            }
          >
            {busy ? t('recording review…') : t('confirm reviewed criteria')}
          </Button>
          <Button disabled={busy || !shown} onClick={() => setRejecting(true)}>
            {t('send back')}
          </Button>
        </div>
      )}
    </section>
  );
}

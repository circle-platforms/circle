import { useState } from 'react';
import type { TaskRecord } from '../../../desktop/src/workspace/task-store';
import { workspaceCall } from '../model/workspace-client';
import { Button } from '../components/common';
import { t } from '../i18n';
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
export function TaskReviewForm({
  task,
  sessionId,
  onRefresh,
}: {
  task: TaskRecord;
  sessionId: string;
  onRefresh: () => void;
}) {
  const identity = patchIdentity(task);
  const [baseline, setBaseline] = useState(() => ({
    attempt: task.attempt,
    sha256: identity?.sha256,
  }));
  const [checks, setChecks] = useState<
    Record<string, { checked: boolean; evidence: string }>
  >({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stale =
    task.attempt !== baseline.attempt || identity?.sha256 !== baseline.sha256;
  const ready =
    !!identity &&
    !stale &&
    task.spec.acceptanceCriteria.length > 0 &&
    task.spec.acceptanceCriteria.every(
      (criterion) =>
        checks[criterion]?.checked && checks[criterion]!.evidence.trim(),
    );
  return (
    <form
      className="task-review panel-section"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setError('');
        void workspaceCall(sessionId, 'tasks', 'review', {
          id: task.spec.id,
          expectedAttempt: baseline.attempt,
          expectedPatchSha256: baseline.sha256,
          checks: task.spec.acceptanceCriteria.map((criterion) => ({
            criterion,
            evidence: checks[criterion]!.evidence.trim(),
          })),
        })
          .then(onRefresh)
          .catch((reason) => {
            setError(String(reason));
            onRefresh();
          })
          .finally(() => setBusy(false));
      }}
    >
      <h4>{t('your review')}</h4>
      <p>
        {t(
          'tick each criterion and say what you saw. this records your review; it does not run tests.',
        )}
      </p>
      {!identity && (
        <p role="status">{t('the changes are not ready to review yet')}</p>
      )}
      {stale && (
        <p role="alert">
          {t('the task changed since you opened it')}
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
      {task.spec.acceptanceCriteria.map((criterion) => {
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
        <p role="alert" className="tasks-error">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!ready || busy}>
        {busy ? t('recording review…') : t('confirm reviewed criteria')}
      </Button>
    </form>
  );
}

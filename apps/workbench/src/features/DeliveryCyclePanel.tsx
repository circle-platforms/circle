import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CycleRecord,
  CycleState,
} from '../../../desktop/src/workspace/delivery-cycle';
import type { WorkspaceService } from '../../../desktop/src/workspace-protocol';
import { workspaceCall, subscribeWorkspace } from '../model/workspace-client';
import { Button, DataBlock } from '../components/common';
import { copyText } from '../host';
import { t } from '../i18n';
const states: Record<CycleState, () => string> = {
  queued: () => t('queued'),
  working: () => t('agents are working'),
  verifying: () => t('verifying acceptance criteria'),
  publishing: () => t('publishing draft pull request'),
  waiting_ci: () => t('waiting for CI'),
  repairing: () => t('repairing CI failure'),
  needs_review: () => t('needs review'),
  pending_human_merge: () => t('ready for human merge'),
};
export function DeliveryCyclePanel({
  sessionId,
  onTask,
  onOpenExternal,
  active = true,
}: {
  sessionId: string;
  onTask: (id: string) => void;
  onOpenExternal: (url: string) => void;
  active?: boolean;
}) {
  const [cycles, setCycles] = useState<CycleRecord[]>([]);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [criteria, setCriteria] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    try {
      const records = await workspaceCall<CycleRecord[]>(
        sessionId,
        'cycles' as WorkspaceService,
        'list',
      );
      if (epoch === generation.current) setCycles(records);
    } catch (reason) {
      if (epoch === generation.current) setError(String(reason));
    }
  }, [sessionId]);
  useEffect(() => {
    generation.current++;
    setCycles([]);
    setError('');
    setBusy(false);
    void refresh();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeWorkspace((event) => {
      if (event.sessionId !== sessionId || String(event.service) !== 'cycles')
        return;
      clearTimeout(pending);
      pending = setTimeout(() => void refresh(), 80);
    });
    return () => {
      generation.current++;
      unsubscribe();
      clearTimeout(pending);
    };
  }, [sessionId, refresh]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [active, refresh]);
  async function run(action: () => Promise<unknown>) {
    const epoch = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
      if (epoch === generation.current) await refresh();
    } catch (reason) {
      if (epoch === generation.current) setError(String(reason));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  return (
    <section className="tasks-panel" aria-label={t('automatic delivery')}>
      <header>
        <strong>{t('automatic delivery')}</strong>
        <Button
          onClick={() => {
            setError('');
            void refresh();
          }}
        >
          {t('refresh')}
        </Button>
      </header>
      <p>
        {t(
          'agents implement, verify and repair CI; you decide the final merge',
        )}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const epoch = generation.current;
            await workspaceCall(
              sessionId,
              'cycles' as WorkspaceService,
              'create',
              {
                id: crypto.randomUUID(),
                operationId: crypto.randomUUID(),
                title: title.trim(),
                body: body.trim(),
                acceptanceCriteria: criteria
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean),
              },
            );
            if (epoch === generation.current) {
              setTitle('');
              setBody('');
              setCriteria('');
            }
          });
        }}
      >
        <label>
          {t('delivery title')}
          <input
            required
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          {t('implementation request')}
          <textarea
            required
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>
        <label>
          {t('acceptance criteria')}
          <textarea
            required
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          disabled={busy || !title.trim() || !body.trim() || !criteria.trim()}
        >
          {t('start automatic delivery')}
        </Button>
      </form>
      {error && (
        <p role="alert" className="tasks-error">
          {error}
        </p>
      )}
      {!cycles.length && !error && <p>{t('no delivery cycles')}</p>}
      <div className="tasks-list">
        {cycles.map((cycle) => (
          <article key={cycle.id} data-state={cycle.state}>
            <header>
              <strong>{cycle.title}</strong>
              <span className={`status status-${cycle.state}`}>
                <i />
                {states[cycle.state]()}
              </span>
              <small>{t('attempt {n}', { n: cycle.attempt })}</small>
            </header>
            {cycle.reason && <p role="status">{cycle.reason}</p>}
            <dl>
              <dt>{t('cycle')}</dt>
              <dd>
                <code>{cycle.id}</code>
              </dd>
              {cycle.publishedHead && (
                <>
                  <dt>{t('published commit')}</dt>
                  <dd>
                    <code>{cycle.publishedHead}</code>
                  </dd>
                </>
              )}
            </dl>
            <ul>
              {cycle.acceptanceCriteria.map((criterion, index) => (
                <li key={index}>{criterion}</li>
              ))}
            </ul>
            <div className="tasks-actions">
              {cycle.taskIds.map((id) => (
                <Button key={id} onClick={() => onTask(id)}>
                  {t('open task {id}', { id: id.slice(0, 12) })}
                </Button>
              ))}
              {cycle.pr && (
                <Button onClick={() => onOpenExternal(cycle.pr!.url)}>
                  {t('open pull request')}
                </Button>
              )}
            </div>
            {cycle.lastFailure && (
              <details>
                <summary>{t('CI failure and repair evidence')}</summary>
                <p>
                  <code>{cycle.lastFailure.head}</code>
                </p>
                <ul>
                  {cycle.lastFailure.checks.map((check, index) => (
                    <li key={index}>
                      {check.name} ·{' '}
                      {
                        {
                          pass: t('passed'),
                          fail: t('failed'),
                          pending: t('pending'),
                          cancel: t('cancelled'),
                          skipping: t('skipped'),
                        }[check.bucket]
                      }
                      {check.runId &&
                        ['fail', 'cancel'].includes(check.bucket) && (
                          <Button
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                workspaceCall(
                                  sessionId,
                                  'cycles' as WorkspaceService,
                                  'retryCI',
                                  {
                                    id: cycle.id,
                                    runId: check.runId,
                                    operationId: crypto.randomUUID(),
                                  },
                                ),
                              )
                            }
                          >
                            {t('retry CI run')}
                          </Button>
                        )}
                    </li>
                  ))}
                </ul>
                <DataBlock
                  title={t('CI logs')}
                  value={cycle.lastFailure.logs}
                />
                <Button
                  onClick={() =>
                    void run(() => copyText(cycle.lastFailure!.logs))
                  }
                >
                  {t('copy CI logs')}
                </Button>
              </details>
            )}
            {cycle.state === 'pending_human_merge' && (
              <p role="status">
                {t(
                  'verification passed; review the pull request and merge on GitHub',
                )}
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

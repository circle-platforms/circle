import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { TaskRecord } from '../../../desktop/src/workspace/task-store';
import { workspaceCall, subscribeWorkspace } from '../model/workspace-client';
import { Button, DataBlock, Status } from '../components/common';
import { PendingOperations } from './PendingOperations';
import { TaskArtifacts } from './TaskArtifacts';
import { TaskReviewForm } from './TaskReviewForm';
import { t } from '../i18n';

interface Limits {
  agents: number;
  builds: number;
  ui: number;
  browsers: number;
}
export function TasksPanel({
  sessionId,
  onSession,
  focusTaskId,
}: {
  sessionId: string;
  onSession: (id: string) => void;
  focusTaskId?: string;
}) {
  const [tasks, setTasks] = useState<
    (TaskRecord & { runtimeSessionId?: string })[]
  >([]);
  const [limits, setLimits] = useState<Limits | null>(null);
  const [agents, setAgents] = useState('8');
  const [prompt, setPrompt] = useState('');
  const [criteria, setCriteria] = useState('');
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [access, setAccess] = useState<'write' | 'readonly'>('write');
  const [resource, setResource] = useState<
    'agent' | 'build' | 'ui' | 'browser'
  >('agent');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const instruction = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (createOpen) instruction.current?.focus();
  }, [createOpen]);
  const generation = useRef(0);
  const revealedTask = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTaskId) {
      revealedTask.current = null;
      return;
    }
    const request = sessionId + ':' + focusTaskId;
    if (revealedTask.current === request) return;
    const item = document.getElementById('task-' + focusTaskId);
    if (item) {
      item.scrollIntoView({ block: 'nearest' });
      item.focus();
      revealedTask.current = request;
    }
  }, [focusTaskId, tasks, sessionId]);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    try {
      const [records, settings] = await Promise.all([
        workspaceCall<TaskRecord[]>(sessionId, 'tasks', 'list'),
        workspaceCall<Limits>(sessionId, 'tasks', 'settings'),
      ]);
      if (epoch !== generation.current) return;
      setTasks(records);
      setLimits(settings);
      setError('');
    } catch (err) {
      if (epoch === generation.current) setError(String(err));
    }
  }, [sessionId]);
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setTasks([]);
    setLimits(null);
    setError('');
    setDependencies([]);
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeWorkspace((event) => {
      if (event.sessionId !== sessionId || event.service !== 'tasks') return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 80);
    });
    return () => {
      generation.current++;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [sessionId, refresh]);
  useEffect(() => {
    if (limits) setAgents(String(limits.agents));
  }, [limits?.agents]);
  const run = async (action: () => Promise<unknown>) => {
    const epoch = generation.current;
    setBusy(true);
    setError('');
    try {
      await action();
      if (epoch === generation.current) await refresh();
    } catch (err) {
      if (epoch === generation.current) setError(String(err));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  };
  return (
    <section className="tasks-panel" aria-label={t('collaboration tasks')}>
      <header>
        <strong>{t('collaboration tasks')}</strong>
        <Button
          type="button"
          aria-expanded={createOpen}
          aria-controls={'new-task-' + sessionId}
          onClick={() => {
            setCreateOpen((value) => !value);
          }}
        >
          {createOpen ? t('close task form') : t('new task')}
        </Button>
        <Button onClick={() => void refresh()}>{t('refresh')}</Button>
        <Button
          type="button"
          disabled={busy || !tasks.some((task) => task.state === 'queued')}
          onClick={() =>
            void run(() => workspaceCall(sessionId, 'tasks', 'start'))
          }
        >
          {t('start ready tasks')}
        </Button>
      </header>
      <div id={'new-task-' + sessionId} hidden={!createOpen}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              const epoch = generation.current;
              await workspaceCall(sessionId, 'tasks', 'enqueue', {
                operationId: crypto.randomUUID(),
                tasks: [
                  {
                    id: crypto.randomUUID(),
                    prompt: prompt.trim(),
                    acceptanceCriteria: criteria
                      .split('\n')
                      .map((line) => line.trim())
                      .filter(Boolean),
                    dependencies,
                    access,
                    resource,
                  },
                ],
              });
              if (epoch === generation.current) {
                setPrompt('');
                setCriteria('');
                setDependencies([]);
                setCreateOpen(false);
              }
            });
          }}
        >
          <label>
            {t('task instruction')}
            <textarea
              ref={instruction}
              required
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
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
          <label>
            {t('workspace access')}
            <select
              value={access}
              onChange={(event) =>
                setAccess(event.target.value as 'write' | 'readonly')
              }
            >
              <option value="write">{t('isolated write worktree')}</option>
              <option value="readonly">{t('read-only baseline')}</option>
            </select>
          </label>
          <label>
            {t('execution resource')}
            <select
              value={resource}
              onChange={(event) =>
                setResource(event.target.value as typeof resource)
              }
            >
              <option value="agent">{t('agent')}</option>
              <option value="build">{t('build')}</option>
              <option value="browser">{t('browser')}</option>
              <option value="ui">{t('foreground interface')}</option>
            </select>
          </label>
          {tasks.length > 0 && (
            <label>
              {t('dependencies')}
              <select
                multiple
                value={dependencies}
                onChange={(event) =>
                  setDependencies(
                    Array.from(
                      event.target.selectedOptions,
                      (option) => option.value,
                    ),
                  )
                }
              >
                {tasks.map((task) => (
                  <option key={task.spec.id} value={task.spec.id}>
                    {task.spec.prompt.slice(0, 80)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div>
            <Button
              type="submit"
              disabled={busy || !prompt.trim() || !criteria.trim()}
            >
              {t('queue task')}
            </Button>
          </div>
        </form>
      </div>
      {error && (
        <p role="alert" className="tasks-error">
          {error}
        </p>
      )}
      {!tasks.length && !error && <p>{t('no collaboration tasks')}</p>}
      <div className="tasks-list">
        {tasks.map((task) => (
          <article
            key={task.spec.id}
            id={'task-' + task.spec.id}
            tabIndex={-1}
            data-state={task.state}
          >
            <header>
              <Status value={task.state} />
              <small>{t('attempt {n}', { n: task.attempt })}</small>
            </header>
            <p>{task.spec.prompt}</p>
            <details>
              <summary>{t('task details and acceptance')}</summary>
              <code>{task.spec.id}</code>
              <dl>
                <dt>{t('baseline')}</dt>
                <dd>
                  <code>{task.spec.baseline}</code>
                </dd>
                <dt>{t('workspace')}</dt>
                <dd>{task.worktree ?? task.spec.workspace}</dd>
                {task.branch && (
                  <>
                    <dt>{t('branch')}</dt>
                    <dd>{task.branch}</dd>
                  </>
                )}
                {task.spec.dependencies.length > 0 && (
                  <>
                    <dt>{t('dependencies')}</dt>
                    <dd>{task.spec.dependencies.join(', ')}</dd>
                  </>
                )}
              </dl>
              <ul>
                {task.spec.acceptanceCriteria.map((criterion, index) => (
                  <li key={index}>{criterion}</li>
                ))}
              </ul>
            </details>
            {task.reason && <p role="status">{task.reason}</p>}
            {task.result !== undefined && (
              <>
                <TaskArtifacts
                  key={`${task.spec.id}:${task.attempt}`}
                  sessionId={sessionId}
                  taskId={task.spec.id}
                  attempt={task.attempt}
                />
                <details>
                  <summary>{t('result')}</summary>
                  <DataBlock title={t('result')} value={task.result} />
                </details>
              </>
            )}
            {String(task.state) === 'needs_review' && (
              <TaskReviewForm
                key={task.spec.id}
                task={task}
                sessionId={sessionId}
                onRefresh={() => void refresh()}
              />
            )}
            <div className="tasks-actions">
              {task.runtimeSessionId && (
                <Button onClick={() => onSession(task.runtimeSessionId!)}>
                  {task.state === 'waiting'
                    ? t('review pending requests')
                    : t('open task conversation')}
                </Button>
              )}
              {[
                'queued',
                'preparing',
                'running',
                'waiting',
                'blocked',
              ].includes(task.state) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      workspaceCall(sessionId, 'tasks', 'cancel', {
                        id: task.spec.id,
                      }),
                    )
                  }
                >
                  {t('cancel task')}
                </Button>
              )}
              {['failed', 'cancelled', 'interrupted', 'needs_review'].includes(
                task.state,
              ) && (
                <Button
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      workspaceCall(sessionId, 'tasks', 'retry', {
                        id: task.spec.id,
                        operationId: crypto.randomUUID(),
                      }),
                    )
                  }
                >
                  {t('reviewed effects · retry task')}
                </Button>
              )}
            </div>
          </article>
        ))}
      </div>
      <details>
        <summary>{t('collaboration settings')}</summary>
        <div className="tasks-limits">
          <label>
            {t('active agents')}{' '}
            <input
              type="number"
              min={1}
              max={32}
              value={agents}
              onChange={(event) => setAgents(event.target.value)}
            />
          </label>
          <Button
            disabled={
              busy ||
              !limits ||
              !Number.isInteger(Number(agents)) ||
              Number(agents) < 1 ||
              Number(agents) > 32
            }
            onClick={() =>
              void run(() =>
                workspaceCall(sessionId, 'tasks', 'settings', {
                  limits: { ...limits, agents: Number(agents) },
                }),
              )
            }
          >
            {t('save limits')}
          </Button>
          {limits && (
            <small>
              {t(
                'builds {builds} · browsers {browsers} · foreground {ui}',
                limits as unknown as Record<string, string | number>,
              )}
            </small>
          )}
        </div>
      </details>
      <PendingOperations key={sessionId} sessionId={sessionId} />
    </section>
  );
}

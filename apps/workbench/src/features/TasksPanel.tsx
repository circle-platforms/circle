import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ChevronRight, Users } from 'lucide-react';
import type { TaskRecord } from '../../../desktop/src/workspace/task-store';
import { workspaceCall, subscribeWorkspace } from '../model/workspace-client';
import { Button, DataBlock, Status } from '../components/common';
import { PendingOperations } from './PendingOperations';
import { TaskArtifacts } from './TaskArtifacts';
import { TaskReviewForm } from './TaskReviewForm';
import { t } from '../i18n';
import './task-panel.css';

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
  embedded = false,
}: {
  sessionId: string;
  onSession: (id: string) => void;
  focusTaskId?: string;
  embedded?: boolean;
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
  const [configurationError, setConfigurationError] = useState('');
  const [tasksReady, setTasksReady] = useState(false);
  const [requiresStart, setRequiresStart] = useState(false);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const instruction = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (createOpen) instruction.current?.focus();
  }, [createOpen]);
  const generation = useRef(0);
  const refreshRevision = useRef(0);
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
      const detail = item.querySelector<HTMLDetailsElement>('.task-entry');
      if (detail) detail.open = true;
      item.scrollIntoView({ block: 'nearest' });
      item.focus();
      revealedTask.current = request;
    }
  }, [focusTaskId, tasks, sessionId]);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const revision = ++refreshRevision.current;
    const [records, settings] = await Promise.allSettled([
      workspaceCall<TaskRecord[]>(sessionId, 'tasks', 'list'),
      workspaceCall<Limits & { error?: string; requiresStart?: boolean }>(
        sessionId,
        'tasks',
        'settings',
      ),
    ]);
    if (epoch !== generation.current || revision !== refreshRevision.current)
      return;
    setTasksReady(records.status === 'fulfilled');
    if (records.status === 'fulfilled') setTasks(records.value);
    if (settings.status === 'fulfilled') {
      const { agents, builds, ui, browsers, error } = settings.value;
      setLimits({ agents, builds, ui, browsers });
      setConfigurationError(error ?? '');
      setRequiresStart(settings.value.requiresStart === true);
    } else {
      setLimits(null);
      setConfigurationError(String(settings.reason));
    }
    setError(records.status === 'rejected' ? String(records.reason) : '');
  }, [sessionId]);
  useEffect(() => {
    generation.current++;
    setBusy(false);
    setTasks([]);
    setLimits(null);
    setConfigurationError('');
    setTasksReady(false);
    setRequiresStart(false);
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
    <section
      className={`tasks-panel task-panel${embedded ? ' task-panel-embedded' : ''}`}
      aria-label={t('collaboration tasks')}
    >
      <header className="task-panel-toolbar">
        {!embedded && <strong>{t('collaboration tasks')}</strong>}
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
          disabled={
            busy ||
            !!configurationError ||
            !tasksReady ||
            !tasks.some((task) => task.state === 'queued')
          }
          onClick={() =>
            void run(() => workspaceCall(sessionId, 'tasks', 'start'))
          }
        >
          {t('start ready tasks')}
        </Button>
      </header>
      <div id={'new-task-' + sessionId} hidden={!createOpen}>
        <form
          className="task-create-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!limits || configurationError || !tasksReady) return;
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
              disabled={
                busy ||
                !limits ||
                !!configurationError ||
                !tasksReady ||
                !prompt.trim() ||
                !criteria.trim()
              }
            >
              {t('queue task')}
            </Button>
          </div>
        </form>
      </div>
      {requiresStart && !configurationError && (
        <p role="status">
          {t('limits repaired; start queued tasks when ready')}
        </p>
      )}
      {configurationError && (
        <p role="alert" className="tasks-error">
          {t('fix collaboration limits in settings before starting tasks')}{' '}
          {configurationError}
        </p>
      )}
      {error && !configurationError && (
        <p role="alert" className="tasks-error">
          {error}
        </p>
      )}
      {!tasks.length && !error && <p>{t('no collaboration tasks')}</p>}
      <div className="tasks-list panel-section first">
        {tasks.map((task) => (
          <article
            key={task.spec.id}
            id={'task-' + task.spec.id}
            tabIndex={-1}
            data-state={task.state}
          >
            <details className="task-entry">
              <summary className="activity-row task-row">
                <Users size={15} aria-hidden="true" />
                <span>
                  <strong>
                    {task.spec.prompt
                      .split(/\r?\n/)
                      .find((line) => line.trim()) ?? task.spec.prompt}
                  </strong>
                  <small>{t('attempt {n}', { n: task.attempt })}</small>
                </span>
                <Status value={task.state} />
                <ChevronRight
                  className="task-row-chevron"
                  size={13}
                  aria-hidden="true"
                />
              </summary>
              <div className="task-detail">
                <p className="task-instruction">{task.spec.prompt}</p>
                <details className="task-technical">
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
                  {[
                    'failed',
                    'cancelled',
                    'interrupted',
                    'needs_review',
                  ].includes(task.state) && (
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
              </div>
            </details>
          </article>
        ))}
      </div>
      <details className="panel-section task-settings task-technical">
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
                  limits: {
                    agents: Number(agents),
                    builds: limits!.builds,
                    ui: limits!.ui,
                    browsers: limits!.browsers,
                  },
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

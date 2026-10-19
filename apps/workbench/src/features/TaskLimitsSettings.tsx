import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { workspaceCall } from '../model/workspace-client';
import { Button } from '../components/common';
import { t } from '../i18n';
import './task-panel.css';

interface Limits {
  agents: number;
  builds: number;
  ui: number;
  browsers: number;
}
/** Fired after the limits are saved, so an open tasks panel reads them again. */
export const TASK_LIMITS_CHANGED = 'circle-task-limits-changed';

/**
 * How many task agents may run at once. The limits are kept for the whole application; the
 * session only routes the request. The other pools are sent back as they were read. After
 * limits that could not be read were repaired here, queued tasks wait until the person
 * starts them, folder by folder: the start is here, for the folder of this session.
 */
export function TaskLimitsSettings({ sessionId }: { sessionId: string }) {
  const id = useId();
  const [limits, setLimits] = useState<Limits | null>(null);
  const [agents, setAgents] = useState('');
  const [problem, setProblem] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [requiresStart, setRequiresStart] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const value = await workspaceCall<
        Limits & { error?: string; requiresStart?: boolean }
      >(sessionId, 'tasks', 'settings');
      if (epoch !== generation.current) return;
      const { agents, builds, ui, browsers } = value;
      setLimits({ agents, builds, ui, browsers });
      setAgents(String(agents));
      setProblem(value.error ?? '');
      setRequiresStart(value.requiresStart === true);
      setError('');
    } catch (reason) {
      if (epoch === generation.current) {
        setLimits(null);
        setError(String(reason));
      }
    }
  }, [sessionId]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const value = Number(agents);
  const valid = Number.isInteger(value) && value >= 1 && value <= 32;
  return (
    <section
      className="settings-block task-limits-settings"
      aria-label={t('parallel tasks')}
    >
      <h2>{t('parallel tasks')}</h2>
      <div className="setting-row">
        <label htmlFor={id}>
          {t('agents at once')}
          <small>
            {t('how many task agents can work at the same time, 1 to 32')}
          </small>
        </label>
        <input
          id={id}
          className="input task-limits-input"
          type="number"
          min={1}
          max={32}
          value={agents}
          disabled={!limits}
          onChange={(event) => {
            setAgents(event.target.value);
            setSaved(false);
          }}
        />
        <Button
          disabled={busy || !limits || !valid}
          onClick={() => {
            if (!limits) return;
            setBusy(true);
            setError('');
            void workspaceCall(sessionId, 'tasks', 'settings', {
              limits: {
                agents: value,
                builds: limits.builds,
                ui: limits.ui,
                browsers: limits.browsers,
              },
            })
              .then(async () => {
                setSaved(true);
                await load();
                window.dispatchEvent(new Event(TASK_LIMITS_CHANGED));
              })
              .catch((reason) => setError(String(reason)))
              .finally(() => setBusy(false));
          }}
        >
          {t('save')}
        </Button>
      </div>
      {saved && !problem && !error && (
        <p role="status" className="panel-note">
          {t('saved')}
        </p>
      )}
      {requiresStart && !problem && (
        <p role="status" className="task-limits-start">
          <Button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError('');
              void workspaceCall(sessionId, 'tasks', 'start')
                .then(load)
                .catch((reason) => setError(String(reason)))
                .finally(() => setBusy(false));
            }}
          >
            {t('start queued tasks')}
          </Button>
        </p>
      )}
      {problem && (
        <p role="alert" className="task-limits-problem">
          {t('the saved limit could not be read; save a value to fix it')}
          <small>{problem}</small>
        </p>
      )}
      {error && (
        <p role="alert" className="task-limits-problem">
          {error}
        </p>
      )}
    </section>
  );
}

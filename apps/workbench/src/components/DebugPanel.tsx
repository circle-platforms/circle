import { useEffect, useState, useRef } from 'react';
import { t } from '../i18n';
import { Button, Status } from './common';
import { workspaceCall, subscribeWorkspace } from '../model/workspace-client';
import './debug-panel.css';

type Snapshot = {
  status: string;
  pauseId?: number;
  reason?: string;
  output: string;
  breakpoints: Record<string, any[]>;
};
export function DebugPanel({
  sessionId,
  onFile,
  embedded = false,
}: {
  sessionId: string;
  embedded?: boolean;
  onFile?: (path: string, line?: number) => void;
}) {
  const context = useRef({
    sessionId,
    epoch: 0,
    pause: 0,
    inspection: 0,
    key: '',
  });
  const refreshSequence = useRef(0);
  const evaluationSequence = useRef(0);
  if (context.current.sessionId !== sessionId) {
    context.current = {
      sessionId,
      epoch: context.current.epoch + 1,
      pause: context.current.pause + 1,
      inspection: context.current.inspection + 1,
      key: '',
    };
  }
  const ticket = (scope: 'session' | 'pause' | 'inspection' = 'pause') => {
    const expected = { ...context.current };
    return () =>
      context.current.sessionId === expected.sessionId &&
      context.current.epoch === expected.epoch &&
      (scope === 'session' || context.current.pause === expected.pause) &&
      (scope !== 'inspection' ||
        context.current.inspection === expected.inspection);
  };
  const statuses: Record<string, string> = {
    idle: t('debug idle'),
    starting: t('debug starting'),
    running: t('debug running'),
    paused: t('debug paused'),
    stopped: t('debug stopped'),
    failed: t('debug failed'),
  };
  const [snapshot, setState] = useState<Snapshot & { sessionId: string }>({
    sessionId,
    status: 'idle',
    output: '',
    breakpoints: {},
  });
  const state: Snapshot =
    snapshot.sessionId === sessionId
      ? snapshot
      : { status: 'idle', output: '', breakpoints: {} };
  const [program, setProgram] = useState('');
  const [port, setPort] = useState('9229');
  const [args, setArgs] = useState<string[]>([]);
  const [stopOnEntry, setStopOnEntry] = useState(false);
  const [line, setLine] = useState('1');
  const [frames, setFrames] = useState<any[]>([]);
  const [variables, setVariables] = useState<any[]>([]);
  const [scopeList, setScopeList] = useState<any[]>([]);
  const [expression, setExpression] = useState('');
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const call = <T,>(method: string, params: Record<string, unknown> = {}) =>
    workspaceCall<T>(sessionId, 'debug', method, params);
  const refresh = () => {
    const current = ticket('session');
    const sequence = ++refreshSequence.current;
    return call<Snapshot>('snapshot')
      .then((next) => {
        if (!current() || sequence !== refreshSequence.current) return;
        const key = `${next.status}:${next.pauseId ?? ''}`;
        if (key !== context.current.key) {
          context.current.key = key;
          context.current.pause++;
          context.current.inspection++;
          setFrames([]);
          setScopeList([]);
          setVariables([]);
          setResult('');
        }
        setState({ ...next, sessionId });
      })
      .catch((error) => {
        if (current() && sequence === refreshSequence.current)
          setError(String(error));
      });
  };
  useEffect(() => {
    setError('');
    setFrames([]);
    setVariables([]);
    setScopeList([]);
    setResult('');
    setExpression('');
    setBusy(false);
    void refresh();
    return subscribeWorkspace((event) => {
      if (event.sessionId === sessionId && event.service === 'debug')
        void refresh();
    });
  }, [sessionId]);
  useEffect(() => {
    const current = ticket();
    if (state.status === 'paused')
      void call<any>('stackTrace')
        .then((result) => {
          if (current()) setFrames(result.stackFrames ?? []);
        })
        .catch((error) => {
          if (current()) setError(String(error));
        });
    else {
      setFrames([]);
      setScopeList([]);
      setVariables([]);
      setResult('');
    }
  }, [
    sessionId,
    snapshot.sessionId,
    state.status,
    state.reason,
    state.pauseId,
  ]);
  async function act(method: string, params: Record<string, unknown> = {}) {
    const current = ticket('session');
    setBusy(true);
    setError('');
    try {
      await call(method, params);
      if (current()) await refresh();
    } catch (error) {
      if (current()) setError(String(error));
    } finally {
      if (current()) setBusy(false);
    }
  }
  async function loadVariables(variablesReference: number) {
    context.current.inspection++;
    const current = ticket('inspection');
    setVariables([]);
    try {
      const result = await call<any>('variables', { variablesReference });
      if (current()) setVariables(result.variables);
    } catch (error) {
      if (current()) setError(String(error));
    }
  }
  async function inspect(frame: any) {
    context.current.inspection++;
    const current = ticket('inspection');
    setScopeList([]);
    setVariables([]);
    if (frame.source?.path && !frame.source.path.startsWith('<'))
      onFile?.(frame.source.path, frame.line);
    try {
      const scopes = await call<any>('scopes', { frameId: frame.id });
      if (!current()) return;
      setScopeList(scopes.scopes);
      const initial =
        scopes.scopes.find((scope: any) => !scope.expensive) ??
        scopes.scopes[0];
      if (initial) {
        const result = await call<any>('variables', {
          variablesReference: initial.variablesReference,
        });
        if (current()) setVariables(result.variables);
      }
    } catch (error) {
      if (current()) setError(String(error));
    }
  }
  async function evaluate() {
    const current = ticket();
    const sequence = ++evaluationSequence.current;
    setResult('');
    try {
      const result = await call<any>('evaluate', {
        expression,
        frameId: frames[0]?.id,
        context: 'repl',
      });
      if (current() && sequence === evaluationSequence.current)
        setResult(result.result);
    } catch (error) {
      if (current() && sequence === evaluationSequence.current)
        setError(String(error));
    }
  }
  return (
    <section
      className={`debug-panel${embedded ? ' embedded' : ''}`}
      aria-label={t('project debug')}
    >
      <div className="inspector-heading debug-heading">
        {!embedded && <h2>{t('project debug')}</h2>}
        <span role="status" className="debug-status">
          <Status
            value={
              ['idle', 'running', 'failed'].includes(state.status)
                ? state.status
                : (statuses[state.status] ?? state.status)
            }
          />
          {state.reason && <small>{state.reason}</small>}
        </span>
      </div>
      <div className="panel-section first debug-launch">
        <div className="debug-controls">
          <input
            aria-label={t('program path')}
            placeholder={t('program path')}
            value={program}
            onChange={(e) => setProgram(e.target.value)}
          />
          <Button
            disabled={
              busy ||
              !program ||
              !['idle', 'stopped', 'failed'].includes(state.status)
            }
            onClick={() => void act('launch', { program, args, stopOnEntry })}
          >
            {t('launch')}
          </Button>
        </div>
        <details className="debug-launch-options">
          <summary>{t('launch options')}</summary>
          <p>
            {t('each argument is passed literally without shell expansion')}
          </p>
          {args.map((argument, index) => (
            <div className="debug-argument" key={index}>
              <input
                aria-label={`${t('program argument')} ${index + 1}`}
                value={argument}
                onChange={(event) =>
                  setArgs((current) =>
                    current.map((value, i) =>
                      i === index ? event.target.value : value,
                    ),
                  )
                }
              />
              <Button
                onClick={() =>
                  setArgs((current) => current.filter((_, i) => i !== index))
                }
              >
                {t('remove argument')} {index + 1}
              </Button>
            </div>
          ))}
          <Button onClick={() => setArgs((current) => [...current, ''])}>
            {t('add argument')}
          </Button>
          <label className="debug-entry-option">
            <input
              type="checkbox"
              checked={stopOnEntry}
              onChange={(event) => setStopOnEntry(event.target.checked)}
            />
            {t('pause at entry')}
          </label>
        </details>
        <details className="debug-attach">
          <summary>{t('attach')}</summary>
          <div className="debug-controls">
            <input
              aria-label={t('inspector port')}
              type="number"
              min="1"
              max="65535"
              value={port}
              onChange={(e) => setPort(e.target.value)}
            />
            <Button
              disabled={
                busy || !['idle', 'stopped', 'failed'].includes(state.status)
              }
              onClick={() => void act('attach', { port: Number(port) })}
            >
              {t('attach')}
            </Button>
          </div>
        </details>
      </div>
      <div className="panel-section debug-run">
        <div className="debug-controls">
          <input
            aria-label={t('breakpoint line')}
            type="number"
            min="1"
            value={line}
            onChange={(e) => setLine(e.target.value)}
          />
          <Button
            disabled={busy || !program}
            onClick={() =>
              void act('setBreakpoints', {
                path: program,
                lines: [Number(line)],
              })
            }
          >
            {t('set breakpoint')}
          </Button>
          <Button
            disabled={busy || state.status !== 'paused'}
            onClick={() => void act('continue')}
          >
            {t('continue')}
          </Button>
          <Button
            disabled={busy || state.status !== 'running'}
            onClick={() => void act('pause')}
          >
            {t('pause')}
          </Button>
          <Button
            disabled={busy || state.status !== 'paused'}
            onClick={() => void act('next')}
          >
            {t('step over')}
          </Button>
          <Button
            disabled={busy || state.status !== 'paused'}
            onClick={() => void act('stepIn')}
          >
            {t('step into')}
          </Button>
          <Button
            disabled={busy || state.status !== 'paused'}
            onClick={() => void act('stepOut')}
          >
            {t('step out')}
          </Button>
          <Button
            disabled={['idle', 'stopped'].includes(state.status)}
            onClick={() => void act('stop')}
          >
            {t('stop')}
          </Button>
        </div>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="debug-inspection">
        <section className="panel-section">
          <h3>{t('call stack')}</h3>
          {frames.map((f) => (
            <button
              className="activity-row"
              key={f.id}
              onClick={() => void inspect(f)}
            >
              <span>
                <strong>{f.name}</strong>
                <small>
                  {f.source?.name ?? f.source?.path}:{f.line}
                </small>
              </span>
            </button>
          ))}
        </section>
        <section className="panel-section">
          <h3>{t('variables')}</h3>
          {scopeList.map((scope) => (
            <Button
              key={scope.variablesReference}
              onClick={() => void loadVariables(scope.variablesReference)}
            >
              {scope.name}
            </Button>
          ))}
          {variables.map((v, i) => (
            <div key={i}>
              <Button
                disabled={!v.variablesReference}
                onClick={() => void loadVariables(v.variablesReference)}
              >
                {v.name}
              </Button>
              <code>{v.value}</code>
            </div>
          ))}
        </section>
      </div>
      <form
        className="panel-section debug-evaluate"
        onSubmit={(e) => {
          e.preventDefault();
          void evaluate();
        }}
      >
        <input
          aria-label={t('debug expression')}
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
        />
        <Button disabled={state.status !== 'paused'}>{t('evaluate')}</Button>
        <output>{result}</output>
      </form>
      <details className="panel-section">
        <summary>{t('breakpoints')}</summary>
        {Object.entries(state.breakpoints).flatMap(([file, rows]) =>
          rows.map((row, i) => (
            <div className="debug-breakpoint" key={`${file}:${i}`}>
              <Button onClick={() => onFile?.(file, row.line)}>
                {file}:{row.line}
              </Button>
              <span>
                {row.verified
                  ? t('verified breakpoint')
                  : t('pending breakpoint')}
              </span>
              <Button
                onClick={() =>
                  void act('setBreakpoints', {
                    path: file,
                    lines: rows
                      .filter((_, index) => index !== i)
                      .map((b) => b.requestedLine ?? b.line),
                  })
                }
              >
                {t('remove breakpoint')}
              </Button>
            </div>
          )),
        )}
      </details>
      <section className="panel-section">
        <h3>{t('debug output')}</h3>
        <pre className="debug-output" aria-label={t('debug output')}>
          {state.output}
        </pre>
      </section>
    </section>
  );
}

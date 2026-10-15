import { useEffect, useState, useRef } from 'react';
import { t } from '../i18n';
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
}: {
  sessionId: string;
  onFile?: (path: string, line?: number) => void;
}) {
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  const statuses: Record<string, string> = {
    idle: t('debug idle'),
    starting: t('debug starting'),
    running: t('debug running'),
    paused: t('debug paused'),
    stopped: t('debug stopped'),
    failed: t('debug failed'),
  };
  const [state, setState] = useState<Snapshot>({
    status: 'idle',
    output: '',
    breakpoints: {},
  });
  const [program, setProgram] = useState('');
  const [port, setPort] = useState('9229');
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
    const requested = sessionId;
    return call<Snapshot>('snapshot')
      .then((s) => {
        if (activeSession.current === requested) setState(s);
      })
      .catch((e) => {
        if (activeSession.current === requested) setError(String(e));
      });
  };
  useEffect(() => {
    setError('');
    setFrames([]);
    setVariables([]);
    setResult('');
    void refresh();
    return subscribeWorkspace((event) => {
      if (event.sessionId === sessionId && event.service === 'debug')
        void refresh();
    });
  }, [sessionId]);
  useEffect(() => {
    if (state.status === 'paused')
      void call<any>('stackTrace')
        .then((r) => setFrames(r.stackFrames ?? []))
        .catch((e) => setError(String(e)));
    else {
      setFrames([]);
      setVariables([]);
    }
  }, [state.status, state.reason, state.pauseId]);
  async function act(method: string, params: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      await call(method, params);
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function inspect(frame: any) {
    if (frame.source?.path && !frame.source.path.startsWith('<'))
      onFile?.(frame.source.path, frame.line);
    try {
      const scopes = await call<any>('scopes', { frameId: frame.id });
      setScopeList(scopes.scopes);
      const initial =
        scopes.scopes.find((s: any) => !s.expensive) ?? scopes.scopes[0];
      if (initial) {
        const result = await call<any>('variables', {
          variablesReference: initial.variablesReference,
        });
        setVariables(result.variables);
      } else setVariables([]);
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <section className="debug-panel" aria-label={t('project debug')}>
      <header>
        <strong>{t('project debug')}</strong>
        <span role="status">
          {statuses[state.status] ?? state.status}
          {state.reason ? ` · ${state.reason}` : ''}
        </span>
      </header>
      <div className="debug-controls">
        <input
          aria-label={t('program path')}
          placeholder={t('program path')}
          value={program}
          onChange={(e) => setProgram(e.target.value)}
        />
        <button
          disabled={
            busy ||
            !program ||
            !['idle', 'stopped', 'failed'].includes(state.status)
          }
          onClick={() => void act('launch', { program })}
        >
          {t('launch')}
        </button>
        <input
          aria-label={t('inspector port')}
          type="number"
          min="1"
          max="65535"
          value={port}
          onChange={(e) => setPort(e.target.value)}
        />
        <button
          disabled={
            busy || !['idle', 'stopped', 'failed'].includes(state.status)
          }
          onClick={() => void act('attach', { port: Number(port) })}
        >
          {t('attach')}
        </button>
      </div>
      <div className="debug-controls">
        <input
          aria-label={t('breakpoint line')}
          type="number"
          min="1"
          value={line}
          onChange={(e) => setLine(e.target.value)}
        />
        <button
          disabled={busy || !program}
          onClick={() =>
            void act('setBreakpoints', { path: program, lines: [Number(line)] })
          }
        >
          {t('set breakpoint')}
        </button>
        <button
          disabled={busy || state.status !== 'paused'}
          onClick={() => void act('continue')}
        >
          {t('continue')}
        </button>
        <button
          disabled={busy || state.status !== 'running'}
          onClick={() => void act('pause')}
        >
          {t('pause')}
        </button>
        <button
          disabled={busy || state.status !== 'paused'}
          onClick={() => void act('next')}
        >
          {t('step over')}
        </button>
        <button
          disabled={busy || state.status !== 'paused'}
          onClick={() => void act('stepIn')}
        >
          {t('step into')}
        </button>
        <button
          disabled={busy || state.status !== 'paused'}
          onClick={() => void act('stepOut')}
        >
          {t('step out')}
        </button>
        <button
          disabled={['idle', 'stopped'].includes(state.status)}
          onClick={() => void act('stop')}
        >
          {t('stop')}
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="debug-inspection">
        <section>
          <h3>{t('call stack')}</h3>
          {frames.map((f) => (
            <button key={f.id} onClick={() => void inspect(f)}>
              {f.name} · {f.source?.name ?? f.source?.path}:{f.line}
            </button>
          ))}
        </section>
        <section>
          <h3>{t('variables')}</h3>
          {scopeList.map((scope) => (
            <button
              key={scope.variablesReference}
              onClick={() =>
                void call<any>('variables', {
                  variablesReference: scope.variablesReference,
                })
                  .then((r) => setVariables(r.variables))
                  .catch((e) => setError(String(e)))
              }
            >
              {scope.name}
            </button>
          ))}
          {variables.map((v, i) => (
            <div key={i}>
              <button
                disabled={!v.variablesReference}
                onClick={() =>
                  void call<any>('variables', {
                    variablesReference: v.variablesReference,
                  })
                    .then((r) => setVariables(r.variables))
                    .catch((e) => setError(String(e)))
                }
              >
                {v.name}
              </button>
              <code>{v.value}</code>
            </div>
          ))}
        </section>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void call<any>('evaluate', {
            expression,
            frameId: frames[0]?.id,
            context: 'repl',
          })
            .then((r) => setResult(r.result))
            .catch((e) => setError(String(e)));
        }}
      >
        <input
          aria-label={t('debug expression')}
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
        />
        <button disabled={state.status !== 'paused'}>{t('evaluate')}</button>
        <output>{result}</output>
      </form>
      <details>
        <summary>{t('breakpoints')}</summary>
        {Object.entries(state.breakpoints).flatMap(([file, rows]) =>
          rows.map((row, i) => (
            <div className="debug-breakpoint" key={`${file}:${i}`}>
              <button onClick={() => onFile?.(file, row.line)}>
                {file}:{row.line}
              </button>
              <span>
                {row.verified
                  ? t('verified breakpoint')
                  : t('pending breakpoint')}
              </span>
              <button
                onClick={() =>
                  void act('setBreakpoints', {
                    path: file,
                    lines: rows
                      .filter((_, index) => index !== i)
                      .map((b) => b.line),
                  })
                }
              >
                {t('remove breakpoint')}
              </button>
            </div>
          )),
        )}
      </details>
      <pre className="debug-output" aria-label={t('debug output')}>
        {state.output}
      </pre>
    </section>
  );
}

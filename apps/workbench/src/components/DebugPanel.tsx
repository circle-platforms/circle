import {
  DebugSourceLabel,
  DebugBreakpointRow,
  DebugVariableRow,
  internalFrame,
} from './DebugRows';
import { useEffect, useState, useRef } from 'react';
import { t, tn } from '../i18n';
import { copyText } from '../host';
import { Button, Status } from './common';
import { DebugToolbar } from './DebugToolbar';
import { workspaceCall, subscribeWorkspace } from '../model/workspace-client';
import './debug-panel.css';

type Snapshot = {
  status: string;
  pauseId?: number;
  reason?: string;
  adapterPid?: number;
  debugTerminals?: { id: string; epoch: string }[];
  output: string;
  breakpoints: Record<string, any[]>;
};
export function DebugPanel({
  sessionId,
  onFile,
  embedded = false,
  sourceRequest,
  onOpenTerminal,
  workspaceRoot,
}: {
  sessionId: string;
  /** Sources inside it are shown relative to it. */
  workspaceRoot?: string;
  sourceRequest?: { id: string; path: string; line?: number };
  embedded?: boolean;
  onOpenTerminal?: (target: { id: string; epoch: string }) => void;
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
  const [copying, setCopying] = useState(false);
  const [showInternal, setShowInternal] = useState(false);
  const copyOutput = async () => {
    const current = ticket('session');
    setCopying(true);
    try {
      let after = { offset: 0, seq: 0 };
      const chunks: string[] = [];
      let throughSeq: number | undefined;
      for (;;) {
        const page = await workspaceCall<{
          events: { data: { text: string } }[];
          cursor: typeof after;
          hasMore: boolean;
          throughSeq: number;
        }>(sessionId, 'debug', 'output', { after, throughSeq });
        if (!current()) return;
        throughSeq = page.throughSeq;
        for (const event of page.events) chunks.push(event.data.text);
        if (!page.hasMore) break;
        if (page.cursor.offset <= after.offset)
          throw Error(t('debug output cursor did not advance'));
        after = page.cursor;
      }
      if (current()) await copyText(chunks.join(''));
    } catch (failure) {
      if (current()) setError(String(failure));
    } finally {
      if (current()) setCopying(false);
    }
  };
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
    setCopying(false);
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
  const preparedSource = useRef('');
  useEffect(() => {
    if (
      !sourceRequest ||
      preparedSource.current === sessionId + ':' + sourceRequest.id
    )
      return;
    preparedSource.current = sessionId + ':' + sourceRequest.id;
    setProgram(sourceRequest.path);
    if (
      !sourceRequest.line ||
      !Number.isSafeInteger(sourceRequest.line) ||
      sourceRequest.line < 1
    )
      return;
    setLine(String(sourceRequest.line));
    const current = ticket('session');
    const requestKey = preparedSource.current;
    void call<Snapshot>('setBreakpoints', {
      path: sourceRequest.path,
      lines: [sourceRequest.line],
      add: true,
    })
      .then(() => {
        if (current() && preparedSource.current === requestKey) void refresh();
      })
      .catch((error) => {
        if (current() && preparedSource.current === requestKey)
          setError(String(error));
      });
  }, [sessionId, sourceRequest?.id, sourceRequest?.path, sourceRequest?.line]);
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
          {state.status === 'paused' && pauseReason(state.reason) && (
            <small>{pauseReason(state.reason)}</small>
          )}
        </span>
      </div>
      <DebugToolbar
        busy={busy}
        enabled={(action) =>
          action === 'pause'
            ? state.status === 'running'
            : action === 'stop'
              ? !['idle', 'stopped'].includes(state.status)
              : state.status === 'paused'
        }
        onAction={(action) => void act(action)}
      />
      <div className="panel-section first debug-launch">
        <div className="debug-controls">
          <input
            aria-label={t('program path')}
            placeholder={t('program path')}
            value={program}
            onChange={(e) => setProgram(e.target.value)}
          />
          <Button
            className="primary"
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
          <summary>{t('attach to a running process')}</summary>
          <div className="debug-controls">
            <input
              aria-label={t('inspector port')}
              placeholder={t('inspector port')}
              title={t('the port given to node --inspect')}
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
      <details className="panel-section debug-run">
        <summary>{t('breakpoints')}</summary>
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
                add: true,
              })
            }
          >
            {t('set breakpoint')}
          </Button>
        </div>
        {Object.entries(state.breakpoints).flatMap(([file, rows]) =>
          rows.map((row, i) => (
            <DebugBreakpointRow
              key={`${file}:${i}`}
              root={workspaceRoot}
              path={file}
              line={row.line}
              verified={row.verified}
              onOpen={() => onFile?.(file, row.line)}
              onRemove={() =>
                void act('setBreakpoints', {
                  path: file,
                  lines: rows
                    .filter((_, index) => index !== i)
                    .map((b) => b.requestedLine ?? b.line),
                })
              }
            />
          )),
        )}
      </details>
      {error && <p role="alert">{error}</p>}
      <div className="debug-inspection">
        <section className="panel-section">
          <h3>{t('call stack')}</h3>
          {!frames.length && (
            <p className="debug-empty">
              {state.status === 'paused' ? t('loading…') : t('not paused')}
            </p>
          )}
          <div className="debug-frames">
            {frames
              .filter((f) => showInternal || !frameInternal(f))
              .map((f) => (
                <button
                  className={`activity-row${frameInternal(f) ? ' debug-frame-internal' : ''}`}
                  key={f.id}
                  onClick={() => void inspect(f)}
                >
                  <DebugSourceLabel
                    name={f.name}
                    path={framePath(f)}
                    root={workspaceRoot}
                    line={f.line}
                  />
                </button>
              ))}
          </div>
          {frames.some((f) => frameInternal(f)) && (
            <button
              type="button"
              className="debug-internal-toggle"
              aria-expanded={showInternal}
              onClick={() => setShowInternal((value) => !value)}
            >
              {showInternal
                ? t('hide runtime frames')
                : tn(
                    frames.filter((f) => frameInternal(f)).length,
                    'show {n} runtime frame',
                    'show {n} runtime frames',
                  )}
            </button>
          )}
        </section>
        <section className="panel-section">
          <h3>{t('variables')}</h3>
          {!scopeList.length && !variables.length && (
            <p className="debug-empty">
              {state.status === 'paused'
                ? t('choose a frame to see its variables')
                : t('not paused')}
            </p>
          )}
          {scopeList.map((scope) => (
            <Button
              key={scope.variablesReference}
              onClick={() => void loadVariables(scope.variablesReference)}
            >
              {scope.name}
            </Button>
          ))}
          {variables.map((v, i) => (
            <DebugVariableRow
              key={i}
              name={v.name}
              value={v.value}
              onExpand={
                v.variablesReference
                  ? () => void loadVariables(v.variablesReference)
                  : undefined
              }
            />
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
          placeholder={
            state.status === 'paused'
              ? t('expression to evaluate')
              : t('pause to evaluate an expression')
          }
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
        />
        <Button disabled={state.status !== 'paused'}>{t('evaluate')}</Button>
        <output>{result}</output>
      </form>
      <section className="panel-section">
        <h3>{t('debug output')}</h3>
        <Button disabled={copying} onClick={() => void copyOutput()}>
          {t('copy complete debug output')}
        </Button>
        {state.debugTerminals?.map((terminal, index, all) => (
          <Button
            key={terminal.id}
            disabled={!onOpenTerminal}
            onClick={() => onOpenTerminal?.(terminal)}
          >
            {t('open debug terminal')}
            {all.length > 1 ? ` ${index + 1}` : ''}
          </Button>
        ))}
        <pre className="debug-output" aria-label={t('debug output')}>
          {state.output}
        </pre>
      </section>
    </section>
  );
}
function framePath(frame: any): string {
  return frame.source?.path ?? frame.source?.name ?? '';
}
function frameInternal(frame: any): boolean {
  return (
    internalFrame(frame.source?.path ?? '') ||
    internalFrame(frame.source?.name ?? '')
  );
}
/** Why the program stopped, in words; reasons people do not act on stay out. */
function pauseReason(reason?: string): string {
  switch (reason) {
    case 'breakpoint':
      return t('at a breakpoint');
    case 'step':
      return t('after a step');
    case 'exception':
      return t('on an exception');
    case 'entry':
      return t('at entry');
    default:
      return '';
  }
}

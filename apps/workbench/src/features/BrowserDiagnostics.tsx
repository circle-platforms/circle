import { useEffect, useRef, useState } from 'react';
import { desktopHost } from '../host';
import { t } from '../i18n';
import type {
  BrowserDiagnosticRequest,
  BrowserDiagnosticResult,
} from '../../../desktop/src/browser-diagnostics-contracts';
import './browser-diagnostics.css';

type Host = {
  browserDiagnostics?: (
    id: string,
    request: BrowserDiagnosticRequest,
  ) => Promise<BrowserDiagnosticResult>;
};
export function BrowserDiagnostics({
  sessionId,
  tab,
  url,
}: {
  sessionId: string;
  tab?: string;
  url: string;
}) {
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<
    'console' | 'network' | 'storage' | 'debug'
  >('console');
  const [result, setResult] = useState<BrowserDiagnosticResult>();
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'local' | 'session'>('local');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [width, setWidth] = useState('375');
  const [height, setHeight] = useState('812');
  const [source, setSource] = useState('');
  const [line, setLine] = useState('1');
  const identity = useRef('');
  identity.current = sessionId + ':' + tab;
  const request = async (r: BrowserDiagnosticRequest) => {
    const ownIdentity = identity.current;
    try {
      const host = desktopHost() as unknown as Host;
      if (!host?.browserDiagnostics) throw Error(t('diagnostics unavailable'));
      const response = await host.browserDiagnostics(sessionId, r);
      if (ownIdentity !== identity.current) return;
      setResult((previous) =>
        r.action === 'read' ? { ...previous, state: response.state } : response,
      );
      setError('');
    } catch (e) {
      if (ownIdentity !== identity.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    setResult(undefined);
    setError('');
  }, [sessionId, tab]);
  useEffect(() => {
    if (!open) return;
    let stopped = false;
    let pending = false;
    const read = async () => {
      if (pending || stopped) return;
      pending = true;
      await request({ action: 'read' });
      pending = false;
    };
    void read();
    const timer = setInterval(() => void read(), 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [open, sessionId, tab]);
  const storage = (operation: 'read' | 'set' | 'remove', entry = key) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      setError(t('open a page first'));
      return;
    }
    void request({
      action: 'storage',
      kind,
      origin,
      operation,
      key: entry,
      value,
    });
  };
  return (
    <section className="browser-diagnostics">
      <button aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('page diagnostics')}
      </button>
      {open && (
        <>
          <div className="browser-diagnostic-tools">
            <button onClick={() => void request({ action: 'devtools' })}>
              {t('hand over to devtools')}
            </button>
            <label>
              {t('viewport width')}
              <input
                value={width}
                onChange={(e) => setWidth(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <label>
              {t('viewport height')}
              <input
                value={height}
                onChange={(e) => setHeight(e.target.value)}
                inputMode="numeric"
              />
            </label>
            <button
              onClick={() =>
                void request({
                  action: 'viewport',
                  width: Number(width),
                  height: Number(height),
                  mobile: true,
                })
              }
            >
              {t('apply viewport')}
            </button>
            <button onClick={() => void request({ action: 'viewport' })}>
              {t('reset viewport')}
            </button>
          </div>
          <div className="browser-diagnostic-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={section === 'console'}
              onClick={() => setSection('console')}
            >
              {t('console')}
            </button>
            <button
              role="tab"
              aria-selected={section === 'network'}
              onClick={() => setSection('network')}
            >
              {t('network')}
            </button>
            <button
              role="tab"
              aria-selected={section === 'storage'}
              onClick={() => {
                setSection('storage');
                storage('read');
              }}
            >
              {t('storage')}
            </button>
            <button
              role="tab"
              aria-selected={section === 'debug'}
              onClick={() => setSection('debug')}
            >
              {t('page debugger')}
            </button>
          </div>
          {error && <p role="alert">{error}</p>}
          {result?.state.owner === 'devtools' && (
            <p>{t('devtools owns this page; close it to reconnect')}</p>
          )}
          <div className="browser-diagnostic-results" role="tabpanel">
            {section === 'console' && (
              <>
                <button
                  onClick={() => void request({ action: 'clearConsole' })}
                >
                  {t('clear console')}
                </button>
                {result?.state.console.map((entry) => (
                  <details key={entry.id}>
                    <summary>
                      {entry.level} · {entry.text}
                    </summary>
                    {entry.stack.map((f, i) => (
                      <div key={i}>
                        <code>
                          {f.name} {f.url}:{f.line}:{f.column}
                        </code>
                      </div>
                    ))}
                  </details>
                ))}
              </>
            )}
            {section === 'network' && (
              <>
                <button
                  onClick={() => void request({ action: 'clearNetwork' })}
                >
                  {t('clear network')}
                </button>
                {result?.state.network.map((n) => (
                  <div key={n.id}>
                    <button
                      onClick={() =>
                        void request({ action: 'response', requestId: n.id })
                      }
                    >
                      {n.method} {n.status ?? '…'} {n.url}
                    </button>
                    <span>
                      {n.duration === undefined
                        ? '…'
                        : Math.round(n.duration) + ' ms'}{' '}
                      {n.error}
                    </span>
                  </div>
                ))}
                {result?.response && (
                  <pre>
                    {result.response.base64Encoded
                      ? t('binary response (base64)')
                      : ''}
                    {result.response.body}
                  </pre>
                )}
              </>
            )}
            {section === 'storage' && (
              <>
                <select
                  aria-label={t('storage kind')}
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as 'local' | 'session');
                    setResult(undefined);
                  }}
                >
                  <option value="local">localStorage</option>
                  <option value="session">sessionStorage</option>
                </select>
                <button onClick={() => storage('read')}>
                  {t('refresh storage')}
                </button>
                <input
                  aria-label={t('storage key')}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <input
                  aria-label={t('storage value')}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <button onClick={() => storage('set')}>
                  {t('save storage item')}
                </button>
                {result?.storage?.map(([k, v]) => (
                  <div key={k}>
                    <code>
                      {k}: {v}
                    </code>
                    <button onClick={() => storage('remove', k)}>
                      {t('remove storage item')}
                    </button>
                  </div>
                ))}
              </>
            )}
            {section === 'debug' && (
              <>
                <div className="browser-diagnostic-tools">
                  {(
                    [
                      'pause',
                      'resume',
                      'stepOver',
                      'stepInto',
                      'stepOut',
                    ] as const
                  ).map((command) => (
                    <button
                      key={command}
                      onClick={() => void request({ action: 'debug', command })}
                    >
                      {command === 'pause'
                        ? t('pause')
                        : command === 'resume'
                          ? t('resume')
                          : command === 'stepOver'
                            ? t('step over')
                            : command === 'stepInto'
                              ? t('step into')
                              : t('step out')}
                    </button>
                  ))}
                </div>
                <input
                  aria-label={t('source URL')}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
                <input
                  aria-label={t('breakpoint line')}
                  value={line}
                  onChange={(e) => setLine(e.target.value)}
                />
                <button
                  onClick={() =>
                    void request({
                      action: 'debug',
                      command: 'breakpoints',
                      url: source,
                      line: Number(line),
                    })
                  }
                >
                  {t('add breakpoint')}
                </button>
                {result?.state.debugger.breakpoints.map((b) => (
                  <div key={b.id}>
                    <code>
                      {b.verified ? '●' : '○'} {b.source.path}:{b.line}
                    </code>
                    <button
                      onClick={() =>
                        void request({
                          action: 'debug',
                          command: 'removeBreakpoint',
                          reference: b.id,
                        })
                      }
                    >
                      {t('remove breakpoint')}
                    </button>
                  </div>
                ))}
                {result?.state.debugger.stackFrames.map((f) => (
                  <details key={f.id}>
                    <summary>
                      {f.name} {f.source.path}:{f.line}
                    </summary>
                    {f.scopes.map((s) => (
                      <button
                        key={s.variablesReference}
                        onClick={() =>
                          void request({
                            action: 'debug',
                            command: 'variables',
                            reference: s.variablesReference,
                          })
                        }
                      >
                        {s.name}
                      </button>
                    ))}
                  </details>
                ))}
                {result?.variables?.map((v) => (
                  <div key={v.name}>
                    <code>
                      {v.name}: {v.value}
                    </code>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

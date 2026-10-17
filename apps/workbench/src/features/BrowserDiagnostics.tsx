import {
  DebugSourceLabel,
  DebugBreakpointRow,
  DebugVariableRow,
} from '../components/DebugRows';
import { DebugToolbar } from '../components/DebugToolbar';
import { Button, Status } from '../components/common';
import { useSources, sourceLocation } from '../components/SourceNavigation';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { desktopHost, copyText } from '../host';
import { t } from '../i18n';
import type {
  BrowserDiagnosticEvent,
  BrowserDiagnosticRequest,
  BrowserDiagnosticResult,
} from '../../../desktop/src/browser-diagnostics-contracts';
import './browser-diagnostics.css';

type Host = {
  onBrowserDiagnosticEvent?: (
    listener: (event: BrowserDiagnosticEvent) => void,
  ) => () => void;
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
  const sources = useSources();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState<
    'console' | 'network' | 'storage' | 'debug'
  >('console');
  const [result, setResult] = useState<BrowserDiagnosticResult>();
  const [error, setError] = useState('');
  const [log, setLog] = useState<BrowserDiagnosticResult['log']>();
  const [logBusy, setLogBusy] = useState(false);
  const [logIncomplete, setLogIncomplete] = useState(false);
  const logGeneration = useRef(0);
  const [kind, setKind] = useState<'local' | 'session'>('local');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [width, setWidth] = useState('375');
  const [height, setHeight] = useState('812');
  const [source, setSource] = useState('');
  const [line, setLine] = useState('1');
  const [expression, setExpression] = useState('');
  const results = useRef<HTMLDivElement>(null);
  const followConsole = useRef(true);
  useLayoutEffect(() => {
    if (
      open &&
      section === 'console' &&
      followConsole.current &&
      results.current
    )
      results.current.scrollTop = results.current.scrollHeight;
  }, [open, section, result?.state.console.at(-1)?.id]);
  const selectedScope = useRef<string | undefined>(undefined);
  const latestPause = useRef({ identity: '', epoch: 0, paused: false });
  const latestConnection = useRef('');
  const evaluationSequence = useRef(0);
  const identity = useRef('');
  identity.current = sessionId + ':' + tab + ':' + url;
  if (latestPause.current.identity !== identity.current) {
    latestConnection.current = '';
    latestPause.current = {
      identity: identity.current,
      epoch: 0,
      paused: false,
    };
  }
  useEffect(() => {
    logGeneration.current++;
    setLog(undefined);
    setLogIncomplete(false);
    setLogBusy(false);
  }, [sessionId, tab, url, section, open, result?.stream?.epoch]);
  const readLog = async (complete = false, next = false) => {
    if (!tab || (section !== 'console' && section !== 'network')) return;
    const target = identity.current;
    const connection = latestConnection.current;
    const generation = ++logGeneration.current;
    const domain = section;
    const host = desktopHost() as Host | undefined;
    if (!host?.browserDiagnostics) return;
    const current = () =>
      identity.current === target &&
      latestConnection.current === connection &&
      logGeneration.current === generation;
    setLogBusy(true);
    try {
      let cursor = next ? log?.cursor : undefined;
      const pages: string[] = [];
      for (;;) {
        const response = await host.browserDiagnostics(sessionId, {
          action: 'log',
          tab,
          domain,
          cursor,
          limit: 256,
        });
        if (!current()) return;
        setLogIncomplete(!!response.state.logError);
        if (complete && response.state.logError)
          throw Error(t('browser log is incomplete'));
        const page = response.log;
        if (!page) throw Error('browser log is unavailable');
        if (!complete) {
          setLog(page);
          break;
        }
        pages.push(...page.entries.map((entry) => JSON.stringify(entry)));
        if (!page.hasMore) {
          await copyText(pages.join('\n'));
          break;
        }
        if (cursor && page.cursor.offset <= cursor.offset)
          throw Error('browser log is unavailable');
        cursor = page.cursor;
      }
    } catch (failure) {
      if (current()) setError(String(failure));
    } finally {
      if (current()) setLogBusy(false);
    }
  };
  const kindRef = useRef(kind);
  kindRef.current = kind;
  const apply = (
    response: BrowserDiagnosticResult,
    r: BrowserDiagnosticRequest,
  ) => {
    if (r.action === 'storage' && r.kind !== kindRef.current) return;
    const pauseEpoch = response.state.debugger.pauseEpoch ?? 0;
    if (
      response.stream?.epoch === latestConnection.current &&
      pauseEpoch < latestPause.current.epoch
    )
      return;
    if (response.stream?.epoch)
      latestConnection.current = response.stream.epoch;
    latestPause.current = {
      identity: identity.current,
      epoch: pauseEpoch,
      paused: response.state.debugger.paused,
    };
    setResult((previous) => ({
      ...previous,
      ...response,
      state: {
        ...response.state,
        console:
          response.domains && !response.domains.includes('console')
            ? (previous?.state.console ?? [])
            : response.state.console,
        network:
          response.domains && !response.domains.includes('network')
            ? (previous?.state.network ?? [])
            : response.state.network,
        debugger:
          response.domains && !response.domains.includes('debug')
            ? (previous?.state.debugger ?? response.state.debugger)
            : response.state.debugger,
      },
      variables: response.state.debugger.paused
        ? (response.variables ??
          (previous?.state.debugger.pauseEpoch ===
          response.state.debugger.pauseEpoch
            ? previous?.variables
            : undefined))
        : undefined,
      evaluation:
        response.state.debugger.paused &&
        previous?.state.debugger.pauseEpoch ===
          response.state.debugger.pauseEpoch &&
        previous?.stream?.epoch === response.stream?.epoch
          ? (response.evaluation ?? previous?.evaluation)
          : response.evaluation,
      ...(r.action === 'clearNetwork' ? { response: undefined } : {}),
    }));
  };
  const request = async (r: BrowserDiagnosticRequest) => {
    const ownIdentity = identity.current;
    const evaluation =
      r.action === 'debug' && r.command === 'evaluate'
        ? ++evaluationSequence.current
        : undefined;
    try {
      const host = desktopHost() as unknown as Host;
      if (!host?.browserDiagnostics) throw Error(t('diagnostics unavailable'));
      const response = await host.browserDiagnostics(sessionId, r);
      if (
        ownIdentity !== identity.current ||
        (evaluation !== undefined && evaluation !== evaluationSequence.current)
      )
        return;
      if (
        r.action === 'debug' &&
        r.command === 'evaluate' &&
        (r.expectedPauseEpoch !== latestPause.current.epoch ||
          !latestPause.current.paused ||
          response.stream?.epoch !== r.expectedConnectionEpoch ||
          latestConnection.current !== r.expectedConnectionEpoch)
      )
        return;
      apply(response, r);
      if (r.action !== 'read') setError('');
      if (r.action === 'debug' && r.command === 'evaluate') {
        const frame = response.state.debugger.stackFrames.find(
          (frame) => frame.id === r.frameId,
        );
        const scope =
          frame?.scopes.find((scope) => scope.name === selectedScope.current) ??
          frame?.scopes.find((scope) => scope.name === 'local');
        if (scope)
          void request({
            action: 'debug',
            command: 'variables',
            reference: scope.variablesReference,
            expectedPauseEpoch: r.expectedPauseEpoch,
            expectedConnectionEpoch: r.expectedConnectionEpoch,
          });
      }
    } catch (e) {
      if (
        ownIdentity !== identity.current ||
        (evaluation !== undefined && evaluation !== evaluationSequence.current)
      )
        return;
      if (
        r.action === 'debug' &&
        ['variables', 'evaluate'].includes(r.command) &&
        r.expectedPauseEpoch !== undefined &&
        (r.expectedPauseEpoch !== latestPause.current.epoch ||
          !latestPause.current.paused ||
          (r.expectedConnectionEpoch !== undefined &&
            r.expectedConnectionEpoch !== latestConnection.current))
      )
        return;
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    if (
      !open ||
      section !== 'debug' ||
      !result?.state.debugger.paused ||
      !selectedScope.current
    )
      return;
    const scope = result.state.debugger.stackFrames[0]?.scopes.find(
      (scope) => scope.name === selectedScope.current,
    );
    if (scope)
      void request({
        action: 'debug',
        command: 'variables',
        reference: scope.variablesReference,
        expectedPauseEpoch: result.state.debugger.pauseEpoch,
      });
  }, [
    open,
    section,
    result?.state.debugger.pauseEpoch,
    result?.state.debugger.paused,
  ]);
  useEffect(() => {
    selectedScope.current = undefined;
    setResult(undefined);
    setError('');
  }, [sessionId, tab, url]);
  useEffect(() => {
    if (!open || !tab) return;
    const host = desktopHost() as unknown as Host;
    if (!host?.browserDiagnostics) return;
    const ownIdentity = identity.current;
    let stopped = false,
      pending = false,
      dirty = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    let fullRead = true;
    let cursor: { epoch: string; sequence: number } | undefined;
    const subscription = crypto.randomUUID();
    const current = () => !stopped && identity.current === ownIdentity;
    const read = async () => {
      if (!current()) return;
      if (pending) {
        dirty = true;
        return;
      }
      pending = true;
      dirty = false;
      const readingFull = fullRead;
      try {
        const response = await host.browserDiagnostics!(sessionId, {
          action: 'read',
          domains: fullRead ? undefined : [section, 'debug'],
        });
        if (!current()) return;
        if (
          cursor &&
          response.stream &&
          (response.stream.epoch !== cursor.epoch ||
            response.stream.sequence < cursor.sequence)
        ) {
          dirty = true;
          return;
        }
        apply(response, { action: 'read' });
        if (fullRead && !readingFull) dirty = true;
        else fullRead = false;
        if (section === 'storage' && response.state.owner === 'circle') {
          const origin = new URL(url).origin;
          const storageRequest = {
            action: 'storage' as const,
            operation: 'read' as const,
            kind,
            origin,
          };
          const storageResponse = await host.browserDiagnostics!(
            sessionId,
            storageRequest,
          );
          if (current()) apply(storageResponse, storageRequest);
        }
      } catch (error) {
        if (current())
          setError(error instanceof Error ? error.message : String(error));
      } finally {
        pending = false;
        if (dirty && current()) schedule();
      }
    };
    const schedule = () => {
      dirty = true;
      if (!pending && !timer)
        timer = setTimeout(() => {
          timer = undefined;
          void read();
        }, 16);
    };
    const unsubscribe = host.onBrowserDiagnosticEvent?.((event) => {
      if (!current() || event.sessionId !== sessionId || event.tab !== tab)
        return;
      if (
        cursor &&
        event.epoch === cursor.epoch &&
        event.sequence <= cursor.sequence
      )
        return;
      // Epoch changes or sequence gaps invalidate cached observations: read the full current domain.
      const gap =
        !!cursor &&
        (event.epoch !== cursor.epoch || event.sequence > cursor.sequence + 1);
      if (gap) fullRead = true;
      cursor = { epoch: event.epoch, sequence: event.sequence };
      if (
        gap ||
        event.domains.some(
          (domain) =>
            domain === 'lifecycle' || domain === 'debug' || domain === section,
        )
      )
        schedule();
    });
    void host
      .browserDiagnostics(sessionId, {
        action: 'watch',
        tab,
        subscription,
        domains: [section, 'debug', 'lifecycle'],
        enabled: true,
      })
      .then(
        (response) => {
          if (current()) {
            if (!cursor) cursor = response.stream;
            schedule();
          }
        },
        (error) => {
          if (current()) setError(String(error));
        },
      );
    if (!host.onBrowserDiagnosticEvent) {
      void read();
      setError(t('live diagnostic updates unavailable'));
    }
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe?.();
      void host.browserDiagnostics!(sessionId, {
        action: 'watch',
        tab,
        subscription,
        domains: [],
        enabled: false,
      }).catch(() => {});
    };
  }, [open, sessionId, tab, url, section, kind]);
  const openSource = (url: string, line: number, column?: number) => {
    const location = sourceLocation(url);
    if (location && sources) sources.openFile(location.path, line, column);
    else void request({ action: 'source', url });
  };
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
    <section className="browser-diagnostics panel-section">
      <Button aria-expanded={open} onClick={() => setOpen(!open)}>
        {t('page diagnostics')}
      </Button>
      {open && (
        <>
          <details className="context-source browser-diagnostic-settings">
            <summary>{t('viewport and developer tools')}</summary>
            <div className="browser-diagnostic-tools">
              <Button onClick={() => void request({ action: 'devtools' })}>
                {t('hand over to devtools')}
              </Button>
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
              <Button
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
              </Button>
              <Button onClick={() => void request({ action: 'viewport' })}>
                {t('reset viewport')}
              </Button>
            </div>
          </details>
          <div className="browser-diagnostic-tabs segmented" role="tablist">
            <button
              role="tab"
              aria-selected={section === 'console'}
              className={section === 'console' ? 'active' : undefined}
              onClick={() => setSection('console')}
            >
              {t('console')}
            </button>
            <button
              role="tab"
              aria-selected={section === 'network'}
              className={section === 'network' ? 'active' : undefined}
              onClick={() => setSection('network')}
            >
              {t('network')}
            </button>
            <button
              role="tab"
              aria-selected={section === 'storage'}
              className={section === 'storage' ? 'active' : undefined}
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
              className={section === 'debug' ? 'active' : undefined}
              onClick={() => setSection('debug')}
            >
              {t('page debugger')}
            </button>
          </div>
          {(error || result?.state.reconnectError) && (
            <div role="alert">
              <p>{t('page status unavailable')}</p>
              <details className="context-source">
                <summary>{t('error details')}</summary>
                <pre>{error || result?.state.reconnectError}</pre>
              </details>
            </div>
          )}
          {!error && !result?.state.reconnectError && (
            <div role="status">
              <Status
                value={
                  !result
                    ? t('loading diagnostics')
                    : result.state.owner === 'devtools'
                      ? t('page status unavailable')
                      : result.state.debugger.paused
                        ? t('page paused')
                        : t('page running')
                }
              />
            </div>
          )}
          {result?.state.owner === 'devtools' && (
            <p>{t('devtools owns this page; close it to reconnect')}</p>
          )}
          {result?.source && (
            <details open className="browser-source-preview context-source">
              <summary>
                {t('browser source')} · {result.source.url}
              </summary>
              <pre>{result.source.content}</pre>
            </details>
          )}
          <div
            className="browser-diagnostic-results"
            role="tabpanel"
            ref={results}
            onScroll={() => {
              const node = results.current;
              if (node)
                followConsole.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 24;
            }}
          >
            {(section === 'console' || section === 'network') && (
              <>
                <div className="browser-diagnostic-tools">
                  <Button disabled={logBusy} onClick={() => void readLog()}>
                    {t('view log')}
                  </Button>
                  <Button
                    onClick={() =>
                      void request({
                        action:
                          section === 'console'
                            ? 'clearConsole'
                            : 'clearNetwork',
                      })
                    }
                  >
                    {t(
                      section === 'console' ? 'clear console' : 'clear network',
                    )}
                  </Button>
                </div>
                {(result?.state.logError || logIncomplete) && (
                  <p role="alert">{t('browser log is incomplete')}</p>
                )}
                {log?.domain === section && (
                  <details className="context-source" open>
                    <summary>{t('saved browser log')}</summary>
                    <div className="browser-diagnostic-tools">
                      <Button
                        onClick={() =>
                          void copyText(
                            log.entries
                              .map((entry) => JSON.stringify(entry))
                              .join('\n'),
                          )
                        }
                      >
                        {t('copy shown content')}
                      </Button>
                      <Button
                        disabled={
                          logBusy || logIncomplete || !!result?.state.logError
                        }
                        onClick={() => void readLog(true)}
                      >
                        {t('copy complete log')}
                      </Button>
                      <Button
                        disabled={logBusy || !log.hasMore}
                        onClick={() => void readLog(false, true)}
                      >
                        {t('next page')}
                      </Button>
                    </div>
                    <pre>
                      {log.entries
                        .map((entry) => JSON.stringify(entry))
                        .join('\n')}
                    </pre>
                  </details>
                )}
              </>
            )}
            {section === 'console' && (
              <>
                {result && !error && result.state.console.length === 0 && (
                  <p className="panel-note">{t('no console messages')}</p>
                )}
                {result?.state.console.map((entry) => (
                  <details
                    className="context-source"
                    key={entry.id}
                    data-console-id={entry.id}
                  >
                    <summary>
                      {entry.level} · {entry.text}
                    </summary>
                    {entry.stack.map((f, i) => (
                      <div key={i}>
                        <Button
                          onClick={() => openSource(f.url, f.line, f.column)}
                        >
                          {f.name} {f.url}:{f.line}:{f.column}
                        </Button>
                      </div>
                    ))}
                  </details>
                ))}
              </>
            )}
            {section === 'network' && (
              <>
                {result?.state.network.map((n) => (
                  <div key={n.id}>
                    <Button
                      onClick={() =>
                        void request({ action: 'response', requestId: n.id })
                      }
                    >
                      {n.method} {n.status ?? '…'} {n.url}
                    </Button>
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
                <Button onClick={() => storage('read')}>
                  {t('refresh storage')}
                </Button>
                <input
                  aria-label={t('storage key')}
                  placeholder={t('storage key')}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <input
                  aria-label={t('storage value')}
                  placeholder={t('storage value')}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
                <Button onClick={() => storage('set')}>
                  {t('save storage item')}
                </Button>
                {result?.storage?.map(([k, v]) => (
                  <div key={k}>
                    <code>
                      {k}: {v}
                    </code>
                    <Button onClick={() => storage('remove', k)}>
                      {t('remove storage item')}
                    </Button>
                  </div>
                ))}
              </>
            )}
            {section === 'debug' && (
              <>
                <DebugToolbar
                  stop={false}
                  continueLabel={t('resume')}
                  enabled={(action) =>
                    result?.state.owner === 'circle' &&
                    (action === 'pause'
                      ? !result.state.debugger.paused
                      : result.state.debugger.paused)
                  }
                  onAction={(action) => {
                    const command = (
                      {
                        continue: 'resume',
                        pause: 'pause',
                        next: 'stepOver',
                        stepIn: 'stepInto',
                        stepOut: 'stepOut',
                      } as const
                    )[action as Exclude<typeof action, 'stop'>];
                    if (command) void request({ action: 'debug', command });
                  }}
                />
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
                <Button
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
                </Button>
                {result?.state.debugger.breakpoints.map((b) => (
                  <DebugBreakpointRow
                    key={b.id}
                    path={b.source.path}
                    line={b.line}
                    verified={b.verified}
                    onOpen={() => void openSource(b.source.path, b.line, 1)}
                    onRemove={() =>
                      void request({
                        action: 'debug',
                        command: 'removeBreakpoint',
                        reference: b.id,
                      })
                    }
                  />
                ))}
                {result?.state.debugger.stackFrames.map((f) => (
                  <details className="context-source" key={f.id}>
                    <summary>
                      <DebugSourceLabel
                        name={f.name}
                        path={f.source.path}
                        line={f.line}
                      />
                    </summary>
                    <Button
                      onClick={() =>
                        openSource(f.source.path, f.line, f.column)
                      }
                    >
                      {t('open source location')}
                    </Button>
                    <form
                      className="debug-evaluate"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void request({
                          action: 'debug',
                          command: 'evaluate',
                          frameId: f.id,
                          expression,
                          expectedPauseEpoch: result.state.debugger.pauseEpoch,
                          expectedConnectionEpoch: result.stream?.epoch,
                        });
                      }}
                    >
                      <input
                        aria-label={t('debug expression')}
                        value={expression}
                        onChange={(event) => setExpression(event.target.value)}
                      />
                      <Button
                        disabled={
                          !result.state.debugger.paused ||
                          result.state.owner !== 'circle' ||
                          !result.stream?.epoch ||
                          !expression.trim()
                        }
                      >
                        {t('evaluate')}
                      </Button>
                      <output>
                        {result.evaluation?.frameId === f.id
                          ? result.evaluation.value
                          : ''}
                      </output>
                    </form>
                    {f.scopes.map((s) => (
                      <Button
                        key={s.variablesReference}
                        onClick={() => {
                          selectedScope.current = s.name;
                          void request({
                            action: 'debug',
                            command: 'variables',
                            reference: s.variablesReference,
                            expectedPauseEpoch:
                              result.state.debugger.pauseEpoch,
                          });
                        }}
                      >
                        {s.name}
                      </Button>
                    ))}
                  </details>
                ))}
                {result?.variables?.map((v) => (
                  <DebugVariableRow
                    key={v.name}
                    name={v.name}
                    value={v.value}
                  />
                ))}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}

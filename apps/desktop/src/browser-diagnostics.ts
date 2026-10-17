import { randomUUID } from 'node:crypto';
import { WorkspaceEventStream } from './workspace/event-stream';
import { join } from 'node:path';
import type {
  BrowserDiagnosticState,
  BrowserDiagnosticRequest,
  BrowserDiagnosticResult,
  BrowserDiagnosticDomain,
  BrowserDiagnosticEvent,
} from './browser-diagnostics-contracts';
type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
const LIMIT = 500;
/** Bounded independent diagnostics stream; never includes cookies or request headers. */
export class BrowserDiagnostics {
  state: BrowserDiagnosticState = {
    owner: 'circle',
    console: [],
    network: [],
    debugger: {
      paused: false,
      pauseEpoch: 0,
      stackFrames: [],
      breakpoints: [],
    },
  };
  private sequence = 0;
  private scriptUrls = new Map<string, string>();
  private epoch = randomUUID();
  private eventSequence = 0;
  private watchers = new Map<string, Set<BrowserDiagnosticDomain>>();
  private dirty = new Set<BrowserDiagnosticDomain>();
  private dirtyAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private logStreams = new Map<
    'console' | 'network',
    Promise<WorkspaceEventStream>
  >();
  private logPending: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  constructor(
    private send: Send,
    private emit: (
      event: Omit<BrowserDiagnosticEvent, 'sessionId' | 'tab'>,
    ) => void = () => {},
    private logTarget?: { directory: string; sessionId: string; tab: string },
  ) {}
  private logStream(domain: 'console' | 'network') {
    if (!this.logTarget) throw Error('browser log is unavailable');
    let stream = this.logStreams.get(domain);
    if (!stream) {
      stream = WorkspaceEventStream.open(
        join(
          this.logTarget.directory,
          this.logTarget.sessionId,
          this.logTarget.tab + '-' + domain + '.jsonl',
        ),
      );
      this.logStreams.set(domain, stream);
    }
    return stream;
  }
  private journal(
    domain: 'console' | 'network',
    data: Record<string, unknown>,
  ) {
    if (!this.logTarget || this.closing || this.state.logError) return;
    const target = this.logTarget;
    const epoch = this.epoch;
    // Take an immutable normalized copy, not Chromium's mutable request object.
    const normalized = JSON.parse(JSON.stringify(data));
    const write = (async () => {
      const stream = await this.logStream(domain);
      await stream.append({
        workspaceId: 'browser',
        sessionId: target.sessionId,
        service: 'events',
        resourceId: target.tab,
        sourceEpoch: epoch,
        data: normalized,
      });
    })();
    this.logPending = Promise.all([this.logPending, write]).catch(() => {
      this.state.logError = 'browser log could not be saved';
      this.invalidate('lifecycle');
    });
  }
  async log(
    domain: 'console' | 'network',
    cursor?: { offset: number; seq: number },
    limit = 256,
  ) {
    await this.logPending;
    const page = await (await this.logStream(domain)).replay(cursor, limit);
    return {
      state: this.state,
      log: {
        domain,
        entries: page.events.map((event) => ({
          seq: event.seq,
          at: event.at,
          epoch: event.sourceEpoch ?? event.epoch,
          data: event.data,
        })),
        cursor: page.cursor,
        hasMore: page.hasMore,
      },
    };
  }
  cursor() {
    return { epoch: this.epoch, sequence: this.eventSequence };
  }
  watch(
    subscription: string,
    domains: BrowserDiagnosticDomain[],
    enabled: boolean,
  ) {
    if (enabled) {
      if (!this.watchers.has(subscription) && this.watchers.size >= 32)
        throw Error('too many browser diagnostic subscriptions');
      this.watchers.set(subscription, new Set(domains));
    } else this.watchers.delete(subscription);
    if (!this.watchers.size) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.dirty.clear();
    }
    return { state: this.state, stream: this.cursor() };
  }
  clearWatches() {
    this.watchers.clear();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty.clear();
  }
  dispose(): Promise<void> {
    this.clearWatches();
    return (this.closing ??= (async () => {
      await this.logPending;
      await Promise.all(
        [...this.logStreams.values()].map(async (stream) =>
          (await stream).close(),
        ),
      );
    })());
  }
  invalidateConnection() {
    // DevTools can resume, navigate and finish requests while this CDP client
    // is detached. Old object and script ids cannot survive that ownership gap.
    this.scriptUrls.clear();
    this.state.debugger.pauseEpoch++;
    this.state.debugger.paused = false;
    this.state.debugger.stackFrames = [];
    for (const breakpoint of this.state.debugger.breakpoints)
      breakpoint.verified = false;
    for (const request of this.state.network)
      if (request.duration === undefined && !request.error)
        request.error = 'diagnostic connection interrupted before completion';
  }
  resetEpoch() {
    this.epoch = randomUUID();
    this.eventSequence = 0;
    this.invalidate('lifecycle');
  }
  invalidate(domain: BrowserDiagnosticDomain) {
    if (
      !this.watchers.size ||
      ![...this.watchers.values()].some(
        (domains) => domain === 'lifecycle' || domains.has(domain),
      )
    )
      return;
    if (!this.dirty.size) this.dirtyAt = Date.now();
    this.dirty.add(domain);
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        const domains = [...this.dirty];
        this.dirty.clear();
        if (!this.watchers.size) return;
        this.emit({
          ...this.cursor(),
          sequence: ++this.eventSequence,
          domains,
          at: this.dirtyAt,
          emittedAt: Date.now(),
          consoleId: this.state.console.at(-1)?.id,
        });
      }, 25);
  }

  async restoreBreakpoints() {
    for (const breakpoint of this.state.debugger.breakpoints) {
      // Chromium can retain the URL breakpoint across frontend handoff. Its id
      // is deterministic, so remove our old intent before restoring it.
      await this.send('Debugger.removeBreakpoint', {
        breakpointId: breakpoint.id,
      }).catch(() => {});
      const restored = await this.send('Debugger.setBreakpointByUrl', {
        url: breakpoint.source.path,
        lineNumber: breakpoint.line - 1,
      });
      breakpoint.id = restored.breakpointId;
      breakpoint.verified = !!restored.locations?.length;
    }
  }
  async enable() {
    await Promise.all(
      [
        'Runtime.enable',
        'Network.enable',
        'Debugger.enable',
        'DOMStorage.enable',
      ].map((method) => this.send(method)),
    );
  }
  event(method: string, p: any) {
    if (
      ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown'].includes(method)
    )
      this.invalidate('console');
    if (
      [
        'Network.requestWillBeSent',
        'Network.responseReceived',
        'Network.loadingFinished',
        'Network.loadingFailed',
      ].includes(method)
    )
      this.invalidate('network');
    if (
      [
        'Debugger.paused',
        'Debugger.resumed',
        'Debugger.breakpointResolved',
      ].includes(method)
    )
      this.invalidate('debug');
    if (method.startsWith('DOMStorage.')) this.invalidate('storage');
    if (method === 'Runtime.executionContextsCleared')
      this.invalidate('lifecycle');

    if (method === 'Debugger.scriptParsed')
      this.scriptUrls.set(p.scriptId, p.url);
    if (method === 'Debugger.breakpointResolved') {
      const breakpoint = this.state.debugger.breakpoints.find(
        (b) => b.id === p.breakpointId,
      );
      if (breakpoint) {
        breakpoint.verified = true;
        breakpoint.line = p.location.lineNumber + 1;
      }
    }

    if (
      method === 'Runtime.consoleAPICalled' ||
      method === 'Runtime.exceptionThrown'
    ) {
      const exception = p.exceptionDetails;
      this.state.console.push({
        id: ++this.sequence,
        level: exception ? 'error' : p.type,
        text: exception
          ? (exception.exception?.description ?? exception.text)
          : (p.args ?? [])
              .map((a: any) => String(a.value ?? a.description ?? a.type))
              .join(' '),
        timestamp: p.timestamp ?? Date.now(),
        stack:
          (exception?.stackTrace ?? p.stackTrace)?.callFrames?.map(
            (f: any) => ({
              url: f.url,
              line: f.lineNumber + 1,
              column: f.columnNumber + 1,
              name: f.functionName,
            }),
          ) ?? [],
      });
      this.journal('console', { ...this.state.console.at(-1)! });
      this.state.console = this.state.console.slice(-LIMIT);
    }
    if (method === 'Network.requestWillBeSent') {
      // A redirect shares a request id. Preserve its prior hop under a distinct key.
      const previous = this.state.network.find((n) => n.id === p.requestId);
      if (previous) {
        previous.id += ':redirect:' + ++this.sequence;
        previous.status = p.redirectResponse?.status;
        previous.duration = Math.max(
          0,
          (p.timestamp - previous.started) * 1000,
        );
      }
      this.state.network.push({
        id: p.requestId,
        url: p.request.url,
        method: p.request.method,
        started: p.timestamp,
      });
      this.state.network = this.state.network.slice(-LIMIT);
    }
    const request = this.state.network.find((n) => n.id === p.requestId);
    if (request && method === 'Network.responseReceived')
      Object.assign(request, {
        status: p.response.status,
        mimeType: p.response.mimeType,
      });
    if (
      request &&
      ['Network.loadingFinished', 'Network.loadingFailed'].includes(method)
    )
      Object.assign(request, {
        duration: Math.max(0, (p.timestamp - request.started) * 1000),
        ...(p.errorText ? { error: p.errorText } : {}),
      });
    if (
      [
        'Network.requestWillBeSent',
        'Network.responseReceived',
        'Network.loadingFinished',
        'Network.loadingFailed',
      ].includes(method)
    ) {
      this.journal('network', {
        phase: method.slice('Network.'.length),
        id: p.requestId,
        timestamp: p.timestamp,
        ...(method === 'Network.requestWillBeSent'
          ? {
              url: p.request.url,
              method: p.request.method,
              ...(p.redirectResponse
                ? { redirectStatus: p.redirectResponse.status }
                : {}),
            }
          : {}),
        ...(method === 'Network.responseReceived'
          ? { status: p.response.status, mimeType: p.response.mimeType }
          : {}),
        ...(request?.duration !== undefined
          ? { duration: request.duration }
          : {}),
        ...(p.errorText ? { error: p.errorText } : {}),
      });
    }
    if (method === 'Debugger.paused')
      this.state.debugger = {
        ...this.state.debugger,
        paused: true,
        pauseEpoch: this.state.debugger.pauseEpoch + 1,
        stackFrames: p.callFrames.map((f: any) => ({
          id: f.callFrameId,
          name: f.functionName || '(anonymous)',
          line: f.location.lineNumber + 1,
          column: f.location.columnNumber + 1,
          source: {
            path: f.url || this.scriptUrls.get(f.location.scriptId) || '',
          },
          scopes: f.scopeChain.map((s: any) => ({
            name: s.type,
            variablesReference: s.object.objectId,
          })),
        })),
      };
    if (
      method === 'Debugger.resumed' ||
      method === 'Runtime.executionContextsCleared'
    ) {
      this.state.debugger.pauseEpoch++;
      this.state.debugger.paused = false;
      this.state.debugger.stackFrames = [];
    }
  }
  async request(
    r: BrowserDiagnosticRequest,
    currentUrl: string,
  ): Promise<BrowserDiagnosticResult> {
    if (this.state.owner !== 'circle' && r.action !== 'read')
      throw Error('browser diagnostics are handed to devtools');
    const domains: BrowserDiagnosticDomain[] | undefined =
      r.action === 'read'
        ? r.domains
        : r.action === 'storage'
          ? ['storage', 'debug']
          : undefined;
    const result: BrowserDiagnosticResult = {
      stream: this.cursor(),
      domains,
      state: domains
        ? {
            ...this.state,
            console: domains.includes('console') ? this.state.console : [],
            network: domains.includes('network') ? this.state.network : [],
            debugger: domains.includes('debug')
              ? this.state.debugger
              : {
                  paused: this.state.debugger.paused,
                  pauseEpoch: this.state.debugger.pauseEpoch,
                  stackFrames: [],
                  breakpoints: [],
                },
          }
        : this.state,
    };
    if (r.action === 'clearConsole') {
      this.state.console = [];
      this.invalidate('console');
    }
    if (r.action === 'clearNetwork') {
      this.state.network = [];
      this.invalidate('network');
    }
    if (r.action === 'source') {
      const script = [...this.scriptUrls]
        .reverse()
        .find(([, url]) => url === r.url);
      if (!script) throw Error('browser source is no longer available');
      const source = await this.send('Debugger.getScriptSource', {
        scriptId: script[0],
      });
      result.source = { url: r.url, content: source.scriptSource };
    }
    if (r.action === 'response') {
      if (!this.state.network.some((n) => n.id === r.requestId))
        throw Error('unknown browser request');
      result.response = await this.send('Network.getResponseBody', {
        requestId: r.requestId,
      });
    }
    if (r.action === 'storage') {
      const origin = new URL(currentUrl).origin;
      if (origin === 'null' || r.origin !== origin)
        throw Error('storage origin no longer matches the current page');
      const storageId = {
        securityOrigin: origin,
        isLocalStorage: r.kind === 'local',
      };
      if (
        !['local', 'session'].includes(r.kind) ||
        !['read', 'set', 'remove'].includes(r.operation)
      )
        throw Error('invalid storage operation');
      if (
        r.operation !== 'read' &&
        (typeof r.key !== 'string' || r.key.length > 65536)
      )
        throw Error('invalid storage key');
      if (r.operation === 'set') {
        if (typeof r.value !== 'string' || r.value.length > 1048576)
          throw Error('invalid storage value');
        await this.send('DOMStorage.setDOMStorageItem', {
          storageId,
          key: r.key,
          value: r.value,
        });
      }
      if (r.operation === 'remove')
        await this.send('DOMStorage.removeDOMStorageItem', {
          storageId,
          key: r.key,
        });
      result.storage = (
        await this.send('DOMStorage.getDOMStorageItems', { storageId })
      ).entries;
    }
    if (r.action === 'viewport') {
      if (r.width === undefined && r.height === undefined)
        await this.send('Emulation.clearDeviceMetricsOverride');
      else {
        if (
          ![r.width, r.height].every(
            (n) => Number.isInteger(n) && n! >= 200 && n! <= 7680,
          )
        )
          throw Error('viewport dimensions must be between 200 and 7680');
        await this.send('Emulation.setDeviceMetricsOverride', {
          width: r.width,
          height: r.height,
          deviceScaleFactor: 1,
          mobile: r.mobile === true,
        });
      }
    }
    if (r.action === 'debug') {
      if (
        ['pause', 'resume', 'stepOver', 'stepInto', 'stepOut'].includes(
          r.command,
        )
      )
        await this.send('Debugger.' + r.command);
      else if (r.command === 'breakpoints') {
        if (!r.url || !Number.isInteger(r.line) || r.line! < 1)
          throw Error('a source URL and line are required');
        const b = await this.send('Debugger.setBreakpointByUrl', {
          url: r.url,
          lineNumber: r.line! - 1,
        });
        this.state.debugger.breakpoints.push({
          id: b.breakpointId,
          verified: !!b.locations?.length,
          line: r.line!,
          source: { path: r.url },
        });
      } else if (r.command === 'removeBreakpoint') {
        if (!this.state.debugger.breakpoints.some((b) => b.id === r.reference))
          throw Error('unknown breakpoint');
        await this.send('Debugger.removeBreakpoint', {
          breakpointId: r.reference,
        });
        this.state.debugger.breakpoints =
          this.state.debugger.breakpoints.filter((b) => b.id !== r.reference);
      } else if (r.command === 'evaluate') {
        const pauseEpoch = this.state.debugger.pauseEpoch;
        const connectionEpoch = this.epoch;
        const valid = () =>
          this.state.owner === 'circle' &&
          this.state.debugger.paused &&
          this.epoch === connectionEpoch &&
          r.expectedConnectionEpoch === connectionEpoch &&
          this.state.debugger.pauseEpoch === pauseEpoch &&
          r.expectedPauseEpoch === pauseEpoch &&
          this.state.debugger.stackFrames.some(
            (frame) => frame.id === r.frameId,
          );
        if (!valid()) throw Error('stale browser target, frame or pause');
        if (
          typeof r.expression !== 'string' ||
          !r.expression.trim() ||
          r.expression.length > 10000
        )
          throw Error('a debug expression is required');
        const evaluated = await this.send('Debugger.evaluateOnCallFrame', {
          callFrameId: r.frameId,
          expression: r.expression,
          returnByValue: true,
          generatePreview: true,
          silent: false,
          timeout: 1000,
        });
        if (!valid())
          throw Error('browser target or pause changed while evaluating');
        if (evaluated.exceptionDetails)
          throw Error(
            evaluated.exceptionDetails.exception?.description ??
              evaluated.exceptionDetails.text ??
              'debug expression failed',
          );
        result.evaluation = {
          frameId: r.frameId!,
          value:
            evaluated.result && Object.hasOwn(evaluated.result, 'value')
              ? typeof evaluated.result.value === 'object'
                ? JSON.stringify(evaluated.result.value)
                : String(evaluated.result.value)
              : String(
                  evaluated.result?.unserializableValue ??
                    evaluated.result?.description ??
                    'undefined',
                ),
          type: evaluated.result?.type,
        };
      } else if (r.command === 'variables') {
        const pauseEpoch = this.state.debugger.pauseEpoch;
        const connectionEpoch = this.epoch;
        if (
          r.expectedConnectionEpoch !== undefined &&
          r.expectedConnectionEpoch !== connectionEpoch
        )
          throw Error('stale browser target');
        if (
          r.expectedPauseEpoch !== undefined &&
          r.expectedPauseEpoch !== pauseEpoch
        )
          throw Error('stale browser pause');
        if (
          !this.state.debugger.stackFrames.some((f) =>
            f.scopes.some((s) => s.variablesReference === r.reference),
          )
        )
          throw Error('stale variable reference');
        const v = await this.send('Runtime.getProperties', {
          objectId: r.reference,
          ownProperties: true,
          generatePreview: true,
        });
        if (
          this.state.owner !== 'circle' ||
          this.epoch !== connectionEpoch ||
          !this.state.debugger.paused ||
          this.state.debugger.pauseEpoch !== pauseEpoch
        )
          throw Error('browser pause changed while reading variables');
        // Chromium's synthetic local-scope RemoteObject retains its first-read
        // values after evaluateOnCallFrame writes a binding. Read observed local
        // binding names in their actual paused frame, without evaluating getters
        // or confusing an outer shadowed closure with the innermost local scope.
        const frame = this.state.debugger.stackFrames.find((frame) =>
          frame.scopes.some(
            (scope) =>
              scope.name === 'local' &&
              scope.variablesReference === r.reference,
          ),
        );
        const current = () =>
          this.state.owner === 'circle' &&
          this.epoch === connectionEpoch &&
          this.state.debugger.paused &&
          this.state.debugger.pauseEpoch === pauseEpoch &&
          this.state.debugger.stackFrames.some(
            (candidate) =>
              candidate.id === frame?.id &&
              candidate.scopes.some(
                (scope) => scope.variablesReference === r.reference,
              ),
          );
        if (frame) {
          const shadowed = new Set<string>();
          let lexical = true;
          const localIndex = frame.scopes.findIndex(
            (scope) => scope.variablesReference === r.reference,
          );
          for (const scope of frame.scopes.slice(0, localIndex)) {
            if (!['block', 'catch'].includes(scope.name)) {
              lexical = false;
              break;
            }
            if (!current())
              throw Error('browser pause changed while reading variables');
            const inner = await this.send('Runtime.getProperties', {
              objectId: scope.variablesReference,
              ownProperties: true,
            });
            if (!current())
              throw Error('browser pause changed while reading variables');
            for (const property of inner.result ?? [])
              shadowed.add(property.name);
          }
          const properties = lexical ? (v.result as any[]) : [];
          for (let start = 0; start < properties.length; start += 8) {
            await Promise.all(
              properties.slice(start, start + 8).map(async (property) => {
                if (
                  shadowed.has(property.name) ||
                  !property.value ||
                  !/^[$_\p{ID_Start}][$_\u200C\u200D\p{ID_Continue}]*$/u.test(
                    property.name,
                  )
                )
                  return;
                if (!current())
                  throw Error('browser pause changed while reading variables');
                const fresh = await this.send('Debugger.evaluateOnCallFrame', {
                  callFrameId: frame.id,
                  expression: property.name,
                  throwOnSideEffect: true,
                  returnByValue: false,
                  silent: true,
                  generatePreview: true,
                  timeout: 1000,
                });
                if (!current())
                  throw Error('browser pause changed while reading variables');
                if (
                  !fresh.exceptionDetails &&
                  fresh.result &&
                  typeof fresh.result.type === 'string'
                )
                  property.value = fresh.result;
              }),
            );
          }
        }
        result.variables = v.result.map((p: any) => ({
          name: p.name,
          value: String(p.value?.value ?? p.value?.description ?? ''),
          type: p.value?.type,
          variablesReference: p.value?.objectId,
        }));
      }
    }
    if (r.action === 'debug') this.invalidate('debug');
    return result;
  }
}

import type {
  BrowserDiagnosticState,
  BrowserDiagnosticRequest,
  BrowserDiagnosticResult,
} from './browser-diagnostics-contracts';
type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
const LIMIT = 500;
/** Bounded independent diagnostics stream; never includes cookies or request headers. */
export class BrowserDiagnostics {
  state: BrowserDiagnosticState = {
    owner: 'circle',
    console: [],
    network: [],
    debugger: { paused: false, stackFrames: [], breakpoints: [] },
  };
  private sequence = 0;
  private scriptUrls = new Map<string, string>();
  constructor(private send: Send) {}
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
    if (method === 'Debugger.paused')
      this.state.debugger = {
        ...this.state.debugger,
        paused: true,
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
    const result: BrowserDiagnosticResult = { state: this.state };
    if (r.action === 'clearConsole') this.state.console = [];
    if (r.action === 'clearNetwork') this.state.network = [];
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
      } else if (r.command === 'variables') {
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
        result.variables = v.result.map((p: any) => ({
          name: p.name,
          value: String(p.value?.value ?? p.value?.description ?? ''),
          type: p.value?.type,
          variablesReference: p.value?.objectId,
        }));
      }
    }
    return result;
  }
}

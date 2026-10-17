/** Human-facing diagnostics use the browser's existing CDP connection. */
export type BrowserDiagnosticRequest =
  | { action: 'read'; domains?: BrowserDiagnosticDomain[] }
  | {
      action: 'log';
      tab: string;
      domain: 'console' | 'network';
      cursor?: { offset: number; seq: number };
      limit?: number;
    }
  | { action: 'clearConsole' | 'clearNetwork' | 'devtools' }
  | { action: 'response'; requestId: string }
  | { action: 'source'; url: string }
  | {
      action: 'watch';
      tab: string;
      subscription: string;
      domains: BrowserDiagnosticDomain[];
      enabled: boolean;
    }
  | {
      action: 'storage';
      kind: 'local' | 'session';
      origin: string;
      operation: 'read' | 'set' | 'remove';
      key?: string;
      value?: string;
    }
  | { action: 'viewport'; width?: number; height?: number; mobile?: boolean }
  | {
      action: 'debug';
      command:
        | 'pause'
        | 'resume'
        | 'stepOver'
        | 'stepInto'
        | 'stepOut'
        | 'breakpoints'
        | 'variables'
        | 'removeBreakpoint'
        | 'evaluate';
      url?: string;
      line?: number;
      reference?: string;
      expectedPauseEpoch?: number;
      expectedConnectionEpoch?: string;
      frameId?: string;
      expression?: string;
    };
export type BrowserDiagnosticDomain =
  'console' | 'network' | 'storage' | 'debug' | 'lifecycle';
export interface BrowserDiagnosticEvent {
  sessionId: string;
  tab: string;
  epoch: string;
  sequence: number;
  domains: BrowserDiagnosticDomain[];
  at: number;
  emittedAt: number;
  consoleId?: number;
}
export interface BrowserConsoleEntry {
  id: number;
  level: string;
  text: string;
  timestamp: number;
  stack: { url: string; line: number; column: number; name: string }[];
}
export interface BrowserNetworkEntry {
  id: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  duration?: number;
  error?: string;
  started: number;
}
export interface BrowserDiagnosticState {
  owner: 'circle' | 'devtools';
  reconnectError?: string;
  logError?: string;
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  debugger: {
    paused: boolean;
    pauseEpoch: number;
    stackFrames: {
      id: string;
      name: string;
      line: number;
      column: number;
      source: { path: string };
      scopes: { name: string; variablesReference: string }[];
    }[];
    breakpoints: {
      id: string;
      verified: boolean;
      line: number;
      source: { path: string };
    }[];
  };
}
export interface BrowserDiagnosticResult {
  log?: {
    domain: 'console' | 'network';
    entries: {
      seq: number;
      at: string;
      epoch: string;
      data: Record<string, unknown>;
    }[];
    cursor: { offset: number; seq: number };
    hasMore: boolean;
  };
  stream?: { epoch: string; sequence: number };
  domains?: BrowserDiagnosticDomain[];
  state: BrowserDiagnosticState;
  source?: { url: string; content: string };
  response?: { body: string; base64Encoded: boolean };
  storage?: [string, string][];
  evaluation?: { frameId: string; value: string; type?: string };
  variables?: {
    name: string;
    value: string;
    type?: string;
    variablesReference?: string;
  }[];
}

export function validateBrowserDiagnosticRequest(
  value: unknown,
): BrowserDiagnosticRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid browser diagnostic request');
  const r = value as Record<string, unknown>;
  const allowed: Record<string, string[]> = {
    read: ['domains'],
    log: ['tab', 'domain', 'cursor', 'limit'],
    clearConsole: [],
    clearNetwork: [],
    devtools: [],
    response: ['requestId'],
    source: ['url'],
    watch: ['tab', 'subscription', 'domains', 'enabled'],
    storage: ['kind', 'origin', 'operation', 'key', 'value'],
    viewport: ['width', 'height', 'mobile'],
    debug: [
      'command',
      'url',
      'line',
      'reference',
      'expectedPauseEpoch',
      'expectedConnectionEpoch',
      'frameId',
      'expression',
    ],
  };
  if (
    typeof r.action !== 'string' ||
    !Object.hasOwn(allowed, r.action) ||
    Object.keys(r).some(
      (k) => k !== 'action' && !allowed[r.action as string].includes(k),
    )
  )
    throw Error('invalid browser diagnostic action');
  if (r.action === 'log') {
    if (
      typeof r.tab !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(r.tab) ||
      !['console', 'network'].includes(String(r.domain))
    )
      throw Error('invalid browser log target');
    if (
      r.limit !== undefined &&
      (!Number.isSafeInteger(r.limit) ||
        Number(r.limit) < 1 ||
        Number(r.limit) > 256)
    )
      throw Error('invalid browser log page size');
    if (r.cursor !== undefined) {
      const c = r.cursor as Record<string, unknown>;
      if (
        !c ||
        typeof c !== 'object' ||
        Array.isArray(c) ||
        Object.keys(c).some((key) => !['offset', 'seq'].includes(key)) ||
        !Number.isSafeInteger(c.offset) ||
        !Number.isSafeInteger(c.seq) ||
        Number(c.offset) < 0 ||
        Number(c.seq) < 0
      )
        throw Error('invalid browser log cursor');
    }
  }
  for (const key of [
    'requestId',
    'kind',
    'origin',
    'operation',
    'key',
    'value',
    'command',
    'url',
    'reference',
  ])
    if (
      r[key] !== undefined &&
      (typeof r[key] !== 'string' || (r[key] as string).length > 1048576)
    )
      throw Error('invalid browser diagnostic field');
  if (r.action === 'response' && !r.requestId)
    throw Error('request id required');
  if (
    r.action === 'debug' &&
    ![
      'pause',
      'resume',
      'stepOver',
      'stepInto',
      'stepOut',
      'breakpoints',
      'variables',
      'removeBreakpoint',
      'evaluate',
    ].includes(String(r.command))
  )
    throw Error('invalid debugger command');
  if (
    r.action === 'storage' &&
    (!['local', 'session'].includes(String(r.kind)) ||
      !['read', 'set', 'remove'].includes(String(r.operation)) ||
      typeof r.origin !== 'string')
  )
    throw Error('invalid storage request');
  if (
    r.expectedPauseEpoch !== undefined &&
    (!Number.isSafeInteger(r.expectedPauseEpoch) ||
      Number(r.expectedPauseEpoch) < 0)
  )
    throw Error('invalid browser pause epoch');
  if (
    r.action === 'debug' &&
    r.command === 'evaluate' &&
    (typeof r.expectedConnectionEpoch !== 'string' ||
      !r.expectedConnectionEpoch ||
      !Number.isSafeInteger(r.expectedPauseEpoch) ||
      typeof r.frameId !== 'string' ||
      !r.frameId ||
      typeof r.expression !== 'string' ||
      !r.expression.trim() ||
      r.expression.length > 10000)
  )
    throw Error('paused debugger target, frame and expression are required');
  if (r.mobile !== undefined && typeof r.mobile !== 'boolean')
    throw Error('invalid viewport mode');
  if (
    r.action === 'watch' &&
    (typeof r.tab !== 'string' ||
      !/^t[1-9][0-9]*$/.test(r.tab) ||
      typeof r.subscription !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(r.subscription) ||
      typeof r.enabled !== 'boolean' ||
      !Array.isArray(r.domains) ||
      r.domains.length > 5 ||
      r.domains.some(
        (d) =>
          !['console', 'network', 'storage', 'debug', 'lifecycle'].includes(
            String(d),
          ),
      ))
  )
    throw Error('invalid browser diagnostic subscription');
  if (
    r.action === 'read' &&
    r.domains !== undefined &&
    (!Array.isArray(r.domains) ||
      r.domains.length > 5 ||
      r.domains.some(
        (d) =>
          !['console', 'network', 'storage', 'debug', 'lifecycle'].includes(
            String(d),
          ),
      ))
  )
    throw Error('invalid browser diagnostic domains');
  return r as unknown as BrowserDiagnosticRequest;
}

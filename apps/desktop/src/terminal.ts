// The device terminals of the desktop window: the same TerminalSessions the terminal
// interface drives in its own process, held here in the main process beside the browser.
// The renderer never touches sockets: it gets state and raw device bytes through the
// preload bridge, and returns keys and sizes the same way. A conversation's own holder
// rule (who types, who waits) is the manager's, exactly as in the terminal interface.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  TerminalSessions,
  type TerminalView,
} from '../../../src/terminal/sessions.js';
import { loadProfiles, profileTarget } from '../../../src/terminal/profiles.js';
import { sshConnector } from '../../../src/terminal/ssh.js';
import { telnetConnector } from '../../../src/terminal/telnet.js';
import { TrustedHostKeys } from '../../../src/terminal/hostkeys.js';
import type {
  TerminalRequest,
  TerminalResult,
} from '../../../src/terminal/protocol.js';
import { isLocalTerminal } from '../../../src/terminal/protocol.js';
import type {
  LocalTerminalRow,
  TerminalEvent,
  TerminalHostKeyAsk,
  TerminalProfileRow,
  TerminalSessionRow,
  TerminalState,
} from './contracts';

/** The person's say over one of their own terminal tabs, carried to the runtime. */
export type TerminalTabControl = (
  conversation: string,
  session: string,
  action: 'take' | 'return' | 'stop',
) => Promise<LocalTerminalRow[]>;

// Raw device bytes travel in coalesced batches: a scrolling console must not turn into
// one IPC message a line.
const BATCH_MS = 60;
const BATCH_MAX = 64_000;
// A key a profile names must be an absolute path to an ordinary file; the same refusal
// of Circle's own credential files the terminal interface's sandbox makes.
const CREDENTIAL_NAMES = new Set([
  'settings.json',
  'credentials.json',
  'secrets.json',
]);

// Everything the renderer names crosses this gate first, as the browser's ids do.
const validConversation = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value))
    throw Error('invalid conversation');
  return value;
};
const validSession = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/.test(value))
    throw Error('invalid terminal');
  return value;
};
// A saved profile's display name follows profiles.ts, not the session-id grammar.
const validProfile = (value: unknown): string => {
  if (
    typeof value !== 'string' ||
    !/^[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]{0,99}$/.test(value)
  )
    throw Error('invalid terminal profile');
  return value;
};
// A quick connect names a device, not a profile: the same shape the tools take,
// checked here because the bridge is not trusted input.
interface TerminalTargetArgs extends Record<string, unknown> {
  transport: 'ssh' | 'telnet';
  host: string;
  port?: number;
  user?: string;
}
const validTarget = (value: unknown): TerminalTargetArgs => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid terminal target');
  const row = value as Record<string, unknown>;
  if (row.transport !== 'ssh' && row.transport !== 'telnet')
    throw Error('invalid terminal transport');
  const host = String(row.host ?? '').trim();
  if (!/^[a-zA-Z0-9._:-]{1,253}$/.test(host))
    throw Error('invalid terminal host');
  const port =
    row.port === undefined || row.port === '' ? undefined : Number(row.port);
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1 || port > 65535)
  )
    throw Error('invalid terminal port');
  const user =
    row.user === undefined || row.user === ''
      ? undefined
      : String(row.user).slice(0, 100);
  return {
    transport: row.transport as 'ssh' | 'telnet',
    host,
    ...(port !== undefined ? { port } : {}),
    ...(user ? { user } : {}),
  };
};
const validText = (value: unknown): string => {
  if (typeof value !== 'string' || value.length > 65536)
    throw Error('invalid terminal input');
  return value;
};

export class TerminalPanelHost {
  private manager: TerminalSessions;
  // A human connect stopped by an unknown host key: the panel asks, in place
  private pendingKey = new Map<
    string,
    TerminalHostKeyAsk & { profile: string; args: Record<string, unknown> }
  >();
  private handoffs = new Map<
    string,
    { resolve: () => void; session: string; reason: string }
  >();
  private batches = new Map<
    string,
    { chunks: Buffer[]; size: number; timer: ReturnType<typeof setTimeout> }
  >();
  // The conversation's own terminal tabs as the runtime last told them: they live in
  // the runtime with their shells, not here
  private tabs = new Map<string, LocalTerminalRow[]>();
  constructor(
    private readonly emit: (event: TerminalEvent) => void,
    private readonly home: string,
    trustFile: string,
    private readonly secret: (name: string) => string,
    private readonly modeOf: (conversation: string) => string | undefined,
    private readonly tabControl?: TerminalTabControl,
  ) {
    this.manager = new TerminalSessions({
      connectors: { ssh: sshConnector, telnet: telnetConnector },
      profiles: () => loadProfiles(join(home, 'terminal-sessions.json')),
      hostkeys: new TrustedHostKeys(trustFile),
      secret: (name) => this.secret(name),
      keyFile: (path) => {
        const full = isAbsolute(path)
          ? path
          : resolve(home, path.replace(/^~/, homedir()));
        if (CREDENTIAL_NAMES.has(full.split(/[\\/]/).pop() ?? ''))
          throw Error(`${path} is a credential file`);
        return full;
      },
      onChange: (conversation) => this.pushState(conversation),
      onOutput: (conversation, session, bytes) =>
        this.pushData(conversation, session, bytes),
      hand: (conversation, session, reason, signal) =>
        this.hand(conversation, session, reason, signal),
    });
  }
  /** The runtime worker's requests, as the supervisor routes them. */
  async agent(
    request: TerminalRequest,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    const result = await this.manager.request(
      request.sessionId,
      request.action,
      request.args,
      signal,
    );
    this.pushState(request.sessionId);
    return result;
  }
  state(conversation: unknown): TerminalState {
    const own = validConversation(conversation);
    return {
      sessionId: `terminal:${own}`,
      conversation: own,
      sessions: this.manager
        .views(own)
        .flatMap((view) =>
          view.transport === 'local'
            ? []
            : [rowOf({ ...view, transport: view.transport })],
        ),
      profiles: this.profiles(),
      local: this.tabs.get(own) ?? [],
      ...(this.pendingKey.get(own)
        ? { pendingKey: this.pendingKey.get(own) }
        : {}),
      ...(this.handoffs.get(own)
        ? {
            handoff: {
              session: this.handoffs.get(own)!.session,
              reason: this.handoffs.get(own)!.reason,
            },
          }
        : {}),
    };
  }
  profiles(): TerminalProfileRow[] {
    return loadProfiles(join(this.home, 'terminal-sessions.json')).map(
      (one) => ({
        name: one.name,
        transport: one.transport,
        target: profileTarget(one),
        user: one.user ?? '',
      }),
    );
  }
  /** Bytes a view opened now needs to paint the screen: the recent raw stream. */
  snapshot(conversation: unknown, session: unknown): string {
    return (
      this.manager
        .session(validConversation(conversation), validSession(session))
        ?.recentBytes()
        .toString('base64') ?? ''
    );
  }
  /** A person connects a saved profile; a new host key asks on the panel, not a card. */
  async connect(
    conversation: unknown,
    profile: unknown,
  ): Promise<TerminalState> {
    const own = validConversation(conversation);
    const name = validProfile(profile);
    const stop = new AbortController();
    let result = await this.manager.request(
      own,
      'connect',
      { profile: name },
      stop.signal,
    );
    for (let round = 0; result.approval && round < 4; round++) {
      const approval = result.approval;
      this.pendingKey.set(own, {
        token: approval.token,
        profile: name,
        args: { profile: name },
        host: approval.host,
        keyType: approval.keyType,
        fingerprint: approval.fingerprint,
        privateHost: approval.privateHost,
      });
      this.pushState(own);
      // The answer comes through hostKey(); until then this connect simply stopped
      return this.state(own);
    }
    this.pushState(own);
    return this.state(own);
  }
  /** A person reaches a device by address, as a quick connect does: no profile. */
  async connectTarget(
    conversation: unknown,
    target: unknown,
  ): Promise<TerminalState> {
    const own = validConversation(conversation);
    const args = validTarget(target);
    const stop = new AbortController();
    const result = await this.manager.request(
      own,
      'connect',
      args,
      stop.signal,
    );
    if (result.approval) {
      this.pendingKey.set(own, {
        token: result.approval.token,
        profile: result.host ?? args.host,
        host: result.approval.host,
        keyType: result.approval.keyType,
        fingerprint: result.approval.fingerprint,
        privateHost: result.approval.privateHost,
        args,
      });
      this.pushState(own);
      return this.state(own);
    }
    this.pushState(own);
    return this.state(own);
  }
  async hostKey(
    conversation: unknown,
    decision: 'once' | 'always' | 'reject',
  ): Promise<TerminalState> {
    const own = validConversation(conversation);
    const ask = this.pendingKey.get(own);
    if (!ask) return this.state(own);
    this.pendingKey.delete(own);
    if (decision === 'reject') {
      this.pushState(own);
      return this.state(own);
    }
    const stop = new AbortController();
    await this.manager.request(
      own,
      'connect',
      {
        ...ask.args,
        approval: { token: ask.token, scope: decision },
      },
      stop.signal,
    );
    this.pushState(own);
    return this.state(own);
  }
  disconnect(conversation: unknown, session: unknown): TerminalState {
    const own = validConversation(conversation);
    void this.manager
      .request(
        own,
        'disconnect',
        { session: validSession(session) },
        AbortSignal.timeout(5000),
      )
      .catch(() => {});
    return this.state(own);
  }
  /** The person takes the console from the panel; the model's actions on it wait. */
  attach(conversation: unknown, session: unknown): TerminalState {
    const own = validConversation(conversation);
    this.manager.attach(own, validSession(session));
    return this.state(own);
  }
  /** Give it back: as the card's continue in the terminal interface. */
  detach(conversation: unknown, session: unknown): TerminalState {
    const own = validConversation(conversation);
    this.manager.detach(own, validSession(session));
    this.giveBack(own);
    return this.state(own);
  }
  /** Whether a session the window names is one of the person's terminal tabs. */
  isTab(session: unknown): boolean {
    return isLocalTerminal(session);
  }
  /**
   * The person takes one of their own terminal tabs (`local:<id>`), hands it back, or
   * stops what Circle does on it without taking it. The tab is the runtime's, where its
   * shell is; the answer is the state once the runtime has done it.
   */
  async tab(
    conversation: unknown,
    session: unknown,
    action: 'take' | 'return' | 'stop',
  ): Promise<TerminalState> {
    const own = validConversation(conversation);
    const name = validSession(session);
    if (!/^local:[A-Za-z0-9-]{1,100}$/.test(name))
      throw Error("that is not one of the user's terminal tabs");
    if (!this.tabControl) throw Error('the runtime is not connected');
    this.tabsChanged(own, await this.tabControl(own, name, action));
    return this.state(own);
  }
  /** What the runtime says Circle is doing with a conversation's terminal tabs. */
  tabsChanged(conversation: unknown, rows: LocalTerminalRow[]): void {
    const own = validConversation(conversation);
    if (rows.length) this.tabs.set(own, rows);
    else this.tabs.delete(own);
    this.pushState(own);
  }
  /** The runtime stopped: nothing it held of the tabs holds any more. */
  tabsGone(): void {
    const known = [...this.tabs.keys()];
    this.tabs.clear();
    for (const own of known) this.pushState(own);
  }
  /** What the person types on the console they hold. */
  input(conversation: unknown, session: unknown, text: unknown): boolean {
    return this.manager.input(
      validConversation(conversation),
      validSession(session),
      validText(text),
    );
  }
  resize(
    conversation: unknown,
    session: unknown,
    cols: unknown,
    rows: unknown,
  ): void {
    if (
      typeof cols !== 'number' ||
      typeof rows !== 'number' ||
      cols < 2 ||
      cols > 500 ||
      rows < 2 ||
      rows > 300
    )
      return;
    this.manager.resize(
      validConversation(conversation),
      validSession(session),
      Math.floor(cols),
      Math.floor(rows),
    );
  }
  /** A conversation deleted: its consoles close, like the browser's tabs. */
  async releaseSession(conversation: unknown): Promise<void> {
    const own = validConversation(conversation);
    this.pendingKey.delete(own);
    this.giveBack(own);
    this.manager.releaseSession(own);
    this.tabs.delete(own);
    this.pushState(own);
  }
  close(): void {
    this.manager.close();
    this.pendingKey.clear();
    this.tabs.clear();
    for (const batch of this.batches.values()) clearTimeout(batch.timer);
    this.batches.clear();
  }
  // -- internals --
  private hand(
    conversation: string,
    session: string,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    // The panel gets a hand-back button instead of a card; plan mode is answered the
    // same refusal the terminal interface gives
    if (this.modeOf(conversation) === 'plan')
      return Promise.reject(Error('plan mode does not hand a terminal over'));
    return new Promise<void>((resolveHand, rejectHand) => {
      const done = () => {
        this.handoffs.delete(conversation);
        signal.removeEventListener('abort', abort);
        this.pushState(conversation);
        resolveHand();
      };
      const abort = () => {
        this.handoffs.delete(conversation);
        rejectHand(signal.reason ?? Error('stopped'));
      };
      this.handoffs.set(conversation, { resolve: done, session, reason });
      signal.addEventListener('abort', abort, { once: true });
      this.pushState(conversation);
    });
  }
  private giveBack(conversation: string): void {
    const handoff = this.handoffs.get(conversation);
    if (handoff) handoff.resolve();
    this.handoffs.delete(conversation);
  }
  private pushState(conversation: string): void {
    this.emit({ kind: 'state', state: this.state(conversation) });
  }
  private pushData(conversation: string, session: string, bytes: Buffer): void {
    const key = `${conversation} ${session}`;
    let batch = this.batches.get(key);
    if (!batch) {
      batch = {
        chunks: [],
        size: 0,
        timer: setTimeout(() => this.flush(key), BATCH_MS),
      };
      this.batches.set(key, batch);
    }
    batch.chunks.push(bytes);
    batch.size += bytes.length;
    if (batch.size >= BATCH_MAX) this.flush(key);
  }
  private flush(key: string): void {
    const batch = this.batches.get(key);
    if (!batch) return;
    this.batches.delete(key);
    clearTimeout(batch.timer);
    const [conversation, session] = key.split(' ');
    this.emit({
      kind: 'data',
      conversation,
      session,
      bytes: Buffer.concat(batch.chunks).toString('base64'),
    });
  }
}

function rowOf(
  view: TerminalView & { transport: 'ssh' | 'telnet' },
): TerminalSessionRow {
  return {
    id: view.id,
    name: view.name,
    target: view.target,
    transport: view.transport,
    state: view.state,
    detail: view.detail,
    held: view.held ?? '',
    quiet: view.quiet,
    cols: view.cols,
    rows: view.rows,
  };
}

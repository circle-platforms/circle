// The device terminals of each conversation: who holds them, what their screens show,
// and how an action waits its turn. Nothing here knows the screen or the process layout:
// the terminal interface drives one in the same process, and the desktop application
// drives one in its main process behind the port in tools.ts. The shape follows the
// conversation browser's (apps/desktop/src/browser.ts): one holder at a time, the agent's
// actions serialized per conversation, and the person's doings told once in the next result.
import { randomUUID } from 'node:crypto';
import xterm from '@xterm/headless';
import { privateHost } from '../browser/hosts.js';
import type {
  Connector,
  ConnectEnv,
  HostKeyApproval,
  TerminalTarget,
  TerminalTransport,
} from './transport.js';
import type { TrustedHostKeys } from './hostkeys.js';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  findProfile,
  parseTarget,
  profileTarget,
  type TerminalProfile,
} from './profiles.js';
import {
  TERMINAL_KEYS,
  type TerminalAction,
  type TerminalApproval,
  type TerminalResult,
} from './protocol.js';

// Default-imported: the headless emulator is CommonJS with loop-copied exports.
const { Terminal } = xterm;

export type TerminalState = 'connecting' | 'ready' | 'closed' | 'error';
export type TerminalHeld = 'handoff' | 'attach';
/** A device's wire, or `local`: one of the person's own terminal tabs in the desktop. */
export type TerminalKind = 'ssh' | 'telnet' | 'local';
type WaitOutcome =
  'quiet' | 'pattern' | 'absent' | 'capped' | 'closed' | 'held';

/** What the strip, the page and the list show; read-only for the hosts. */
export interface TerminalView {
  id: string;
  name: string;
  target: string;
  transport: TerminalKind;
  state: TerminalState;
  detail: string;
  held: TerminalHeld | undefined;
  quiet: number;
  cols: number;
  rows: number;
  /** When this console opened: a tab row puts a later one after an earlier one. */
  startedAt?: number;
  /** The last line on the screen, for the strip's doing column; '' before any. */
  last?: string;
}

/** The fields a band or a lamp reads; a live session satisfies it directly. */
export type TerminalBandView = Omit<TerminalView, 'last'>;

export interface TerminalSessionsOptions {
  /** One connector per transport; a test hands in fakes through the same shape. */
  connectors: Record<'ssh' | 'telnet', Connector>;
  /** The saved profiles, read fresh when a connect names one. */
  profiles: () => TerminalProfile[];
  /** Host keys the person trusted for good; without it a "for good" answer changes nothing. */
  hostkeys?: TrustedHostKeys;
  /** A saved secret's value by name; '' when it is not saved. */
  secret: (name: string) => string;
  /** A key file's path, as the file tools take it. */
  keyFile: (path: string) => string;
  /** Output arrived, or a session's state changed: repaint, or push to the renderer. */
  onChange: (conversation: string) => void;
  /** Raw device bytes, for a renderer that paints its own emulator (the desktop panel). */
  onOutput?: (conversation: string, session: string, bytes: Buffer) => void;
  /**
   * The person takes a device console over: the host shows its card and opens the page.
   * `session` is the console's name; `id` is its id, such as `t1`.
   */
  hand?: (
    conversation: string,
    session: string,
    reason: string,
    signal: AbortSignal,
    id: string,
  ) => Promise<void>;
  maxSessions?: number;
}

const DEFAULT_MAX_SESSIONS = 6;
// A send shows what the device answered when the screen rests: quiet for a moment,
// bounded so a slow device never stops the turn.
const SEND_SETTLE_QUIET_MS = 400;
const SEND_SETTLE_MAX_MS = 2000;
const WAIT_TICK_MS = 150;
// How often a wait on a terminal tab asks again whether its shell has the terminal back,
// while the screen stays as it was. New output on the screen asks again at once.
const PROMPT_PROBE_MS = 500;
// A wait's record of the device's output keeps this many lines beyond its screen, and
// `changed` shows the last CHANGED_LINES of them.
const RECORD_SCROLLBACK = 1000;
const CHANGED_LINES = 200;

/**
 * One device console and its emulated screen. A `local` session is one of the person's
 * own terminal tabs instead, adopted rather than connected: when they hold it the model's
 * actions on it end rather than wait, and nothing of the model's closes it.
 */
export class TerminalSession {
  state: TerminalState = 'connecting';
  detail = '';
  held: TerminalHeld | undefined;
  lastOutputAt = Date.now();
  startedAt = Date.now();
  cols: number;
  rows: number;
  readonly screen: InstanceType<typeof Terminal>;
  // Actions parked on the person holding the console
  readonly wakers = new Set<() => void>();
  // The checks of the waits under way, run again at once when the holder changes
  readonly watchers = new Set<() => void>();
  /**
   * A terminal tab: whether its shell has the terminal back, so no command it started runs
   * in front of it. That is the shell at its prompt, whatever the prompt looks like.
   * Undefined where the host cannot tell (Windows), and absent for a device console.
   */
  foreground?: () => Promise<boolean | undefined>;
  // The newest raw bytes, so a view opened mid-session can paint the screen by feeding
  // them to its own emulator: a panel never waits for the device to speak again.
  private ring: Buffer[] = [];
  private ringSize = 0;
  // The waits keeping what the device prints while they run
  private readonly records = new Set<OutputRecord>();
  private disposed = false;
  private static readonly RING_MAX = 256_000;
  constructor(
    readonly id: string,
    // A terminal tab's name follows its place among the person's tabs
    public name: string,
    readonly target: string,
    readonly transport: TerminalKind,
    cols: number,
    rows: number,
    readonly handle: TerminalTransport,
    private readonly onChange: () => void,
    private readonly onOutput: (bytes: Buffer) => void = () => {},
  ) {
    this.cols = cols;
    this.rows = rows;
    // The screen buffer is still a proposed API of the emulator: without the flag, reading
    // it throws. Nothing else of the proposed surface is used.
    this.screen = new Terminal({
      cols,
      rows,
      scrollback: 2000,
      allowProposedApi: true,
    });
    handle.onData((bytes) => {
      this.lastOutputAt = Date.now();
      this.screen.write(bytes);
      for (const record of this.records) record.write(bytes);
      this.remember(bytes);
      this.onOutput(bytes);
      this.onChange();
    });
    handle.onEnd((reason) => {
      if (this.state === 'closed' || this.state === 'error') return;
      const expected = reason === 'disconnected';
      this.state = expected ? 'closed' : 'error';
      this.detail = expected ? '' : reason;
      this.held = undefined;
      this.wake();
      this.onChange();
    });
  }
  recentBytes(): Buffer {
    return Buffer.concat(this.ring);
  }
  /** Keeps what the device prints from now on, on a screen of its own, until disposed. */
  record(): OutputRecord {
    const record = new OutputRecord(this.cols, this.rows, () =>
      this.records.delete(record),
    );
    this.records.add(record);
    return record;
  }
  private remember(bytes: Buffer): void {
    this.ring.push(Buffer.from(bytes));
    this.ringSize += bytes.length;
    while (this.ringSize > TerminalSession.RING_MAX && this.ring.length > 1)
      this.ringSize -= this.ring.shift()!.length;
  }
  get quiet(): number {
    return Date.now() - this.lastOutputAt;
  }
  /** One of the person's own terminal tabs, not a device console. */
  get local(): boolean {
    return this.transport === 'local';
  }
  wake(): void {
    for (const wake of [...this.wakers]) wake();
    this.wakers.clear();
  }
  /** The waits under way look again now, rather than at their next tick. */
  nudge(): void {
    for (const check of [...this.watchers]) check();
  }
  /** Cuts the wire. The screen stays readable until dispose() with the conversation. */
  close(): void {
    try {
      this.handle.close();
    } catch {
      /* Already gone. */
    }
    if (this.state === 'connecting' || this.state === 'ready') {
      this.state = 'closed';
      this.held = undefined;
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.screen.dispose();
  }
  /** The last lines on the screen, scrollback included, plain text. Read from the end,
   * so asking for the last line costs the last line. */
  tail(lines: number): string[] {
    const buffer = this.screen.buffer.active;
    const wanted = Math.max(1, lines);
    const out: string[] = [];
    for (let at = buffer.length - 1; at >= 0; at--) {
      const text = buffer.getLine(at)?.translateToString(true) ?? '';
      if (!text.trim() && out.length === 0) continue; // unseen trailing blanks
      out.unshift(text);
      if (out.length >= wanted) break;
    }
    return out;
  }
  /** The line the cursor sits on: the prompt the device waits at. */
  cursorLine(): string {
    const buffer = this.screen.buffer.active;
    return (
      buffer
        .getLine(buffer.baseY + buffer.cursorY)
        ?.translateToString(true)
        .trimEnd() ?? ''
    );
  }
}

/**
 * What a device prints from the moment a wait begins, on an emulated screen of its own:
 * `absent` and `changed` read this, never the scrollback from before. Counting the
 * session's buffer lines instead went wrong on a screen that had not scrolled yet, at
 * the scrollback's cap, after a clear and on leaving a full-screen program. A clear
 * during the wait keeps what it erased here, as scrollback.
 */
export class OutputRecord {
  private readonly screen: InstanceType<typeof Terminal>;
  constructor(
    cols: number,
    rows: number,
    private readonly stop: () => void,
  ) {
    this.screen = new Terminal({
      cols,
      rows,
      scrollback: RECORD_SCROLLBACK,
      scrollOnEraseInDisplay: true,
      allowProposedApi: true,
    });
    // Erasing the scrollback, which `clear` asks for too, would take printed lines with it
    this.screen.parser.registerCsiHandler(
      { final: 'J' },
      (params) => params[0] === 3,
    );
  }
  write(bytes: Uint8Array): void {
    this.screen.write(bytes);
  }
  /** Runs `listener` each time this screen has taken in more output. */
  onParsed(listener: () => void): { dispose(): void } {
    return this.screen.onWriteParsed(listener);
  }
  /** Resolves once every byte received so far is on this screen. */
  settled(): Promise<void> {
    // The emulator parses later: an empty write's callback comes after the output's
    return new Promise((resolve) => this.screen.write('', resolve));
  }
  /** The lines printed so far, oldest first; a line the screen wrapped is one line. */
  lines(): string[] {
    const read = (
      buffer: InstanceType<typeof Terminal>['buffer']['active'],
    ) => {
      const out: string[] = [];
      for (let at = 0; at < buffer.length; at++) {
        const line = buffer.getLine(at);
        if (!line) continue;
        const text = line.translateToString(false);
        if (line.isWrapped && out.length) out[out.length - 1] += text;
        else out.push(text);
      }
      const trimmed = out.map((text) => text.trimEnd());
      const first = trimmed.findIndex((text) => text);
      const last = trimmed.findLastIndex((text) => text);
      return first < 0 ? [] : trimmed.slice(first, last + 1);
    };
    const { active, normal } = this.screen.buffer;
    // A full-screen program still running shows its screen after what came before it
    return active.type === 'alternate'
      ? [...read(normal), ...read(active)]
      : read(normal);
  }
  /** Full: the device may have printed more than this record keeps. */
  get overflowed(): boolean {
    return (
      this.screen.buffer.normal.length >= this.screen.rows + RECORD_SCROLLBACK
    );
  }
  dispose(): void {
    this.stop();
    this.screen.dispose();
  }
}

interface PendingConnect {
  challenge: TerminalApproval;
  profile?: TerminalProfile;
  transport: 'ssh' | 'telnet';
  explicit: { host: string; port: number; target: string; user?: string };
}

interface Conversation {
  sessions: Map<string, TerminalSession>;
  // The agent's actions run one after another, like the browser's queue
  queue: Promise<unknown>;
  // What the person did since the model's last result, told once
  events: string[];
  count: number;
  // An unanswered host key, by the token its second connect comes back with
  pending: Map<string, PendingConnect>;
}

/** The terminals of every conversation, behind the shape of a TerminalPort. */
export class TerminalSessions {
  /**
   * One-time passwords a quick connect carried: a secret name to its value and
   * conversation, in memory only, for as long as the connector takes to read it.
   */
  private onceSecrets = new Map<
    string,
    { conversation: string; value: string }
  >();
  private conversations = new Map<string, Conversation>();
  private options: TerminalSessionsOptions;
  private maxSessions: number;
  constructor(options: TerminalSessionsOptions) {
    this.options = options;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }
  /** One action of one conversation, as the tools' port calls it. */
  request(
    conversation: string,
    action: TerminalAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    const own = this.conversation(conversation);
    const run = () => this.perform(own, conversation, action, args, signal);
    // One action's failure must not sink the ones after it. The person's own close of a
    // console does not come this way: see disconnectForPerson.
    own.queue = own.queue.then(run, run);
    return own.queue as Promise<TerminalResult>;
  }
  /** This conversation's sessions, for the strip, the page and `terminal_sessions`. */
  views(conversation: string): TerminalView[] {
    const own = this.conversations.get(conversation);
    if (!own) return [];
    return [...own.sessions.values()].map((session) => ({
      id: session.id,
      name: session.name,
      target: session.target,
      transport: session.transport,
      state: session.state,
      detail: session.detail,
      held: session.held,
      quiet: session.quiet,
      cols: session.cols,
      rows: session.rows,
      startedAt: session.startedAt,
      last: session.tail(1)[0] ?? '',
    }));
  }
  session(conversation: string, id: string): TerminalSession | undefined {
    return this.conversations.get(conversation)?.sessions.get(id);
  }
  /**
   * One of the person's own terminal tabs joins the conversation's terminals, already
   * open: the desktop application's local shells come in this way, never by connect.
   */
  adopt(conversation: string, session: TerminalSession): void {
    if (!session.local) throw Error('only a terminal tab is adopted');
    const own = this.conversation(conversation);
    if (own.sessions.has(session.id))
      throw Error(`${session.id} is already one of this conversation's`);
    session.state = 'ready';
    own.sessions.set(session.id, session);
    this.options.onChange(conversation);
  }
  /**
   * A terminal tab is gone: it leaves the list, the actions on it end, and its screen goes
   * once the actions already asked for have seen that.
   */
  drop(conversation: string, id: string, why = 'closed'): void {
    const own = this.conversations.get(conversation);
    const session = own?.sessions.get(id);
    if (!own || !session?.local) return;
    own.sessions.delete(id);
    if (session.state === 'ready' || session.state === 'connecting') {
      session.state = 'closed';
      session.detail = why;
    }
    session.held = undefined;
    own.events.push(`${session.name}: ${why}`);
    session.wake();
    session.nudge();
    session.close();
    const dispose = () => session.dispose();
    void own.queue.then(dispose, dispose);
    this.options.onChange(conversation);
  }
  /** A terminal's state line, as `terminal_sessions` lists it. */
  describe(conversation: string, id: string): string | undefined {
    const session = this.session(conversation, id);
    return session ? this.header(session) : undefined;
  }
  /** Something the person did, told once in the conversation's next result. */
  tell(conversation: string, event: string): void {
    const own = this.conversations.get(conversation);
    if (own && !own.events.includes(event)) own.events.push(event);
  }
  /** The person takes a console over from the page or panel: keys go to the device now. */
  attach(conversation: string, id: string): boolean {
    const session = this.session(conversation, id);
    if (!session || session.state !== 'ready') return false;
    if (!session.held) {
      session.held = 'attach';
      this.conversations
        .get(conversation)!
        .events.push(`${session.name}: the user took the terminal`);
      // A wait on a terminal tab ends now rather than at its next tick
      session.nudge();
      this.options.onChange(conversation);
    }
    return true;
  }
  /** The person gives it back; an action parked on it runs again. */
  detach(conversation: string, id: string): void {
    const session = this.session(conversation, id);
    if (!session || !session.held) return;
    session.held = undefined;
    this.conversations
      .get(conversation)!
      .events.push(`${session.name}: the user gave the terminal back`);
    session.wake();
    this.options.onChange(conversation);
  }
  /**
   * The person closes a console from the page or panel. It is theirs to close at any time,
   * while they hold it too: it waits for nothing, and an action of the model's parked on it
   * ends as it would if the device had hung up.
   */
  disconnectForPerson(conversation: string, id: string): void {
    const own = this.conversations.get(conversation);
    const session = own?.sessions.get(id);
    if (!own || !session || session.local) return;
    const was = session.state;
    session.close();
    session.held = undefined;
    if (was === 'ready' || was === 'connecting')
      own.events.push(`${session.name}: the user disconnected the terminal`);
    session.wake();
    session.nudge();
    this.options.onChange(conversation);
  }
  /** What the person types on a console they hold. Only the holder's keys arrive. */
  input(conversation: string, id: string, text: string): boolean {
    const session = this.session(conversation, id);
    if (!session || session.held === undefined || session.state !== 'ready')
      return false;
    session.handle.write(Buffer.from(text, 'utf8'));
    const own = this.conversations.get(conversation)!;
    // What they type is theirs: the model learns that they typed, never what
    if (!own.events.some((event) => event.endsWith(': the user typed')))
      own.events.push(`${session.name}: the user typed`);
    return true;
  }
  resize(conversation: string, id: string, cols: number, rows: number): void {
    const session = this.session(conversation, id);
    if (
      !session ||
      (session.cols === cols && session.rows === rows) ||
      cols < 2 ||
      rows < 2
    )
      return;
    session.cols = cols;
    session.rows = rows;
    session.screen.resize(cols, rows);
    session.handle.resize(cols, rows);
    this.options.onChange(conversation);
  }
  /** The conversation is gone: its consoles close and their screens go with it. */
  releaseSession(conversation: string): void {
    const own = this.conversations.get(conversation);
    if (!own) return;
    this.conversations.delete(conversation);
    for (const [name, entry] of this.onceSecrets)
      if (entry.conversation === conversation) this.onceSecrets.delete(name);
    for (const session of own.sessions.values()) {
      session.close();
      session.dispose();
    }
  }
  close(): void {
    for (const own of this.conversations.values())
      for (const session of own.sessions.values()) {
        session.close();
        session.dispose();
      }
    this.conversations.clear();
    this.onceSecrets.clear();
  }
  // -- the actions --
  private async perform(
    own: Conversation,
    conversation: string,
    action: TerminalAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    if (action === 'sessions') return this.sessionsResult(own);
    if (action === 'connect')
      return this.connect(own, conversation, args, signal);
    const session = this.find(own, String(args.session ?? ''));
    if (session.local)
      return this.performLocal(
        own,
        conversation,
        session,
        action,
        args,
        signal,
      );
    // The person holds the console: nothing of Circle's runs until they give it back,
    // its disconnect included. Their own close does not wait: disconnectForPerson.
    if (session.held) await this.handedBack(session, signal);
    switch (action) {
      case 'send':
        return this.send(own, session, args, signal);
      case 'press':
        return this.press(own, session, args, signal);
      case 'read':
        return this.readResult(own, session, args);
      case 'wait':
        return this.wait(own, session, args, signal);
      case 'disconnect':
        return this.disconnect(own, conversation, session);
      case 'handoff':
        return this.handoff(own, conversation, session, args, signal);
      default:
        throw Error(`no such terminal action: ${action}`);
    }
  }
  /**
   * An action on one of the person's own terminal tabs. While they hold it a read or a wait
   * says so at once and nothing is typed: the tab is theirs, and a hold there can last
   * longer than a turn should wait. Nothing the model does closes it.
   */
  private async performLocal(
    own: Conversation,
    conversation: string,
    session: TerminalSession,
    action: TerminalAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    // An action stopped while it waited its turn does not run late
    signal.throwIfAborted();
    switch (action) {
      case 'send':
      case 'press':
        if (session.held)
          throw Error(
            `${session.name} is the user's now: they took it over, and nothing was typed. It is yours again when they hand it back`,
          );
        return action === 'send'
          ? this.send(own, session, args, signal)
          : this.press(own, session, args, signal);
      case 'read':
        return session.held
          ? this.heldResult(own, session)
          : this.readResult(own, session, args);
      case 'wait':
        return session.held
          ? this.heldResult(own, session)
          : this.wait(own, session, args, signal);
      case 'handoff':
        return this.handoff(own, conversation, session, args, signal);
      case 'disconnect':
        throw Error(
          `${session.name} is the user's own terminal tab; Circle does not close it`,
        );
      default:
        throw Error(`no such terminal action: ${action}`);
    }
  }
  /** A terminal tab the person holds: what the model gets instead of its screen. */
  private heldResult(
    own: Conversation,
    session: TerminalSession,
    note = 'nothing was read or typed',
  ): TerminalResult {
    return {
      text: `${this.header(session)}\nThe user has ${session.name} now, until they hand it back; ${note}.${this.told(own)}`,
      host: session.target,
      session: session.id,
    };
  }
  private conversation(id: string): Conversation {
    let own = this.conversations.get(id);
    if (!own) {
      own = {
        sessions: new Map(),
        queue: Promise.resolve(),
        events: [],
        count: 0,
        pending: new Map(),
      };
      this.conversations.set(id, own);
    }
    return own;
  }
  private find(own: Conversation, name: string): TerminalSession {
    const session =
      own.sessions.get(name) ??
      [...own.sessions.values()].find((one) => one.name === name);
    if (!session)
      throw Error(
        own.sessions.size
          ? `no terminal ${name || '(none given)'} in this conversation; see terminal_sessions`
          : 'this conversation has no terminal yet; connect one with terminal_connect',
      );
    return session;
  }
  /** The one-shot events block, told and then forgotten, like the browser's. */
  private told(own: Conversation): string {
    const events = own.events.splice(0);
    return events.length
      ? `\n### Events\n${events.map((event) => `- ${event}`).join('\n')}`
      : '';
  }
  private header(session: TerminalSession): string {
    const state =
      session.state !== 'ready'
        ? session.state === 'connecting'
          ? 'connecting'
          : `${session.state}${session.detail ? `: ${session.detail}` : ''}`
        : session.held
          ? `held by the user (${session.held})`
          : session.quiet < 1500
            ? 'output'
            : `quiet ${Math.round(session.quiet / 1000)}s`;
    return `${session.id} · ${session.name} · ${session.transport} ${session.target} · ${state}`;
  }
  private sessionsResult(own: Conversation): TerminalResult {
    const lines = [...own.sessions.values()].map(
      (session) => `- ${this.header(session)}`,
    );
    const profiles = this.options
      .profiles()
      .map(
        (profile) =>
          `- ${profile.name} (${profile.transport} ${profileTarget(profile)})`,
      );
    return {
      text:
        `### Terminals\n${lines.length ? lines.join('\n') : '- none'}` +
        `\n### Profiles\n${profiles.length ? profiles.join('\n') : '- none'}`,
    };
  }
  private connectArgs(
    own: Conversation,
    args: Record<string, unknown>,
  ): PendingConnect & { approval?: HostKeyApproval; answeredToken?: string } {
    const approval = args.approval as
      { token?: unknown; scope?: unknown } | undefined;
    if (approval && typeof approval.token === 'string') {
      const held = own.pending.get(approval.token);
      if (!held)
        throw Error(
          'that host key request is gone; connect again to see the device key',
        );
      own.pending.delete(approval.token);
      return {
        ...held,
        approval: {
          fingerprint: held.challenge.fingerprint,
          scope: approval.scope === 'always' ? 'always' : 'once',
        },
        answeredToken: approval.token,
      };
    }
    // A fresh connect: one profile, or a bare device the console itself answers
    const profile =
      typeof args.profile === 'string' && args.profile
        ? findProfile(this.options.profiles(), args.profile)
        : undefined;
    if (typeof args.profile === 'string' && args.profile && !profile)
      throw Error(
        `no saved profile ${args.profile}; see terminal_sessions for the names`,
      );
    if (profile)
      return {
        challenge: {
          kind: 'hostkey',
          token: '',
          host: profileTarget(profile),
          keyType: '',
          fingerprint: '',
          privateHost: privateHost(profileTarget(profile)),
        },
        profile,
        transport: profile.transport,
        explicit: {
          host: profile.host,
          port: profile.port,
          target: profileTarget(profile),
          ...(profile.user ? { user: profile.user } : {}),
        },
      };
    const transport = args.transport === 'telnet' ? 'telnet' : 'ssh';
    const host = typeof args.host === 'string' ? args.host : '';
    const parsed = parseTarget(
      transport,
      host,
      typeof args.port === 'number' ? args.port : undefined,
    );
    if (!parsed)
      throw Error(
        `connect takes a saved profile, or a plain host${
          host ? ` (${host} is not one)` : ''
        }${transport === 'ssh' ? ', and SSH sign-in comes from a profile' : ''}`,
      );
    return {
      challenge: {
        kind: 'hostkey',
        token: '',
        host: parsed.target,
        keyType: '',
        fingerprint: '',
        privateHost: privateHost(parsed.target),
      },
      transport,
      explicit: {
        ...parsed,
        ...(typeof args.user === 'string' && args.user
          ? { user: args.user }
          : {}),
      },
    };
  }
  private async connect(
    own: Conversation,
    conversation: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    const request = this.connectArgs(own, args);
    const { profile, transport, explicit, approval } = request;
    if (own.sessions.size >= this.maxSessions && !approval) {
      // Gone consoles clear out before the count is held against a new one
      for (const [id, session] of [...own.sessions])
        if (session.state === 'closed' || session.state === 'error') {
          session.dispose();
          own.sessions.delete(id);
        }
      if (own.sessions.size >= this.maxSessions)
        throw Error(
          `this conversation already has ${own.sessions.size} terminals; disconnect one first`,
        );
    }
    // A password typed into a quick connect becomes a one-time secret: the wire
    // level only ever sees a secret name, exactly as a saved profile's does.
    let once: string | undefined;
    if (
      !profile &&
      transport === 'ssh' &&
      typeof args.password === 'string' &&
      args.password
    ) {
      once = `once:${randomUUID()}`;
      this.onceSecrets.set(once, {
        conversation,
        value: args.password,
      });
      while (this.onceSecrets.size > 64)
        this.onceSecrets.delete(this.onceSecrets.keys().next().value!);
    }
    const target: TerminalTarget = {
      transport,
      host: explicit.host,
      port: explicit.port,
      target: explicit.target,
      ...(explicit.user ? { user: explicit.user } : {}),
      ...(profile?.passwordSecret
        ? { passwordSecret: profile.passwordSecret }
        : once
          ? { passwordSecret: once }
          : {}),
      ...(profile?.keyPath ? { keyPath: profile.keyPath } : {}),
      ...(profile?.passphraseSecret
        ? { passphraseSecret: profile.passphraseSecret }
        : {}),
      cols: profile?.cols ?? DEFAULT_COLS,
      rows: profile?.rows ?? DEFAULT_ROWS,
    };
    const env: ConnectEnv = {
      secret: (name) =>
        this.onceSecrets.get(name)?.value ?? this.options.secret(name),
      keyFile: (path) => this.options.keyFile(path),
      trusted: (host, fingerprint) =>
        !!this.options.hostkeys?.has(host, fingerprint),
      ...(approval ? { approval } : {}),
      signal,
    };
    // The connector reads the password as it starts; a one-time one is gone after it,
    // and a login stopped by a host key gets the password again with the person's answer
    const outcome = await this.options.connectors[transport](
      target,
      env,
    ).finally(() => {
      if (once) this.onceSecrets.delete(once);
    });
    if ('hostkey' in outcome) {
      const token = randomUUID();
      const challenge: TerminalApproval = {
        kind: 'hostkey',
        token,
        host: explicit.target,
        keyType: outcome.hostkey.keyType,
        fingerprint: outcome.hostkey.fingerprint,
        privateHost: privateHost(explicit.target),
      };
      own.pending.set(token, { ...request, challenge });
      return {
        text:
          `${explicit.target} offered a host key nobody has trusted yet:\n` +
          `  ${outcome.hostkey.keyType || 'unknown type'}  ${outcome.hostkey.fingerprint}\n` +
          `The login stopped before anything was sent.`,
        host: explicit.target,
        approval: challenge,
      };
    }
    if (
      approval?.scope === 'always' &&
      this.options.hostkeys &&
      privateHost(explicit.target)
    )
      this.options.hostkeys.add(
        explicit.target,
        approval.fingerprint,
        request.challenge.keyType,
      );
    own.count += 1;
    const id = `t${own.count}`;
    const name = profile?.name ?? explicit.target;
    const session = new TerminalSession(
      id,
      name,
      explicit.target,
      transport,
      target.cols,
      target.rows,
      outcome.transport,
      () => this.options.onChange(conversation),
      (bytes) => this.options.onOutput?.(conversation, id, bytes),
    );
    session.state = 'ready';
    own.sessions.set(id, session);
    own.events.push(`${name}: connected (${transport} ${explicit.target})`);
    this.options.onChange(conversation);
    // A login banner or first prompt is worth waiting the short settle for
    try {
      await this.quiet(session, SEND_SETTLE_QUIET_MS, 3000, signal);
    } catch (error) {
      own.sessions.delete(id);
      session.close();
      session.dispose();
      throw error;
    }
    return {
      text: `Connected: ${this.header(session)}\n### Output\n${session
        .tail(20)
        .join('\n')}${this.told(own)}`,
      host: explicit.target,
      session: session.id,
    };
  }
  private async send(
    own: Conversation,
    session: TerminalSession,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    this.liveness(session);
    const text = String(args.text ?? '');
    if (!text) throw Error('terminal_send needs text');
    session.handle.write(Buffer.from(text, 'utf8'));
    if (args.enter === true) session.handle.write(Buffer.from('\r'));
    // The screen counts as moving from the moment the console was given the work
    session.lastOutputAt = Date.now();
    return this.settled(own, session, signal);
  }
  private async press(
    own: Conversation,
    session: TerminalSession,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    this.liveness(session);
    const key = String(args.key ?? '');
    const bytes = TERMINAL_KEYS[key];
    if (bytes === undefined)
      throw Error(
        `no such key: ${key}; the keys are ${Object.keys(TERMINAL_KEYS).join(', ')}`,
      );
    session.handle.write(Buffer.from(bytes, 'latin1'));
    session.lastOutputAt = Date.now();
    return this.settled(own, session, signal);
  }
  private async settled(
    own: Conversation,
    session: TerminalSession,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    const outcome = await this.quiet(
      session,
      SEND_SETTLE_QUIET_MS,
      SEND_SETTLE_MAX_MS,
      signal,
    );
    if (session.local && outcome === 'closed')
      throw Error(
        `${session.name} was closed; what you sent may have been typed before it closed`,
      );
    if (outcome === 'held')
      return this.heldResult(
        own,
        session,
        'what you sent was typed before that',
      );
    return {
      text: `${this.header(session)}\n### Output\n${session
        .tail(20)
        .join('\n')}${this.told(own)}`,
      host: session.target,
      session: session.id,
    };
  }
  private readResult(
    own: Conversation,
    session: TerminalSession,
    args: Record<string, unknown>,
  ): TerminalResult {
    const lines = clamp(args.lines, 1, 2000, 50);
    const tail = session.tail(lines);
    const prompt = session.cursorLine();
    return {
      text: `${this.header(session)}\n### Output\n${
        tail.length ? tail.join('\n') : '(nothing on the screen yet)'
      }\n### Prompt\n${prompt || '(no text at the cursor)'}${this.told(own)}`,
      host: session.target,
      session: session.id,
    };
  }
  private async wait(
    own: Conversation,
    session: TerminalSession,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    const idleMs = clamp(args.idle_ms, 100, 30000, 600);
    const timeoutMs = clamp(args.timeout_ms, 1000, 300000, 30000);
    const retries = clamp(args.retries, 0, 5, 0);
    const pattern = regexArg(args.pattern);
    const absent = regexArg(args.absent);
    const changed = args.changed === true;
    // A test asserts on what the device printed during the wait, never on the
    // scrollback from before it: absent and changed read a record that starts now.
    const record = absent || changed ? session.record() : undefined;
    try {
      let outcome: WaitOutcome = 'capped';
      let attempts = 0;
      for (;;) {
        attempts++;
        outcome = await this.waitFor(session, {
          idleMs,
          timeoutMs,
          ...(pattern ? { pattern } : {}),
          ...(absent && record ? { absent: { pattern: absent, record } } : {}),
          // A terminal tab that prints nothing, such as sleep, is quiet while it
          // still runs. Quiet only finishes the wait once the shell is at its prompt.
          holdUntilPrompt: session.local && !pattern,
          signal,
        });
        if (outcome !== 'capped' || attempts > retries) break;
      }
      if (session.local && outcome === 'closed')
        throw Error(
          `${session.name} was closed while you waited; it is gone from terminal_sessions`,
        );
      if (outcome === 'held')
        return this.heldResult(own, session, 'your wait ended there');
      // Everything the device sent so far, on the record: an absent line that came with
      // the matching one, or just before the quiet or the cap, still fails the check.
      await record?.settled();
      const printed = record?.lines() ?? [];
      if (absent && outcome !== 'closed' && absent.test(printed.join('\n')))
        outcome = 'absent';
      const why =
        outcome === 'quiet'
          ? `quiet for ${Math.round(idleMs / 100) / 10}s`
          : outcome === 'pattern'
            ? `matched ${String(args.pattern)}`
            : outcome === 'absent'
              ? `the absent pattern ${String(args.absent)} appeared`
              : outcome === 'closed'
                ? `the session ended: ${session.detail || 'closed'}`
                : `still going after ${Math.round(
                    (timeoutMs * attempts) / 1000,
                  )}s`;
      // A wait that needed more than one attempt says so, whatever it ended on.
      const attemptNote =
        retries && attempts > 1 ? ` in ${attempts} attempts` : '';
      // The line a pattern hit, so a result carries its own evidence: the newest on the
      // screen for a pattern, the newest the device printed during the wait for absent.
      const evidence =
        outcome === 'pattern'
          ? lineWith(session.tail(400), pattern)
          : outcome === 'absent'
            ? lineWith(printed, absent)
            : '';
      const during = changed ? duringWait(printed, record?.overflowed) : '';
      return {
        text: `${this.header(session)} · ${why}${attemptNote}${evidence}\n### Output\n${session
          .tail(20)
          .join('\n')}${during}${this.told(own)}`,
        host: session.target,
        session: session.id,
      };
    } finally {
      record?.dispose();
    }
  }
  private disconnect(
    own: Conversation,
    conversation: string,
    session: TerminalSession,
  ): TerminalResult {
    const was = session.state;
    session.close();
    // Anything parked on their hold stops waiting now and sees the closed console.
    session.wake();
    own.events.push(`${session.name}: disconnected`);
    this.options.onChange(conversation);
    return {
      text: `${session.id} ${session.name} was ${
        was === 'ready' ? 'cut off' : 'already gone'
      }; terminal_read can still show its last screen.${this.told(own)}`,
      host: session.target,
      session: session.id,
    };
  }
  private async handoff(
    own: Conversation,
    conversation: string,
    session: TerminalSession,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    if (session.held)
      throw Error(
        session.local
          ? `${session.name} is already the user's; it is yours again when they hand it back`
          : `${session.name} is already the user's; your action waits for it and shows what they did`,
      );
    if (!this.options.hand) throw Error('this caller has no handoff');
    const reason = String(args.reason ?? '');
    session.held = 'handoff';
    own.events.push(
      `${session.name}: handed to the user${reason ? ` for: ${reason}` : ''}`,
    );
    this.options.onChange(conversation);
    try {
      await this.options.hand(
        conversation,
        session.name,
        reason,
        signal,
        session.id,
      );
    } catch (error) {
      // A host that will not carry the handoff (plan mode) must not leave the console held
      session.held = undefined;
      session.wake();
      this.options.onChange(conversation);
      throw error;
    }
    await this.handedBack(session, signal);
    return this.settled(own, session, signal);
  }
  // -- shared mechanics --
  private liveness(session: TerminalSession): void {
    if (session.state !== 'ready')
      throw Error(
        session.local
          ? `${session.name} was closed; it is gone from terminal_sessions`
          : `${session.name} is ${session.state}${
              session.detail ? `: ${session.detail}` : ''
            }; connect again with terminal_connect`,
      );
  }
  /** Parked while the person holds the console; woken when they give it back. */
  private handedBack(
    session: TerminalSession,
    signal: AbortSignal,
  ): Promise<void> {
    if (!session.held) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal.removeEventListener('abort', abort);
        session.wakers.delete(wake);
        resolve();
      };
      const abort = () => {
        session.wakers.delete(wake);
        reject(signal.reason ?? Error('stopped'));
      };
      signal.addEventListener('abort', abort, { once: true });
      session.wakers.add(wake);
    });
  }
  /** Until the screen rests: quiet for `idleMs`, at most `maxMs`. */
  private quiet(
    session: TerminalSession,
    idleMs: number,
    maxMs: number,
    signal: AbortSignal,
  ): Promise<WaitOutcome> {
    return this.waitFor(session, { idleMs, timeoutMs: maxMs, signal });
  }
  private waitFor(
    session: TerminalSession,
    want: {
      idleMs: number;
      timeoutMs: number;
      pattern?: RegExp;
      /** A local tab: quiet counts only while the shell is at its prompt. */
      holdUntilPrompt?: boolean;
      /** Fails the wait once the record of what the device printed since it began shows it. */
      absent?: { pattern: RegExp; record: OutputRecord };
      signal: AbortSignal;
    },
  ): Promise<WaitOutcome> {
    return new Promise((resolve, reject) => {
      // A terminal tab's action stopped before its wait began does not wait at all
      if (session.local && want.signal.aborted) {
        reject(want.signal.reason ?? Error('stopped'));
        return;
      }
      const started = Date.now();
      let done = false;
      // What the host last said of the shell, and the output it was asked after
      let asked: { output: number; at: number; shell?: boolean } | undefined;
      let asking = false;
      // The shell has its terminal back: the host knows that from the process in front of
      // it, whatever the prompt looks like (❯, ➜ … ✗). Where it cannot tell, or a program
      // the shell started holds the terminal and waits at a prompt of its own (ssh, a
      // REPL), the line at the cursor ending like a prompt counts.
      const atPrompt = (): boolean => {
        if (looksLikePrompt(session.cursorLine())) return true;
        if (!session.foreground) return false;
        const output = session.lastOutputAt;
        if (asked?.output === output && asked.shell === true) return true;
        if (
          !asking &&
          (!asked ||
            asked.output !== output ||
            Date.now() - asked.at >= PROMPT_PROBE_MS)
        ) {
          asking = true;
          const answer = (shell?: boolean) => {
            asking = false;
            asked = { output, at: Date.now(), shell };
            check();
          };
          session.foreground().then(answer, () => answer(undefined));
        }
        return false;
      };
      const end = () => {
        done = true;
        clearInterval(ticker);
        parsed.dispose();
        recorded?.dispose();
        session.watchers.delete(check);
        want.signal.removeEventListener('abort', abort);
      };
      const finish = (outcome: WaitOutcome) => {
        end();
        resolve(outcome);
      };
      const check = () => {
        if (done) return;
        if (session.state === 'closed' || session.state === 'error')
          finish('closed');
        // The person took their terminal tab over: it is theirs, the wait is over
        else if (session.local && session.held) finish('held');
        else if (
          want.absent &&
          want.absent.pattern.test(want.absent.record.lines().join('\n'))
        )
          finish('absent');
        else if (
          want.pattern &&
          want.pattern.test(session.tail(400).join('\n'))
        )
          finish('pattern');
        else if (
          session.quiet >= want.idleMs &&
          // `sleep` and its like print nothing, so the screen is quiet the whole
          // time. That is not the prompt coming back, and the timeout still bounds it.
          (!want.holdUntilPrompt || atPrompt())
        )
          finish('quiet');
        else if (Date.now() - started >= want.timeoutMs) finish('capped');
      };
      const parsed = session.screen.onWriteParsed(() => check());
      const recorded = want.absent?.record.onParsed(() => check());
      const ticker = setInterval(check, WAIT_TICK_MS);
      const abort = () => {
        end();
        reject(want.signal.reason ?? Error('stopped'));
      };
      want.signal.addEventListener('abort', abort, { once: true });
      session.watchers.add(check);
      check();
    });
  }
}

/**
 * The `terminal_sessions` text with more terminals in its list: the desktop's own terminal
 * tabs, listed by the runtime beside the device consoles the main process lists.
 */
export function withMoreTerminals(text: string, lines: string[]): string {
  if (!lines.length) return text;
  const head = '### Terminals\n';
  const at = text.indexOf(head);
  if (at < 0) return `${head}${lines.join('\n')}\n${text}`;
  const rest = text.slice(at + head.length);
  const end = rest.indexOf('\n### ');
  const block = end < 0 ? rest : rest.slice(0, end);
  const listed = block === '- none' ? [] : block.split('\n');
  return (
    text.slice(0, at) +
    head +
    [...listed, ...lines].join('\n') +
    (end < 0 ? '' : rest.slice(end))
  );
}

/**
 * The line at the cursor ends like a prompt: a shell's `$`, `#`, `%` or `>`, a REPL's
 * `>>>`, or the `❯` of starship, pure and powerlevel10k.
 */
export function looksLikePrompt(line: string): boolean {
  return /[$#>%❯]\s*$/.test(line);
}
/** An assertion's regular expression; a bad one is the caller's error. */
function regexArg(value: unknown): RegExp | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return new RegExp(value);
}
/** The newest line an assertion hit, so a result names its evidence. */
function lineWith(lines: string[], pattern?: RegExp): string {
  if (!pattern) return '';
  const line = lines.findLast((row) => pattern.test(row));
  return line === undefined ? '' : ` on the line: ${line.trim()}`;
}
/** `changed`: what the device printed while the wait ran, its last lines when long. */
function duringWait(printed: string[], overflowed = false): string {
  const shown = printed.slice(-CHANGED_LINES);
  const left = printed.length - shown.length;
  const note = left
    ? `(${overflowed ? 'at least ' : ''}${left} earlier lines left out)\n`
    : '';
  return `\n### During the wait\n${
    shown.length ? note + shown.join('\n') : '(the device printed nothing)'
  }`;
}

function clamp(
  value: unknown,
  low: number,
  high: number,
  fallback: number,
): number {
  const number =
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(low, Math.min(high, Math.floor(number)));
}

// The person's own terminal tabs, as the model's terminal tools reach them in the desktop
// application. Each running shell of a conversation is `local:<id>` beside its device
// consoles, adopted by the same TerminalSessions the devices use: one holder at a time,
// the screen read from an emulator fed with the shell's output, the person's doings told
// once in the next result. The first write to a tab asks the person; after that a line
// that runs is judged by the execute rules (src/approvals.ts), from the facts given here.
// Typing into a tab while Circle operates it takes it over. Background commands the
// runtime runs in a terminal of their own are not tabs, and are never listed here.
import { basename } from 'node:path';
import {
  TerminalSession,
  TerminalSessions,
  withMoreTerminals,
} from '../../../src/terminal/sessions.js';
import {
  isLocalTerminal,
  type TerminalAction,
  type TerminalResult,
} from '../../../src/terminal/protocol.js';
import type {
  TerminalPort,
  TerminalTabFacts,
} from '../../../src/terminal/tools.js';
import type {
  Connector,
  TerminalTransport,
} from '../../../src/terminal/transport.js';
import type { TerminalEvent, TerminalSnapshot } from './workspace/terminal.ts';
import {
  terminalTabId,
  terminalTabNumbers,
  terminalTabSession,
} from './terminal-tabs.ts';
import type { LocalTerminalRow } from './contracts.ts';

/** The trusted half of the terminal service (TerminalManager) the tools need. */
export interface LocalTerminalHost {
  listNow(owner: string): TerminalSnapshot[];
  recentOutput(
    owner: string,
    id: string,
    maxLength: number,
  ): { data: string; sequence: number; at?: string } | undefined;
  observe(listener: (event: TerminalEvent) => void): () => void;
  write(owner: string, id: string, data: string): Promise<unknown>;
}

export interface LocalTerminalsOptions {
  /** The terminal service of the conversation's folder, when it has one. */
  host(conversation: string): LocalTerminalHost | undefined;
  /** Something the window shows of Circle's use of the conversation's tabs changed. */
  changed(conversation: string): void;
  /** The conversation's mode: plan mode does not hand a terminal over. */
  mode(conversation: string): string | undefined;
  /** The tabs, as `local:<id>`, that an approval of the conversation waits on. */
  waiting(conversation: string): ReadonlySet<string>;
}

export type LocalTerminalControl = 'take' | 'return' | 'stop';

// How much of a tab's recent output its screen is drawn from when Circle first looks
const RECENT_OUTPUT = 256_000;
const MAX_TEXT = 65_536;
// The most of Circle's handoff reason the window's state carries
const MAX_REASON = 2_000;
// What xterm answers by itself and the window passes on as input: cursor position and
// device attribute reports, focus changes, colour, mode and status reports. None of it
// is the person typing.
const AUTOMATIC_REPLY =
  /^(?:\x1b\[\d+;\d+R|\x1b\[[?>=]?[\d;]*c|\x1b\[[IO]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\??[\d;]*\$y|\x1b\[\d*n|\x1bP[^\x1b]*\x1b\\)+$/;
// Control characters a typed text may not carry: a key is pressed with terminal_press,
// so what the line holds stays what the card shows
const CONTROL = /[\x00-\x09\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
// The keys that run the line at the prompt, as Enter does; Ctrl_C drops it
const RUNS_LINE = new Set(['Enter', 'Ctrl_D']);

/** The line at a tab's prompt, as far as Circle can tell what the shell will run. */
interface Line {
  /** What Circle typed on it since it last ran, as it runs (secrets' values included). */
  text: string;
  /** Nothing else changed it: no editing key, nothing the person typed. */
  clean: boolean;
  /** Where typing on it began, Circle's or the person's, on the screen: past the prompt. */
  start?: { row: number; col: number };
  /** Counts every change, to tell a line that changed after its approval was asked. */
  version: number;
}

interface Tab {
  conversation: string;
  terminal: string;
  session: TerminalSession;
  pipe: TabPipe;
  /** The screen has been drawn from the recent output, or the tab is gone. */
  ready: Promise<void>;
  settle: () => void;
}

interface Conversation {
  /** Tabs the person allowed Circle's first write to. */
  granted: Set<string>;
  lines: Map<string, Line>;
  /** The actions under way on each tab, to stop them. */
  active: Map<string, Set<AbortController>>;
  /** Circle handed a tab over and waits for it back. */
  handoffs: Map<
    string,
    { reason: string; resolve: () => void; reject: (error: Error) => void }
  >;
  /** The line version a running write's approval was asked at. */
  asked: Map<string, number>;
}

const key = (conversation: string, terminal: string) =>
  `${conversation}\0${terminal}`;
const isShell = (snapshot: TerminalSnapshot) =>
  snapshot.kind === 'shell' && !snapshot.managedCommand;
const running = (snapshot: TerminalSnapshot) =>
  isShell(snapshot) && snapshot.status === 'running';
// A tab is opened by the person in the window, never by the tools
const opened: Connector = async () => {
  throw Error("the user's terminal tabs are opened in the window");
};

/** A terminal tab as a console: its output fed from the service, its input written to it. */
class TabPipe implements TerminalTransport {
  private data?: (bytes: Buffer) => void;
  private end?: (reason: string) => void;
  /** Runs at the next write, just before it: the line's change. */
  before?: () => void;
  constructor(
    private readonly host: LocalTerminalHost,
    private readonly owner: string,
    private readonly id: string,
  ) {}
  onData(handler: (bytes: Buffer) => void): void {
    this.data = handler;
  }
  onEnd(handler: (reason: string) => void): void {
    this.end = handler;
  }
  write(bytes: Buffer | string): void {
    const before = this.before;
    this.before = undefined;
    before?.();
    void this.host
      .write(
        this.owner,
        this.id,
        typeof bytes === 'string' ? bytes : bytes.toString('utf8'),
      )
      .catch((error: unknown) =>
        this.ended(error instanceof Error ? error.message : String(error)),
      );
  }
  /** The person's tab gives the shell its size; Circle never changes it. */
  resize(): void {}
  /** Letting go of a tab never closes its shell: that is the person's. */
  close(): void {
    this.data = undefined;
    this.end = undefined;
  }
  feed(data: string): void {
    this.data?.(Buffer.from(data, 'utf8'));
  }
  ended(reason: string): void {
    const end = this.end;
    this.end = undefined;
    end?.(reason);
  }
}

/** What the person typed does to the line: Enter or Ctrl-C ends it, anything else changes it. */
function personTyped(line: Line, data: string): void {
  line.version++;
  const cut = Math.max(
    data.lastIndexOf('\r'),
    data.lastIndexOf('\n'),
    data.lastIndexOf('\x03'),
  );
  if (cut >= 0) {
    line.text = '';
    line.clean = true;
    line.start = undefined;
  }
  if (data.length > cut + 1) line.clean = false;
}

export class LocalTerminals implements TerminalTabFacts {
  private readonly sessions: TerminalSessions;
  private readonly tabs = new Map<string, Tab>();
  private readonly conversations = new Map<string, Conversation>();
  private readonly watched = new Map<LocalTerminalHost, () => void>();
  constructor(private readonly options: LocalTerminalsOptions) {
    this.sessions = new TerminalSessions({
      connectors: { ssh: opened, telnet: opened },
      profiles: () => [],
      secret: () => '',
      keyFile: () => {
        throw Error('a terminal tab has no key file');
      },
      onChange: (conversation) => this.options.changed(conversation),
      hand: (conversation, _name, reason, signal, id) =>
        this.hand(conversation, id, reason, signal),
    });
  }
  /** The tools' port: the tabs here, everything else to the device consoles. */
  port(device?: TerminalPort): TerminalPort {
    return {
      request: async (conversation, action, args, signal) => {
        if (action === 'sessions') {
          const listed = device
            ? await device.request(conversation, action, args, signal)
            : { text: '### Terminals\n- none\n### Profiles\n- none' };
          const lines = await this.list(conversation);
          return lines.length
            ? { ...listed, text: withMoreTerminals(listed.text, lines) }
            : listed;
        }
        if (isLocalTerminal(args.session))
          return this.request(conversation, action, args, signal);
        if (!device) throw Error('this conversation has no device terminals');
        return device.request(conversation, action, args, signal);
      },
    };
  }
  /** Follow a terminal service's events: tabs opening, output, size, closing. */
  watch(host: LocalTerminalHost): void {
    if (this.watched.has(host)) return;
    this.watched.set(
      host,
      host.observe((event) => this.event(event)),
    );
  }
  /**
   * What a write to a tab types and runs, for its approval: `terminal`, its tab number
   * (`ordinal`), whether this is its `first_use` in the conversation, and the `command`
   * the shell will run when the write runs a line, with `uncertain` when that line was read
   * off the screen without knowing where its prompt ends. `typed` is the text it types.
   * All are read from the values the write runs with; the card shows each secret's value
   * back as its name.
   */
  facts(
    conversation: string,
    action: TerminalAction,
    args: Record<string, unknown>,
    shown: Record<string, unknown>,
  ): Record<string, unknown> {
    const { host, terminal } = this.find(conversation, args.session);
    const name = this.name(host, conversation, terminal);
    if (action === 'disconnect')
      throw Error(
        `${name} is the user's own terminal tab; Circle does not close it`,
      );
    if (action !== 'send' && action !== 'press') return {};
    const own = this.own(conversation);
    const line = this.line(own, terminal);
    const facts: Record<string, unknown> = {
      terminal: terminalTabSession(terminal),
      ordinal: this.ordinal(host, conversation, terminal),
      first_use: !own.granted.has(terminal),
      command: undefined,
      typed: undefined,
    };
    const before = () =>
      line.clean
        ? line.text
        : this.onScreen(this.tabs.get(key(conversation, terminal)), line);
    if (action === 'send') {
      checkText(String(shown.text ?? ''));
      const text = String(args.text ?? '');
      checkText(text);
      const plain = text.replace(/\r\n?/g, '\n');
      facts.typed = plain;
      if (args.enter === true || plain.includes('\n'))
        facts.command = (before() + plain).replace(/\n+$/, '');
    } else if (RUNS_LINE.has(String(args.key ?? ''))) facts.command = before();
    if (facts.command !== undefined) {
      own.asked.set(terminal, line.version);
      // Read off the screen from its first column: the prompt may be part of it
      if (!line.clean && !line.start) facts.uncertain = true;
    } else own.asked.delete(terminal);
    return facts;
  }
  /**
   * What the person typed in a tab, as the window sends it. Typing into a tab Circle is
   * operating takes it over; otherwise Circle is told that they typed, never what.
   */
  typed(conversation: string, terminal: string, data: string): void {
    if (!terminal || !data || AUTOMATIC_REPLY.test(data)) return;
    const line = this.line(this.own(conversation), terminal);
    const tab = this.tabs.get(key(conversation, terminal));
    // Where the person starts a line is where the prompt ends: the keys have not reached
    // the shell yet, so the cursor is still there
    if (tab && !line.text && line.clean && !line.start) {
      const buffer = tab.session.screen.buffer.active;
      line.start = { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX };
    }
    personTyped(line, data);
    if (!tab || tab.session.held) return;
    if (this.conversations.get(conversation)?.active.has(terminal))
      this.sessions.attach(conversation, tab.session.id);
    else
      this.sessions.tell(conversation, `${tab.session.name}: the user typed`);
  }
  /** The person takes a tab, hands it back, or stops Circle's action on it. */
  async control(
    conversation: string,
    session: string,
    action: LocalTerminalControl,
  ): Promise<LocalTerminalRow[]> {
    const { host, snapshot, terminal } = this.find(conversation, session);
    const own = this.own(conversation);
    if (action === 'take') {
      const tab = this.adopt(conversation, host, snapshot);
      await tab.ready;
      this.sessions.attach(conversation, tab.session.id);
    } else if (action === 'return') {
      const tab = this.tabs.get(key(conversation, terminal));
      if (tab) this.sessions.detach(conversation, tab.session.id);
      own.handoffs.get(terminal)?.resolve();
    } else {
      const reason = Error(
        `the user stopped your action on ${this.name(host, conversation, terminal)}; what you had typed there may already have run, so read the tab before you send again`,
      );
      for (const controller of own.active.get(terminal) ?? [])
        controller.abort(reason);
    }
    return this.rows(conversation);
  }
  /** The conversation's running tabs, as the window shows Circle's use of them. */
  rows(conversation: string): LocalTerminalRow[] {
    const host = this.options.host(conversation);
    if (!host) return [];
    const list = host.listNow(conversation);
    const numbers = terminalTabNumbers(list);
    const own = this.conversations.get(conversation);
    const waiting = this.options.waiting(conversation);
    return list.filter(running).map((snapshot) => {
      const id = terminalTabSession(snapshot.id);
      const held = this.tabs.get(key(conversation, snapshot.id))?.session.held;
      const given = own?.handoffs.get(snapshot.id)?.reason;
      const reason =
        given && given.length > MAX_REASON
          ? given.slice(0, MAX_REASON - 1) + '…'
          : given;
      return {
        id,
        terminal: snapshot.id,
        ordinal: numbers.get(snapshot.id) ?? 0,
        state: held
          ? 'held'
          : waiting.has(id)
            ? 'waiting'
            : own?.active.has(snapshot.id)
              ? 'operating'
              : 'idle',
        allowed: own?.granted.has(snapshot.id) === true,
        ...(held ? { held } : {}),
        ...(reason ? { reason } : {}),
      };
    });
  }
  /** The conversation is gone: Circle lets go of its tabs; their shells are the window's. */
  release(conversation: string): void {
    const own = this.conversations.get(conversation);
    for (const handoff of own?.handoffs.values() ?? [])
      handoff.reject(Error('the conversation was deleted'));
    for (const controllers of own?.active.values() ?? [])
      for (const controller of controllers)
        controller.abort(Error('the conversation was deleted'));
    for (const [at, tab] of [...this.tabs])
      if (tab.conversation === conversation) {
        this.tabs.delete(at);
        tab.settle();
      }
    this.sessions.releaseSession(conversation);
    this.conversations.delete(conversation);
  }
  close(): void {
    for (const conversation of new Set([
      ...this.conversations.keys(),
      ...[...this.tabs.values()].map((tab) => tab.conversation),
    ]))
      this.release(conversation);
    for (const stop of this.watched.values()) stop();
    this.watched.clear();
    this.tabs.clear();
    this.sessions.close();
  }
  /** How many tabs Circle holds a screen for: none once their shells closed. */
  get adopted(): number {
    return this.tabs.size;
  }
  // -- internals --
  private async request(
    conversation: string,
    action: TerminalAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    const { host, snapshot, terminal } = this.find(conversation, args.session);
    const own = this.own(conversation);
    const writes = action === 'send' || action === 'press';
    if (writes) {
      // The facts asked the person for this tab's first write, and it runs: they allowed it
      if (args.first_use === true) own.granted.add(terminal);
      else if (!own.granted.has(terminal))
        throw Error(
          `the user has not let Circle use ${this.name(host, conversation, terminal)} yet; nothing was typed`,
        );
    }
    const tab = this.adopt(conversation, host, snapshot);
    await tab.ready;
    const gone = () =>
      Error(
        `${tab.session.name} was closed; it is gone from terminal_sessions`,
      );
    if (this.tabs.get(key(conversation, terminal)) !== tab) throw gone();
    // The line the card showed is the line that runs, or nothing is typed
    if (
      writes &&
      typeof args.command === 'string' &&
      own.asked.get(terminal) !== this.line(own, terminal).version
    )
      throw Error(
        `the line in ${tab.session.name} changed after you asked, so nothing was typed; read it and send again`,
      );
    const given = writes ? this.prepare(tab, action, args) : args;
    const controller = new AbortController();
    const relay = () => controller.abort(signal.reason);
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', relay, { once: true });
    const active = own.active.get(terminal) ?? new Set<AbortController>();
    own.active.set(terminal, active);
    active.add(controller);
    this.options.changed(conversation);
    try {
      const result = await this.sessions
        .request(conversation, action, given, controller.signal)
        .catch((error: unknown) => {
          // Closed while the action waited its turn: say so, not that none was connected
          if (
            this.tabs.get(key(conversation, terminal)) !== tab &&
            !/was closed/.test(error instanceof Error ? error.message : '')
          )
            throw gone();
          throw error;
        });
      // A tab has no host:port; the session alone says which terminal it was
      return { text: result.text, session: tab.session.id };
    } finally {
      signal.removeEventListener('abort', relay);
      tab.pipe.before = undefined;
      active.delete(controller);
      if (!active.size) own.active.delete(terminal);
      this.options.changed(conversation);
    }
  }
  /**
   * A write's text as the shell is given it, every line break an Enter, and what it does
   * to the line, kept for when the bytes go.
   */
  private prepare(
    tab: Tab,
    action: TerminalAction,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const line = this.line(this.own(tab.conversation), tab.terminal);
    const cursor = () => {
      const buffer = tab.session.screen.buffer.active;
      return { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX };
    };
    if (action === 'send') {
      const text = String(args.text ?? '');
      checkText(text);
      const shown = typeof args.typed === 'string' ? args.typed : text;
      const parts = shown.replace(/\r\n?/g, '\n').split('\n');
      const runs = args.enter === true || parts.length > 1;
      tab.pipe.before = () => {
        if (runs) {
          line.text = args.enter === true ? '' : parts.at(-1)!;
          line.clean = true;
          line.start = undefined;
        } else {
          if (!line.text && line.clean) line.start = cursor();
          line.text += shown;
        }
        line.version++;
      };
      return { ...args, text: text.replace(/\r\n|\n/g, '\r') };
    }
    const pressed = String(args.key ?? '');
    tab.pipe.before = () => {
      if (RUNS_LINE.has(pressed) || pressed === 'Ctrl_C') {
        line.text = '';
        line.clean = true;
        line.start = undefined;
      } else {
        if (!line.text && line.clean && !line.start) line.start = cursor();
        line.clean = false;
      }
      line.version++;
    };
    return args;
  }
  /** The text of the line at the prompt on the screen, from where Circle's typing began. */
  private onScreen(tab: Tab | undefined, line: Line): string {
    if (!tab) return '';
    const buffer = tab.session.screen.buffer.active;
    const cursor = buffer.baseY + buffer.cursorY;
    const start =
      line.start && line.start.row <= cursor
        ? line.start
        : { row: cursor, col: 0 };
    let row = start.row;
    if (!line.start) while (row > 0 && buffer.getLine(row)?.isWrapped) row--;
    let text = '';
    for (let at = row; ; at++) {
      const one = buffer.getLine(at);
      if (!one) break;
      const continues = buffer.getLine(at + 1)?.isWrapped === true;
      text += one.translateToString(
        !continues,
        at === start.row && line.start ? start.col : 0,
      );
      if (at >= cursor && !continues) break;
    }
    return text.trim();
  }
  private adopt(
    conversation: string,
    host: LocalTerminalHost,
    snapshot: TerminalSnapshot,
  ): Tab {
    const at = key(conversation, snapshot.id);
    const found = this.tabs.get(at);
    if (found) {
      found.session.name = this.name(host, conversation, snapshot.id);
      return found;
    }
    // Watched before the recent output is taken, so nothing falls between the two
    this.watch(host);
    const pipe = new TabPipe(host, conversation, snapshot.id);
    const session = new TerminalSession(
      terminalTabSession(snapshot.id),
      this.name(host, conversation, snapshot.id),
      `${basename(snapshot.shell)} in ${snapshot.cwd}`,
      'local',
      snapshot.cols,
      snapshot.rows,
      pipe,
      // Output alone changes nothing the window shows of Circle's use of the tab
      () => {},
    );
    let settle = () => {};
    const ready = new Promise<void>((done) => (settle = done));
    const tab: Tab = {
      conversation,
      terminal: snapshot.id,
      session,
      pipe,
      ready,
      settle,
    };
    this.tabs.set(at, tab);
    this.sessions.adopt(conversation, session);
    const recent = host.recentOutput(conversation, snapshot.id, RECENT_OUTPUT);
    if (recent?.data) pipe.feed(recent.data);
    // Quiet since its last output, not since Circle looked
    session.lastOutputAt =
      Date.parse(recent?.at ?? snapshot.startedAt) || Date.now();
    // The emulator parses later: an empty write's callback comes after the output's
    session.screen.write('', settle);
    return tab;
  }
  private event(event: TerminalEvent): void {
    const tab = this.tabs.get(key(event.owner, event.terminalId));
    if (event.kind === 'data') {
      if (tab && event.data) tab.pipe.feed(event.data);
      return;
    }
    if (event.kind === 'resized' && event.snapshot) {
      if (tab)
        this.sessions.resize(
          tab.conversation,
          tab.session.id,
          event.snapshot.cols,
          event.snapshot.rows,
        );
      return;
    }
    const status = event.snapshot?.status;
    if (status && status !== 'running') {
      if (tab) this.drop(tab);
      const own = this.conversations.get(event.owner);
      own?.lines.delete(event.terminalId);
      own?.granted.delete(event.terminalId);
      own?.asked.delete(event.terminalId);
    }
    if (event.snapshot && isShell(event.snapshot))
      this.options.changed(event.owner);
  }
  /** A tab closed: its actions end with that said, and Circle's screen of it goes. */
  private drop(tab: Tab): void {
    const at = key(tab.conversation, tab.terminal);
    if (this.tabs.get(at) !== tab) return;
    this.tabs.delete(at);
    tab.settle();
    this.conversations
      .get(tab.conversation)
      ?.handoffs.get(tab.terminal)
      ?.reject(Error(`${tab.session.name} was closed`));
    this.sessions.drop(tab.conversation, tab.session.id, 'closed');
  }
  private hand(
    conversation: string,
    session: string,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.options.mode(conversation) === 'plan')
      return Promise.reject(Error('plan mode does not hand a terminal over'));
    const terminal = terminalTabId(session);
    if (!terminal) return Promise.reject(Error('no such terminal tab'));
    const own = this.own(conversation);
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        own.handoffs.delete(terminal);
        signal.removeEventListener('abort', abort);
        this.options.changed(conversation);
      };
      const abort = () => {
        settle();
        reject(signal.reason ?? Error('stopped'));
      };
      own.handoffs.set(terminal, {
        reason,
        resolve: () => {
          settle();
          resolve();
        },
        reject: (error) => {
          settle();
          reject(error);
        },
      });
      signal.addEventListener('abort', abort, { once: true });
      this.options.changed(conversation);
    });
  }
  private async list(conversation: string): Promise<string[]> {
    const host = this.options.host(conversation);
    if (!host) return [];
    const lines: string[] = [];
    for (const snapshot of host.listNow(conversation).filter(running)) {
      const tab = this.adopt(conversation, host, snapshot);
      await tab.ready;
      const line = this.sessions.describe(conversation, tab.session.id);
      if (line) lines.push(`- ${line}`);
    }
    return lines;
  }
  private find(
    conversation: string,
    session: unknown,
  ): { host: LocalTerminalHost; snapshot: TerminalSnapshot; terminal: string } {
    const terminal = terminalTabId(session);
    const host = terminal ? this.options.host(conversation) : undefined;
    const snapshot = host
      ?.listNow(conversation)
      .find((one) => one.id === terminal && isShell(one));
    if (!terminal || !host || !snapshot)
      throw Error(
        `no terminal ${String(session ?? '') || '(none given)'} in this conversation; see terminal_sessions`,
      );
    if (snapshot.status !== 'running')
      throw Error(
        `${this.name(host, conversation, terminal)} was closed; it is gone from terminal_sessions`,
      );
    return { host, snapshot, terminal };
  }
  private ordinal(
    host: LocalTerminalHost,
    conversation: string,
    terminal: string,
  ): number {
    return terminalTabNumbers(host.listNow(conversation)).get(terminal) ?? 0;
  }
  /** The tab's name for the model: "terminal N", as the person's tab reads in English. */
  private name(
    host: LocalTerminalHost,
    conversation: string,
    terminal: string,
  ): string {
    return `terminal ${this.ordinal(host, conversation, terminal)}`;
  }
  private own(conversation: string): Conversation {
    let own = this.conversations.get(conversation);
    if (!own) {
      own = {
        granted: new Set(),
        lines: new Map(),
        active: new Map(),
        handoffs: new Map(),
        asked: new Map(),
      };
      this.conversations.set(conversation, own);
    }
    return own;
  }
  private line(own: Conversation, terminal: string): Line {
    let line = own.lines.get(terminal);
    if (!line) {
      line = { text: '', clean: true, version: 0 };
      own.lines.set(terminal, line);
    }
    return line;
  }
}

function checkText(text: string): void {
  if (text.length > MAX_TEXT)
    throw Error(
      `text for a terminal tab is at most ${MAX_TEXT} characters at a time`,
    );
  if (CONTROL.test(text))
    throw Error(
      'text for a terminal tab takes no control characters or tabs; press keys with terminal_press',
    );
}

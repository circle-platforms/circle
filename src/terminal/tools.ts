// The tools that drive this conversation's device terminals, and the bridge that carries
// their requests where the consoles live: the main process in the desktop application, the
// runtime itself in the terminal. The shape follows the browser's (src/browser/tools.ts).
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { loadToolPrompt } from '../system_prompt.js';
import type { Effect, Tool, ToolContext } from '../types.js';
import type { AgentRuntime } from '../runtime.js';
import { standsIn } from '../secrets.js';
import {
  isLocalTerminal,
  TERMINAL_KEYS,
  type TerminalAction,
  type TerminalApproval,
  type TerminalResult,
} from './protocol.js';
import {
  loadProfiles,
  parseTarget,
  profileTarget,
  type TerminalProfile,
} from './profiles.js';

/** Where the runtime's terminal tools send their requests: the main process, or a test. */
export interface TerminalPort {
  request(
    sessionId: string,
    action: TerminalAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult>;
}

/** The runtime's side of the device terminals, over the utility process's port. */
export class TerminalBridge implements TerminalPort {
  private closed?: Error;
  private pending = new Map<
    string,
    {
      resolve: (result: TerminalResult) => void;
      reject: (error: Error) => void;
    }
  >();
  constructor(private post: (message: unknown) => void) {}
  request(
    sessionId: string,
    action: TerminalAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<TerminalResult> {
    if (this.closed) return Promise.reject(this.closed);
    if (signal.aborted)
      return Promise.reject(signal.reason ?? Error('terminal action stopped'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        try {
          this.post({ type: 'terminal-cancel', id });
        } catch {
          // A lost transport cannot cancel the main process, but this caller still stops.
        }
        reject(signal.reason ?? Error('terminal action stopped'));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (result) => {
          signal.removeEventListener('abort', abort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      });
      try {
        this.post({
          type: 'terminal',
          request: { id, sessionId, action, args },
        });
      } catch (error) {
        this.pending.delete(id);
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }
  /** Internal lifecycle RPC, never exposed as a model tool. */
  releaseSession(sessionId: string): Promise<void> {
    if (this.closed) return Promise.reject(this.closed);
    const id = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('session terminal cleanup timed out'));
      }, 15000);
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.post({ type: 'terminal-release', id, sessionId });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }
  receive(reply: {
    id: string;
    ok: boolean;
    error?: string;
    data?: TerminalResult;
  }) {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok && reply.data) pending.resolve(reply.data);
    else pending.reject(Error(reply.error || 'the terminal failed'));
  }
  /** The main process is gone: nothing it was asked will be answered. */
  close(error = Error('the terminal is closed')) {
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

/**
 * Asks the person whether the model may log in to a device whose host key nobody has
 * trusted yet (`once` for this conversation, `always` for good on a private host, or
 * `reject`). `auto`: answered without asking, as once — never for good.
 */
export type TerminalConfirm = (
  sessionId: string,
  approval: TerminalApproval,
  signal: AbortSignal,
  callId?: string,
) => Promise<'once' | 'always' | 'reject' | 'auto'>;

/**
 * The person's own terminal tabs, where the host has them (the desktop application): what
 * a write to one types and runs, for its approval. It throws for a call that cannot run,
 * so no card is shown for it.
 */
export interface TerminalTabFacts {
  facts(
    conversation: string,
    action: TerminalAction,
    args: Record<string, unknown>,
    shown: Record<string, unknown>,
  ): Record<string, unknown>;
}

export interface TerminalToolOptions {
  confirm?: TerminalConfirm;
  /** The person's saved device profiles, read the way the manager reads them. */
  profiles?: () => TerminalProfile[];
  /** The person's terminal tabs, as `local:<id>` sessions beside the devices. */
  tabs?: TerminalTabFacts;
}

// What the tools say of the person's terminal tabs, where the host has them.
const TAB_NOTES: Record<string, string> = {
  terminal_sessions:
    "\n- In the desktop application it also lists the user's own terminal tabs on this computer, as `local:<id>` and the name their tab has (`terminal 1`). The same tools read, wait on, type in and press keys in them.",
  terminal_send:
    "\n- In one of the user's terminal tabs (`local:…`) the first thing you type asks the user. After that a line you send with Enter, or with a line break, is approved like an `execute` command, by the same rules; typing without Enter does not ask. Text there takes no control characters: press keys with terminal_press. If the user takes the tab over, typing is refused until they hand it back.",
  terminal_press:
    "\n- In one of the user's terminal tabs (`local:…`) the first key asks the user. After that Enter and Ctrl_D run the line at the prompt and are approved like an `execute` command; other keys do not ask.",
  terminal_read:
    "\n- One of the user's terminal tabs reads the same way, without asking. While the user has taken it over, the result says so and shows nothing.",
  terminal_wait:
    '\n- If the user takes one of their terminal tabs over while you wait on it, the wait ends at once and says so.',
  terminal_disconnect:
    "\n- The user's own terminal tabs (`local:…`) are theirs: they cannot be closed from here.",
  terminal_handoff:
    "\n- One of the user's terminal tabs (`local:…`) can be handed over the same way.",
};

// Device words that can wipe what a device holds: one of them in a sent line asks every
// time, rule aside, the way deleting files does. Whole words only: `reset` inside a path
// does not count, `reset config` does. A false alarm costs one more card; a miss would
// cost a device.
const DESTRUCTIVE_WORDS = [
  'reboot',
  'reload',
  'erase',
  'delete',
  'format',
  'shutdown',
  'destroy',
  'wipe',
  'reset',
];

function destructiveWord(text: string): string {
  const lower = text.toLowerCase();
  for (const word of DESTRUCTIVE_WORDS) if (standsIn(lower, word)) return word;
  return '';
}

/**
 * The tools that drive the devices of the conversation the user sees. They stay out of
 * subagents: the terminal page shows one conversation's consoles.
 */
export function terminalTools(
  port: TerminalPort,
  options: TerminalToolOptions = {},
): Tool[] {
  const { confirm, profiles = () => [], tabs } = options;
  // Each conversation's devices: the host of every session the model has seen, and the
  // last one, kept from each result like the browser keeps the site of its page
  const hosts = new Map<string, Map<string, string>>();
  const remember = (sessionId: string, result: TerminalResult) => {
    if (typeof result.host !== 'string' || !result.host) return;
    let own = hosts.get(sessionId);
    if (!own) hosts.set(sessionId, (own = new Map()));
    if (typeof result.session === 'string' && result.session)
      own.set(result.session, result.host);
    own.set('*', result.host);
  };
  /** The device an action acts on, for its approval, known before anything runs. */
  const hostFor = (
    action: TerminalAction,
    args: Record<string, unknown>,
    sessionId: string,
  ): string => {
    if (action === 'connect') {
      // A connect goes where its profile goes, worked out now, before anyone is asked
      if (typeof args.profile === 'string' && args.profile) {
        const wanted = args.profile.toLowerCase();
        const profile = profiles().find(
          (one) => one.name.toLowerCase() === wanted,
        );
        return profile ? profileTarget(profile) : '';
      }
      if (typeof args.host === 'string' && args.host) {
        const transport = args.transport === 'telnet' ? 'telnet' : 'ssh';
        const parsed = parseTarget(
          transport,
          args.host,
          typeof args.port === 'number' ? args.port : undefined,
        );
        return parsed?.target ?? '';
      }
      return '';
    }
    const own = hosts.get(sessionId);
    if (!own) return '';
    // The host of the very terminal named; the last known one is no answer for another
    if (typeof args.session === 'string' && args.session) {
      const known = own.get(args.session);
      if (known) return known;
    }
    return '';
  };
  /**
   * One terminal action, as a tool does it: the person asked when a new host key stops
   * the login, and the device of the result kept for the next approval.
   */
  const perform = async (
    action: TerminalAction,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<TerminalResult> => {
    let result = await port.request(
      context.sessionId,
      action,
      args,
      context.signal,
    );
    // A connect can need the person: the host key of a device never logged in to
    for (let round = 0; result.approval && round < 8; round++) {
      const approval = result.approval;
      // The approval comes from the person, never from the model's arguments: the token
      // that carries it is not shown to the model and the schema refuses it.
      const decision = confirm
        ? await confirm(
            context.sessionId,
            approval,
            context.signal,
            context.callId,
          )
        : 'reject';
      if (decision === 'reject')
        throw Error(
          'the user did not trust this device host key; nothing was sent to it',
        );
      result = await port.request(
        context.sessionId,
        action,
        {
          ...args,
          approval: {
            token: approval.token,
            // `always` for good only where the store will keep it: the manager decides
            scope: decision === 'always' ? 'always' : 'once',
          },
        },
        context.signal,
      );
    }
    remember(context.sessionId, result);
    return result;
  };
  const tool = (
    name: string,
    action: TerminalAction,
    effect: Effect,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): Tool => ({
    name,
    description: loadToolPrompt(name) + (tabs ? (TAB_NOTES[name] ?? '') : ''),
    effect,
    subagents: false,
    ...(effect === 'read'
      ? {}
      : {
          approvalFacts: (
            args: Record<string, unknown>,
            sessionId: string,
            shown?: Record<string, unknown>,
          ) => {
            // A terminal tab's write is judged by what it types and runs
            if (tabs && isLocalTerminal(args.session))
              return tabs.facts(sessionId, action, args, shown ?? args);
            const host = hostFor(action, args, sessionId);
            // What the line can destroy on the device, from the text as it will run
            // (secrets already expanded); only the matched word is ever named
            const removes =
              action === 'send' ? destructiveWord(String(args.text ?? '')) : '';
            return host || removes
              ? {
                  ...(host ? { host } : {}),
                  ...(removes ? { deletes: removes } : {}),
                }
              : undefined;
          },
        }),
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    async run(args, context) {
      const result = await perform(action, args, context);
      return result.text;
    },
  });
  const session = {
    type: 'string',
    description: tabs
      ? "The terminal of this conversation: a device such as t1, or one of the user's terminal tabs as local:<id>"
      : 'The terminal of this conversation, such as t1',
  };
  return [
    tool('terminal_sessions', 'sessions', 'read', {}),
    tool('terminal_connect', 'connect', 'unknown', {
      profile: {
        type: 'string',
        description:
          'The saved profile to connect by, from terminal_sessions: the way to SSH',
      },
      host: {
        type: 'string',
        description:
          'A device by address, when there is no profile for it; telnet consoles answer their own login',
      },
      port: {
        type: 'number',
        description: 'The port; 22 for ssh, 23 for telnet',
      },
      transport: {
        type: 'string',
        enum: ['ssh', 'telnet'],
        description: 'The protocol, for a bare host',
      },
      user: {
        type: 'string',
        description: 'The login name, for a bare host',
      },
    }),
    tool(
      'terminal_send',
      'send',
      'unknown',
      {
        session,
        text: {
          type: 'string',
          description:
            'What to type to the device; %NAME% puts in a variable or a secret, whose value you never see back',
        },
        enter: {
          type: 'boolean',
          description: 'Press Enter after the text',
        },
      },
      ['session', 'text'],
    ),
    tool(
      'terminal_read',
      'read',
      'read',
      {
        session,
        lines: {
          type: 'number',
          minimum: 1,
          maximum: 2000,
          description: 'How far back to read; 50 by default',
        },
      },
      ['session'],
    ),
    tool(
      'terminal_wait',
      'wait',
      'read',
      {
        session,
        idle_ms: {
          type: 'number',
          minimum: 100,
          maximum: 30000,
          description:
            'Quiet that counts as resting at the prompt; 600 by default',
        },
        pattern: {
          type: 'string',
          maxLength: 200,
          description:
            'A regular expression the screen must show, for a device that answers',
        },
        absent: {
          type: 'string',
          maxLength: 200,
          description:
            'A regular expression the device must not print once the wait begins: the wait ends at once, as a failed check, when it does',
        },
        retries: {
          type: 'number',
          minimum: 0,
          maximum: 5,
          description:
            'How many times to wait again after a timeout; 0 by default',
        },
        changed: {
          type: 'boolean',
          description:
            'Also return the lines the device printed during the wait, and only those',
        },
        timeout_ms: {
          type: 'number',
          minimum: 1000,
          maximum: 300000,
          description: 'How long to wait at most; 30000 by default',
        },
      },
      ['session'],
    ),
    tool(
      'terminal_press',
      'press',
      'unknown',
      {
        session,
        key: {
          type: 'string',
          enum: Object.keys(TERMINAL_KEYS),
          description: 'The key to press',
        },
      },
      ['session', 'key'],
    ),
    tool('terminal_disconnect', 'disconnect', 'unknown', { session }, [
      'session',
    ]),
    tool(
      'terminal_handoff',
      'handoff',
      'read',
      {
        session,
        reason: {
          type: 'string',
          description: 'What the person is asked to do on the device',
        },
      },
      ['session', 'reason'],
    ),
  ];
}

/** What the tools take of a runtime: the device profiles, from its data folder. */
export function runtimeTerminalOptions(runtime: () => AgentRuntime): {
  profiles: () => TerminalProfile[];
} {
  return {
    profiles: () =>
      loadProfiles(join(runtime().options.home, 'terminal-sessions.json')),
  };
}

import { randomUUID } from 'node:crypto';
import { loadToolPrompt } from '../../../src/system_prompt.js';
import { fitMedia } from '../../../src/media.js';
import type { Effect, Tool } from '../../../src/types.js';
import { onlyReferences } from '../../../src/secrets.js';
import {
  BROWSER_KEYS,
  type CertificateApproval,
  type BrowserAction,
  type BrowserReply,
  type BrowserResult,
} from './browser-protocol';

/** Where the runtime's browser tools send their requests: the main process, or a test. */
export interface BrowserPort {
  request(
    sessionId: string,
    action: BrowserAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<BrowserResult>;
}

/** The runtime's side of the conversation browser, over the utility process's port. */
export class BrowserBridge implements BrowserPort {
  private closed?: Error;
  private pending = new Map<
    string,
    { resolve: (result: BrowserResult) => void; reject: (error: Error) => void }
  >();
  constructor(private post: (message: unknown) => void) {}
  request(
    sessionId: string,
    action: BrowserAction,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<BrowserResult> {
    if (this.closed) return Promise.reject(this.closed);
    if (signal.aborted)
      return Promise.reject(signal.reason ?? Error('browser action stopped'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        try {
          this.post({ type: 'browser-cancel', id });
        } catch {
          // A lost transport cannot cancel the main process, but this caller still stops.
        }
        reject(signal.reason ?? Error('browser action stopped'));
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
          type: 'browser',
          request: { id, sessionId, action, args },
        });
      } catch (error) {
        this.pending.delete(id);
        signal.removeEventListener('abort', abort);
        reject(error instanceof Error ? error : Error(String(error)));
      }
    });
  }
  receive(reply: BrowserReply) {
    const pending = this.pending.get(reply.id);
    if (!pending) return;
    this.pending.delete(reply.id);
    if (reply.ok && reply.data) pending.resolve(reply.data);
    else pending.reject(Error(reply.error || 'the browser failed'));
  }
  /** The main process is gone: nothing it was asked will be answered. */
  close(error = Error('the browser is closed')) {
    this.closed = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

const ref = {
  type: 'string',
  description: "The element's ref from the latest snapshot, such as e3",
};
const element = {
  type: 'string',
  description: 'What the element is, in a few words, for the user',
};

/** Asks the person whether the model may pass a certificate warning: once, for good, or not. */
export type CertificateConfirm = (
  sessionId: string,
  approval: CertificateApproval,
  signal: AbortSignal,
  callId?: string,
) => Promise<'once' | 'always' | 'reject'>;

/** What the tools need of the runtime that hosts them, beyond the browser itself. */
export interface BrowserToolOptions {
  confirm?: CertificateConfirm;
}

/**
 * The tools that drive the browser of the conversation the user sees. They stay out of
 * subagents: the browser panel shows one conversation's browser.
 */
export function browserTools(
  browser: BrowserPort,
  options: BrowserToolOptions = {},
): Tool[] {
  const { confirm } = options;
  const tool = (
    name: string,
    action: BrowserAction,
    effect: Effect,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): Tool => ({
    name,
    description: loadToolPrompt(name),
    effect,
    subagents: false,
    parameters: {
      type: 'object',
      properties,
      required,
      additionalProperties: false,
    },
    async run(args, context) {
      // Nothing is taken for a model that could not look at it
      if (action === 'screenshot' && context.imageInput === false)
        throw Error(
          'the model in use does not read images; use browser_snapshot',
        );
      // Text made only of secrets' %NAME% may go into a password field, and the pointer's
      // label hides it. The harness put the values in.
      if (
        action === 'type' &&
        context.secretNames?.length &&
        typeof context.rawArgs?.text === 'string' &&
        onlyReferences(context.rawArgs.text, context.secretNames)
      )
        args = {
          ...args,
          secret: true,
          secretName: context.secretNames.join(', '),
        };
      let result = await browser.request(
        context.sessionId,
        action,
        args,
        context.signal,
      );
      if (result.approval) {
        // The approval comes from the person, never from the model's arguments: the token
        // that carries it is not shown to the model and the schema refuses it.
        const decision = confirm
          ? await confirm(
              context.sessionId,
              result.approval,
              context.signal,
              context.callId,
            )
          : 'reject';
        if (decision === 'reject')
          throw Error(
            'the user did not approve proceeding past the certificate warning',
          );
        result = await browser.request(
          context.sessionId,
          action,
          {
            ...args,
            approval: { token: result.approval.token, scope: decision },
          },
          context.signal,
        );
      }
      if (!result.image) return result.text;
      if (!context.emitAttachments)
        throw Error('this caller does not accept media attachments');
      const { attachment, size } = fitMedia(
        Buffer.from(result.image, 'base64'),
        'image/png',
        'browser.png',
      );
      context.emitAttachments([attachment]);
      return `${result.text} (${size})`;
    },
  });
  return [
    tool(
      'browser_navigate',
      'navigate',
      'unknown',
      {
        url: {
          type: 'string',
          description: 'An http or https address, or back, forward or reload',
        },
      },
      ['url'],
    ),
    tool('browser_snapshot', 'snapshot', 'read', {}),
    tool('browser_click', 'click', 'unknown', { ref, element }, [
      'ref',
      'element',
    ]),
    tool(
      'browser_type',
      'type',
      'unknown',
      {
        ref,
        element,
        text: {
          type: 'string',
          description:
            'The text to type; %NAME% puts in a variable or a secret, whose value you never see',
        },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
      },
      ['ref', 'element', 'text'],
    ),
    tool(
      'browser_select',
      'select',
      'unknown',
      {
        ref,
        element,
        values: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description: 'The options to choose, by their text or value',
        },
      },
      ['ref', 'element', 'values'],
    ),
    tool(
      'browser_press',
      'press',
      'unknown',
      {
        key: {
          type: 'string',
          enum: Object.keys(BROWSER_KEYS),
          description: 'The key to press',
        },
      },
      ['key'],
    ),
    tool('browser_screenshot', 'screenshot', 'read', {}),
    tool(
      'browser_dialog',
      'dialog',
      'unknown',
      {
        id: {
          type: 'string',
          description:
            "The dialog's id, such as d2; leave out for the shown tab's dialog",
        },
        accept: {
          type: 'boolean',
          description:
            'True presses OK (or leaves the page), false presses Cancel (or stays)',
        },
        text: { type: 'string', description: 'The answer to a prompt' },
      },
      ['accept'],
    ),
    tool(
      'browser_tabs',
      'tabs',
      'unknown',
      {
        action: {
          type: 'string',
          enum: ['list', 'new', 'select', 'close'],
          description: 'What to do',
        },
        tab: {
          type: 'string',
          description: 'The tab to show or close, such as t2',
        },
        url: {
          type: 'string',
          description: 'For new: an http or https address to open in it',
        },
      },
      ['action'],
    ),
  ];
}

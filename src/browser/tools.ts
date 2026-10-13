import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { loadToolPrompt } from '../system_prompt.js';
import { fitMedia } from '../media.js';
import type { Effect, Message, Tool, ToolContext } from '../types.js';
import type { AgentRuntime } from '../runtime.js';
import { loadSecrets, onlyReferences } from '../secrets.js';
import { VARIABLE_NAME } from '../settings.js';
import { siteOf } from './hosts.js';
import { destructive, snapshotElement, waitingDialog } from './format.js';
import {
  BROWSER_KEYS,
  type BrowserAction,
  type BrowserApproval,
  type BrowserReply,
  type BrowserResult,
} from './protocol.js';
import { replay as replayScript } from './replay.js';
import {
  formatScript,
  inline,
  leftOutText,
  nameFromPath,
  parseScript,
  recordSteps,
  ScriptValues,
  SCRIPT_FORMAT,
  startSite,
  stepTexts,
  type BrowserScript,
} from './script.js';

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

/**
 * Asks the person whether the model may pass a certificate warning (once, for good, or not)
 * or give a page files (once or not). `auto`: auto mode answered without asking, as once.
 */
export type BrowserConfirm = (
  sessionId: string,
  approval: BrowserApproval,
  signal: AbortSignal,
  callId?: string,
) => Promise<'once' | 'always' | 'reject' | 'auto'>;

/** What the tools need of the runtime that hosts them, beyond the browser itself. */
export interface BrowserToolOptions {
  confirm?: BrowserConfirm;
  /**
   * A path the model gave, as the file tools read it: the full path, or an error for a
   * credential file. Without it only full paths are taken.
   */
  files?: (path: string) => string;
  /**
   * A path the model gave, as write_file writes it: the full path, or an error for a
   * credential file or a job's output. Without it only full paths are taken.
   */
  writable?: (path: string) => string;
  /** A conversation's stored messages, which `browser_record` writes a script from. */
  history?: (sessionId: string) => Message[];
  /** Circle's plain variables and its secrets, which a replayed script's %NAME% take. */
  variables?: () => Record<string, string>;
  secrets?: () => Record<string, string>;
}
/**
 * What the tools take of a runtime: paths as the file tools take them, its stored
 * conversations, its variables and its secrets. `runtime` is read when a tool runs.
 */
export function runtimeBrowserOptions(
  runtime: () => AgentRuntime,
): Required<Omit<BrowserToolOptions, 'confirm'>> {
  return {
    files: (path) => {
      const full = runtime().sandbox.resolvePath(path);
      runtime().sandbox.checkCredentialPath(full);
      return full;
    },
    writable: (path) => {
      const full = runtime().sandbox.resolvePath(path);
      runtime().sandbox.checkMutablePath(full);
      return full;
    },
    history: (sessionId) => runtime().store.messages(sessionId),
    variables: () => runtime().options.settings.variables ?? {},
    secrets: () => loadSecrets(runtime().options.home),
  };
}

/**
 * The tools that drive the browser of the conversation the user sees. They stay out of
 * subagents: the browser panel shows one conversation's browser.
 */
export function browserTools(
  browser: BrowserPort,
  options: BrowserToolOptions = {},
): Tool[] {
  const {
    confirm,
    files = full,
    writable = full,
    history,
    variables = () => ({}),
    secrets = () => ({}),
  } = options;
  // Each conversation's shown site and latest result, which names what its refs are
  const sites = new Map<string, string>();
  const pages = new Map<string, string>();
  // What an action would delete, for its approval: the control's name in the latest
  // snapshot (the model's own words when the ref is not there), or the dialog it accepts
  const deletes = (
    action: BrowserAction,
    args: Record<string, unknown>,
    sessionId: string,
  ): string => {
    const page = pages.get(sessionId) ?? '';
    if (action === 'click' && typeof args.ref === 'string') {
      const target = snapshotElement(page, args.ref);
      const name =
        target?.name ||
        (target ? '' : typeof args.element === 'string' ? args.element : '');
      return destructive(name) ? name : '';
    }
    if (action === 'dialog' && args.accept === true) {
      const dialog = waitingDialog(page, args.id);
      return destructive(dialog) ? dialog.slice(0, 300) : '';
    }
    return '';
  };
  // The site an action acts on, for its approval: where a navigation goes, else the page's
  const siteFor = (
    action: BrowserAction,
    args: Record<string, unknown>,
    sessionId: string,
  ): string => {
    const shown = sites.get(sessionId) ?? '';
    if (action === 'navigate' && typeof args.url === 'string')
      return ['back', 'forward', 'reload'].includes(args.url)
        ? shown
        : siteOf(args.url);
    if (action === 'tabs')
      return args.action === 'new'
        ? typeof args.url === 'string' && args.url
          ? siteOf(args.url)
          : ''
        : shown;
    return shown;
  };
  /**
   * One browser action, as a tool does it and as a replayed script's step does it: text made
   * only of secrets' names marked as a secret, paths taken as the file tools take them, the
   * person asked when the browser needs them, and the site the result shows kept.
   */
  const perform = async (
    action: BrowserAction,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<BrowserResult> => {
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
    // A sign-in's password, as a password field's, is only ever a saved secret
    if (action === 'dialog' && args.password !== undefined) {
      if (
        typeof context.rawArgs?.password !== 'string' ||
        !context.secretNames?.length ||
        !onlyReferences(context.rawArgs.password, context.secretNames)
      )
        throw Error(
          "a sign-in's password takes only a saved secret, written %NAME%",
        );
    }
    if (action === 'upload') {
      if (
        !Array.isArray(args.paths) ||
        !args.paths.every((path) => typeof path === 'string')
      )
        throw Error('invalid file paths');
      args = { ...args, paths: args.paths.map((path) => files(path)) };
    }
    let result = await browser.request(
      context.sessionId,
      action,
      args,
      context.signal,
    );
    // An action can need the person more than once: past a warning, then a download from
    // each site
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
      // The action was done: a download the person does not keep is discarded, and the
      // model still learns what the action did
      if (approval.kind === 'download') {
        const answer = await browser.request(
          context.sessionId,
          action,
          {
            ...args,
            approval: { token: approval.token, scope: decision },
          },
          context.signal,
        );
        result = { ...answer, text: `${result.text}\n${answer.text}` };
        continue;
      }
      if (decision === 'reject')
        throw Error(
          approval.kind === 'upload'
            ? 'the user did not allow giving the page these files'
            : 'the user did not approve proceeding past the certificate warning',
        );
      result = await browser.request(
        context.sessionId,
        action,
        {
          ...args,
          approval: {
            token: approval.token,
            scope: approval.kind === 'upload' ? 'once' : decision,
          },
        },
        context.signal,
      );
    }
    if (typeof result.origin === 'string')
      sites.set(context.sessionId, result.origin);
    pages.set(context.sessionId, result.text);
    return result;
  };
  const tool = (
    name: string,
    action: BrowserAction,
    effect: Effect,
    properties: Record<string, unknown>,
    required: string[] = [],
    // False: the tool asks the person itself, every time
    approval?: boolean,
  ): Tool => ({
    name,
    description: loadToolPrompt(name),
    effect,
    subagents: false,
    ...(approval === false ? { approval } : {}),
    ...(effect === 'read'
      ? {}
      : {
          approvalFacts: (args: Record<string, unknown>, sessionId: string) => {
            const site = siteFor(action, args, sessionId);
            const removes = deletes(action, args, sessionId);
            return site || removes
              ? {
                  ...(site ? { site } : {}),
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
      // Nothing is taken for a model that could not look at it
      if (action === 'screenshot' && context.imageInput === false)
        throw Error(
          'the model in use does not read images; use browser_snapshot',
        );
      const result = await perform(action, args, context);
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
  const actions = [
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
        text: {
          type: 'string',
          description: 'The answer to a prompt, or the user name for a sign-in',
        },
        password: {
          type: 'string',
          description: "A sign-in's password: only a saved secret's %NAME%",
        },
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
    tool(
      'browser_handoff',
      'handoff',
      'read',
      {
        reason: {
          type: 'string',
          description:
            'What the user should do in the browser, in a sentence, such as "sign in with your security key"',
        },
      },
      ['reason'],
    ),
    tool(
      'browser_upload',
      'upload',
      'unknown',
      {
        ref: {
          ...ref,
          description:
            "A file input's ref from the latest snapshot; leave out to answer the file chooser waiting in the result",
        },
        element,
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The files to give the page; an empty list closes the waiting file chooser without any',
        },
      },
      ['paths'],
      false,
    ),
  ];
  // What a replay of a script file runs: its steps, the values of its %NAME%, and the site
  // it starts on. Read again when it runs, as the file or the page may have changed.
  const plan = (
    args: Record<string, unknown>,
    sessionId: string,
    context?: ToolContext,
  ) => {
    if (typeof args.path !== 'string' || !args.path)
      throw Error('give the path of the script');
    const path = files(args.path);
    let source: string;
    try {
      if (statSync(path).size > MAX_SCRIPT)
        throw Error('it is larger than 1 MB');
      source = readFileSync(path, 'utf8');
    } catch (error) {
      throw Error(
        `the script cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const script = parseScript(source);
    const count = script.steps.length;
    const from = args.from === undefined ? 1 : Number(args.from);
    const to = args.to === undefined ? count : Number(args.to);
    if (
      !Number.isInteger(from) ||
      !Number.isInteger(to) ||
      from < 1 ||
      to > count ||
      from > to
    )
      throw Error(
        `from and to are step numbers from 1 to ${count}, from no later than to`,
      );
    const given = args.variables ?? {};
    if (
      !given ||
      typeof given !== 'object' ||
      Array.isArray(given) ||
      Object.entries(given).some(
        ([name, value]) =>
          !VARIABLE_NAME.test(name) || typeof value !== 'string',
      )
    )
      throw Error(
        'variables maps names, written in capital letters, digits and _, to text',
      );
    // A value given as a secret's %NAME% stands for that secret: typed as one
    const raw = context?.rawArgs?.variables as
      Record<string, unknown> | undefined;
    const names = context?.secretNames ?? [];
    const givenSecret = new Set(
      Object.keys(given).filter(
        (name) =>
          typeof raw?.[name] === 'string' &&
          onlyReferences(raw[name] as string, names),
      ),
    );
    const values = new ScriptValues(
      given as Record<string, string>,
      givenSecret,
      variables(),
      secrets(),
    );
    const steps = script.steps.slice(from - 1, to);
    const missing = [
      ...new Set(
        steps.flatMap((step) =>
          stepTexts(step).flatMap((text) => values.missing(text)),
        ),
      ),
    ];
    if (missing.length)
      throw Error(
        `the script uses ${missing.map((name) => `%${name}%`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not set: give ${missing.length === 1 ? 'it' : 'them'} in variables, or ask the user to keep ${missing.length === 1 ? 'it' : 'them'} as a Circle variable or secret. No step was done.`,
      );
    return {
      path,
      script,
      from,
      to,
      values,
      site: startSite(steps, values, sites.get(sessionId) ?? ''),
    };
  };
  const record: Tool = {
    name: 'browser_record',
    description: loadToolPrompt('browser_record'),
    effect: 'write',
    subagents: false,
    // A file writer: %NAME% stays as written, as the script's own
    variables: false,
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'The file to write, such as login.circle-browser.json; relative to the workspace',
        },
        name: {
          type: 'string',
          description:
            "The script's name; without it, the file's name without .circle-browser.json",
        },
        first: {
          type: 'integer',
          minimum: 1,
          description: 'The first recorded step to keep, from 1',
        },
        last: {
          type: 'integer',
          minimum: 1,
          description: 'The last recorded step to keep',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, context) {
      if (!history) throw Error('this conversation has no history to record');
      const path = writable(String(args.path));
      const { steps, left } = recordSteps(history(context.sessionId), actions);
      if (!steps.length)
        throw Error(
          `this conversation has no browser action to record${left.length ? `; left out: ${leftOutText(left)}` : ''}`,
        );
      const first = args.first === undefined ? 1 : Number(args.first);
      const last = args.last === undefined ? steps.length : Number(args.last);
      if (
        !Number.isInteger(first) ||
        !Number.isInteger(last) ||
        first < 1 ||
        last > steps.length ||
        first > last
      )
        throw Error(
          `first and last are step numbers from 1 to ${steps.length}, the steps recorded: ${steps.map((step, index) => `${index + 1}. ${inline(step)}`).join(' ')}`,
        );
      const script: BrowserScript = {
        circle: SCRIPT_FORMAT,
        name:
          typeof args.name === 'string' && args.name.trim()
            ? args.name.trim()
            : nameFromPath(path),
        steps: steps.slice(first - 1, last),
      };
      context.signal.throwIfAborted();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, formatScript(script));
      const count = script.steps.length;
      return [
        `Recorded ${count} step${count === 1 ? '' : 's'} in ${path}${first > 1 || last < steps.length ? ` (steps ${first}–${last} of the ${steps.length} recorded)` : ''}:`,
        ...script.steps.map((step, index) => `${index + 1}. ${inline(step)}`),
        ...(left.length ? [`Left out: ${leftOutText(left)}.`] : []),
        'Clean it up before you replay it: read it with read_file, then with edit_file drop detours, add expect steps that check the outcome, and write values that change between runs as %NAME%.',
      ].join('\n');
    },
  };
  const replayTool: Tool = {
    name: 'browser_replay',
    description: loadToolPrompt('browser_replay'),
    effect: 'unknown',
    subagents: false,
    // The site the script starts on, read from the file: allowing that site covers the
    // replay, and the replay acts on no other. A script that cannot run fails here, before
    // anyone is asked.
    approvalFacts: (args, sessionId) => {
      const { site, script, from, to } = plan(args, sessionId);
      // The steps that click a control that deletes: in manual mode the replay then asks
      // every time, as such a click does, and the card names them
      const removes = script.steps
        .map((step, index) => ({ step, number: index + 1 }))
        .slice(from - 1, to)
        .flatMap(({ step, number }) =>
          'click' in step && destructive(step.click.name)
            ? [
                `step ${number}: ${step.click.role} ${JSON.stringify(step.click.name)}`,
              ]
            : [],
        )
        .join('; ')
        .slice(0, 300);
      return site || removes
        ? {
            ...(site ? { site } : {}),
            ...(removes ? { deletes: removes } : {}),
          }
        : undefined;
    },
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The script file, as read_file takes it',
        },
        variables: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            "Values for the script's %NAME%, by name; they come before Circle's variables and secrets",
        },
        from: {
          type: 'integer',
          minimum: 1,
          description:
            'The step to start at, from 1; after a failed replay, the step that failed',
        },
        to: {
          type: 'integer',
          minimum: 1,
          description: 'The last step to run',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args, context) {
      const planned = plan(args, context.sessionId, context);
      const allowed = typeof args.site === 'string' ? args.site : '';
      if (planned.site !== allowed)
        throw Error(
          `the script, or the page it starts on, changed since the replay was allowed: it was for ${allowed || 'no site'}, and now starts on ${planned.site || 'no site'}. Call browser_replay again.`,
        );
      return replayScript({
        name: planned.script.name || nameFromPath(planned.path),
        steps: planned.script.steps,
        from: planned.from,
        to: planned.to,
        values: planned.values,
        site: planned.site,
        context,
        perform,
      });
    },
  };
  return [...actions, ...(history ? [record] : []), replayTool];
}
/** The largest script file a replay reads. */
const MAX_SCRIPT = 1024 * 1024;
const full = (path: string) => {
  if (!isAbsolute(path)) throw Error(`give the full path of ${path}`);
  return path;
};

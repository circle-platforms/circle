import vm from 'node:vm';
import { Worker } from 'node:worker_threads';

/** What a workflow script's `meta` says of it. */
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  /** The progress groups, in order: each `phase()` title the script uses. */
  phases: { title: string; detail?: string; model?: string }[];
}
/** A script that cannot run: its words name the line when there is one. */
export class WorkflowScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowScriptError';
  }
}
/** A checked script: its meta, and the code an isolated context evaluates. */
export interface PreparedScript {
  meta: WorkflowMeta;
  source: string;
  filename: string;
  /** The body as an async function called at once, its lines where the source has them. */
  code: string;
}
/** A workflow's name: letters, digits, `_` and `-`, up to 64, starting with a letter or digit. */
export const WORKFLOW_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** How many items one `parallel()` or `pipeline()` call takes. */
export const MAX_FAN_OUT = 4096;

const lineOf = (text: string, at: number): number =>
  text.slice(0, at).split('\n').length;
const isIdentifierStart = (char: string | undefined): boolean =>
  char !== undefined && /[\p{ID_Start}$_\\]/u.test(char);
const isIdentifierPart = (char: string | undefined): boolean =>
  char !== undefined && /[\p{ID_Continue}$\u200c\u200d\\]/u.test(char);

/** Skips spaces, line ends and comments from `at`; the offset of what follows. */
function skipTrivia(text: string, at: number): number {
  for (;;) {
    while (at < text.length && /\s/.test(text[at]!)) at++;
    if (text.startsWith('//', at)) {
      const end = text.indexOf('\n', at);
      at = end < 0 ? text.length : end + 1;
    } else if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      if (end < 0)
        throw new WorkflowScriptError(
          `line ${lineOf(text, at)}: a comment is never closed`,
        );
      at = end + 2;
    } else return at;
  }
}
function readIdentifier(text: string, at: number): string {
  let end = at;
  while (end < text.length && isIdentifierPart(text[end])) end++;
  return text.slice(at, end);
}
/** The text of a quoted string or a template without `${`, with its escapes read. */
function unescape(raw: string): string {
  return raw.replace(
    /\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\r\n|\n|\r|\u2028|\u2029)|([\s\S]))/g,
    (_match, hex, braced, unicode, lineEnd, other: string) => {
      if (hex) return String.fromCharCode(parseInt(hex, 16));
      if (braced) return String.fromCodePoint(parseInt(braced, 16));
      if (unicode) return String.fromCharCode(parseInt(unicode, 16));
      if (lineEnd) return '';
      const named: Record<string, string> = {
        n: '\n',
        t: '\t',
        r: '\r',
        b: '\b',
        f: '\f',
        v: '\v',
        '0': '\0',
      };
      return named[other] ?? other;
    },
  );
}
/** The end of a quoted string or template that starts at `at`, after its closing quote. */
function stringEnd(text: string, at: number): number {
  const quote = text[at]!;
  for (let index = at + 1; index < text.length; index++) {
    const char = text[index]!;
    if (char === '\\') index++;
    else if (char === quote) return index + 1;
    else if (quote !== '`' && (char === '\n' || char === '\r')) break;
  }
  throw new WorkflowScriptError(
    `line ${lineOf(text, at)}: a string is never closed`,
  );
}

/**
 * One literal value of `meta`: an object, an array, a string, a number, a template without `${`,
 * true, false or null. Anything else (a name, a call, a spread, a computed key, a method) is not
 * a literal, and the script is refused with the line it is on.
 */
function parseLiteral(
  text: string,
  start: number,
): { value: unknown; end: number } {
  let at = skipTrivia(text, start);
  const char = text[at];
  const refuse = (what: string): never => {
    throw new WorkflowScriptError(
      `line ${lineOf(text, at)}: meta must be a plain literal, and ${what} is not one`,
    );
  };
  if (char === '{') {
    const value: Record<string, unknown> = {};
    at++;
    for (;;) {
      at = skipTrivia(text, at);
      if (text[at] === '}') return { value, end: at + 1 };
      let key: string;
      const head = text[at];
      if (head === '"' || head === "'") {
        const end = stringEnd(text, at);
        key = unescape(text.slice(at + 1, end - 1));
        at = end;
      } else if (head !== undefined && /[0-9]/.test(head)) {
        const number = parseLiteral(text, at);
        key = String(number.value);
        at = number.end;
      } else if (isIdentifierStart(head) && head !== '\\') {
        key = readIdentifier(text, at);
        at += key.length;
      } else if (text.startsWith('...', at)) return refuse('a spread');
      else if (head === '[') return refuse('a computed key');
      else return refuse(`'${(head ?? 'the end').slice(0, 1)}'`);
      at = skipTrivia(text, at);
      if (text[at] !== ':')
        return refuse(
          text[at] === '('
            ? `the method ${key}()`
            : `the shorthand property ${key}`,
        );
      const item = parseLiteral(text, at + 1);
      if (key === '__proto__') return refuse('a __proto__ key');
      value[key] = item.value;
      at = skipTrivia(text, item.end);
      if (text[at] === ',') at++;
      else if (text[at] !== '}') return refuse(`'${text[at] ?? 'the end'}'`);
    }
  }
  if (char === '[') {
    const value: unknown[] = [];
    at++;
    for (;;) {
      at = skipTrivia(text, at);
      if (text[at] === ']') return { value, end: at + 1 };
      if (text[at] === ',') return refuse('an empty array slot');
      if (text.startsWith('...', at)) return refuse('a spread');
      const item = parseLiteral(text, at);
      value.push(item.value);
      at = skipTrivia(text, item.end);
      if (text[at] === ',') at++;
      else if (text[at] !== ']') return refuse(`'${text[at] ?? 'the end'}'`);
    }
  }
  if (char === '"' || char === "'" || char === '`') {
    const end = stringEnd(text, at);
    const raw = text.slice(at + 1, end - 1);
    if (char === '`' && /(^|[^\\])(\\\\)*\$\{/.test(raw))
      return refuse('a template with ${…}');
    return { value: unescape(raw), end };
  }
  if (
    char === '-' ||
    char === '.' ||
    (char !== undefined && /[0-9]/.test(char))
  ) {
    const match =
      /^-?\s*(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d[\d_]*)?)/.exec(
        text.slice(at),
      );
    if (!match) return refuse('this');
    const number = Number(match[1]!.replaceAll('_', ''));
    if (!Number.isFinite(number)) return refuse('this number');
    return {
      value: match[0].startsWith('-') ? -number : number,
      end: at + match[0].length,
    };
  }
  if (isIdentifierStart(char)) {
    const word = readIdentifier(text, at);
    const known: Record<string, unknown> = {
      true: true,
      false: false,
      null: null,
    };
    if (Object.hasOwn(known, word)) {
      const after = skipTrivia(text, at + word.length);
      if (text[after] === '(' || text[after] === '.')
        return refuse(`the expression starting with ${word}`);
      return { value: known[word], end: at + word.length };
    }
    return refuse(`the name ${word}`);
  }
  return refuse(char === undefined ? 'the end of the file' : `'${char}'`);
}

/** The meta a literal says, or why it says nothing that can be used. */
function readMeta(value: unknown, text: string, at: number): WorkflowMeta {
  const where = `line ${lineOf(text, at)}`;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkflowScriptError(`${where}: meta must be an object`);
  const raw = value as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!WORKFLOW_NAME.test(name))
    throw new WorkflowScriptError(
      `${where}: meta.name must be a name of letters, digits, _ and - (up to 64), such as audit-routes`,
    );
  const description =
    typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description)
    throw new WorkflowScriptError(
      `${where}: meta.description must say in one line what the workflow does`,
    );
  if (raw.phases !== undefined && !Array.isArray(raw.phases))
    throw new WorkflowScriptError(`${where}: meta.phases must be a list`);
  const phases: WorkflowMeta['phases'] = [];
  for (const entry of (raw.phases as unknown[] | undefined) ?? []) {
    const phase =
      typeof entry === 'string'
        ? { title: entry }
        : entry && typeof entry === 'object' && !Array.isArray(entry)
          ? (entry as Record<string, unknown>)
          : undefined;
    const title = typeof phase?.title === 'string' ? phase.title.trim() : '';
    if (!title)
      throw new WorkflowScriptError(
        `${where}: each entry of meta.phases needs a title, the one its phase() call passes`,
      );
    if (phases.some((known) => known.title === title)) continue;
    phases.push({
      title,
      ...(typeof phase!.detail === 'string' && phase!.detail.trim()
        ? { detail: phase!.detail.trim() }
        : {}),
      ...(typeof phase!.model === 'string' && phase!.model.trim()
        ? { model: phase!.model.trim() }
        : {}),
    });
  }
  return {
    name,
    description: description.slice(0, 1024),
    ...(typeof raw.whenToUse === 'string' && raw.whenToUse.trim()
      ? { whenToUse: raw.whenToUse.trim().slice(0, 1024) }
      : {}),
    phases,
  };
}

interface Token {
  type: 'name' | 'punct' | 'literal';
  value: string;
  start: number;
}
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
  'extends',
]);
/**
 * The names and punctuation of a script, with strings, templates, regular expressions and
 * comments passed over (a template's `${…}` is read as code). It tells code from text well
 * enough to find an `import`; the script itself is parsed by the engine that runs it.
 */
function tokens(text: string, from: number): Token[] {
  const found: Token[] = [];
  // `{` of code, or `${` of a template whose text goes on after the matching `}`
  const braces: ('{' | '${')[] = [];
  let at = from;
  const regexAllowed = (): boolean => {
    const last = found.at(-1);
    if (!last) return true;
    if (last.type === 'literal') return false;
    if (last.type === 'name') return REGEX_AFTER_WORDS.has(last.value);
    return ![')', ']', '}'].includes(last.value);
  };
  // The rest of a template from `at`, which is just after its backquote or its `}`
  const templateText = (): void => {
    for (; at < text.length; at++) {
      const char = text[at]!;
      if (char === '\\') at++;
      else if (char === '`') {
        at++;
        found.push({ type: 'literal', value: '`', start: at });
        return;
      } else if (char === '$' && text[at + 1] === '{') {
        at += 2;
        braces.push('${');
        found.push({ type: 'punct', value: '${', start: at });
        return;
      }
    }
  };
  while (at < text.length) {
    at = skipTrivia(text, at);
    if (at >= text.length) break;
    const char = text[at]!;
    if (char === '"' || char === "'") {
      found.push({ type: 'literal', value: char, start: at });
      at = stringEnd(text, at);
    } else if (char === '`') {
      at++;
      templateText();
    } else if (char === '{') {
      braces.push('{');
      found.push({ type: 'punct', value: '{', start: at++ });
    } else if (char === '}') {
      if (braces.pop() === '${') {
        at++;
        templateText();
      } else found.push({ type: 'punct', value: '}', start: at++ });
    } else if (isIdentifierStart(char)) {
      const word = readIdentifier(text, at);
      found.push({ type: 'name', value: word, start: at });
      at += Math.max(1, word.length);
    } else if (
      /[0-9]/.test(char) ||
      (char === '.' && /[0-9]/.test(text[at + 1] ?? ''))
    ) {
      const match = /^[0-9.]*(?:[eE][+-]?)?[0-9a-zA-Z_.]*/.exec(
        text.slice(at),
      )!;
      found.push({ type: 'literal', value: match[0], start: at });
      at += Math.max(1, match[0].length);
    } else if (char === '/' && regexAllowed()) {
      let inClass = false;
      let index = at + 1;
      for (; index < text.length; index++) {
        const next = text[index]!;
        if (next === '\\') index++;
        else if (next === '[') inClass = true;
        else if (next === ']') inClass = false;
        else if (next === '/' && !inClass) break;
        else if (next === '\n') break;
      }
      index++;
      while (index < text.length && isIdentifierPart(text[index])) index++;
      found.push({ type: 'literal', value: '/', start: at });
      at = index;
    } else found.push({ type: 'punct', value: char, start: at++ });
  }
  return found;
}

/**
 * Checks a script and makes it ready to run. It must start with `export const meta = {…}`, a
 * plain literal with a name and a description, and must not import anything. The body is
 * plain JavaScript run as an async function, so it can `await` and `return` at its top level;
 * a syntax error is reported here, before anything runs.
 */
export function prepareWorkflowScript(
  source: string,
  filename = 'workflow.js',
): PreparedScript {
  try {
    return prepare(source, filename);
  } catch (error) {
    // What the reader found is told by the file and its line, as an engine would tell it
    if (error instanceof WorkflowScriptError)
      throw new WorkflowScriptError(
        error.message.replace(/^line (\d+): /, `${filename}:$1: `),
      );
    throw error;
  }
}
function prepare(source: string, filename: string): PreparedScript {
  // A first line `#!…` is read as a comment, which keeps the lines where they are
  const text = source.replace(/^\ufeff/, '').replace(/^#!/, '//');
  let at = skipTrivia(text, 0);
  const exportAt = at;
  const expect = (word: string): void => {
    at = skipTrivia(text, at);
    const found = isIdentifierStart(text[at])
      ? readIdentifier(text, at)
      : (text[at] ?? '');
    if (found !== word)
      throw new WorkflowScriptError(
        `${filename}: a workflow script begins with export const meta = { name: '…', description: '…' }`,
      );
    at += word.length;
  };
  expect('export');
  expect('const');
  expect('meta');
  expect('=');
  const literal = parseLiteral(text, at);
  const meta = readMeta(literal.value, text, at);
  at = skipTrivia(text, literal.end);
  if (text[at] === ';') at++;
  const body = tokens(text, at);
  for (const [index, token] of body.entries()) {
    if (token.type !== 'name' || token.value !== 'import') continue;
    const before = body[index - 1];
    const after = body[index + 1];
    // A property or key named import is not an import
    if (
      before?.value === '.' ||
      (after?.value === ':' && before?.value !== '?')
    )
      continue;
    throw new WorkflowScriptError(
      `${filename}:${lineOf(text, token.start)}: a workflow script cannot import; put work that needs a library in an agent's task`,
    );
  }
  // `export` becomes spaces and the wrapper shares the first line: lines stay where they are
  const code =
    "(async function () { 'use strict'; " +
    text.slice(0, exportAt) +
    ' '.repeat('export'.length) +
    text.slice(exportAt + 'export'.length) +
    '\n})()';
  try {
    new vm.Script(code, { filename });
  } catch (error) {
    const stack = error instanceof Error ? String(error.stack ?? '') : '';
    const line = new RegExp(
      `^${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`,
    ).exec(stack)?.[1];
    throw new WorkflowScriptError(
      `${filename}${line ? `:${line}` : ''}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { meta, source: text, filename, code };
}

/** What a running script tells the runtime, as it happens. */
export interface ScriptHost {
  /**
   * An `agent()` call: `spec` is `{ prompt, options }` as JSON; answer it with `settle(id, …)`. An `execute()`
   * call comes the same way, its `spec` being `{ command, options }`.
   */
  agent(id: number, spec: string): void;
  phase(title: string): void;
  log(message: string): void;
  /** The script returned: its value as JSON, or undefined for none. */
  done(json: string | undefined): void;
  /** The script threw, ran too long without waiting for an agent, or its worker ended. */
  failed(message: string): void;
  /** The script waits again: everything it asked since the last message it was sent has arrived. */
  idle(): void;
}
/** The most memory a script's heap may take. */
export const SCRIPT_MEMORY_MB = 256;

// Runs inside the script's context, from its own realm: the script reaches the runtime only
// through `host`, which it never sees, and gets back only strings and values made here.
const BOOTSTRAP = String.raw`(function (host, argsJson, fanOut, fileName) {
  'use strict';
  const G = globalThis;
  const call = host;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const blocked = (what, instead) => {
    throw new Error(what + ' is not available in a workflow, so that a relaunched run repeats the same agent() calls: ' + instead);
  };
  const RealDate = Date;
  const SafeDate = function Date(...values) {
    if (!new.target) blocked('Date()', 'pass a timestamp in through args');
    if (values.length === 0) blocked('new Date() without an argument', 'pass a timestamp in through args');
    return Reflect.construct(RealDate, values, new.target);
  };
  SafeDate.prototype = RealDate.prototype;
  Object.defineProperty(RealDate.prototype, 'constructor', { value: SafeDate, writable: true, configurable: true });
  SafeDate.UTC = RealDate.UTC;
  SafeDate.parse = RealDate.parse;
  SafeDate.now = function now() { blocked('Date.now()', 'pass a timestamp in through args'); };
  G.Date = SafeDate;
  Math.random = function random() { blocked('Math.random()', 'vary each prompt or label by its index instead'); };
  const formats = Intl.DateTimeFormat.prototype;
  const format = Object.getOwnPropertyDescriptor(formats, 'format');
  Object.defineProperty(formats, 'format', {
    configurable: true,
    get() {
      const bound = format.get.call(this);
      return (date) => {
        if (date === undefined) blocked('formatting the current time', 'pass a timestamp in through args');
        return bound(date);
      };
    },
  });
  const toParts = formats.formatToParts;
  formats.formatToParts = function formatToParts(date) {
    if (date === undefined) blocked('formatting the current time', 'pass a timestamp in through args');
    return toParts.call(this, date);
  };
  if (typeof G.Temporal === 'object') delete G.Temporal;
  for (const name of ['WebAssembly', 'SharedArrayBuffer', 'Atomics', 'WeakRef', 'FinalizationRegistry'])
    delete G[name];
  const text = (value) => {
    if (typeof value === 'string') return value;
    try { const json = stringify(value); if (json !== undefined) return json; } catch {}
    return String(value);
  };
  function agent(prompt, options) {
    if (typeof prompt !== 'string' || !prompt.trim())
      return Promise.reject(new TypeError('agent() takes the prompt as its first argument, a string'));
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
      return Promise.reject(new TypeError('agent() takes its options as an object'));
    let spec;
    try { spec = stringify({ prompt, options: options === undefined ? {} : options }); }
    catch (error) { return Promise.reject(new TypeError('agent() options must be plain data: ' + error.message)); }
    return new Promise((resolve, reject) => {
      call('agent', spec,
        (json) => resolve(json === undefined ? null : parse(json)),
        (message) => reject(new Error(message)));
    });
  }
  function execute(command, options) {
    if (typeof command !== 'string' || !command.trim())
      return Promise.reject(new TypeError('execute() takes the command as its first argument, a string'));
    if (options !== undefined && (options === null || typeof options !== 'object' || Array.isArray(options)))
      return Promise.reject(new TypeError('execute() takes its options as an object'));
    let spec;
    try { spec = stringify({ command, options: options === undefined ? {} : options }); }
    catch (error) { return Promise.reject(new TypeError('execute() options must be plain data: ' + error.message)); }
    return new Promise((resolve, reject) => {
      call('agent', spec,
        (json) => resolve(json === undefined ? null : parse(json)),
        (message) => reject(new Error(message)));
    });
  }
  function parallel(tasks) {
    if (!Array.isArray(tasks))
      return Promise.reject(new TypeError('parallel() takes a list of functions, each starting one task'));
    if (tasks.length > fanOut)
      return Promise.reject(new RangeError('parallel() takes at most ' + fanOut + ' tasks; this call has ' + tasks.length));
    return Promise.all(tasks.map((task) => {
      try {
        return Promise.resolve(typeof task === 'function' ? task() : task).then((value) => value, () => null);
      } catch {
        return null;
      }
    }));
  }
  function pipeline(items, ...stages) {
    if (!Array.isArray(items))
      return Promise.reject(new TypeError('pipeline() takes a list of items, then one function per stage'));
    if (items.length > fanOut)
      return Promise.reject(new RangeError('pipeline() takes at most ' + fanOut + ' items; this call has ' + items.length));
    if (!stages.length || stages.some((stage) => typeof stage !== 'function'))
      return Promise.reject(new TypeError('pipeline() takes a list of items, then one function per stage'));
    return Promise.all(items.map(async (item, index) => {
      let value = item;
      for (const stage of stages) {
        try {
          value = await stage(value, item, index);
        } catch {
          return null;
        }
      }
      return value;
    }));
  }
  function phase(title) {
    call('phase', String(title));
  }
  function log(message) {
    call('log', text(message));
  }
  function workflow() {
    return Promise.reject(new Error('workflow() is not available in Circle yet: run the other workflow as a step of its own'));
  }
  const api = { agent, execute, parallel, pipeline, phase, log, workflow };
  for (const [name, value] of Object.entries(api))
    Object.defineProperty(G, name, { value, writable: true, configurable: true });
  G.budget = Object.freeze({
    total: null,
    spent: () => Number(call('spent')) || 0,
    remaining: () => Infinity,
  });
  G.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });
  G.args = argsJson === undefined ? undefined : parse(argsJson);
  return function watch(promise) {
    Promise.resolve(promise).then(
      (value) => {
        let json;
        try { json = value === undefined ? undefined : stringify(value); }
        catch (error) { call('error', 'the workflow returned a value that cannot be written as JSON: ' + error.message); return; }
        call('done', json);
      },
      (error) => {
        const message = error instanceof Error ? error.message : text(error);
        const line = error instanceof Error && typeof error.stack === 'string'
          ? (error.stack.split('\n').find((frame) => frame.includes(fileName)) || '').trim()
          : '';
        call('error', message + (line ? ' (' + line.replace(/^at\s+/, '') + ')' : ''));
      },
    );
  };
})`;

// The worker a script runs in. It makes the context, runs the script, and passes messages: the script's
// calls out, the runtime's answers in. After each message it says when the script waits again.
const WORKER = String.raw`'use strict';
const vm = require('node:vm');
const { parentPort } = require('node:worker_threads');
// A promise the script let go of and that failed, such as an agent() it never awaited, is not the run's end
process.on('unhandledRejection', () => {});
const BOOTSTRAP = ${JSON.stringify(BOOTSTRAP)};
let ended = false;
let spent = 0;
let next = 0;
const waiting = new Map();
const post = (message) => {
  if (!ended) parentPort.postMessage(message);
};
const bridge = (kind, first, second, third) => {
  try {
    if (kind === 'agent') {
      if (typeof first !== 'string' || typeof second !== 'function' || typeof third !== 'function') return undefined;
      const id = next++;
      waiting.set(id, { resolve: second, reject: third });
      post({ type: 'agent', id, spec: first });
    } else if (kind === 'phase') post({ type: 'phase', title: String(first) });
    else if (kind === 'log') post({ type: 'log', message: String(first) });
    else if (kind === 'spent') return spent;
    else if (kind === 'done') {
      post({ type: 'done', json: typeof first === 'string' ? first : undefined });
      ended = true;
    } else if (kind === 'error') {
      post({ type: 'failed', message: String(first) });
      ended = true;
    }
  } catch {}
  return undefined;
};
parentPort.on('message', (message) => {
  try {
    if (typeof message.spent === 'number') spent = message.spent;
    if (message.type === 'start') {
      const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, {
        name: message.name,
        codeGeneration: { strings: false, wasm: false },
      });
      const install = vm.runInContext(BOOTSTRAP, context);
      const watch = install(bridge, message.args, message.fanOut, message.filename);
      watch(new vm.Script(message.code, { filename: message.filename }).runInContext(context));
    } else if (message.type === 'settle') {
      const target = waiting.get(message.id);
      waiting.delete(message.id);
      if (target) {
        if (typeof message.json === 'string') target.resolve(message.json);
        else target.reject(String(message.error));
      }
    }
  } catch (error) {
    post({ type: 'failed', message: error && error.message ? error.message : String(error) });
    ended = true;
  }
  // What this message set going runs as microtasks first; then the script waits again
  setImmediate(() => parentPort.postMessage({ type: 'idle' }));
});`;

/**
 * One script running in a worker thread of its own, inside a node:vm context made without any of Node's
 * objects: no require, process, fs, timers or network, no code from strings, and no clock or randomness.
 * Values cross as JSON text in both directions, so nothing of the runtime is reachable from the script. The
 * worker has its own heap, of at most `memoryMb`; a stretch of script that runs on for `sliceMs` without
 * waiting for an agent ends the worker, as does running out of memory.
 */
export class ScriptWorker {
  private worker?: Worker;
  /** Messages sent that the worker has not finished with. */
  private outstanding = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private ended = false;
  constructor(
    private readonly prepared: PreparedScript,
    private readonly host: ScriptHost,
    private readonly options: {
      args?: unknown;
      sliceMs: number;
      memoryMb?: number;
    },
  ) {}
  /** Starts the script; what it asks for arrives through the host. */
  start(): void {
    let worker: Worker;
    try {
      worker = new Worker(WORKER, {
        eval: true,
        execArgv: [],
        env: {},
        stdout: true,
        stderr: true,
        name: `workflow ${this.prepared.meta.name}`,
        resourceLimits: {
          maxOldGenerationSizeMb: this.options.memoryMb ?? SCRIPT_MEMORY_MB,
        },
      });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.worker = worker;
    worker.on('message', (message: Record<string, unknown>) =>
      this.received(message),
    );
    worker.on('error', (error: Error) =>
      this.fail(
        /memory limit/i.test(error.message)
          ? `the script used more than ${this.options.memoryMb ?? SCRIPT_MEMORY_MB} MB of memory, so it was stopped`
          : error.message,
      ),
    );
    worker.on('exit', (code) => {
      if (!this.ended) this.fail(`the script's worker ended with code ${code}`);
    });
    this.send({
      type: 'start',
      code: this.prepared.code,
      filename: this.prepared.filename,
      name: `workflow ${this.prepared.meta.name}`,
      args:
        this.options.args === undefined
          ? undefined
          : JSON.stringify(this.options.args),
      fanOut: MAX_FAN_OUT,
    });
  }
  /** Answers an `agent()` call: its value as JSON, or the error it rejects with. */
  settle(
    id: number,
    outcome: { json: string } | { error: string },
    spent: number,
  ): void {
    this.send({ type: 'settle', id, ...outcome, spent });
  }
  /** Whether the script is running now, not waiting for an agent. */
  get running(): boolean {
    return !this.ended && this.outstanding > 0;
  }
  /** Ends the worker: what the script would still do is dropped. */
  end(): void {
    this.ended = true;
    this.outstanding = 0;
    if (this.timer) clearTimeout(this.timer);
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate().catch(() => {});
  }
  private send(message: Record<string, unknown>): void {
    if (this.ended || !this.worker) return;
    this.outstanding++;
    this.arm();
    this.worker.postMessage(message);
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    const armed = Date.now();
    this.timer = setTimeout(() => {
      // Late because this thread was busy: the answer may be waiting behind it, so look once more
      if (Date.now() - armed > this.options.sliceMs + 1000) return this.arm();
      this.fail(
        `the script ran for more than ${
          this.options.sliceMs >= 1000
            ? `${Math.round(this.options.sliceMs / 1000)}s`
            : `${this.options.sliceMs}ms`
        } without waiting for an agent, so it was stopped`,
      );
    }, this.options.sliceMs);
    this.timer.unref?.();
  }
  private received(message: Record<string, unknown>): void {
    if (this.ended) return;
    if (message.type === 'agent')
      this.host.agent(Number(message.id), String(message.spec));
    else if (message.type === 'phase') this.host.phase(String(message.title));
    else if (message.type === 'log') this.host.log(String(message.message));
    else if (message.type === 'done')
      this.host.done(
        typeof message.json === 'string' ? message.json : undefined,
      );
    else if (message.type === 'failed')
      this.host.failed(String(message.message));
    else if (message.type === 'idle') {
      this.outstanding = Math.max(0, this.outstanding - 1);
      if (this.outstanding > 0) this.arm();
      else {
        if (this.timer) clearTimeout(this.timer);
        this.host.idle();
      }
    }
  }
  private fail(message: string): void {
    if (this.ended) return;
    this.end();
    this.host.failed(message);
  }
}

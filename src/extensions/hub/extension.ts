// The hub connector. It ships with Circle and is off until `/extensions enable
// hub`. It signs in to a server, hands it work with your files, follows the work
// while it runs and saves what the server delivers. The task lives on the server: closing
// Circle does not stop it, and `/hub task <id>` picks it up where this window left off.
//
// This file is loaded as written (Node strips the types), so it uses only syntax that
// type stripping accepts. The interface words live in the compiled module beside the
// program (`hub_text.js`); that module has no interface of its own.
import { createHash, randomUUID } from 'node:crypto';
import { hubText } from '../../hub_text.js';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type {
  CommandContext,
  ExtensionAPI,
  ToolMiddleware,
} from '../../extensions.js';

interface Config {
  url: string;
  username: string;
  scopeId?: string;
  /** Who the server said you are when you signed in; a bot runs as its owner. */
  principalId?: string;
  /** When the server said the current token runs out. */
  expiresAt?: string;
}
interface ServerEvent {
  seq: number;
  taskId: string;
  kind: string;
  payload: Record<string, unknown>;
}
interface Artifact {
  artifactId: string;
  fileName?: string;
  sha256: string;
  size?: number;
  downloadPath?: string;
}
// An asset as the server lists it; a bot and its trigger are assets with a lifecycle.
interface Asset {
  assetId: string;
  kind: string;
  name: string;
  version: string;
  sha256: string;
  lifecycle: string;
  ownerPrincipalId: string;
  configuration: Record<string, unknown>;
}
// One occurrence of a bot's trigger. Admitted, it has the task it started and is published
// once its output went to the bot's channel; failed, the server started no task and says why.
interface BotRun {
  /** The task it started; '' when the occurrence was not admitted. */
  taskId: string;
  occurrenceKey: string;
  channel: string;
  published: boolean;
  status: string;
  trigger: Record<string, unknown>;
  error: string;
}
// A run is known by its task, or by bot and occurrence when it has none.
const runKey = (botId: string, run: BotRun): string =>
  run.taskId || `${botId}:${run.occurrenceKey}`;
// What this window remembers of a task it handed over: the last event it has shown.
interface Followed {
  title: string;
  seq: number;
  /** Its results were saved here once. */
  saved?: boolean;
}
class ServerError extends Error {
  status = 0;
  code = '';
  details: Record<string, unknown> = {};
}
// What a refusal names besides its message (the rows, tools or limits it is about), kept
// short so a model reads it beside the code instead of a whole response.
const MAX_DETAIL_CHARS = 2000;

// A task in one of these phases changes no more; `unknown` waits for someone to check.
const TERMINAL = new Set(['delivered', 'failed', 'cancelled', 'unknown']);
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
// The file extension a saved record's media type suggests; anything else is .bin.
const EXTENSIONS: Record<string, string> = {
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/xml': 'xml',
  'application/xml': 'xml',
};
const DEFAULT_HUB_URL = 'http://127.0.0.1:7410';
// Commands share one description column, including the shorter reconcile line.
function usage(rows: [string, string][]): string {
  const width = Math.max(...rows.map(([command]) => command.length)) + 2;
  return rows
    .map(([command, description]) => command.padEnd(width) + description)
    .join('\n');
}
// Built when the line is shown, so a Chinese locale translates the descriptions
// and an English one keeps the words the tests match.
function usageText(): string {
  return usage([
    ['/hub', hubText('where you are signed in')],
    ['/hub help', hubText('every command')],
    [
      '/hub login [url] <user>',
      hubText(
        'sign in; the password is asked on a masked card unless this window already has it',
      ),
    ],
    ['/hub logout', hubText('revoke the token at the server, then forget it')],
    ['/hub packs', hubText('what the server can do')],
    [
      '/hub submit <pack> <file>',
      hubText(
        'hand it work with this file, follow it, save the results (module-execute takes the flow input JSON instead of a file)',
      ),
    ],
    [
      '/hub tasks',
      hubText(
        'tasks this window handed over, each with its phase. "seen to N" is the last event number shown for that task, not how many tasks /hub refresh counted',
      ),
    ],
    ['/hub task <id>', hubText('show a task and follow it until it ends')],
    [
      '/hub respond <id> <answer>',
      hubText('answer what a task is waiting on (text, key=value or JSON)'),
    ],
    ['/hub get <id>', hubText('save a delivered task’s results again')],
    [
      '/hub refresh',
      hubText(
        'how many work tasks the pages just read (at most 20; tool and index tasks are not in that number) and how many capability packs. Not the /hub tasks list',
      ),
    ],
    [
      '/hub approve <id> <approval>',
      hubText('approve an action a task waits on (reject: /hub reject …)'),
    ],
    [
      '/hub review',
      hubText('open approvals you may decide, each with its /hub approve line'),
    ],
    [
      '/hub audit',
      hubText(
        'recent audit rows (needs admin.manage; there is no browser page)',
      ),
    ],
    [
      '/hub modules',
      hubText(
        'skill packs and module assets the server lists (no browser page)',
      ),
    ],
    [
      '/hub reconcile <id> [op]',
      hubText(
        'check an unknown operation; without op the server only explains',
      ),
    ],
    ['/hub tools', hubText('the server’s tools the model can use, read again')],
    [
      '/hub trial start',
      hubText(
        'record server tool calls from now. A non-empty record that was not pushed stays until /hub trial start --force',
      ),
    ],
    [
      '/hub skill push <folder>',
      hubText(
        'submit a skill pack. skillpack.json outputs are required; the trial call record may be empty. --outputs a,b names trial files and defaults to that list',
      ),
    ],
    ['/hub skill list', hubText('the skill packs on the server')],
    [
      '/hub skill run <id> [json]',
      hubText(
        'run a skill pack on the server and follow it (--file <path> attaches)',
      ),
    ],
    [
      '/hub bot list',
      hubText('the bots you can see; yours with their runs and new results'),
    ],
    [
      '/hub bot every <pack> <1h>',
      hubText(
        'a bot that runs a skill pack on a schedule (--from, --inputs, --file, --name)',
      ),
    ],
    [
      '/hub bot on <pack> <source> <event>',
      hubText(
        'a bot that runs a skill pack when a connector reports the event',
      ),
    ],
    [
      '/hub bot approve <bot>',
      hubText('approve someone else’s bot and its trigger'),
    ],
    ['/hub bot start|stop <bot>', hubText('turn your approved bot on or off')],
    [
      '/hub bot runs <bot>',
      hubText('its runs and what each delivered to Circle'),
    ],
  ]);
}

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
// Keys in a fixed order, so the same arguments always hash the same.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}
const MAX_PACK_FILES = 200;
const MAX_PACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PACK_BYTES = 10 * 1024 * 1024;
const short = (hash: unknown): string =>
  typeof hash === 'string' ? hash.slice(0, 12) + '…' : '';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
// A list route answers with an array, or with { items } when asked for a page.
function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  if (isRecord(data) && Array.isArray(data.items))
    return data.items.filter(isRecord);
  return [];
}
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
// A refusal the server named, said so a person can act on it. A usage line has no code
// and is already the whole explanation.
function explainFailure(error: unknown): string {
  if (!(error instanceof ServerError) || !error.code) return reason(error);
  const issues = Array.isArray(error.details.issues)
    ? error.details.issues.filter(isRecord).slice(0, 6)
    : [];
  const detail = issues
    .map((issue) => {
      const path = Array.isArray(issue.path)
        ? issue.path.map(String).join('.')
        : '';
      const message = String(issue.message ?? issue.code ?? hubText('invalid'));
      return path ? `${path}: ${message}` : message;
    })
    .join('; ');
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return hubText(
        'sign-in was refused ({code}). Check the user and password, then /hub login again.',
        { code: error.code },
      );
    case 'FORBIDDEN_SCOPE':
    case 'FORBIDDEN_ACTION':
    case 'SOURCE_FORBIDDEN':
      return hubText(
        'the server refused this ({code}): {detail}. Sign in to a scope that may do it, or ask someone who can.',
        {
          code: error.code,
          detail: error.message.replace(/^[^:]+:\s*/, ''),
        },
      );
    case 'TARGET_NOT_FOUND':
      return hubText('not found ({code}). Check the id and try again.', {
        code: error.code,
      });
    case 'INVALID_PAYLOAD':
      return /outputs/i.test(detail)
        ? hubText(
            'the hub refused the payload ({code}). {detail}. skillpack.json needs outputs (at least one file). --outputs only names the trial files and defaults to that list.',
            { code: error.code, detail },
          )
        : hubText('the hub refused the payload ({code}). {detail}', {
            code: error.code,
            detail: detail || hubText('Check the fields the command sent.'),
          });
    case 'SKILLPACK_CHECK_FAILED':
      return hubText(
        '{message}. Fix skillpack.json so it declares every tool the trial used, then /hub trial start --force and push again.',
        { message: error.message },
      );
    case 'SOURCE_HASH_MISMATCH':
      return hubText(
        'the file changed while it was sent ({code}). Send it again.',
        { code: error.code },
      );
    case 'BODY_TOO_LARGE':
      return hubText(
        'that is larger than the server accepts ({code}). Send a smaller file.',
        { code: error.code },
      );
    case 'DECISION_CONFLICT': {
      // The code alone does not say which request collided. The server's outcome does:
      // a text answer sent where an approval is open, or a decision already recorded.
      const outcome = String(error.details.outcome ?? '');
      const said = error.message
        .replace(/^[A-Z0-9_]+:\s*/, '')
        .replace(/\s·\s\{[\s\S]*$/, '');
      const named = outcome || said || hubText('the request no longer matches');
      if (
        outcome === 'missing-request' ||
        /missing-request|not waiting/i.test(said)
      )
        return hubText(
          'nothing is waiting for that answer ({code}: {named}). {said}. An open approval is decided with /hub approve <task> <approval>, and /hub review lists those. /hub task <id> shows the phase.',
          { code: error.code, named, said },
        );
      if (
        outcome === 'already-answered' ||
        outcome === 'already-decided' ||
        /already-/.test(outcome) ||
        /already-|frozen/i.test(said)
      )
        return hubText(
          'that request already has a decision ({code}: {named}). {said}. /hub task <id> shows the phase. Wait for a new question before /hub respond, or /hub review for what is still open.',
          { code: error.code, named, said },
        );
      return hubText(
        'the server refused this decision ({code}: {named}). {said}. /hub task <id> shows the phase; /hub review lists open approvals.',
        { code: error.code, named, said },
      );
    }
    default:
      return error.message;
  }
}

// Words split on spaces, with "…" or '…' kept together. Only a word that is all one quoted
// part loses its quotes, so {"a": "b c"} keeps the quotes JSON needs.
function words(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:"[^"]*"|'[^']*'|[^\s"']+|["'])+/g)) {
    const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(match[0]);
    found.push(quoted ? (quoted[1] ?? quoted[2] ?? '') : match[0]);
  }
  return found;
}
// An answer as the server takes it: a JSON object, key=value pairs, or plain text.
function answerOf(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch {
    /* Not JSON. */
  }
  const pairs = words(text).map((word) => /^([\w.-]+)=(.*)$/.exec(word));
  if (pairs.length && pairs.every(Boolean))
    return Object.fromEntries(pairs.map((pair) => [pair![1], pair![2]]));
  return { answer: text };
}

// The host's limit covers the complete JSON view, not just its object lists.
// Keep small views byte-for-byte equivalent. Large views select rows fairly
// across lists, retain every object page, and disclose what is not displayed.
export function projectHubView(
  view: Record<string, unknown>,
  byteLimit = 65536,
): Record<string, unknown> {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const originalBytes = bytes(view);
  if (originalBytes <= byteLimit) return view;
  const counts = (
    value: unknown,
    path = '',
    result: Record<string, number> = {},
  ) => {
    if (Array.isArray(value)) {
      result[path] = (result[path] ?? 0) + value.length;
      for (const item of value) counts(item, `${path}[]`, result);
    } else if (isRecord(value))
      for (const [key, item] of Object.entries(value))
        counts(item, path ? `${path}.${key}` : key, result);
    return result;
  };
  type Queue = {
    source: unknown[];
    selected: unknown[];
    path: string;
    next: number;
  };
  // Identity pins and actions are never rewritten to fit. An oversized action
  // is omitted whole; its omission is counted alongside its parent list.
  const identity =
    /(?:Id|Sha256|Version)$|^(?:sha256|targetIdentity|action|version|url|username)$/;
  function build(
    value: unknown,
    path: string,
    key = '',
  ): {
    value: unknown;
    queues: Queue[];
    shortened: number;
  } {
    if (identity.test(key)) return { value, queues: [], shortened: 0 };
    if (Array.isArray(value)) {
      const selected: unknown[] = [];
      return {
        value: selected,
        queues: [{ source: value, selected, path, next: 0 }],
        shortened: 0,
      };
    }
    if (isRecord(value)) {
      const result: Record<string, unknown> = {},
        queues: Queue[] = [];
      let shortened = 0;
      for (const [name, item] of Object.entries(value)) {
        const made = build(item, path ? `${path}.${name}` : name, name);
        result[name] = made.value;
        queues.push(...made.queues);
        shortened += made.shortened;
      }
      return { value: result, queues, shortened };
    }
    if (typeof value === 'string' && Buffer.byteLength(value) > 1024) {
      let selected = '',
        size = 0;
      for (const character of value) {
        const next = Buffer.byteLength(character);
        if (size + next > 1021) break;
        selected += character;
        size += next;
      }
      return { value: selected + '…', queues: [], shortened: 1 };
    }
    return { value, queues: [], shortened: 0 };
  }
  const totals = counts(view),
    made = build(view, ''),
    result = made.value as Record<string, unknown>,
    queues = made.queues;
  const projection = {
    byteLimit,
    originalBytes,
    viewBytes: byteLimit,
    shownItems: 0,
    omittedItems: Object.values(totals).reduce((sum, n) => sum + n, 0),
    shortenedFields: made.shortened,
    collections: Object.fromEntries(
      Object.entries(totals).map(([path, total]) => [
        path,
        { shown: 0, total, omitted: total },
      ]),
    ),
  };
  result.projection = projection;
  let size = bytes(result),
    projectionBytes = bytes(projection);
  if (size > byteLimit)
    throw new Error('hub view metadata exceeds its byte budget');
  while (queues.some((queue) => queue.next < queue.source.length)) {
    // New child lists join the next round, so one task's large history cannot
    // consume the budget before methods or the other object pages get a row.
    const round = queues.length;
    for (let index = 0; index < round; index++) {
      const queue = queues[index]!;
      if (queue.next >= queue.source.length) continue;
      const candidate = build(queue.source[queue.next++], `${queue.path}[]`);
      const additions = counts(candidate.value, `${queue.path}[]`);
      additions[queue.path] = (additions[queue.path] ?? 0) + 1;
      const addedItems = Object.values(additions).reduce(
        (sum, n) => sum + n,
        0,
      );
      for (const [path, n] of Object.entries(additions)) {
        const held = projection.collections[path]!;
        held.shown += n;
        held.omitted -= n;
      }
      projection.shownItems += addedItems;
      projection.omittedItems -= addedItems;
      projection.shortenedFields += candidate.shortened;
      const nextProjectionBytes = bytes(projection),
        increment = bytes(candidate.value) + (queue.selected.length ? 1 : 0),
        nextSize = size + increment + nextProjectionBytes - projectionBytes;
      if (nextSize <= byteLimit) {
        queue.selected.push(candidate.value);
        queues.push(...candidate.queues);
        size = nextSize;
        projectionBytes = nextProjectionBytes;
      } else {
        for (const [path, n] of Object.entries(additions)) {
          const held = projection.collections[path]!;
          held.shown -= n;
          held.omitted += n;
        }
        projection.shownItems -= addedItems;
        projection.omittedItems += addedItems;
        projection.shortenedFields -= candidate.shortened;
      }
    }
  }
  projection.viewBytes = size;
  for (
    let actual = bytes(result);
    actual !== projection.viewBytes;
    actual = bytes(result)
  )
    projection.viewBytes = actual;
  return result;
}

export async function register(api: ExtensionAPI): Promise<void> {
  const following = new Map<string, AbortController>();
  let failure = '';

  const file = (name: string): string => join(api.dataDir, name);
  function readJson(name: string): unknown {
    try {
      return JSON.parse(readFileSync(file(name), 'utf8'));
    } catch {
      return undefined;
    }
  }
  function writeJson(name: string, value: unknown): void {
    writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n', {
      mode: 0o600,
    });
  }
  // A program that runs Circle on a server's behalf (hub's own runner) hands over
  // the address and a short-lived token in the environment. Nothing is written to disk then,
  // and a token the server turns down is not asked for again.
  const runUrl = process.env.CIRCLE_HUB_URL?.trim() ?? '';
  const runToken = process.env.CIRCLE_HUB_TOKEN?.trim() ?? '';
  const fromRun = Boolean(runUrl && runToken);
  async function currentToken(): Promise<string | null | undefined> {
    return fromRun ? runToken : api.secrets.get('token');
  }
  function readConfig(): Config | undefined {
    if (fromRun)
      return {
        url: runUrl,
        username: process.env.CIRCLE_HUB_USER?.trim() ?? '',
        scopeId: process.env.CIRCLE_HUB_SCOPE?.trim() || undefined,
      };
    const value = readJson('config.json');
    if (
      isRecord(value) &&
      typeof value.url === 'string' &&
      typeof value.username === 'string'
    )
      return {
        url: value.url,
        username: value.username,
        scopeId: typeof value.scopeId === 'string' ? value.scopeId : undefined,
        principalId:
          typeof value.principalId === 'string' ? value.principalId : undefined,
        expiresAt:
          typeof value.expiresAt === 'string' ? value.expiresAt : undefined,
      };
    // An address given in settings.json under extensions.hub.url.
    const url = api.settings.url;
    return typeof url === 'string' && url.trim()
      ? { url: url.trim(), username: '' }
      : undefined;
  }
  // The address to offer before anyone has signed in. Not written until they do.
  function knownUrl(): string {
    return readConfig()?.url || DEFAULT_HUB_URL;
  }
  // Remember the address for the next sign-in, in this extension's files and in
  // settings.json. A run token never writes either.
  function rememberAddress(url: string, username: string): void {
    if (fromRun) return;
    const current = readConfig();
    writeJson('config.json', {
      ...current,
      url,
      username: username || current?.username || '',
    });
    api.saveSettings({ url });
  }
  function followed(): Record<string, Followed> {
    const value = readJson('tasks.json');
    return isRecord(value) ? (value as Record<string, Followed>) : {};
  }
  function remember(taskId: string, change: Partial<Followed>): void {
    const all = followed();
    all[taskId] = { title: '', seq: 0, ...all[taskId], ...change };
    writeJson('tasks.json', all);
  }

  // What a paired page of the desktop application shows (api.setView): where you are
  // signed in, the tasks handed over from here and the last lines this extension wrote.
  const recent: string[] = [];
  // Runs of your bots the server has published to Circle, or could not start, that this
  // window has not shown yet; and whether the last look found the token expired.
  let botNews: { bot: Asset; run: BotRun }[] = [];
  let expired = false;
  // The four platform objects as the server last reported them (/hub refresh). Reads of
  // them overlap (a refresh, a decision, a followed task ending) and are numbered as they
  // start, so one that started earlier and finished later does not replace a newer one.
  let objects: Record<string, unknown> | undefined;
  let objectsStarted = 0;
  let objectsShown = 0;
  function publishView(signedIn: boolean): void {
    const config = readConfig();
    const view = {
      url: config?.url || (fromRun ? '' : DEFAULT_HUB_URL),
      username: config?.username ?? '',
      scopeId: config?.scopeId ?? '',
      signedIn,
      following: [...following.keys()],
      tasks: Object.entries(followed())
        .slice(-20)
        .map(([taskId, item]) => ({ taskId, ...item })),
      recent: recent.slice(-30),
      objects,
      botResults: botNews.map(({ bot, run }) => ({
        botAssetId: bot.assetId,
        name: bot.name,
        taskId: run.taskId,
        occurrenceKey: run.occurrenceKey,
      })),
    };
    api.setView(projectHubView(view));
  }
  async function optional<T>(path: string, fallback: T): Promise<T> {
    try {
      const { data } = await request('GET', path);
      return (data ?? fallback) as T;
    } catch {
      return fallback;
    }
  }
  const pick = (value: unknown, keys: string[]): Record<string, unknown> =>
    isRecord(value)
      ? Object.fromEntries(
          keys.filter((key) => key in value).map((key) => [key, value[key]]),
        )
      : {};
  // C: work with its open questions and approvals; D: its operations; B: its source,
  // artifacts, evidence and the server's own check; E: the capability packs. Read from the
  // server for the most recent tasks you may read; the server decides what you may see.
  async function collectObjects(): Promise<{ tasks: number; packs: number }> {
    const run = ++objectsStarted;
    // Each server tool call, and the knowledge indexing of what it read, is a task of its
    // own: the server lists them apart (kind=tool, kind=index) and they are counted here
    // rather than listed among the work. A server without that filter sends every task, so
    // the capability pack decides as well.
    const listed = async (kind: string, limit: number) => {
      const value = await optional<unknown>(
        `/v1/tasks?kind=${kind}&limit=${limit}`,
        [],
      );
      return (Array.isArray(value) ? value : []).filter(isRecord);
    };
    const internal = ['asset-tool', 'asset-index'];
    const toolReads = (await listed('tool', 100)).filter(
      (task) => task.capabilityPackId === 'asset-tool',
    );
    const indexing = (await listed('index', 100)).filter(
      (task) => task.capabilityPackId === 'asset-index',
    );
    const background = {
      toolReads: toolReads.length,
      indexing: indexing.length,
      indexingOpen: indexing.filter((task) => !TERMINAL.has(String(task.phase)))
        .length,
    };
    let tasks = (await listed('work', 20)).filter(
      (task) => !internal.includes(String(task.capabilityPackId)),
    );
    if (!tasks.length)
      for (const taskId of Object.keys(followed()).slice(-20))
        try {
          tasks.push(await status(taskId));
        } catch {
          /* A task this window remembers but may no longer read. */
        }
    tasks = tasks.slice(0, 20);
    const work: unknown[] = [];
    const execution: unknown[] = [];
    const knowledge: unknown[] = [];
    for (const task of tasks) {
      const taskId = String(task.taskId);
      const path = `/v1/tasks/${encodeURIComponent(taskId)}`;
      const title = String(task.title ?? '');
      const approvals = await optional<unknown>(`${path}/approvals`, []);
      work.push({
        ...pick(task, [
          'taskId',
          'title',
          'phase',
          'inputRevisionId',
          'capabilityPackId',
        ]),
        pendingInputs: (Array.isArray(task.pendingInputs)
          ? task.pendingInputs
          : []
        )
          .filter(
            (item) =>
              isRecord(item) &&
              item.status === 'open' &&
              item.inputRevisionId === task.inputRevisionId,
          )
          .map((item) =>
            pick(item, ['requestId', 'kind', 'question', 'expiresAt']),
          ),
        approvals: (Array.isArray(approvals) ? approvals : []).map((item) =>
          pick(item, [
            'approvalId',
            'status',
            'applicantId',
            'approvedBy',
            'inputRevisionId',
            'targetIdentity',
            'action',
            'expiresAt',
          ]),
        ),
      });
      const operations = await optional<unknown>(`${path}/operations`, []);
      execution.push({
        taskId,
        title,
        operations: (Array.isArray(operations) ? operations : [])
          .slice(-10)
          .map((item) =>
            pick(item, [
              'operationId',
              'name',
              'kind',
              'status',
              'target',
              'workerId',
              'fencingToken',
            ]),
          ),
      });
      const input = isRecord(task.input) ? task.input : {};
      const ended = TERMINAL.has(String(task.phase));
      const result = ended
        ? await optional<Record<string, unknown>>(`${path}/result`, {})
        : {};
      knowledge.push({
        taskId,
        title,
        phase: task.phase,
        status: result.status ?? task.phase,
        source: pick(input, ['sourceRevisionId', 'sourceSha256']),
        artifacts: (Array.isArray(result.artifacts)
          ? result.artifacts
          : []
        ).map((item) =>
          pick(item, ['artifactId', 'fileName', 'sha256', 'size']),
        ),
        evidence: (Array.isArray(result.evidence) ? result.evidence : []).map(
          (item) => pick(item, ['evidenceId', 'kind', 'sha256', 'size']),
        ),
        verification: pick(result.verification, ['reader', 'rowCount']),
        unmapped: (Array.isArray(result.unmapped) ? result.unmapped : []).slice(
          0,
          10,
        ),
      });
    }
    const packs = await optional<unknown>('/v1/packs', []);
    const methods = (Array.isArray(packs) ? packs : []).map((item) =>
      pick(item, [
        'capabilityPackId',
        'version',
        'title',
        'inputFormats',
        'contractVersion',
        'mappingRulesVersion',
        'requiredOperations',
        'conclusionScope',
      ]),
    );
    // E also holds the skill packs people pushed, and the tools the model has from here.
    const pushed = await optional<unknown>('/v1/skillpacks', []);
    // And the bots you may see: yours with their runs and how many are new to you.
    const me = readConfig()?.principalId;
    const seen = seenRuns();
    const botViews: Record<string, unknown>[] = [];
    for (const item of (await bots().catch(() => [] as Asset[])).slice(0, 20)) {
      const trigger = await asset(
        String(item.configuration.triggerAssetId),
      ).catch(() => undefined);
      const mine = item.ownerPrincipalId === me;
      const runs = mine
        ? await botRuns(item.assetId).catch(() => [] as BotRun[])
        : [];
      botViews.push({
        assetId: item.assetId,
        name: item.name,
        lifecycle: item.lifecycle,
        trigger: triggerLabel(trigger),
        triggerLifecycle: trigger?.lifecycle,
        mine,
        owner: item.ownerPrincipalId,
        runs: runs.length,
        fresh: runs.filter(
          (run) => news(run) && !seen.has(runKey(item.assetId, run)),
        ).length,
      });
    }
    const found = {
      refreshedAt: new Date().toISOString(),
      work,
      execution,
      knowledge,
      methods,
      tools: [...serverTools].map(([name, held]) => ({
        name,
        remote: held.remote,
        write: held.write,
      })),
      skillPacks: await Promise.all(
        (Array.isArray(pushed) ? pushed : [])
          .filter(isRecord)
          .slice(0, 20)
          .map(async (item) => {
            const manifest = isRecord(item.manifest) ? item.manifest : {};
            const assetId =
              typeof item.assetId === 'string' ? item.assetId : '';
            const approvalTaskId =
              typeof item.approvalTaskId === 'string'
                ? item.approvalTaskId
                : '';
            const named =
              typeof item.lifecycle === 'string' ? item.lifecycle : '';
            const asset =
              !named && assetId
                ? await optional<unknown>(
                    `/v1/assets/${encodeURIComponent(assetId)}`,
                    undefined,
                  )
                : undefined;
            const lifecycle =
              named ||
              (isRecord(asset) && typeof asset.lifecycle === 'string'
                ? asset.lifecycle
                : '');
            const statusLabel =
              typeof item.statusLabel === 'string' ? item.statusLabel : '';
            const open =
              approvalTaskId && item.status !== 'registered'
                ? rowsOf(
                    await optional<unknown>(
                      `/v1/tasks/${encodeURIComponent(approvalTaskId)}/approvals`,
                      [],
                    ),
                  ).find((row) => row.status === 'open')
                : undefined;
            return {
              skillPackId: item.skillPackId,
              id: item.id ?? manifest.id,
              version: item.version ?? manifest.version,
              status: item.status,
              ...(statusLabel ? { statusLabel } : {}),
              ...(lifecycle ? { lifecycle } : {}),
              ...(approvalTaskId ? { approvalTaskId } : {}),
              ...(open?.approvalId
                ? { approvalId: String(open.approvalId) }
                : {}),
            };
          }),
      ),
      bots: botViews,
      background,
    };
    if (run > objectsShown) {
      objectsShown = run;
      objects = found;
    }
    // A command that read them (/hub refresh) returns once the view shows them: the
    // desktop's pages read the view, not the command's lines.
    await showStatus();
    return { tasks: tasks.length, packs: methods.length };
  }
  // A context whose lines are also kept for the view.
  function recording(context: CommandContext): CommandContext {
    const keep = (line: string): void => {
      recent.push(...String(line).split('\n'));
      recent.splice(0, Math.max(0, recent.length - 30));
      api.background(showStatus());
    };
    return {
      workspace: context.workspace,
      toast: (line) => {
        keep(line);
        context.toast(line);
      },
      append: (line) => {
        keep(line);
        context.append(line);
      },
      sendUserMessage: (line) => context.sendUserMessage(line),
      secret: context.secret,
    };
  }

  // The footer line: where you are signed in, and how many tasks this window follows.
  let statusRun = 0;
  let latestStatus: Promise<void> = Promise.resolve();
  // Called in the background from many places; a status line that cannot be read now (the
  // secrets file busy or gone) is simply not redrawn. Awaited, it returns once this call or
  // a later one has drawn, so the view shows at least what was true when it was called.
  function showStatus(): Promise<void> {
    // Nobody looks once the extension is closed, and its files may be going.
    if (api.signal.aborted) return Promise.resolve();
    // Several refreshes may overlap; only the latest one draws, and the others wait for it.
    const run = ++statusRun;
    latestStatus = drawStatus(run);
    return latestStatus;
  }
  async function drawStatus(run: number): Promise<void> {
    const config = readConfig();
    let signedIn: boolean;
    try {
      signedIn = Boolean(await currentToken());
    } catch {
      return;
    }
    if (api.signal.aborted) return;
    if (run !== statusRun) return latestStatus;
    publishView(signedIn);
    if (!config || !signedIn) {
      api.setStatus(config ? hubText('hub · signed out') : null);
      return;
    }
    const where = hubText('hub · {who}', {
      who: `${config.username ? config.username + '@' : ''}${new URL(config.url).host}`,
    });
    const stopped = failure.endsWith(' stopped following')
      ? failure.slice(0, -' stopped following'.length)
      : '';
    if (failure)
      api.setStatus(
        stopped
          ? hubText('{where} · {task} stopped following', {
              where,
              task: stopped,
            })
          : `${where} · ${failure}`,
        'error',
      );
    else if (following.size)
      api.setStatus(
        hubText('{where} · {n} running', { where, n: following.size }),
        'running',
      );
    else if (expired)
      api.setStatus(hubText('{where} · sign-in expired', { where }), 'wait');
    else if (botNews.length)
      api.setStatus(
        hubText('{where} · {n} bot result(s)', {
          where,
          n: botNews.length,
        }),
        'wait',
      );
    else api.setStatus(where, 'ok');
  }

  function serverUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ServerError(hubText('not a URL: {raw}', { raw }));
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new ServerError(
        hubText('the address must start with http:// or https://'),
      );
    if (url.username || url.password)
      throw new ServerError(
        hubText('put no user name or password in the address'),
      );
    return url.origin;
  }

  async function send(
    method: string,
    path: string,
    options: {
      json?: unknown;
      bytes?: Buffer;
      headers?: Record<string, string>;
      anonymous?: boolean;
      raw?: boolean;
      timeoutMs?: number;
    },
  ): Promise<{ data: unknown; bytes: Buffer; headers: Headers }> {
    const config = readConfig();
    if (!config)
      throw new ServerError(hubText('not signed in: /hub login <url> <user>'));
    const headers: Record<string, string> = { ...options.headers };
    if (!options.anonymous) {
      const token = await currentToken();
      if (!token)
        throw new ServerError(
          hubText('not signed in: /hub login <url> <user>'),
        );
      headers.authorization = `Bearer ${token}`;
    }
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (options.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.json);
    } else if (options.bytes) {
      headers['content-type'] ??= 'application/octet-stream';
      body = new Uint8Array(options.bytes);
    }
    let response: Response;
    try {
      response = await fetch(new URL(path, config.url), {
        method,
        headers,
        body,
        // Ends with the extension: a reload or leaving does not wait out a long poll.
        signal: AbortSignal.any([
          AbortSignal.timeout(options.timeoutMs ?? 60_000),
          api.signal,
        ]),
      });
    } catch (error) {
      throw new ServerError(
        hubText('cannot reach {url}: {message}', {
          url: config.url,
          message: reason(error),
        }),
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    // Asked with If-None-Match: nothing changed since the last answer.
    if (response.status === 304)
      return { data: undefined, bytes, headers: response.headers };
    if (options.raw && response.ok)
      return { data: undefined, bytes, headers: response.headers };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ServerError(
        hubText('{method} {path} → {status}, not JSON', {
          method,
          path,
          status: response.status,
        }),
      );
    }
    // A refusal carries its error at the top. A task that ended failed is answered with HTTP
    // 200, status "failed" and the task's own result (its error inside) as data: that is
    // what was asked for, so it is returned, not thrown away as a request failure.
    const endedFailed =
      response.ok &&
      isRecord(parsed) &&
      parsed.status === 'failed' &&
      !isRecord(parsed.error) &&
      'data' in parsed;
    if (
      !endedFailed &&
      (!response.ok || (isRecord(parsed) && parsed.status === 'failed'))
    ) {
      const error =
        isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
      const details =
        isRecord(error.details) && Object.keys(error.details).length
          ? JSON.stringify(error.details)
          : '';
      const failed = new ServerError(
        `${String(error.code ?? response.status)}: ${String(error.message ?? hubText('request failed'))}${details ? ` · ${details.length > MAX_DETAIL_CHARS ? `${details.slice(0, MAX_DETAIL_CHARS)}…` : details}` : ''}`,
      );
      failed.status = response.status;
      failed.code = typeof error.code === 'string' ? error.code : '';
      failed.details = isRecord(error.details) ? error.details : {};
      throw failed;
    }
    return {
      data: isRecord(parsed) && 'data' in parsed ? parsed.data : parsed,
      bytes,
      headers: response.headers,
    };
  }

  async function signIn(
    url: string,
    username: string,
    password: string,
  ): Promise<string[]> {
    writeJson('config.json', { ...readConfig(), url, username });
    const { data } = await send('POST', '/v1/auth/dev-login', {
      json: { username, password },
      anonymous: true,
    });
    const issued = isRecord(data) ? data : {};
    if (typeof issued.token !== 'string' || !issued.token)
      throw new ServerError(hubText('the server issued no token'));
    await api.secrets.set('token', issued.token);
    const scopes = Array.isArray(issued.scopes)
      ? issued.scopes.map(String)
      : [];
    writeJson('config.json', {
      url,
      username,
      scopeId: scopes[0],
      principalId:
        typeof issued.principalId === 'string' ? issued.principalId : undefined,
      expiresAt:
        typeof issued.expiresAt === 'string' ? issued.expiresAt : undefined,
    });
    failure = '';
    expired = false;
    scheduleRefresh();
    api.background(showStatus());
    return scopes;
  }

  // A session stays alive without asking anyone: shortly before the token runs out it is
  // renewed at the server (POST /v1/auth/refresh), which issues a new token; the old one
  // dies five seconds later. A server without that route, or a run token, is left to expire.
  let refreshing: Promise<boolean> | undefined;
  let refreshUnsupported = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Two minutes before the end, or a fifth of what a short token has left.
  function refreshDue(expiresAt: string | undefined): number | undefined {
    const end = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    if (Number.isNaN(end)) return undefined;
    return end - Math.min(120_000, Math.max((end - Date.now()) / 5, 5_000));
  }
  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    if (api.signal.aborted || fromRun || refreshUnsupported || expired) return;
    const due = refreshDue(readConfig()?.expiresAt);
    if (due === undefined) return;
    refreshTimer = setTimeout(
      () => api.background(refresh()),
      Math.max(due - Date.now(), 15_000),
    );
    refreshTimer.unref?.();
  }
  function refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      if (
        api.signal.aborted ||
        fromRun ||
        refreshUnsupported ||
        !(await currentToken())
      )
        return false;
      try {
        const { data } = await send('POST', '/v1/auth/refresh', { json: {} });
        const issued = isRecord(data) ? data : {};
        if (typeof issued.token === 'string' && issued.token)
          await api.secrets.set('token', issued.token);
        const config = readConfig();
        if (config && typeof issued.expiresAt === 'string')
          writeJson('config.json', { ...config, expiresAt: issued.expiresAt });
        expired = false;
        return true;
      } catch (error) {
        if (error instanceof ServerError && [404, 405].includes(error.status))
          refreshUnsupported = true;
        else if (error instanceof ServerError && error.status === 401)
          expired = true;
        return false;
      } finally {
        scheduleRefresh();
        api.background(showStatus());
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  // A token the server turns down is never followed by a password card: a model's tool call
  // or a task being followed must not stop for one. The footer says the sign-in expired, and
  // the person signs in again with /hub login when they choose.
  async function request(
    method: string,
    path: string,
    options: Parameters<typeof send>[2] = {},
  ): Promise<{ data: unknown; bytes: Buffer; headers: Headers }> {
    if (!options.anonymous && !fromRun) {
      const due = refreshDue(readConfig()?.expiresAt);
      if (due !== undefined && Date.now() >= due) await refresh();
    }
    // Refresh rotates the token: the old one dies five seconds later, so a long poll
    // started before the refresh can come back 401. Retry once on the current token
    // before calling the session expired.
    const used =
      options.anonymous || fromRun ? undefined : await currentToken();
    try {
      return await send(method, path, options);
    } catch (error) {
      if (
        options.anonymous ||
        !(error instanceof ServerError) ||
        error.status !== 401
      )
        throw error;
      if (fromRun)
        throw new ServerError(hubText('hub turned down the run token'));
      const current = await currentToken();
      if (used && current && current !== used)
        try {
          return await send(method, path, options);
        } catch (again) {
          if (!(again instanceof ServerError) || again.status !== 401)
            throw again;
        }
      expired = true;
      scheduleRefresh();
      api.background(showStatus());
      const config = readConfig();
      throw new ServerError(
        hubText(
          'signed out: the sign-in has expired · /hub login {url} {user}',
          {
            url: config?.url ?? '<url>',
            user: config?.username || '<user>',
          },
        ),
      );
    }
  }

  async function status(taskId: string): Promise<Record<string, unknown>> {
    const { data } = await request(
      'GET',
      `/v1/tasks/${encodeURIComponent(taskId)}/status`,
    );
    if (!isRecord(data))
      throw new ServerError(hubText('the server sent no task'));
    return data;
  }

  // One line per event. The server projects event payloads to metadata: short strings such
  // as status, outcome, waitingReason, decision, code or state stay inline, and an error or
  // reason is reduced to its code; bodies are only reachable through the event's content
  // reference. Older servers still send the full payload, whose string fields print the same.
  function eventLine(event: ServerEvent): string {
    const payload = event.payload ?? {};
    const parts: string[] = [];
    for (const key of [
      'phase',
      'to',
      'status',
      'outcome',
      'waitingReason',
      'decision',
      'code',
      'state',
      'message',
      'question',
      'reason',
      'workerId',
    ])
      if (
        typeof payload[key] === 'string' &&
        !parts.includes(String(payload[key]))
      )
        parts.push(String(payload[key]));
    for (const key of ['reason', 'error']) {
      const value = payload[key];
      if (
        isRecord(value) &&
        typeof value.code === 'string' &&
        !parts.includes(value.code)
      )
        parts.push(value.code);
    }
    return `  ${event.taskId} · ${event.seq} · ${event.kind}${parts.length ? ' · ' + parts.join(' · ') : ''}`;
  }

  function freePath(directory: string, name: string): string {
    const safe =
      basename(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'result';
    let path = join(directory, safe);
    for (let n = 1; existsSync(path); n += 1)
      path = join(
        directory,
        `${basename(safe, extname(safe))}-${n}${extname(safe)}`,
      );
    return path;
  }

  // Save every artifact of a delivered task in the workspace, after checking the bytes
  // against the SHA-256 the server recorded for it. A module-execute run produces a
  // flow original per step, so artifacts land in tasks/<taskId>/, not the root.
  async function deliver(
    taskId: string,
    context: CommandContext,
  ): Promise<void> {
    const { data } = await request(
      'GET',
      `/v1/tasks/${encodeURIComponent(taskId)}/result`,
    );
    const result = isRecord(data) ? data : {};
    const unmapped = Array.isArray(result.unmapped) ? result.unmapped : [];
    const check = isRecord(result.verification) ? result.verification : {};
    context.append(
      `  ${taskId} · ${String(result.phase)} · ${String(result.status)}${
        check.reader
          ? hubText(' · read back with {reader}, {rows} rows', {
              reader: String(check.reader),
              rows: String(check.rowCount),
            })
          : ''
      }${
        unmapped.length
          ? hubText(' · {n} unmapped (listed in the workbook)', {
              n: unmapped.length,
            })
          : ''
      }`,
    );
    // A flow result summarizes its cases and the terminal execution observations.
    const outcome = isRecord(result.result) ? result.result : {};
    const cases = Array.isArray(outcome.cases) ? outcome.cases : [];
    for (const item of cases)
      if (isRecord(item))
        context.append(
          hubText('    case {id} · {verdict}', {
            id: String(item.autoid),
            verdict: String(item.verdict),
          }),
        );
    const executionObservations = Array.isArray(result.executionObservations)
      ? result.executionObservations
      : [];
    for (const item of executionObservations)
      if (isRecord(item))
        context.append(
          hubText(
            '    execution {operation} · terminal {terminal} · remote lease released {released}',
            {
              operation: String(item.operationId),
              terminal: String(item.terminal),
              released: String(item.remoteLeaseReleased),
            },
          ),
        );
    for (const item of unmapped.slice(0, 5))
      if (isRecord(item))
        context.append(
          hubText('    unmapped {path}: {reason}', {
            path: String(item.path),
            reason: String(item.reason),
          }),
        );
    const evidence = Array.isArray(result.evidence) ? result.evidence : [];
    for (const item of evidence)
      if (isRecord(item))
        context.append(
          hubText('    evidence {id} · {kind} · sha256 {hash}', {
            id: String(item.evidenceId),
            kind: String(item.kind),
            hash: short(item.sha256),
          }),
        );
    const artifacts = (
      Array.isArray(result.artifacts) ? result.artifacts : []
    ).filter(
      (item): item is Artifact =>
        isRecord(item) &&
        typeof item.artifactId === 'string' &&
        typeof item.sha256 === 'string',
    );
    if (!artifacts.length) {
      context.append(hubText('  {task} delivered no files', { task: taskId }));
      return;
    }
    const folder = join(context.workspace, 'tasks', taskId);
    mkdirSync(folder, { recursive: true });
    for (const artifact of artifacts) {
      const { bytes, headers } = await request(
        'GET',
        artifact.downloadPath ??
          `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`,
        { raw: true, timeoutMs: 120_000 },
      );
      const actual = sha256(bytes);
      const declared = headers.get('x-content-sha256');
      const name = artifact.fileName || artifact.artifactId;
      if (actual !== artifact.sha256 || (declared && declared !== actual)) {
        context.append(
          hubText(
            "✖ {name}: the bytes ({actual}) do not match the server's SHA-256 ({expected}); not saved",
            {
              name,
              actual: short(actual),
              expected: short(artifact.sha256),
            },
          ),
        );
        continue;
      }
      const path = freePath(folder, name);
      writeFileSync(path, bytes, { flag: 'wx' });
      remember(taskId, { saved: true });
      context.append(
        hubText(
          '✓ saved {path} · {bytes} bytes · sha256 {hash} matches the server ({id})',
          {
            path,
            bytes: bytes.byteLength,
            hash: short(actual),
            id: artifact.artifactId,
          },
        ),
      );
    }
  }

  // A failed task carries its own error; hub 60220cf adds the rejected flow action
  // (stepId/kind) and the bounded cause (code/message) in error.details.
  async function failureNote(taskId: string, phase: string): Promise<string> {
    let error: Record<string, unknown> | undefined;
    try {
      const { data } = await request(
        'GET',
        `/v1/tasks/${encodeURIComponent(taskId)}/result`,
      );
      if (isRecord(data) && isRecord(data.error)) error = data.error;
    } catch {
      /* The plain line stands. */
    }
    if (!error) return `✖ ${taskId} ${phase}`;
    const details = isRecord(error.details) ? error.details : {};
    const cause = isRecord(details.cause) ? details.cause : undefined;
    const where =
      typeof details.stepId === 'string'
        ? hubText(' · step {step}{kind}', {
            step: details.stepId,
            kind: typeof details.kind === 'string' ? ` (${details.kind})` : '',
          })
        : '';
    const why = cause
      ? ` · ${String(cause.code ?? '')}: ${String(cause.message ?? '')}`
      : '';
    return `✖ ${taskId} ${phase}: ${String(error.code ?? '')} · ${String(error.message ?? '')}${where}${why}`;
  }

  // Follow a task from the last event this window showed until it ends, writing each event
  // as a line. Runs in the background: the command that started it has already returned,
  // and Circle waits for it when it closes the extension.
  async function follow(
    taskId: string,
    context: CommandContext,
  ): Promise<void> {
    if (following.has(taskId)) return;
    const controller = new AbortController();
    following.set(taskId, controller);
    failure = '';
    api.background(showStatus());
    let cursor = followed()[taskId]?.seq ?? 0;
    let ended = false;
    try {
      while (!controller.signal.aborted && !api.signal.aborted) {
        // The task's state first: a task that has ended has only its missed events left,
        // so there is nothing to wait for.
        const current = await status(taskId);
        const phase = String(current.phase ?? '');
        const over = TERMINAL.has(phase);
        let data: unknown;
        try {
          data = (
            await request(
              'GET',
              `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${cursor}&waitMs=${over ? 0 : 20000}`,
              { timeoutMs: 40_000 },
            )
          ).data;
        } catch (error) {
          // The retained window moved past this cursor: restart at its first
          // retained position instead of sitting on the stale one forever.
          if (error instanceof ServerError && error.code === 'CURSOR_EXPIRED') {
            cursor = Number(error.details.minCursor) || 0;
            remember(taskId, { seq: cursor });
            continue;
          }
          throw error;
        }
        const events = (
          isRecord(data) && Array.isArray(data.events) ? data.events : []
        ) as ServerEvent[];
        for (const event of events) {
          context.append(eventLine(event));
          cursor = Math.max(cursor, event.seq);
        }
        if (events.length) remember(taskId, { seq: cursor });
        if (over) {
          if (phase === 'delivered') {
            if (followed()[taskId]?.saved)
              context.append(
                hubText(
                  '  {task} was delivered and its results are saved here · /hub get {task} saves them again',
                  { task: taskId },
                ),
              );
            else await deliver(taskId, context);
          } else if (phase === 'unknown')
            context.append(
              hubText(
                '✖ {task}: the outcome is unknown and the server does not guess it · /hub task {task} later',
                { task: taskId },
              ),
            );
          else context.append(await failureNote(taskId, phase));
          ended = true;
          return;
        }
        const open = (
          Array.isArray(current.pendingInputs) ? current.pendingInputs : []
        ).filter(
          (item) =>
            isRecord(item) &&
            item.status === 'open' &&
            item.inputRevisionId === current.inputRevisionId,
        );
        for (const item of open)
          if (isRecord(item))
            context.append(
              hubText(
                '  {task} asks: {question} · /hub respond {task} <answer>',
                {
                  task: taskId,
                  question: String(item.question),
                },
              ),
            );
        if (open.length) return;
      }
    } catch (error) {
      // Closed under it: the task goes on on the server, and /hub task picks it up.
      if (api.signal.aborted) return;
      failure = `${taskId} stopped following`;
      context.append(
        hubText('✖ {task}: {message} · /hub task {task} picks it up again', {
          task: taskId,
          message: reason(error),
        }),
      );
    } finally {
      following.delete(taskId);
      api.background(showStatus());
      // Read the objects again once it has ended, after it stopped counting as followed.
      if (ended && !api.signal.aborted) api.background(collectObjects());
    }
  }

  async function upload(
    path: string,
    scopeId: string,
    capabilityPackId?: string,
  ): Promise<{ id: string; sha256: string; name: string }> {
    if (statSync(path).size > MAX_UPLOAD_BYTES)
      throw new ServerError(
        hubText('{name} is larger than 16 MB', { name: basename(path) }),
      );
    const bytes = readFileSync(path);
    const { data } = await request('POST', '/v1/sources', {
      bytes,
      headers: {
        'x-scope-id': scopeId,
        'x-file-name': encodeURIComponent(basename(path)),
        // The hub checks this before it stores the bytes, so an unknown pack
        // does not leave a source behind. Absent, the upload happens first.
        ...(capabilityPackId
          ? { 'x-capability-pack-id': capabilityPackId }
          : {}),
      },
      timeoutMs: 120_000,
    });
    const source = isRecord(data) ? data : {};
    const id = String(source.sourceRevisionId ?? '');
    if (!id) throw new ServerError(hubText('the server returned no source id'));
    if (source.sha256 !== sha256(bytes))
      throw new ServerError(
        hubText('{name} arrived with a different SHA-256', {
          name: basename(path),
        }),
      );
    return { id, sha256: sha256(bytes), name: basename(path) };
  }

  // Upload one file of the workspace and hand the server a task on it, with whatever else
  // the pack's input asks for (the assets it binds, a build). The same pack, file and input
  // give the same idempotency key, so sending twice finds the same task.
  async function handOver(
    pack: string,
    file: string,
    again: boolean,
    context: CommandContext,
    extra: Record<string, unknown> = {},
  ): Promise<{
    taskId: string;
    phase: string;
    inputRevisionId: string;
    deduplicated: boolean;
  }> {
    const config = readConfig();
    if (!config?.scopeId)
      throw new ServerError(
        hubText('no scope: sign in again with /hub login <url> <user>'),
      );
    // module-execute is the hub's generic execution flow: its input is the frozen
    // FlowSubmission itself (flowId, methodPin, resources, sources, value,
    // controlledBytes), validated strictly by the hub. No file upload, and no
    // sourceRevisionId/sourceSha256 — the hub refuses those with INVALID_PAYLOAD.
    const moduleExecute = pack === 'module-execute';
    if (moduleExecute && file)
      throw new ServerError(
        hubText(
          'module-execute takes the flow input, not a file: /hub submit module-execute <input-json>',
        ),
      );
    if (
      moduleExecute &&
      (typeof extra.flowId !== 'string' ||
        !extra.flowId ||
        !isRecord(extra.methodPin) ||
        !isRecord(extra.resources))
    )
      throw new ServerError(
        hubText(
          'module-execute input is the flow: {flowId, methodPin, resources, sources?, value?, controlledBytes?}',
        ),
      );
    let source: Awaited<ReturnType<typeof upload>> | undefined;
    if (!moduleExecute) {
      const path = resolve(context.workspace, file);
      if (!existsSync(path))
        throw new ServerError(hubText('no such file: {path}', { path }));
      source = await upload(path, config.scopeId, pack);
      context.append(
        hubText('  uploaded {name} · sha256 {hash} → {id}', {
          name: source.name,
          hash: short(source.sha256),
          id: source.id,
        }),
      );
    }
    const title = moduleExecute
      ? `${pack}: ${String(extra.flowId)}`
      : `${pack}: ${source!.name}`;
    const idempotencyKey =
      'circle-' +
      sha256(
        Buffer.from(
          JSON.stringify([
            config.scopeId,
            pack,
            source?.sha256 ?? '',
            again ? Date.now() : 0,
            ...(Object.keys(extra).length
              ? [
                  Object.keys(extra)
                    .sort()
                    .map((key) => [key, extra[key]]),
                ]
              : []),
          ]),
        ),
      ).slice(0, 40);
    const { data } = await request('POST', '/v1/tasks/submit', {
      json: {
        scopeId: config.scopeId,
        title,
        capabilityPackId: pack,
        idempotencyKey,
        input: moduleExecute
          ? extra
          : {
              ...extra,
              sourceRevisionId: source!.id,
              sourceSha256: source!.sha256,
            },
      },
    });
    const task = isRecord(data) ? data : {};
    const taskId = String(task.taskId ?? '');
    if (!taskId) throw new ServerError(hubText('the server accepted no task'));
    if (!followed()[taskId]) remember(taskId, { title, seq: 0 });
    return {
      taskId,
      phase: String(task.phase ?? ''),
      inputRevisionId: String(task.inputRevisionId ?? ''),
      deduplicated: task.deduplicated === true,
    };
  }

  // A context for code that writes lines, when the lines go back to the model instead.
  function collecting(): { lines: string[]; context: CommandContext } {
    const lines: string[] = [];
    return {
      lines,
      context: {
        workspace: api.workspace,
        toast: (line) => lines.push(line),
        append: (line) => lines.push(line),
        sendUserMessage: () => {},
      },
    };
  }

  // The server's tools, offered to the model as hub_tool_<name>: read after signing in, on
  // /hub refresh and /hub tools, and when a session starts (an ETag keeps that cheap).
  // Signing out removes them. Read tools run at once; the others ask first.
  const serverTools = new Map<
    string,
    { remote: string; fingerprint: string; write: boolean }
  >();
  let catalogTag = '';
  let syncing: Promise<boolean> | undefined;
  // hub_tool_<name> with dots as underscores. Names that would come out the same (docs.list and
  // docs_list) or be cut at 64 characters get a suffix from their full name instead, so the
  // same catalog always gives the same names, whatever order it lists them in.
  function toolNames(remotes: string[]): Map<string, string> {
    const plain = (remote: string): string =>
      'hub_tool_' + remote.replace(/[^A-Za-z0-9_]/g, '_');
    const counts = new Map<string, number>();
    for (const remote of remotes)
      counts.set(plain(remote), (counts.get(plain(remote)) ?? 0) + 1);
    return new Map(
      remotes.map((remote) => {
        const base = plain(remote);
        if (counts.get(base) === 1 && base.length <= 64) return [remote, base];
        const suffix = '_' + sha256(Buffer.from(remote)).slice(0, 8);
        return [remote, base.slice(0, 64 - suffix.length) + suffix];
      }),
    );
  }
  function dropServerTools(): void {
    for (const name of serverTools.keys()) api.unregisterTool(name);
    serverTools.clear();
    catalogTag = '';
  }
  // A server tool's response, kept in the workspace exactly as it came: a skill's own checks
  // compare against this file, and the model cites it instead of retyping what it saw.
  let returned = 0;
  function keepReturn(
    remote: string,
    args: unknown,
    response: unknown,
  ): string | undefined {
    if (!api.workspace) return undefined;
    try {
      const folder = join(api.workspace, '.circle', 'hub-returns');
      mkdirSync(folder, { recursive: true });
      const name = `${new Date().toISOString().replace(/[:.]/g, '')}-${String(++returned).padStart(4, '0')}-${remote}.json`;
      writeFileSync(
        join(folder, name),
        JSON.stringify(
          { tool: remote, args, at: new Date().toISOString(), response },
          null,
          2,
        ) + '\n',
      );
      return `.circle/hub-returns/${name}`;
    } catch {
      return undefined;
    }
  }
  function registerServerTool(
    name: string,
    tool: Record<string, unknown>,
  ): boolean {
    const remote = String(tool.name);
    const write = tool.effect !== 'read';
    const schema =
      isRecord(tool.inputSchema) && tool.inputSchema.type === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} };
    try {
      api.registerTool(
        name,
        hubText('hub tool {remote}{title}: {description}{write}{tail}', {
          remote,
          title: tool.title
            ? hubText(' ({title})', { title: String(tool.title) })
            : '',
          description: String(tool.description ?? ''),
          write: write
            ? hubText(' It changes something, so it asks first.')
            : '',
          tail:
            tool.mode === 'task'
              ? hubText(
                  ' It runs as a hub task and is waited for in the background.',
                )
              : hubText(
                  ' Its response is also saved as it came under .circle/hub-returns/ in the workspace (savedAs), to cite or check against instead of retyping it.',
                ),
        }),
        schema,
        async (args) => {
          let data: unknown;
          try {
            ({ data } = await request(
              'POST',
              `/v1/tools/${encodeURIComponent(remote)}/call`,
              {
                json: { args, idempotencyKey: randomUUID() },
                timeoutMs: 120_000,
              },
            ));
          } catch (error) {
            throw new api.ToolError(reason(error));
          }
          const reply = isRecord(data) ? data : {};
          if (typeof reply.taskId !== 'string') {
            const response = {
              result: reply.result ?? null,
              evidence: reply.evidence ?? [],
            };
            const savedAs = keepReturn(remote, args, response);
            return savedAs ? { ...response, savedAs } : response;
          }
          const taskId = reply.taskId;
          return new api.Watch(
            hubText('hub {remote} {task}', { remote, task: taskId }),
            async () => {
              const current = await status(taskId);
              const phase = String(current.phase ?? '');
              if (!TERMINAL.has(phase)) return null;
              const result = await optional<unknown>(
                `/v1/tasks/${encodeURIComponent(taskId)}/result`,
                null,
              );
              return { taskId, phase, result };
            },
            {
              interval_s: 3,
              deadline_s: 3600,
              result: { taskId, phase: reply.phase ?? 'admitted' },
            },
          );
        },
        { readOnly: !write, approval: write },
      );
      return true;
    } catch {
      // A name another extension or Circle already uses: leave that one alone.
      return false;
    }
  }
  // Resolves to false when the server has no tool catalog (an older server): no tools then.
  async function syncTools(force = false): Promise<boolean> {
    if (!(await currentToken())) {
      dropServerTools();
      return false;
    }
    syncing ??= (async () => {
      let reply: Awaited<ReturnType<typeof request>>;
      try {
        reply = await request('GET', '/v1/tools', {
          headers: catalogTag && !force ? { 'if-none-match': catalogTag } : {},
        });
      } catch (error) {
        if (error instanceof ServerError && error.status === 404) {
          dropServerTools();
          return false;
        }
        throw error;
      }
      const { data, headers } = reply;
      if (data === undefined && catalogTag && !force) return true;
      catalogTag = headers.get('etag') ?? '';
      const listed = (Array.isArray(data) ? data : [])
        .filter(isRecord)
        .filter(
          (tool) =>
            typeof tool.name === 'string' &&
            /^[a-z0-9._]{1,200}$/.test(tool.name),
        );
      const names = toolNames(listed.map((tool) => String(tool.name)));
      const wanted = new Map<string, Record<string, unknown>>();
      for (const tool of listed)
        wanted.set(names.get(String(tool.name))!, tool);
      for (const [name, held] of [...serverTools]) {
        const tool = wanted.get(name);
        if (tool && JSON.stringify(tool) === held.fingerprint) continue;
        api.unregisterTool(name);
        serverTools.delete(name);
      }
      for (const [name, tool] of wanted)
        if (!serverTools.has(name) && registerServerTool(name, tool))
          serverTools.set(name, {
            remote: String(tool.name),
            fingerprint: JSON.stringify(tool),
            write: tool.effect !== 'read',
          });
      return true;
    })().finally(() => {
      syncing = undefined;
    });
    return syncing;
  }
  async function announceTools(
    context: CommandContext,
    list = false,
  ): Promise<void> {
    if (list && !fromRun && !(await currentToken())) {
      const where = readConfig();
      context.append(
        hubText('not signed in: /hub login {url} <user>', {
          url: where?.url ?? DEFAULT_HUB_URL,
        }),
      );
      return;
    }
    let catalog: boolean;
    try {
      catalog = await syncTools(list);
    } catch (error) {
      context.append(
        hubText("  could not read the server's tools: {message}", {
          message: explainFailure(error),
        }),
      );
      return;
    }
    if (!catalog) {
      if (list) context.append(hubText('  this server offers no tools'));
      return;
    }
    context.append(
      hubText('  {n} server tools available to the model from its next turn', {
        n: serverTools.size,
      }),
    );
    if (list)
      for (const [name, held] of serverTools)
        context.append(
          hubText('    {name} ← {remote} · {mode}', {
            name,
            remote: held.remote,
            mode: held.write ? hubText('asks first') : hubText('read-only'),
          }),
        );
  }
  // Read again whenever a session starts (load, reload, a new session); an unchanged
  // catalog costs one 304.
  api.on('session_start', () => {
    void syncTools().catch(() => {});
  });
  // Run for a server: its tools are there before the first prompt, or not at all.
  if (fromRun) await syncTools().catch(() => {});

  // What the model did with the server's tools since /hub trial start: the trial record a
  // skill pack is pushed with. Arguments are kept only as SHA-256.
  // Kept in the extension's data folder too, so a reload or a restart does not lose it.
  const savedTrial = readJson('trial.json');
  const trial: {
    startedAt: string;
    calls: { name: string; argsSha256: string; ok: boolean }[];
  } =
    isRecord(savedTrial) && Array.isArray(savedTrial.calls)
      ? {
          startedAt: String(savedTrial.startedAt ?? ''),
          calls: savedTrial.calls.filter(isRecord).map((call) => ({
            name: String(call.name),
            argsSha256: String(call.argsSha256),
            ok: call.ok === true,
          })),
        }
      : { startedAt: '', calls: [] };
  const keepTrial = (): void => {
    if (!fromRun) writeJson('trial.json', trial);
  };
  // Starting again drops calls that were never pushed. Leave them, and say so,
  // unless the caller asked to drop them.
  function beginTrial(force: boolean): {
    recording: boolean;
    dropped: number;
    line: string;
  } {
    const pending = trial.calls.length;
    const noun = hubText(
      pending === 1 ? '{n} unpushed trial call' : '{n} unpushed trial calls',
      { n: pending },
    );
    if (pending && !force)
      return {
        recording: false,
        dropped: 0,
        line: hubText(
          '  {noun} would be dropped. /hub skill push <folder> sends them with the pack. /hub trial start --force drops them and records from now.',
          { noun },
        ),
      };
    trial.calls = [];
    trial.startedAt = new Date().toISOString();
    keepTrial();
    return {
      recording: true,
      dropped: pending,
      line: `${
        pending ? hubText('  dropped {noun}.\n', { noun }) : ''
      }${hubText('  recording the server tool calls of this trial; /hub skill push <folder> sends them with the pack')}`,
    };
  }
  const recordTrial: ToolMiddleware = async (invocation, next) => {
    const held = serverTools.get(invocation.tool.name);
    if (!held) return next(invocation);
    const argsSha256 = sha256(Buffer.from(canonical(invocation.args)));
    try {
      const text = await next(invocation);
      trial.calls.push({ name: held.remote, argsSha256, ok: true });
      keepTrial();
      return text;
    } catch (error) {
      trial.calls.push({ name: held.remote, argsSha256, ok: false });
      keepTrial();
      throw error;
    }
  };
  api.registerMiddleware(recordTrial, 'tool_boundary');

  function packFiles(
    root: string,
  ): { path: string; base64: string; sha256: string }[] {
    const files: { path: string; base64: string; sha256: string }[] = [];
    let total = 0;
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
        (a, b) =>
          // Code-point order, the same on every machine, so a pack always lists the same way.
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules')
          continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile()) {
          const bytes = readFileSync(path);
          if (bytes.length > MAX_PACK_FILE_BYTES)
            throw new ServerError(
              hubText('{path} is larger than 2 MB', {
                path: relative(root, path),
              }),
            );
          total += bytes.length;
          if (total > MAX_PACK_BYTES)
            throw new ServerError(
              hubText('the skill pack is larger than 10 MB'),
            );
          files.push({
            path: relative(root, path).split(sep).join('/'),
            base64: bytes.toString('base64'),
            sha256: sha256(bytes),
          });
          if (files.length > MAX_PACK_FILES)
            throw new ServerError(
              hubText('more than {n} files', { n: MAX_PACK_FILES }),
            );
        }
      }
    };
    walk(root);
    return files;
  }
  function skillManifestError(
    manifest: Record<string, unknown>,
  ): string | undefined {
    const problems: string[] = [];
    if (
      typeof manifest.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id)
    )
      problems.push('id (lowercase letters, digits and -)');
    if (typeof manifest.version !== 'string' || !manifest.version.trim())
      problems.push('version');
    if (typeof manifest.title !== 'string' || !manifest.title.trim())
      problems.push('title');
    if (typeof manifest.owner !== 'string' || !manifest.owner.trim())
      problems.push('owner');
    if (!Array.isArray(manifest.tools)) problems.push('tools[]');
    const triggers = Array.isArray(manifest.triggers)
      ? manifest.triggers.map(String)
      : [];
    if (
      !triggers.length ||
      triggers.some((item) => !['manual', 'schedule', 'event'].includes(item))
    )
      problems.push('triggers (manual, schedule or event)');
    if (!isRecord(manifest.inputs)) problems.push('inputs (an object)');
    const outputs = Array.isArray(manifest.outputs)
      ? manifest.outputs.filter((item) => typeof item === 'string')
      : [];
    if (!outputs.length)
      problems.push('outputs (at least one file the pack produces)');
    if (!('model' in manifest)) problems.push('model');
    if (!problems.length) return;
    return hubText(
      'skillpack.json needs {problems} before the hub will accept it (client API 1.0.0). outputs is required there (at least one file the pack produces). The trial call record may be empty. --outputs names the trial files and defaults to that list.',
      { problems: problems.join(', ') },
    );
  }
  const skillPushUsage = (): string =>
    hubText(
      'usage: /hub skill push <folder> [--outputs a,b]. skillpack.json outputs are required; the trial call record may be empty.',
    );
  // `--outputs` with no list must not take the folder (or the next flag) as that list.
  function skillPushArgs(rest: string[]): {
    folder: string;
    explicit: boolean;
    outputs: string[];
  } {
    const flag = rest.indexOf('--outputs');
    const positional = (skipValue: boolean) =>
      rest.filter(
        (word, index) =>
          !word.startsWith('-') &&
          index !== flag &&
          !(skipValue && index === flag + 1),
      );
    if (flag < 0) {
      const folder = positional(false)[0];
      if (!folder || rest.some((word) => word.startsWith('-')))
        throw new ServerError(skillPushUsage());
      return { folder, explicit: false, outputs: [] };
    }
    const value = rest[flag + 1];
    const others = positional(true);
    const fileList =
      typeof value === 'string' &&
      !value.startsWith('-') &&
      (value.includes(',') || value.includes('.') || others.length > 0);
    if (!fileList)
      throw new ServerError(
        hubText(
          '--outputs needs a comma-separated file list (a,b). Without that list it does not take the next word. skillpack.json outputs are required (at least one file the pack produces). The trial call record may be empty.',
        ),
      );
    const outputs = value!
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (!outputs.length)
      throw new ServerError(
        hubText(
          '--outputs needs a comma-separated file list (a,b). skillpack.json outputs are required. The trial call record may be empty.',
        ),
      );
    const folder = others[0];
    if (!folder) throw new ServerError(skillPushUsage());
    return { folder, explicit: true, outputs };
  }
  async function pushSkill(
    rest: string[],
    context: CommandContext,
  ): Promise<void> {
    const { folder, explicit, outputs } = skillPushArgs(rest);
    const workspace = api.workspace ?? context.workspace;
    const root = resolve(workspace, folder);
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new ServerError(hubText('{folder} is not a folder', { folder }));
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(root, 'skillpack.json'), 'utf8'),
      );
      if (!isRecord(parsed)) throw new Error('not an object');
      manifest = parsed;
    } catch (error) {
      throw new ServerError(
        hubText('{folder}/skillpack.json: {message}', {
          folder,
          message: reason(error),
        }),
      );
    }
    const manifestError = skillManifestError(manifest);
    if (manifestError) throw new ServerError(manifestError);
    if (!existsSync(join(root, 'SKILL.md')))
      throw new ServerError(hubText('{folder} has no SKILL.md', { folder }));
    const declared = new Set(
      (Array.isArray(manifest.tools) ? manifest.tools : []).map(String),
    );
    const undeclared = [
      ...new Set(
        trial.calls
          .map((call) => call.name)
          .filter((name) => !declared.has(name)),
      ),
    ];
    if (undeclared.length)
      context.append(
        hubText(
          '  ! the trial used tools skillpack.json does not declare: {names}',
          { names: undeclared.join(', ') },
        ),
      );
    const declaredOutputs = Array.isArray(manifest.outputs)
      ? manifest.outputs.map(String)
      : [];
    const chosen = explicit ? outputs : declaredOutputs;
    if (!explicit) {
      const missing = chosen.filter(
        (output) => !existsSync(resolve(workspace, output)),
      );
      if (missing.length)
        throw new ServerError(
          hubText(
            missing.length === 1
              ? '{files} is not in the workspace. /hub skill push uses the files skillpack.json lists as outputs; pass --outputs a,b for this trial, or put those files in place.'
              : '{files} are not in the workspace. /hub skill push uses the files skillpack.json lists as outputs; pass --outputs a,b for this trial, or put those files in place.',
            { files: missing.join(', ') },
          ),
        );
    }
    const produced: { path: string; sha256: string }[] = [];
    for (const output of chosen) {
      const path = resolve(workspace, output);
      if (!existsSync(path)) {
        context.append(
          hubText('  ! {output} does not exist; left out of the trial record', {
            output,
          }),
        );
        continue;
      }
      produced.push({ path: output, sha256: sha256(readFileSync(path)) });
    }
    const files = packFiles(root);
    // With more than one scope the server needs to know which one the pack is for.
    const scopeId = readConfig()?.scopeId;
    const { data } = await request('POST', '/v1/skillpacks', {
      headers: scopeId ? { 'x-scope-id': scopeId } : {},
      json: {
        manifest,
        files,
        trial: { toolCalls: trial.calls, outputs: produced },
      },
      timeoutMs: 120_000,
    });
    const reply = isRecord(data) ? data : {};
    const check = isRecord(reply.check) ? reply.check : {};
    context.append(
      hubText(
        '✓ submitted {id} {version} · {files} files · {calls} trial calls · {pack} · digest {digest} · {status}',
        {
          id: String(manifest.id),
          version: String(manifest.version),
          files: files.length,
          calls: trial.calls.length,
          pack: String(reply.skillPackId ?? '?'),
          digest: short(reply.digest),
          status: String(reply.status ?? 'submitted'),
        },
      ),
    );
    for (const [key, label] of [
      [
        'undeclaredTools',
        'the server found tools the trial used but the pack does not declare',
      ],
      ['missingTools', 'the server offers none of'],
    ] as const) {
      const names = Array.isArray(check[key]) ? check[key].map(String) : [];
      if (names.length)
        context.append(
          hubText('  ✖ {label}: {names}', {
            label: hubText(label),
            names: names.join(', '),
          }),
        );
    }
    // Submitted is not approved: the approval id lives on that task, not in this reply.
    const approvalTask =
      typeof reply.approvalTaskId === 'string' ? reply.approvalTaskId : '';
    if (!approvalTask) {
      context.append(
        hubText(
          '  submitted, but the server named no approval task. /hub review lists open approvals',
        ),
      );
      return;
    }
    remember(approvalTask, {
      title: `approve skill pack ${String(manifest.id)}`,
      seq: 0,
    });
    context.append(await approvalNotice(approvalTask));
  }

  // Files of the workspace as a skill pack run takes them: inputs.files.
  function attach(
    names: string[],
    context: CommandContext,
  ): { path: string; base64: string; sha256: string }[] {
    const workspace = api.workspace ?? context.workspace;
    return names.map((name) => {
      const path = resolve(workspace, name);
      if (!existsSync(path) || !statSync(path).isFile())
        throw new ServerError(
          hubText('{name} is not a file in the workspace', { name }),
        );
      if (statSync(path).size > MAX_UPLOAD_BYTES)
        throw new ServerError(hubText('{name} is larger than 16 MB', { name }));
      const bytes = readFileSync(path);
      return {
        path: relative(workspace, path).split(sep).join('/'),
        base64: bytes.toString('base64'),
        sha256: sha256(bytes),
      };
    });
  }
  function jsonObject(text: string, what: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error('not an object');
      return parsed;
    } catch (error) {
      throw new ServerError(
        hubText('{what} are not a JSON object: {message}', {
          what,
          message: reason(error),
        }),
      );
    }
  }
  // Words, then --options: an option takes the words up to the next option, and may repeat.
  function options(rest: string[]): {
    args: string[];
    values: Record<string, string[]>;
  } {
    const args: string[] = [];
    const values: Record<string, string[]> = {};
    let open: string[] | undefined;
    for (const word of rest) {
      const flag = /^--([a-z]+)$/.exec(word);
      if (flag) {
        open = values[flag[1]!] ??= [];
        open.push('');
      } else if (open)
        open[open.length - 1] = open.at(-1) ? `${open.at(-1)} ${word}` : word;
      else args.push(word);
    }
    return { args, values };
  }

  const UNITS: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  function every(text: string | undefined): number {
    const match = /^(\d+)([smhd])$/.exec(text ?? '');
    if (!match)
      throw new ServerError(
        hubText('not an interval: {text} (for example 30m, 1h or 1d)', {
          text: text ?? '',
        }),
      );
    return Number(match[1]) * UNITS[match[2]!]!;
  }
  const asAsset = (value: unknown): Asset => {
    if (!isRecord(value) || typeof value.assetId !== 'string')
      throw new ServerError(hubText('the server sent no asset'));
    return {
      ...(value as unknown as Asset),
      configuration: isRecord(value.configuration) ? value.configuration : {},
    };
  };
  async function asset(id: string): Promise<Asset> {
    return asAsset(
      (await request('GET', `/v1/assets/${encodeURIComponent(id)}`)).data,
    );
  }
  async function bots(get: typeof request = request): Promise<Asset[]> {
    const { data } = await get('GET', '/v1/assets?kind=bot&limit=100');
    const items = isRecord(data) && Array.isArray(data.items) ? data.items : [];
    return items.filter(isRecord).map(asAsset);
  }
  async function botRuns(
    id: string,
    get: typeof request = request,
  ): Promise<BotRun[]> {
    const { data } = await get(
      'GET',
      `/v1/automations/bots/${encodeURIComponent(id)}/runs`,
    );
    return (Array.isArray(data) ? data : []).filter(isRecord).map((run) => {
      const error = isRecord(run.error)
        ? [run.error.code ?? run.error.category, run.error.message]
            .filter((part) => part !== undefined && part !== '')
            .map(String)
            .join(': ')
        : typeof run.error === 'string'
          ? run.error
          : '';
      return {
        taskId: typeof run.taskId === 'string' ? run.taskId : '',
        occurrenceKey: String(run.occurrenceKey ?? ''),
        channel: String(run.channel ?? ''),
        published: run.published === true,
        status: String(run.status ?? (run.taskId ? 'admitted' : 'failed')),
        trigger: isRecord(run.trigger) ? run.trigger : {},
        error,
      };
    });
  }
  // What a run has for its owner: a published output, or an occurrence that never started.
  const news = (run: BotRun): boolean =>
    run.published || (run.status === 'failed' && !run.taskId);
  // A lifecycle step bound to the version and digest the server showed: approved (by
  // someone other than the owner), running or disabled (by the owner).
  async function move(item: Asset, state: string): Promise<Asset> {
    return asAsset(
      (
        await request(
          'POST',
          `/v1/assets/${encodeURIComponent(item.assetId)}/lifecycle`,
          { json: { version: item.version, sha256: item.sha256, state } },
        )
      ).data,
    );
  }
  function scheduleEvery(ms: number): string {
    const unit =
      Object.entries(UNITS)
        .reverse()
        .find(([, size]) => ms % size === 0) ?? (['ms', 1] as const);
    return `${ms / unit[1]}${unit[0]}`;
  }
  // English for the desktop view. The terminal uses triggerText, which follows
  // the process language and says the same thing when that language is English.
  function triggerLabel(trigger: Asset | undefined): string {
    const configuration = trigger?.configuration ?? {};
    if (configuration.kind === 'schedule')
      return `every ${scheduleEvery(Number(configuration.intervalMs))} from ${String(configuration.startsAt)}`;
    if (configuration.kind === 'event')
      return `on ${String(configuration.eventName)} of ${String(configuration.sourceAssetId)}`;
    return 'no trigger';
  }
  function triggerText(trigger: Asset | undefined): string {
    const configuration = trigger?.configuration ?? {};
    if (configuration.kind === 'schedule')
      return hubText('every {every} from {from}', {
        every: scheduleEvery(Number(configuration.intervalMs)),
        from: String(configuration.startsAt),
      });
    if (configuration.kind === 'event')
      return hubText('on {event} of {source}', {
        event: String(configuration.eventName),
        source: String(configuration.sourceAssetId),
      });
    return hubText('no trigger');
  }
  // The output the server published for a run: the bot.output event of its task.
  async function botOutput(
    taskId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const { data } = await request(
      'GET',
      `/v1/tasks/${encodeURIComponent(taskId)}/events?after=0&waitMs=0`,
    );
    const events = (
      isRecord(data) && Array.isArray(data.events) ? data.events : []
    ) as ServerEvent[];
    return events.filter((event) => event.kind === 'bot.output').at(-1)
      ?.payload;
  }
  function seenRuns(): Set<string> {
    const value = readJson('bots.json');
    return new Set(
      isRecord(value) && Array.isArray(value.seen)
        ? value.seen.map(String)
        : [],
    );
  }
  function markSeen(keys: string[]): void {
    const seen = [...seenRuns(), ...keys];
    writeJson('bots.json', { seen: [...new Set(seen)].slice(-1000) });
    botNews = botNews.filter(
      ({ bot, run }) => !keys.includes(runKey(bot.assetId, run)),
    );
  }
  // Look for new results of your bots in the background. Like every request it never asks
  // for a password: a token the server turns down only puts "sign-in expired" in the
  // footer, and /hub login looks once more.
  let lookingForBots: Promise<void> | undefined;
  function lookForBots(): Promise<void> {
    lookingForBots ??= (async () => {
      const me = readConfig()?.principalId;
      if (api.signal.aborted || fromRun || !me || !(await currentToken()))
        return;
      const quiet: typeof request = (method, path, options = {}) =>
        send(method, path, options);
      const seen = seenRuns();
      const found: { bot: Asset; run: BotRun }[] = [];
      for (const bot of (await bots(quiet))
        .filter((item) => item.ownerPrincipalId === me)
        .slice(0, 20))
        for (const run of await botRuns(bot.assetId, quiet))
          if (news(run) && !seen.has(runKey(bot.assetId, run)))
            found.push({ bot, run });
      botNews = found;
      expired = false;
      api.background(showStatus());
    })()
      .catch((error) => {
        if (error instanceof ServerError && error.status === 401) {
          expired = true;
          api.background(showStatus());
        }
      })
      .finally(() => {
        lookingForBots = undefined;
      });
    return lookingForBots;
  }
  if (!fromRun) {
    const botTimer = setInterval(() => api.background(lookForBots()), 60_000);
    botTimer.unref();
    api.signal.addEventListener(
      'abort',
      () => {
        clearInterval(botTimer);
        if (refreshTimer) clearTimeout(refreshTimer);
      },
      { once: true },
    );
  }

  async function bot(
    [verb, ...rest]: string[],
    context: CommandContext,
  ): Promise<void> {
    const config = readConfig();
    if (verb === 'every' || verb === 'on') {
      const { args, values } = options(rest);
      if (!config?.scopeId)
        throw new ServerError(
          hubText('no scope: sign in again with /hub login <url> <user>'),
        );
      if (!config.principalId)
        throw new ServerError(
          hubText(
            'the server has not said who you are here; sign in again with /hub login <url> <user>',
          ),
        );
      const [pack] = args;
      const schedule = verb === 'every';
      if (!pack || args.length !== (schedule ? 2 : 3))
        throw new ServerError(
          schedule
            ? hubText(
                'usage: /hub bot every <skill pack> <interval> [--from <time>] [--inputs <json>] [--file <path>] [--name <name>]',
              )
            : hubText(
                'usage: /hub bot on <skill pack> <connector asset> <event> [--inputs <json>] [--file <path>] [--name <name>]',
              ),
        );
      const trigger = schedule
        ? (() => {
            const from = values.from?.at(-1);
            const startsAt = from ? new Date(from) : new Date();
            if (Number.isNaN(startsAt.getTime()))
              throw new ServerError(hubText('not a time: {from}', { from }));
            return {
              kind: 'schedule',
              intervalMs: every(args[1]),
              startsAt: startsAt.toISOString(),
            };
          })()
        : { kind: 'event', sourceAssetId: args[1], eventName: args[2] };
      const inputs = values.inputs?.length
        ? jsonObject(values.inputs.at(-1)!, 'inputs')
        : {};
      if (values.file?.length) inputs.files = attach(values.file, context);
      const listed = await optional<unknown>('/v1/skillpacks', []);
      const known = (Array.isArray(listed) ? listed : [])
        .filter(isRecord)
        .find((item) => item.skillPackId === pack);
      const label =
        known && isRecord(known.manifest) ? String(known.manifest.id) : pack;
      const name =
        values.name?.at(-1) ||
        (schedule ? `${label} every ${args[1]}` : `${label} on ${args[2]}`);
      const common = { scopeId: config.scopeId, version: '1.0.0', name };
      const made = asAsset(
        (
          await request('POST', '/v1/automations/triggers', {
            json: { ...common, ...trigger },
          })
        ).data,
      );
      const created = asAsset(
        (
          await request('POST', '/v1/automations/bots', {
            json: {
              ...common,
              skillPackId: pack,
              triggerAssetId: made.assetId,
              identityPrincipalId: config.principalId,
              channel: 'circle-events',
              inputs,
            },
          })
        ).data,
      );
      context.append(
        hubText(
          '✓ bot {id} · {name} · runs {pack} {trigger} as you · output to Circle · {lifecycle}',
          {
            id: created.assetId,
            name,
            pack,
            trigger: triggerText(made),
            lifecycle: created.lifecycle,
          },
        ),
      );
      context.append(
        hubText(
          '  someone else approves it: /hub bot approve {id} · then you turn it on: /hub bot start {id}',
          { id: created.assetId },
        ),
      );
      return;
    }
    if (verb === 'list') {
      const me = config?.principalId;
      const all = await bots();
      if (!all.length) {
        context.append(hubText('No bots you can see on this server'));
        return;
      }
      const seen = seenRuns();
      const rows: string[] = [];
      for (const item of all) {
        let trigger: Asset | undefined;
        try {
          trigger = await asset(String(item.configuration.triggerAssetId));
        } catch {
          trigger = undefined;
        }
        let runs = '';
        if (item.ownerPrincipalId === me) {
          const list = await botRuns(item.assetId).catch(() => []);
          const fresh = list.filter(
            (run) => news(run) && !seen.has(runKey(item.assetId, run)),
          ).length;
          runs = hubText(' · {n} run(s){fresh}', {
            n: list.length,
            fresh: fresh
              ? hubText(', {n} new: /hub bot runs {id}', {
                  n: fresh,
                  id: item.assetId,
                })
              : '',
          });
        } else runs = hubText(' · owner {id}', { id: item.ownerPrincipalId });
        rows.push(
          hubText(
            '  {id} · {name} · {lifecycle} · {trigger}{triggerState}{runs}',
            {
              id: item.assetId,
              name: item.name,
              lifecycle: item.lifecycle,
              trigger: triggerText(trigger),
              triggerState: trigger
                ? hubText(' (trigger {lifecycle})', {
                    lifecycle: trigger.lifecycle,
                  })
                : '',
              runs,
            },
          ),
        );
      }
      context.append(rows.join('\n'));
      return;
    }
    const [id] = rest;
    if (!id || !['approve', 'start', 'stop', 'runs'].includes(verb ?? ''))
      throw new ServerError(
        hubText(
          'usage: /hub bot list | every <pack> <interval> | on <pack> <source> <event> | approve <bot> | start <bot> | stop <bot> | runs <bot>',
        ),
      );
    const item = await asset(id);
    if (item.kind !== 'bot')
      throw new ServerError(hubText('{id} is not a bot', { id }));
    const triggerId = String(item.configuration.triggerAssetId ?? '');
    if (verb === 'approve' || verb === 'start') {
      // The trigger first: a running bot needs a running trigger before it fires.
      const target = verb === 'approve' ? 'approved' : 'running';
      for (const part of [await asset(triggerId), item]) {
        const what = hubText(part.kind === 'bot' ? 'bot' : 'trigger');
        if (
          (verb === 'approve' && part.lifecycle !== 'draft') ||
          (verb === 'start' && part.lifecycle === 'running')
        ) {
          context.append(
            hubText('  {what} {id} is already {lifecycle}', {
              what,
              id: part.assetId,
              lifecycle: part.lifecycle,
            }),
          );
          continue;
        }
        if (verb === 'start' && part.lifecycle !== 'approved')
          throw new ServerError(
            hubText(
              '{what} {id} is {lifecycle}; someone else approves it first: /hub bot approve {bot}',
              {
                what,
                id: part.assetId,
                lifecycle: part.lifecycle,
                bot: id,
              },
            ),
          );
        const moved = await move(part, target);
        context.append(
          hubText(
            '✓ {what} {id} {lifecycle} · version {version} · digest {digest}',
            {
              what,
              id: moved.assetId,
              lifecycle: moved.lifecycle,
              version: moved.version,
              digest: short(moved.sha256),
            },
          ),
        );
      }
      if (verb === 'start')
        context.append(
          hubText(
            '  {id} runs {trigger}; its results come to Circle: /hub bot runs {id}',
            { id, trigger: triggerText(await asset(triggerId)) },
          ),
        );
      return;
    }
    if (verb === 'stop') {
      const moved = await move(item, 'disabled');
      context.append(
        hubText('✓ bot {id} {lifecycle}; it starts no more runs', {
          id: moved.assetId,
          lifecycle: moved.lifecycle,
        }),
      );
      return;
    }
    const runs = await botRuns(id);
    if (!runs.length) {
      context.append(hubText('  {id} has not run yet', { id }));
      return;
    }
    const shown: string[] = [];
    for (const run of runs.slice(-10)) {
      // Occurrences a late approval or a stopped server missed, folded into this one run.
      const skipped = Number(run.trigger.skippedOccurrences ?? 0);
      const folded =
        skipped > 0
          ? hubText(
              ' · {n} missed occurrence(s) since {time} folded into this run',
              {
                n: skipped,
                time: String(run.trigger.firstDueAt),
              },
            )
          : '';
      if (!run.taskId) {
        context.append(
          hubText('  — · {key} · not started: {error}{folded}', {
            key: run.occurrenceKey,
            error: run.error || run.status,
            folded,
          }),
        );
        shown.push(runKey(id, run));
        continue;
      }
      const output = run.published ? await botOutput(run.taskId) : undefined;
      if (!output) {
        let phase = hubText('not published yet');
        try {
          phase = String((await status(run.taskId)).phase);
        } catch {
          /* The task is not readable now. */
        }
        context.append(
          `  ${run.taskId} · ${run.occurrenceKey} · ${phase}${folded}`,
        );
        continue;
      }
      const artifacts = Array.isArray(output.artifacts) ? output.artifacts : [];
      const unknowns = Array.isArray(output.unknowns)
        ? output.unknowns.map(String)
        : [];
      context.append(
        hubText(
          '  {task} · {key} · {status} · {n} file(s){unknown}{folded} · /hub get {task} saves them',
          {
            task: run.taskId,
            key: run.occurrenceKey,
            status: String(output.status),
            n: artifacts.length,
            unknown: unknowns.length
              ? hubText(' · unknown: {list}', { list: unknowns.join('; ') })
              : '',
            folded,
          },
        ),
      );
      for (const artifact of artifacts.filter(isRecord).slice(0, 5))
        context.append(
          hubText('    {name} · sha256 {hash}', {
            name: String(artifact.fileName ?? artifact.artifactId),
            hash: short(artifact.sha256),
          }),
        );
      shown.push(run.taskId);
    }
    if (runs.length > 10)
      context.append(
        hubText('  ({n} earlier run(s) not shown)', { n: runs.length - 10 }),
      );
    markSeen(shown);
    await showStatus();
  }

  // The approval id is not on the submission. It is the open approval on that task,
  // and the same id is the pending input's request id when the task is waiting.
  async function approvalNotice(taskId: string): Promise<string> {
    const current = await status(taskId).catch(() => undefined);
    const pending = (
      Array.isArray(current?.pendingInputs) ? current.pendingInputs : []
    )
      .filter(
        (item) =>
          isRecord(item) && item.status === 'open' && item.kind === 'approval',
      )
      .map((item) => String(item.requestId ?? ''))
      .filter(Boolean);
    const listed = rowsOf(
      await optional<unknown>(
        `/v1/tasks/${encodeURIComponent(taskId)}/approvals`,
        [],
      ),
    )
      .filter((item) => item.status === 'open')
      .map((item) => String(item.approvalId ?? ''))
      .filter(Boolean);
    const ids = [...new Set([...listed, ...pending])];
    if (!ids.length)
      return hubText(
        '  approval task {task} · no open approval id yet. /hub review lists them; /hub task {task} shows this task',
        { task: taskId },
      );
    return ids
      .map((id) =>
        hubText(
          '  waiting for approval {id} in {task} · someone else approves: /hub approve {task} {id}',
          { id, task: taskId },
        ),
      )
      .join('\n');
  }
  // circle-hub sends statusLabel and lifecycle on the pack (candidate is
  // "waiting for approval", registered is "approved" or "running"). An older
  // server sends only status, so the asset lifecycle is read then.
  async function packLine(pack: Record<string, unknown>): Promise<string> {
    const manifest = isRecord(pack.manifest) ? pack.manifest : {};
    const name = String(pack.id ?? manifest.id ?? '');
    const version = String(pack.version ?? manifest.version ?? '');
    const label = typeof pack.statusLabel === 'string' ? pack.statusLabel : '';
    let lifecycle = typeof pack.lifecycle === 'string' ? pack.lifecycle : '';
    const assetId = typeof pack.assetId === 'string' ? pack.assetId : '';
    if (!label && !lifecycle && assetId) {
      const asset = await optional<unknown>(
        `/v1/assets/${encodeURIComponent(assetId)}`,
        undefined,
      );
      if (isRecord(asset) && typeof asset.lifecycle === 'string')
        lifecycle = asset.lifecycle;
    }
    const status = String(pack.status ?? '');
    const shown = label
      ? lifecycle
        ? hubText('{label} · lifecycle {lifecycle}', { label, lifecycle })
        : label
      : status === 'registered' && lifecycle
        ? hubText('{lifecycle} (server status registered)', { lifecycle })
        : lifecycle
          ? hubText('{status} · asset {lifecycle}', { status, lifecycle })
          : status;
    return `  ${String(pack.skillPackId ?? '')} · ${name} ${version} · ${shown}`
      .replace(/ +/g, ' ')
      .trimEnd();
  }

  function shownTitle(title: string): string {
    const approve = /^approve skill pack (.*)$/.exec(title);
    if (approve) return hubText('approve skill pack {id}', { id: approve[1]! });
    const skill = /^skill pack (.*)$/.exec(title);
    if (skill) return hubText('skill pack {id}', { id: skill[1]! });
    return title;
  }
  function acceptedLine(task: {
    taskId: string;
    phase: string;
    inputRevisionId: string;
    deduplicated: boolean;
  }): string {
    return hubText(
      '✓ accepted {task} · {phase} · input {input}{same} · following it; closing Circle does not stop it',
      {
        task: task.taskId,
        phase: task.phase,
        input: task.inputRevisionId,
        same: task.deduplicated
          ? hubText(' · the same request as before, no new task')
          : '',
      },
    );
  }

  const commands: Record<
    string,
    (rest: string[], context: CommandContext) => Promise<void>
  > = {
    async login(args, context) {
      if (fromRun)
        throw new ServerError(
          hubText(
            'Circle runs with a token from hub here; there is no sign-in',
          ),
        );
      let address = args[0];
      let username = args[1];
      if (args.length === 1 && !/^https?:\/\//i.test(args[0] ?? '')) {
        username = args[0];
        address = knownUrl();
      }
      if (!address || !username || args.length > 2)
        throw new ServerError(hubText('usage: /hub login [url] <user>'));
      const url = serverUrl(address);
      rememberAddress(url, username);
      const given = context.secret;
      const password =
        typeof given === 'string' && given.length > 0
          ? given
          : await api.askSecret(
              hubText('Password for {user} on {url}', { user: username, url }),
            );
      if (password === null) {
        context.append(hubText('Sign-in cancelled'));
        return;
      }
      api.conceal(password);
      const scopes = await signIn(url, username, password);
      await collectObjects().catch(() => {});
      const { data: about } = await request('GET', '/v1/status');
      context.append(
        hubText('● signed in to {url} as {user}{scope}{api}', {
          url,
          user: username,
          scope: scopes.length
            ? hubText(' · scope {id}', { id: String(scopes[0]) })
            : '',
          api:
            isRecord(about) && about.apiVersion
              ? hubText(' · api {version}', {
                  version: String(about.apiVersion),
                })
              : '',
        }),
      );
      await announceTools(context);
      api.background(lookForBots());
    },
    async logout(_rest, context) {
      if (fromRun)
        throw new ServerError(
          hubText(
            'Circle runs with a token from hub here; there is no sign-out',
          ),
        );
      // Revoke the whole token family at the server first; a server without the
      // route, or one that already forgot the token, does not trap the local sign-out.
      try {
        await request('POST', '/v1/auth/logout', { json: {} });
      } catch {
        /* the local sign-out stands */
      }
      const removed = await api.secrets.delete('token');
      const config = readConfig();
      if (config) writeJson('config.json', { ...config, expiresAt: undefined });
      if (refreshTimer) clearTimeout(refreshTimer);
      dropServerTools();
      api.background(showStatus());
      context.append(
        removed ? hubText('Signed out') : hubText('Not signed in'),
      );
    },
    async packs(_rest, context) {
      const { data } = await request('GET', '/v1/packs');
      const packs = (Array.isArray(data) ? data : []).filter(isRecord);
      context.append(
        packs.length
          ? packs
              .map(
                (pack) =>
                  `  ${String(pack.capabilityPackId)} ${String(pack.version ?? pack.packVersion ?? '')}${pack.title || pack.description ? ' · ' + String(pack.title ?? pack.description) : ''}${Array.isArray(pack.inputFormats) ? ' · ' + pack.inputFormats.join(', ') : ''}`,
              )
              .join('\n')
          : hubText('The server lists no capability packs'),
      );
    },
    async submit(rest, context) {
      const again = rest.includes('--again');
      const [pack, ...files] = rest.filter((word) => word !== '--again');
      if (pack === 'module-execute') {
        if (files.length !== 1)
          throw new ServerError(
            hubText('usage: /hub submit module-execute <input-json> [--again]'),
          );
        let flow: unknown;
        try {
          flow = JSON.parse(files[0]!);
        } catch {
          throw new ServerError(
            hubText('module-execute takes the flow input as a JSON object'),
          );
        }
        if (!isRecord(flow))
          throw new ServerError(
            hubText('module-execute takes the flow input as a JSON object'),
          );
        const task = await handOver(pack, '', again, context, flow);
        context.append(acceptedLine(task));
        void follow(task.taskId, context);
        return;
      }
      if (!pack || files.length !== 1)
        throw new ServerError(
          hubText('usage: /hub submit <pack> <file> [--again]'),
        );
      const task = await handOver(pack, files[0]!, again, context);
      context.append(acceptedLine(task));
      api.background(follow(task.taskId, context));
    },
    async tasks(_rest, context) {
      const known = Object.entries(followed());
      if (!known.length) {
        context.append(hubText('No tasks handed over from here'));
        return;
      }
      const rows: string[] = [];
      for (const [taskId, item] of known.slice(-20)) {
        let phase = '?';
        try {
          phase = String((await status(taskId)).phase);
        } catch (error) {
          phase = reason(error);
        }
        rows.push(
          hubText('  {task} · {phase} · {title} · seen to {seq}', {
            task: taskId,
            phase,
            title: shownTitle(item.title),
            seq: item.seq,
          }),
        );
      }
      context.append(rows.join('\n'));
    },
    async task([taskId], context) {
      if (!taskId) throw new ServerError(hubText('usage: /hub task <id>'));
      const current = await status(taskId);
      if (!followed()[taskId])
        remember(taskId, { title: String(current.title ?? ''), seq: 0 });
      context.append(
        hubText('  {task} · {phase} · {title} · input {input}', {
          task: taskId,
          phase: String(current.phase),
          title: String(current.title ?? ''),
          input: String(current.inputRevisionId),
        }),
      );
      api.background(follow(taskId, context));
    },
    async respond([taskId, ...answer], context) {
      if (!taskId || !answer.length)
        throw new ServerError(hubText('usage: /hub respond <id> <answer>'));
      const current = await status(taskId);
      const open = (
        Array.isArray(current.pendingInputs) ? current.pendingInputs : []
      ).find(
        (item) =>
          isRecord(item) &&
          item.status === 'open' &&
          item.inputRevisionId === current.inputRevisionId,
      );
      if (!isRecord(open))
        throw new ServerError(
          hubText(
            '{task} is not waiting for an answer. /hub task {task} shows its phase; an approval is /hub approve, and /hub review lists those.',
            { task: taskId },
          ),
        );
      if (open.kind === 'approval')
        throw new ServerError(
          hubText(
            '{task} is waiting for a decision, not a text answer ({request}). Someone else runs /hub approve {task} {request}. /hub review lists open approvals.',
            { task: taskId, request: String(open.requestId) },
          ),
        );
      // A repair input is a replacement of the bound input; anything else is a response.
      const repair = open.kind === 'repair';
      await request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/input`, {
        json: {
          inputRevisionId: current.inputRevisionId,
          requestId: open.requestId,
          ...(repair
            ? { replacement: answerOf(answer.join(' ')) }
            : { response: answerOf(answer.join(' ')) }),
        },
      });
      context.append(
        repair
          ? hubText('✓ replaced the input of {task} ({request})', {
              task: taskId,
              request: String(open.requestId),
            })
          : hubText('✓ answered {task} ({request})', {
              task: taskId,
              request: String(open.requestId),
            }),
      );
      api.background(follow(taskId, context));
    },
    async get([taskId], context) {
      if (!taskId) throw new ServerError(hubText('usage: /hub get <id>'));
      await deliver(taskId, context);
    },
    async refresh(_rest, context) {
      const counts = await collectObjects();
      context.append(
        hubText(
          '  read {tasks} tasks and {packs} capability packs from the server (work tasks for the pages, at most 20, not tool or index tasks). /hub tasks lists only what this window handed over; "seen to N" there is the last event number shown for that task',
          { tasks: counts.tasks, packs: counts.packs },
        ),
      );
      await announceTools(context);
    },
    async trial(rest, context) {
      const [verb, flag] = rest;
      if (verb !== 'start' || (flag && flag !== '--force') || rest.length > 2)
        throw new ServerError(hubText('usage: /hub trial start [--force]'));
      context.append(beginTrial(flag === '--force').line);
    },
    async skill([verb, ...rest], context) {
      if (verb === 'push') return pushSkill(rest, context);
      if (verb === 'list') {
        const { data } = await request('GET', '/v1/skillpacks');
        const packs = (Array.isArray(data) ? data : []).filter(isRecord);
        context.append(
          packs.length
            ? (await Promise.all(packs.map((pack) => packLine(pack)))).join(
                '\n',
              )
            : hubText('No skill packs on this server'),
        );
        return;
      }
      if (verb === 'run') {
        // --file <path> attaches a file of the workspace as inputs.files.
        const attached: string[] = [];
        const words: string[] = [];
        for (let i = 0; i < rest.length; i++)
          if (rest[i] === '--file' && rest[i + 1]) attached.push(rest[++i]!);
          else words.push(rest[i]!);
        const [id, ...json] = words;
        if (!id)
          throw new ServerError(
            hubText(
              'usage: /hub skill run <id> [json inputs] [--file <path>]…',
            ),
          );
        const inputs = json.length ? jsonObject(json.join(' '), 'inputs') : {};
        if (attached.length) inputs.files = attach(attached, context);
        const { data } = await request(
          'POST',
          `/v1/skillpacks/${encodeURIComponent(id)}/runs`,
          { json: { inputs, idempotencyKey: randomUUID() } },
        );
        const taskId = isRecord(data) ? String(data.taskId ?? '') : '';
        if (!taskId)
          throw new ServerError(hubText('the server started no task'));
        remember(taskId, { title: `skill pack ${id}`, seq: 0 });
        context.append(
          hubText('✓ running {id} on the server as {task} · following it', {
            id,
            task: taskId,
          }),
        );
        api.background(follow(taskId, context));
        return;
      }
      throw new ServerError(
        hubText('usage: /hub skill push <folder> | list | run <id> [json]'),
      );
    },
    async tools(_rest, context) {
      catalogTag = '';
      await announceTools(context, true);
    },
    bot,
    async approve(rest, context) {
      await decide(rest, true, context);
    },
    async reject(rest, context) {
      await decide(rest, false, context);
    },
    async reconcile([taskId, operationId], context) {
      if (!taskId)
        throw new ServerError(
          hubText('usage: /hub reconcile <id> [operationId]'),
        );
      // Only a request naming the operation is a real reconciliation; without one
      // the server answers with an explanation of what is missing.
      const { data } = await request(
        'POST',
        `/v1/tasks/${encodeURIComponent(taskId)}/reconcile`,
        { json: operationId ? { operationId } : {} },
      );
      const payload = isRecord(data) ? data : {};
      const explained =
        !operationId && typeof payload.reconciliation === 'string'
          ? payload.reconciliation
          : !operationId
            ? hubText('name the operation: /hub reconcile <id> <operationId>')
            : String(payload.status ?? 'accepted');
      // The first line is the heading. A long explanation used to sit on the
      // same line as the task id, so a wrap had nothing to show as the title.
      context.append(
        operationId
          ? hubText('✓ reconcile {task} · {status}', {
              task: taskId,
              status: explained,
            })
          : hubText('reconcile {task}\n  {detail}', {
              task: taskId,
              detail: explained,
            }),
      );
      await collectObjects().catch(() => {});
    },
    async review(_rest, context) {
      // circle-hub 0.2.0 has no browser page. The queue is the paged task list.
      const { data } = await request(
        'GET',
        '/v1/tasks?view=page&queue=awaitingMyApproval&limit=20',
      );
      const tasks = rowsOf(data);
      if (!tasks.length) {
        context.append(
          hubText(
            'Nothing is waiting for your approval. /hub task <id> shows one task. Knowledge claims are reviewed one id at a time (GET /v1/knowledge/reviews/<id>); this server has no page that lists them.',
          ),
        );
        return;
      }
      const lines: string[] = [];
      for (const task of tasks) {
        const taskId = String(task.taskId ?? '');
        if (!taskId) continue;
        lines.push(
          `  ${taskId} · ${String(task.phase ?? '')} · ${String(task.title ?? '')}`,
        );
        lines.push(await approvalNotice(taskId));
      }
      context.append(lines.join('\n'));
    },
    async audit(_rest, context) {
      let data: unknown;
      try {
        ({ data } = await request('GET', '/v1/admin/audit'));
      } catch (error) {
        if (
          error instanceof ServerError &&
          (error.code === 'FORBIDDEN_ACTION' || error.status === 403)
        )
          throw new ServerError(
            hubText(
              'audit needs admin.manage on this server. There is no browser page; GET /v1/admin/audit is the list.',
            ),
          );
        throw error;
      }
      const rows = rowsOf(data).slice(0, 20);
      context.append(
        rows.length
          ? rows
              .map((row) => {
                const detail = isRecord(row.detail)
                  ? Object.keys(row.detail).slice(0, 4).join(', ')
                  : '';
                return `  ${String(row.id ?? '')} · ${String(row.action ?? '')} · ${String(row.principalId ?? '')}${row.scopeId ? ' · ' + String(row.scopeId) : ''}${detail ? ' · ' + detail : ''}`;
              })
              .join('\n')
          : hubText(
              'No audit rows. GET /v1/admin/audit is the list; this server has no browser page for it.',
            ),
      );
    },
    async modules(_rest, context) {
      // No GET /v1/modules and no browser page. Skill packs and the assets a
      // module install creates are what the server will list.
      const packs = rowsOf(await optional<unknown>('/v1/skillpacks', []));
      const skills = rowsOf(
        await optional<unknown>('/v1/assets?kind=skill-package&limit=100', []),
      );
      const sources = rowsOf(
        await optional<unknown>(
          '/v1/assets?kind=knowledge-source&limit=100',
          [],
        ),
      );
      const lines: string[] = [];
      for (const pack of packs.slice(0, 20)) lines.push(await packLine(pack));
      for (const asset of [...skills, ...sources].slice(0, 40)) {
        const configuration = isRecord(asset.configuration)
          ? asset.configuration
          : {};
        const module = isRecord(configuration.module)
          ? configuration.module
          : undefined;
        const label = module
          ? `${String(module.id ?? '')} ${String(module.version ?? '')}`.trim()
          : String(asset.name ?? '');
        lines.push(
          `  ${String(asset.assetId ?? '')} · ${String(asset.kind ?? '')} · ${label} · ${String(asset.lifecycle ?? asset.version ?? '')}`,
        );
      }
      context.append(
        lines.length
          ? lines.join('\n')
          : hubText(
              'No modules listed. circle-hub has no browser page for them. Install is POST /v1/modules/install (server CLI: node apps/server/src/cli.ts modules install). This command reads GET /v1/skillpacks and GET /v1/assets.',
            ),
      );
    },
  };
  // A decision on an action a task waits on, bound to what the server says it is: the
  // input revision, the target's identity and the action's digest.
  async function decide(
    [taskId, approvalId]: string[],
    approve: boolean,
    context: CommandContext,
  ): Promise<void> {
    if (!taskId || !approvalId)
      throw new ServerError(
        approve
          ? hubText('usage: /hub approve <id> <approval>')
          : hubText('usage: /hub reject <id> <approval>'),
      );
    const path = `/v1/tasks/${encodeURIComponent(taskId)}/approvals`;
    const { data } = await request('GET', path);
    const found = (Array.isArray(data) ? data : []).find(
      (item) => isRecord(item) && item.approvalId === approvalId,
    );
    if (!isRecord(found))
      throw new ServerError(
        hubText('{task} has no approval {approval}', {
          task: taskId,
          approval: approvalId,
        }),
      );
    await request('POST', `${path}/${encodeURIComponent(approvalId)}`, {
      json: {
        inputRevisionId: found.inputRevisionId,
        targetIdentity: found.targetIdentity,
        actionDigest: found.actionDigest,
        approve,
      },
    });
    context.append(
      hubText(
        approve
          ? '✓ approved {approval} for {task} (input {input})'
          : '✓ rejected {approval} for {task} (input {input})',
        {
          approval: approvalId,
          task: taskId,
          input: String(found.inputRevisionId),
        },
      ),
    );
    // The pack status word stays `registered` after approval. Re-read the asset
    // lifecycle so the line shows what actually changed.
    const packs = rowsOf(await optional<unknown>('/v1/skillpacks', []));
    const touched = packs.filter(
      (pack) => pack.approvalTaskId === taskId || pack.assetId === found.target,
    );
    if (touched.length)
      context.append(
        (await Promise.all(touched.map((pack) => packLine(pack)))).join('\n'),
      );
    else {
      const target = typeof found.target === 'string' ? found.target : '';
      const asset = target
        ? await optional<unknown>(
            `/v1/assets/${encodeURIComponent(target)}`,
            undefined,
          )
        : undefined;
      if (isRecord(asset) && typeof asset.lifecycle === 'string')
        context.append(`  ${target} · ${asset.lifecycle}`);
    }
    await collectObjects().catch(() => {});
  }

  // The same work as tools, for a model that is told to hand work to the server.
  api.registerTool(
    'hub_packs',
    'List what the connected hub can do: its capability packs, their input formats, the input each one takes (inputSchema) and versions. Read-only.',
    { type: 'object', properties: {} },
    async () => (await request('GET', '/v1/packs')).data,
    { readOnly: true },
  );
  api.registerTool(
    'hub_task',
    'Look up a hub task by id: its phase and, once it has ended, its result (status, artifacts with their SHA-256, the independent check, unmapped items). Read-only; saves nothing.',
    {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    async (args) => {
      const taskId = String(args.task_id ?? '');
      if (!taskId) throw new api.ToolError(hubText('task_id is required'));
      const task = await status(taskId);
      const ended = TERMINAL.has(String(task.phase));
      return {
        task,
        result: ended
          ? (
              await request(
                'GET',
                `/v1/tasks/${encodeURIComponent(taskId)}/result`,
              )
            ).data
          : null,
      };
    },
    { readOnly: true },
  );
  api.registerTool(
    'hub_submit',
    'Hand hub a task with a capability pack: for a file pack (for example mindmap-compile) give the workspace file; for module-execute give the flow input object instead (flowId, methodPin, resources, sources, value, controlledBytes — the hub validates it strictly). The server keeps the task; this waits in the background and, once it is delivered, saves the results in the workspace after checking their SHA-256. It sends the file to the server and writes files, so it asks first.',
    {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'capability pack id' },
        file: {
          type: 'string',
          description: 'path in the workspace (file packs)',
        },
        input: {
          type: 'object',
          description:
            'module-execute: the whole flow input. Other packs: the rest of the task input the pack asks for, for example the asset ids it binds and the build; the uploaded file’s sourceRevisionId and sourceSha256 are filled in here',
        },
      },
      required: ['pack'],
    },
    async (args) => {
      const pack = String(args.pack ?? '');
      const file = String(args.file ?? '');
      if (!pack) throw new api.ToolError(hubText('pack is required'));
      if (args.input !== undefined && !isRecord(args.input))
        throw new api.ToolError(
          hubText('input is an object of task input fields'),
        );
      if (pack === 'module-execute' && !isRecord(args.input))
        throw new api.ToolError(
          hubText('module-execute needs the flow input object'),
        );
      if (pack !== 'module-execute' && !file)
        throw new api.ToolError(hubText('file is required'));
      const accepted = collecting();
      let task;
      try {
        task = await handOver(
          pack,
          file,
          false,
          accepted.context,
          isRecord(args.input) ? args.input : {},
        );
      } catch (error) {
        throw new api.ToolError(reason(error));
      }
      const taskId = task.taskId;
      return new api.Watch(
        hubText('hub {task}', { task: taskId }),
        async () => {
          const current = await status(taskId);
          const phase = String(current.phase ?? '');
          if (!TERMINAL.has(phase)) return null;
          const done = collecting();
          if (phase === 'delivered') await deliver(taskId, done.context);
          return { taskId, phase, lines: done.lines };
        },
        {
          interval_s: 3,
          deadline_s: 3600,
          result: { ...task, lines: accepted.lines },
        },
      );
    },
  );
  // A model that fixes a skill pack records its trial and sends the new version itself.
  // Sending is not registering: someone else still approves the new digest on the server.
  api.registerTool(
    'hub_trial_start',
    'Start recording which hub tools the model calls: the trial record a skill pack is pushed with, as /hub trial start does. If that record already has calls that were not pushed, it stays and the result says so; pass force true to drop them. Start it before the trial run of a new or changed skill pack. skillpack.json outputs are required; the call record may be empty.',
    {
      type: 'object',
      properties: {
        force: {
          type: 'boolean',
          description:
            'drop unpushed trial calls and record from now. Without it, a non-empty record is left as it is',
        },
      },
    },
    async (args) => {
      const started = beginTrial(args.force === true);
      return started.recording
        ? {
            recording: true,
            startedAt: trial.startedAt,
            dropped: started.dropped,
          }
        : {
            recording: false,
            calls: trial.calls.length,
            warning: started.line.trim(),
          };
    },
  );
  api.registerTool(
    'hub_skill_push',
    'Submit a skill pack folder of the workspace (skillpack.json, SKILL.md and its files) to hub with the current trial record and the SHA-256 of the files the trial produced, as /hub skill push does. The server checks the tools the trial used against the pack; someone else must approve the new digest before it runs there. It sends the folder, so it asks first.',
    {
      type: 'object',
      properties: {
        folder: {
          type: 'string',
          description: 'the skill pack folder, a path in the workspace',
        },
        outputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'files the trial produced, paths in the workspace',
        },
      },
      required: ['folder'],
    },
    async (args) => {
      const folder = String(args.folder ?? '');
      if (!folder) throw new api.ToolError(hubText('folder is required'));
      const outputs = Array.isArray(args.outputs)
        ? args.outputs.map(String).filter(Boolean)
        : [];
      const sent = collecting();
      try {
        await pushSkill(
          outputs.length ? [folder, '--outputs', outputs.join(',')] : [folder],
          sent.context,
        );
      } catch (error) {
        throw new api.ToolError(reason(error));
      }
      return { lines: sent.lines };
    },
  );
  // Files of the workspace kept on the server as one versioned source artifact: a command
  // tree, a contract, any original a tool should read instead of the network. Registering is
  // not approving: someone else approves the asset before its sar_ id can be used.
  api.registerTool(
    'hub_source_artifact',
    'Register files of the workspace on hub as one versioned source artifact (a knowledge-source asset): each file is uploaded as an original with its SHA-256 and listed with its role. The server keeps it as a draft until someone else approves it; hub_source_artifact_status then gives its sourceArtifactId (sar_…), which server tools take as sourceArtifactId. A new version of an artifact you registered before takes its asset_id. It sends the files to the server, so it asks first.',
    {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'the artifact name' },
        version: {
          type: 'string',
          description: 'a new version for changed contents',
        },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'path in the workspace' },
              role: {
                type: 'string',
                description:
                  'what the file is to the tools that read it, for example command-tree',
              },
              mediaType: { type: 'string' },
            },
            required: ['path', 'role'],
          },
        },
        metadata: {
          type: 'object',
          description:
            'what the uploader expects the artifact to be, for example the build it is meant for; readers take it as a claim, not a fact',
        },
        readers: {
          type: 'array',
          items: { type: 'string' },
          description:
            'principal ids besides you who may see the draft, such as the person who approves it',
        },
        asset_id: {
          type: 'string',
          description:
            'the asset id of an artifact you registered before, for a new version of it',
        },
      },
      required: ['name', 'version', 'files'],
    },
    async (args) => {
      const config = readConfig();
      if (!config?.scopeId)
        throw new api.ToolError(
          hubText('no scope: sign in again with /hub login <url> <user>'),
        );
      const name = String(args.name ?? '');
      const version = String(args.version ?? '');
      const files = Array.isArray(args.files) ? args.files : [];
      if (!name || !version || !files.length)
        throw new api.ToolError(
          hubText('name, version and at least one file are required'),
        );
      if (args.metadata !== undefined && !isRecord(args.metadata))
        throw new api.ToolError(hubText('metadata is an object'));
      const listed: Record<string, unknown>[] = [];
      try {
        for (const file of files) {
          if (!isRecord(file) || typeof file.path !== 'string' || !file.path)
            throw new ServerError(
              hubText('each file needs a path in the workspace'),
            );
          if (typeof file.role !== 'string' || !file.role)
            throw new ServerError(
              hubText('{path}: role is required', { path: file.path }),
            );
          const path = resolve(api.workspace, file.path);
          const inside = relative(api.workspace, path);
          if (!inside || inside.startsWith('..') || isAbsolute(inside))
            throw new ServerError(
              hubText('{path} is outside the workspace', { path: file.path }),
            );
          if (!existsSync(path))
            throw new ServerError(
              hubText('no such file: {path}', { path: file.path }),
            );
          const source = await upload(path, config.scopeId);
          listed.push({
            path: inside.split(sep).join('/'),
            role: file.role,
            ...(typeof file.mediaType === 'string'
              ? { mediaType: file.mediaType }
              : {}),
            sourceRevisionId: source.id,
            sha256: source.sha256,
          });
        }
        // The platform's own chain: originals through /v1/sources, the artifact as a
        // knowledge-source asset, approved through the asset lifecycle like any other.
        const readers = [
          ...new Set(
            [
              config.principalId,
              ...(Array.isArray(args.readers) ? args.readers.map(String) : []),
            ].filter((reader): reader is string => Boolean(reader)),
          ),
        ];
        const { data } = await request('POST', '/v1/assets', {
          json: {
            ...(typeof args.asset_id === 'string' && args.asset_id
              ? { assetId: args.asset_id }
              : {}),
            scopeId: config.scopeId,
            kind: 'knowledge-source',
            name,
            version,
            declaration: {
              reads: ['registered-source'],
              writes: [],
              credentials: [],
            },
            configuration: {
              schema: 'external-source-artifact/1',
              metadata: isRecord(args.metadata) ? args.metadata : {},
              files: listed,
            },
            ...(readers.length ? { readers } : {}),
          },
        });
        const approvalTaskId =
          isRecord(data) && typeof data.approvalTaskId === 'string'
            ? data.approvalTaskId
            : '';
        const notice = approvalTaskId
          ? await approvalNotice(approvalTaskId)
          : '';
        return {
          registered: data,
          files: listed,
          ...(approvalTaskId ? { approvalTaskId } : {}),
          ...(notice ? { approve: notice.trim() } : {}),
          next: notice
            ? notice.trim()
            : hubText(
                'someone else approves the asset; the reply names approvalTaskId when the server sends one, and /hub review lists open approvals. Then hub_source_artifact_status gives the sourceArtifactId',
              ),
        };
      } catch (error) {
        throw new api.ToolError(reason(error));
      }
    },
  );
  api.registerTool(
    'hub_source_artifact_status',
    'Look up a source artifact on hub by its asset id: its version, lifecycle, files with their SHA-256 and, once someone else has approved it, its sourceArtifactId (sar_…). Read-only.',
    {
      type: 'object',
      properties: { asset_id: { type: 'string' } },
      required: ['asset_id'],
    },
    async (args) => {
      const id = String(args.asset_id ?? '');
      if (!id) throw new api.ToolError(hubText('asset_id is required'));
      try {
        return (await request('GET', `/v1/assets/${encodeURIComponent(id)}`))
          .data;
      } catch (error) {
        throw new api.ToolError(reason(error));
      }
    },
    { readOnly: true },
  );
  // The original bytes of a knowledge record, an evidence record or an artifact, for a skill
  // that must read them (apv-mindmap-compile's --bed-facts). Saved in the workspace after
  // the bytes are checked against the SHA-256 the server sends; the reply names the path,
  // never the content.
  api.registerTool(
    'hub_evidence',
    'Read the content of a hub record by id: knr_… a knowledge record, evd_… an evidence record, art_… an artifact. The bytes are checked against the SHA-256 the server sends (x-content-sha256) and saved under evidence/ in the workspace (or at save_as), never overwriting; the reply names the saved path, its SHA-256 and size, never the content. Read-only on the server.',
    {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'knr_…, evd_… or art_…',
        },
        save_as: {
          type: 'string',
          description:
            'a relative path in the workspace to save to instead of evidence/<id>.<ext>',
        },
      },
      required: ['id'],
    },
    async (args) => {
      const id = String(args.id ?? '');
      const route = id.startsWith('knr_')
        ? `/v1/knowledge/records/${encodeURIComponent(id)}/content`
        : id.startsWith('evd_')
          ? `/v1/evidence/${encodeURIComponent(id)}/content`
          : id.startsWith('art_')
            ? `/v1/artifacts/${encodeURIComponent(id)}/content`
            : '';
      if (!route)
        throw new api.ToolError(
          hubText(
            'id must start with knr_ (knowledge record), evd_ (evidence) or art_ (artifact): {id}',
            { id: id || '(empty)' },
          ),
        );
      const workspace = api.workspace;
      if (!workspace)
        throw new api.ToolError(
          hubText('no workspace to save the content into'),
        );
      const saveAs =
        typeof args.save_as === 'string' && args.save_as ? args.save_as : '';
      const wanted = saveAs ? resolve(workspace, saveAs) : '';
      if (saveAs) {
        const inside = relative(workspace, wanted);
        if (!inside || inside.startsWith('..') || isAbsolute(inside))
          throw new api.ToolError(
            hubText('save_as {path} is outside the workspace', {
              path: saveAs,
            }),
          );
      }
      let bytes: Buffer;
      let headers: Headers;
      try {
        ({ bytes, headers } = await request('GET', route, {
          raw: true,
          timeoutMs: 120_000,
        }));
      } catch (error) {
        throw new api.ToolError(reason(error));
      }
      const actual = sha256(bytes);
      const declared = headers.get('x-content-sha256');
      if (declared && declared !== actual)
        throw new api.ToolError(
          hubText(
            "the bytes (sha256 {actual}) do not match the server's SHA-256 ({expected}); not saved",
            { actual: short(actual), expected: short(declared) },
          ),
        );
      const mediaType =
        (headers.get('content-type') ?? '')
          .split(';')[0]
          ?.trim()
          .toLowerCase() ?? '';
      const directory = saveAs ? dirname(wanted) : join(workspace, 'evidence');
      const name = saveAs
        ? basename(wanted)
        : `${id}.${EXTENSIONS[mediaType] ?? 'bin'}`;
      mkdirSync(directory, { recursive: true });
      const path = freePath(directory, name);
      writeFileSync(path, bytes, { flag: 'wx' });
      return {
        id,
        path: relative(workspace, path).split(sep).join('/'),
        sha256: actual,
        bytes: bytes.byteLength,
        mediaType: mediaType || 'application/octet-stream',
      };
    },
    { readOnly: true },
  );
  api.background(showStatus());
  scheduleRefresh();
  api.background(lookForBots());
  api.registerCommand(
    'hub',
    hubText(
      'Work with a hub: /hub [help | login | logout | packs | submit | tasks | task | respond | get | refresh | review | audit | modules | tools | skill | bot]',
    ),
    async (args, context) => {
      const [verb, ...rest] = words(args);
      const place = (
        signedIn: boolean,
        url: string,
        config: Config | undefined,
      ): string =>
        `${signedIn ? '●' : '○'} ${url}${config?.username ? ' · ' + config.username : ''}${
          config?.scopeId
            ? hubText(' · scope {id}', { id: config.scopeId })
            : ''
        }${signedIn ? '' : hubText(' · not signed in')}`;
      if (!verb || verb === 'help') {
        const config = readConfig();
        const signedIn = Boolean(await currentToken());
        const url = config?.url || DEFAULT_HUB_URL;
        if (verb === 'help') {
          context.append(`${place(signedIn, url, config)}\n${usageText()}`);
          return;
        }
        context.append(
          `${place(signedIn, url, config)}\n${hubText('/hub help lists the commands')}`,
        );
        return;
      }
      const command = commands[verb];
      if (!command)
        throw new ServerError(
          hubText('unknown: /hub {verb}\n{usage}', {
            verb,
            usage: usageText(),
          }),
        );
      try {
        await command(rest, recording(context));
      } catch (error) {
        throw new ServerError(explainFailure(error));
      }
    },
  );
}

// The circle-server connector. It ships with Circle and is off until `/extensions enable
// circle-server`. It signs in to a server, hands it work with your files, follows the work
// while it runs and saves what the server delivers. The task lives on the server: closing
// Circle does not stop it, and `/server task <id>` picks it up where this window left off.
//
// This file is loaded as written (Node strips the types), so it uses only syntax that
// type stripping accepts and imports nothing from Circle at run time.
import { createHash, randomUUID } from 'node:crypto';
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
}
// What a refusal names besides its message (the rows, tools or limits it is about), kept
// short so a model reads it beside the code instead of a whole response.
const MAX_DETAIL_CHARS = 2000;

// A task in one of these phases changes no more; `unknown` waits for someone to check.
const TERMINAL = new Set(['delivered', 'failed', 'cancelled', 'unknown']);
const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;
const USAGE = [
  '/server                          where you are signed in',
  '/server login <url> <user>       sign in; the password is asked on a masked card',
  '/server logout                   forget the token',
  '/server packs                    what the server can do',
  '/server submit <pack> <file>     hand it work with this file, follow it, save the results',
  '/server tasks                    the tasks you handed over from here',
  '/server task <id>                show a task and follow it until it ends',
  '/server respond <id> <answer>    answer what a task is waiting on (text, key=value or JSON)',
  '/server get <id>                 save a delivered task’s results again',
  '/server refresh                  read work, execution, knowledge and methods from the server',
  '/server approve <id> <approval>  approve an action a task waits on (reject: /server reject …)',
  '/server reconcile <id>           ask the server to check an operation whose outcome is unknown',
  '/server tools                    the server’s tools the model can use, read again',
  '/server trial start              record the server tool calls of a trial run from now',
  '/server skill push <folder>      submit a skill pack with the trial record (--outputs a,b)',
  '/server skill list               the skill packs on the server',
  '/server skill run <id> [json]    run a skill pack on the server and follow it (--file <path> attaches)',
  '/server bot list                 the bots you can see; yours with their runs and new results',
  '/server bot every <pack> <1h>    a bot that runs a skill pack on a schedule (--from, --inputs, --file, --name)',
  '/server bot on <pack> <source> <event>  a bot that runs a skill pack when a connector reports the event',
  '/server bot approve <bot>        approve someone else’s bot and its trigger',
  '/server bot start|stop <bot>     turn your approved bot on or off',
  '/server bot runs <bot>           its runs and what each delivered to Circle',
].join('\n');

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
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  // A program that runs Circle on a server's behalf (circle-server's own runner) hands over
  // the address and a short-lived token in the environment. Nothing is written to disk then,
  // and a token the server turns down is not asked for again.
  const runUrl = process.env.CIRCLE_SERVER_URL?.trim() ?? '';
  const runToken = process.env.CIRCLE_SERVER_TOKEN?.trim() ?? '';
  const fromRun = Boolean(runUrl && runToken);
  async function currentToken(): Promise<string | null | undefined> {
    return fromRun ? runToken : api.secrets.get('token');
  }
  function readConfig(): Config | undefined {
    if (fromRun)
      return {
        url: runUrl,
        username: process.env.CIRCLE_SERVER_USER?.trim() ?? '',
        scopeId: process.env.CIRCLE_SERVER_SCOPE?.trim() || undefined,
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
    // An address given in settings.json under extensions.circle-server.url.
    const url = api.settings.url;
    return typeof url === 'string' && url ? { url, username: '' } : undefined;
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
  // The four platform objects as the server last reported them (/server refresh).
  let objects: Record<string, unknown> | undefined;
  function publishView(signedIn: boolean): void {
    const config = readConfig();
    const view = {
      url: config?.url ?? '',
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
    try {
      api.setView(view);
    } catch {
      // Too much to show: keep the connection and tasks, drop the objects.
      api.setView({ ...view, objects: undefined });
    }
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
    objects = {
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
      skillPacks: (Array.isArray(pushed) ? pushed : [])
        .filter(isRecord)
        .map((item) => {
          const manifest = isRecord(item.manifest) ? item.manifest : {};
          return {
            skillPackId: item.skillPackId,
            id: item.id ?? manifest.id,
            version: item.version ?? manifest.version,
            status: item.status,
          };
        }),
      bots: botViews,
      background,
    };
    await showStatus();
    return { tasks: tasks.length, packs: methods.length };
  }
  // A context whose lines are also kept for the view.
  function recording(context: CommandContext): CommandContext {
    const keep = (line: string): void => {
      recent.push(...String(line).split('\n'));
      recent.splice(0, Math.max(0, recent.length - 30));
      void showStatus();
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
    };
  }

  // The footer line: where you are signed in, and how many tasks this window follows.
  let statusRun = 0;
  // Called in the background from many places; a status line that cannot be read now (the
  // secrets file busy or gone) is simply not redrawn.
  async function showStatus(): Promise<void> {
    // Several refreshes may overlap; only the latest one draws.
    const run = ++statusRun;
    const config = readConfig();
    let signedIn: boolean;
    try {
      signedIn = Boolean(await currentToken());
    } catch {
      return;
    }
    if (run !== statusRun) return;
    publishView(signedIn);
    if (!config || !signedIn) {
      api.setStatus(config ? 'circle-server · signed out' : null);
      return;
    }
    const where = `circle-server · ${config.username ? config.username + '@' : ''}${new URL(config.url).host}`;
    if (failure) api.setStatus(`${where} · ${failure}`, 'error');
    else if (following.size)
      api.setStatus(`${where} · ${following.size} running`, 'running');
    else if (expired) api.setStatus(`${where} · sign-in expired`, 'wait');
    else if (botNews.length)
      api.setStatus(`${where} · ${botNews.length} bot result(s)`, 'wait');
    else api.setStatus(where, 'ok');
  }

  function serverUrl(raw: string): string {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ServerError(`not a URL: ${raw}`);
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new ServerError('the address must start with http:// or https://');
    if (url.username || url.password)
      throw new ServerError('put no user name or password in the address');
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
      throw new ServerError('not signed in: /server login <url> <user>');
    const headers: Record<string, string> = { ...options.headers };
    if (!options.anonymous) {
      const token = await currentToken();
      if (!token)
        throw new ServerError('not signed in: /server login <url> <user>');
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
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
      });
    } catch (error) {
      throw new ServerError(`cannot reach ${config.url}: ${reason(error)}`);
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
      throw new ServerError(`${method} ${path} → ${response.status}, not JSON`);
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
        `${String(error.code ?? response.status)}: ${String(error.message ?? 'request failed')}${details ? ` · ${details.length > MAX_DETAIL_CHARS ? `${details.slice(0, MAX_DETAIL_CHARS)}…` : details}` : ''}`,
      );
      failed.status = response.status;
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
      throw new ServerError('the server issued no token');
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
    void showStatus();
    return scopes;
  }

  // A session stays alive without asking anyone: shortly before the token runs out it is
  // renewed at the server (POST /v1/auth/refresh), which keeps the same token and moves its
  // expiry. A server without that route, or a run token, is left to expire.
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
    if (fromRun || refreshUnsupported || expired) return;
    const due = refreshDue(readConfig()?.expiresAt);
    if (due === undefined) return;
    refreshTimer = setTimeout(
      () => void refresh(),
      Math.max(due - Date.now(), 15_000),
    );
    refreshTimer.unref?.();
  }
  function refresh(): Promise<boolean> {
    refreshing ??= (async () => {
      if (fromRun || refreshUnsupported || !(await currentToken()))
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
        void showStatus();
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  // A token the server turns down is never followed by a password card: a model's tool call
  // or a task being followed must not stop for one. The footer says the sign-in expired, and
  // the person signs in again with /server login when they choose.
  async function request(
    method: string,
    path: string,
    options: Parameters<typeof send>[2] = {},
  ): Promise<{ data: unknown; bytes: Buffer; headers: Headers }> {
    if (!options.anonymous && !fromRun) {
      const due = refreshDue(readConfig()?.expiresAt);
      if (due !== undefined && Date.now() >= due) await refresh();
    }
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
        throw new ServerError('circle-server turned down the run token');
      expired = true;
      scheduleRefresh();
      void showStatus();
      const config = readConfig();
      throw new ServerError(
        `signed out: the sign-in has expired · /server login ${config?.url ?? '<url>'} ${config?.username || '<user>'}`,
      );
    }
  }

  async function status(taskId: string): Promise<Record<string, unknown>> {
    const { data } = await request(
      'GET',
      `/v1/tasks/${encodeURIComponent(taskId)}/status`,
    );
    if (!isRecord(data)) throw new ServerError('the server sent no task');
    return data;
  }

  function eventLine(event: ServerEvent): string {
    const payload = event.payload ?? {};
    const parts: string[] = [];
    for (const key of [
      'phase',
      'to',
      'status',
      'message',
      'question',
      'reason',
      'workerId',
    ])
      if (typeof payload[key] === 'string') parts.push(String(payload[key]));
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
  // against the SHA-256 the server recorded for it.
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
          ? ` · read back with ${String(check.reader)}, ${String(check.rowCount)} rows`
          : ''
      }${unmapped.length ? ` · ${unmapped.length} unmapped (listed in the workbook)` : ''}`,
    );
    for (const item of unmapped.slice(0, 5))
      if (isRecord(item))
        context.append(
          `    unmapped ${String(item.path)}: ${String(item.reason)}`,
        );
    const evidence = Array.isArray(result.evidence) ? result.evidence : [];
    for (const item of evidence)
      if (isRecord(item))
        context.append(
          `    evidence ${String(item.evidenceId)} · ${String(item.kind)} · sha256 ${short(item.sha256)}`,
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
      context.append(`  ${taskId} delivered no files`);
      return;
    }
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
          `✖ ${name}: the bytes (${short(actual)}) do not match the server's SHA-256 (${short(artifact.sha256)}); not saved`,
        );
        continue;
      }
      const path = freePath(context.workspace, name);
      writeFileSync(path, bytes, { flag: 'wx' });
      remember(taskId, { saved: true });
      context.append(
        `✓ saved ${path} · ${bytes.byteLength} bytes · sha256 ${short(actual)} matches the server (${artifact.artifactId})`,
      );
    }
  }

  // Follow a task from the last event this window showed until it ends, writing each event
  // as a line. Runs in the background: the command that started it has already returned.
  async function follow(
    taskId: string,
    context: CommandContext,
  ): Promise<void> {
    if (following.has(taskId)) return;
    const controller = new AbortController();
    following.set(taskId, controller);
    failure = '';
    void showStatus();
    let cursor = followed()[taskId]?.seq ?? 0;
    let ended = false;
    try {
      while (!controller.signal.aborted) {
        // The task's state first: a task that has ended has only its missed events left,
        // so there is nothing to wait for.
        const current = await status(taskId);
        const phase = String(current.phase ?? '');
        const over = TERMINAL.has(phase);
        const { data } = await request(
          'GET',
          `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${cursor}&waitMs=${over ? 0 : 20000}`,
          { timeoutMs: 40_000 },
        );
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
                `  ${taskId} was delivered and its results are saved here · /server get ${taskId} saves them again`,
              );
            else await deliver(taskId, context);
          } else if (phase === 'unknown')
            context.append(
              `✖ ${taskId}: the outcome is unknown and the server does not guess it · /server task ${taskId} later`,
            );
          else context.append(`✖ ${taskId} ${phase}`);
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
              `  ${taskId} asks: ${String(item.question)} · /server respond ${taskId} <answer>`,
            );
        if (open.length) return;
      }
    } catch (error) {
      failure = `${taskId} stopped following`;
      context.append(
        `✖ ${taskId}: ${reason(error)} · /server task ${taskId} picks it up again`,
      );
    } finally {
      following.delete(taskId);
      void showStatus();
      // Read the objects again once it has ended, after it stopped counting as followed.
      if (ended) void collectObjects().catch(() => {});
    }
  }

  async function upload(
    path: string,
    scopeId: string,
  ): Promise<{ id: string; sha256: string; name: string }> {
    if (statSync(path).size > MAX_UPLOAD_BYTES)
      throw new ServerError(`${basename(path)} is larger than 16 MB`);
    const bytes = readFileSync(path);
    const { data } = await request('POST', '/v1/sources', {
      bytes,
      headers: {
        'x-scope-id': scopeId,
        'x-file-name': encodeURIComponent(basename(path)),
      },
      timeoutMs: 120_000,
    });
    const source = isRecord(data) ? data : {};
    const id = String(source.sourceRevisionId ?? '');
    if (!id) throw new ServerError('the server returned no source id');
    if (source.sha256 !== sha256(bytes))
      throw new ServerError(
        `${basename(path)} arrived with a different SHA-256`,
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
        'no project: sign in again with /server login <url> <user>',
      );
    const path = resolve(context.workspace, file);
    if (!existsSync(path)) throw new ServerError(`no such file: ${path}`);
    const source = await upload(path, config.scopeId);
    context.append(
      `  uploaded ${source.name} · sha256 ${short(source.sha256)} → ${source.id}`,
    );
    const title = `${pack}: ${source.name}`;
    const idempotencyKey =
      'circle-' +
      sha256(
        Buffer.from(
          JSON.stringify([
            config.scopeId,
            pack,
            source.sha256,
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
        input: {
          ...extra,
          sourceRevisionId: source.id,
          sourceSha256: source.sha256,
        },
      },
    });
    const task = isRecord(data) ? data : {};
    const taskId = String(task.taskId ?? '');
    if (!taskId) throw new ServerError('the server accepted no task');
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

  // The server's tools, offered to the model as srv_<name>: read after signing in, on
  // /server refresh and /server tools, and when a session starts (an ETag keeps that cheap).
  // Signing out removes them. Read tools run at once; the others ask first.
  const serverTools = new Map<
    string,
    { remote: string; fingerprint: string; write: boolean }
  >();
  let catalogTag = '';
  let syncing: Promise<boolean> | undefined;
  // srv_<name> with dots as underscores. Names that would come out the same (docs.list and
  // docs_list) or be cut at 64 characters get a suffix from their full name instead, so the
  // same catalog always gives the same names, whatever order it lists them in.
  function toolNames(remotes: string[]): Map<string, string> {
    const plain = (remote: string): string =>
      'srv_' + remote.replace(/[^A-Za-z0-9_]/g, '_');
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
      const folder = join(api.workspace, '.circle', 'server-returns');
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
      return `.circle/server-returns/${name}`;
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
        `circle-server tool ${remote}${tool.title ? ` (${String(tool.title)})` : ''}: ${String(tool.description ?? '')}${
          write ? ' It changes something, so it asks first.' : ''
        }${tool.mode === 'task' ? ' It runs as a server task and is waited for in the background.' : ' Its response is also saved as it came under .circle/server-returns/ in the workspace (savedAs), to cite or check against instead of retyping it.'}`,
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
            `circle-server ${remote} ${taskId}`,
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
    let catalog: boolean;
    try {
      catalog = await syncTools(list);
    } catch (error) {
      context.append(`  could not read the server's tools: ${reason(error)}`);
      return;
    }
    if (!catalog) {
      if (list) context.append('  this server offers no tools');
      return;
    }
    context.append(
      `  ${serverTools.size} server tools available to the model from its next turn`,
    );
    if (list)
      for (const [name, held] of serverTools)
        context.append(
          `    ${name} ← ${held.remote} · ${held.write ? 'asks first' : 'read-only'}`,
        );
  }
  // Read again whenever a session starts (load, reload, a new session); an unchanged
  // catalog costs one 304.
  api.on('session_start', () => {
    void syncTools().catch(() => {});
  });
  // Run for a server: its tools are there before the first prompt, or not at all.
  if (fromRun) await syncTools().catch(() => {});

  // What the model did with the server's tools since /server trial start: the trial record a
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
              `${relative(root, path)} is larger than 2 MB`,
            );
          total += bytes.length;
          if (total > MAX_PACK_BYTES)
            throw new ServerError('the skill pack is larger than 10 MB');
          files.push({
            path: relative(root, path).split(sep).join('/'),
            base64: bytes.toString('base64'),
            sha256: sha256(bytes),
          });
          if (files.length > MAX_PACK_FILES)
            throw new ServerError(`more than ${MAX_PACK_FILES} files`);
        }
      }
    };
    walk(root);
    return files;
  }
  async function pushSkill(
    rest: string[],
    context: CommandContext,
  ): Promise<void> {
    const flag = rest.indexOf('--outputs');
    const outputs =
      flag >= 0 ? (rest[flag + 1] ?? '').split(',').filter(Boolean) : [];
    const folder = rest.filter(
      (_, index) => index !== flag && index !== flag + 1,
    )[0];
    if (!folder)
      throw new ServerError(
        'usage: /server skill push <folder> [--outputs a,b]',
      );
    const workspace = api.workspace ?? context.workspace;
    const root = resolve(workspace, folder);
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new ServerError(`${folder} is not a folder`);
    let manifest: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(
        readFileSync(join(root, 'skillpack.json'), 'utf8'),
      );
      if (!isRecord(parsed)) throw new Error('not an object');
      manifest = parsed;
    } catch (error) {
      throw new ServerError(`${folder}/skillpack.json: ${reason(error)}`);
    }
    if (
      typeof manifest.id !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id) ||
      typeof manifest.version !== 'string' ||
      !Array.isArray(manifest.tools)
    )
      throw new ServerError(
        'skillpack.json needs id (lowercase letters, digits, -), version and tools[]',
      );
    if (!existsSync(join(root, 'SKILL.md')))
      throw new ServerError(`${folder} has no SKILL.md`);
    const declared = new Set(manifest.tools.map(String));
    const undeclared = [
      ...new Set(
        trial.calls
          .map((call) => call.name)
          .filter((name) => !declared.has(name)),
      ),
    ];
    if (undeclared.length)
      context.append(
        `  ! the trial used tools skillpack.json does not declare: ${undeclared.join(', ')}`,
      );
    const produced: { path: string; sha256: string }[] = [];
    for (const output of outputs) {
      const path = resolve(workspace, output);
      if (!existsSync(path)) {
        context.append(
          `  ! ${output} does not exist; left out of the trial record`,
        );
        continue;
      }
      produced.push({ path: output, sha256: sha256(readFileSync(path)) });
    }
    const files = packFiles(root);
    // With more than one project the server needs to know which one the pack is for.
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
      `✓ submitted ${String(manifest.id)} ${String(manifest.version)} · ${files.length} files · ${trial.calls.length} trial calls · ${String(reply.skillPackId ?? '?')} · digest ${short(reply.digest)} · ${String(reply.status ?? 'submitted')}`,
    );
    for (const [key, label] of [
      [
        'undeclaredTools',
        'the server found tools the trial used but the pack does not declare',
      ],
      ['missingTools', 'the server offers none of'],
    ] as const) {
      const names = Array.isArray(check[key]) ? check[key].map(String) : [];
      if (names.length) context.append(`  ✖ ${label}: ${names.join(', ')}`);
    }
    // Submitted is not approved: the approval bound to this digest waits in its own task.
    const approvalTask =
      typeof reply.approvalTaskId === 'string' ? reply.approvalTaskId : '';
    if (!approvalTask) return;
    remember(approvalTask, {
      title: `approve skill pack ${String(manifest.id)}`,
      seq: 0,
    });
    const approvals = await optional<unknown>(
      `/v1/tasks/${encodeURIComponent(approvalTask)}/approvals`,
      [],
    );
    const open = (Array.isArray(approvals) ? approvals : [])
      .filter(isRecord)
      .filter((item) => item.status === 'open');
    context.append(
      open.length
        ? open
            .map(
              (item) =>
                `  waiting for approval ${String(item.approvalId)} in ${approvalTask} · someone else approves: /server approve ${approvalTask} ${String(item.approvalId)}`,
            )
            .join('\n')
        : `  approval task ${approvalTask} · no open approval yet`,
    );
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
        throw new ServerError(`${name} is not a file in the workspace`);
      if (statSync(path).size > MAX_UPLOAD_BYTES)
        throw new ServerError(`${name} is larger than 16 MB`);
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
      throw new ServerError(`${what} are not a JSON object: ${reason(error)}`);
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
        `not an interval: ${text ?? ''} (for example 30m, 1h or 1d)`,
      );
    return Number(match[1]) * UNITS[match[2]!]!;
  }
  const asAsset = (value: unknown): Asset => {
    if (!isRecord(value) || typeof value.assetId !== 'string')
      throw new ServerError('the server sent no asset');
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
  function triggerLabel(trigger: Asset | undefined): string {
    const configuration = trigger?.configuration ?? {};
    if (configuration.kind === 'schedule') {
      const ms = Number(configuration.intervalMs);
      const unit =
        Object.entries(UNITS)
          .reverse()
          .find(([, size]) => ms % size === 0) ?? (['ms', 1] as const);
      return `every ${ms / unit[1]}${unit[0]} from ${String(configuration.startsAt)}`;
    }
    if (configuration.kind === 'event')
      return `on ${String(configuration.eventName)} of ${String(configuration.sourceAssetId)}`;
    return 'no trigger';
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
  // footer, and /server login looks once more.
  let lookingForBots: Promise<void> | undefined;
  function lookForBots(): Promise<void> {
    lookingForBots ??= (async () => {
      const me = readConfig()?.principalId;
      if (fromRun || !me || !(await currentToken())) return;
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
      void showStatus();
    })()
      .catch((error) => {
        if (error instanceof ServerError && error.status === 401) {
          expired = true;
          void showStatus();
        }
      })
      .finally(() => {
        lookingForBots = undefined;
      });
    return lookingForBots;
  }
  if (!fromRun) setInterval(() => void lookForBots(), 60_000).unref();

  async function bot(
    [verb, ...rest]: string[],
    context: CommandContext,
  ): Promise<void> {
    const config = readConfig();
    if (verb === 'every' || verb === 'on') {
      const { args, values } = options(rest);
      if (!config?.scopeId)
        throw new ServerError(
          'no project: sign in again with /server login <url> <user>',
        );
      if (!config.principalId)
        throw new ServerError(
          'the server has not said who you are here; sign in again with /server login <url> <user>',
        );
      const [pack] = args;
      const schedule = verb === 'every';
      if (!pack || args.length !== (schedule ? 2 : 3))
        throw new ServerError(
          schedule
            ? 'usage: /server bot every <skill pack> <interval> [--from <time>] [--inputs <json>] [--file <path>] [--name <name>]'
            : 'usage: /server bot on <skill pack> <connector asset> <event> [--inputs <json>] [--file <path>] [--name <name>]',
        );
      const trigger = schedule
        ? (() => {
            const from = values.from?.at(-1);
            const startsAt = from ? new Date(from) : new Date();
            if (Number.isNaN(startsAt.getTime()))
              throw new ServerError(`not a time: ${from}`);
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
        `✓ bot ${created.assetId} · ${name} · runs ${pack} ${triggerLabel(made)} as you · output to Circle · ${created.lifecycle}`,
      );
      context.append(
        `  someone else approves it: /server bot approve ${created.assetId} · then you turn it on: /server bot start ${created.assetId}`,
      );
      return;
    }
    if (verb === 'list') {
      const me = config?.principalId;
      const all = await bots();
      if (!all.length) {
        context.append('No bots you can see on this server');
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
          runs = ` · ${list.length} run(s)${fresh ? `, ${fresh} new: /server bot runs ${item.assetId}` : ''}`;
        } else runs = ` · owner ${item.ownerPrincipalId}`;
        rows.push(
          `  ${item.assetId} · ${item.name} · ${item.lifecycle} · ${triggerLabel(trigger)}${trigger ? ` (trigger ${trigger.lifecycle})` : ''}${runs}`,
        );
      }
      context.append(rows.join('\n'));
      return;
    }
    const [id] = rest;
    if (!id || !['approve', 'start', 'stop', 'runs'].includes(verb ?? ''))
      throw new ServerError(
        'usage: /server bot list | every <pack> <interval> | on <pack> <source> <event> | approve <bot> | start <bot> | stop <bot> | runs <bot>',
      );
    const item = await asset(id);
    if (item.kind !== 'bot') throw new ServerError(`${id} is not a bot`);
    const triggerId = String(item.configuration.triggerAssetId ?? '');
    if (verb === 'approve' || verb === 'start') {
      // The trigger first: a running bot needs a running trigger before it fires.
      const target = verb === 'approve' ? 'approved' : 'running';
      for (const part of [await asset(triggerId), item]) {
        const what = part.kind === 'bot' ? 'bot' : 'trigger';
        if (
          (verb === 'approve' && part.lifecycle !== 'draft') ||
          (verb === 'start' && part.lifecycle === 'running')
        ) {
          context.append(
            `  ${what} ${part.assetId} is already ${part.lifecycle}`,
          );
          continue;
        }
        if (verb === 'start' && part.lifecycle !== 'approved')
          throw new ServerError(
            `${what} ${part.assetId} is ${part.lifecycle}; someone else approves it first: /server bot approve ${id}`,
          );
        const moved = await move(part, target);
        context.append(
          `✓ ${what} ${moved.assetId} ${moved.lifecycle} · version ${moved.version} · digest ${short(moved.sha256)}`,
        );
      }
      if (verb === 'start')
        context.append(
          `  ${id} runs ${triggerLabel(await asset(triggerId))}; its results come to Circle: /server bot runs ${id}`,
        );
      return;
    }
    if (verb === 'stop') {
      const moved = await move(item, 'disabled');
      context.append(
        `✓ bot ${moved.assetId} ${moved.lifecycle}; it starts no more runs`,
      );
      return;
    }
    const runs = await botRuns(id);
    if (!runs.length) {
      context.append(`  ${id} has not run yet`);
      return;
    }
    const shown: string[] = [];
    for (const run of runs.slice(-10)) {
      // Occurrences a late approval or a stopped server missed, folded into this one run.
      const skipped = Number(run.trigger.skippedOccurrences ?? 0);
      const folded =
        skipped > 0
          ? ` · ${skipped} missed occurrence(s) since ${String(run.trigger.firstDueAt)} folded into this run`
          : '';
      if (!run.taskId) {
        context.append(
          `  — · ${run.occurrenceKey} · not started: ${run.error || run.status}${folded}`,
        );
        shown.push(runKey(id, run));
        continue;
      }
      const output = run.published ? await botOutput(run.taskId) : undefined;
      if (!output) {
        let phase = 'not published yet';
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
        `  ${run.taskId} · ${run.occurrenceKey} · ${String(output.status)} · ${artifacts.length} file(s)${unknowns.length ? ` · unknown: ${unknowns.join('; ')}` : ''}${folded} · /server get ${run.taskId} saves them`,
      );
      for (const artifact of artifacts.filter(isRecord).slice(0, 5))
        context.append(
          `    ${String(artifact.fileName ?? artifact.artifactId)} · sha256 ${short(artifact.sha256)}`,
        );
      shown.push(run.taskId);
    }
    if (runs.length > 10)
      context.append(`  (${runs.length - 10} earlier run(s) not shown)`);
    markSeen(shown);
    await showStatus();
  }

  const commands: Record<
    string,
    (rest: string[], context: CommandContext) => Promise<void>
  > = {
    async login([address, username], context) {
      if (fromRun)
        throw new ServerError(
          'Circle runs with a token from circle-server here; there is no sign-in',
        );
      if (!address || !username)
        throw new ServerError('usage: /server login <url> <user>');
      const url = serverUrl(address);
      const password = await api.askSecret(
        `Password for ${username} on ${url}`,
      );
      if (password === null) {
        context.append('Sign-in cancelled');
        return;
      }
      const scopes = await signIn(url, username, password);
      await collectObjects().catch(() => {});
      const { data: about } = await request('GET', '/v1/status');
      context.append(
        `● signed in to ${url} as ${username}${scopes.length ? ` · scope ${scopes[0]}` : ''}${
          isRecord(about) && about.apiVersion
            ? ` · api ${String(about.apiVersion)}`
            : ''
        }`,
      );
      await announceTools(context);
      void lookForBots();
    },
    async logout(_rest, context) {
      if (fromRun)
        throw new ServerError(
          'Circle runs with a token from circle-server here; there is no sign-out',
        );
      const removed = await api.secrets.delete('token');
      const config = readConfig();
      if (config) writeJson('config.json', { ...config, expiresAt: undefined });
      if (refreshTimer) clearTimeout(refreshTimer);
      dropServerTools();
      void showStatus();
      context.append(removed ? 'Signed out' : 'Not signed in');
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
          : 'The server lists no capability packs',
      );
    },
    async submit(rest, context) {
      const again = rest.includes('--again');
      const [pack, ...files] = rest.filter((word) => word !== '--again');
      if (!pack || files.length !== 1)
        throw new ServerError('usage: /server submit <pack> <file> [--again]');
      const task = await handOver(pack, files[0]!, again, context);
      context.append(
        `✓ accepted ${task.taskId} · ${task.phase} · input ${task.inputRevisionId}${task.deduplicated ? ' · the same request as before, no new task' : ''} · following it; closing Circle does not stop it`,
      );
      void follow(task.taskId, context);
    },
    async tasks(_rest, context) {
      const known = Object.entries(followed());
      if (!known.length) {
        context.append('No tasks handed over from here');
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
          `  ${taskId} · ${phase} · ${item.title} · seen to ${item.seq}`,
        );
      }
      context.append(rows.join('\n'));
    },
    async task([taskId], context) {
      if (!taskId) throw new ServerError('usage: /server task <id>');
      const current = await status(taskId);
      if (!followed()[taskId])
        remember(taskId, { title: String(current.title ?? ''), seq: 0 });
      context.append(
        `  ${taskId} · ${String(current.phase)} · ${String(current.title ?? '')} · input ${String(current.inputRevisionId)}`,
      );
      void follow(taskId, context);
    },
    async respond([taskId, ...answer], context) {
      if (!taskId || !answer.length)
        throw new ServerError('usage: /server respond <id> <answer>');
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
        throw new ServerError(`${taskId} is not waiting for an answer`);
      await request('POST', `/v1/tasks/${encodeURIComponent(taskId)}/input`, {
        json: {
          inputRevisionId: current.inputRevisionId,
          requestId: open.requestId,
          response: answerOf(answer.join(' ')),
        },
      });
      context.append(`✓ answered ${taskId} (${String(open.requestId)})`);
      void follow(taskId, context);
    },
    async get([taskId], context) {
      if (!taskId) throw new ServerError('usage: /server get <id>');
      await deliver(taskId, context);
    },
    async refresh(_rest, context) {
      const counts = await collectObjects();
      context.append(
        `  read ${counts.tasks} tasks and ${counts.packs} capability packs from the server`,
      );
      await announceTools(context);
    },
    async trial([verb], context) {
      if (verb !== 'start') throw new ServerError('usage: /server trial start');
      trial.calls = [];
      trial.startedAt = new Date().toISOString();
      keepTrial();
      context.append(
        '  recording the server tool calls of this trial; /server skill push <folder> sends them with the pack',
      );
    },
    async skill([verb, ...rest], context) {
      if (verb === 'push') return pushSkill(rest, context);
      if (verb === 'list') {
        const { data } = await request('GET', '/v1/skillpacks');
        const packs = (Array.isArray(data) ? data : []).filter(isRecord);
        context.append(
          packs.length
            ? packs
                .map(
                  (pack) =>
                    `  ${String(pack.skillPackId ?? '')} · ${String(pack.id ?? (isRecord(pack.manifest) ? pack.manifest.id : ''))} ${String(pack.version ?? (isRecord(pack.manifest) ? pack.manifest.version : ''))} · ${String(pack.status ?? '')}`,
                )
                .join('\n')
            : 'No skill packs on this server',
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
            'usage: /server skill run <id> [json inputs] [--file <path>]…',
          );
        const inputs = json.length ? jsonObject(json.join(' '), 'inputs') : {};
        if (attached.length) inputs.files = attach(attached, context);
        const { data } = await request(
          'POST',
          `/v1/skillpacks/${encodeURIComponent(id)}/runs`,
          { json: { inputs, idempotencyKey: randomUUID() } },
        );
        const taskId = isRecord(data) ? String(data.taskId ?? '') : '';
        if (!taskId) throw new ServerError('the server started no task');
        remember(taskId, { title: `skill pack ${id}`, seq: 0 });
        context.append(
          `✓ running ${id} on the server as ${taskId} · following it`,
        );
        void follow(taskId, context);
        return;
      }
      throw new ServerError(
        'usage: /server skill push <folder> | list | run <id> [json]',
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
    async reconcile([taskId], context) {
      if (!taskId) throw new ServerError('usage: /server reconcile <id>');
      const { data } = await request(
        'POST',
        `/v1/tasks/${encodeURIComponent(taskId)}/reconcile`,
        { json: {} },
      );
      context.append(
        `  ${taskId} · reconcile · ${JSON.stringify(data).slice(0, 200)}`,
      );
      await collectObjects().catch(() => {});
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
        `usage: /server ${approve ? 'approve' : 'reject'} <id> <approval>`,
      );
    const path = `/v1/tasks/${encodeURIComponent(taskId)}/approvals`;
    const { data } = await request('GET', path);
    const found = (Array.isArray(data) ? data : []).find(
      (item) => isRecord(item) && item.approvalId === approvalId,
    );
    if (!isRecord(found))
      throw new ServerError(`${taskId} has no approval ${approvalId}`);
    await request('POST', `${path}/${encodeURIComponent(approvalId)}`, {
      json: {
        inputRevisionId: found.inputRevisionId,
        targetIdentity: found.targetIdentity,
        actionDigest: found.actionDigest,
        approve,
      },
    });
    context.append(
      `✓ ${approve ? 'approved' : 'rejected'} ${approvalId} for ${taskId} (input ${String(found.inputRevisionId)})`,
    );
    await collectObjects().catch(() => {});
  }

  // The same work as tools, for a model that is told to hand work to the server.
  api.registerTool(
    'circle_server_packs',
    'List what the connected circle-server can do: its capability packs, their input formats, the input each one takes (inputSchema) and versions. Read-only.',
    { type: 'object', properties: {} },
    async () => (await request('GET', '/v1/packs')).data,
    { readOnly: true },
  );
  api.registerTool(
    'circle_server_task',
    'Look up a circle-server task by id: its phase and, once it has ended, its result (status, artifacts with their SHA-256, the independent check, unmapped items). Read-only; saves nothing.',
    {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
    async (args) => {
      const taskId = String(args.task_id ?? '');
      if (!taskId) throw new api.ToolError('task_id is required');
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
    'circle_server_submit',
    'Hand circle-server a task on one file of the workspace with a capability pack, for example mindmap-compile on an .xmind. The server keeps the task; this waits in the background and, once it is delivered, saves the results in the workspace after checking their SHA-256. It sends the file to the server and writes files, so it asks first.',
    {
      type: 'object',
      properties: {
        pack: { type: 'string', description: 'capability pack id' },
        file: { type: 'string', description: 'path in the workspace' },
        input: {
          type: 'object',
          description:
            'the rest of the task input the pack asks for, for example the asset ids it binds and the build; the uploaded file’s sourceRevisionId and sourceSha256 are filled in here',
        },
      },
      required: ['pack', 'file'],
    },
    async (args) => {
      const pack = String(args.pack ?? '');
      const file = String(args.file ?? '');
      if (!pack || !file) throw new api.ToolError('pack and file are required');
      if (args.input !== undefined && !isRecord(args.input))
        throw new api.ToolError('input is an object of task input fields');
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
        `circle-server ${taskId}`,
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
    'circle_server_trial_start',
    'Start recording which circle-server tools the model calls: the trial record a skill pack is pushed with, as /server trial start does. Clears the previous record. Start it before the trial run of a new or changed skill pack.',
    { type: 'object', properties: {} },
    async () => {
      trial.calls = [];
      trial.startedAt = new Date().toISOString();
      keepTrial();
      return { recording: true, startedAt: trial.startedAt };
    },
  );
  api.registerTool(
    'circle_server_skill_push',
    'Submit a skill pack folder of the workspace (skillpack.json, SKILL.md and its files) to circle-server with the current trial record and the SHA-256 of the files the trial produced, as /server skill push does. The server checks the tools the trial used against the pack; someone else must approve the new digest before it runs there. It sends the folder, so it asks first.',
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
      if (!folder) throw new api.ToolError('folder is required');
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
    'circle_server_source_artifact',
    'Register files of the workspace on circle-server as one versioned source artifact: each file is uploaded as an original with its SHA-256 and listed with its role. The server keeps it as a draft until someone else approves it; circle_server_source_artifact_status then gives its sourceArtifactId (sar_…), which server tools take as sourceArtifactId. It sends the files to the server, so it asks first.',
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
      },
      required: ['name', 'version', 'files'],
    },
    async (args) => {
      const config = readConfig();
      if (!config?.scopeId)
        throw new api.ToolError(
          'no project: sign in again with /server login <url> <user>',
        );
      const name = String(args.name ?? '');
      const version = String(args.version ?? '');
      const files = Array.isArray(args.files) ? args.files : [];
      if (!name || !version || !files.length)
        throw new api.ToolError(
          'name, version and at least one file are required',
        );
      if (args.metadata !== undefined && !isRecord(args.metadata))
        throw new api.ToolError('metadata is an object');
      const listed: Record<string, unknown>[] = [];
      try {
        for (const file of files) {
          if (!isRecord(file) || typeof file.path !== 'string' || !file.path)
            throw new ServerError('each file needs a path in the workspace');
          if (typeof file.role !== 'string' || !file.role)
            throw new ServerError(`${file.path}: role is required`);
          const path = resolve(api.workspace, file.path);
          const inside = relative(api.workspace, path);
          if (!inside || inside.startsWith('..') || isAbsolute(inside))
            throw new ServerError(`${file.path} is outside the workspace`);
          if (!existsSync(path))
            throw new ServerError(`no such file: ${file.path}`);
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
        const { data } = await request('POST', '/v1/source-artifacts', {
          json: {
            scopeId: config.scopeId,
            name,
            version,
            metadata: isRecord(args.metadata) ? args.metadata : {},
            files: listed,
            ...(Array.isArray(args.readers) && args.readers.length
              ? { readers: args.readers.map(String) }
              : {}),
          },
        });
        return {
          registered: data,
          files: listed,
          next: 'someone else approves the asset; then circle_server_source_artifact_status gives the sourceArtifactId',
        };
      } catch (error) {
        throw new api.ToolError(reason(error));
      }
    },
  );
  api.registerTool(
    'circle_server_source_artifact_status',
    'Look up a source artifact on circle-server by its asset id: its version, lifecycle, files with their SHA-256 and, once someone else has approved it, its sourceArtifactId (sar_…). Read-only.',
    {
      type: 'object',
      properties: { asset_id: { type: 'string' } },
      required: ['asset_id'],
    },
    async (args) => {
      const id = String(args.asset_id ?? '');
      if (!id) throw new api.ToolError('asset_id is required');
      try {
        return (
          await request('GET', `/v1/source-artifacts/${encodeURIComponent(id)}`)
        ).data;
      } catch (error) {
        throw new api.ToolError(reason(error));
      }
    },
    { readOnly: true },
  );
  void showStatus();
  scheduleRefresh();
  void lookForBots();
  api.registerCommand(
    'server',
    'Work with a circle-server: /server [login | logout | packs | submit | tasks | task | respond | get | refresh | tools | skill | bot]',
    async (args, context) => {
      const [verb, ...rest] = words(args);
      if (!verb) {
        const config = readConfig();
        const signedIn = Boolean(await currentToken());
        context.append(
          config
            ? `${signedIn ? '●' : '○'} ${config.url}${config.username ? ' · ' + config.username : ''}${config.scopeId ? ' · project ' + config.scopeId : ''}${signedIn ? '' : ' · not signed in'}\n${USAGE}`
            : `Not connected.\n${USAGE}`,
        );
        return;
      }
      const command = commands[verb];
      if (!command) throw new ServerError(`unknown: /server ${verb}\n${USAGE}`);
      await command(rest, recording(context));
    },
  );
}

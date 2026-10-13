// The circle-server connector. It ships with Circle and is off until `/extensions enable
// circle-server`. It signs in to a server, hands it work with your files, follows the work
// while it runs and saves what the server delivers. The task lives on the server: closing
// Circle does not stop it, and `/server task <id>` picks it up where this window left off.
//
// This file is loaded as written (Node strips the types), so it uses only syntax that
// type stripping accepts and imports nothing from Circle at run time.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import type { CommandContext, ExtensionAPI } from '../../extensions.js';

interface Config {
  url: string;
  username: string;
  scopeId?: string;
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
].join('\n');

const sha256 = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');
const short = (hash: unknown): string =>
  typeof hash === 'string' ? hash.slice(0, 12) + '…' : '';
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const reason = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Words split on spaces, with "…" or '…' kept together.
function words(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    found.push(match[1] ?? match[2] ?? match[3] ?? '');
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

export function register(api: ExtensionAPI): void {
  const following = new Map<string, AbortController>();
  let failure = '';
  let reauthorizing: Promise<void> | undefined;

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
  function readConfig(): Config | undefined {
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
    const listed = await optional<unknown>('/v1/tasks?limit=20', []);
    let tasks = (Array.isArray(listed) ? listed : []).filter(isRecord);
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
    objects = {
      refreshedAt: new Date().toISOString(),
      work,
      execution,
      knowledge,
      methods,
    };
    api.background(showStatus());
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
    };
  }

  // The footer line: where you are signed in, and how many tasks this window follows.
  let statusRun = 0;
  async function showStatus(): Promise<void> {
    // Nobody looks once the extension is closed, and its files may be going.
    if (api.signal.aborted) return;
    // Several refreshes may overlap; only the latest one draws.
    const run = ++statusRun;
    const config = readConfig();
    const signedIn = Boolean(await api.secrets.get('token'));
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
      const token = await api.secrets.get('token');
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
        // Ends with the extension: a reload or leaving does not wait out a long poll.
        signal: AbortSignal.any([
          AbortSignal.timeout(options.timeoutMs ?? 60_000),
          api.signal,
        ]),
      });
    } catch (error) {
      throw new ServerError(`cannot reach ${config.url}: ${reason(error)}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (options.raw && response.ok)
      return { data: undefined, bytes, headers: response.headers };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ServerError(`${method} ${path} → ${response.status}, not JSON`);
    }
    if (!response.ok || (isRecord(parsed) && parsed.status === 'failed')) {
      const error =
        isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
      const failed = new ServerError(
        `${String(error.code ?? response.status)}: ${String(error.message ?? 'request failed')}`,
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
    writeJson('config.json', { url, username, scopeId: scopes[0] });
    failure = '';
    api.background(showStatus());
    return scopes;
  }

  // A token lasts minutes. When the server turns it down, ask for the password again on the
  // masked card (once, however many requests were turned down) and go on.
  async function reauthorize(): Promise<void> {
    reauthorizing ??= (async () => {
      await api.secrets.delete('token');
      api.background(showStatus());
      const config = readConfig();
      if (!config?.username)
        throw new ServerError('signed out: /server login <url> <user>');
      const password = await api.askSecret(
        `circle-server signed you out. Password for ${config.username} on ${config.url}`,
      );
      if (password === null)
        throw new ServerError('signed out: /server login <url> <user>');
      await signIn(config.url, config.username, password);
    })().finally(() => {
      reauthorizing = undefined;
    });
    return reauthorizing;
  }

  async function request(
    method: string,
    path: string,
    options: Parameters<typeof send>[2] = {},
  ): Promise<{ data: unknown; bytes: Buffer; headers: Headers }> {
    try {
      return await send(method, path, options);
    } catch (error) {
      if (
        options.anonymous ||
        !(error instanceof ServerError) ||
        error.status !== 401
      )
        throw error;
      await reauthorize();
      return send(method, path, options);
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
      // Closed under it: the task goes on on the server, and /server task picks it up.
      if (api.signal.aborted) return;
      failure = `${taskId} stopped following`;
      context.append(
        `✖ ${taskId}: ${reason(error)} · /server task ${taskId} picks it up again`,
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

  // Upload one file of the workspace and hand the server a task on it. The same pack and
  // file give the same idempotency key, so sending twice finds the same task.
  async function handOver(
    pack: string,
    file: string,
    again: boolean,
    context: CommandContext,
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
          ]),
        ),
      ).slice(0, 40);
    const { data } = await request('POST', '/v1/tasks/submit', {
      json: {
        scopeId: config.scopeId,
        title,
        capabilityPackId: pack,
        idempotencyKey,
        input: { sourceRevisionId: source.id, sourceSha256: source.sha256 },
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

  const commands: Record<
    string,
    (rest: string[], context: CommandContext) => Promise<void>
  > = {
    async login([address, username], context) {
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
    },
    async logout(_rest, context) {
      const removed = await api.secrets.delete('token');
      api.background(showStatus());
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
      api.background(follow(task.taskId, context));
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
      api.background(follow(taskId, context));
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
      api.background(follow(taskId, context));
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
    },
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
    'List what the connected circle-server can do: its capability packs, their input formats and versions. Read-only.',
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
      },
      required: ['pack', 'file'],
    },
    async (args) => {
      const pack = String(args.pack ?? '');
      const file = String(args.file ?? '');
      if (!pack || !file) throw new api.ToolError('pack and file are required');
      const accepted = collecting();
      let task;
      try {
        task = await handOver(pack, file, false, accepted.context);
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
  api.background(showStatus());
  api.registerCommand(
    'server',
    'Work with a circle-server: /server [login | logout | packs | submit | tasks | task | respond | get]',
    async (args, context) => {
      const [verb, ...rest] = words(args);
      if (!verb) {
        const config = readConfig();
        const signedIn = Boolean(await api.secrets.get('token'));
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

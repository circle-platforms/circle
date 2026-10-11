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

  // The footer line: where you are signed in, and how many tasks this window follows.
  let statusRun = 0;
  async function showStatus(): Promise<void> {
    // Several refreshes may overlap; only the latest one draws.
    const run = ++statusRun;
    const config = readConfig();
    const signedIn = Boolean(await api.secrets.get('token'));
    if (run !== statusRun) return;
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
        signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
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
    void showStatus();
    return scopes;
  }

  // A token lasts minutes. When the server turns it down, ask for the password again on the
  // masked card (once, however many requests were turned down) and go on.
  async function reauthorize(): Promise<void> {
    reauthorizing ??= (async () => {
      await api.secrets.delete('token');
      void showStatus();
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
    try {
      while (!controller.signal.aborted) {
        // The task's state first: a task that has ended has only its missed events left,
        // so there is nothing to wait for.
        const current = await status(taskId);
        const phase = String(current.phase ?? '');
        const ended = TERMINAL.has(phase);
        const { data } = await request(
          'GET',
          `/v1/tasks/${encodeURIComponent(taskId)}/events?after=${cursor}&waitMs=${ended ? 0 : 20000}`,
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
        if (ended) {
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
      const config = readConfig();
      if (!config?.scopeId)
        throw new ServerError(
          'no project: sign in again with /server login <url> <user>',
        );
      const path = resolve(context.workspace, files[0]!);
      if (!existsSync(path)) throw new ServerError(`no such file: ${path}`);
      const source = await upload(path, config.scopeId);
      context.append(
        `  uploaded ${source.name} · sha256 ${short(source.sha256)} → ${source.id}`,
      );
      const title = `${pack}: ${source.name}`;
      // The same pack and file give the same key, so sending twice finds the same task.
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
      context.append(
        `✓ accepted ${taskId} · ${String(task.phase ?? '')} · input ${String(task.inputRevisionId ?? '')}${task.deduplicated ? ' · the same request as before, no new task' : ''} · following it; closing Circle does not stop it`,
      );
      void follow(taskId, context);
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
  };

  void showStatus();
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
      await command(rest, context);
    },
  );
}

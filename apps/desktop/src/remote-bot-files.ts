import { lstat, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import type { McpBearerConnection } from '../../../src/mcp_loader.js';
import type { ChatFile } from '../../../src/remote_bot_protocol.js';
import {
  botServerUrl,
  fetchWithRefresh,
  parseRemoteBotError,
} from './remote-bot';

const MAX_BOT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_BOT_BATCH_FILES = 8;

interface PreparedSelectedFile {
  handle: FileHandle;
  name: string;
  sha256: string;
  size: number;
}

function sanitizeFileSystemError(
  error: unknown,
  context: 'attach' | 'save',
): never {
  const code =
    error && typeof error === 'object'
      ? (error as { code?: unknown }).code
      : undefined;
  if (code === 'ENOENT') {
    throw Object.assign(new Error('file unavailable'), { code: 'ENOENT' });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw Object.assign(new Error('file permission denied'), { code });
  }
  if (code === 'EISDIR') {
    throw Object.assign(
      new Error(
        context === 'attach'
          ? 'only a regular file can be attached'
          : 'cannot access a directory as a file',
      ),
      { code: 'EISDIR' },
    );
  }
  throw error;
}

async function prepareSelectedFile(
  path: string,
): Promise<PreparedSelectedFile> {
  let link;
  try {
    link = await lstat(path, { bigint: true });
  } catch (error) {
    sanitizeFileSystemError(error, 'attach');
  }
  if (link.isSymbolicLink())
    throw new Error('symbolic links cannot be attached');
  if (!link.isFile()) throw new Error('only a regular file can be attached');
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    sanitizeFileSystemError(error, 'attach');
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.dev !== link.dev || stat.ino !== link.ino)
      throw new Error('file identity changed');
    if (stat.size > BigInt(MAX_BOT_FILE_BYTES))
      throw new Error('file exceeds the 100 MiB limit');
    const size = Number(stat.size);
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({
      start: 0,
      autoClose: false,
    }))
      hash.update(chunk);
    return {
      handle,
      name: basename(path),
      sha256: hash.digest('hex'),
      size,
    };
  } catch (error) {
    await handle.close().catch(() => {});
    sanitizeFileSystemError(error, 'attach');
  }
}

async function putPreparedFile(
  port: McpBearerConnection,
  prepared: PreparedSelectedFile,
  fetcher: typeof fetch,
): Promise<ChatFile> {
  const url = botServerUrl(port.server, '/api/bot/v1/files/' + prepared.sha256);
  const signal = AbortSignal.timeout(120000);
  const response = await fetchWithRefresh(port, signal, (token) =>
    fetcher(url, {
      method: 'PUT',
      signal,
      redirect: 'error',
      headers: {
        authorization: 'Bearer ' + token,
        'content-length': String(prepared.size),
        'content-type': 'application/octet-stream',
      },
      body: Readable.toWeb(
        prepared.handle.createReadStream({ start: 0, autoClose: false }),
      ) as BodyInit,
      duplex: 'half',
    } as RequestInit),
  );
  if (!response.ok) {
    throw await parseRemoteBotError(response, 'file upload was not verified');
  }
  let info: { sha256?: unknown; size?: unknown };
  try {
    info = (await response.json()) as { sha256?: unknown; size?: unknown };
  } catch {
    throw new Error('file upload was not verified');
  }
  if (info.sha256 !== prepared.sha256 || info.size !== prepared.size)
    throw new Error('file upload was not verified');
  return { name: prepared.name, sha256: prepared.sha256, size: prepared.size };
}

export async function uploadSelected(
  port: McpBearerConnection,
  path: string,
  fetcher = fetch,
): Promise<ChatFile> {
  botServerUrl(port.server, '/api/bot/v1');
  const prepared = await prepareSelectedFile(path);
  try {
    return await putPreparedFile(port, prepared, fetcher);
  } finally {
    await prepared.handle.close();
  }
}

export class PartialBatchUploadError extends Error {
  readonly uploaded: number;
  readonly total: number;
  readonly fileName: string;
  readonly reason: string;
  readonly status?: number;
  readonly code?: string;
  readonly remoteMessage?: string;
  readonly scope?: string;

  constructor(
    uploaded: number,
    total: number,
    fileName: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Uploaded ${uploaded} of ${total} files; failed on ${fileName}: ${reason}`,
      { cause },
    );
    this.name = 'PartialBatchUploadError';
    this.uploaded = uploaded;
    this.total = total;
    this.fileName = fileName;
    this.reason = reason;
    if (cause && typeof cause === 'object') {
      const meta = cause as {
        status?: unknown;
        code?: unknown;
        remoteMessage?: unknown;
        scope?: unknown;
      };
      if (typeof meta.status === 'number') this.status = meta.status;
      if (typeof meta.code === 'string') this.code = meta.code;
      if (typeof meta.remoteMessage === 'string')
        this.remoteMessage = meta.remoteMessage;
      if (typeof meta.scope === 'string') this.scope = meta.scope;
    }
  }
}

export async function uploadSelectedBatch(
  port: McpBearerConnection,
  paths: readonly string[],
  fetcher = fetch,
): Promise<ChatFile[]> {
  if (paths.length > MAX_BOT_BATCH_FILES)
    throw new Error('select up to eight files');
  botServerUrl(port.server, '/api/bot/v1');
  const prepared: PreparedSelectedFile[] = [];
  try {
    for (const path of paths) {
      prepared.push(await prepareSelectedFile(path));
    }
    const receipts: ChatFile[] = [];
    for (const item of prepared) {
      try {
        receipts.push(await putPreparedFile(port, item, fetcher));
      } catch (error) {
        if (receipts.length > 0) {
          throw new PartialBatchUploadError(
            receipts.length,
            prepared.length,
            item.name,
            error,
          );
        }
        throw error;
      }
    }
    return receipts;
  } finally {
    await Promise.all(
      prepared.map((item) => item.handle.close().catch(() => {})),
    );
  }
}

export async function saveRemoteFile(
  port: McpBearerConnection,
  descriptor: ChatFile,
  path: string,
  fetcher = fetch,
) {
  if (
    !/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
    !Number.isSafeInteger(descriptor.size) ||
    descriptor.size < 0 ||
    descriptor.size > MAX_BOT_FILE_BYTES
  )
    throw new Error('invalid file receipt');
  const url = botServerUrl(
    port.server,
    '/api/bot/v1/files/' + descriptor.sha256,
  );
  const signal = AbortSignal.timeout(120000);
  const response = await fetchWithRefresh(port, signal, (token) =>
    fetcher(url, {
      signal,
      redirect: 'error',
      headers: { authorization: 'Bearer ' + token },
    }),
  );
  if (!response.ok) {
    throw await parseRemoteBotError(response, 'file unavailable');
  }
  const contentLength = response.headers.get('content-length');
  if (
    !response.body ||
    contentLength === null ||
    Number(contentLength) !== descriptor.size
  ) {
    await response.body?.cancel();
    throw new Error('file unavailable');
  }
  const hash = createHash('sha256');
  let size = 0;
  const temp = join(dirname(path), '.circle-' + randomUUID() + '.part');
  let handle: FileHandle;
  try {
    handle = await open(temp, 'wx', 0o600);
  } catch (error) {
    sanitizeFileSystemError(error, 'save');
  }
  try {
    const verify = new Transform({
      transform(chunk, _encoding, done) {
        size += chunk.length;
        if (size > descriptor.size)
          return done(new Error('file size mismatch'));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      verify,
      handle.createWriteStream(),
    );
    if (hash.digest('hex') !== descriptor.sha256 || size !== descriptor.size)
      throw new Error('file digest mismatch');
    port.assertActive();
    await rename(temp, path);
  } catch (error) {
    sanitizeFileSystemError(error, 'save');
  } finally {
    await handle.close();
    await unlink(temp).catch(() => {});
  }
}

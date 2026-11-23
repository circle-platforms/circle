import { lstat, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';
import type { McpBearerConnection } from '../../../src/mcp_loader.js';
import type { ChatFile } from '../../../src/remote_bot_protocol.js';
import { fetchWithRefresh } from './remote-bot';

const MAX_BOT_FILE_BYTES = 100 * 1024 * 1024;
export async function uploadSelected(
  port: McpBearerConnection,
  path: string,
  fetcher = fetch,
) {
  const link = await lstat(path, { bigint: true });
  if (link.isSymbolicLink())
    throw new Error('symbolic links cannot be attached');
  if (!link.isFile()) throw new Error('only a regular file can be attached');
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await file.stat({ bigint: true });
    if (!stat.isFile() || stat.dev !== link.dev || stat.ino !== link.ino)
      throw new Error('file identity changed');
    if (stat.size > BigInt(MAX_BOT_FILE_BYTES))
      throw new Error('file exceeds the 100 MiB limit');
    const size = Number(stat.size);
    const hash = createHash('sha256');
    for await (const chunk of file.createReadStream({
      start: 0,
      autoClose: false,
    }))
      hash.update(chunk);
    const sha256 = hash.digest('hex');
    const url = new URL('/api/bot/v1/files/' + sha256, port.server);
    const signal = AbortSignal.timeout(120000);
    const response = await fetchWithRefresh(port, signal, (token) =>
      fetcher(url, {
        method: 'PUT',
        signal,
        redirect: 'error',
        headers: {
          authorization: 'Bearer ' + token,
          'content-length': String(size),
          'content-type': 'application/octet-stream',
        },
        body: Readable.toWeb(
          file.createReadStream({ start: 0, autoClose: false }),
        ) as BodyInit,
        duplex: 'half',
      } as RequestInit),
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('file upload was not verified');
    }
    let info: { sha256?: unknown; size?: unknown };
    try {
      info = (await response.json()) as { sha256?: unknown; size?: unknown };
    } catch {
      throw new Error('file upload was not verified');
    }
    if (info.sha256 !== sha256 || info.size !== size)
      throw new Error('file upload was not verified');
    return { name: basename(path), sha256, size };
  } finally {
    await file.close();
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
  const url = new URL('/api/bot/v1/files/' + descriptor.sha256, port.server);
  const signal = AbortSignal.timeout(120000);
  const response = await fetchWithRefresh(port, signal, (token) =>
    fetcher(url, {
      signal,
      redirect: 'error',
      headers: { authorization: 'Bearer ' + token },
    }),
  );
  const contentLength = response.headers.get('content-length');
  if (
    !response.ok ||
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
  const handle = await open(temp, 'wx', 0o600);
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
  } finally {
    await handle.close();
    await unlink(temp).catch(() => {});
  }
}

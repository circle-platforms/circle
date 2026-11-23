import type { ChatFile } from './remote_bot_protocol.js';
import { createServer, type ServerResponse } from 'node:http';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import lockfile from 'proper-lockfile';
import {
  BotError,
  RemoteBot,
  remoteCompletion,
  type ChatRoute,
  type ChatOperation,
  type RemoteModel,
} from './remote_bot.js';
import { validVersion, VERSION } from './version.js';

const RECEIPT_STATES = new Set([
  'sent',
  'unknown',
  'refused',
  'issued',
  'target_rejected',
  'not_dispatched',
]);

function majorMinor(version: string): string {
  const base = version.split('+')[0]!.split('-')[0]!;
  const [major, minor] = base.split('.');
  return `${major}.${minor}`;
}

function answer(response: ServerResponse, status: number, body: unknown) {
  response
    .writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    })
    .end(JSON.stringify(body));
}

function maxUnixSocketPathBytes(platform = process.platform): number {
  return platform === 'darwin' ? 103 : 107;
}

export async function serveRemoteBot(directory: string) {
  if (process.platform === 'win32' || !isAbsolute(directory))
    throw new Error('private absolute socket directory required');
  await mkdir(directory, { mode: 0o700, recursive: true });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('private socket directory required');
  const socket = join(directory, 'host.sock');
  const maxSocketBytes = maxUnixSocketPathBytes();
  const socketBytes = Buffer.byteLength(socket, 'utf8');
  if (socketBytes > maxSocketBytes) {
    throw new Error(
      `unix socket path too long (${socketBytes} bytes, max ${maxSocketBytes}): ${socket}`,
    );
  }
  const release = await lockfile.lock(directory, {
    lockfilePath: join(directory, 'host.lock'),
    retries: 0,
  });
  let bot: RemoteBot | undefined;
  try {
    const previous = await lstat(socket).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (previous) {
      if (!previous.isSocket()) throw new Error('socket path occupied');
      await unlink(socket);
    }
    bot = new RemoteBot(directory);
    const host = bot;
    const server = createServer(
      { requestTimeout: 15000 },
      async (request, response) => {
        if (request.url !== '/chat' || request.method !== 'POST') {
          request.resume();
          return answer(response, 404, {});
        }
        try {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of request) {
            size += chunk.length;
            if (size > 128 * 1024)
              throw new BotError(
                413,
                'invalid_request',
                'request payload too large',
              );
            chunks.push(chunk);
          }
          const frame = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            owner: string;
            op:
              | ChatOperation
              | { action: 'configure' }
              | { action: 'disable' }
              | { action: 'test' }
              | { action: 'claim'; issuer: string }
              | {
                  action: 'receipt';
                  receipt: string;
                  state:
                    | 'sent'
                    | 'unknown'
                    | 'refused'
                    | 'issued'
                    | 'target_rejected'
                    | 'not_dispatched';
                }
              | {
                  action: 'inbound';
                  request: string;
                  text: string;
                  files?: ChatFile[];
                };
            route?: ChatRoute;
            config?: RemoteModel;
            version?: string;
          };
          if (!frame.owner || !frame.op || typeof frame.owner !== 'string')
            throw new BotError(
              400,
              'invalid_request',
              'missing owner or operation',
            );
          if (frame.version !== undefined) {
            if (
              typeof frame.version !== 'string' ||
              !validVersion(frame.version)
            )
              throw new BotError(
                400,
                'invalid_version',
                'invalid client semantic version',
              );
            if (majorMinor(frame.version) !== majorMinor(VERSION))
              throw new BotError(
                409,
                'version_mismatch',
                'client and host version mismatch',
              );
          }
          if (frame.op.action === 'configure') {
            if (!frame.config)
              throw new BotError(
                400,
                'invalid_request',
                'missing bot configuration',
              );
            host.configure(frame.config);
            return answer(response, 200, { configured: true });
          }
          if (frame.op.action === 'disable') {
            host.disable();
            return answer(response, 200, { disabled: true });
          }
          if (frame.op.action === 'claim')
            return answer(response, 200, {
              delivery: host.claim(frame.op.issuer),
            });
          if (frame.op.action === 'receipt') {
            if (!RECEIPT_STATES.has(frame.op.state))
              throw new BotError(
                400,
                'invalid_request',
                'invalid receipt state',
              );
            host.delivered(frame.op.receipt, frame.op.state);
            return answer(response, 200, {});
          }
          if (frame.op.action === 'inbound') {
            if (!frame.config || !frame.route)
              throw new BotError(
                503,
                'bot_not_enabled',
                'bot is not configured',
              );
            return answer(
              response,
              200,
              host.inbound(
                frame.owner,
                frame.op.request,
                frame.op.text,
                frame.config,
                frame.route,
                frame.op.files,
              ),
            );
          }
          if (frame.op.action === 'test') {
            if (!frame.config)
              throw new BotError(
                503,
                'bot_not_enabled',
                'bot model is not enabled',
              );
            await remoteCompletion(
              directory,
              frame.config,
              [{ id: 'test', role: 'user', content: 'reply OK' }],
              AbortSignal.timeout(15000),
              () => {},
              true,
            );
            return answer(response, 200, { tested: true, version: VERSION });
          }
          return answer(
            response,
            200,
            host.run(frame.owner, frame.op, frame.config, frame.route),
          );
        } catch (error) {
          if (error instanceof BotError)
            return answer(response, error.status, {
              code: error.code,
              message: error.message,
            });
          return answer(response, 500, {
            code: 'host_internal_error',
            message: 'bot host failed to complete request',
          });
        }
      },
    );
    await new Promise<void>((ok, fail) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EINVAL' || error.code === 'ENAMETOOLONG') {
          fail(
            new Error(
              `unix socket path too long (${socketBytes} bytes, max ${maxSocketBytes}): ${socket}`,
            ),
          );
          return;
        }
        fail(error);
      };
      server.once('error', onError);
      server.listen(socket, () => {
        server.off('error', onError);
        ok();
      });
    });
    return async () => {
      await new Promise<void>((ok, fail) =>
        server.close((e) => (e ? fail(e) : ok())),
      );
      await host.close();
      await release();
    };
  } catch (error) {
    await bot?.close();
    await release();
    throw error;
  }
}

export async function runRemoteBot(args: string[]): Promise<number> {
  if (args.length !== 1 || !args[0] || !isAbsolute(args[0]))
    throw new Error('usage: circle remote-bot <private service directory>');
  process.umask(0o077);
  const close = await serveRemoteBot(args[0]);
  await new Promise<void>((resolve, reject) => {
    const stop = () => {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
      close().then(resolve, reject);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  return 0;
}

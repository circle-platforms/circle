import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, lstat, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { WSClient } from '@wecom/aibot-node-sdk';
import { postHub, transferHubFile } from './hub-client.ts';
import { WeComApplication, loginUrl } from './identity.ts';
import {
  privateInput,
  safeAttachmentName,
  type Channel,
  type DeliveryItem,
  type FileRef,
  type Frame,
  type Identity,
} from './protocol.ts';

export { privateInput };

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 20480;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class ChannelSession {
  readonly db: DatabaseSync;
  private current?: {
    id: string;
    scope: string;
    channel: Channel;
    app: WeComApplication;
    client: WSClient;
    ready: boolean;
  };
  private busy = false;
  private downloads = new Set<Promise<void>>();
  readonly now: () => number;
  private timer: NodeJS.Timeout;
  private boundApp?: { id: string; value: WeComApplication };
  readonly create: (channel: Channel) => WSClient;
  readonly fetcher: typeof fetch;

  constructor(
    directory: string,
    create = (c: Channel) =>
      new WSClient({
        botId: c.bot,
        secret: c.secret,
        maxAuthFailureAttempts: 0,
        logger: quiet,
      }),
    fetcher = fetch,
    now = Date.now,
  ) {
    this.create = create;
    this.fetcher = fetcher;
    this.now = now;
    this.db = new DatabaseSync(join(directory, 'channel.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS batch(seq INTEGER PRIMARY KEY, scope TEXT NOT NULL,request TEXT NOT NULL,sender TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,UNIQUE(scope,request));
      CREATE TABLE IF NOT EXISTS part(seq INTEGER PRIMARY KEY,scope TEXT NOT NULL,platform_id TEXT NOT NULL,batch INTEGER NOT NULL,body TEXT NOT NULL,files TEXT,UNIQUE(scope,platform_id));
      CREATE TABLE IF NOT EXISTS peer(scope TEXT NOT NULL,subject TEXT NOT NULL,sender TEXT NOT NULL,PRIMARY KEY(scope,subject));
    `);
    this.db
      .prepare("UPDATE part SET files='[]',body=body||? WHERE files IS NULL")
      .run('（附件接收中断，请重新上传）');
    this.timer = setInterval(() => void this.flush(), 1000);
    this.timer.unref();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  application(identity: Identity) {
    const id = digest([identity.tenant, identity.application, identity.secret]);
    if (this.boundApp?.id !== id)
      this.boundApp = {
        id,
        value: new WeComApplication(identity, this.fetcher),
      };
    return this.boundApp.value;
  }

  configure(channel: Channel, identity: Identity) {
    const id = digest([channel, identity]);
    if (this.current?.id === id) return;
    this.disconnect();
    const client = this.create(channel);
    const runtime = (this.current = {
      id,
      scope: digest([identity.tenant, channel.bot]),
      channel,
      app: this.application(identity),
      client,
      ready: false,
    } as NonNullable<typeof this.current>);
    client.on('authenticated', () => {
      runtime.ready = true;
    });
    client.on('disconnected', () => {
      runtime.ready = false;
    });
    client.on('error', () => {});
    client.on('message', (frame) => {
      if (this.current !== runtime) return;
      const input = privateInput(frame as Frame, channel.bot);
      if (!input) return;
      this.enqueueInbound(runtime, input);
    });
    client.connect();
  }

  private enqueueInbound(
    runtime: NonNullable<typeof this.current>,
    input: NonNullable<ReturnType<typeof privateInput>>,
  ) {
    if (
      this.db
        .prepare('SELECT 1 FROM part WHERE scope=? AND platform_id=?')
        .get(runtime.scope, input.platformId)
    )
      return;
    const now = this.now();
    const open = this.db
      .prepare(
        "SELECT seq FROM batch WHERE scope=? AND sender=? AND state='open' AND due>=? ORDER BY seq DESC LIMIT 1",
      )
      .get(runtime.scope, input.sender, now);
    this.tx(() => {
      const batch =
        open?.seq ??
        this.db
          .prepare(
            "INSERT INTO batch(scope,request,sender,state,due) VALUES(?,?,?,'open',?)",
          )
          .run(runtime.scope, input.platformId, input.sender, now)
          .lastInsertRowid;
      this.db
        .prepare(
          'INSERT INTO part(scope,platform_id,batch,body,files) VALUES(?,?,?,?,?)',
        )
        .run(
          runtime.scope,
          input.platformId,
          batch,
          input.text,
          input.media.length ? null : '[]',
        );
      if (input.media.length)
        this.db
          .prepare('UPDATE batch SET due=? WHERE seq=?')
          .run(now + 3000, batch);
    });
    if (!input.media.length) return;
    const pull = this.downloadMedia(runtime, input);
    this.downloads.add(pull);
    void pull.finally(() => this.downloads.delete(pull));
  }

  private async downloadMedia(
    runtime: NonNullable<typeof this.current>,
    input: NonNullable<ReturnType<typeof privateInput>>,
  ) {
    try {
      const subject = await runtime.app.fromBot(input.sender);
      const allowed = await this.post(runtime, {
        action: 'authorize',
        subject,
      });
      if (!allowed.ok) throw new Error('unavailable');
      const files: FileRef[] = [];
      for (const media of input.media) {
        if (runtime !== this.current) throw new Error('channel changed');
        const { buffer, filename } = await runtime.client.downloadFile(
          media.url,
          media.aeskey,
        );
        if (buffer.length > MAX_ATTACHMENT_BYTES)
          throw new Error('attachment too large');
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const name = safeAttachmentName(filename);
        const response = await this.transfer(runtime, subject, sha256, buffer);
        const receipt = await response.json();
        if (
          !response.ok ||
          receipt.sha256 !== sha256 ||
          receipt.size !== buffer.length
        )
          throw new Error('file integrity');
        files.push({ name, sha256, size: buffer.length });
      }
      this.db
        .prepare('UPDATE part SET files=? WHERE scope=? AND platform_id=?')
        .run(JSON.stringify(files), runtime.scope, input.platformId);
    } catch {
      this.db
        .prepare(
          "UPDATE part SET files='[]',body=body||? WHERE scope=? AND platform_id=?",
        )
        .run('（附件未接收，请重新上传）', runtime.scope, input.platformId);
    }
  }

  disconnect() {
    const current = this.current;
    this.current = undefined;
    current?.client.disconnect();
  }

  private post(run: { channel: Channel }, body: unknown) {
    if (run !== this.current) throw new Error('通道已更改');
    return postHub(this.fetcher, run.channel, body);
  }

  private transfer(
    run: { channel: Channel },
    subject: string,
    sha: string,
    buffer?: Buffer,
  ) {
    if (run !== this.current) throw new Error('文件不可用');
    return transferHubFile(this.fetcher, run.channel, subject, sha, buffer);
  }

  private async flushInbound(run: NonNullable<typeof this.current>) {
    const batch = this.db
      .prepare(
        `SELECT * FROM batch b WHERE b.scope=? AND b.state IN ('open','sending') AND due<=? AND NOT EXISTS(SELECT 1 FROM part p WHERE p.batch=b.seq AND p.files IS NULL) ORDER BY b.seq LIMIT 1`,
      )
      .get(run.scope, this.now());
    if (!batch) return;
    this.db
      .prepare("UPDATE batch SET state='sending',due=? WHERE seq=?")
      .run(this.now() + 1000, Number(batch.seq));
    const parts = this.db
      .prepare('SELECT body,files FROM part WHERE batch=? ORDER BY seq')
      .all(Number(batch.seq));
    const files = parts.flatMap(
      (p) => JSON.parse(String(p.files)) as FileRef[],
    );
    const subject = await run.app.fromBot(String(batch.sender));
    const accepted = await this.post(run, {
      action: 'inbound',
      subject,
      platformId: batch.request,
      text: parts
        .map((p) => p.body)
        .filter(Boolean)
        .join('\n'),
      ...(files.length ? { files } : {}),
    });
    if (accepted.ok || accepted.status === 403 || accepted.status === 400) {
      if (accepted.ok)
        this.db
          .prepare(
            'INSERT INTO peer VALUES(?,?,?) ON CONFLICT(scope,subject) DO UPDATE SET sender=excluded.sender',
          )
          .run(run.scope, subject, String(batch.sender));
      this.tx(() => {
        this.db
          .prepare('UPDATE batch SET state=? WHERE seq=?')
          .run(accepted.ok ? 'accepted' : 'refused', Number(batch.seq));
        this.db
          .prepare("UPDATE part SET body='',files='[]' WHERE batch=?")
          .run(Number(batch.seq));
      });
    }
  }

  private async flushOutbound(run: NonNullable<typeof this.current>) {
    const next = await this.post(run, { action: 'next' });
    if (!next.ok) return;
    const item = (await next.json()).delivery as DeliveryItem | null;
    if (!item || run !== this.current) return;
    const peer = this.db
      .prepare('SELECT sender FROM peer WHERE scope=? AND subject=?')
      .get(run.scope, item.subject);
    const to = String(peer?.sender ?? item.subject);
    const content = String(item.text);
    let state: 'not_sent' | 'unknown' | 'sent' | 'refused' = 'not_sent';
    let acknowledgment: { request: string; code: number } | undefined;
    try {
      let result;
      if (item.file) {
        if (item.file.sha256 !== item.sha256 || item.file.size !== item.size)
          throw new Error('file declaration mismatch');
        const got = await this.transfer(run, item.subject, item.file.sha256);
        const contentLength = got.headers.get('content-length');
        if (
          !got.ok ||
          contentLength === null ||
          Number(contentLength) !== item.file.size ||
          item.file.size > MAX_ATTACHMENT_BYTES
        )
          throw new Error('file unavailable');
        const bytes = Buffer.from(await got.arrayBuffer());
        if (
          bytes.length !== item.size ||
          createHash('sha256').update(bytes).digest('hex') !== item.sha256
        )
          throw new Error('file integrity');
        const media = await run.client.uploadMedia(bytes, {
          type: 'file',
          filename: item.file.name,
        });
        state = 'unknown';
        result = await run.client.sendMediaMessage(to, 'file', media.media_id);
      } else {
        if (
          createHash('sha256').update(content).digest('hex') !== item.sha256 ||
          Buffer.byteLength(content) !== item.size
        )
          throw new Error('message integrity');
        if (item.size <= MAX_INLINE_TEXT_BYTES) {
          state = 'unknown';
          result = await run.client.sendMessage(to, {
            msgtype: 'markdown',
            markdown: { content },
          });
        } else {
          const media = await run.client.uploadMedia(Buffer.from(content), {
            type: 'file',
            filename: 'reply.md',
          });
          state = 'unknown';
          result = await run.client.sendMediaMessage(
            to,
            'file',
            media.media_id,
          );
        }
      }
      if (
        typeof result.headers?.req_id === 'string' &&
        typeof result.errcode === 'number'
      ) {
        acknowledgment = {
          request: createHash('sha256')
            .update(result.headers.req_id)
            .digest('hex'),
          code: result.errcode,
        };
        state = result.errcode === 0 ? 'sent' : 'refused';
      }
    } catch {
      /* Keep the observed dispatch stage when no acknowledgment arrives. */
    }
    await this.post(run, {
      action: 'receipt',
      receipt: item.receipt,
      state,
      reached_target:
        state === 'not_sent' ? false : state === 'unknown' ? null : true,
      ...(acknowledgment ? { acknowledgment } : {}),
    });
  }

  async flush() {
    const run = this.current;
    if (!run?.ready || this.busy) return;
    this.busy = true;
    try {
      await this.flushInbound(run);
      await this.flushOutbound(run);
    } catch {
      /* The next poll can recover reads. Claimed writes stay unknown. */
    } finally {
      this.busy = false;
    }
  }

  async close() {
    clearInterval(this.timer);
    this.disconnect();
    await Promise.allSettled(this.downloads);
    while (this.busy) await new Promise((ok) => setTimeout(ok, 20));
    this.db.close();
  }
}

export async function serveChannel(directory: string) {
  if (!isAbsolute(directory)) throw new Error('需要私有服务目录');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw new Error('需要私有服务目录');
  const release = await lockfile.lock(directory, {
    lockfilePath: join(directory, 'channel.lock'),
    retries: 0,
  });
  const socket = join(directory, 'channel.sock');
  const adapter = new ChannelSession(directory);
  const server = createServer({ requestTimeout: 15000 }, async (req, res) => {
    const reply = (status: number, data: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(data));
    };
    if (req.method !== 'POST' || req.url !== '/chat') {
      req.resume();
      return reply(404, {});
    }
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 32768) throw new Error();
        parts.push(part);
      }
      const frame = JSON.parse(Buffer.concat(parts).toString());
      switch (frame.action) {
        case 'configure':
          adapter.configure(frame.channel, frame.identity);
          return reply(200, { configured: true });
        case 'disconnect':
          adapter.disconnect();
          return reply(200, {});
        case 'qr':
          return reply(200, {
            location: loginUrl(frame, frame.redirect, frame.state),
          });
        case 'identity':
          return reply(200, {
            subject: await adapter.application(frame).fromCode(frame.code),
          });
        default:
          return reply(400, {});
      }
    } catch {
      return reply(503, { message: '通道操作未完成' });
    }
  });
  try {
    const previous = await lstat(socket).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
      return null;
    });
    if (previous) {
      if (!previous.isSocket()) throw new Error('套接字路径已被占用');
      await unlink(socket);
    }
    await new Promise<void>((ok, fail) => {
      server.once('error', fail);
      server.listen(socket, () => {
        server.off('error', fail);
        ok();
      });
    });
  } catch (e) {
    await adapter.close();
    await release();
    throw e;
  }
  return async () => {
    await new Promise((ok) => server.close(ok));
    await adapter.close();
    await release();
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  process.umask(0o077);
  const close = await serveChannel(process.argv[2] ?? '');
  let stopping = false;
  const stop = () => {
    if (!stopping) {
      stopping = true;
      void close();
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

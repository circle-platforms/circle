import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, lstat, unlink } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { decryptFile, WSClient } from '@wecom/aibot-node-sdk';
import { getFile, postHub, transferHubFile } from './hub-client.ts';
import { WeComApplication, loginUrl } from './identity.ts';
import {
  privateInput,
  safeAttachmentName,
  type Channel,
  type DeliveryItem,
  type FileRef,
  type Frame,
  type Identity,
  type Media,
  type ReceiptOutcome,
} from './protocol.ts';

export { privateInput };

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const WECOM_AES_PADDING_BYTES = 32;
const MAX_INLINE_TEXT_BYTES = 20480;
const MAX_BATCH_ATTEMPTS = 5;
const BATCH_BACKOFF_BASE_MS = 1000;
const BATCH_BACKOFF_MAX_MS = 60_000;
const DEFAULT_WECOM_MEDIA_HOSTS = new Set([
  'qyapi.weixin.qq.com',
  'wwcdn.weixin.qq.com',
  'wework.qpic.cn',
  'wx.qlogo.cn',
]);
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha256Utf8 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex');

function verifyDeliveryIntent(item: DeliveryItem) {
  const intent = item.intent;
  if (!intent || typeof item.text !== 'string')
    throw new Error('delivery intent missing');
  const textSize = Buffer.byteLength(item.text, 'utf8');
  const textSha256 = textSize > 0 ? sha256Utf8(item.text) : null;
  if (intent.text_size !== textSize || intent.text_sha256 !== textSha256)
    throw new Error('text intent mismatch');
  const file = item.file ?? null;
  const fileSha256 = file ? file.sha256 : null;
  const fileSize = file ? file.size : null;
  const nameSha256 = file ? sha256Utf8(file.name) : null;
  if (
    file &&
    (typeof file.name !== 'string' ||
      !/^[0-9a-f]{64}$/.test(file.sha256) ||
      !Number.isInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_ATTACHMENT_BYTES)
  )
    throw new Error('file declaration invalid');
  if (
    intent.file_sha256 !== fileSha256 ||
    intent.file_size !== fileSize ||
    intent.name_sha256 !== nameSha256
  )
    throw new Error('file intent mismatch');
  const combinedSize = textSize + (fileSize ?? 0);
  const combinedSha256 = sha256Utf8(
    JSON.stringify({
      file_sha256: fileSha256,
      file_size: fileSize,
      name_sha256: nameSha256,
      text_sha256: textSha256,
      text_size: textSize,
    }),
  );
  if (
    intent.size !== combinedSize ||
    intent.sha256 !== combinedSha256 ||
    item.size !== intent.size ||
    item.sha256 !== intent.sha256
  )
    throw new Error('combined intent mismatch');
}

function maxUnixSocketPathBytes(platform = process.platform): number {
  return platform === 'darwin' ? 103 : 107;
}

function parseMediaFilename(
  contentDisposition: string | null,
): string | undefined {
  if (!contentDisposition) return undefined;
  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;\s]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const match = contentDisposition.match(/filename="?([^";\s]+)"?/i);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return undefined;
}

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
  readonly mediaHosts: ReadonlySet<string>;

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
    mediaHosts: ReadonlySet<string> = DEFAULT_WECOM_MEDIA_HOSTS,
  ) {
    this.create = create;
    this.fetcher = fetcher;
    this.now = now;
    this.mediaHosts = new Set([...mediaHosts].map((h) => h.toLowerCase()));
    this.db = new DatabaseSync(join(directory, 'channel.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS batch(seq INTEGER PRIMARY KEY, scope TEXT NOT NULL,request TEXT NOT NULL,sender TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,UNIQUE(scope,request));
      CREATE TABLE IF NOT EXISTS part(seq INTEGER PRIMARY KEY,scope TEXT NOT NULL,platform_id TEXT NOT NULL,batch INTEGER NOT NULL,body TEXT NOT NULL,files TEXT,UNIQUE(scope,platform_id));
      CREATE TABLE IF NOT EXISTS peer(scope TEXT NOT NULL,subject TEXT NOT NULL,sender TEXT NOT NULL,PRIMARY KEY(scope,subject));
    `);
    const batchColumns = new Set(
      (
        this.db.prepare('PRAGMA table_info(batch)').all() as Array<{
          name: string;
        }>
      ).map((col) => col.name),
    );
    if (!batchColumns.has('attempts'))
      this.db.exec(
        'ALTER TABLE batch ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0',
      );
    if (!batchColumns.has('next_at'))
      this.db.exec(
        'ALTER TABLE batch ADD COLUMN next_at INTEGER NOT NULL DEFAULT 0',
      );
    if (!batchColumns.has('error'))
      this.db.exec('ALTER TABLE batch ADD COLUMN error TEXT');
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

  private async downloadEncryptedMedia(
    runtime: NonNullable<typeof this.current>,
    media: Media,
  ): Promise<{ buffer: Buffer; filename?: string }> {
    if (!URL.canParse(media.url)) throw new Error('invalid media url');
    const url = new URL(media.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !this.mediaHosts.has(url.hostname.toLowerCase())
    )
      throw new Error('media host not allowed');
    const maxWireBytes = media.aeskey
      ? MAX_ATTACHMENT_BYTES + WECOM_AES_PADDING_BYTES
      : MAX_ATTACHMENT_BYTES;
    const controller = new AbortController();
    const response = await this.fetcher(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('media download failed');
    }
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declared = Number(contentLengthHeader);
      if (
        !Number.isFinite(declared) ||
        declared < 0 ||
        declared > maxWireBytes
      ) {
        await response.body?.cancel();
        controller.abort();
        throw new Error('attachment too large');
      }
    }
    const filename = parseMediaFilename(
      response.headers.get('content-disposition'),
    );
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          if (runtime !== this.current) {
            await reader.cancel().catch(() => {});
            controller.abort();
            throw new Error('channel changed');
          }
          const { done, value } = await reader.read();
          if (done) break;
          if (!value?.byteLength) continue;
          total += value.byteLength;
          if (total > maxWireBytes) {
            await reader.cancel().catch(() => {});
            controller.abort();
            throw new Error('attachment too large');
          }
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        controller.abort();
        throw error;
      }
    }
    const raw = Buffer.concat(chunks, total);
    const buffer = media.aeskey ? decryptFile(raw, media.aeskey) : raw;
    if (buffer.length > MAX_ATTACHMENT_BYTES)
      throw new Error('attachment too large');
    return { buffer, filename };
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
      await allowed.body?.cancel();
      if (!allowed.ok) throw new Error('unavailable');
      const files: FileRef[] = [];
      for (const media of input.media) {
        if (runtime !== this.current) throw new Error('channel changed');
        const { buffer, filename } = await this.downloadEncryptedMedia(
          runtime,
          media,
        );
        if (buffer.length > MAX_ATTACHMENT_BYTES)
          throw new Error('attachment too large');
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const name = safeAttachmentName(filename);
        const response = await this.transfer(runtime, subject, sha256, buffer);
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('file integrity');
        }
        let receipt: { sha256?: unknown; size?: unknown };
        try {
          receipt = (await response.json()) as {
            sha256?: unknown;
            size?: unknown;
          };
        } catch {
          throw new Error('file integrity');
        }
        if (receipt.sha256 !== sha256 || receipt.size !== buffer.length)
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
    receipt?: string,
  ) {
    if (run !== this.current) throw new Error('文件不可用');
    return transferHubFile(
      this.fetcher,
      run.channel,
      subject,
      sha,
      buffer,
      receipt,
    );
  }

  private getFile(
    run: { channel: Channel },
    sha256: string,
    subject: string,
    receipt: string,
  ) {
    if (run !== this.current) throw new Error('文件不可用');
    return getFile(this.fetcher, run.channel, sha256, subject, receipt);
  }

  private async flushInbound(run: NonNullable<typeof this.current>) {
    const now = this.now();
    const batches = this.db
      .prepare(
        `SELECT * FROM batch b WHERE b.scope=? AND b.state IN ('open','pending','sending') AND b.due<=? AND b.next_at<=? AND NOT EXISTS(SELECT 1 FROM part p WHERE p.batch=b.seq AND p.files IS NULL) ORDER BY b.seq`,
      )
      .all(run.scope, now, now);
    for (const batch of batches) {
      if (run !== this.current) break;
      const seq = Number(batch.seq);
      const attempts = Number(batch.attempts ?? 0);
      this.db
        .prepare("UPDATE batch SET state='sending',due=? WHERE seq=?")
        .run(this.now() + 1000, seq);
      const parts = this.db
        .prepare('SELECT body,files FROM part WHERE batch=? ORDER BY seq')
        .all(seq);
      const files = parts.flatMap(
        (p) => JSON.parse(String(p.files)) as FileRef[],
      );
      try {
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
        await accepted.body?.cancel();
        if (accepted.ok || accepted.status === 403 || accepted.status === 400) {
          if (accepted.ok)
            this.db
              .prepare(
                'INSERT INTO peer VALUES(?,?,?) ON CONFLICT(scope,subject) DO UPDATE SET sender=excluded.sender',
              )
              .run(run.scope, subject, String(batch.sender));
          this.tx(() => {
            this.db
              .prepare('UPDATE batch SET state=?,error=NULL WHERE seq=?')
              .run(accepted.ok ? 'accepted' : 'refused', seq);
            this.db
              .prepare("UPDATE part SET body='',files='[]' WHERE batch=?")
              .run(seq);
          });
        } else {
          throw new Error('hub inbound status ' + accepted.status);
        }
      } catch (error) {
        if (run !== this.current) {
          this.db
            .prepare("UPDATE batch SET state='pending' WHERE seq=?")
            .run(seq);
          break;
        }
        const nextAttempts = attempts + 1;
        const failAt = this.now();
        const reason =
          error instanceof Error
            ? error.message.slice(0, 200)
            : 'inbound failed';
        if (nextAttempts >= MAX_BATCH_ATTEMPTS) {
          this.db
            .prepare(
              "UPDATE batch SET state='failed',attempts=?,next_at=0,error=? WHERE seq=?",
            )
            .run(nextAttempts, reason, seq);
          console.error('[wecom] inbound batch quarantined:', {
            seq,
            attempts: nextAttempts,
            error: reason,
          });
        } else {
          const backoff = Math.min(
            BATCH_BACKOFF_MAX_MS,
            BATCH_BACKOFF_BASE_MS * 2 ** (nextAttempts - 1),
          );
          this.db
            .prepare(
              "UPDATE batch SET state='pending',attempts=?,next_at=?,error=? WHERE seq=?",
            )
            .run(nextAttempts, failAt + backoff, reason, seq);
          console.warn('[wecom] inbound batch retrying:', {
            seq,
            attempts: nextAttempts,
            nextAt: failAt + backoff,
            error: reason,
          });
        }
      }
    }
  }

  private async flushOutbound(run: NonNullable<typeof this.current>) {
    const next = await this.post(run, { action: 'next' });
    if (!next.ok) {
      await next.body?.cancel();
      return;
    }
    const item = (await next.json()).delivery as DeliveryItem | null;
    if (!item || run !== this.current) return;
    const peer = this.db
      .prepare('SELECT sender FROM peer WHERE scope=? AND subject=?')
      .get(run.scope, item.subject);
    const to = String(peer?.sender ?? item.subject);
    let state: ReceiptOutcome = 'not_dispatched';
    let acknowledgment: { request: string; code: number } | undefined;
    try {
      verifyDeliveryIntent(item);
      let result;
      if (item.file) {
        const got = await this.getFile(
          run,
          item.file.sha256,
          item.subject,
          item.receipt,
        );
        const contentLength = got.headers.get('content-length');
        if (
          !got.ok ||
          contentLength === null ||
          Number(contentLength) !== item.intent.file_size ||
          item.file.size > MAX_ATTACHMENT_BYTES
        ) {
          await got.body?.cancel();
          throw new Error('file unavailable');
        }
        const bytes = Buffer.from(await got.arrayBuffer());
        if (
          bytes.length !== item.intent.file_size ||
          createHash('sha256').update(bytes).digest('hex') !==
            item.intent.file_sha256
        )
          throw new Error('file integrity');
        const media = await run.client.uploadMedia(bytes, {
          type: 'file',
          filename: item.file.name,
        });
        state = 'unknown';
        result = await run.client.sendMediaMessage(to, 'file', media.media_id);
      } else {
        const content =
          item.role === 'user' ? '客户端消息：\n' + item.text : item.text;
        if (Buffer.byteLength(content) <= MAX_INLINE_TEXT_BYTES) {
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
        result.headers.req_id.length > 0 &&
        typeof result.errcode === 'number'
      ) {
        acknowledgment = {
          request: createHash('sha256')
            .update(result.headers.req_id)
            .digest('hex'),
          code: result.errcode,
        };
        state = result.errcode === 0 ? 'issued' : 'target_rejected';
      }
    } catch {
      /* Keep the observed dispatch stage when no acknowledgment arrives. */
    }
    const ack = await this.post(run, {
      action: 'receipt',
      receipt: item.receipt,
      state,
      reached_target:
        state === 'not_dispatched' ? false : state === 'unknown' ? null : true,
      ...(acknowledgment ? { acknowledgment } : {}),
      ...(state === 'unknown'
        ? {
            missing: ['未取得与本条消息对应的平台确认'],
            next: '核对目标侧记录，不自动重发',
          }
        : {}),
    });
    await ack.body?.cancel();
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
  const socket = join(directory, 'channel.sock');
  const maxSocketBytes = maxUnixSocketPathBytes();
  const socketBytes = Buffer.byteLength(socket, 'utf8');
  if (socketBytes > maxSocketBytes) {
    throw new Error(
      `unix socket path too long (${socketBytes} bytes, max ${maxSocketBytes}): ${socket}`,
    );
  }
  const release = await lockfile.lock(directory, {
    lockfilePath: join(directory, 'channel.lock'),
    retries: 0,
  });
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

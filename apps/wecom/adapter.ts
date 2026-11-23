import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import lockfile from 'proper-lockfile';
import { decryptFile, WSClient } from '@wecom/aibot-node-sdk';
import { getFile, postHub, transferHubFile } from './hub-client.ts';
import { WeComApiError, WeComApplication, loginUrl } from './identity.ts';
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
const MAX_CONCURRENT_DOWNLOADS = 2;
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

const CHANNEL_NOTICE_MESSAGES: Record<string, string> = {
  help: '发送文本或文件即可与机器人对话；发送 /new 或“新对话”开启新会话，发送 /stop 或“停止”可取消当前回复。',
  conversation_started: '已开启新对话。',
  stop_requested: '已请求停止当前回复。',
  stop_idle: '当前没有正在生成的回复。',
  disabled_queued: '机器人模型已停用，排队的请求未执行。',
  bot_disabled_aborted: '机器人模型已停用，当前回复已中止。',
  credential_blocked: '消息不能包含机器人凭据，未予处理。',
  reply_stopped: '已停止回复。',
  host_restarted_queued: '机器人宿主已重启，排队的请求未执行。',
  host_restarted_interrupted:
    '机器人宿主已重启，上一条请求结果未知，请按需重新发送。',
  bot_not_enabled: '机器人模型尚未启用，请联系管理员配置。',
  model_invalid_question: '模型提问格式无效，请稍后重试。',
  model_credentials_blocked: '模型回复疑似包含凭据，已被拦截。',
  model_empty_reply: '模型未返回有效回复，请稍后重试。',
  model_auth_failed: '模型服务鉴权失败，请联系管理员检查配置。',
  model_id_unavailable: '当前配置的模型标识不可用，请联系管理员检查配置。',
  model_not_found: '未找到配置的模型或服务地址，请联系管理员检查配置。',
  model_unreachable: '无法连接模型服务或请求超时，请稍后重试。',
  model_invalid_reply: '模型未返回有效应答，请稍后重试。',
  attachment_integrity_failed: '附件完整性校验失败，请重新上传后再试。',
  invalid_attachment_digest: '附件摘要无效，请重新上传后再试。',
  attachment_unavailable: '附件无法读取，请重新上传后再试。',
  reply_interrupted: '模型回复已中断，结果未知，请按需重试。',
};

const LEGACY_ENGLISH_NOTICE_TEXTS: Record<string, string> = {
  'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.':
    CHANNEL_NOTICE_MESSAGES.help!,
  'started a new conversation': CHANNEL_NOTICE_MESSAGES.conversation_started!,
  'requested stop for active reply': CHANNEL_NOTICE_MESSAGES.stop_requested!,
  'no active reply to stop': CHANNEL_NOTICE_MESSAGES.stop_idle!,
  'bot model is disabled; queued message was not executed':
    CHANNEL_NOTICE_MESSAGES.disabled_queued!,
  'bot model was disabled; active reply stopped':
    CHANNEL_NOTICE_MESSAGES.bot_disabled_aborted!,
  'message cannot contain bot credentials':
    CHANNEL_NOTICE_MESSAGES.credential_blocked!,
  'reply stopped': CHANNEL_NOTICE_MESSAGES.reply_stopped!,
  'host restarted while queued; message not executed':
    CHANNEL_NOTICE_MESSAGES.host_restarted_queued!,
  'host restarted; previous request outcome unknown':
    CHANNEL_NOTICE_MESSAGES.host_restarted_interrupted!,
  'bot model is not enabled': CHANNEL_NOTICE_MESSAGES.bot_not_enabled!,
  'model did not provide a valid question':
    CHANNEL_NOTICE_MESSAGES.model_invalid_question!,
  'model reply contained credentials':
    CHANNEL_NOTICE_MESSAGES.model_credentials_blocked!,
  'model returned an empty reply': CHANNEL_NOTICE_MESSAGES.model_empty_reply!,
  'model endpoint rejected credentials':
    CHANNEL_NOTICE_MESSAGES.model_auth_failed!,
  'model id is unavailable': CHANNEL_NOTICE_MESSAGES.model_id_unavailable!,
  'endpoint or model not found': CHANNEL_NOTICE_MESSAGES.model_not_found!,
  'model endpoint unreachable or timed out':
    CHANNEL_NOTICE_MESSAGES.model_unreachable!,
  'model did not return a valid reply':
    CHANNEL_NOTICE_MESSAGES.model_invalid_reply!,
  'attachment integrity check failed':
    CHANNEL_NOTICE_MESSAGES.attachment_integrity_failed!,
  'invalid attachment digest':
    CHANNEL_NOTICE_MESSAGES.invalid_attachment_digest!,
  'attachment could not be read':
    CHANNEL_NOTICE_MESSAGES.attachment_unavailable!,
  'model reply interrupted; outcome unknown':
    CHANNEL_NOTICE_MESSAGES.reply_interrupted!,
};

export function formatChannelNotice(
  code: string | undefined,
  fallbackText: string,
): string {
  if (code && Object.hasOwn(CHANNEL_NOTICE_MESSAGES, code)) {
    return CHANNEL_NOTICE_MESSAGES[code]!;
  }
  const trimmed = fallbackText.trim();
  if (trimmed && Object.hasOwn(LEGACY_ENGLISH_NOTICE_TEXTS, trimmed)) {
    return LEGACY_ENGLISH_NOTICE_TEXTS[trimmed]!;
  }
  if (!trimmed) return '系统提示：处理状态已更新。';
  if (/[\u4e00-\u9fff]/.test(trimmed)) return trimmed;
  return '系统提示：' + trimmed;
}

export function sanitizeLogError(
  error: unknown,
  secrets: readonly string[] = [],
  maxLength = 200,
): string {
  let text =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error ?? '');
  const uniqueSecrets = [
    ...new Set(secrets.filter((s) => typeof s === 'string' && s.length > 0)),
  ].sort((a, b) => b.length - a.length);
  for (const secret of uniqueSecrets) {
    if (text.includes(secret)) {
      text = text.replaceAll(secret, '[REDACTED]');
    }
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret && text.includes(escaped)) {
      text = text.replaceAll(escaped, '[REDACTED]');
    }
  }
  text = text
    .replace(/Bearer\s+[^\s"',;}\]]+/gi, 'Bearer [REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .trim();
  if (!text) return 'inbound failed';
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

class TransientInboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientInboundError';
  }
}

class PermanentInboundError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PermanentInboundError';
    this.status = status;
  }
}

function verifyDeliveryIntent(
  item: DeliveryItem,
  maxAttachmentBytes = MAX_ATTACHMENT_BYTES,
) {
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
      file.size > maxAttachmentBytes)
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
  private readonly directory: string;
  private readonly stagingDir: string;
  private current?: {
    id: string;
    scope: string;
    channel: Channel;
    app: WeComApplication;
    client: WSClient;
    ready: boolean;
  };
  private busy = false;
  private flushing?: Promise<void>;
  private downloads = new Set<Promise<void>>();
  private activeDownloadCount = 0;
  private downloadQueue: Array<() => void> = [];
  private activeStaging = new Map<string, number>();
  readonly now: () => number;
  private timer: NodeJS.Timeout;
  private boundApp?: { id: string; value: WeComApplication };
  readonly create: (channel: Channel) => WSClient;
  readonly fetcher: typeof fetch;
  readonly mediaHosts: ReadonlySet<string>;
  readonly maxAttachmentBytes: number;

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
    maxAttachmentBytes = MAX_ATTACHMENT_BYTES,
  ) {
    this.directory = directory;
    this.stagingDir = join(directory, 'staging');
    this.create = create;
    this.fetcher = fetcher;
    this.now = now;
    this.mediaHosts = new Set([...mediaHosts].map((h) => h.toLowerCase()));
    this.maxAttachmentBytes = maxAttachmentBytes;
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
    this.sweepStagingSync();
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
    const pull = this.withDownloadSlot(() =>
      this.downloadMedia(runtime, input),
    );
    this.downloads.add(pull);
    void pull.finally(() => this.downloads.delete(pull));
  }

  private async withDownloadSlot(task: () => Promise<void>): Promise<void> {
    if (this.activeDownloadCount >= MAX_CONCURRENT_DOWNLOADS) {
      await new Promise<void>((resolve) => {
        this.downloadQueue.push(resolve);
      });
    } else {
      this.activeDownloadCount++;
    }
    try {
      await task();
    } finally {
      const next = this.downloadQueue.shift();
      if (next) {
        next();
      } else {
        this.activeDownloadCount--;
      }
    }
  }

  private retainActiveStaging(sha256: string) {
    this.activeStaging.set(sha256, (this.activeStaging.get(sha256) ?? 0) + 1);
  }

  private releaseActiveStaging(sha256: string) {
    const count = this.activeStaging.get(sha256) ?? 0;
    if (count <= 1) this.activeStaging.delete(sha256);
    else this.activeStaging.set(sha256, count - 1);
  }

  private referencedStagingShas(): Set<string> {
    const refs = new Set<string>(this.activeStaging.keys());
    const rows = this.db
      .prepare(
        "SELECT p.files FROM part p JOIN batch b ON b.seq=p.batch WHERE b.state IN ('open','pending','sending') AND p.files IS NOT NULL AND p.files<>'[]'",
      )
      .all() as Array<{ files: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.files) as Array<{ sha256?: unknown }>;
        if (!Array.isArray(parsed)) continue;
        for (const file of parsed) {
          if (
            typeof file?.sha256 === 'string' &&
            /^[0-9a-f]{64}$/.test(file.sha256)
          ) {
            refs.add(file.sha256);
          }
        }
      } catch {
        // Ignore malformed legacy rows when collecting active digests.
      }
    }
    return refs;
  }

  private sweepStagingSync() {
    if (!existsSync(this.stagingDir)) return;
    const keep = this.referencedStagingShas();
    for (const entry of readdirSync(this.stagingDir)) {
      if (!keep.has(entry)) {
        rmSync(join(this.stagingDir, entry), { recursive: true, force: true });
      }
    }
  }

  private async sweepStaging() {
    let entries: string[];
    try {
      entries = await readdir(this.stagingDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const keep = this.referencedStagingShas();
    for (const entry of entries) {
      if (!keep.has(entry)) {
        await rm(join(this.stagingDir, entry), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  private async persistStagingFile(sha256: string, buffer: Buffer) {
    if (!/^[0-9a-f]{64}$/.test(sha256))
      throw new Error('invalid staging digest');
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    await chmod(this.stagingDir, 0o700);
    const temp = join(this.stagingDir, `${sha256}.${randomUUID()}.part`);
    const target = join(this.stagingDir, sha256);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(buffer);
      await handle.chmod(0o600);
      await handle.close();
      handle = null;
      await rename(temp, target);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await rm(temp, { force: true }).catch(() => {});
    }
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
      ? this.maxAttachmentBytes + WECOM_AES_PADDING_BYTES
      : this.maxAttachmentBytes;
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
    chunks.length = 0;
    const buffer = media.aeskey ? decryptFile(raw, media.aeskey) : raw;
    if (buffer.length > this.maxAttachmentBytes)
      throw new Error('attachment too large');
    return { buffer, filename };
  }

  private async downloadMedia(
    runtime: NonNullable<typeof this.current>,
    input: NonNullable<ReturnType<typeof privateInput>>,
  ) {
    const retainedShas: string[] = [];
    let committed = false;
    try {
      if (runtime !== this.current) throw new Error('channel changed');
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
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const name = safeAttachmentName(filename);
        this.retainActiveStaging(sha256);
        retainedShas.push(sha256);
        await this.persistStagingFile(sha256, buffer);
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
      committed = true;
    } catch {
      this.db
        .prepare(
          "UPDATE part SET files='[]',body=body||? WHERE scope=? AND platform_id=?",
        )
        .run('（附件未接收，请重新上传）', runtime.scope, input.platformId);
    } finally {
      for (const sha of retainedShas) {
        this.releaseActiveStaging(sha);
      }
      if (!committed && retainedShas.length > 0) {
        await this.sweepStaging().catch(() => {});
      }
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

  private runtimeSecrets(run: NonNullable<typeof this.current>): string[] {
    return [run.channel.token, run.channel.secret, run.app.app.secret].filter(
      (s) => typeof s === 'string' && (s.length >= 4 || /[\r\n\s]/.test(s)),
    );
  }

  private isTransientStatus(status: number): boolean {
    return status === 401 || status === 408 || status === 429 || status >= 500;
  }

  private isTransientInboundError(error: unknown): boolean {
    if (error instanceof TransientInboundError) return true;
    if (error instanceof PermanentInboundError) return false;
    if (error instanceof WeComApiError) return error.errcode === -1;
    if (!(error instanceof Error)) return false;
    if (
      error.message === '企业应用尚未通过认证' ||
      error.message === '企业应用读取失败'
    ) {
      return (
        error.cause !== undefined && !(error.cause instanceof WeComApiError)
      );
    }
    return (
      error.name === 'AbortError' ||
      error.name === 'TimeoutError' ||
      error instanceof TypeError ||
      'code' in error
    );
  }

  private async putStagingFiles(
    run: NonNullable<typeof this.current>,
    subject: string,
    files: FileRef[],
  ): Promise<void> {
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.sha256)) continue;
      seen.add(file.sha256);
      if (!/^[0-9a-f]{64}$/.test(file.sha256)) {
        throw new PermanentInboundError(400, 'invalid attachment digest');
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(join(this.stagingDir, file.sha256));
      } catch {
        throw new PermanentInboundError(400, 'local staging file missing');
      }
      if (
        bytes.length !== file.size ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256
      ) {
        throw new PermanentInboundError(400, 'local staging integrity failed');
      }
      const response = await this.transfer(run, subject, file.sha256, bytes);
      if (!response.ok) {
        await response.body?.cancel();
        if (this.isTransientStatus(response.status)) {
          throw new TransientInboundError(
            'hub staging upload status ' + response.status,
          );
        }
        throw new PermanentInboundError(
          response.status,
          'hub staging upload status ' + response.status,
        );
      }
      let receipt: { sha256?: unknown; size?: unknown };
      try {
        receipt = (await response.json()) as {
          sha256?: unknown;
          size?: unknown;
        };
      } catch {
        throw new PermanentInboundError(400, 'file integrity');
      }
      if (receipt.sha256 !== file.sha256 || receipt.size !== bytes.length) {
        throw new PermanentInboundError(400, 'file integrity');
      }
    }
  }

  private async notifyRejectedSender(
    run: NonNullable<typeof this.current>,
    sender: string,
    status: number,
  ): Promise<void> {
    if (!run.ready || typeof run.client.sendMessage !== 'function') return;
    const content =
      status === 403
        ? '消息未送达：当前企业账号未绑定 Hub 账号或机器人访问权限已停用，请联系管理员处理。'
        : status === 413
          ? '消息未送达：附件数量、大小或存储配额超出限制，请精简后重试。'
          : status === 0
            ? '消息未送达：暂无法核对您的企业成员身份，请稍后重试或联系管理员。'
            : '消息未送达：请求内容或附件校验未通过，请检查后重新发送。';
    try {
      await run.client.sendMessage(sender, {
        msgtype: 'markdown',
        markdown: { content },
      });
    } catch {
      // Best-effort notification only; never roll back terminal quarantine state.
    }
  }

  private async flushInbound(run: NonNullable<typeof this.current>) {
    const deferredSenders = new Set<string>();
    while (run === this.current) {
      const now = this.now();
      const batches = this.db
        .prepare(
          `SELECT * FROM batch b
           WHERE b.scope=?
             AND b.state IN ('open','pending','sending')
             AND b.due<=?
             AND b.next_at<=?
             AND NOT EXISTS(SELECT 1 FROM part p WHERE p.batch=b.seq AND p.files IS NULL)
             AND NOT EXISTS(
               SELECT 1 FROM batch prev
               WHERE prev.scope=b.scope
                 AND prev.sender=b.sender
                 AND prev.state IN ('open','pending','sending')
                 AND prev.seq < b.seq
             )
           ORDER BY b.seq`,
        )
        .all(run.scope, now, now);
      if (!batches.length) break;
      let progressed = false;
      for (const batch of batches) {
        if (run !== this.current) break;
        const sender = String(batch.sender);
        if (deferredSenders.has(sender)) continue;
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
          const subject = await run.app.fromBot(sender);
          const payload = {
            action: 'inbound',
            subject,
            platformId: batch.request,
            text: parts
              .map((p) => p.body)
              .filter(Boolean)
              .join('\n'),
            ...(files.length ? { files } : {}),
          };
          let accepted = await this.post(run, payload);
          await accepted.body?.cancel();
          if (accepted.status === 400 && files.length > 0) {
            await this.putStagingFiles(run, subject, files);
            accepted = await this.post(run, payload);
            await accepted.body?.cancel();
          }
          if (accepted.ok) {
            this.db
              .prepare(
                'INSERT INTO peer VALUES(?,?,?) ON CONFLICT(scope,subject) DO UPDATE SET sender=excluded.sender',
              )
              .run(run.scope, subject, sender);
            this.tx(() => {
              this.db
                .prepare(
                  "UPDATE batch SET state='accepted',error=NULL WHERE seq=?",
                )
                .run(seq);
              this.db
                .prepare("UPDATE part SET body='',files='[]' WHERE batch=?")
                .run(seq);
            });
            await this.sweepStaging();
            progressed = true;
          } else if (this.isTransientStatus(accepted.status)) {
            throw new TransientInboundError(
              'hub inbound status ' + accepted.status,
            );
          } else {
            throw new PermanentInboundError(
              accepted.status,
              'hub inbound status ' + accepted.status,
            );
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
          const reason = sanitizeLogError(error, this.runtimeSecrets(run));
          const transient = this.isTransientInboundError(error);
          if (
            error instanceof PermanentInboundError ||
            (!transient && nextAttempts >= MAX_BATCH_ATTEMPTS)
          ) {
            this.tx(() => {
              this.db
                .prepare(
                  "UPDATE batch SET state='failed',attempts=?,next_at=0,error=? WHERE seq=?",
                )
                .run(nextAttempts, reason, seq);
              this.db
                .prepare("UPDATE part SET body='',files='[]' WHERE batch=?")
                .run(seq);
            });
            await this.sweepStaging();
            console.error('[wecom] inbound batch quarantined:', {
              seq,
              attempts: nextAttempts,
              error: reason,
            });
            await this.notifyRejectedSender(
              run,
              sender,
              error instanceof PermanentInboundError ? error.status : 0,
            );
            progressed = true;
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
            deferredSenders.add(sender);
          }
        }
      }
      if (!progressed) break;
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
      verifyDeliveryIntent(item, this.maxAttachmentBytes);
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
          item.file.size > this.maxAttachmentBytes
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
          item.role === 'user'
            ? '客户端消息：\n' + item.text
            : item.role === 'notice'
              ? formatChannelNotice(item.code, item.text)
              : item.text;
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
    const task = (async () => {
      try {
        await this.flushInbound(run);
        await this.flushOutbound(run);
      } catch {
        /* The next poll can recover reads. Claimed writes stay unknown. */
      } finally {
        this.busy = false;
        this.flushing = undefined;
      }
    })();
    this.flushing = task;
    await task;
  }

  async close() {
    clearInterval(this.timer);
    this.disconnect();
    await Promise.allSettled(this.downloads);
    await this.flushing;
    await this.sweepStaging();
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

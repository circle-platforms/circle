import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeAttachment, MAX_MEDIA_BYTES, mediaType } from './media.js';
import { GatewayModel } from './model.js';
import { providerErrorRecords } from './model_completion.js';
import { httpStatus } from './model_guard.js';
import { isNetworkFailure } from './net.js';
import { panelQuestion, QUESTION_SCHEMA } from './questions.js';
import type { ChatFile } from './remote_bot_protocol.js';
import { defaultSettings, isRecord } from './settings.js';
import type { Message, Tool, ToolCall } from './types.js';
import { VERSION } from './version.js';

export interface RemoteModel {
  name: string;
  protocol: string;
  endpoint: string;
  model: string;
  key: string;
}

export class BotError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly noticeCode?: string,
  ) {
    super(message);
  }
}

interface PromptQuestion {
  call: ToolCall;
  text: string;
}

export type ChatOperation =
  | { action: 'discover' }
  | { action: 'history'; conversation: string; after: number }
  | {
      action: 'send';
      conversation: string;
      request: string;
      text: string;
      files?: ChatFile[];
      replyTo?: string;
    }
  | { action: 'new'; request: string }
  | { action: 'stop'; conversation: string; request: string };

export interface ChatRoute {
  source: 'client' | 'channel';
  issuer: string;
  subject: string | null;
}

function ownerHash(owner: string): string {
  return createHash('sha256').update(owner).digest('hex');
}

export function maskKey(text: string, key: string): string {
  return key ? text.replaceAll(key, '[redacted]') : text;
}

function describeQuestion(call: ToolCall): PromptQuestion {
  const questions = call.args.questions;
  if (
    !Array.isArray(questions) ||
    questions.length < 1 ||
    questions.length > 10 ||
    !questions.every(
      (v) =>
        isRecord(v) &&
        v.secret !== true &&
        typeof v.question === 'string' &&
        v.question.trim(),
    )
  )
    throw new BotError(
      502,
      'model_output_blocked',
      'model did not provide a valid question',
      'model_invalid_question',
    );
  const text = questions
    .map((q) => {
      const panel = panelQuestion(q);
      return [
        panel.question,
        ...panel.options.map(
          (option, i) => String(i + 1) + '. ' + option.label,
        ),
      ].join('\n');
    })
    .join('\n\n');
  return { call, text };
}

const questionTool: Tool = {
  name: 'question',
  description:
    'Ask the current member for a missing input. The member can answer with text or a file.',
  parameters: QUESTION_SCHEMA,
  effect: 'read',
  run: async () => {
    throw Error('question requires a member answer');
  },
};

export async function remoteCompletion(
  home: string,
  config: RemoteModel,
  messages: Message[],
  signal: AbortSignal,
  token: (text: string) => void,
  test = false,
) {
  if (!config.key)
    throw new BotError(
      503,
      'bot_not_enabled',
      'bot model is not enabled',
      'bot_not_enabled',
    );
  const settings = defaultSettings();
  settings.auth = {
    protocol: config.protocol,
    base_url: config.endpoint,
    model: config.model,
    api_key_ref: '',
  };
  const model = new GatewayModel(
    settings,
    home,
    undefined,
    {},
    undefined,
    config.key,
  );
  try {
    const response = await model.complete({
      system: '',
      messages,
      tools: test ? [] : [questionTool],
      signal,
      token: (text, thinking) => {
        if (!thinking) token(text);
      },
      ...(test ? { maxTokens: 16 } : {}),
    });
    if (
      !test &&
      response.message.tool_calls?.length === 1 &&
      response.message.tool_calls[0]!.name === 'question'
    ) {
      const call = response.message.tool_calls[0]!;
      if (config.key && JSON.stringify(call).includes(config.key))
        throw new BotError(
          502,
          'model_output_blocked',
          'model reply contained credentials',
          'model_credentials_blocked',
        );
      return describeQuestion(call);
    }
    if (!response.message.content.trim())
      throw new BotError(
        502,
        'model_empty_reply',
        'model returned an empty reply',
        'model_empty_reply',
      );
    return response.message.content;
  } catch (error) {
    if (error instanceof BotError) throw error;
    const status = httpStatus(error);
    if (status === 401 || status === 403)
      throw new BotError(
        422,
        'model_auth_failed',
        'model endpoint rejected credentials',
        'model_auth_failed',
      );
    if (
      providerErrorRecords(error).some(
        (row) => row.code === 'model_not_found' || row.code === 'invalid_model',
      )
    )
      throw new BotError(
        422,
        'model_not_found',
        'model id is unavailable',
        'model_id_unavailable',
      );
    if (status === 404)
      throw new BotError(
        422,
        'model_not_found',
        'endpoint or model not found',
        'model_not_found',
      );
    if (signal.aborted || isNetworkFailure(error))
      throw new BotError(
        503,
        'model_unreachable',
        'model endpoint unreachable or timed out',
        'model_unreachable',
      );
    throw new BotError(
      502,
      'model_unreachable',
      'model did not return a valid reply',
      'model_invalid_reply',
    );
  }
}

export const MAX_HISTORY_TEXT_BYTES = 256 * 1024;
export const MAX_REPLY_DELIVERY_CHARS = 64_000;
const REPLY_CHUNK_CHARS = 60_000;
const NOTICE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

export function splitReplyText(text: string): string[] {
  if (text.length <= MAX_REPLY_DELIVERY_CHARS) return [text];
  const rawChunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + REPLY_CHUNK_CHARS, text.length);
    if (end < text.length) {
      const last = text.charCodeAt(end - 1);
      const next = text.charCodeAt(end);
      if (
        last >= 0xd800 &&
        last <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      ) {
        end -= 1;
      }
    }
    rawChunks.push(text.slice(start, end));
    start = end;
  }
  const total = rawChunks.length;
  return rawChunks.map(
    (chunk, index) => `${chunk}\n\n(part ${index + 1}/${total})`,
  );
}

export async function attachFiles(
  home: string,
  owner: string,
  files: ChatFile[],
  message: Message,
  budget: { media: number; text?: number } = { media: MAX_MEDIA_BYTES },
  allowMissing = false,
): Promise<void> {
  for (const file of files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      if (allowMissing) {
        message.content +=
          '\n' +
          JSON.stringify({
            name: file.name,
            size: file.size,
            sha256: file.sha256,
          }) +
          ' (file unavailable)';
        continue;
      }
      throw new BotError(
        400,
        'invalid_request',
        'invalid attachment digest',
        'invalid_attachment_digest',
      );
    }
    message.content +=
      '\n' +
      JSON.stringify({ name: file.name, size: file.size, sha256: file.sha256 });
    const mime = mediaType(file.name);
    const text =
      /\.(txt|md|json|csv|tsv|xml|km)$/i.test(file.name) &&
      file.size <= 128 * 1024;
    const available = mime ? budget.media : (budget.text ?? budget.media);
    if ((!mime && !text) || file.size > available) {
      message.content += ' (file reference only)';
      continue;
    }
    try {
      const bytes = await readFile(
        join(home, 'files', ownerHash(owner), file.sha256),
      );
      if (
        bytes.length !== file.size ||
        createHash('sha256').update(bytes).digest('hex') !== file.sha256
      ) {
        throw new BotError(
          422,
          'attachment_integrity_failed',
          'attachment integrity check failed',
          'attachment_integrity_failed',
        );
      }
      if (mime) {
        const attachment = makeAttachment(bytes, mime, file.name);
        (message.attachments ??= []).push(attachment);
        budget.media -= bytes.length;
      } else {
        message.content += '\n' + bytes.toString('utf8');
        if (budget.text !== undefined) budget.text -= bytes.length;
        else budget.media -= bytes.length;
      }
    } catch (error) {
      if (allowMissing) {
        message.content += ' (file unavailable)';
        continue;
      }
      if (error instanceof BotError) throw error;
      throw new BotError(
        422,
        'attachment_unavailable',
        'attachment could not be read',
        'attachment_unavailable',
      );
    }
  }
}

export class RemoteBot {
  readonly db: DatabaseSync;
  #activeConfig: RemoteModel | null = null;
  #configVersion = 0;
  private stopping = false;
  private admissions = new Map<string, () => void>();
  private active = new Map<
    string,
    {
      request: string;
      abort: AbortController;
      draft: string;
      done: Promise<void>;
      disabled?: boolean;
    }
  >();

  constructor(
    private home: string,
    private complete = remoteCompletion,
  ) {
    this.db = new DatabaseSync(join(home, 'chat.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS bot(owner TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, current TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES bot(owner), request TEXT NOT NULL, UNIQUE(owner, request));
      CREATE TABLE IF NOT EXISTS event(cursor INTEGER PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversation(id), id TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL, role TEXT NOT NULL, code TEXT, text TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(conversation,request,role));
      CREATE TABLE IF NOT EXISTS queued(seq INTEGER PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversation(id),request TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(conversation,request));
      CREATE TABLE IF NOT EXISTS question(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversation(id),request TEXT NOT NULL,call TEXT NOT NULL,answered TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS open_question ON question(conversation) WHERE answered IS NULL;
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY REFERENCES event(id),files TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS file_delivery(
        event_id TEXT NOT NULL REFERENCES event(id), slot INTEGER NOT NULL, issuer TEXT NOT NULL, subject TEXT,
        file TEXT NOT NULL, state TEXT NOT NULL,receipt TEXT UNIQUE,PRIMARY KEY(event_id,slot)
      );
      CREATE TABLE IF NOT EXISTS delivery (
        id TEXT PRIMARY KEY REFERENCES event(id), issuer TEXT NOT NULL, subject TEXT, source TEXT NOT NULL,
        state TEXT NOT NULL, receipt TEXT UNIQUE
      );
    `);
    const eventColumns = new Set(
      (
        this.db.prepare('PRAGMA table_info(event)').all() as Array<{
          name: string;
        }>
      ).map((col) => col.name),
    );
    if (!eventColumns.has('code')) {
      this.db.exec('ALTER TABLE event ADD COLUMN code TEXT');
    }
    // A claimed message may already have left the host.
    this.db.exec("UPDATE delivery SET state='unknown' WHERE state='sending'");
    this.db.exec(`BEGIN IMMEDIATE;
      INSERT INTO event(conversation,id,request,role,code,text,at) SELECT conversation,lower(hex(randomblob(16))),request,'user',NULL,json_extract(body,'$.text'),at FROM queued ORDER BY seq;
      INSERT INTO attachments SELECT e.id,json_extract(q.body,'$.files') FROM queued q JOIN event e ON e.conversation=q.conversation AND e.request=q.request AND e.role='user' WHERE json_array_length(json_extract(q.body,'$.files'))>0;
      INSERT INTO event(conversation,id,request,role,code,text,at) SELECT conversation,lower(hex(randomblob(16))),request,'notice','host_restarted_queued','host restarted while queued; message not executed',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM queued ORDER BY seq;
      DELETE FROM queued; COMMIT;`);
    // An interrupted call may have reached the endpoint. Preserve the input and never resend it.
    this.db.exec(`INSERT INTO event(conversation,id,request,role,code,text,at)
      SELECT e.conversation, lower(hex(randomblob(16))), e.request,'notice','host_restarted_interrupted','host restarted; previous request outcome unknown',strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM event e WHERE e.role='user' AND NOT EXISTS (SELECT 1 FROM event f WHERE f.conversation=e.conversation AND f.request=e.request AND f.role<>'user')`);
  }

  #applyConfig(
    config: RemoteModel | null,
    configVersion?: number,
    authoritative = false,
  ): void {
    if (configVersion !== undefined) {
      if (
        typeof configVersion !== 'number' ||
        !Number.isSafeInteger(configVersion) ||
        configVersion < 0
      ) {
        throw new BotError(400, 'invalid_request', 'invalid config version');
      }
      if (!authoritative && configVersion < this.#configVersion) return;
      this.#configVersion = configVersion;
    } else if (authoritative) {
      this.#configVersion = 0;
    } else if (this.#configVersion !== 0) {
      return;
    }
    if (config === null) {
      this.#activeConfig = null;
      for (const running of this.active.values()) {
        running.disabled = true;
        running.abort.abort();
      }
      return;
    }
    this.#activeConfig = config.key ? { ...config } : null;
  }

  configure(
    config: RemoteModel | null,
    configVersion?: number,
    authoritative = false,
  ): void {
    this.#applyConfig(config, configVersion, authoritative);
  }

  disable(configVersion?: number, authoritative = false): void {
    this.#applyConfig(null, configVersion, authoritative);
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

  private ensureBot(owner: string) {
    const existing = this.db
      .prepare('SELECT id,current FROM bot WHERE owner=?')
      .get(owner);
    if (existing)
      return { id: String(existing.id), current: String(existing.current) };
    const id = randomUUID(),
      current = randomUUID();
    this.tx(() => {
      this.db.prepare('INSERT INTO bot VALUES(?,?,?)').run(owner, id, current);
      this.db
        .prepare('INSERT INTO conversation VALUES(?,?,?)')
        .run(current, owner, 'default');
    });
    return { id, current };
  }

  private appendInTx(
    conversation: string,
    request: string,
    role: string,
    text: string,
    route?: ChatRoute,
    files: ChatFile[] = [],
    question?: PromptQuestion,
    answer?: string,
    code?: string,
  ) {
    if (code !== undefined && !NOTICE_CODE_PATTERN.test(code)) {
      throw new Error(`invalid notice code: ${code}`);
    }
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO event(conversation,id,request,role,code,text,at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        conversation,
        id,
        request,
        role,
        code ?? null,
        text,
        new Date().toISOString(),
      );
    if (role === 'user')
      this.db
        .prepare('DELETE FROM queued WHERE conversation=? AND request=?')
        .run(conversation, request);
    if (question)
      this.db
        .prepare(
          'INSERT INTO question(id,conversation,request,call) VALUES(?,?,?,?)',
        )
        .run(id, conversation, request, JSON.stringify(question.call));
    if (answer)
      this.db
        .prepare(
          'UPDATE question SET answered=? WHERE conversation=? AND id=? AND answered IS NULL',
        )
        .run(id, conversation, answer);
    if (files.length)
      this.db
        .prepare('INSERT INTO attachments VALUES(?,?)')
        .run(id, JSON.stringify(files));
    if (route && (role !== 'user' || route.source === 'client')) {
      this.db
        .prepare(
          'INSERT INTO delivery(id,issuer,subject,source,state) VALUES(?,?,?,?,?)',
        )
        .run(
          id,
          route.issuer,
          route.subject,
          route.source,
          route.subject ? 'queued' : 'unbound',
        );
    }
    if (route && role === 'user' && route.source === 'client') {
      for (const [slot, file] of files.entries())
        this.db
          .prepare(
            'INSERT INTO file_delivery(event_id,slot,issuer,subject,file,state) VALUES(?,?,?,?,?,?)',
          )
          .run(
            id,
            slot,
            route.issuer,
            route.subject,
            JSON.stringify(file),
            route.subject ? 'queued' : 'unbound',
          );
    }
  }

  private append(
    conversation: string,
    request: string,
    role: string,
    text: string,
    route?: ChatRoute,
    files: ChatFile[] = [],
    question?: PromptQuestion,
    answer?: string,
    code?: string,
  ) {
    this.tx(() =>
      this.appendInTx(
        conversation,
        request,
        role,
        text,
        route,
        files,
        question,
        answer,
        code,
      ),
    );
  }

  // Reserve before any external write. A lost acknowledgment cannot recreate permission to send.
  claim(issuer: string) {
    const row = this.db
      .prepare(
        `SELECT q.id,q.slot,q.subject,c.owner,e.role,e.code,e.text,q.file FROM (
      SELECT id,-1 AS slot,subject,NULL AS file FROM delivery WHERE state='queued' AND issuer=?
      UNION ALL SELECT event_id,slot,subject,file FROM file_delivery WHERE state='queued' AND issuer=?
      ) q JOIN event e ON e.id=q.id JOIN conversation c ON c.id=e.conversation ORDER BY e.cursor,q.slot LIMIT 1`,
      )
      .get(issuer, issuer);
    if (!row) return null;
    const receipt = randomUUID();
    if (row.slot === -1)
      this.db
        .prepare(
          "UPDATE delivery SET state='unknown',receipt=? WHERE id=? AND state='queued'",
        )
        .run(receipt, String(row.id));
    else
      this.db
        .prepare(
          "UPDATE file_delivery SET state='unknown',receipt=? WHERE event_id=? AND slot=? AND state='queued'",
        )
        .run(receipt, String(row.id), Number(row.slot));
    const file = row.file
      ? (JSON.parse(String(row.file)) as ChatFile)
      : undefined;
    return {
      id: String(row.id),
      owner: String(row.owner),
      subject: String(row.subject),
      receipt,
      role: String(row.role),
      ...(row.code ? { code: String(row.code) } : {}),
      text: String(row.text),
      ...(file ? { file } : {}),
    };
  }

  delivered(
    receipt: string,
    state:
      | 'sent'
      | 'unknown'
      | 'refused'
      | 'issued'
      | 'target_rejected'
      | 'not_dispatched',
  ) {
    const stored =
      state === 'issued'
        ? 'sent'
        : state === 'target_rejected' || state === 'not_dispatched'
          ? 'refused'
          : state;
    this.db
      .prepare(
        "UPDATE delivery SET state=? WHERE receipt=? AND state='unknown'",
      )
      .run(stored, receipt);
    this.db
      .prepare(
        "UPDATE file_delivery SET state=? WHERE receipt=? AND state='unknown'",
      )
      .run(stored, receipt);
  }

  inbound(
    owner: string,
    request: string,
    text: string,
    config: RemoteModel,
    route: ChatRoute,
    files: ChatFile[] = [],
    configVersion?: number,
  ) {
    this.#applyConfig(config, configVersion);
    if (!this.#activeConfig?.key)
      throw new BotError(
        503,
        'bot_not_enabled',
        'bot model is not enabled',
        'bot_not_enabled',
      );
    const old = this.db
      .prepare(
        "SELECT e.conversation FROM (SELECT conversation,request FROM event WHERE role='user' UNION ALL SELECT conversation,request FROM queued) e JOIN conversation c ON c.id=e.conversation WHERE c.owner=? AND e.request=?",
      )
      .get(owner, request);
    const bot = this.ensureBot(owner);
    const current = old ? String(old.conversation) : bot.current;
    const existing = this.db
      .prepare(
        "SELECT 1 FROM conversation c JOIN event e ON c.id=e.conversation WHERE c.owner=? AND e.request=? AND e.role='notice'",
      )
      .get(owner, request);
    if (existing) return { request };
    if (!files.length) {
      if (['帮助', 'help'].includes(text)) {
        this.append(
          current,
          request,
          'notice',
          'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.',
          route,
          [],
          undefined,
          undefined,
          'help',
        );
        return { request };
      }
      if (['新对话', '新会话', '重置', '/new', '/reset'].includes(text)) {
        const next = this.newConversation(owner, request);
        this.append(
          String(next.conversation),
          request,
          'notice',
          'started a new conversation',
          route,
          [],
          undefined,
          undefined,
          'conversation_started',
        );
        return { request };
      }
      if (
        ['停止', '终止', '强制终止', '/stop', '/kill', '/abort'].includes(text)
      ) {
        const job = this.active.get(current);
        job?.abort.abort();
        this.append(
          current,
          request,
          'notice',
          job ? 'requested stop for active reply' : 'no active reply to stop',
          route,
          [],
          undefined,
          undefined,
          job ? 'stop_requested' : 'stop_idle',
        );
        return { request };
      }
    }
    return this.run(
      owner,
      { action: 'send', request, text, files, conversation: current },
      config,
      route,
      false,
      configVersion,
    );
  }

  private newConversation(owner: string, request: string) {
    const previous = this.db
      .prepare('SELECT id FROM conversation WHERE owner=? AND request=?')
      .get(owner, request);
    if (previous) return { conversation: String(previous.id) };
    const id = randomUUID();
    this.tx(() => {
      this.db
        .prepare('INSERT INTO conversation VALUES(?,?,?)')
        .run(id, owner, request);
      this.db.prepare('UPDATE bot SET current=? WHERE owner=?').run(id, owner);
    });
    return { conversation: id };
  }

  private readHistory(
    conversation: string,
    after: number,
    questionId: string | null,
  ) {
    const job = this.active.get(conversation);
    const events = this.db
      .prepare(
        'SELECT e.cursor,e.id,e.request,e.role,e.code,e.text,e.at,d.state,a.files FROM event e LEFT JOIN attachments a ON a.id=e.id LEFT JOIN delivery d ON d.id=e.id WHERE conversation=? AND cursor>? ORDER BY cursor LIMIT 100',
      )
      .all(conversation, after)
      .map((row) => ({
        files: row.files ? (JSON.parse(String(row.files)) as ChatFile[]) : [],
        delivery: row.state ?? null,
        cursor: Number(row.cursor),
        id: String(row.id),
        request: String(row.request),
        role: String(row.role),
        ...(row.code ? { code: String(row.code) } : {}),
        text: String(row.text),
        at: String(row.at),
      }));
    const deliveries = this.db
      .prepare(
        'SELECT d.id,d.state FROM delivery d JOIN event e ON e.id=d.id WHERE e.conversation=? ORDER BY e.cursor DESC LIMIT 100',
      )
      .all(conversation);
    return {
      queued: this.db
        .prepare(
          `SELECT request,at,json_extract(body,'$.text') AS text FROM queued WHERE conversation=? ORDER BY seq`,
        )
        .all(conversation),
      fileDeliveries: this.db
        .prepare(
          'SELECT d.event_id AS id,d.slot,d.state FROM file_delivery d JOIN event e ON e.id=d.event_id WHERE e.conversation=? ORDER BY e.cursor DESC LIMIT 800',
        )
        .all(conversation),
      question: questionId,
      deliveries,
      events,
      active: job ? { request: job.request, draft: job.draft } : null,
    };
  }

  private drainQueue(conversation: string) {
    while (
      !this.stopping &&
      !this.active.has(conversation) &&
      !this.db
        .prepare(
          'SELECT 1 FROM question WHERE conversation=? AND answered IS NULL',
        )
        .get(conversation)
    ) {
      const next = this.db
        .prepare(
          'SELECT request FROM queued WHERE conversation=? ORDER BY seq LIMIT 1',
        )
        .get(conversation);
      if (!next) break;
      const key = conversation + ':' + String(next.request);
      const start = this.admissions.get(key);
      this.admissions.delete(key);
      if (!start) break;
      start();
    }
  }

  private sendMessage(
    owner: string,
    op: Extract<ChatOperation, { action: 'send' }>,
    question: { id: unknown; request: unknown; call: unknown } | undefined,
    route?: ChatRoute,
    promoted = false,
  ) {
    const conversation = op.conversation;
    const job = this.active.get(conversation);
    const previous = this.db
      .prepare(
        "SELECT e.text,a.files FROM event e LEFT JOIN attachments a ON a.id=e.id WHERE conversation=? AND request=? AND role='user'",
      )
      .get(conversation, op.request);
    if (previous) {
      if (
        previous.text !== op.text ||
        (previous.files ?? '[]') !== JSON.stringify(op.files ?? [])
      )
        throw new BotError(
          409,
          'invalid_request',
          'request id already used with different content',
        );
      return { request: op.request };
    }
    if (op.replyTo && question?.id !== op.replyTo)
      throw new BotError(409, 'invalid_request', 'question already closed');
    const queuedBody = JSON.stringify({ text: op.text, files: op.files ?? [] });
    const queued = this.db
      .prepare('SELECT body FROM queued WHERE conversation=? AND request=?')
      .get(conversation, op.request);
    if (queued && !promoted) {
      if (queued.body !== queuedBody)
        throw new BotError(
          409,
          'invalid_request',
          'request id already used with different content',
        );
      return { request: op.request, queued: true };
    }
    const activeConfig = this.#activeConfig;
    if (promoted && (!activeConfig || !activeConfig.key)) {
      this.append(
        conversation,
        op.request,
        'user',
        op.text,
        route,
        op.files,
        undefined,
        question ? String(question.id) : undefined,
      );
      this.append(
        conversation,
        op.request,
        'notice',
        'bot model is disabled; queued message was not executed',
        route,
        [],
        undefined,
        undefined,
        'disabled_queued',
      );
      return { request: op.request };
    }
    if (!activeConfig || !activeConfig.key)
      throw new BotError(
        503,
        'bot_not_enabled',
        'bot model is not enabled',
        'bot_not_enabled',
      );
    if (op.text.includes(activeConfig.key)) {
      if (promoted) {
        this.append(
          conversation,
          op.request,
          'user',
          maskKey(op.text, activeConfig.key),
          route,
          op.files,
          undefined,
          question ? String(question.id) : undefined,
        );
        this.append(
          conversation,
          op.request,
          'notice',
          'message cannot contain bot credentials',
          route,
          [],
          undefined,
          undefined,
          'credential_blocked',
        );
        return { request: op.request };
      }
      throw new BotError(
        400,
        'invalid_request',
        'message cannot contain bot credentials',
        'credential_blocked',
      );
    }
    if (job) {
      if (
        (this.db
          .prepare('SELECT count(*) AS n FROM queued WHERE conversation=?')
          .get(conversation)!.n as number) >= 64
      )
        throw new BotError(429, 'bot_busy', 'queued message limit reached');
      this.db
        .prepare(
          'INSERT INTO queued(conversation,request,body,at) VALUES(?,?,?,?)',
        )
        .run(conversation, op.request, queuedBody, new Date().toISOString());
      this.admissions.set(conversation + ':' + op.request, () => {
        this.run(owner, op, undefined, route, true);
      });
      return { request: op.request, queued: true };
    }
    const rows = this.db
      .prepare(
        "SELECT e.id,e.role,e.text,a.files FROM event e LEFT JOIN attachments a ON a.id=e.id WHERE e.conversation=? AND e.role IN ('user','assistant') ORDER BY e.cursor DESC LIMIT 100",
      )
      .all(conversation)
      .reverse();
    const historyAttachments: Array<{ message: Message; files: ChatFile[] }> =
      [];
    const messages: Message[] = rows.map((row) => {
      const message: Message = {
        id: String(row.id),
        role: row.role === 'user' ? 'user' : 'assistant',
        content: String(row.text),
      };
      if (row.files) {
        const parsed = JSON.parse(String(row.files)) as ChatFile[];
        if (parsed.length) historyAttachments.push({ message, files: parsed });
      }
      return message;
    });
    if (question) {
      const preceding = messages.find((m) => m.id === question.id);
      const call = JSON.parse(String(question.call)) as ToolCall;
      if (preceding) {
        preceding.tool_calls = [call];
        messages.push({
          id: randomUUID(),
          role: 'tool',
          tool_call_id: call.id,
          name: 'question',
          content: op.text || 'member attached files',
        });
      }
    }
    this.append(
      conversation,
      op.request,
      'user',
      op.text,
      route,
      op.files,
      undefined,
      question ? String(question.id) : undefined,
    );
    messages.push({ id: op.request, role: 'user', content: op.text });
    const running: {
      request: string;
      abort: AbortController;
      draft: string;
      done: Promise<void>;
      disabled?: boolean;
    } = {
      request: op.request,
      abort: new AbortController(),
      draft: '',
      done: Promise.resolve(),
    };
    this.active.set(conversation, running);
    const signal = AbortSignal.any([
      running.abort.signal,
      AbortSignal.timeout(120000),
    ]);
    const memberHome = join(this.home, 'members', ownerHash(owner));
    let tail = '';
    let modelInvoked = false;
    running.done = Promise.all([
      mkdir(memberHome, { recursive: true, mode: 0o700 }),
      (async () => {
        try {
          const mediaBudget = { media: MAX_MEDIA_BYTES };
          await attachFiles(
            this.home,
            owner,
            op.files ?? [],
            messages[messages.length - 1]!,
            mediaBudget,
          );
          const historyBudget = {
            media: mediaBudget.media,
            text: MAX_HISTORY_TEXT_BYTES,
          };
          for (const entry of [...historyAttachments].reverse()) {
            await attachFiles(
              this.home,
              owner,
              entry.files,
              entry.message,
              historyBudget,
              true,
            );
          }
        } catch (error) {
          if (error instanceof BotError) throw error;
          throw new BotError(
            422,
            'attachment_unavailable',
            'attachment could not be read',
            'attachment_unavailable',
          );
        }
      })(),
    ])
      .then(() => {
        const currentConfig = this.#activeConfig;
        if (running.disabled) {
          running.abort.abort();
          running.abort.signal.throwIfAborted();
        }
        if (signal.aborted) {
          if (running.abort.signal.aborted)
            running.abort.signal.throwIfAborted();
          throw new BotError(
            503,
            'model_unreachable',
            'model endpoint unreachable or timed out',
            'model_unreachable',
          );
        }
        if (!currentConfig?.key) {
          throw new BotError(
            503,
            'bot_not_enabled',
            'bot model is not enabled',
            'bot_not_enabled',
          );
        }
        modelInvoked = true;
        return this.complete(
          memberHome,
          currentConfig,
          messages,
          signal,
          (delta) => {
            const accumulated = maskKey(tail + delta, currentConfig.key);
            // Keep a possible split credential out of live updates as well as final history.
            let length = 0;
            for (
              let i = 1;
              i <= Math.min(currentConfig.key.length - 1, accumulated.length);
              i++
            )
              if (accumulated.endsWith(currentConfig.key.slice(0, i)))
                length = i;
            running.draft += accumulated.slice(0, accumulated.length - length);
            tail = accumulated.slice(accumulated.length - length);
          },
        ).then((reply) => ({ reply, key: currentConfig.key }));
      })
      .then(({ reply, key }) => {
        signal.throwIfAborted();
        const masked = maskKey(
          typeof reply === 'string' ? reply : reply.text,
          key,
        );
        const parts = splitReplyText(masked);
        const promptQuestion = typeof reply === 'string' ? undefined : reply;
        this.tx(() => {
          for (const [index, part] of parts.entries()) {
            this.appendInTx(
              conversation,
              index === 0 ? op.request : `${op.request}:part:${index + 1}`,
              'assistant',
              part,
              route,
              [],
              index === parts.length - 1 ? promptQuestion : undefined,
            );
          }
        });
      })
      .catch((error: unknown) => {
        const notice = running.disabled
          ? {
              code: 'bot_disabled_aborted',
              text: 'bot model was disabled; active reply stopped',
            }
          : running.abort.signal.aborted
            ? { code: 'reply_stopped', text: 'reply stopped' }
            : error instanceof BotError
              ? {
                  code: error.noticeCode ?? error.code,
                  text: error.message,
                }
              : modelInvoked
                ? {
                    code: 'reply_interrupted',
                    text: 'model reply interrupted; outcome unknown',
                  }
                : {
                    code: 'message_not_processed',
                    text: 'message was not processed; you can resend it',
                  };
        this.append(
          conversation,
          op.request,
          'notice',
          notice.text,
          route,
          [],
          undefined,
          undefined,
          notice.code,
        );
      })
      .finally(() => {
        this.active.delete(conversation);
        this.drainQueue(conversation);
      });
    return { request: op.request };
  }

  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'discover' }>,
    config?: RemoteModel | null,
    route?: ChatRoute,
    promoted?: boolean,
    configVersion?: number,
  ): { id: string; current: string; version: string };
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'new' }>,
    config?: RemoteModel | null,
    route?: ChatRoute,
    promoted?: boolean,
    configVersion?: number,
  ): { conversation: string };
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'history' }>,
    config?: RemoteModel | null,
    route?: ChatRoute,
    promoted?: boolean,
    configVersion?: number,
  ): ReturnType<RemoteBot['readHistory']>;
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'stop' }>,
    config?: RemoteModel | null,
    route?: ChatRoute,
    promoted?: boolean,
    configVersion?: number,
  ): { stopping: boolean };
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'send' }>,
    config?: RemoteModel | null,
    route?: ChatRoute,
    promoted?: boolean,
    configVersion?: number,
  ): { request: string; queued?: boolean };
  run(
    owner: string,
    op: ChatOperation,
    config?: RemoteModel | null,
    route?: ChatRoute,
    promoted?: boolean,
    configVersion?: number,
  ): unknown;
  run(
    owner: string,
    op: ChatOperation,
    config?: RemoteModel | null,
    route?: ChatRoute,
    promoted = false,
    configVersion?: number,
  ) {
    if (!promoted && config !== undefined)
      this.#applyConfig(config, configVersion);
    const bot = this.ensureBot(owner);
    if (op.action === 'discover') return { ...bot, version: VERSION };
    if (op.action === 'new') return this.newConversation(owner, op.request);
    const conversation = op.conversation;
    if (
      !this.db
        .prepare('SELECT 1 FROM conversation WHERE owner=? AND id=?')
        .get(owner, conversation)
    )
      throw new BotError(
        404,
        'conversation_not_found',
        'conversation not found',
      );
    const question = this.db
      .prepare(
        'SELECT id,request,call FROM question WHERE conversation=? AND answered IS NULL',
      )
      .get(conversation) as
      { id: unknown; request: unknown; call: unknown } | undefined;
    if (op.action === 'history')
      return this.readHistory(
        conversation,
        op.after,
        question ? String(question.id) : null,
      );
    if (op.action === 'stop') {
      const job = this.active.get(conversation);
      if (job?.request === op.request) job.abort.abort();
      return { stopping: job?.request === op.request };
    }
    return this.sendMessage(owner, op, question, route, promoted);
  }

  async close() {
    this.stopping = true;
    this.admissions.clear();
    const jobs = [...this.active.values()];
    for (const job of jobs) job.abort.abort();
    await Promise.all(jobs.map((job) => job.done));
    this.db.close();
  }
}

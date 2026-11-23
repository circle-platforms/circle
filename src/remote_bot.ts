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
    message: string,
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
  source: 'desktop' | 'channel';
  issuer: string;
  subject: string | null;
}

function ownerHash(owner: string): string {
  return createHash('sha256').update(owner).digest('hex');
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
    throw new BotError(502, '模型未提供有效问题');
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
      if (JSON.stringify(call).includes(config.key))
        throw new BotError(502, '模型回复包含凭据');
      return describeQuestion(call);
    }
    if (!response.message.content.trim())
      throw new BotError(502, '模型没有返回正文');
    return response.message.content;
  } catch (error) {
    const status = httpStatus(error);
    if (status === 401 || status === 403)
      throw new BotError(422, '模型端点拒绝凭据');
    if (
      providerErrorRecords(error).some(
        (row) => row.code === 'model_not_found' || row.code === 'invalid_model',
      )
    )
      throw new BotError(422, '模型 ID 不可用');
    if (status === 404) throw new BotError(422, '指定端点或模型不存在');
    if (signal.aborted || isNetworkFailure(error))
      throw new BotError(503, '模型端点未能建立连接或响应超时');
    throw new BotError(502, '模型未返回有效回复');
  }
}

async function attachFiles(
  home: string,
  owner: string,
  files: ChatFile[],
  message: Message,
) {
  let remaining = MAX_MEDIA_BYTES;
  for (const file of files) {
    if (!/^[a-f0-9]{64}$/.test(file.sha256))
      throw new BotError(400, '附件摘要无效');
    message.content +=
      '\n' +
      JSON.stringify({ name: file.name, size: file.size, sha256: file.sha256 });
    const mime = mediaType(file.name);
    const text =
      /\.(txt|md|json|csv|tsv|xml|km)$/i.test(file.name) &&
      file.size <= 128 * 1024;
    if ((!mime && !text) || file.size > remaining) {
      message.content += '（本次只提供文件引用）';
      continue;
    }
    const bytes = await readFile(
      join(home, 'files', ownerHash(owner), file.sha256),
    );
    if (
      bytes.length !== file.size ||
      createHash('sha256').update(bytes).digest('hex') !== file.sha256
    )
      throw new BotError(422, '附件完整性校验失败');
    remaining -= bytes.length;
    if (mime)
      (message.attachments ??= []).push(makeAttachment(bytes, mime, file.name));
    else message.content += '\n' + bytes.toString('utf8');
  }
}

export class RemoteBot {
  readonly db: DatabaseSync;
  private stopping = false;
  private admissions = new Map<string, () => void>();
  private active = new Map<
    string,
    {
      request: string;
      abort: AbortController;
      draft: string;
      done: Promise<void>;
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
        request TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(conversation,request,role));
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
    // A claimed message may already have left the host.
    this.db.exec("UPDATE delivery SET state='unknown' WHERE state='sending'");
    this.db.exec(`BEGIN IMMEDIATE;
      INSERT INTO event(conversation,id,request,role,text,at) SELECT conversation,lower(hex(randomblob(16))),request,'user',json_extract(body,'$.text'),at FROM queued ORDER BY seq;
      INSERT INTO attachments SELECT e.id,json_extract(q.body,'$.files') FROM queued q JOIN event e ON e.conversation=q.conversation AND e.request=q.request AND e.role='user' WHERE json_array_length(json_extract(q.body,'$.files'))>0;
      INSERT INTO event(conversation,id,request,role,text,at) SELECT conversation,lower(hex(randomblob(16))),request,'notice','宿主重启时仍在排队，本条未执行',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM queued ORDER BY seq;
      DELETE FROM queued; COMMIT;`);
    // An interrupted call may have reached the endpoint. Preserve the input and never resend it.
    this.db.exec(`INSERT INTO event(conversation,id,request,role,text,at)
      SELECT e.conversation, lower(hex(randomblob(16))), e.request,'notice','宿主重启，上一条请求结果未知',strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM event e WHERE e.role='user' AND NOT EXISTS (SELECT 1 FROM event f WHERE f.conversation=e.conversation AND f.request=e.request AND f.role<>'user')`);
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

  private append(
    conversation: string,
    request: string,
    role: string,
    text: string,
    route?: ChatRoute,
    files: ChatFile[] = [],
    question?: PromptQuestion,
    answer?: string,
  ) {
    const id = randomUUID();
    this.tx(() => {
      this.db
        .prepare(
          'INSERT INTO event(conversation,id,request,role,text,at) VALUES(?,?,?,?,?,?)',
        )
        .run(conversation, id, request, role, text, new Date().toISOString());
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
      if (route && (role !== 'user' || route.source === 'desktop')) {
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
      if (route && role === 'user' && route.source === 'desktop') {
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
    });
  }

  // Reserve before any external write. A lost acknowledgment cannot recreate permission to send.
  claim(issuer: string) {
    const row = this.db
      .prepare(
        `SELECT q.id,q.slot,q.subject,c.owner,e.role,e.text,q.file FROM (
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
    return {
      ...row,
      file: row.file ? (JSON.parse(String(row.file)) as ChatFile) : null,
      receipt,
    };
  }

  delivered(receipt: string, state: 'sent' | 'unknown' | 'refused') {
    this.db
      .prepare(
        "UPDATE delivery SET state=? WHERE receipt=? AND state='unknown'",
      )
      .run(state, receipt);
    this.db
      .prepare(
        "UPDATE file_delivery SET state=? WHERE receipt=? AND state='unknown'",
      )
      .run(state, receipt);
  }

  inbound(
    owner: string,
    request: string,
    text: string,
    config: RemoteModel,
    route: ChatRoute,
    files: ChatFile[] = [],
  ) {
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
          '发送文字或文件与私人机器人对话。发送 /new 新建对话，发送 /stop 停止当前回复。',
          route,
        );
        return { request };
      }
      if (['新对话', '新会话', '重置', '/new', '/reset'].includes(text)) {
        const next = this.newConversation(owner, request);
        this.append(
          String(next.conversation),
          request,
          'notice',
          '已新建对话',
          route,
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
          job ? '已请求停止当前回复' : '当前没有正在生成的回复',
          route,
        );
        return { request };
      }
    }
    return this.run(
      owner,
      { action: 'send', request, text, files, conversation: current },
      config,
      route,
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
        'SELECT e.cursor,e.id,e.request,e.role,e.text,e.at,d.state,a.files FROM event e LEFT JOIN attachments a ON a.id=e.id LEFT JOIN delivery d ON d.id=e.id WHERE conversation=? AND cursor>? ORDER BY cursor LIMIT 100',
      )
      .all(conversation, after)
      .map((row) => ({
        files: row.files ? (JSON.parse(String(row.files)) as ChatFile[]) : [],
        delivery: row.state ?? null,
        cursor: Number(row.cursor),
        id: String(row.id),
        request: String(row.request),
        role: String(row.role),
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

  private sendMessage(
    owner: string,
    op: Extract<ChatOperation, { action: 'send' }>,
    question: { id: unknown; request: unknown; call: unknown } | undefined,
    config?: RemoteModel,
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
        throw new BotError(409, '这条消息编号已用于不同内容');
      return { request: op.request };
    }
    if (op.replyTo && question?.id !== op.replyTo)
      throw new BotError(409, '这条追问已经结束');
    const queuedBody = JSON.stringify({ text: op.text, files: op.files ?? [] });
    const queued = this.db
      .prepare('SELECT body FROM queued WHERE conversation=? AND request=?')
      .get(conversation, op.request);
    if (queued && !promoted) {
      if (queued.body !== queuedBody)
        throw new BotError(409, '这条消息编号已用于不同内容');
      return { request: op.request, queued: true };
    }
    if (!config) throw new BotError(503, '机器人模型尚未启用');
    if (op.text.includes(config.key))
      throw new BotError(400, '消息包含机器人凭据');
    if (job) {
      if (
        (this.db
          .prepare('SELECT count(*) AS n FROM queued WHERE conversation=?')
          .get(conversation)!.n as number) >= 64
      )
        throw new BotError(429, '排队消息已满');
      this.db
        .prepare(
          'INSERT INTO queued(conversation,request,body,at) VALUES(?,?,?,?)',
        )
        .run(conversation, op.request, queuedBody, new Date().toISOString());
      this.admissions.set(conversation + ':' + op.request, () => {
        this.run(owner, op, config, route, true);
      });
      return { request: op.request, queued: true };
    }
    const rows = this.db
      .prepare(
        "SELECT id,role,text FROM event WHERE conversation=? AND role IN ('user','assistant') ORDER BY cursor DESC LIMIT 100",
      )
      .all(conversation)
      .reverse();
    const messages: Message[] = rows.map((row) => ({
      id: String(row.id),
      role: row.role === 'user' ? 'user' : 'assistant',
      content: String(row.text),
    }));
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
          content: op.text || '成员已补充附件',
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
    const running = {
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
    running.done = Promise.all([
      mkdir(memberHome, { recursive: true, mode: 0o700 }),
      attachFiles(
        this.home,
        owner,
        op.files ?? [],
        messages[messages.length - 1]!,
      ),
    ])
      .then(() =>
        this.complete(memberHome, config, messages, signal, (delta) => {
          const accumulated = (tail + delta).replaceAll(config.key, '[已遮盖]');
          // Keep a possible split credential out of live updates as well as final history.
          let length = 0;
          for (
            let i = 1;
            i <= Math.min(config.key.length - 1, accumulated.length);
            i++
          )
            if (accumulated.endsWith(config.key.slice(0, i))) length = i;
          running.draft += accumulated.slice(0, accumulated.length - length);
          tail = accumulated.slice(accumulated.length - length);
        }),
      )
      .then((reply) => {
        signal.throwIfAborted();
        this.append(
          conversation,
          op.request,
          'assistant',
          (typeof reply === 'string' ? reply : reply.text).replaceAll(
            config.key,
            '[已遮盖]',
          ),
          route,
          [],
          typeof reply === 'string' ? undefined : reply,
        );
      })
      .catch((error: unknown) => {
        const text = running.abort.signal.aborted
          ? '已停止本次回复'
          : error instanceof BotError
            ? error.message
            : '模型回复中断，结果未知';
        this.append(conversation, op.request, 'notice', text, route);
      })
      .finally(() => {
        this.active.delete(conversation);
        if (
          this.stopping ||
          this.db
            .prepare(
              'SELECT 1 FROM question WHERE conversation=? AND answered IS NULL',
            )
            .get(conversation)
        )
          return;
        const next = this.db
          .prepare(
            'SELECT request FROM queued WHERE conversation=? ORDER BY seq LIMIT 1',
          )
          .get(conversation);
        if (next) {
          const key = conversation + ':' + String(next.request);
          const start = this.admissions.get(key);
          this.admissions.delete(key);
          start?.();
        }
      });
    return { request: op.request };
  }

  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'discover' }>,
  ): { id: string; current: string; version: string };
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'new' }>,
  ): { conversation: string };
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'history' }>,
  ): ReturnType<RemoteBot['readHistory']>;
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'stop' }>,
  ): { stopping: boolean };
  run(
    owner: string,
    op: Extract<ChatOperation, { action: 'send' }>,
    config?: RemoteModel,
    route?: ChatRoute,
    promoted?: boolean,
  ): { request: string; queued?: boolean };
  run(
    owner: string,
    op: ChatOperation,
    config?: RemoteModel,
    route?: ChatRoute,
    promoted?: boolean,
  ): unknown;
  run(
    owner: string,
    op: ChatOperation,
    config?: RemoteModel,
    route?: ChatRoute,
    promoted = false,
  ) {
    const bot = this.ensureBot(owner);
    if (op.action === 'discover') return { ...bot, version: VERSION };
    if (op.action === 'new') return this.newConversation(owner, op.request);
    const conversation = op.conversation;
    if (
      !this.db
        .prepare('SELECT 1 FROM conversation WHERE owner=? AND id=?')
        .get(owner, conversation)
    )
      throw new BotError(404, '会话不可用');
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
    return this.sendMessage(owner, op, question, config, route, promoted);
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

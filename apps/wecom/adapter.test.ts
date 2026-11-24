import { createCipheriv, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { request as unixRequest } from 'node:http';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WSClient } from '@wecom/aibot-node-sdk';
import {
  ChannelSession,
  formatChannelNotice,
  privateInput,
  sanitizeLogError,
  serveChannel,
} from './adapter.ts';
import { transferHubFile } from './hub-client.ts';
import {
  loginUrl,
  WeComApiError,
  WeComApplication,
  WeComHttpError,
} from './identity.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

async function untilPartSettled(
  adapter: ChannelSession,
  platformId: string,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = adapter.db
      .prepare('SELECT files FROM part WHERE platform_id=?')
      .get(platformId) as { files: string | null } | undefined;
    if (row && row.files !== null) return;
    await new Promise<void>((ok) => setImmediate(ok));
  }
  throw new Error(`part ${platformId} did not settle within ${timeoutMs}ms`);
}

async function waitForGateCount(
  gates: unknown[],
  count: number,
  timeoutMs = 5000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (gates.length >= count) return;
    await new Promise<void>((ok) => setImmediate(ok));
  }
  throw new Error(`expected ${count} concurrent gates, got ${gates.length}`);
}

function makeDeliveryIntent(
  text: string,
  file: { sha256: string; size: number; name: string } | null = null,
) {
  const shaUtf8 = (s: string) =>
    createHash('sha256').update(s, 'utf8').digest('hex');
  const text_size = Buffer.byteLength(text, 'utf8');
  const text_sha256 = text_size > 0 ? shaUtf8(text) : null;
  const file_sha256 = file?.sha256 ?? null;
  const file_size = file?.size ?? null;
  const name_sha256 = file ? shaUtf8(file.name) : null;
  const size = text_size + (file_size ?? 0);
  const sha256 = shaUtf8(
    JSON.stringify({
      file_sha256,
      file_size,
      name_sha256,
      text_sha256,
      text_size,
    }),
  );
  return {
    sha256,
    size,
    text_sha256,
    text_size,
    file_sha256,
    file_size,
    name_sha256,
  };
}

function encryptWeComBytes(plain: Buffer, fillByte = 0x42) {
  const aesKeyRaw = Buffer.alloc(32, fillByte);
  const aeskey = aesKeyRaw.toString('base64').replace(/=+$/, '');
  const padLen = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv(
    'aes-256-cbc',
    aesKeyRaw,
    aesKeyRaw.subarray(0, 16),
  );
  cipher.setAutoPadding(false);
  return {
    aeskey,
    encrypted: Buffer.concat([cipher.update(padded), cipher.final()]),
  };
}

const identity = {
  tenant: 'corp',
  application: 'app',
  secret: 'test-app-secret',
};
const channel = {
  bot: 'bot',
  secret: 'test-bot-secret',
  token: 'local-channel',
  hub: 'https://hub.invalid',
};
test('only an official matching corporate conversion can identify a member', async () => {
  assert.equal(
    new URL(
      loginUrl(identity, 'https://hub.invalid/callback', 'one'),
    ).searchParams.get('agentid'),
    'app',
  );
  const urls: string[] = [];
  const app = new WeComApplication(identity, async (input) => {
    const url = new URL(String(input));
    urls.push(url.pathname);
    if (url.pathname.endsWith('/gettoken'))
      return Response.json({
        errcode: 0,
        access_token: 'test',
        expires_in: 7200,
      });
    if (url.pathname.endsWith('/getuserinfo'))
      return Response.json({ errcode: 0, userid: 'member' });
    return Response.json({
      errcode: 0,
      userid_list: [{ open_userid: 'peer', userid: 'member' }],
    });
  });
  assert.equal(await app.fromCode('code'), 'member');
  assert.equal(await app.fromBot('peer'), 'member');
  await assert.rejects(app.fromBot('unrelated'));
  assert.equal(urls.filter((x) => x.endsWith('/gettoken')).length, 1);
  let attempts = 0;
  const bad = new WeComApplication(identity, async () => {
    attempts++;
    return Response.json({ errcode: 40013 });
  });
  await assert.rejects(bad.fromCode('one'));
  await assert.rejects(bad.fromCode('two'));
  assert.equal(attempts, 2);
});

test('group traffic never enters the inbox, platform redelivery stays single, and a lost private-send ack is unknown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-adapter-'));
  const sdk = new EventEmitter() as EventEmitter & {
    connect: () => void;
    disconnect: () => void;
    sendMessage: (peer: string, body: unknown) => Promise<unknown>;
  };
  sdk.connect = () => {
    sdk.emit('authenticated');
  };
  sdk.disconnect = () => {};
  const sent: unknown[] = [];
  sdk.sendMessage = async (peer, body) => {
    sent.push({ peer, body });
    throw new Error('ack lost');
  };
  const effects: Record<string, unknown>[] = [];
  let claimed = false;
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/gettoken'))
        return Response.json({
          errcode: 0,
          access_token: 'test',
          expires_in: 7200,
        });
      if (url.pathname.endsWith('/openuserid_to_userid'))
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: 'peer', userid: 'member' }],
        });
      assert.equal(
        new Headers(init?.headers).get('authorization'),
        'Bearer local-channel',
      );
      const body = JSON.parse(String(init?.body));
      if (body.action === 'next') {
        const text = 'from Mac';
        const textSha = createHash('sha256').update(text, 'utf8').digest('hex');
        const textSize = Buffer.byteLength(text, 'utf8');
        const combinedSha = createHash('sha256')
          .update(
            JSON.stringify({
              file_sha256: null,
              file_size: null,
              name_sha256: null,
              text_sha256: textSha,
              text_size: textSize,
            }),
            'utf8',
          )
          .digest('hex');
        const row = claimed
          ? null
          : {
              subject: 'member',
              receipt: 'one',
              role: 'user',
              text,
              sha256: combinedSha,
              size: textSize,
              file: null,
              intent: {
                sha256: combinedSha,
                size: textSize,
                text_sha256: textSha,
                text_size: textSize,
                file_sha256: null,
                file_size: null,
                name_sha256: null,
              },
            };
        claimed = true;
        return Response.json({ delivery: row });
      }
      effects.push(body);
      return Response.json({});
    },
  );
  try {
    adapter.configure(channel, identity);
    const base = {
      chattype: 'single',
      msgtype: 'text',
      aibotid: 'bot',
      from: { userid: 'peer' },
      msgid: 'message-1',
      text: { content: 'test input' },
    };
    assert.equal(
      privateInput({ body: { ...base, chattype: 'group' } }, channel.bot),
      null,
    );
    sdk.emit('message', {
      body: { ...base, chattype: 'group', msgid: 'group' },
    });
    for (let i = 0; i < 2; i++) sdk.emit('message', { body: base });
    await adapter.flush();
    await adapter.flush();
    assert.deepEqual(effects, [
      {
        action: 'inbound',
        subject: 'member',
        platformId: 'message-1',
        text: 'test input',
      },
      {
        action: 'receipt',
        receipt: 'one',
        state: 'unknown',
        reached_target: null,
        missing: ['未取得与本条消息对应的平台确认'],
        next: '核对目标侧记录，不自动重发',
      },
    ]);
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0] as { peer: string }).peer, 'peer');
    assert.equal(
      (sent[0] as { body: { markdown: { content: string } } }).body.markdown
        .content,
      '客户端消息：\nfrom Mac',
    );
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file followed by its caption becomes one verified input across platform redelivery', async () => {
  const { createCipheriv } = await import('node:crypto');
  const dir = await mkdtemp(join(tmpdir(), 'wecom-file-'));
  let time = 100;
  const uploads: Buffer[] = [];
  const inputs: Record<string, unknown>[] = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
  });
  const aesKeyRaw = Buffer.alloc(32, 0x42);
  const aeskey = aesKeyRaw.toString('base64').replace(/=+$/, '');
  const plain = Buffer.from('synthetic file');
  const padLen = 32 - (plain.length % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padLen, padLen)]);
  const cipher = createCipheriv(
    'aes-256-cbc',
    aesKeyRaw,
    aesKeyRaw.subarray(0, 16),
  );
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (parsed.hostname === 'wwcdn.weixin.qq.com') {
        return new Response(encrypted, {
          status: 200,
          headers: {
            'content-length': String(encrypted.length),
            'content-disposition': 'attachment; filename="fixture.txt"',
          },
        });
      }
      if (path.endsWith('/gettoken'))
        return Response.json({
          errcode: 0,
          expires_in: 7200,
          access_token: 'test',
        });
      if (path.endsWith('/openuserid_to_userid'))
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: 'peer', userid: 'member' }],
        });
      if (init?.method === 'PUT') {
        const buffer = Buffer.from(await new Response(init.body).arrayBuffer());
        uploads.push(buffer);
        return Response.json({
          size: buffer.length,
          sha256: path.split('/').at(-1),
        });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'inbound') inputs.push(op);
      return Response.json(
        op.action === 'authorize' ? { bound: true } : { delivery: null },
      );
    },
    () => time,
  );
  try {
    adapter.configure(channel, identity);
    const base = {
      chattype: 'single',
      aibotid: 'bot',
      from: { userid: 'peer' },
    };
    const file = {
      ...base,
      msgtype: 'file',
      msgid: 'file-msg',
      file: { url: 'https://wwcdn.weixin.qq.com/file', aeskey },
    };
    const caption = {
      ...base,
      msgtype: 'text',
      msgid: 'caption',
      text: { content: 'check this attachment' },
    };
    sdk.emit('message', { body: file });
    sdk.emit('message', { body: caption });
    sdk.emit('message', { body: file });
    await untilPartSettled(adapter, 'file-msg');
    await adapter.flush();
    assert.equal(inputs.length, 0);
    time += 3001;
    await adapter.flush();
    await adapter.flush();
    assert.equal(uploads.length, 1);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.platformId, 'file-msg');
    assert.equal(inputs[0]!.text, 'check this attachment');
    assert.equal(
      (inputs[0]!.files as { name: string }[])[0]!.name,
      'fixture.txt',
    );
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-JSON upload failures and missing download content-length cancel response bodies cleanly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-error-bodies-'));
  let time = 100;
  let cancelledUpload = false;
  let cancelledDownload = false;
  const receipts: Array<Record<string, unknown>> = [];
  const inputs: Array<Record<string, unknown>> = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
  });
  let servedOutbound = false;
  const sha = createHash('sha256').update('outbound').digest('hex');
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (url, init) => {
      const parsed = new URL(String(url));
      const path = parsed.pathname;
      if (parsed.hostname === 'wwcdn.weixin.qq.com') {
        return new Response(Buffer.from('attachment'), {
          status: 200,
          headers: {
            'content-length': '10',
            'content-disposition': 'attachment; filename="broken.txt"',
          },
        });
      }
      if (path.endsWith('/gettoken'))
        return Response.json({
          errcode: 0,
          expires_in: 7200,
          access_token: 'test',
        });
      if (path.endsWith('/openuserid_to_userid'))
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: 'peer', userid: 'member' }],
        });
      if (init?.method === 'PUT') {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('Unprocessable Entity'));
            controller.close();
          },
          cancel() {
            cancelledUpload = true;
          },
        });
        return new Response(body, { status: 422 });
      }
      if (path.includes('/files/')) {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from('missing length'));
            controller.close();
          },
          cancel() {
            cancelledDownload = true;
          },
        });
        return new Response(body, { status: 200 });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'inbound') inputs.push(op);
      if (op.action === 'receipt') receipts.push(op);
      if (op.action === 'next' && !servedOutbound) {
        servedOutbound = true;
        const nameSha = createHash('sha256')
          .update('out.bin', 'utf8')
          .digest('hex');
        const combinedSha = createHash('sha256')
          .update(
            JSON.stringify({
              file_sha256: sha,
              file_size: 8,
              name_sha256: nameSha,
              text_sha256: null,
              text_size: 0,
            }),
            'utf8',
          )
          .digest('hex');
        return Response.json({
          delivery: {
            receipt: 'r-file-1',
            subject: 'member',
            role: 'assistant',
            text: '',
            sha256: combinedSha,
            size: 8,
            file: { name: 'out.bin', sha256: sha, size: 8 },
            intent: {
              sha256: combinedSha,
              size: 8,
              text_sha256: null,
              text_size: 0,
              file_sha256: sha,
              file_size: 8,
              name_sha256: nameSha,
            },
          },
        });
      }
      return Response.json(
        op.action === 'authorize' ? { bound: true } : { delivery: null },
      );
    },
    () => time,
  );
  try {
    adapter.configure(channel, identity);
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgtype: 'file',
        msgid: 'bad-file',
        file: {
          url: 'https://wwcdn.weixin.qq.com/file',
        },
      },
    });
    await untilPartSettled(adapter, 'bad-file');
    time += 3001;
    await adapter.flush();
    assert.equal(cancelledUpload, true);
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0]!.text, '（附件未接收，请重新上传）');
    assert.equal(cancelledDownload, true);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.state, 'not_dispatched');
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('transient gettoken failure recovers for subsequent identity and bot lookups', async () => {
  let tokenCalls = 0;
  const app = new WeComApplication(identity, async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/gettoken')) {
      tokenCalls++;
      if (tokenCalls === 1) throw new Error('ETIMEDOUT');
      return Response.json({
        errcode: 0,
        access_token: 'recovered-token',
        expires_in: 7200,
      });
    }
    if (url.pathname.endsWith('/getuserinfo'))
      return Response.json({ errcode: 0, userid: 'member-qr' });
    const id = JSON.parse(String(init?.body)).open_userid_list[0];
    return Response.json({
      errcode: 0,
      userid_list: [{ open_userid: id, userid: 'member-bot' }],
    });
  });
  await assert.rejects(app.fromCode('code-fail'));
  assert.equal(await app.fromCode('code-ok'), 'member-qr');
  assert.equal(await app.fromBot('peer'), 'member-bot');
  assert.equal(tokenCalls, 2);
});

test('fromBot falls back to plaintext userid only on errcode 0 invalid_open_userid_list and rejects errcode 40003 or mixed/multi lists', async () => {
  let mode:
    'plaintext' | 'mismatch' | 'err40003' | 'nonempty_pairs' | 'two_invalid' =
    'plaintext';
  const app = new WeComApplication(identity, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/gettoken'))
      return Response.json({
        errcode: 0,
        access_token: 'test',
        expires_in: 7200,
      });
    if (mode === 'plaintext')
      return Response.json({
        errcode: 0,
        userid_list: [],
        invalid_open_userid_list: ['plain-member'],
      });
    if (mode === 'mismatch')
      return Response.json({
        errcode: 0,
        userid_list: [],
        invalid_open_userid_list: ['other-member'],
      });
    if (mode === 'nonempty_pairs')
      return Response.json({
        errcode: 0,
        userid_list: [{ open_userid: 'other', userid: 'u' }],
        invalid_open_userid_list: ['plain-member'],
      });
    if (mode === 'two_invalid')
      return Response.json({
        errcode: 0,
        userid_list: [],
        invalid_open_userid_list: ['plain-member', 'other'],
      });
    return Response.json({
      errcode: 40003,
      errmsg: 'invalid userid',
      invalid_open_userid_list: ['plain-member'],
    });
  });
  assert.equal(await app.fromBot('plain-member'), 'plain-member');
  mode = 'mismatch';
  await assert.rejects(app.fromBot('plain-member'));
  mode = 'nonempty_pairs';
  await assert.rejects(app.fromBot('plain-member'));
  mode = 'two_invalid';
  await assert.rejects(app.fromBot('plain-member'));
  mode = 'err40003';
  await assert.rejects(app.fromBot('plain-member'));
});

test('WeComApplication invalidates cached token on errcode 42001, 40014, and 42007 and retries once', async () => {
  for (const expiredCode of [42001, 40014, 42007]) {
    let getTokenCalls = 0;
    let botLookupCalls = 0;
    let codeLookupCalls = 0;
    const seenTokens: string[] = [];
    const app = new WeComApplication(identity, async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/gettoken')) {
        getTokenCalls++;
        return Response.json({
          errcode: 0,
          access_token: 'tok-' + getTokenCalls,
          expires_in: 7200,
        });
      }
      const token = url.searchParams.get('access_token') ?? '';
      seenTokens.push(token);
      if (url.pathname.endsWith('/openuserid_to_userid')) {
        botLookupCalls++;
        if (botLookupCalls === 1) {
          return Response.json({ errcode: expiredCode, errmsg: 'expired' });
        }
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: 'peer', userid: 'member-bot' }],
        });
      }
      codeLookupCalls++;
      if (codeLookupCalls === 1) {
        return Response.json({ errcode: expiredCode, errmsg: 'expired' });
      }
      return Response.json({ errcode: 0, userid: 'member-code' });
    });

    assert.equal(await app.fromBot('peer'), 'member-bot');
    assert.equal(getTokenCalls, 2);
    assert.deepEqual(seenTokens, ['tok-1', 'tok-2']);

    assert.equal(await app.fromCode('qr-code'), 'member-code');
    assert.equal(getTokenCalls, 3);
    assert.deepEqual(seenTokens, ['tok-1', 'tok-2', 'tok-2', 'tok-3']);
  }

  // Repeated expired-token errors fail cleanly after one refresh without looping.
  let tokenCount = 0;
  let apiCount = 0;
  const alwaysExpired = new WeComApplication(identity, async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/gettoken')) {
      tokenCount++;
      return Response.json({
        errcode: 0,
        access_token: 'bad-' + tokenCount,
        expires_in: 7200,
      });
    }
    apiCount++;
    return Response.json({ errcode: 42001, errmsg: 'still expired' });
  });
  await assert.rejects(
    alwaysExpired.fromBot('peer'),
    (err: unknown) => err instanceof WeComApiError && err.errcode === 42001,
  );
  assert.equal(tokenCount, 2);
  assert.equal(apiCount, 2);
});

test('failing sender batch backs off and quarantines across restarts without blocking other senders or outbound', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'wecom-c1-'));
  const scope = createHash('sha256')
    .update(JSON.stringify([identity.tenant, channel.bot]))
    .digest('hex');
  // Seed a populated legacy SQLite database without attempts, next_at, or error columns.
  const legacy = new DatabaseSync(join(dir, 'channel.sqlite'));
  legacy.exec(`
    CREATE TABLE batch(seq INTEGER PRIMARY KEY, scope TEXT NOT NULL,request TEXT NOT NULL,sender TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,UNIQUE(scope,request));
    CREATE TABLE part(seq INTEGER PRIMARY KEY,scope TEXT NOT NULL,platform_id TEXT NOT NULL,batch INTEGER NOT NULL,body TEXT NOT NULL,files TEXT,UNIQUE(scope,platform_id));
    CREATE TABLE peer(scope TEXT NOT NULL,subject TEXT NOT NULL,sender TEXT NOT NULL,PRIMARY KEY(scope,subject));
  `);
  legacy
    .prepare(
      "INSERT INTO batch(seq,scope,request,sender,state,due) VALUES(1,?,?,?,'accepted',100)",
    )
    .run(scope, 'legacy-accepted', 'goodsender');
  legacy
    .prepare(
      "INSERT INTO part(scope,platform_id,batch,body,files) VALUES(?,?,1,'','[]')",
    )
    .run(scope, 'legacy-accepted');
  legacy
    .prepare(
      "INSERT INTO batch(seq,scope,request,sender,state,due) VALUES(2,?,?,?,'pending',500)",
    )
    .run(scope, 'legacy-pending', 'goodsender');
  legacy
    .prepare(
      "INSERT INTO part(scope,platform_id,batch,body,files) VALUES(?,?,2,'migrated legacy pending','[]')",
    )
    .run(scope, 'legacy-pending');
  legacy
    .prepare(
      "INSERT INTO batch(seq,scope,request,sender,state,due) VALUES(3,?,?,?,'open',500)",
    )
    .run(scope, 'legacy-null-files', 'goodsender');
  legacy
    .prepare(
      "INSERT INTO part(scope,platform_id,batch,body,files) VALUES(?,?,3,'interrupted',NULL)",
    )
    .run(scope, 'legacy-null-files');
  legacy.close();
  let time = 1000;
  let badCalls = 0;
  const hubCalls: string[] = [];
  const hubTexts: string[] = [];
  const rejectedNotices: Array<{ to: string; body: unknown }> = [];
  const origWarn = console.warn;
  const origError = console.error;
  const warnLogs: unknown[][] = [];
  const errorLogs: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnLogs.push(args);
  console.error = (...args: unknown[]) => errorLogs.push(args);

  const makeHarness = () => {
    const emitter = new EventEmitter();
    const sdk = Object.assign(emitter, {
      connect() {
        emitter.emit('authenticated');
      },
      disconnect() {},
      async sendMessage(to: string, body: unknown) {
        rejectedNotices.push({ to, body });
        return { headers: { req_id: 'r-ok' }, errcode: 0 };
      },
    });
    let outboundDelivered = false;
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 't',
            expires_in: 7200,
          });
        const id = JSON.parse(String(init?.body)).open_userid_list[0];
        if (id === 'badsender') {
          badCalls++;
          return Response.json({ errcode: 60011, errmsg: 'no privilege' });
        }
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: id, userid: 'u-' + id }],
        });
      }
      const body = JSON.parse(String(init?.body));
      hubCalls.push(body.action + (body.subject ? ':' + body.subject : ''));
      if (body.action === 'inbound') hubTexts.push(body.text);
      if (body.action === 'inbound' && body.subject === 'u-conflict')
        return Response.json({}, { status: 409 });
      if (body.action === 'next' && !outboundDelivered) {
        outboundDelivered = true;
        const text = 'hello member';
        const intent = makeDeliveryIntent(text);
        return Response.json({
          delivery: {
            subject: 'u-goodsender',
            receipt: 'r-out-1',
            role: 'assistant',
            text,
            sha256: intent.sha256,
            size: intent.size,
            file: null,
            intent,
          },
        });
      }
      return Response.json(body.action === 'next' ? { delivery: null } : {});
    };
    return { sdk, fetcher };
  };
  let h = makeHarness();
  let adapter = new ChannelSession(
    dir,
    () => h.sdk as unknown as WSClient,
    h.fetcher,
    () => time,
  );
  try {
    const migratedCols = (
      adapter.db.prepare('PRAGMA table_info(batch)').all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    assert.ok(migratedCols.includes('attempts'));
    assert.ok(migratedCols.includes('transient_attempts'));
    assert.ok(migratedCols.includes('sent_chunks'));
    assert.ok(migratedCols.includes('next_at'));
    assert.ok(migratedCols.includes('error'));
    const migratedRow = adapter.db
      .prepare(
        'SELECT attempts,transient_attempts,sent_chunks,next_at,error FROM batch WHERE request=?',
      )
      .get('legacy-pending') as {
      attempts: number;
      transient_attempts: number;
      sent_chunks: number;
      next_at: number;
      error: string | null;
    };
    assert.equal(migratedRow.attempts, 0);
    assert.equal(migratedRow.transient_attempts, 0);
    assert.equal(migratedRow.sent_chunks, 0);
    assert.equal(migratedRow.next_at, 0);
    assert.equal(migratedRow.error, null);
    const fixedNullPart = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('legacy-null-files') as { body: string; files: string };
    assert.equal(fixedNullPart.files, '[]');
    assert.equal(fixedNullPart.body, 'interrupted（附件接收中断，请重新上传）');

    adapter.configure(channel, identity);
    const frame = (sender: string, msgid: string, content: string) => ({
      body: {
        chattype: 'single',
        msgtype: 'text',
        aibotid: 'bot',
        from: { userid: sender },
        msgid,
        text: { content },
      },
    });
    h.sdk.emit('message', frame('badsender', 'b1', 'cannot resolve'));
    h.sdk.emit('message', frame('conflict', 'c1', 'hub 409 conflict'));
    h.sdk.emit('message', frame('goodsender', 'g1', 'good message'));
    await adapter.flush();
    // Legacy pending + null-files batch delivered; legacy accepted did not re-deliver.
    assert.ok(hubTexts.includes('migrated legacy pending'));
    assert.ok(hubTexts.includes('interrupted（附件接收中断，请重新上传）'));
    assert.ok(hubTexts.includes('good message'));
    assert.equal(hubTexts.includes(''), false);
    assert.ok(hubCalls.includes('next'));
    assert.ok(hubCalls.includes('receipt'));

    // 409 conflict is a permanent batch rejection -> quarantined immediately on attempt 1 + sender notified.
    const conflictQuarantined = adapter.db
      .prepare('SELECT state,attempts FROM batch WHERE sender=?')
      .get('conflict') as { state: string; attempts: number };
    assert.equal(conflictQuarantined.state, 'failed');
    assert.equal(conflictQuarantined.attempts, 1);
    assert.ok(rejectedNotices.some((n) => n.to === 'conflict'));

    const backoffDeltas: number[] = [];
    const badRow1 = adapter.db
      .prepare(
        'SELECT state,attempts,due,next_at,error FROM batch WHERE sender=?',
      )
      .get('badsender') as {
      state: string;
      attempts: number;
      due: number;
      next_at: number;
      error: string | null;
    };
    assert.equal(badRow1.state, 'pending');
    assert.equal(badRow1.attempts, 1);
    assert.equal(badRow1.next_at - time, 1000);
    backoffDeltas.push(badRow1.next_at - time);
    assert.ok(badRow1.error);

    // Attempt 2 at next_at (time = 2000), then probe strictly BETWEEN due (3000) and next_at (4000)!
    time = badRow1.next_at;
    await adapter.flush();
    const badRow2 = adapter.db
      .prepare('SELECT state,attempts,due,next_at FROM batch WHERE sender=?')
      .get('badsender') as {
      state: string;
      attempts: number;
      due: number;
      next_at: number;
    };
    assert.equal(badRow2.attempts, 2);
    assert.equal(badRow2.due, 3000);
    assert.equal(badRow2.next_at, 4000);
    backoffDeltas.push(badRow2.next_at - time);

    const callsBeforeProbe = badCalls;
    time = 3500; // due (3000) < 3500 < next_at (4000): FAILS if `AND b.next_at<=?` is removed!
    await adapter.flush();
    assert.equal(badCalls, callsBeforeProbe);

    // Restart mid-retry (at attempts === 2) and confirm attempts persists without resetting!
    await adapter.close();
    h = makeHarness();
    adapter = new ChannelSession(
      dir,
      () => h.sdk as unknown as WSClient,
      h.fetcher,
      () => time,
    );
    adapter.configure(channel, identity);
    const persisted = adapter.db
      .prepare('SELECT attempts,next_at FROM batch WHERE sender=?')
      .get('badsender') as { attempts: number; next_at: number };
    assert.equal(persisted.attempts, 2);
    assert.equal(persisted.next_at, 4000);

    // Probe again between due and next_at after restart.
    await adapter.flush();
    assert.equal(badCalls, callsBeforeProbe);

    // Advance through attempts 3, 4, 5 verifying exponential deltas [1000, 2000, 4000, 8000].
    for (let attempt = 3; attempt <= 5; attempt++) {
      const row = adapter.db
        .prepare('SELECT next_at FROM batch WHERE sender=?')
        .get('badsender') as { next_at: number };
      time = row.next_at;
      await adapter.flush();
      const updated = adapter.db
        .prepare('SELECT state,attempts,next_at FROM batch WHERE sender=?')
        .get('badsender') as {
        state: string;
        attempts: number;
        next_at: number;
      };
      assert.equal(updated.attempts, attempt);
      if (attempt < 5) {
        backoffDeltas.push(updated.next_at - time);
      }
    }
    assert.deepEqual(backoffDeltas, [1000, 2000, 4000, 8000]);
    const quarantined = adapter.db
      .prepare('SELECT state,attempts FROM batch WHERE sender=?')
      .get('badsender') as { state: string; attempts: number };
    assert.equal(quarantined.state, 'failed');
    assert.equal(quarantined.attempts, 5);
    assert.equal(
      warnLogs.filter((l) => l[0] === '[wecom] inbound batch retrying:').length,
      2,
    );
    assert.equal(
      errorLogs.filter((l) => l[0] === '[wecom] inbound batch quarantined:')
        .length,
      2,
    );

    // Restart and confirm quarantined batches remain permanently failed and never retry.
    const callsAtQuarantine = badCalls;
    await adapter.close();
    h = makeHarness();
    adapter = new ChannelSession(
      dir,
      () => h.sdk as unknown as WSClient,
      h.fetcher,
      () => time,
    );
    adapter.configure(channel, identity);
    time += 1_000_000;
    h.sdk.emit('message', frame('goodsender', 'g2', 'after restart'));
    await adapter.flush();
    assert.equal(badCalls, callsAtQuarantine);
    assert.ok(hubTexts.includes('after restart'));
  } finally {
    console.warn = origWarn;
    console.error = origError;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('downloadMedia enforces allowlisted HTTPS media hosts, redirect: error, stream & post-decryption limits, and concurrency cap 2', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-c9-'));
  let time = 100;
  const fetchedUrls: string[] = [];
  const mediaFetchInits: Array<RequestInit | undefined> = [];
  let pulledChunks = 0;
  let streamCancelled = false;
  let cancelGate = deferred();
  let streamMode: 'header' | 'chunks' | 'post-decrypt' | 'concurrent' =
    'header';
  let inFlightDownloads = 0;
  let maxConcurrentDownloads = 0;
  const concurrentGates: Array<ReturnType<typeof deferred>> = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async downloadFile() {
      throw new Error(
        'legacy unbounded client.downloadFile must not be called',
      );
    },
  });
  const testMaxBytes = 1024;
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      fetchedUrls.push(url.href);
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'test',
            expires_in: 7200,
          });
        const id = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: id, userid: 'member-' + id }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        mediaFetchInits.push(init);
        if (streamMode === 'header') {
          const body = new ReadableStream<Uint8Array>(
            {
              pull() {
                pulledChunks++;
              },
              cancel() {
                streamCancelled = true;
                cancelGate.resolve();
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, {
            status: 200,
            headers: {
              'content-length': String(testMaxBytes + 64),
            },
          });
        }
        if (streamMode === 'chunks') {
          let sentCount = 0;
          const body = new ReadableStream<Uint8Array>(
            {
              pull(controller) {
                sentCount++;
                pulledChunks++;
                if (sentCount <= 3) controller.enqueue(Buffer.alloc(529));
                else controller.close();
              },
              cancel() {
                streamCancelled = true;
                cancelGate.resolve();
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, { status: 200 });
        }
        if (streamMode === 'post-decrypt') {
          // 1025 plaintext bytes -> 1056 encrypted bytes <= testMaxBytes (1024) + 32 (1056) wire limit!
          const { encrypted } = encryptWeComBytes(Buffer.alloc(1025, 0x61));
          return new Response(encrypted, {
            status: 200,
            headers: { 'content-length': String(encrypted.length) },
          });
        }
        inFlightDownloads++;
        maxConcurrentDownloads = Math.max(
          maxConcurrentDownloads,
          inFlightDownloads,
        );
        const gate = deferred();
        concurrentGates.push(gate);
        await gate.promise;
        inFlightDownloads--;
        const bytes = Buffer.from('ok-' + url.pathname);
        return new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        });
      }
      if (init?.method === 'PUT') {
        const buffer = Buffer.from(await new Response(init.body).arrayBuffer());
        return Response.json({
          size: buffer.length,
          sha256: url.pathname.split('/').at(-1),
        });
      }
      const op = JSON.parse(String(init?.body));
      return Response.json(
        op.action === 'authorize' ? { bound: true } : { delivery: null },
      );
    },
    () => time,
    undefined,
    testMaxBytes,
  );
  try {
    adapter.configure(channel, identity);
    // 1. Disallowed host is rejected without fetching.
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgtype: 'file',
        msgid: 'bad-host',
        file: {
          url: 'https://evil.example.invalid/secret.bin',
          aeskey: 'a'.repeat(43),
        },
      },
    });
    await untilPartSettled(adapter, 'bad-host');
    assert.ok(
      !fetchedUrls.some((u) => u.includes('evil.example.invalid')),
      'non-allowlisted media host must not be fetched',
    );
    const badHostPart = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('bad-host') as { body: string; files: string };
    assert.equal(badHostPart.files, '[]');
    assert.match(badHostPart.body, /附件未接收/);

    // 2. Content-Length > encrypted upper bound cancels stream without pulling body and sets redirect: 'error'.
    streamMode = 'header';
    pulledChunks = 0;
    streamCancelled = false;
    cancelGate = deferred();
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgtype: 'file',
        msgid: 'big-header',
        file: {
          url: 'https://wwcdn.weixin.qq.com/big-header',
          aeskey: 'a'.repeat(43),
        },
      },
    });
    await Promise.race([
      cancelGate.promise,
      untilPartSettled(adapter, 'big-header'),
    ]);
    await untilPartSettled(adapter, 'big-header');
    assert.equal(mediaFetchInits.at(-1)?.redirect, 'error');
    assert.equal(streamCancelled, true);
    assert.equal(pulledChunks, 0);

    // 3. Streamed chunks exceeding encrypted upper bound cancel immediately after 2nd 529B chunk.
    streamMode = 'chunks';
    pulledChunks = 0;
    streamCancelled = false;
    cancelGate = deferred();
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgtype: 'file',
        msgid: 'big-chunks',
        file: {
          url: 'https://wwcdn.weixin.qq.com/big-chunks',
          aeskey: 'a'.repeat(43),
        },
      },
    });
    await Promise.race([
      cancelGate.promise,
      untilPartSettled(adapter, 'big-chunks'),
    ]);
    await untilPartSettled(adapter, 'big-chunks');
    assert.equal(streamCancelled, true);
    assert.equal(pulledChunks, 2);

    // 4. Small encrypted body within wire limit that decrypts above maxAttachmentBytes is rejected post-decryption.
    streamMode = 'post-decrypt';
    const overflowPlain = Buffer.alloc(1025, 0x61);
    const { aeskey: overflowKey } = encryptWeComBytes(overflowPlain);
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgtype: 'file',
        msgid: 'post-decrypt-overflow',
        file: {
          url: 'https://wwcdn.weixin.qq.com/post-decrypt',
          aeskey: overflowKey,
        },
      },
    });
    await untilPartSettled(adapter, 'post-decrypt-overflow');
    const postDecryptPart = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('post-decrypt-overflow') as { body: string; files: string };
    assert.equal(postDecryptPart.files, '[]');
    assert.match(postDecryptPart.body, /附件未接收/);

    // 5. Concurrent media downloads are bounded at concurrency cap 2.
    streamMode = 'concurrent';
    for (let i = 1; i <= 4; i++) {
      sdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: 'peer' + i },
          msgtype: 'file',
          msgid: 'conc-' + i,
          file: { url: 'https://wwcdn.weixin.qq.com/c-' + i },
        },
      });
    }
    await waitForGateCount(concurrentGates, 2);
    await new Promise<void>((ok) => setImmediate(ok));
    assert.equal(concurrentGates.length, 2);
    assert.equal(maxConcurrentDownloads, 2);
    concurrentGates[0]!.resolve();
    await waitForGateCount(concurrentGates, 3);
    assert.equal(maxConcurrentDownloads, 2);
    concurrentGates[1]!.resolve();
    await waitForGateCount(concurrentGates, 4);
    assert.equal(maxConcurrentDownloads, 2);
    concurrentGates[2]!.resolve();
    concurrentGates[3]!.resolve();
    for (let i = 1; i <= 4; i++) await untilPartSettled(adapter, 'conc-' + i);
  } finally {
    for (const g of concurrentGates) g.resolve();
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('serveChannel rejects Unix socket paths exceeding platform sun_path byte limit', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { serveChannel } = await import('./adapter.ts');
  const base = await mkdtemp(join(tmpdir(), 'wecom-c18-'));
  const maxBytes = process.platform === 'darwin' ? 103 : 107;
  const pad = Math.max(
    10,
    maxBytes - Buffer.byteLength(join(base, 'channel.sock'), 'utf8') + 5,
  );
  const longDir = join(base, 'x'.repeat(pad));
  await mkdir(longDir, { recursive: true, mode: 0o700 });
  const sockBytes = Buffer.byteLength(join(longDir, 'channel.sock'), 'utf8');
  try {
    await assert.rejects(
      serveChannel(longDir),
      (err: unknown) =>
        err instanceof Error &&
        err.message.includes(String(sockBytes)) &&
        err.message.includes(String(maxBytes)) &&
        !/EINVAL/.test(err.message),
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('outbound deliveries send Bot-Member-Subject and Bot-Delivery-Receipt, verify full intent, report issued, and prepend client echo prefix', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-wire-h3h4h8-'));
  const sentMessages: Array<{ to: string; body: unknown }> = [];
  const sentMedia: Array<{ to: string; type: string; mediaId: string }> = [];
  const receipts: Array<Record<string, unknown>> = [];
  const fileHeaders: Array<{
    method: string;
    subject: string | null;
    receipt: string | null;
  }> = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async uploadMedia(buf: Buffer, opts: { type: string; filename: string }) {
      return { media_id: 'media-' + opts.filename + '-' + buf.length };
    },
    async sendMessage(to: string, body: unknown) {
      sentMessages.push({ to, body });
      return { headers: { req_id: 'req-text-1' }, errcode: 0 };
    },
    async sendMediaMessage(to: string, type: string, mediaId: string) {
      sentMedia.push({ to, type, mediaId });
      return { headers: { req_id: 'req-file-1' }, errcode: 0 };
    },
  });
  const shaUtf8 = (s: string) =>
    createHash('sha256').update(s, 'utf8').digest('hex');
  const makeIntent = (
    text: string,
    file: { sha256: string; size: number; name: string } | null,
  ) => {
    const text_size = Buffer.byteLength(text, 'utf8');
    const text_sha256 = text_size > 0 ? shaUtf8(text) : null;
    const file_sha256 = file?.sha256 ?? null;
    const file_size = file?.size ?? null;
    const name_sha256 = file ? shaUtf8(file.name) : null;
    const size = text_size + (file_size ?? 0);
    const sha256 = shaUtf8(
      JSON.stringify({
        file_sha256,
        file_size,
        name_sha256,
        text_sha256,
        text_size,
      }),
    );
    return {
      sha256,
      size,
      text_sha256,
      text_size,
      file_sha256,
      file_size,
      name_sha256,
    };
  };
  const fileBytes = Buffer.from('hello attachment bytes');
  const fileRef = {
    sha256: createHash('sha256').update(fileBytes).digest('hex'),
    size: fileBytes.length,
    name: 'report.txt',
  };
  const userText = 'desktop message without prefix';
  const textIntent = makeIntent(userText, null);
  const fileIntent = makeIntent('caption', fileRef);
  const deliveries: Array<Record<string, unknown>> = [
    {
      subject: 'member',
      receipt: '11111111-1111-4111-8111-111111111111',
      role: 'user',
      text: userText,
      sha256: textIntent.sha256,
      size: textIntent.size,
      file: null,
      intent: textIntent,
    },
    {
      subject: 'member',
      receipt: '22222222-2222-4222-8222-222222222222',
      role: 'user',
      text: 'caption',
      sha256: fileIntent.sha256,
      size: fileIntent.size,
      file: fileRef,
      intent: fileIntent,
    },
  ];
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith('/api/bot-channel/v1/files/')) {
        const headers = new Headers(init?.headers);
        fileHeaders.push({
          method: init?.method ?? 'GET',
          subject: headers.get('bot-member-subject'),
          receipt: headers.get('bot-delivery-receipt'),
        });
        assert.equal(headers.get('circle-member-subject'), null);
        return new Response(fileBytes, {
          status: 200,
          headers: { 'content-length': String(fileBytes.length) },
        });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next') {
        return Response.json({ delivery: deliveries.shift() ?? null });
      }
      if (op.action === 'receipt') {
        receipts.push(op);
        return Response.json({});
      }
      return Response.json({});
    },
  );
  try {
    adapter.configure(channel, identity);
    await adapter.flush();
    await adapter.flush();
    assert.equal(sentMessages.length, 1);
    assert.equal(
      (sentMessages[0]!.body as { markdown: { content: string } }).markdown
        .content,
      '客户端消息：\n' + userText,
    );
    assert.equal(sentMedia.length, 1);
    assert.deepEqual(fileHeaders, [
      {
        method: 'GET',
        subject: Buffer.from('member').toString('base64url'),
        receipt: '22222222-2222-4222-8222-222222222222',
      },
    ]);
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]!.state, 'issued');
    assert.equal(receipts[0]!.reached_target, true);
    assert.equal((receipts[0]!.acknowledgment as { code: number }).code, 0);
    assert.equal(receipts[1]!.state, 'issued');
    assert.equal(receipts[1]!.reached_target, true);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('outbound delivery aborts and reports not_dispatched when intent text, file, or combined digest mismatches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-wire-mismatch-'));
  let sendCalls = 0;
  const receipts: Array<Record<string, unknown>> = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async uploadMedia() {
      sendCalls++;
      return { media_id: 'x' };
    },
    async sendMessage() {
      sendCalls++;
      return { headers: { req_id: 'r' }, errcode: 0 };
    },
    async sendMediaMessage() {
      sendCalls++;
      return { headers: { req_id: 'r' }, errcode: 0 };
    },
  });
  const shaUtf8 = (s: string) =>
    createHash('sha256').update(s, 'utf8').digest('hex');
  const badTextIntent = {
    sha256: shaUtf8('wrong'),
    size: 5,
    text_sha256: shaUtf8('tampered'),
    text_size: 5,
    file_sha256: null,
    file_size: null,
    name_sha256: null,
  };
  const badFile = { sha256: 'a'.repeat(64), size: 3, name: 'x.txt' };
  const badFileIntent = {
    sha256: shaUtf8(
      JSON.stringify({
        file_sha256: badFile.sha256,
        file_size: badFile.size,
        name_sha256: shaUtf8('different.txt'),
        text_sha256: null,
        text_size: 0,
      }),
    ),
    size: 3,
    text_sha256: null,
    text_size: 0,
    file_sha256: badFile.sha256,
    file_size: badFile.size,
    name_sha256: shaUtf8('different.txt'),
  };
  const deliveries: Array<Record<string, unknown>> = [
    {
      subject: 'member',
      receipt: '33333333-3333-4333-8333-333333333333',
      role: 'assistant',
      text: 'hello',
      sha256: badTextIntent.sha256,
      size: 5,
      file: null,
      intent: badTextIntent,
    },
    {
      subject: 'member',
      receipt: '44444444-4444-4444-8444-444444444444',
      role: 'assistant',
      text: '',
      sha256: badFileIntent.sha256,
      size: 3,
      file: badFile,
      intent: badFileIntent,
    },
  ];
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (_input, init) => {
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next')
        return Response.json({ delivery: deliveries.shift() ?? null });
      if (op.action === 'receipt') receipts.push(op);
      return Response.json({});
    },
  );
  try {
    adapter.configure(channel, identity);
    await adapter.flush();
    await adapter.flush();
    assert.equal(sendCalls, 0);
    assert.deepEqual(receipts, [
      {
        action: 'receipt',
        receipt: '33333333-3333-4333-8333-333333333333',
        state: 'not_dispatched',
        reached_target: false,
      },
      {
        action: 'receipt',
        receipt: '44444444-4444-4444-8444-444444444444',
        state: 'not_dispatched',
        reached_target: false,
      },
    ]);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('R1: formatChannelNotice translates all 23 host notice codes after verifyDeliveryIntent passes and aborts tampered notices', async () => {
  const allCodes = [
    'help',
    'conversation_started',
    'stop_requested',
    'stop_idle',
    'disabled_queued',
    'bot_disabled_aborted',
    'credential_blocked',
    'reply_stopped',
    'host_restarted_queued',
    'host_restarted_interrupted',
    'bot_not_enabled',
    'model_invalid_question',
    'model_credentials_blocked',
    'model_empty_reply',
    'model_auth_failed',
    'model_id_unavailable',
    'model_not_found',
    'model_unreachable',
    'model_invalid_reply',
    'attachment_integrity_failed',
    'invalid_attachment_digest',
    'attachment_unavailable',
    'reply_interrupted',
  ];
  const outputs = new Set<string>();
  for (const code of allCodes) {
    const formatted = formatChannelNotice(code, 'raw english fallback');
    assert.ok(/[\u4e00-\u9fff]/.test(formatted), code);
    assert.notEqual(formatted, '系统提示：raw english fallback');
    outputs.add(formatted);
  }
  assert.equal(outputs.size, 23);
  assert.equal(
    formatChannelNotice(
      undefined,
      'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.',
    ),
    formatChannelNotice('help', ''),
  );
  assert.equal(
    formatChannelNotice('unknown_future_code', 'some future host notice'),
    '系统提示：some future host notice',
  );
  assert.equal(
    formatChannelNotice(undefined, ''),
    '系统提示：处理状态已更新。',
  );

  const dir = await mkdtemp(join(tmpdir(), 'wecom-r1-notice-'));
  const sentMessages: Array<{ to: string; body: unknown }> = [];
  const receipts: Array<Record<string, unknown>> = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage(to: string, body: unknown) {
      sentMessages.push({ to, body });
      return { headers: { req_id: 'req-notice-1' }, errcode: 0 };
    },
  });
  const helpFallback =
    'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.';
  const validIntent = makeDeliveryIntent(helpFallback);
  const tamperedIntent = makeDeliveryIntent('untampered');
  const deliveries: Array<Record<string, unknown>> = [
    {
      subject: 'member',
      receipt: '55555555-5555-4555-8555-555555555555',
      role: 'notice',
      code: 'help',
      text: helpFallback,
      sha256: validIntent.sha256,
      size: validIntent.size,
      file: null,
      intent: validIntent,
    },
    {
      subject: 'member',
      receipt: '66666666-6666-4666-8666-666666666666',
      role: 'notice',
      code: 'help',
      text: 'tampered notice text',
      sha256: tamperedIntent.sha256,
      size: tamperedIntent.size,
      file: null,
      intent: tamperedIntent,
    },
  ];
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (_input, init) => {
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next')
        return Response.json({ delivery: deliveries.shift() ?? null });
      if (op.action === 'receipt') receipts.push(op);
      return Response.json({});
    },
  );
  try {
    adapter.configure(channel, identity);
    await adapter.flush();
    await adapter.flush();
    assert.equal(sentMessages.length, 1);
    assert.equal(
      (sentMessages[0]!.body as { markdown: { content: string } }).markdown
        .content,
      formatChannelNotice('help', helpFallback),
    );
    assert.equal(receipts.length, 2);
    assert.equal(receipts[0]!.state, 'issued');
    assert.equal(receipts[1]!.state, 'not_dispatched');
    assert.equal(receipts[1]!.reached_target, false);
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('R6: transient Hub outages retry past 15s and 5 attempts without quarantining, re-upload lost staging on 400, sweep orphans, and notify on permanent rejections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-r6-'));
  const stagingDir = join(dir, 'staging');
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const orphanSha = 'f'.repeat(64);
  await writeFile(join(stagingDir, orphanSha), 'orphan');

  let time = 1000;
  let inboundAttempt = 0;
  let hubStagedPutCount = 0;
  let hubLostStaging = false;
  const transientStatuses = [
    'network',
    401,
    408,
    429,
    502,
    503,
    504,
    503,
  ] as const;
  const acceptedPayloads: Array<Record<string, unknown>> = [];
  const sentNotices: Array<{ to: string; content: string }> = [];
  const origWarn = console.warn;
  const origError = console.error;
  const warnLogs: unknown[][] = [];
  const errorLogs: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnLogs.push(args);
  console.error = (...args: unknown[]) => errorLogs.push(args);

  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage(to: string, body: { markdown?: { content?: string } }) {
      sentNotices.push({ to, content: body.markdown?.content ?? '' });
      return { headers: { req_id: 'r-notice' }, errcode: 0 };
    },
  });

  const plainFile = Buffer.from('recoverable attachment bytes');
  const fileSha = createHash('sha256').update(plainFile).digest('hex');
  const { aeskey, encrypted } = encryptWeComBytes(plainFile, 0x24);
  const hubStaged = new Set<string>();

  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: 'peer-a', userid: 'u-a' }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        return new Response(encrypted, {
          status: 200,
          headers: {
            'content-length': String(encrypted.length),
            'content-disposition': 'attachment; filename="recover.txt"',
          },
        });
      }
      if (init?.method === 'PUT') {
        hubStagedPutCount++;
        const sha = url.pathname.split('/').at(-1)!;
        const buf = Buffer.from(await new Response(init.body).arrayBuffer());
        hubStaged.add(sha);
        return Response.json({ sha256: sha, size: buf.length });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'authorize') return Response.json({ bound: true });
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        if (op.platformId === 'outage-msg') {
          inboundAttempt++;
          if (inboundAttempt <= transientStatuses.length) {
            const kind = transientStatuses[inboundAttempt - 1]!;
            if (kind === 'network') throw new TypeError('fetch failed');
            return Response.json({}, { status: kind });
          }
          acceptedPayloads.push(op);
          return Response.json({ accepted: true });
        }
        if (op.platformId === 'file-recover-1') {
          const sha = op.files?.[0]?.sha256 as string;
          if (!hubStaged.has(sha)) {
            hubLostStaging = true;
            return Response.json({}, { status: 400 });
          }
          acceptedPayloads.push(op);
          return Response.json({ accepted: true });
        }
        if (op.platformId === 'file-recover-2') {
          acceptedPayloads.push(op);
          return Response.json({ accepted: true });
        }
        if (op.platformId === 'reject-403')
          return Response.json({}, { status: 403 });
        if (op.platformId === 'reject-413')
          return Response.json({}, { status: 413 });
        if (op.platformId === 'reject-422')
          return Response.json({}, { status: 422 });
        if (op.platformId === 'reject-400')
          return Response.json({}, { status: 400 });
      }
      return Response.json({});
    },
    () => time,
  );

  try {
    // Startup sweep removed the orphaned staging file.
    assert.deepEqual(await readdir(stagingDir), []);

    adapter.configure(channel, identity);

    // 1. Long transient Hub outage (> 5 attempts, reaching 60s max backoff) never quarantines.
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer-a' },
        msgtype: 'text',
        msgid: 'outage-msg',
        text: { content: 'survive long outage' },
      },
    });
    const deltas: number[] = [];
    for (let i = 1; i <= transientStatuses.length; i++) {
      await adapter.flush();
      const row = adapter.db
        .prepare(
          'SELECT state,attempts,transient_attempts,next_at FROM batch WHERE request=?',
        )
        .get('outage-msg') as {
        state: string;
        attempts: number;
        transient_attempts: number;
        next_at: number;
      };
      assert.equal(row.state, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.transient_attempts, i);
      deltas.push(row.next_at - time);
      time = row.next_at;
    }
    assert.deepEqual(
      deltas,
      [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000],
    );
    assert.equal(
      warnLogs.filter((l) => l[0] === '[wecom] inbound batch retrying:').length,
      7,
    );
    await adapter.flush();
    assert.equal(
      (
        adapter.db
          .prepare('SELECT state FROM batch WHERE request=?')
          .get('outage-msg') as { state: string }
      ).state,
      'accepted',
    );
    assert.equal(acceptedPayloads.at(-1)?.text, 'survive long outage');

    // 2. Local staging persists with 0600 inside 0700 dir, respects multi-batch references, re-uploads on 400, and cleans up after final acceptance.
    const emitFile = (msgid: string) =>
      sdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: 'peer-a' },
          msgtype: 'file',
          msgid,
          file: { url: 'https://wwcdn.weixin.qq.com/' + msgid, aeskey },
        },
      });
    emitFile('file-recover-1');
    await untilPartSettled(adapter, 'file-recover-1');
    const stagingDirStat = await stat(stagingDir);
    const stagingFilePath = join(stagingDir, fileSha);
    const stagingFileStat = await stat(stagingFilePath);
    assert.equal(stagingDirStat.mode & 0o777, 0o700);
    assert.equal(stagingFileStat.mode & 0o777, 0o600);
    assert.deepEqual(await readFile(stagingFilePath), plainFile);

    // Enqueue a second batch referencing the exact same file SHA after advancing past first batch due window.
    time += 3500;
    emitFile('file-recover-2');
    await untilPartSettled(adapter, 'file-recover-2');
    // Simulate Hub restart wiping Hub's channel-staging before file-recover-1 flushes.
    hubStaged.clear();
    const putsBeforeRecover = hubStagedPutCount;
    await adapter.flush();
    assert.equal(hubLostStaging, true);
    assert.equal(hubStagedPutCount, putsBeforeRecover + 1);
    assert.equal(
      (
        adapter.db
          .prepare('SELECT state FROM batch WHERE request=?')
          .get('file-recover-1') as { state: string }
      ).state,
      'accepted',
    );
    // file-recover-2 is still waiting on its 3000ms due window, so local staging MUST remain until file-recover-2 finishes!
    assert.equal((await stat(stagingFilePath)).isFile(), true);
    time += 3500;
    await adapter.flush();
    assert.equal(
      (
        adapter.db
          .prepare('SELECT state FROM batch WHERE request=?')
          .get('file-recover-2') as { state: string }
      ).state,
      'accepted',
    );
    await assert.rejects(stat(stagingFilePath));

    // 3. Permanent rejections (403, 413, 422, 400 without files) quarantine immediately, blank parts, log console.error, and notify sender with distinct reasons.
    for (const [msgid, pattern] of [
      ['reject-403', /尚未绑定机器人或访问权限已停用/],
      ['reject-413', /超出限制/],
      ['reject-422', /校验未通过/],
      ['reject-400', /校验未通过/],
    ] as const) {
      sdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: 'peer-a' },
          msgtype: 'text',
          msgid,
          text: { content: 'secret content ' + msgid },
        },
      });
      await adapter.flush();
      const b = adapter.db
        .prepare('SELECT state FROM batch WHERE request=?')
        .get(msgid) as { state: string };
      const p = adapter.db
        .prepare('SELECT body,files FROM part WHERE platform_id=?')
        .get(msgid) as { body: string; files: string };
      assert.equal(b.state, 'failed');
      assert.equal(p.body, '');
      assert.equal(p.files, '[]');
      const noticeContent = sentNotices.at(-1)?.content ?? '';
      assert.match(noticeContent, pattern);
      assert.equal(noticeContent.includes('Hub'), false);
      assert.equal(sentNotices.at(-1)?.to, 'peer-a');
    }
    assert.equal(
      errorLogs.filter((l) => l[0] === '[wecom] inbound batch quarantined:')
        .length,
      4,
    );

    // Plant an orphan staging file and verify close() sweeps it too.
    await writeFile(join(stagingDir, 'e'.repeat(64)), 'close-orphan');
  } finally {
    console.warn = origWarn;
    console.error = origError;
    await adapter.close();
    assert.deepEqual(await readdir(stagingDir), []);
    await rm(dir, { recursive: true, force: true });
  }
});

test('S2: per-sender FIFO ordering blocks later batches behind retries without blocking other senders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-s2-'));
  let time = 1000;
  let m1FailCount = 1;
  const delivered: Array<{ subject: string; text: string }> = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
  });
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        const id = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: id, userid: 'u-' + id }],
        });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        if (op.text === 'm1' && m1FailCount > 0) {
          m1FailCount--;
          return Response.json({}, { status: 503 });
        }
        delivered.push({ subject: op.subject, text: op.text });
        return Response.json({ accepted: true });
      }
      return Response.json({});
    },
    () => time,
  );
  const origWarn = console.warn;
  console.warn = () => {};
  try {
    adapter.configure(channel, identity);
    const emitText = (sender: string, msgid: string, content: string) =>
      sdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: sender },
          msgid,
          msgtype: 'text',
          text: { content },
        },
      });
    emitText('A', 'a-1', 'm1');
    await adapter.flush(); // m1 enters pending retry (next_at = 2000).
    time = 1200;
    emitText('A', 'a-2', 'm2');
    emitText('B', 'b-1', 'm3');
    await adapter.flush();
    // m3 (sender B) delivers immediately while m2 (sender A) stays blocked behind m1!
    assert.deepEqual(delivered, [{ subject: 'u-B', text: 'm3' }]);
    assert.equal(
      (
        adapter.db
          .prepare('SELECT state FROM batch WHERE request=?')
          .get('a-2') as { state: string }
      ).state,
      'open',
    );

    // Advance past m1's next_at (2000): Hub receives m1 BEFORE m2!
    time = 2000;
    await adapter.flush();
    assert.deepEqual(delivered, [
      { subject: 'u-B', text: 'm3' },
      { subject: 'u-A', text: 'm1' },
      { subject: 'u-A', text: 'm2' },
    ]);
  } finally {
    console.warn = origWarn;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('S6: sanitizeLogError masks Bearer headers and runtime secrets including undici Headers errors', async () => {
  assert.equal(
    sanitizeLogError(
      new Error('Authorization: Bearer secret-tok-123 failed with appsec'),
      ['appsec', 'chansec'],
    ),
    'Authorization: Bearer [REDACTED] failed with [REDACTED]',
  );

  const dir = await mkdtemp(join(tmpdir(), 'wecom-s6-'));
  let time = 1000;
  const badChannel = {
    bot: 'bot',
    secret: 'CHANNEL-SECRET-XYZ',
    token: 'tok\nINJECTED-SECRET',
    hub: 'http://127.0.0.1:9',
  };
  const secretIdentity = {
    tenant: 'corp',
    application: 'app',
    secret: 'IDENTITY-SECRET-XYZ',
  };
  const warnLogs: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnLogs.push(args);
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
  });
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        const openId = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: openId, userid: 'u-' + openId }],
        });
      }
      // Trigger real undici Headers error on invalid header value containing `\nINJECTED-SECRET`.
      new Headers(init?.headers);
      return Response.json({});
    },
    () => time,
  );
  try {
    adapter.configure(badChannel, secretIdentity);
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 's6-msg',
        msgtype: 'text',
        text: { content: 'hello' },
      },
    });
    await adapter.flush();
    const row = adapter.db
      .prepare('SELECT state,error FROM batch WHERE request=?')
      .get('s6-msg') as { state: string; error: string | null };
    assert.equal(row.state, 'pending');
    assert.ok(row.error);
    assert.ok(!row.error.includes('INJECTED-SECRET'));
    assert.ok(!row.error.includes(badChannel.token));
    assert.match(row.error, /Bearer \[REDACTED\]/);
    const logText = JSON.stringify(warnLogs);
    assert.ok(warnLogs.length >= 1);
    assert.ok(!logText.includes('INJECTED-SECRET'));
    assert.ok(!logText.includes(badChannel.secret));
    assert.ok(!logText.includes(secretIdentity.secret));
    assert.match(logText, /Bearer \[REDACTED\]/);
  } finally {
    console.warn = origWarn;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('T3: TypeError fetch failures without .code stay pending past MAX_BATCH_ATTEMPTS and leave attempts at 0', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-t3-'));
  let time = 1000;
  let inboundCalls = 0;
  const origWarn = console.warn;
  console.warn = () => {};
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
  });
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        const openId = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: openId, userid: 'u-' + openId }],
        });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        inboundCalls++;
        if (inboundCalls <= 6) {
          const err = new TypeError('fetch failed');
          assert.equal('code' in err, false);
          throw err;
        }
        return Response.json({ accepted: true });
      }
      return Response.json({});
    },
    () => time,
  );
  try {
    adapter.configure(channel, identity);
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 't3-msg',
        msgtype: 'text',
        text: { content: 'retry network typeerror' },
      },
    });
    for (let i = 1; i <= 6; i++) {
      await adapter.flush();
      const row = adapter.db
        .prepare(
          'SELECT state,attempts,transient_attempts,next_at FROM batch WHERE request=?',
        )
        .get('t3-msg') as {
        state: string;
        attempts: number;
        transient_attempts: number;
        next_at: number;
      };
      assert.equal(row.state, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.transient_attempts, i);
      time = row.next_at;
    }
    await adapter.flush();
    const accepted = adapter.db
      .prepare(
        'SELECT state,attempts,transient_attempts FROM batch WHERE request=?',
      )
      .get('t3-msg') as {
      state: string;
      attempts: number;
      transient_attempts: number;
    };
    assert.equal(accepted.state, 'accepted');
    assert.equal(accepted.attempts, 0);
    assert.equal(accepted.transient_attempts, 6);
  } finally {
    console.warn = origWarn;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F1: WeCom lookup HTTP 408/429/5xx and transient errcodes retry via transient_attempts without consuming MAX_BATCH_ATTEMPTS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-f1-'));
  let time = 1000;
  let wecomStep = 0;
  let hubMixedStep = 0;
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage() {
      return { headers: { req_id: 'r' }, errcode: 0 };
    },
  });

  // Verify WeComApplication directly throws WeComHttpError with status on HTTP 503.
  const httpErrApp = new WeComApplication(
    identity,
    async () => new Response('bad gateway', { status: 503 }),
  );
  await assert.rejects(
    httpErrApp.fromCode('c'),
    (err: unknown) => err instanceof WeComHttpError && err.status === 503,
  );

  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken')) {
          if (wecomStep === 0 && init?.method === 'GET') {
            wecomStep++;
            return new Response('unavailable', { status: 503 });
          }
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        }
        const openId = JSON.parse(String(init?.body)).open_userid_list[0];
        if (openId === 'wecom-transient-peer') {
          wecomStep++;
          if (wecomStep === 2) return new Response('gateway', { status: 503 });
          if (wecomStep === 3)
            return new Response('rate limit', { status: 429 });
          if (wecomStep === 4) return new Response('timeout', { status: 408 });
          if (wecomStep === 5)
            return Response.json({
              errcode: 45009,
              errmsg: 'freq out of limit',
            });
          if (wecomStep === 6)
            return Response.json({ errcode: -1, errmsg: 'system busy' });
          return Response.json({
            errcode: 0,
            userid_list: [{ open_userid: openId, userid: 'u-wecom-ok' }],
          });
        }
        if (openId === 'mixed-peer') {
          if (hubMixedStep >= 6) {
            return Response.json({ errcode: 60011, errmsg: 'no privilege' });
          }
          return Response.json({
            errcode: 0,
            userid_list: [{ open_userid: openId, userid: 'u-mixed' }],
          });
        }
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound' && op.subject === 'u-mixed') {
        hubMixedStep++;
        if (hubMixedStep <= 6) return Response.json({}, { status: 503 });
      }
      return Response.json({ accepted: true });
    },
    () => time,
  );
  try {
    adapter.configure(channel, identity);
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'wecom-transient-peer' },
        msgid: 'f1-wecom',
        msgtype: 'text',
        text: { content: 'survive wecom outages' },
      },
    });
    const deltas: number[] = [];
    for (let i = 1; i <= 6; i++) {
      await adapter.flush();
      const row = adapter.db
        .prepare(
          'SELECT state,attempts,transient_attempts,next_at FROM batch WHERE request=?',
        )
        .get('f1-wecom') as {
        state: string;
        attempts: number;
        transient_attempts: number;
        next_at: number;
      };
      assert.equal(row.state, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.transient_attempts, i);
      deltas.push(row.next_at - time);
      time = row.next_at;
    }
    assert.deepEqual(deltas, [1000, 2000, 4000, 8000, 16000, 32000]);
    await adapter.flush();
    assert.equal(
      (
        adapter.db
          .prepare('SELECT state FROM batch WHERE request=?')
          .get('f1-wecom') as { state: string }
      ).state,
      'accepted',
    );

    // 6 Hub 503s followed by a non-transient error must NOT quarantine on the 7th attempt.
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'mixed-peer' },
        msgid: 'f1-mixed',
        msgtype: 'text',
        text: { content: '6 transient then non-transient' },
      },
    });
    for (let i = 1; i <= 6; i++) {
      await adapter.flush();
      const row = adapter.db
        .prepare(
          'SELECT state,attempts,transient_attempts,next_at FROM batch WHERE request=?',
        )
        .get('f1-mixed') as {
        state: string;
        attempts: number;
        transient_attempts: number;
        next_at: number;
      };
      assert.equal(row.state, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.transient_attempts, i);
      time = row.next_at;
    }
    await adapter.flush();
    const afterFirstPerm = adapter.db
      .prepare(
        'SELECT state,attempts,transient_attempts,next_at FROM batch WHERE request=?',
      )
      .get('f1-mixed') as {
      state: string;
      attempts: number;
      transient_attempts: number;
      next_at: number;
    };
    assert.equal(afterFirstPerm.state, 'pending');
    assert.equal(afterFirstPerm.attempts, 1);
    assert.equal(afterFirstPerm.transient_attempts, 6);
    time = afterFirstPerm.next_at;
    for (let perm = 2; perm <= 5; perm++) {
      await adapter.flush();
      const row = adapter.db
        .prepare(
          'SELECT state,attempts,transient_attempts,next_at FROM batch WHERE request=?',
        )
        .get('f1-mixed') as {
        state: string;
        attempts: number;
        transient_attempts: number;
        next_at: number;
      };
      assert.equal(row.attempts, perm);
      assert.equal(row.transient_attempts, 6);
      assert.equal(row.state, perm < 5 ? 'pending' : 'failed');
      time = row.next_at;
    }
  } finally {
    console.warn = origWarn;
    console.error = origError;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F2: downloadMedia persists local staging before Hub authorize/PUT outages and delivers file + caption upon recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-f2-'));
  let time = 1000;
  let hubMode: 'auth-503' | 'put-503' | 'perm-403' | 'perm-413' | 'ok' =
    'auth-503';
  const hubStaged = new Map<string, Buffer>();
  const acceptedInputs: Array<Record<string, unknown>> = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage() {
      return { headers: { req_id: 'r' }, errcode: 0 };
    },
  });

  const plainA = Buffer.from('f2-auth-outage-payload');
  const shaA = createHash('sha256').update(plainA).digest('hex');
  const encA = encryptWeComBytes(plainA, 0x11);
  const plainB = Buffer.from('f2-put-outage-payload');
  const shaB = createHash('sha256').update(plainB).digest('hex');
  const encB = encryptWeComBytes(plainB, 0x22);
  const plainPerm = Buffer.from('f2-perm-reject');
  const shaPerm = createHash('sha256').update(plainPerm).digest('hex');
  const encPerm = encryptWeComBytes(plainPerm, 0x33);

  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        const openId = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: openId, userid: 'u-' + openId }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        const name = url.pathname.slice(1);
        const body =
          name === 'a.txt'
            ? encA.encrypted
            : name === 'b.txt'
              ? encB.encrypted
              : encPerm.encrypted;
        return new Response(body, {
          status: 200,
          headers: {
            'content-length': String(body.length),
            'content-disposition': `attachment; filename="${name}"`,
          },
        });
      }
      if (init?.method === 'PUT') {
        if (hubMode === 'put-503') return new Response('busy', { status: 503 });
        if (hubMode === 'perm-413')
          return new Response('too large', { status: 413 });
        const sha = url.pathname.split('/').at(-1)!;
        const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
        hubStaged.set(sha, bytes);
        return Response.json({ sha256: sha, size: bytes.length });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'authorize') {
        if (hubMode === 'auth-503')
          return new Response('down', { status: 503 });
        if (hubMode === 'perm-403') return Response.json({}, { status: 403 });
        return Response.json({ bound: true });
      }
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        if (hubMode !== 'ok') return new Response('down', { status: 503 });
        for (const f of op.files ?? []) {
          if (!hubStaged.has(f.sha256))
            return Response.json({}, { status: 400 });
        }
        acceptedInputs.push(op);
        return Response.json({ accepted: true });
      }
      return Response.json({});
    },
    () => time,
  );
  try {
    adapter.configure(channel, identity);
    // 1. authorize returns 503 during downloadMedia -> local staging + part.files preserved!
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f2-auth-file',
        msgtype: 'file',
        file: { url: 'https://wwcdn.weixin.qq.com/a.txt', aeskey: encA.aeskey },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f2-auth-caption',
        msgtype: 'text',
        text: { content: 'caption during auth outage' },
      },
    });
    await untilPartSettled(adapter, 'f2-auth-file');
    const partA = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('f2-auth-file') as { body: string; files: string };
    assert.equal(partA.body, '');
    assert.deepEqual(JSON.parse(partA.files), [
      { name: 'a.txt', sha256: shaA, size: plainA.length },
    ]);
    assert.deepEqual(await readFile(join(dir, 'staging', shaA)), plainA);

    time += 3500;
    await adapter.flush();
    assert.equal(
      (
        adapter.db
          .prepare('SELECT state FROM batch WHERE request=?')
          .get('f2-auth-file') as { state: string }
      ).state,
      'pending',
    );

    // Hub recovers -> flushInbound uploads missing file from local staging and sends text + file!
    hubMode = 'ok';
    time += 1000;
    await adapter.flush();
    assert.equal(acceptedInputs.length, 1);
    assert.equal(acceptedInputs[0]!.text, 'caption during auth outage');
    assert.deepEqual(acceptedInputs[0]!.files, [
      { name: 'a.txt', sha256: shaA, size: plainA.length },
    ]);
    assert.deepEqual(hubStaged.get(shaA), plainA);
    await assert.rejects(stat(join(dir, 'staging', shaA)));

    // 2. PUT returns 503 during downloadMedia -> local staging + part.files preserved, delivers after recovery!
    hubMode = 'put-503';
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f2-put-file',
        msgtype: 'file',
        file: { url: 'https://wwcdn.weixin.qq.com/b.txt', aeskey: encB.aeskey },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f2-put-caption',
        msgtype: 'text',
        text: { content: 'caption during put outage' },
      },
    });
    await untilPartSettled(adapter, 'f2-put-file');
    const partB = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('f2-put-file') as { body: string; files: string };
    assert.deepEqual(JSON.parse(partB.files), [
      { name: 'b.txt', sha256: shaB, size: plainB.length },
    ]);
    assert.deepEqual(await readFile(join(dir, 'staging', shaB)), plainB);
    hubMode = 'ok';
    time += 3500;
    await adapter.flush();
    assert.equal(acceptedInputs.length, 2);
    assert.equal(acceptedInputs[1]!.text, 'caption during put outage');
    assert.deepEqual(acceptedInputs[1]!.files, [
      { name: 'b.txt', sha256: shaB, size: plainB.length },
    ]);
    assert.deepEqual(hubStaged.get(shaB), plainB);

    // 3. Permanent rejections (authorize 403 / PUT 413) discard attachment and append missing notice.
    hubMode = 'perm-403';
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f2-perm-403',
        msgtype: 'file',
        file: {
          url: 'https://wwcdn.weixin.qq.com/perm.txt',
          aeskey: encPerm.aeskey,
        },
      },
    });
    await untilPartSettled(adapter, 'f2-perm-403');
    const p403 = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('f2-perm-403') as { body: string; files: string };
    assert.equal(p403.files, '[]');
    assert.match(p403.body, /附件未接收/);
    await assert.rejects(stat(join(dir, 'staging', shaPerm)));

    hubMode = 'perm-413';
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f2-perm-413',
        msgtype: 'file',
        file: {
          url: 'https://wwcdn.weixin.qq.com/perm.txt',
          aeskey: encPerm.aeskey,
        },
      },
    });
    await untilPartSettled(adapter, 'f2-perm-413');
    const p413 = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('f2-perm-413') as { body: string; files: string };
    assert.equal(p413.files, '[]');
    assert.match(p413.body, /附件未接收/);
  } finally {
    console.warn = origWarn;
    console.error = origError;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F3: sweepStaging keeps in-flight .part files younger than 15m while sweeping completed orphans and stale .part files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-f3-'));
  const stagingDir = join(dir, 'staging');
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  let time = Date.now();
  const partOpened = deferred();
  const allowRename = deferred();
  let activePartPath = '';
  const plain = Buffer.from('f3-inflight-part-bytes');
  const fileSha = createHash('sha256').update(plain).digest('hex');
  const { aeskey, encrypted } = encryptWeComBytes(plain, 0x55);
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
  });
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        const openId = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: openId, userid: 'u-' + openId }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        return new Response(encrypted, {
          status: 200,
          headers: {
            'content-length': String(encrypted.length),
            'content-disposition': 'attachment; filename="inflight.txt"',
          },
        });
      }
      if (init?.method === 'PUT') {
        const buf = Buffer.from(await new Response(init.body).arrayBuffer());
        return Response.json({
          sha256: url.pathname.split('/').at(-1),
          size: buf.length,
        });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'authorize') return Response.json({ bound: true });
      if (op.action === 'next') return Response.json({ delivery: null });
      return Response.json({ accepted: true });
    },
    () => time,
    undefined,
    undefined,
    async (tempPath) => {
      activePartPath = tempPath;
      partOpened.resolve();
      await allowRename.promise;
    },
  );
  try {
    adapter.configure(channel, identity);
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f3-file',
        msgtype: 'file',
        file: { url: 'https://wwcdn.weixin.qq.com/f3.bin', aeskey },
      },
    });
    await Promise.race([
      partOpened.promise,
      untilPartSettled(adapter, 'f3-file').then(() => {
        throw new Error('part settled before staging rename gate');
      }),
    ]);
    assert.ok(activePartPath.endsWith('.part'));
    assert.equal((await stat(activePartPath)).isFile(), true);

    // Plant an unreferenced completed orphan file and flush another sender's batch so real sweepStaging() runs.
    const orphanSha = 'c'.repeat(64);
    await writeFile(join(stagingDir, orphanSha), 'orphan');
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'other-peer' },
        msgid: 'f3-trigger-sweep',
        msgtype: 'text',
        text: { content: 'sweep now' },
      },
    });
    await adapter.flush();
    await assert.rejects(stat(join(stagingDir, orphanSha)));
    assert.equal(
      await stat(activePartPath).then(
        (s) => s.isFile(),
        () => false,
      ),
      true,
    );

    // Release rename gate -> temp .part renames cleanly and part settles with attachment intact!
    allowRename.resolve();
    await untilPartSettled(adapter, 'f3-file');
    const settled = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('f3-file') as { body: string; files: string };
    assert.equal(settled.body, '');
    assert.deepEqual(JSON.parse(settled.files), [
      { name: 'inflight.txt', sha256: fileSha, size: plain.length },
    ]);

    // Plant a .part file and age mocked clock >= 15m -> sweepStaging deletes stale .part!
    const stalePart = join(stagingDir, 'd'.repeat(64) + '.stale.part');
    await writeFile(stalePart, 'stale');
    time += 15 * 60_000 + 1000;
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'other-peer' },
        msgid: 'f3-trigger-stale-sweep',
        msgtype: 'text',
        text: { content: 'sweep stale part' },
      },
    });
    await adapter.flush();
    await assert.rejects(stat(stalePart));
  } finally {
    allowRename.resolve();
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F4: serveChannel configures mediaHosts via options, CIRCLE_WECOM_MEDIA_HOSTS fallback, and configure socket frame', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-f4-'));
  const dirSocket = await mkdtemp(join(tmpdir(), 'wecom-f4-sock-'));
  const dirEnv = await mkdtemp(join(tmpdir(), 'wecom-f4-env-'));
  const fetchedUrls: string[] = [];
  const postSocket = (socketDir: string, payload: unknown) =>
    new Promise<{ status: number; body: unknown }>((ok, fail) => {
      const bytes = Buffer.from(JSON.stringify(payload));
      const req = unixRequest(
        {
          socketPath: join(socketDir, 'channel.sock'),
          path: '/chat',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': bytes.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            ok({
              status: res.statusCode ?? 500,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      req.on('error', fail);
      req.end(bytes);
    });

  const makeSdk = () => {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      connect() {
        emitter.emit('authenticated');
      },
      disconnect() {},
    });
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    fetchedUrls.push(url.href);
    if (url.hostname === 'qyapi.weixin.qq.com') {
      if (url.pathname.endsWith('/gettoken'))
        return Response.json({
          errcode: 0,
          access_token: 'tok',
          expires_in: 7200,
        });
      return Response.json({
        errcode: 0,
        userid_list: [{ open_userid: 'peer', userid: 'u-peer' }],
      });
    }
    if (
      url.hostname === 'custom.media.example' ||
      url.hostname === 'socket.media.example' ||
      url.hostname === 'env.media.example'
    ) {
      const bytes = Buffer.from('media-from-' + url.hostname);
      return new Response(bytes, {
        status: 200,
        headers: { 'content-length': String(bytes.length) },
      });
    }
    if (init?.method === 'PUT') {
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
      return Response.json({
        sha256: url.pathname.split('/').at(-1),
        size: bytes.length,
      });
    }
    const op = JSON.parse(String(init?.body));
    return Response.json(
      op.action === 'authorize' ? { bound: true } : { delivery: null },
    );
  };

  const prevEnv = process.env.CIRCLE_WECOM_MEDIA_HOSTS;
  let close1: (() => Promise<void>) | undefined;
  let close2: (() => Promise<void>) | undefined;
  let closeEnv: (() => Promise<void>) | undefined;
  try {
    const sdk1 = makeSdk();
    close1 = await serveChannel(dir, {
      mediaHosts: ['custom.media.example'],
      create: () => sdk1 as unknown as WSClient,
      fetcher,
    });
    const res1 = await postSocket(dir, {
      action: 'configure',
      channel,
      identity,
    });
    assert.equal(res1.status, 200);
    sdk1.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f4-custom',
        msgtype: 'file',
        file: { url: 'https://custom.media.example/a.bin' },
      },
    });
    sdk1.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f4-evil',
        msgtype: 'file',
        file: { url: 'https://evil.example.invalid/b.bin' },
      },
    });
    await close1();
    close1 = undefined;
    assert.equal(
      fetchedUrls.includes('https://custom.media.example/a.bin'),
      true,
    );
    assert.equal(
      fetchedUrls.includes('https://evil.example.invalid/b.bin'),
      false,
    );

    // Update mediaHosts dynamically via configure socket frame.
    const sdk2 = makeSdk();
    close2 = await serveChannel(dirSocket, {
      create: () => sdk2 as unknown as WSClient,
      fetcher,
    });
    const res2 = await postSocket(dirSocket, {
      action: 'configure',
      channel,
      identity,
      mediaHosts: ['socket.media.example'],
    });
    assert.equal(res2.status, 200);
    sdk2.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f4-socket',
        msgtype: 'file',
        file: { url: 'https://socket.media.example/c.bin' },
      },
    });
    await close2();
    close2 = undefined;
    assert.equal(
      fetchedUrls.includes('https://socket.media.example/c.bin'),
      true,
    );

    // Verify CIRCLE_WECOM_MEDIA_HOSTS fallback when options.mediaHosts is omitted.
    process.env.CIRCLE_WECOM_MEDIA_HOSTS = 'env.media.example';
    const envSdk = makeSdk();
    closeEnv = await serveChannel(dirEnv, {
      create: () => envSdk as unknown as WSClient,
      fetcher,
    });
    const resEnv = await postSocket(dirEnv, {
      action: 'configure',
      channel,
      identity,
    });
    assert.equal(resEnv.status, 200);
    envSdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer' },
        msgid: 'f4-env',
        msgtype: 'file',
        file: { url: 'https://env.media.example/d.bin' },
      },
    });
    await closeEnv();
    closeEnv = undefined;
    assert.equal(fetchedUrls.includes('https://env.media.example/d.bin'), true);
  } finally {
    if (prevEnv === undefined) delete process.env.CIRCLE_WECOM_MEDIA_HOSTS;
    else process.env.CIRCLE_WECOM_MEDIA_HOSTS = prevEnv;
    await closeEnv?.();
    await close2?.();
    await close1?.();
    await rm(dir, { recursive: true, force: true });
    await rm(dirSocket, { recursive: true, force: true });
    await rm(dirEnv, { recursive: true, force: true });
  }
});

test('F5 & F7: rejection notices avoid "Hub", rate-limit per (sender, reasonKey) for 5m, and warn on send failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-f5f7-'));
  let time = 1000;
  let sendMode: 'ok' | 'throw' | 'errcode' = 'ok';
  const sentNotices: Array<{ to: string; content: string }> = [];
  const origWarn = console.warn;
  const origError = console.error;
  const warnLogs: unknown[][] = [];
  console.warn = (...args: unknown[]) => warnLogs.push(args);
  console.error = () => {};
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage(to: string, body: { markdown?: { content?: string } }) {
      if (sendMode === 'throw') {
        throw new Error('send failed ' + channel.token);
      }
      if (sendMode === 'errcode') {
        return {
          headers: { req_id: 'r-fail' },
          errcode: 45009,
          errmsg: 'freq limit',
        };
      }
      sentNotices.push({ to, content: body.markdown?.content ?? '' });
      return { headers: { req_id: 'r-ok' }, errcode: 0 };
    },
  });
  let disconnectOn403 = false;
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        const id = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: id, userid: 'u-' + id }],
        });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        if (op.text.startsWith('413:'))
          return Response.json({}, { status: 413 });
        if (disconnectOn403) emitter.emit('disconnected');
        return Response.json({}, { status: 403 });
      }
      return Response.json({});
    },
    () => time,
  );
  try {
    adapter.configure(channel, identity);
    const emitText = (sender: string, msgid: string, content: string) =>
      sdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: sender },
          msgid,
          msgtype: 'text',
          text: { content },
        },
      });

    // 20 unbound 403 rejections from same sender within 5m emit 1 notice (without "Hub").
    for (let i = 1; i <= 20; i++) {
      emitText('spammer', 's-' + i, 'hi ' + i);
      await adapter.flush();
    }
    assert.equal(sentNotices.length, 1);
    assert.match(sentNotices[0]!.content, /尚未绑定机器人或访问权限已停用/);
    assert.equal(sentNotices[0]!.content.includes('Hub'), false);

    // Different reasonKey (413) for the same sender sends immediately.
    emitText('spammer', 's-413', '413:quota');
    await adapter.flush();
    assert.equal(sentNotices.length, 2);
    assert.match(sentNotices[1]!.content, /超出限制/);

    // After 5 minutes, 403 notice is allowed again.
    time += 5 * 60_000;
    emitText('spammer', 's-21', 'hi 21');
    await adapter.flush();
    assert.equal(sentNotices.length, 3);

    // Verify all 3 warning paths on failure (!run.ready, thrown error, non-zero errcode).
    warnLogs.length = 0;
    disconnectOn403 = true;
    emitText('fail-peer', 'fp-1', 'not ready');
    await adapter.flush();
    disconnectOn403 = false;
    emitter.emit('authenticated');

    sendMode = 'throw';
    emitText('fail-peer', 'fp-2', 'throws');
    await adapter.flush();

    sendMode = 'errcode';
    emitText('fail-peer', 'fp-3', 'nonzero');
    await adapter.flush();

    const noticeWarns = warnLogs.filter(
      (args) => args[0] === '[wecom] rejection notice failed:',
    );
    assert.equal(noticeWarns.length, 3);
    assert.equal(
      (noticeWarns[0]![1] as { error: string }).error,
      'channel not ready',
    );
    assert.equal(JSON.stringify(noticeWarns[1]).includes(channel.token), false);
    assert.equal((noticeWarns[2]![1] as { errcode: number }).errcode, 45009);
  } finally {
    console.warn = origWarn;
    console.error = origError;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('F6: transferHubFile 900s timeout, README alignment, >16k/>8 batch splitting, and single-chat frame rejections', async () => {
  // 1. Verify transferHubFile uses 900_000ms timeout and README documents Round-3 details.
  const origTimeout = AbortSignal.timeout;
  const observedTimeouts: number[] = [];
  AbortSignal.timeout = ((ms: number) => {
    observedTimeouts.push(ms);
    return origTimeout.call(AbortSignal, ms);
  }) as typeof AbortSignal.timeout;
  try {
    const sha = createHash('sha256').update('x').digest('hex');
    await transferHubFile(
      async () => Response.json({ sha256: sha, size: 1 }),
      channel,
      'member',
      sha,
      Buffer.from('x'),
    );
  } finally {
    AbortSignal.timeout = origTimeout;
  }
  assert.deepEqual(observedTimeouts, [900_000]);

  const readme = await readFile(
    new URL('./README.md', import.meta.url),
    'utf8',
  );
  assert.match(readme, /900000/);
  assert.match(readme, /16000/);
  assert.match(readme, /transient_attempts/);
  assert.match(readme, /CIRCLE_WECOM_MEDIA_HOSTS/);
  assert.match(readme, /15 分钟/);

  // 2. Verify merged batch splitting (>16k text & >8 files + F2 + T3 interaction) and non-silent frame rejections.
  const dir = await mkdtemp(join(tmpdir(), 'wecom-f6-'));
  let time = 1000;
  let hubDown = true;
  let chunk1NetworkFails = 6;
  const hubStaged = new Set<string>();
  const inboundPayloads: Array<{
    platformId: string;
    text: string;
    files?: Array<{ name: string; sha256: string; size: number }>;
  }> = [];
  const sentNotices: Array<{ to: string; content: string }> = [];
  const warnLogs: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnLogs.push(args);

  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage(to: string, body: { markdown?: { content?: string } }) {
      sentNotices.push({ to, content: body.markdown?.content ?? '' });
      return { headers: { req_id: 'r-f6' }, errcode: 0 };
    },
  });

  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken'))
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        const id = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: id, userid: 'u-' + id }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        const bytes = Buffer.from('content-' + url.pathname);
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-length': String(bytes.length),
            'content-disposition': `attachment; filename="${url.pathname.slice(1)}.txt"`,
          },
        });
      }
      if (init?.method === 'PUT') {
        if (hubDown) return new Response('down', { status: 503 });
        const sha = url.pathname.split('/').at(-1)!;
        const buf = Buffer.from(await new Response(init.body).arrayBuffer());
        hubStaged.add(sha);
        return Response.json({ sha256: sha, size: buf.length });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'authorize') {
        return hubDown
          ? new Response('down', { status: 503 })
          : Response.json({ bound: true });
      }
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        if (hubDown) return new Response('down', { status: 503 });
        if (op.platformId === 'ten-files-1:1' && chunk1NetworkFails > 0) {
          chunk1NetworkFails--;
          throw new TypeError('fetch failed');
        }
        for (const f of op.files ?? []) {
          if (!hubStaged.has(f.sha256))
            return Response.json({}, { status: 400 });
        }
        inboundPayloads.push(op);
        return Response.json({ accepted: true });
      }
      return Response.json({});
    },
    () => time,
  );
  try {
    adapter.configure(channel, identity);

    // Single-chat frames rejected by privateInput must warn and notify sender, while group frames stay silent.
    assert.equal(
      privateInput(
        {
          body: {
            chattype: 'single',
            aibotid: 'bot',
            from: { userid: 'oversize-user' },
            msgid: 'too-long',
            msgtype: 'text',
            text: { content: 'x'.repeat(16001) },
          },
        },
        'bot',
      ),
      null,
    );
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'oversize-user' },
        msgid: 'too-long-1',
        msgtype: 'text',
        text: { content: 'x'.repeat(16001) },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'oversize-user' },
        msgid: 'too-long-2',
        msgtype: 'text',
        text: { content: 'y'.repeat(16001) },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'oversize-user' },
        msgid: 'too-many-files',
        msgtype: 'mixed',
        mixed: {
          msg_item: Array.from({ length: 9 }, (_, i) => ({
            msgtype: 'file',
            file: { url: `https://wwcdn.weixin.qq.com/f${i}` },
          })),
        },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'oversize-user' },
        msgid: 'http-media',
        msgtype: 'file',
        file: { url: 'http://wwcdn.weixin.qq.com/plain-http' },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'group',
        aibotid: 'bot',
        from: { userid: 'group-user' },
        msgid: 'group-oversize',
        msgtype: 'text',
        text: { content: 'g'.repeat(16001) },
      },
    });
    await new Promise<void>((ok) => setImmediate(ok));
    assert.equal(sentNotices.length, 3);
    assert.match(sentNotices[0]!.content, /16000/);
    assert.match(sentNotices[1]!.content, /8 个上限/);
    assert.match(sentNotices[2]!.content, /HTTPS/);
    assert.equal(
      sentNotices.some((n) => n.to === 'group-user'),
      false,
    );
    assert.equal(
      warnLogs.filter((l) => l[0] === '[wecom] inbound frame rejected:').length,
      4,
    );

    // Merged text > 16000 (preserving surrogate pair across boundary!) splits sequentially.
    hubDown = false;
    const part1 = 'a'.repeat(15999) + '😀'; // 16001 chars, surrogate pair starts at index 15999!
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'text-splitter' },
        msgid: 'split-text-1',
        msgtype: 'text',
        text: { content: part1.slice(0, 10000) },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'text-splitter' },
        msgid: 'split-text-2',
        msgtype: 'text',
        text: { content: part1.slice(10000) },
      },
    });
    await adapter.flush();
    assert.equal(inboundPayloads.length, 2);
    assert.equal(inboundPayloads[0]!.platformId, 'split-text-1:0');
    assert.equal(inboundPayloads[1]!.platformId, 'split-text-1:1');
    assert.ok(inboundPayloads[0]!.text.length <= 16000);
    assert.ok(inboundPayloads[1]!.text.length <= 16000);
    assert.equal(
      inboundPayloads[0]!.text + inboundPayloads[1]!.text,
      part1.slice(0, 10000) + '\n' + part1.slice(10000),
    );
    assert.equal(inboundPayloads[1]!.text.startsWith('😀'), true);

    // Merged >8 files (5 + 5 = 10) while Hub is down (F2) + chunk 1 hits 6 TypeErrors (T3) -> recovers without duplicating chunk 0!
    hubDown = true;
    const emit5Files = (msgid: string, prefix: string) =>
      sdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: 'file-splitter' },
          msgid,
          msgtype: 'mixed',
          mixed: {
            msg_item: Array.from({ length: 5 }, (_, i) => ({
              msgtype: 'file',
              file: { url: `https://wwcdn.weixin.qq.com/${prefix}-${i}` },
            })),
          },
        },
      });
    emit5Files('ten-files-1', 'batchA');
    emit5Files('ten-files-2', 'batchB');
    await untilPartSettled(adapter, 'ten-files-1');
    await untilPartSettled(adapter, 'ten-files-2');

    hubDown = false;
    time += 3500;
    for (let i = 1; i <= 6; i++) {
      await adapter.flush();
      const row = adapter.db
        .prepare(
          'SELECT state,attempts,transient_attempts,sent_chunks,next_at FROM batch WHERE request=?',
        )
        .get('ten-files-1') as {
        state: string;
        attempts: number;
        transient_attempts: number;
        sent_chunks: number;
        next_at: number;
      };
      assert.equal(row.state, 'pending');
      assert.equal(row.attempts, 0);
      assert.equal(row.transient_attempts, i);
      assert.equal(row.sent_chunks, 1);
      time = row.next_at;
    }
    await adapter.flush();
    assert.equal(
      (
        adapter.db
          .prepare('SELECT state FROM batch WHERE request=?')
          .get('ten-files-1') as { state: string }
      ).state,
      'accepted',
    );
    const fileBatchCalls = inboundPayloads.filter((p) =>
      p.platformId.startsWith('ten-files-1:'),
    );
    assert.equal(fileBatchCalls.length, 2);
    assert.equal(fileBatchCalls[0]!.platformId, 'ten-files-1:0');
    assert.equal(fileBatchCalls[0]!.files?.length, 8);
    assert.equal(fileBatchCalls[1]!.platformId, 'ten-files-1:1');
    assert.equal(fileBatchCalls[1]!.files?.length, 2);
  } finally {
    console.warn = origWarn;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('M1-a/b: pre-auth rejects 403 and permanent identity errors with 0 media fetches/staging, avoids duplicate authorize, and preserves F2 on transient authorize', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-m1-preauth-'));
  const stagingDir = join(dir, 'staging');
  let time = 1000;
  let wecomMode: 'ok' | 'perm-60011' = 'ok';
  let hubAuthMode: '403' | '503' | 'ok' = '403';
  let mediaFetchCount = 0;
  let fromBotCalls = 0;
  let authorizeCalls = 0;
  let putCalls = 0;
  const hubStaged = new Map<string, Buffer>();
  const acceptedPayloads: Array<Record<string, unknown>> = [];
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};

  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage() {
      return { headers: { req_id: 'r' }, errcode: 0 };
    },
  });

  const plainOk = Buffer.from('m1-authorized-ok');
  const shaOk = createHash('sha256').update(plainOk).digest('hex');
  const encOk = encryptWeComBytes(plainOk, 0x31);
  const plainTrans = Buffer.from('m1-transient-f2');
  const shaTrans = createHash('sha256').update(plainTrans).digest('hex');
  const encTrans = encryptWeComBytes(plainTrans, 0x32);

  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken')) {
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        }
        fromBotCalls++;
        if (wecomMode === 'perm-60011') {
          return Response.json({ errcode: 60011, errmsg: 'no privilege' });
        }
        const id = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: id, userid: 'u-' + id }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        mediaFetchCount++;
        const payload = url.pathname.endsWith('/ok.bin')
          ? encOk.encrypted
          : encTrans.encrypted;
        return new Response(payload, {
          status: 200,
          headers: {
            'content-length': String(payload.length),
            'content-disposition': `attachment; filename="${url.pathname.slice(1)}"`,
          },
        });
      }
      if (init?.method === 'PUT') {
        putCalls++;
        const sha = url.pathname.split('/').at(-1)!;
        const buf = Buffer.from(await new Response(init.body).arrayBuffer());
        hubStaged.set(sha, buf);
        return Response.json({ sha256: sha, size: buf.length });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'authorize') {
        authorizeCalls++;
        if (hubAuthMode === '403') return Response.json({}, { status: 403 });
        if (hubAuthMode === '503') return new Response('down', { status: 503 });
        return Response.json({ bound: true });
      }
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        if (op.subject === 'u-unbound-peer' || op.subject === 'u-bad-wecom') {
          return Response.json({}, { status: 403 });
        }
        if (hubAuthMode !== 'ok') return new Response('down', { status: 503 });
        for (const f of op.files ?? []) {
          if (!hubStaged.has(f.sha256)) {
            return Response.json({}, { status: 400 });
          }
        }
        acceptedPayloads.push(op);
        return Response.json({ accepted: true });
      }
      return Response.json({});
    },
    () => time,
  );

  try {
    adapter.configure(channel, identity);

    // 1. Unbound 403 sender with reachable Hub -> 0 media fetches, 0 staging files!
    hubAuthMode = '403';
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'unbound-peer' },
        msgid: 'm1-403',
        msgtype: 'file',
        file: {
          url: 'https://wwcdn.weixin.qq.com/ok.bin',
          aeskey: encOk.aeskey,
        },
      },
    });
    await untilPartSettled(adapter, 'm1-403');
    assert.equal(authorizeCalls, 1);
    assert.equal(mediaFetchCount, 0);
    await assert.rejects(stat(stagingDir));
    const p403 = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('m1-403') as { body: string; files: string };
    assert.equal(p403.files, '[]');
    assert.match(p403.body, /附件未接收/);

    // 2. Permanent WeCom identity rejection -> 0 media fetches, 0 staging files!
    wecomMode = 'perm-60011';
    hubAuthMode = 'ok';
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'bad-wecom' },
        msgid: 'm1-wecom-perm',
        msgtype: 'file',
        file: {
          url: 'https://wwcdn.weixin.qq.com/ok.bin',
          aeskey: encOk.aeskey,
        },
      },
    });
    await untilPartSettled(adapter, 'm1-wecom-perm');
    assert.equal(mediaFetchCount, 0);
    await assert.rejects(stat(stagingDir));

    // 3. Authorized 200 sender -> fromBot and authorize called ONCE in step 1, uploads directly via PUT!
    wecomMode = 'ok';
    fromBotCalls = 0;
    authorizeCalls = 0;
    putCalls = 0;
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'good-peer' },
        msgid: 'm1-ok',
        msgtype: 'file',
        file: {
          url: 'https://wwcdn.weixin.qq.com/ok.bin',
          aeskey: encOk.aeskey,
        },
      },
    });
    await untilPartSettled(adapter, 'm1-ok');
    assert.equal(mediaFetchCount, 1);
    assert.equal(fromBotCalls, 1);
    assert.equal(authorizeCalls, 1);
    assert.equal(putCalls, 1);
    assert.deepEqual(hubStaged.get(shaOk), plainOk);
    time += 3500;
    await adapter.flush();
    assert.equal(acceptedPayloads.length, 1);
    await assert.rejects(stat(join(stagingDir, shaOk)));

    // 4. Transient authorize 503 -> downloads & stages locally (skipping PUT during outage), delivers upon recovery!
    hubAuthMode = '503';
    putCalls = 0;
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'recover-peer' },
        msgid: 'm1-trans-file',
        msgtype: 'file',
        file: {
          url: 'https://wwcdn.weixin.qq.com/trans.bin',
          aeskey: encTrans.aeskey,
        },
      },
    });
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'recover-peer' },
        msgid: 'm1-trans-cap',
        msgtype: 'text',
        text: { content: 'transient authorize caption' },
      },
    });
    await untilPartSettled(adapter, 'm1-trans-file');
    assert.equal(mediaFetchCount, 2);
    assert.equal(putCalls, 0);
    assert.deepEqual(await readFile(join(stagingDir, shaTrans)), plainTrans);

    hubAuthMode = 'ok';
    hubStaged.clear();
    time += 3500;
    await adapter.flush();
    assert.equal(acceptedPayloads.length, 2);
    assert.equal(acceptedPayloads[1]!.text, 'transient authorize caption');
    assert.deepEqual(acceptedPayloads[1]!.files, [
      { name: 'trans.bin', sha256: shaTrans, size: plainTrans.length },
    ]);
    await assert.rejects(stat(join(stagingDir, shaTrans)));
  } finally {
    console.warn = origWarn;
    console.error = origError;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('M1-c-limits: staging limits enforce global bytes, global files, and per-sender bytes across DB and in-flight downloads with rate-limited notices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-m1-limits-'));
  const dirConc = await mkdtemp(join(tmpdir(), 'wecom-m1-conc-'));
  let time = 1000;
  let mediaFetches = 0;
  const sentNotices: Array<{ to: string; content: string }> = [];
  const origWarn = console.warn;
  console.warn = () => {};

  const readme = await readFile(
    new URL('./README.md', import.meta.url),
    'utf8',
  );
  assert.match(readme, /maxStagingBytes/);
  assert.match(readme, /maxStagingFiles/);
  assert.match(readme, /maxSenderStagingBytes/);
  assert.match(readme, /maxStagingAgeMs/);
  assert.match(readme, /536870912/);
  assert.match(readme, /134217728/);
  assert.match(readme, /7200000/);

  const payloads = new Map<string, Buffer>([
    ['/a50.bin', Buffer.alloc(50, 0x41)],
    ['/a40.bin', Buffer.alloc(40, 0x42)],
    ['/a20.bin', Buffer.alloc(20, 0x43)],
    ['/b30.bin', Buffer.alloc(30, 0x44)],
    ['/b60.bin', Buffer.alloc(60, 0x45)],
  ]);

  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage(to: string, body: { markdown?: { content?: string } }) {
      sentNotices.push({ to, content: body.markdown?.content ?? '' });
      return { headers: { req_id: 'r-limit' }, errcode: 0 };
    },
  });

  const postSocket = (socketDir: string, payload: unknown) =>
    new Promise<{ status: number; body: unknown }>((ok, fail) => {
      const bytes = Buffer.from(JSON.stringify(payload));
      const req = unixRequest(
        {
          socketPath: join(socketDir, 'channel.sock'),
          path: '/chat',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': bytes.length,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            ok({
              status: res.statusCode ?? 500,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      req.on('error', fail);
      req.end(bytes);
    });

  let close: (() => Promise<void>) | undefined;
  let concAdapter: ChannelSession | undefined;
  const concGate = deferred();
  const concStarted = deferred();
  try {
    close = await serveChannel(dir, {
      create: () => sdk as unknown as WSClient,
      now: () => time,
      maxStagingBytes: 200,
      maxStagingFiles: 3,
      maxSenderStagingBytes: 70,
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'qyapi.weixin.qq.com') {
          if (url.pathname.endsWith('/gettoken')) {
            return Response.json({
              errcode: 0,
              access_token: 'tok',
              expires_in: 7200,
            });
          }
          const id = JSON.parse(String(init?.body)).open_userid_list[0];
          return Response.json({
            errcode: 0,
            userid_list: [{ open_userid: id, userid: 'u-' + id }],
          });
        }
        if (url.hostname === 'wwcdn.weixin.qq.com') {
          mediaFetches++;
          const buf = payloads.get(url.pathname) ?? Buffer.alloc(10, 0x46);
          return new Response(new Uint8Array(buf), {
            status: 200,
            headers: {
              'content-length': String(buf.length),
              'content-disposition': `attachment; filename="${url.pathname.slice(1)}"`,
            },
          });
        }
        const op = JSON.parse(String(init?.body));
        if (op.action === 'authorize')
          return new Response('down', { status: 503 });
        if (op.action === 'next') return Response.json({ delivery: null });
        return new Response('down', { status: 503 });
      },
    });
    const cfg = await postSocket(dir, {
      action: 'configure',
      channel,
      identity,
    });
    assert.equal(cfg.status, 200);

    const emitFile = (
      targetSdk: EventEmitter,
      sender: string,
      msgid: string,
      path: string,
    ) =>
      targetSdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: sender },
          msgid,
          msgtype: 'file',
          file: { url: 'https://wwcdn.weixin.qq.com' + path },
        },
      });

    // 1. sender-a stages 50B (50/70 sender, 50/200 global, 1/3 files).
    emitFile(sdk, 'sender-a', 'lim-a1', '/a50.bin');
    // Wait until staging file appears on disk via ChannelSession socket DB check:
    const { DatabaseSync } = await import('node:sqlite');
    const waitSettledDb = async (msgid: string) => {
      const db = new DatabaseSync(join(dir, 'channel.sqlite'));
      try {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const row = db
            .prepare('SELECT body,files FROM part WHERE platform_id=?')
            .get(msgid) as { body: string; files: string | null } | undefined;
          if (row && row.files !== null) return row;
          await new Promise<void>((ok) => setImmediate(ok));
        }
        throw new Error(`part ${msgid} did not settle`);
      } finally {
        db.close();
      }
    };
    const rowA1 = await waitSettledDb('lim-a1');
    assert.equal(JSON.parse(rowA1.files!).length, 1);

    // 2. sender-a tries 40B (50 + 40 = 90 > 70 per-sender limit) -> rejected, 0 new staging file, notice sent!
    emitFile(sdk, 'sender-a', 'lim-a2', '/a40.bin');
    const rowA2 = await waitSettledDb('lim-a2');
    assert.equal(rowA2.files, '[]');
    assert.match(rowA2.body, /附件未接收/);
    assert.equal(sentNotices.length, 1);
    assert.equal(sentNotices[0]!.to, 'sender-a');
    assert.match(sentNotices[0]!.content, /暂存数量或容量已达上限/);
    assert.equal(sentNotices[0]!.content.includes('Hub'), false);
    const sha40 = createHash('sha256')
      .update(payloads.get('/a40.bin')!)
      .digest('hex');
    await assert.rejects(stat(join(dir, 'staging', sha40)));

    // 3. sender-a stages 20B (50 + 20 = 70/70 sender, 70/200 global, 2/3 files).
    emitFile(sdk, 'sender-a', 'lim-a3', '/a20.bin');
    const rowA3 = await waitSettledDb('lim-a3');
    assert.equal(JSON.parse(rowA3.files!).length, 1);

    // 4. sender-a sends another file while at 70/70 (global 70/200, 2/3 files) -> rejected BEFORE downloading (0 media fetches) & notice rate-limited!
    const fetchesBeforeZeroSender = mediaFetches;
    emitFile(sdk, 'sender-a', 'lim-a4', '/a40.bin');
    const rowA4 = await waitSettledDb('lim-a4');
    assert.equal(rowA4.files, '[]');
    assert.equal(mediaFetches, fetchesBeforeZeroSender);
    assert.equal(sentNotices.length, 1);

    // 5. sender-b stages 30B (30/70 sender, 100/200 global, 3/3 files); then sender-c hits globalFiles = 3/3 -> 0 media fetches & notice sent!
    emitFile(sdk, 'sender-b', 'lim-b1', '/b30.bin');
    const rowB1 = await waitSettledDb('lim-b1');
    assert.equal(JSON.parse(rowB1.files!).length, 1);
    const fetchesBeforeGlobalFiles = mediaFetches;
    emitFile(sdk, 'sender-c', 'lim-c1', '/b60.bin');
    const rowC1 = await waitSettledDb('lim-c1');
    assert.equal(rowC1.files, '[]');
    assert.equal(mediaFetches, fetchesBeforeGlobalFiles);
    assert.equal(sentNotices.length, 2);
    assert.equal(sentNotices[1]!.to, 'sender-c');
    await close();
    close = undefined;

    // 6. Global bytes cap & concurrent in-flight download tracking (maxStagingBytes=80, maxStagingFiles=1, maxSenderStagingBytes=80).
    let concFetches = 0;
    const concEmitter = new EventEmitter();
    const concSdk = Object.assign(concEmitter, {
      connect() {
        concEmitter.emit('authenticated');
      },
      disconnect() {},
      async sendMessage() {
        return { headers: { req_id: 'r' }, errcode: 0 };
      },
    });
    concAdapter = new ChannelSession(
      dirConc,
      () => concSdk as unknown as WSClient,
      async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'qyapi.weixin.qq.com') {
          if (url.pathname.endsWith('/gettoken')) {
            return Response.json({
              errcode: 0,
              access_token: 'tok',
              expires_in: 7200,
            });
          }
          const id = JSON.parse(String(init?.body)).open_userid_list[0];
          return Response.json({
            errcode: 0,
            userid_list: [{ open_userid: id, userid: 'u-' + id }],
          });
        }
        if (url.hostname === 'wwcdn.weixin.qq.com') {
          concFetches++;
          if (url.pathname === '/first.bin') {
            concStarted.resolve();
            await concGate.promise;
          }
          const size =
            url.pathname === '/dup.bin'
              ? 60
              : url.pathname === '/fill20.bin'
                ? 20
                : 60;
          const fill = url.pathname === '/fill20.bin' ? 0x52 : 0x51;
          const buf = Buffer.alloc(size, fill);
          return new Response(new Uint8Array(buf), {
            status: 200,
            headers: { 'content-length': String(buf.length) },
          });
        }
        const op = JSON.parse(String(init?.body));
        if (op.action === 'authorize')
          return new Response('down', { status: 503 });
        return Response.json({ delivery: null });
      },
      () => time,
      undefined,
      undefined,
      undefined,
      {
        maxStagingBytes: 80,
        maxStagingFiles: 1,
        maxSenderStagingBytes: 80,
      },
    );
    concAdapter.configure(channel, identity);
    emitFile(concSdk, 'c-1', 'conc-first', '/first.bin');
    await concStarted.promise;
    // While first download is in-flight (occupying the 1 global file slot), second download rejects before fetching!
    emitFile(concSdk, 'c-2', 'conc-second', '/second.bin');
    await untilPartSettled(concAdapter, 'conc-second');
    assert.equal(concFetches, 1);
    const secondRow = concAdapter.db
      .prepare('SELECT files FROM part WHERE platform_id=?')
      .get('conc-second') as { files: string };
    assert.equal(secondRow.files, '[]');
    concGate.resolve();
    await untilPartSettled(concAdapter, 'conc-first');
    const firstRow = concAdapter.db
      .prepare('SELECT files FROM part WHERE platform_id=?')
      .get('conc-first') as { files: string };
    assert.equal(JSON.parse(firstRow.files).length, 1);
    await concAdapter.close();
    concAdapter = undefined;

    // 7. Standalone global bytes cap (maxStagingBytes=80, maxStagingFiles=10, maxSenderStagingBytes=80) & sha256 dedup:
    const dirBytes = await mkdtemp(join(tmpdir(), 'wecom-m1-gbytes-'));
    let gbytesFetches = 0;
    const gbytesEmitter = new EventEmitter();
    const gbytesSdk = Object.assign(gbytesEmitter, {
      connect() {
        gbytesEmitter.emit('authenticated');
      },
      disconnect() {},
      async sendMessage() {
        return { headers: { req_id: 'r' }, errcode: 0 };
      },
    });
    const gbytesAdapter = new ChannelSession(
      dirBytes,
      () => gbytesSdk as unknown as WSClient,
      async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'qyapi.weixin.qq.com') {
          if (url.pathname.endsWith('/gettoken')) {
            return Response.json({
              errcode: 0,
              access_token: 'tok',
              expires_in: 7200,
            });
          }
          const id = JSON.parse(String(init?.body)).open_userid_list[0];
          return Response.json({
            errcode: 0,
            userid_list: [{ open_userid: id, userid: 'u-' + id }],
          });
        }
        if (url.hostname === 'wwcdn.weixin.qq.com') {
          gbytesFetches++;
          const size =
            url.pathname === '/g60.bin' || url.pathname === '/g60dup.bin'
              ? 60
              : url.pathname === '/g30.bin'
                ? 30
                : 20;
          const fill =
            url.pathname === '/g60.bin' || url.pathname === '/g60dup.bin'
              ? 0x61
              : url.pathname === '/g30.bin'
                ? 0x62
                : 0x63;
          const buf = Buffer.alloc(size, fill);
          return new Response(new Uint8Array(buf), {
            status: 200,
            headers: { 'content-length': String(buf.length) },
          });
        }
        const op = JSON.parse(String(init?.body));
        if (op.action === 'authorize')
          return new Response('down', { status: 503 });
        return Response.json({ delivery: null });
      },
      () => time,
      undefined,
      undefined,
      undefined,
      {
        maxStagingBytes: 80,
        maxStagingFiles: 10,
        maxSenderStagingBytes: 80,
      },
    );
    try {
      gbytesAdapter.configure(channel, identity);
      // g-1 stages 60B -> global 60/80.
      emitFile(gbytesSdk, 'g-1', 'gb-1', '/g60.bin');
      await untilPartSettled(gbytesAdapter, 'gb-1');
      // g-2 tries 30B (within g-2's 80B limit & 10 files limit, but 60+30=90 > 80 global!) -> rejected!
      emitFile(gbytesSdk, 'g-2', 'gb-2', '/g30.bin');
      await untilPartSettled(gbytesAdapter, 'gb-2');
      assert.equal(
        (
          gbytesAdapter.db
            .prepare('SELECT files FROM part WHERE platform_id=?')
            .get('gb-2') as { files: string }
        ).files,
        '[]',
      );
      // g-3 sends 20B -> global reaches 80/80.
      emitFile(gbytesSdk, 'g-3', 'gb-3', '/g20.bin');
      await untilPartSettled(gbytesAdapter, 'gb-3');
      assert.equal(
        JSON.parse(
          (
            gbytesAdapter.db
              .prepare('SELECT files FROM part WHERE platform_id=?')
              .get('gb-3') as { files: string }
          ).files,
        ).length,
        1,
      );
      // g-4 tries 20B when globalBytes is 80/80 -> rejected BEFORE downloading (0 new fetches)!
      const fetchesAtFull = gbytesFetches;
      emitFile(gbytesSdk, 'g-4', 'gb-4', '/g20.bin');
      await untilPartSettled(gbytesAdapter, 'gb-4');
      assert.equal(gbytesFetches, fetchesAtFull);
      assert.equal(
        (
          gbytesAdapter.db
            .prepare('SELECT files FROM part WHERE platform_id=?')
            .get('gb-4') as { files: string }
        ).files,
        '[]',
      );
    } finally {
      await gbytesAdapter.close();
      await rm(dirBytes, { recursive: true, force: true });
    }
  } finally {
    concGate.resolve();
    console.warn = origWarn;
    await concAdapter?.close();
    await close?.();
    await rm(dir, { recursive: true, force: true });
    await rm(dirConc, { recursive: true, force: true });
  }
});

test('M1-c-expiry & M1-d: expired staging batches purge disk files immediately, clear attachments, notify sender, unblock FIFO, and rate-limit retry warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-m1-expiry-'));
  const stagingDir = join(dir, 'staging');
  let time = 1000;
  let hubMode: '503' | '502' | 'ok' = '503';
  const sentNotices: Array<{ to: string; content: string }> = [];
  const acceptedInputs: Array<Record<string, unknown>> = [];
  const warnLogs: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warnLogs.push(args);

  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage(to: string, body: { markdown?: { content?: string } }) {
      sentNotices.push({ to, content: body.markdown?.content ?? '' });
      return { headers: { req_id: 'r-exp' }, errcode: 0 };
    },
  });

  const fileOnlyBytes = Buffer.from('expired-file-only-payload');
  const fileOnlySha = createHash('sha256').update(fileOnlyBytes).digest('hex');
  const fileTextBytes = Buffer.from('expired-with-text-payload');
  const fileTextSha = createHash('sha256').update(fileTextBytes).digest('hex');

  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'qyapi.weixin.qq.com') {
        if (url.pathname.endsWith('/gettoken')) {
          return Response.json({
            errcode: 0,
            access_token: 'tok',
            expires_in: 7200,
          });
        }
        const id = JSON.parse(String(init?.body)).open_userid_list[0];
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: id, userid: 'u-' + id }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        const buf = url.pathname.endsWith('/only.bin')
          ? fileOnlyBytes
          : fileTextBytes;
        return new Response(buf, {
          status: 200,
          headers: {
            'content-length': String(buf.length),
            'content-disposition': `attachment; filename="${url.pathname.slice(1)}"`,
          },
        });
      }
      if (init?.method === 'PUT') {
        const buf = Buffer.from(await new Response(init.body).arrayBuffer());
        return Response.json({
          sha256: url.pathname.split('/').at(-1),
          size: buf.length,
        });
      }
      const op = JSON.parse(String(init?.body));
      if (op.action === 'authorize') {
        return hubMode === 'ok'
          ? Response.json({ bound: true })
          : new Response('down', { status: Number(hubMode) });
      }
      if (op.action === 'next') return Response.json({ delivery: null });
      if (op.action === 'inbound') {
        if (hubMode !== 'ok')
          return new Response('down', { status: Number(hubMode) });
        acceptedInputs.push(op);
        return Response.json({ accepted: true });
      }
      return Response.json({});
    },
    () => time,
    undefined,
    undefined,
    undefined,
    { maxStagingAgeMs: 60_000 },
  );

  try {
    adapter.configure(channel, identity);

    // 1. Create file-only batch at t=1000, then follow-up text batch at t=5000 for same sender.
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer-exp' },
        msgid: 'exp-file-only',
        msgtype: 'file',
        file: { url: 'https://wwcdn.weixin.qq.com/only.bin' },
      },
    });
    await untilPartSettled(adapter, 'exp-file-only');
    assert.equal((await stat(join(stagingDir, fileOnlySha))).isFile(), true);

    time = 5000;
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer-exp' },
        msgid: 'after-exp',
        msgtype: 'text',
        text: { content: 'follow-up after expiry' },
      },
    });

    // Retry exp-file-only 4 times within 5m with same 503 error -> only 1 retry warning!
    for (let i = 0; i < 4; i++) {
      await adapter.flush();
      const row = adapter.db
        .prepare('SELECT next_at FROM batch WHERE request=?')
        .get('exp-file-only') as { next_at: number };
      time = row.next_at;
    }
    const retryWarns503 = warnLogs.filter(
      (l) => l[0] === '[wecom] inbound batch retrying:',
    );
    assert.equal(retryWarns503.length, 1);

    // Distinct error reason (502) for same seq logs once and also rate-limits within 5m.
    hubMode = '502';
    await adapter.flush();
    time = (
      adapter.db
        .prepare('SELECT next_at FROM batch WHERE request=?')
        .get('exp-file-only') as { next_at: number }
    ).next_at;
    await adapter.flush();
    assert.equal(
      warnLogs.filter((l) => l[0] === '[wecom] inbound batch retrying:').length,
      2,
    );

    // 2. Create text+file batch at t=20000 for peer-text.
    time = 20_000;
    hubMode = '503';
    sdk.emit('message', {
      body: {
        chattype: 'single',
        aibotid: 'bot',
        from: { userid: 'peer-text' },
        msgid: 'exp-with-text',
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: 'keep my question' } },
            {
              msgtype: 'file',
              file: { url: 'https://wwcdn.weixin.qq.com/text.bin' },
            },
          ],
        },
      },
    });
    await untilPartSettled(adapter, 'exp-with-text');
    assert.equal((await stat(join(stagingDir, fileTextSha))).isFile(), true);

    // 3. Advance to t = 1000 + 60_000 (exp-file-only expires, exp-with-text age=41_000 < 60_000 still kept!).
    time = 61_000;
    await adapter.flush();
    const expiredBatch = adapter.db
      .prepare('SELECT state,next_at,error FROM batch WHERE request=?')
      .get('exp-file-only') as {
      state: string;
      next_at: number;
      error: string | null;
    };
    const expiredPart = adapter.db
      .prepare('SELECT files FROM part WHERE platform_id=?')
      .get('exp-file-only') as { files: string };
    assert.equal(expiredBatch.state, 'failed');
    assert.equal(expiredBatch.next_at, 0);
    assert.equal(expiredBatch.error, 'staging retention expired');
    assert.equal(expiredPart.files, '[]');
    await assert.rejects(stat(join(stagingDir, fileOnlySha)));
    assert.equal((await stat(join(stagingDir, fileTextSha))).isFile(), true);
    assert.ok(
      sentNotices.some(
        (n) =>
          n.to === 'peer-exp' &&
          /暂存超过保留时间/.test(n.content) &&
          !n.content.includes('Hub'),
      ),
    );

    // 4. Advance to t = 80_000 (exp-with-text expires) and recover Hub -> text + expiry notice delivers!
    time = 80_000;
    hubMode = 'ok';
    await adapter.flush();
    await assert.rejects(stat(join(stagingDir, fileTextSha)));
    assert.ok(
      sentNotices.some(
        (n) => n.to === 'peer-text' && /暂存超过保留时间/.test(n.content),
      ),
    );
    const followUp = acceptedInputs.find((p) => p.platformId === 'after-exp');
    const expiredTextDelivery = acceptedInputs.find(
      (p) => p.platformId === 'exp-with-text',
    );
    assert.equal(followUp?.text, 'follow-up after expiry');
    assert.ok(expiredTextDelivery);
    assert.equal(expiredTextDelivery!.files, undefined);
    assert.match(
      String(expiredTextDelivery!.text),
      /keep my question.*附件暂存超时未送达，请重新上传/,
    );
  } finally {
    console.warn = origWarn;
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('S1: transferHubFile aborts stalled PUT/GET transfers without extra AbortSignal.timeout while completing slow steady multi-chunk progress', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const dir = await mkdtemp(join(tmpdir(), 'wecom-s1-stall-'));
  let time = 1000;
  const origWarn = console.warn;
  console.warn = () => {};
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
  });

  try {
    const payload = Buffer.alloc(4096, 0x77);
    const sha = createHash('sha256').update(payload).digest('hex');

    // (i) Stalled PUT stops reading after chunk 0 -> aborts promptly at 40ms with TimeoutError (no second AbortSignal.timeout).
    const origTimeout = AbortSignal.timeout;
    const seenTimeouts: number[] = [];
    AbortSignal.timeout = ((ms: number) => {
      seenTimeouts.push(ms);
      return origTimeout.call(AbortSignal, ms);
    }) as typeof AbortSignal.timeout;
    try {
      const stalled: { error?: unknown } = {};
      const stallFetchStarted = deferred();
      const stalledPromise = transferHubFile(
        async (_input, init) => {
          assert.equal((init as { duplex?: string }).duplex, 'half');
          const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
          await reader.read();
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => reject(init!.signal!.reason),
              { once: true },
            );
            stallFetchStarted.resolve();
          });
        },
        channel,
        'member',
        sha,
        payload,
        undefined,
        { stallTimeoutMs: 40, chunkBytes: 1024 },
      ).catch((err) => {
        stalled.error = err;
      });
      await stallFetchStarted.promise;
      t.mock.timers.tick(39);
      await new Promise<void>((ok) => setImmediate(ok));
      assert.equal(stalled.error, undefined);
      t.mock.timers.tick(1);
      await Promise.race([
        stalledPromise,
        new Promise<void>((ok) => setImmediate(ok)),
      ]);
      assert.ok(stalled.error instanceof DOMException);
      assert.equal(stalled.error.name, 'TimeoutError');
      assert.deepEqual(seenTimeouts, [900_000]);
    } finally {
      AbortSignal.timeout = origTimeout;
    }

    // (i-b) Stalled response.body on GET aborts cleanly at 40ms.
    let getReaderCancelReason: unknown;
    const getFirstChunkEnqueued = deferred();
    const stalledGetResp = await transferHubFile(
      async () => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(Buffer.from('first'));
            getFirstChunkEnqueued.resolve();
          },
          cancel(reason) {
            getReaderCancelReason = reason;
          },
        });
        return new Response(body, { status: 200 });
      },
      channel,
      'member',
      sha,
      undefined,
      'receipt-1',
      { stallTimeoutMs: 40 },
    );
    const getResult: { error?: unknown } = {};
    const readingGet = stalledGetResp.arrayBuffer().catch((err) => {
      getResult.error = err;
    });
    await getFirstChunkEnqueued.promise;
    await new Promise<void>((ok) => setImmediate(ok));
    t.mock.timers.tick(39);
    await new Promise<void>((ok) => setImmediate(ok));
    assert.equal(getResult.error, undefined);
    t.mock.timers.tick(1);
    await Promise.race([
      readingGet,
      new Promise<void>((ok) => setImmediate(ok)),
    ]);
    assert.ok(getResult.error instanceof DOMException);
    assert.equal(getResult.error.name, 'TimeoutError');
    assert.ok(getReaderCancelReason instanceof DOMException);

    // (ii) Slow multi-chunk upload (> 40ms total across 4 chunks * 25ms = 100ms) completes 200.
    let readChunks = 0;
    const slowResp = await transferHubFile(
      async (_input, init) => {
        const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
        const received: Uint8Array[] = [];
        while (true) {
          t.mock.timers.tick(25);
          const { done, value } = await reader.read();
          if (done) break;
          readChunks++;
          received.push(value);
        }
        const merged = Buffer.concat(received);
        return Response.json({
          sha256: createHash('sha256').update(merged).digest('hex'),
          size: merged.length,
        });
      },
      channel,
      'member',
      sha,
      payload,
      undefined,
      { stallTimeoutMs: 40, chunkBytes: 1024 },
    );
    assert.equal(slowResp.status, 200);
    assert.equal(readChunks, 4);
    assert.deepEqual(await slowResp.json(), { sha256: sha, size: 4096 });

    // (iii) ChannelSession classifies a stalled PUT as transient (not permanent) and recovers on flush.
    let failFirstPutStall = true;
    let putStallStarted = deferred();
    const acceptedPayloads: Array<Record<string, unknown>> = [];
    const adapter = new ChannelSession(
      dir,
      () => sdk as unknown as WSClient,
      async (input, init) => {
        const url = new URL(String(input));
        if (url.hostname === 'qyapi.weixin.qq.com') {
          if (url.pathname.endsWith('/gettoken')) {
            return Response.json({
              errcode: 0,
              access_token: 'tok',
              expires_in: 7200,
            });
          }
          const id = JSON.parse(String(init?.body)).open_userid_list[0];
          return Response.json({
            errcode: 0,
            userid_list: [{ open_userid: id, userid: 'u-' + id }],
          });
        }
        if (url.hostname === 'wwcdn.weixin.qq.com') {
          return new Response(new Uint8Array(payload), {
            status: 200,
            headers: { 'content-length': String(payload.length) },
          });
        }
        if (init?.method === 'PUT') {
          if (failFirstPutStall) {
            return new Promise<Response>((_resolve, reject) => {
              init.signal!.addEventListener(
                'abort',
                () => reject(init.signal!.reason),
                { once: true },
              );
              putStallStarted.resolve();
            });
          }
          const buf = Buffer.from(await new Response(init.body).arrayBuffer());
          return Response.json({
            sha256: url.pathname.split('/').at(-1),
            size: buf.length,
          });
        }
        const op = JSON.parse(String(init?.body));
        if (op.action === 'authorize') return Response.json({ bound: true });
        if (op.action === 'next') return Response.json({ delivery: null });
        if (op.action === 'inbound') {
          if (failFirstPutStall) return Response.json({}, { status: 400 });
          acceptedPayloads.push(op);
          return Response.json({ accepted: true });
        }
        return Response.json({});
      },
      () => time,
      undefined,
      undefined,
      undefined,
      { transferStallTimeoutMs: 40 },
    );
    try {
      adapter.configure(channel, identity);
      sdk.emit('message', {
        body: {
          chattype: 'single',
          aibotid: 'bot',
          from: { userid: 'stall-peer' },
          msgid: 's1-msg',
          msgtype: 'file',
          file: { url: 'https://wwcdn.weixin.qq.com/s1.bin' },
        },
      });
      await putStallStarted.promise;
      t.mock.timers.tick(40);
      await untilPartSettled(adapter, 's1-msg');
      putStallStarted = deferred();
      time += 3500;
      const flushing = adapter.flush();
      await putStallStarted.promise;
      t.mock.timers.tick(40);
      await flushing;
      const pendingRow = adapter.db
        .prepare(
          'SELECT state,attempts,transient_attempts,next_at FROM batch WHERE request=?',
        )
        .get('s1-msg') as {
        state: string;
        attempts: number;
        transient_attempts: number;
        next_at: number;
      };
      assert.equal(pendingRow.state, 'pending');
      assert.equal(pendingRow.attempts, 0);
      assert.equal(pendingRow.transient_attempts, 1);

      failFirstPutStall = false;
      time = pendingRow.next_at;
      await adapter.flush();
      assert.equal(acceptedPayloads.length, 1);
      assert.equal(
        (acceptedPayloads[0]!.files as Array<{ sha256: string }>)[0]!.sha256,
        sha,
      );
    } finally {
      await adapter.close();
    }
  } finally {
    t.mock.timers.reset();
    console.warn = origWarn;
    await rm(dir, { recursive: true, force: true });
  }
});

test('S2: formatChannelNotice maps message_not_processed and English fallback to Simplified Chinese', async () => {
  assert.equal(
    formatChannelNotice('message_not_processed', 'raw english'),
    '本条消息未被处理，可以重新发送。',
  );
  assert.equal(
    formatChannelNotice(
      undefined,
      'message was not processed; you can resend it',
    ),
    '本条消息未被处理，可以重新发送。',
  );

  const dir = await mkdtemp(join(tmpdir(), 'wecom-s2-notice-'));
  const sentMessages: Array<{ to: string; body: unknown }> = [];
  const emitter = new EventEmitter();
  const sdk = Object.assign(emitter, {
    connect() {
      emitter.emit('authenticated');
    },
    disconnect() {},
    async sendMessage(to: string, body: unknown) {
      sentMessages.push({ to, body });
      return { headers: { req_id: 'req-s2' }, errcode: 0 };
    },
  });
  const text = 'message was not processed; you can resend it';
  const intent = makeDeliveryIntent(text);
  let delivered = false;
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (_input, init) => {
      const op = JSON.parse(String(init?.body));
      if (op.action === 'next') {
        if (delivered) return Response.json({ delivery: null });
        delivered = true;
        return Response.json({
          delivery: {
            subject: 'member',
            receipt: '77777777-7777-4777-8777-777777777777',
            role: 'notice',
            code: 'message_not_processed',
            text,
            sha256: intent.sha256,
            size: intent.size,
            file: null,
            intent,
          },
        });
      }
      return Response.json({});
    },
  );
  try {
    adapter.configure(channel, identity);
    await adapter.flush();
    assert.equal(sentMessages.length, 1);
    assert.equal(
      (sentMessages[0]!.body as { markdown: { content: string } }).markdown
        .content,
      '本条消息未被处理，可以重新发送。',
    );
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

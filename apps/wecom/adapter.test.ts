import { createCipheriv, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
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
} from './adapter.ts';
import { loginUrl, WeComApiError, WeComApplication } from './identity.ts';

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
            controller.enqueue(Buffer.from('Bad Gateway'));
            controller.close();
          },
          cancel() {
            cancelledUpload = true;
          },
        });
        return new Response(body, { status: 502 });
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
    assert.ok(migratedCols.includes('next_at'));
    assert.ok(migratedCols.includes('error'));
    const migratedRow = adapter.db
      .prepare('SELECT attempts,next_at,error FROM batch WHERE request=?')
      .get('legacy-pending') as {
      attempts: number;
      next_at: number;
      error: string | null;
    };
    assert.equal(migratedRow.attempts, 0);
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
      4,
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
        .prepare('SELECT state,attempts,next_at FROM batch WHERE request=?')
        .get('outage-msg') as {
        state: string;
        attempts: number;
        next_at: number;
      };
      assert.equal(row.state, 'pending');
      assert.equal(row.attempts, i);
      deltas.push(row.next_at - time);
      time = row.next_at;
    }
    assert.deepEqual(
      deltas,
      [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000],
    );
    assert.equal(
      warnLogs.filter((l) => l[0] === '[wecom] inbound batch retrying:').length,
      8,
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
      ['reject-403', /未绑定 Hub 账号或机器人访问权限已停用/],
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
      assert.match(sentNotices.at(-1)?.content ?? '', pattern);
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
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: 'peer', userid: 'u-peer' }],
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

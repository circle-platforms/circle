import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WSClient } from '@wecom/aibot-node-sdk';
import { ChannelSession, privateInput } from './adapter.ts';
import { loginUrl, WeComApplication } from './identity.ts';

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
    await new Promise<void>((resolve) => setImmediate(resolve));
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
    await new Promise<void>((resolve) => setImmediate(resolve));
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

test('fromBot falls back to plaintext userid only on errcode 0 invalid_open_userid_list and rejects errcode 40003', async () => {
  let mode: 'plaintext' | 'mismatch' | 'err40003' = 'plaintext';
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
    return Response.json({
      errcode: 40003,
      errmsg: 'invalid userid',
      invalid_open_userid_list: ['plain-member'],
    });
  });
  assert.equal(await app.fromBot('plain-member'), 'plain-member');
  mode = 'mismatch';
  await assert.rejects(app.fromBot('plain-member'));
  mode = 'err40003';
  await assert.rejects(app.fromBot('plain-member'));
});

test('failing sender batch backs off and quarantines across restarts without blocking other senders or outbound', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'wecom-c1-'));
  // Seed legacy batch schema without attempts, next_at, error to verify ALTER TABLE migration.
  const legacy = new DatabaseSync(join(dir, 'channel.sqlite'));
  legacy.exec(`
    CREATE TABLE batch(seq INTEGER PRIMARY KEY, scope TEXT NOT NULL,request TEXT NOT NULL,sender TEXT NOT NULL,state TEXT NOT NULL,due INTEGER NOT NULL,UNIQUE(scope,request));
    CREATE TABLE part(seq INTEGER PRIMARY KEY,scope TEXT NOT NULL,platform_id TEXT NOT NULL,batch INTEGER NOT NULL,body TEXT NOT NULL,files TEXT,UNIQUE(scope,platform_id));
    CREATE TABLE peer(scope TEXT NOT NULL,subject TEXT NOT NULL,sender TEXT NOT NULL,PRIMARY KEY(scope,subject));
  `);
  legacy.close();
  let time = 1000;
  let badCalls = 0;
  const hubCalls: string[] = [];
  const makeHarness = () => {
    const emitter = new EventEmitter();
    const sdk = Object.assign(emitter, {
      connect() {
        emitter.emit('authenticated');
      },
      disconnect() {},
      async sendMessage() {
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
      if (body.action === 'inbound' && body.subject === 'u-conflict')
        return Response.json({}, { status: 409 });
      if (body.action === 'next' && !outboundDelivered) {
        outboundDelivered = true;
        const text = 'hello member';
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
        return Response.json({
          delivery: {
            subject: 'u-goodsender',
            receipt: 'r-out-1',
            role: 'assistant',
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
    assert.ok(hubCalls.includes('inbound:u-goodsender'));
    assert.ok(hubCalls.includes('next'));
    assert.ok(hubCalls.includes('receipt'));
    const badRow1 = adapter.db
      .prepare('SELECT state,attempts,next_at,error FROM batch WHERE sender=?')
      .get('badsender') as {
      state: string;
      attempts: number;
      next_at: number;
      error: string | null;
    };
    assert.equal(badRow1.state, 'pending');
    assert.equal(badRow1.attempts, 1);
    assert.ok(badRow1.next_at > time);
    assert.ok(badRow1.error);

    // Flush before next_at must NOT retry badsender or conflict.
    const callsBeforeWait = badCalls;
    time += 1;
    await adapter.flush();
    assert.equal(badCalls, callsBeforeWait);

    // Advance past exponential backoff up to MAX_BATCH_ATTEMPTS (5).
    for (let attempt = 2; attempt <= 5; attempt++) {
      const row = adapter.db
        .prepare('SELECT next_at FROM batch WHERE sender=?')
        .get('badsender') as { next_at: number };
      time = row.next_at;
      await adapter.flush();
    }
    const quarantined = adapter.db
      .prepare('SELECT state,attempts FROM batch WHERE sender=?')
      .get('badsender') as { state: string; attempts: number };
    assert.equal(quarantined.state, 'failed');
    assert.equal(quarantined.attempts, 5);
    const quarantinedConflict = adapter.db
      .prepare('SELECT state,attempts FROM batch WHERE sender=?')
      .get('conflict') as { state: string; attempts: number };
    assert.equal(quarantinedConflict.state, 'failed');
    assert.equal(quarantinedConflict.attempts, 5);

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
    assert.equal(
      hubCalls.filter((x) => x === 'inbound:u-goodsender').length,
      2,
    );
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('downloadMedia enforces allowlisted HTTPS media hosts and aborts streams above encrypted attachment limit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wecom-c9-'));
  let time = 100;
  const fetchedUrls: string[] = [];
  let pulledChunks = 0;
  let streamCancelled = false;
  let streamMode: 'header' | 'chunks' = 'header';
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
        return Response.json({
          errcode: 0,
          userid_list: [{ open_userid: 'peer', userid: 'member' }],
        });
      }
      if (url.hostname === 'wwcdn.weixin.qq.com') {
        if (streamMode === 'header') {
          const body = new ReadableStream<Uint8Array>(
            {
              pull() {
                pulledChunks++;
              },
              cancel() {
                streamCancelled = true;
              },
            },
            { highWaterMark: 0 },
          );
          return new Response(body, {
            status: 200,
            headers: {
              'content-length': String(100 * 1024 * 1024 + 64),
            },
          });
        }
        let sentCount = 0;
        const body = new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              sentCount++;
              pulledChunks++;
              if (sentCount <= 3)
                controller.enqueue(Buffer.alloc(51 * 1024 * 1024));
              else controller.close();
            },
            cancel() {
              streamCancelled = true;
            },
          },
          { highWaterMark: 0 },
        );
        return new Response(body, { status: 200 });
      }
      const op = JSON.parse(String(init?.body));
      return Response.json(
        op.action === 'authorize' ? { bound: true } : { delivery: null },
      );
    },
    () => time,
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
    await new Promise<void>((ok) => setImmediate(ok));
    assert.ok(
      !fetchedUrls.some((u) => u.includes('evil.example.invalid')),
      'non-allowlisted media host must not be fetched',
    );
    const badHostPart = adapter.db
      .prepare('SELECT body,files FROM part WHERE platform_id=?')
      .get('bad-host') as { body: string; files: string };
    assert.equal(badHostPart.files, '[]');
    assert.match(badHostPart.body, /附件未接收/);

    // 2. Content-Length > encrypted upper bound cancels stream without pulling body.
    streamMode = 'header';
    pulledChunks = 0;
    streamCancelled = false;
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
    await new Promise<void>((ok) => setImmediate(ok));
    await new Promise<void>((ok) => setTimeout(ok, 20));
    assert.equal(streamCancelled, true);
    assert.equal(pulledChunks, 0);

    // 3. Streamed chunks exceeding encrypted upper bound cancel immediately after 2nd 51MiB chunk.
    streamMode = 'chunks';
    pulledChunks = 0;
    streamCancelled = false;
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
    await new Promise<void>((ok) => setImmediate(ok));
    await new Promise<void>((ok) => setTimeout(ok, 50));
    assert.equal(streamCancelled, true);
    assert.equal(pulledChunks, 2);
  } finally {
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

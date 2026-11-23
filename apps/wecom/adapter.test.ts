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
  assert.equal(attempts, 1);
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
        const row = claimed
          ? null
          : {
              subject: 'member',
              receipt: 'one',
              role: 'user',
              text: '来自 Mac：\nfrom Mac',
              sha256: createHash('sha256')
                .update('来自 Mac：\nfrom Mac')
                .digest('hex'),
              size: Buffer.byteLength('来自 Mac：\nfrom Mac'),
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
      },
    ]);
    assert.equal(sent.length, 1);
    assert.deepEqual((sent[0] as { peer: string }).peer, 'peer');
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file followed by its caption becomes one verified input across platform redelivery', async () => {
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
    async downloadFile() {
      return { buffer: Buffer.from('synthetic file'), filename: 'fixture.txt' };
    },
  });
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (url, init) => {
      const path = new URL(String(url)).pathname;
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
      file: { url: 'https://media.example.invalid/file', aeskey: 'synthetic' },
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
    async downloadFile() {
      return { buffer: Buffer.from('attachment'), filename: 'broken.txt' };
    },
  });
  let servedOutbound = false;
  const sha = createHash('sha256').update('outbound').digest('hex');
  const adapter = new ChannelSession(
    dir,
    () => sdk as unknown as WSClient,
    async (url, init) => {
      const path = new URL(String(url)).pathname;
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
        return Response.json({
          delivery: {
            receipt: 'r-file-1',
            subject: 'member',
            text: '',
            sha256: sha,
            size: 8,
            file: { name: 'out.bin', sha256: sha, size: 8 },
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
          url: 'https://media.example.invalid/file',
          aeskey: 'synthetic',
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
    assert.equal(receipts[0]!.state, 'not_sent');
  } finally {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  }
});

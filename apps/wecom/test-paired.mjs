// Exercise the official WebSocket client against either a real Hub checkout or a self-contained mock Hub.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request as unixRequest } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { WSClient } from '@wecom/aibot-node-sdk';
import { ChannelSession } from './adapter.ts';

async function loadRemoteBotService() {
  const distPath = new URL('../../dist/remote_bot_service.js', import.meta.url);
  if (existsSync(distPath)) {
    const [{ serveRemoteBot }, { VERSION }] = await Promise.all([
      import(distPath.href),
      import(new URL('../../dist/version.js', import.meta.url).href),
    ]);
    return { serveRemoteBot, VERSION };
  }
  const { tsImport } = await import(
    new URL('../../node_modules/tsx/dist/esm/api/index.mjs', import.meta.url)
      .href
  );
  const [{ serveRemoteBot }, { VERSION }] = await Promise.all([
    tsImport('../../src/remote_bot_service.ts', import.meta.url),
    tsImport('../../src/version.ts', import.meta.url),
  ]);
  return { serveRemoteBot, VERSION };
}

const { serveRemoteBot, VERSION } = await loadRemoteBotService();
const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

async function createMockHub(identity, channelConfig) {
  const dataDir = await mkdtemp(join(tmpdir(), 'wecom-paired-mock-'));
  const runtimeDir = join(dataDir, 'bot-runtime');
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const a = { principal: { id: 'member-a' }, token: 'token-a' };
  const b = { principal: { id: 'member-b' }, token: 'token-b' };
  const membersByToken = new Map([
    [a.token, a],
    [b.token, b],
  ]);
  const issuer = sha256Hex(
    JSON.stringify(['bot-identity-v1', identity.tenant]),
  );
  const bindings = new Map([
    ['bound-a', a.principal.id],
    ['bound-b', b.principal.id],
  ]);
  const subjectByOwner = new Map([
    [a.principal.id, 'bound-a'],
    [b.principal.id, 'bound-b'],
  ]);
  const disabled = new Set();
  const staged = new Map();
  const storedFiles = new Map();
  const intents = new Map();
  const receipts = new Map();
  let botProfile = null;
  let channelToken = channelConfig.token;
  let botId = channelConfig.bot;

  const callHost = (frame) =>
    new Promise((ok, fail) => {
      const payload = Buffer.from(JSON.stringify(frame));
      const req = unixRequest(
        {
          socketPath: join(runtimeDir, 'host.sock'),
          path: '/chat',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': payload.length,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () =>
            ok({
              status: res.statusCode ?? 500,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
            }),
          );
        },
      );
      req.on('error', fail);
      req.end(payload);
    });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const rawBody = Buffer.concat(chunks);
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (url.pathname === '/api/bot/v1') {
      const auth = String(req.headers.authorization ?? '');
      const member = membersByToken.get(auth.replace(/^Bearer /, ''));
      if (!member) return reply(401, { code: 'UNAUTHORIZED' });
      if (disabled.has(member.principal.id))
        return reply(403, { code: 'BOT_DISABLED' });
      const ver = req.headers['bot-client-version'];
      if (typeof ver !== 'string' || !/^\d+\.\d+\.\d+/.test(ver))
        return reply(400, { code: 'BOT_VERSION_INVALID' });
      const op = JSON.parse(rawBody.toString('utf8'));
      const result = await callHost({
        owner: member.principal.id,
        op,
        version: ver,
        config: op.action === 'send' ? botProfile : undefined,
        route:
          op.action === 'send'
            ? {
                source: 'desktop',
                issuer,
                subject: subjectByOwner.get(member.principal.id) ?? null,
              }
            : undefined,
      });
      return reply(result.status, result.body);
    }

    const auth = String(req.headers.authorization ?? '');
    if (auth !== 'Bearer ' + channelToken)
      return reply(401, { code: 'UNAUTHORIZED' });

    if (url.pathname.startsWith('/api/bot-channel/v1/files/')) {
      const sha = url.pathname.split('/').at(-1);
      const encSub = req.headers['bot-member-subject'];
      if (typeof encSub !== 'string') return reply(403, {});
      const sub = Buffer.from(encSub, 'base64url').toString('utf8');
      const owner = bindings.get(sub);
      if (!owner || disabled.has(owner)) return reply(403, {});
      if (req.method === 'PUT') {
        if (sha256Hex(rawBody) !== sha) return reply(422, {});
        staged.set(`${owner}:${sha}`, rawBody);
        return reply(200, { sha256: sha, size: rawBody.length });
      }
      if (req.method === 'GET') {
        const rec = req.headers['bot-delivery-receipt'];
        if (typeof rec !== 'string') return reply(403, {});
        const intent = intents.get(rec);
        if (!intent || intent.body.file_sha256 !== sha) return reply(403, {});
        const bytes = storedFiles.get(`${owner}:${sha}`);
        if (!bytes) return reply(404, {});
        res.writeHead(200, { 'content-length': String(bytes.length) });
        res.end(bytes);
        return;
      }
    }

    if (url.pathname === '/api/bot-channel/v1') {
      const op = JSON.parse(rawBody.toString('utf8'));
      if (op.action === 'authorize') {
        const owner = bindings.get(op.subject);
        return reply(owner && !disabled.has(owner) ? 200 : 403, {});
      }
      if (op.action === 'inbound') {
        const owner = bindings.get(op.subject);
        if (!owner || disabled.has(owner)) return reply(403, {});
        const ownerDir = join(runtimeDir, 'files', sha256Hex(owner));
        await mkdir(ownerDir, { recursive: true, mode: 0o700 });
        for (const f of op.files ?? []) {
          const bytes = staged.get(`${owner}:${f.sha256}`);
          if (!bytes) return reply(400, {});
          storedFiles.set(`${owner}:${f.sha256}`, bytes);
          await writeFile(join(ownerDir, f.sha256), bytes);
          staged.delete(`${owner}:${f.sha256}`);
        }
        const hash = createHash('sha256')
          .update(JSON.stringify([issuer, botId, op.subject, op.platformId]))
          .digest();
        hash[6] = (hash[6] & 15) | 0x80;
        hash[8] = (hash[8] & 63) | 0x80;
        const hex = hash.toString('hex');
        const requestUuid = [
          hex.slice(0, 8),
          hex.slice(8, 12),
          hex.slice(12, 16),
          hex.slice(16, 20),
          hex.slice(20, 32),
        ].join('-');
        const result = await callHost({
          owner,
          op: {
            action: 'inbound',
            request: requestUuid,
            text: op.text,
            files: op.files,
          },
          config: botProfile,
          route: { source: 'channel', issuer, subject: op.subject },
        });
        return reply(result.status, result.body);
      }
      if (op.action === 'next') {
        const result = await callHost({
          owner: 'channel',
          op: { action: 'claim', issuer },
        });
        const item = result.body?.delivery;
        if (!item) return reply(200, { delivery: null });
        const owner = bindings.get(item.subject);
        if (!owner || owner !== item.owner) {
          await callHost({
            owner: 'channel',
            op: {
              action: 'receipt',
              receipt: item.receipt,
              state: 'not_dispatched',
            },
          });
          return reply(200, { delivery: null });
        }
        const textSize = Buffer.byteLength(item.text, 'utf8');
        const textSha =
          textSize > 0 ? sha256Hex(Buffer.from(item.text, 'utf8')) : null;
        const fileSha = item.file?.sha256 ?? null;
        const fileSize = item.file?.size ?? null;
        const nameSha = item.file
          ? sha256Hex(Buffer.from(item.file.name, 'utf8'))
          : null;
        const size = textSize + (fileSize ?? 0);
        const combinedSha = sha256Hex(
          JSON.stringify({
            file_sha256: fileSha,
            file_size: fileSize,
            name_sha256: nameSha,
            text_sha256: textSha,
            text_size: textSize,
          }),
        );
        const intentObj = {
          sha256: combinedSha,
          size,
          text_sha256: textSha,
          text_size: textSize,
          file_sha256: fileSha,
          file_size: fileSize,
          name_sha256: nameSha,
        };
        const intentRecord = {
          digest: sha256Hex(JSON.stringify(intentObj)),
          body: {
            ...intentObj,
            receipt: item.receipt,
            member: owner,
          },
        };
        intents.set(item.receipt, intentRecord);
        return reply(200, {
          delivery: {
            subject: item.subject,
            receipt: item.receipt,
            role: item.role,
            text: item.text,
            sha256: combinedSha,
            size,
            file: item.file ?? null,
            intent: intentObj,
          },
        });
      }
      if (op.action === 'receipt') {
        const intent = intents.get(op.receipt);
        if (!intent) return reply(404, {});
        receipts.set(op.receipt, {
          body: {
            intent: intent.digest,
            receipt: op.receipt,
            outcome: op.state,
            acknowledgment: op.acknowledgment ?? null,
          },
          member: intent.body.member,
        });
        const resHost = await callHost({
          owner: 'channel',
          op: { action: 'receipt', receipt: op.receipt, state: op.state },
        });
        return reply(resHost.status, resHost.body);
      }
    }
    return reply(404, {});
  });

  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const url = 'http://127.0.0.1:' + server.address().port;
  return {
    mode: 'mock',
    url,
    a,
    b,
    deps: { config: { dataDir } },
    logs: [],
    setBotProfile(profile) {
      botProfile = profile;
    },
    disableMember(principalId) {
      disabled.add(principalId);
    },
    getIntents(principalId) {
      return [...intents.values()].filter((i) => i.body.member === principalId);
    },
    getReceipt(receiptId) {
      return receipts.get(receiptId);
    },
    async close() {
      await new Promise((ok) => server.close(ok));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

const hubSourceDir = process.argv[2];
let hub;
let realHubHelpers;
const identity = {
  application: 'app',
  tenant: 'test-tenant',
  secret: 'local-identity',
};
let channel;

if (hubSourceDir) {
  const moduleAt = (p) => import(pathToFileURL(resolve(hubSourceDir, p)).href);
  const { createTestServer } = await moduleAt('hub/server/testing.ts');
  const {
    setBotProfile,
    newChannel,
    channelProfileName,
    identityProfileName,
    identityIssuer,
  } = await moduleAt('hub/server/personal-bot.ts');
  const { recordReaderFor } = await moduleAt('hub/server/readers.ts');
  const realHub = await createTestServer();
  const a = await realHub.createUser('合成甲');
  const b = await realHub.createUser('合成乙');
  channel = {
    ...newChannel({
      bot: 'fixture',
      secret: 'local-channel',
      hub: realHub.url,
    }),
    enabled: true,
  };
  realHubHelpers = {
    setBotProfile,
    channelProfileName,
    identityProfileName,
    identityIssuer,
    recordReaderFor,
    realHub,
  };
  hub = {
    mode: 'real',
    url: realHub.url,
    a,
    b,
    deps: realHub.deps,
    logs: realHub.logs,
    async close() {
      await realHub.close();
    },
  };
} else {
  channel = {
    bot: 'fixture',
    secret: 'local-channel',
    token: 'local-channel-token-' + randomUUID(),
    hub: 'http://127.0.0.1:0',
    enabled: true,
  };
  hub = await createMockHub(identity, channel);
  channel.hub = hub.url;
}

const home = join(hub.deps.config.dataDir, 'bot-runtime');
await mkdir(home, { recursive: true, mode: 0o700 });
const stop = await serveRemoteBot(home);
const inputs = [];
const sent = [];
const model = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks)).messages.at(-1).content;
  inputs.push(input);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [
    [{ role: 'assistant', content: 'reply ' + input }, null],
    [{}, 'stop'],
  ])
    res.write(
      'data: ' +
        JSON.stringify({
          id: 'demo',
          model: 'model',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n',
    );
  res.end('data: [DONE]\n\n');
});
await new Promise((ok) => model.listen(0, '127.0.0.1', ok));
const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(ws, 'listening');
const sockets = [];
ws.on('connection', (socket) => {
  sockets.push(socket);
  socket.on('message', (bytes) => {
    const frame = JSON.parse(bytes);
    if (frame.cmd === 'aibot_send_msg') sent.push(frame.body);
    socket.send(
      JSON.stringify({ headers: frame.headers, errcode: 0, errmsg: 'ok' }),
    );
  });
});

const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const adapter = new ChannelSession(
  home,
  (c) =>
    new WSClient({
      botId: c.bot,
      secret: c.secret,
      wsUrl: 'ws://127.0.0.1:' + ws.address().port,
      logger: quiet,
      maxAuthFailureAttempts: 0,
    }),
  async (url, options) => {
    if (new URL(url).origin === hub.url) return fetch(url, options);
    if (new URL(url).pathname.endsWith('/gettoken'))
      return Response.json({
        errcode: 0,
        access_token: 'synthetic',
        expires_in: 7200,
      });
    const id = JSON.parse(options.body).open_userid_list[0];
    return Response.json({
      errcode: 0,
      userid_list: [{ open_userid: id, userid: 'bound-' + id }],
    });
  },
);
const app = async (member, body) => {
  const reply = await fetch(hub.url + '/api/bot/v1', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + member.token,
      'content-type': 'application/json',
      'Bot-Client-Version': VERSION,
    },
    body: JSON.stringify(body),
  });
  return { status: reply.status, data: await reply.json() };
};
async function until(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await adapter.flush();
    if (await check()) return;
    await wait(25);
  }
  throw Error(
    'channel condition did not finish (' +
      JSON.stringify({
        requests: inputs.length,
        deliveries: sent.length,
        log: hub.logs.slice(-2),
      }) +
      ')',
  );
}
const frame = (sender, id, content, kind = 'single') =>
  JSON.stringify({
    cmd: 'aibot_msg_callback',
    headers: { req_id: id },
    body: {
      aibotid: channel.bot,
      msgid: id,
      msgtype: 'text',
      chattype: kind,
      from: { userid: sender },
      text: { content },
    },
  });
try {
  const modelProfile = {
    name: 'Test',
    model: 'model',
    endpoint: 'http://127.0.0.1:' + model.address().port + '/v1',
    protocol: 'openai',
    key: 'fixture-model-key',
  };
  if (realHubHelpers) {
    const {
      realHub,
      setBotProfile,
      identityProfileName,
      channelProfileName,
      identityIssuer,
    } = realHubHelpers;
    await setBotProfile(realHub.records.vault, modelProfile);
    await realHub.records.vault.put(
      identityProfileName,
      JSON.stringify(identity),
    );
    await realHub.records.vault.put(
      channelProfileName,
      JSON.stringify(channel),
    );
    await realHub.records.principals.bindExternalIdentity(
      hub.a.principal,
      identityIssuer(identity.tenant),
      'bound-a',
    );
    await realHub.records.principals.bindExternalIdentity(
      hub.b.principal,
      identityIssuer(identity.tenant),
      'bound-b',
    );
  } else {
    hub.setBotProfile(modelProfile);
  }
  adapter.configure(channel, identity);
  await until(() => sockets.length === 1);
  const ca = (await app(hub.a, { action: 'discover' })).data.current,
    cb = (await app(hub.b, { action: 'discover' })).data.current;
  sockets[0].send(frame('a', 'p1', 'first'));
  sockets[0].send(frame('a', 'p1', 'first'));
  sockets[0].send(frame('a', 'p2', 'ignored', 'group'));
  sockets[0].send(frame('b', 'p3', 'second'));
  await until(() => sent.length === 2);
  assert.deepEqual([...inputs].sort(), ['first', 'second']);
  assert.equal(
    (await app(hub.a, { action: 'history', conversation: cb, after: 0 }))
      .status,
    404,
  );
  const hist = await app(hub.a, {
    action: 'history',
    conversation: ca,
    after: 0,
  });
  assert.deepEqual(
    hist.data.events.map((e) => e.text),
    ['first', 'reply first'],
  );
  assert.equal(
    (
      await app(hub.a, {
        action: 'send',
        conversation: ca,
        request: randomUUID(),
        text: 'desktop',
      })
    ).status,
    200,
  );
  await until(() => sent.length === 4);
  const content = sent.map((x) => x.markdown.content);
  assert.equal(content.filter((x) => x === '客户端消息：\ndesktop').length, 1);
  assert.equal(content.filter((x) => x === 'reply desktop').length, 1);
  assert.equal(sent.filter((x) => x.chatid === 'b').length, 1);
  if (realHubHelpers) {
    const { realHub, recordReaderFor } = realHubHelpers;
    const intents = await realHub.records.store.findMany({
      kind: 'action',
      key: 'chat.notification.owner',
      values: [hub.a.principal.id],
    });
    assert.equal(intents.length, 3);
    for (const intent of intents) {
      const receipt = await realHub.records.store.getByKey(
        'effect',
        'chat-receipt:' + intent.body.receipt,
      );
      assert.equal(receipt.body.intent, intent.digest);
      assert.equal(receipt.body.outcome, 'issued');
      assert.equal(receipt.body.acknowledgment.code, 0);
      for (const record of [intent, receipt]) {
        assert.ok(
          await recordReaderFor(
            realHub.records,
            realHub.deps.runs,
            hub.a.principal,
          ).read(record.digest),
        );
        assert.equal(
          await recordReaderFor(
            realHub.records,
            realHub.deps.runs,
            hub.b.principal,
          ).read(record.digest),
          null,
        );
      }
    }
    await realHub.records.principals.setDisabled(
      realHub.admin.principal,
      hub.a.principal.id,
      true,
    );
  } else {
    const intents = hub.getIntents(hub.a.principal.id);
    assert.equal(intents.length, 3);
    for (const intent of intents) {
      const receipt = hub.getReceipt(intent.body.receipt);
      assert.equal(receipt.body.intent, intent.digest);
      assert.equal(receipt.body.outcome, 'issued');
      assert.equal(receipt.body.acknowledgment.code, 0);
    }
    hub.disableMember(hub.a.principal.id);
  }
  sockets[0].send(frame('a', 'p4', 'revoked'));
  await until(
    () =>
      adapter.db
        .prepare("SELECT count(*) AS n FROM batch WHERE state='refused'")
        .get().n === 1,
  );
  assert.equal(inputs.includes('revoked'), false);
  console.log(
    `Paired synthetic check passed (${hub.mode}): official SDK private frames, two members, group exclusion, deduplication, shared history, scoped outbound receipts and disabled account.`,
  );
} finally {
  await adapter.close();
  for (const s of sockets) s.terminate();
  await new Promise((ok) => ws.close(ok));
  await new Promise((ok) => model.close(ok));
  await stop();
  await hub.close();
}

// Exercise the official WebSocket client and a matching synthetic Hub checkout.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { WSClient } from '@wecom/aibot-node-sdk';
import { ChannelSession } from './adapter.ts';
import { serveRemoteBot } from '../../dist/remote_bot_service.js';
import { VERSION } from '../../dist/version.js';
const moduleAt = (p) => import(pathToFileURL(resolve(process.argv[2], p)));
const { createTestServer } = await moduleAt('hub/server/testing.ts');
const {
  setBotProfile,
  newChannel,
  channelProfileName,
  identityProfileName,
  identityIssuer,
} = await moduleAt('hub/server/personal-bot.ts');
const { recordReaderFor } = await moduleAt('hub/server/readers.ts');
const hub = await createTestServer(),
  a = await hub.createUser('合成甲'),
  b = await hub.createUser('合成乙');
const home = join(hub.deps.config.dataDir, 'bot-runtime');
const stop = await serveRemoteBot(home);
const inputs = [],
  sent = [];
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
const identity = {
  application: 'app',
  tenant: 'test-tenant',
  secret: 'local-identity',
};
const channel = {
  ...newChannel({ bot: 'fixture', secret: 'local-channel', hub: hub.url }),
  enabled: true,
};
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
      'circle-version': VERSION,
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
  await setBotProfile(hub.records.vault, {
    name: 'Test',
    model: 'model',
    endpoint: 'http://127.0.0.1:' + model.address().port + '/v1',
    protocol: 'openai',
    key: 'fixture-model-key',
  });
  await hub.records.vault.put(identityProfileName, JSON.stringify(identity));
  await hub.records.vault.put(channelProfileName, JSON.stringify(channel));
  await hub.records.principals.bindExternalIdentity(
    a.principal,
    identityIssuer(identity.tenant),
    'bound-a',
  );
  await hub.records.principals.bindExternalIdentity(
    b.principal,
    identityIssuer(identity.tenant),
    'bound-b',
  );
  adapter.configure(channel, identity);
  await until(() => sockets.length === 1);
  const ca = (await app(a, { action: 'discover' })).data.current,
    cb = (await app(b, { action: 'discover' })).data.current;
  sockets[0].send(frame('a', 'p1', 'first'));
  sockets[0].send(frame('a', 'p1', 'first'));
  sockets[0].send(frame('a', 'p2', 'ignored', 'group'));
  sockets[0].send(frame('b', 'p3', 'second'));
  await until(() => sent.length === 2);
  assert.deepEqual(inputs.sort(), ['first', 'second']);
  assert.equal(
    (await app(a, { action: 'history', conversation: cb, after: 0 })).status,
    404,
  );
  const hist = await app(a, { action: 'history', conversation: ca, after: 0 });
  assert.deepEqual(
    hist.data.events.map((e) => e.text),
    ['first', 'reply first'],
  );
  assert.equal(
    (
      await app(a, {
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
  assert.equal(content.filter((x) => x === '来自 Mac：\ndesktop').length, 1);
  assert.equal(content.filter((x) => x === 'reply desktop').length, 1);
  assert.equal(sent.filter((x) => x.chatid === 'b').length, 1);
  const intents = await hub.records.store.findMany({
    kind: 'action',
    key: 'chat.notification.owner',
    values: [a.principal.id],
  });
  assert.equal(intents.length, 3);
  for (const intent of intents) {
    const receipt = await hub.records.store.getByKey(
      'effect',
      'chat-receipt:' + intent.body.receipt,
    );
    assert.equal(receipt.body.intent, intent.digest);
    assert.equal(receipt.body.outcome, 'issued');
    assert.equal(receipt.body.acknowledgment.code, 0);
    for (const record of [intent, receipt]) {
      assert.ok(
        await recordReaderFor(hub.records, hub.deps.runs, a.principal).read(
          record.digest,
        ),
      );
      assert.equal(
        await recordReaderFor(hub.records, hub.deps.runs, b.principal).read(
          record.digest,
        ),
        null,
      );
    }
  }
  await hub.records.principals.setDisabled(
    hub.admin.principal,
    a.principal.id,
    true,
  );
  sockets[0].send(frame('a', 'p4', 'revoked'));
  await until(
    () =>
      adapter.db
        .prepare("SELECT count(*) AS n FROM batch WHERE state='refused'")
        .get().n === 1,
  );
  assert.equal(inputs.includes('revoked'), false);
  console.log(
    'Paired synthetic check passed: official SDK private frames, two members, group exclusion, deduplication, shared Mac history, scoped outbound receipts and disabled account.',
  );
} finally {
  await adapter.close();
  for (const s of sockets) s.terminate();
  await new Promise((ok) => ws.close(ok));
  await new Promise((ok) => model.close(ok));
  await stop();
  await hub.close();
}

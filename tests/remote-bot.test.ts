import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  attachFiles,
  BotError,
  maskKey,
  MAX_HISTORY_TEXT_BYTES,
  MAX_REPLY_DELIVERY_CHARS,
  RemoteBot,
  remoteCompletion,
  splitReplyText,
  type ChatRoute,
  type RemoteModel,
} from '../src/remote_bot.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}
const config: RemoteModel = {
  name: 'Synthetic',
  protocol: 'openai',
  endpoint: 'http://127.0.0.1',
  model: 'demo',
  key: 'fixture-key',
};
test('first discovery, owner isolation, replay, streamed secret masking and durable history', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-'));
  const gate = deferred(),
    started = deferred();
  let calls = 0;
  let host = new RemoteBot(
    home,
    async (_home, _config, _messages, _signal, token) => {
      calls++;
      token('hello fixture-');
      started.resolve();
      await gate.promise;
      token('key');
      return 'hello fixture-key';
    },
  );
  try {
    const discover = (owner: string) =>
      host.run(owner, { action: 'discover' }) as {
        id: string;
        current: string;
      };
    const a = discover('first'),
      b = discover('second');
    assert.notEqual(a.id, b.id);
    assert.deepEqual(discover('first'), a);
    const request = randomUUID();
    const input = {
      action: 'send' as const,
      conversation: a.current,
      request,
      text: 'hello',
    };
    const history = {
      action: 'history' as const,
      conversation: a.current,
      after: 0,
    };
    assert.throws(() => host.run('second', input, config));
    assert.throws(() => host.run('second', history));
    host.run('first', input, config);
    await started.promise;
    assert.deepEqual(host.run('first', input, config), { request });
    assert.throws(() =>
      host.run('first', { ...input, text: 'changed' }, config),
    );
    assert.equal(calls, 1);
    assert.equal(
      (host.run('first', history) as { active: { draft: string } }).active
        .draft,
      'hello ',
    );
    gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = host.run('first', history) as {
      events: { cursor: number; text: string }[];
    };
    assert.deepEqual(
      result.events.map((e) => e.text),
      ['hello', 'hello [redacted]'],
    );
    assert.equal(
      (
        host.run('first', { ...history, after: result.events[0]!.cursor }) as {
          events: unknown[];
        }
      ).events.length,
      1,
    );
    const fresh = { action: 'new' as const, request: randomUUID() };
    assert.deepEqual(host.run('first', fresh), host.run('first', fresh));
    await host.close();
    host = new RemoteBot(home);
    assert.equal(discover('first').id, a.id);
    assert.deepEqual(host.run('first', history), result);
    assert.deepEqual(host.run('first', input, config), { request });
  } finally {
    gate.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('restart records interrupted calls as unknown and a duplicate does not dispatch', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-'));
  const host = new RemoteBot(home);
  const { current } = host.run('owner', { action: 'discover' }) as {
    current: string;
  };
  await host.close();
  const db = new DatabaseSync(join(home, 'chat.sqlite'));
  const request = randomUUID();
  db.prepare(
    'INSERT INTO event(conversation,id,request,role,text,at) VALUES(?,?,?,?,?,?)',
  ).run(
    current,
    randomUUID(),
    request,
    'user',
    'before crash',
    new Date().toISOString(),
  );
  db.close();
  let calls = 0;
  const restarted = new RemoteBot(home, async () => {
    calls++;
    return 'unexpected';
  });
  try {
    restarted.run(
      'owner',
      { action: 'send', conversation: current, text: 'before crash', request },
      config,
    );
    const history = restarted.run('owner', {
      action: 'history',
      conversation: current,
      after: 0,
    }) as { events: { role: string; text: string }[] };
    assert.equal(calls, 0);
    assert.equal(history.events[1]?.role, 'notice');
    assert.match(history.events[1]!.text, /unknown/);
  } finally {
    await restarted.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('a durable question is resolved only by its member and can receive a verified attachment', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-question-'));
  let calls = 0;
  const model: typeof import('../src/remote_bot.js').remoteCompletion = async (
    _home,
    _config,
    messages,
  ) => {
    calls++;
    if (calls === 1)
      return {
        text: '请补充日志',
        call: {
          id: 'ask-1',
          name: 'question',
          args: { questions: [{ question: '请补充日志' }] },
        },
      };
    assert.ok(
      messages.some((m) => m.role === 'tool' && m.tool_call_id === 'ask-1'),
    );
    assert.match(messages.at(-1)!.content, /example file bytes/);
    return '已收到附件';
  };
  let host = new RemoteBot(home, model);
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: '开始',
      },
      config,
    );
    await new Promise<void>((ok) => setImmediate(ok));
    const history = {
      action: 'history' as const,
      after: 0,
      conversation: current,
    };
    const questionDeadline = Date.now() + 5000;
    while (!host.run('member', history).question) {
      if (Date.now() > questionDeadline)
        throw new Error('question did not open');
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const asked = host.run('member', history);
    assert.ok(typeof asked.question === 'string');
    await host.close();
    host = new RemoteBot(home, model);
    assert.equal(host.run('member', history).question, asked.question);
    const bytes = Buffer.from('example file bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const folder = join(
      home,
      'files',
      createHash('sha256').update('member').digest('hex'),
    );
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, sha256), bytes);
    const answer = {
      action: 'send' as const,
      conversation: current,
      request: randomUUID(),
      replyTo: asked.question,
      text: '',
      files: [{ name: 'log.txt', sha256, size: bytes.length }],
    };
    assert.throws(() => host.run('other', answer, config));
    assert.throws(() =>
      host.run('member', { ...answer, replyTo: randomUUID() }, config),
    );
    host.run('member', answer, config);
    const deadline = Date.now() + 5000;
    while (host.run('member', history).active) {
      if (Date.now() > deadline) throw new Error('answer did not finish');
      await new Promise<void>((ok) => setImmediate(ok));
    }
    const completed = host.run('member', history);
    assert.equal(completed.question, null);
    assert.equal(completed.events?.at(-1)?.text, '已收到附件');
    assert.equal(calls, 2);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('overlapping Mac and channel messages keep their admission order and each reaches the model once', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bot-overlap-'));
  const block = deferred(),
    started = deferred(),
    finished = deferred();
  const calls: string[] = [];
  const host = new RemoteBot(home, async (_home, _config, messages) => {
    const text = messages.at(-1)!.content;
    calls.push(text);
    if (text === 'one') {
      started.resolve();
      await block.promise;
    } else finished.resolve();
    return 'reply ' + text;
  });
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    const route: import('../src/remote_bot.js').ChatRoute = {
      source: 'channel',
      issuer: 'test',
      subject: 'member',
    };
    const first = randomUUID(),
      second = randomUUID();
    host.inbound('member', first, 'one', config, route);
    await started.promise;
    const mac = {
      action: 'send' as const,
      conversation: current,
      request: second,
      text: 'two',
    };
    assert.equal(host.run('member', mac, config).queued, true);
    assert.equal(host.run('member', mac, config).queued, true);
    assert.deepEqual(calls, ['one']);
    block.resolve();
    await finished.promise;
    await new Promise<void>((ok) => setImmediate(ok));
    const history = host.run('member', {
      action: 'history',
      conversation: current,
      after: 0,
    });
    assert.deepEqual(
      history.events?.map((x) => x.text),
      ['one', 'reply one', 'two', 'reply two'],
    );
    assert.deepEqual(calls, ['one', 'two']);
    assert.deepEqual(history.queued, []);
  } finally {
    block.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('inbound help, new conversation and stop commands stay idempotent without calling the model', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bot-commands-'));
  let calls = 0;
  const block = deferred(),
    started = deferred();
  const host = new RemoteBot(
    home,
    async (_home, _config, _messages, signal) => {
      calls++;
      started.resolve();
      await Promise.race([
        block.promise,
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
      ]);
      signal.throwIfAborted();
      return 'finished';
    },
  );
  const route: import('../src/remote_bot.js').ChatRoute = {
    source: 'channel',
    issuer: 'test',
    subject: 'member',
  };
  try {
    const first = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    const helpId = randomUUID();
    host.inbound('member', helpId, 'help', config, route);
    host.inbound('member', helpId, 'help', config, route);
    const afterHelp = host.run('member', {
      action: 'history',
      conversation: first.current,
      after: 0,
    }) as { events: { role: string; text: string }[] };
    assert.equal(afterHelp.events.length, 1);
    assert.equal(afterHelp.events[0]?.role, 'notice');
    assert.match(afterHelp.events[0]!.text, /personal bot/);

    host.inbound('member', randomUUID(), 'hello', config, route);
    await started.promise;
    host.inbound('member', randomUUID(), '/stop', config, route);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const afterStop = host.run('member', {
      action: 'history',
      conversation: first.current,
      after: 0,
    }) as { events: { role: string; text: string }[] };
    assert.ok(
      afterStop.events.some(
        (e) => e.role === 'notice' && e.text.includes('stop'),
      ),
    );

    const newId = randomUUID();
    host.inbound('member', newId, '/new', config, route);
    const second = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    assert.notEqual(second.current, first.current);
    const afterNew = host.run('member', {
      action: 'history',
      conversation: second.current,
      after: 0,
    }) as { events: { role: string; text: string }[] };
    assert.deepEqual(
      afterNew.events.map((e) => e.text),
      ['started a new conversation'],
    );
    assert.equal(calls, 1);
  } finally {
    block.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('empty model credential is rejected up front and empty-key masking is a no-op', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-empty-key-'));
  let calls = 0;
  const host = new RemoteBot(home, async () => {
    calls++;
    return 'unexpected';
  });
  const emptyKey: RemoteModel = { ...config, key: '' };
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    assert.throws(
      () =>
        host.run(
          'member',
          {
            action: 'send',
            conversation: current,
            request: randomUUID(),
            text: 'hello',
          },
          emptyKey,
        ),
      (error: unknown) =>
        error instanceof BotError &&
        error.status === 503 &&
        error.code === 'bot_not_enabled' &&
        error.message === 'bot model is not enabled',
    );
    assert.throws(
      () =>
        host.inbound('member', randomUUID(), 'hello', emptyKey, {
          source: 'channel',
          issuer: 'test',
          subject: 'member',
        }),
      (error: unknown) =>
        error instanceof BotError &&
        error.status === 503 &&
        error.code === 'bot_not_enabled' &&
        error.message === 'bot model is not enabled',
    );
    await assert.rejects(
      remoteCompletion(
        home,
        emptyKey,
        [{ id: '1', role: 'user', content: 'hello' }],
        new AbortController().signal,
        () => {},
      ),
      (error: unknown) =>
        error instanceof BotError &&
        error.status === 503 &&
        error.code === 'bot_not_enabled' &&
        error.message === 'bot model is not enabled',
    );
    assert.equal(calls, 0);
    assert.equal(maskKey('plain text', ''), 'plain text');
    assert.equal(
      maskKey('token=fixture-key', 'fixture-key'),
      'token=[redacted]',
    );
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('queued messages read latest active model config at dequeue and skip model with notice when disabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-c4-'));
  const block = deferred();
  const started = deferred();
  const seen: Array<{ text: string; key: string; endpoint: string }> = [];
  const host = new RemoteBot(home, async (_home, cfg, messages) => {
    const text = String(messages.at(-1)?.content ?? '');
    seen.push({ text, key: cfg.key, endpoint: cfg.endpoint });
    if (text === 'M1') {
      started.resolve();
      await block.promise;
    }
    return 'reply ' + text;
  });
  const cfg1: RemoteModel = {
    ...config,
    endpoint: 'http://127.0.0.1:1/v1',
    key: 'KEY-OLD',
  };
  const cfg2: RemoteModel = {
    ...config,
    endpoint: 'http://127.0.0.1:2/v1',
    key: 'KEY-NEW',
  };
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'M1',
      },
      cfg1,
    );
    await started.promise;
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'M2',
      },
      cfg1,
    );
    (host as unknown as { configure: (c: RemoteModel) => void }).configure(
      cfg2,
    );
    block.resolve();
    const deadline = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation: current,
          after: 0,
        }) as { queued: unknown[]; active: unknown }
      ).queued.length > 0 ||
      (
        host.run('member', {
          action: 'history',
          conversation: current,
          after: 0,
        }) as { active: unknown }
      ).active
    ) {
      if (Date.now() > deadline)
        throw new Error('rotation queue did not drain');
      await new Promise<void>((ok) => setImmediate(ok));
    }
    assert.deepEqual(seen, [
      { text: 'M1', key: 'KEY-OLD', endpoint: cfg1.endpoint },
      { text: 'M2', key: 'KEY-NEW', endpoint: cfg2.endpoint },
    ]);

    const block2 = deferred();
    const started2 = deferred();
    const callsAfterDisable: string[] = [];
    const host2 = new RemoteBot(home, async (_home, _cfg, messages) => {
      const text = String(messages.at(-1)?.content ?? '');
      callsAfterDisable.push(text);
      if (text === 'D1') {
        started2.resolve();
        await block2.promise;
      }
      return 'reply ' + text;
    });
    try {
      const next = host2.run('member', {
        action: 'new',
        request: randomUUID(),
      }) as { conversation: string };
      host2.run(
        'member',
        {
          action: 'send',
          conversation: next.conversation,
          request: randomUUID(),
          text: 'D1',
        },
        cfg2,
      );
      await started2.promise;
      host2.run(
        'member',
        {
          action: 'send',
          conversation: next.conversation,
          request: randomUUID(),
          text: 'D2',
        },
        cfg2,
      );
      (host2 as unknown as { disable: () => void }).disable();
      block2.resolve();
      const deadline2 = Date.now() + 5000;
      while (
        (
          host2.run('member', {
            action: 'history',
            conversation: next.conversation,
            after: 0,
          }) as { queued: unknown[]; active: unknown }
        ).queued.length > 0 ||
        (
          host2.run('member', {
            action: 'history',
            conversation: next.conversation,
            after: 0,
          }) as { active: unknown }
        ).active
      ) {
        if (Date.now() > deadline2)
          throw new Error('disabled queue did not drain');
        await new Promise<void>((ok) => setImmediate(ok));
      }
      assert.deepEqual(callsAfterDisable, ['D1']);
      const hist = host2.run('member', {
        action: 'history',
        conversation: next.conversation,
        after: 0,
      }) as { events: Array<{ role: string; text: string }> };
      const notice = hist.events.at(-1);
      assert.equal(notice?.role, 'notice');
      assert.match(notice?.text ?? '', /disabled/);
      assert.doesNotMatch(notice?.text ?? '', /[\u4e00-\u9fff]/);
    } finally {
      block2.resolve();
      await host2.close();
    }
  } finally {
    block.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('remoteCompletion preserves model_empty_reply and model_output_blocked BotError codes and emits lowercase English errors', async () => {
  const { createServer } = await import('node:http');
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-c16-c17-'));
  let mode: 'empty' | 'key_question' | 'auth' | 'missing' = 'empty';
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    if (mode === 'auth') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'bad key' } }));
      return;
    }
    if (mode === 'missing') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { code: 'model_not_found', message: 'nope' } }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null) =>
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'x',
            object: 'chat.completion.chunk',
            model: 'm',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );
    if (mode === 'empty') {
      send({ role: 'assistant', content: '   ' }, null);
      send({}, 'stop');
    } else {
      send(
        {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'c1',
              type: 'function',
              function: {
                name: 'question',
                arguments: JSON.stringify({
                  questions: [{ question: 'leak ' + config.key }],
                }),
              },
            },
          ],
        },
        null,
      );
      send({}, 'tool_calls');
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as { port: number }).port;
  const endpointConfig: RemoteModel = {
    ...config,
    endpoint: `http://127.0.0.1:${port}/v1`,
  };
  try {
    mode = 'empty';
    await assert.rejects(
      remoteCompletion(
        home,
        endpointConfig,
        [{ id: '1', role: 'user', content: 'hi' }],
        new AbortController().signal,
        () => {},
      ),
      (err: unknown) =>
        err instanceof BotError &&
        err.status === 502 &&
        (err as unknown as { code: string }).code === 'model_empty_reply' &&
        err.noticeCode === 'model_empty_reply' &&
        !/[\u4e00-\u9fff]/.test(err.message),
    );
    mode = 'key_question';
    await assert.rejects(
      remoteCompletion(
        home,
        endpointConfig,
        [{ id: '1', role: 'user', content: 'hi' }],
        new AbortController().signal,
        () => {},
      ),
      (err: unknown) =>
        err instanceof BotError &&
        err.status === 502 &&
        (err as unknown as { code: string }).code === 'model_output_blocked' &&
        err.noticeCode === 'model_credentials_blocked' &&
        !/[\u4e00-\u9fff]/.test(err.message),
    );
    mode = 'auth';
    await assert.rejects(
      remoteCompletion(
        home,
        endpointConfig,
        [{ id: '1', role: 'user', content: 'hi' }],
        new AbortController().signal,
        () => {},
      ),
      (err: unknown) =>
        err instanceof BotError &&
        err.status === 422 &&
        (err as unknown as { code: string }).code === 'model_auth_failed' &&
        err.noticeCode === 'model_auth_failed' &&
        !/[\u4e00-\u9fff]/.test(err.message),
    );
    mode = 'missing';
    await assert.rejects(
      remoteCompletion(
        home,
        endpointConfig,
        [{ id: '1', role: 'user', content: 'hi' }],
        new AbortController().signal,
        () => {},
      ),
      (err: unknown) =>
        err instanceof BotError &&
        err.status === 422 &&
        (err as unknown as { code: string }).code === 'model_not_found' &&
        err.noticeCode === 'model_id_unavailable' &&
        !/[\u4e00-\u9fff]/.test(err.message),
    );
    await new Promise<void>((ok) => server.close(() => ok()));
    await assert.rejects(
      remoteCompletion(
        home,
        endpointConfig,
        [{ id: '1', role: 'user', content: 'hi' }],
        AbortSignal.timeout(150),
        () => {},
      ),
      (err: unknown) =>
        err instanceof BotError &&
        err.status === 503 &&
        err.code === 'model_unreachable' &&
        err.noticeCode === 'model_unreachable' &&
        !/[\u4e00-\u9fff]/.test(err.message),
    );

    const botGate = deferred();
    const botStarted = deferred();
    const botHost = new RemoteBot(home, async () => {
      botStarted.resolve();
      await botGate.promise;
      return 'ok';
    });
    try {
      const { current } = botHost.run('member', { action: 'discover' }) as {
        current: string;
      };
      assert.throws(
        () =>
          botHost.run('member', {
            action: 'history',
            conversation: randomUUID(),
            after: 0,
          }),
        (err: unknown) =>
          err instanceof BotError &&
          err.status === 404 &&
          err.code === 'conversation_not_found' &&
          !/[\u4e00-\u9fff]/.test(err.message),
      );
      assert.throws(
        () =>
          botHost.run(
            'member',
            {
              action: 'send',
              conversation: current,
              request: randomUUID(),
              text: 'contains ' + config.key,
            },
            config,
          ),
        (err: unknown) =>
          err instanceof BotError &&
          err.status === 400 &&
          err.code === 'invalid_request' &&
          !/[\u4e00-\u9fff]/.test(err.message),
      );
      botHost.run(
        'member',
        {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'first',
        },
        config,
      );
      await botStarted.promise;
      for (let i = 0; i < 64; i++) {
        botHost.run(
          'member',
          {
            action: 'send',
            conversation: current,
            request: randomUUID(),
            text: 'q-' + i,
          },
          config,
        );
      }
      assert.throws(
        () =>
          botHost.run(
            'member',
            {
              action: 'send',
              conversation: current,
              request: randomUUID(),
              text: 'overflow',
            },
            config,
          ),
        (err: unknown) =>
          err instanceof BotError &&
          err.status === 429 &&
          err.code === 'bot_busy' &&
          !/[\u4e00-\u9fff]/.test(err.message),
      );
      botGate.resolve();
    } finally {
      botGate.resolve();
      await botHost.close();
    }
  } finally {
    if (server.listening)
      await new Promise<void>((ok) => server.close(() => ok()));
    await rm(home, { recursive: true, force: true });
  }
});

test('multi-turn RemoteBot history replays prior turn attachments across turns', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-c19-'));
  const seenTurns: Array<Array<{ role: string; content: string }>> = [];
  const host = new RemoteBot(home, async (_home, _cfg, messages) => {
    seenTurns.push(
      messages.map((m) => ({ role: m.role, content: String(m.content) })),
    );
    return 'ok';
  });
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    const bytes = Buffer.from('SECRET-LOOKING-FILE-CONTENT');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const folder = join(
      home,
      'files',
      createHash('sha256').update('member').digest('hex'),
    );
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(join(folder, sha256), bytes);
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'please read this',
        files: [{ name: 'notes.txt', sha256, size: bytes.length }],
      },
      config,
    );
    const deadline1 = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation: current,
          after: 0,
        }) as { active: unknown }
      ).active
    ) {
      if (Date.now() > deadline1) throw new Error('turn 1 did not finish');
      await new Promise<void>((ok) => setImmediate(ok));
    }
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'what did the file say?',
      },
      config,
    );
    const deadline2 = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation: current,
          after: 0,
        }) as { active: unknown }
      ).active
    ) {
      if (Date.now() > deadline2) throw new Error('turn 2 did not finish');
      await new Promise<void>((ok) => setImmediate(ok));
    }
    assert.equal(seenTurns.length, 2);
    assert.match(seenTurns[1]![0]!.content, /SECRET-LOOKING-FILE-CONTENT/);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test(
  'serveRemoteBot rejects Unix socket paths exceeding platform sun_path byte limit',
  { skip: process.platform === 'win32' },
  async () => {
    const { mkdir } = await import('node:fs/promises');
    const { serveRemoteBot } = await import('../src/remote_bot_service.js');
    const base = await mkdtemp(join(tmpdir(), 'remote-bot-c18-'));
    const maxBytes = process.platform === 'darwin' ? 103 : 107;
    const pad = Math.max(
      10,
      maxBytes - Buffer.byteLength(join(base, 'host.sock'), 'utf8') + 5,
    );
    const longDir = join(base, 'x'.repeat(pad));
    await mkdir(longDir, { recursive: true, mode: 0o700 });
    const sockBytes = Buffer.byteLength(join(longDir, 'host.sock'), 'utf8');
    try {
      await assert.rejects(
        serveRemoteBot(longDir),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes(String(sockBytes)) &&
          err.message.includes(String(maxBytes)) &&
          !/EINVAL/.test(err.message),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);

test(
  'serveRemoteBot accepts EffectOutcomeSchema receipt states and enforces SemVer 2.0.0 version compatibility',
  { skip: process.platform === 'win32' },
  async () => {
    const { request } = await import('node:http');
    const { serveRemoteBot } = await import('../src/remote_bot_service.js');
    const { VERSION } = await import('../src/version.js');
    const dir = await mkdtemp(join(tmpdir(), 'remote-bot-svc-wire-'));
    const stop = await serveRemoteBot(dir);
    const call = (frame: unknown) =>
      new Promise<{ status: number; body: Record<string, unknown> }>(
        (ok, fail) => {
          const payload = Buffer.from(JSON.stringify(frame));
          const req = request(
            {
              socketPath: join(dir, 'host.sock'),
              path: '/chat',
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': payload.length,
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
          req.end(payload);
        },
      );
    try {
      const [major, minor] = VERSION.split('.');
      // SemVer 2.0.0: pre-release & build metadata on same major.minor succeed; invalid SemVer -> 400; major.minor mismatch -> 409.
      assert.equal(
        (
          await call({
            owner: 'member',
            op: { action: 'discover' },
            version: `${major}.${minor}.9-rc.1+build.42`,
          })
        ).status,
        200,
      );
      const badSemver = await call({
        owner: 'member',
        op: { action: 'discover' },
        version: '01.18.1',
      });
      assert.equal(badSemver.status, 400);
      assert.equal(badSemver.body.code, 'invalid_version');
      const mismatchSemver = await call({
        owner: 'member',
        op: { action: 'discover' },
        version: `${major}.${Number(minor) + 1}.0`,
      });
      assert.equal(mismatchSemver.status, 409);
      assert.equal(mismatchSemver.body.code, 'version_mismatch');
      assert.equal(
        mismatchSemver.body.message,
        'client and host version mismatch',
      );
      const missingOwner = await call({
        op: { action: 'discover' },
      });
      assert.equal(missingOwner.status, 400);
      assert.equal(missingOwner.body.code, 'invalid_request');
      assert.equal(missingOwner.body.message, 'missing owner or operation');
      const missingOp = await call({ owner: 'member' });
      assert.equal(missingOp.status, 400);
      assert.equal(missingOp.body.code, 'invalid_request');
      assert.equal(missingOp.body.message, 'missing owner or operation');

      const { current } = (
        await call({ owner: 'member', op: { action: 'discover' } })
      ).body as { current: string };
      // Verify EffectOutcomeSchema receipt states ('issued', 'target_rejected', 'not_dispatched') map cleanly.
      const { RemoteBot } = await import('../src/remote_bot.js');
      void RemoteBot;
      const fakeId = randomUUID();
      const resIssued = await call({
        owner: 'channel',
        op: { action: 'receipt', receipt: fakeId, state: 'issued' },
      });
      assert.equal(resIssued.status, 200);
      const resRejected = await call({
        owner: 'channel',
        op: {
          action: 'receipt',
          receipt: randomUUID(),
          state: 'target_rejected',
        },
      });
      assert.equal(resRejected.status, 200);
      const resNotDispatched = await call({
        owner: 'channel',
        op: {
          action: 'receipt',
          receipt: randomUUID(),
          state: 'not_dispatched',
        },
      });
      assert.equal(resNotDispatched.status, 200);
      // Malformed JSON triggers host_internal_error with 500 and lowercase English message.
      const raw500 = await new Promise<{
        status: number;
        body: Record<string, unknown>;
      }>((ok, fail) => {
        const badPayload = Buffer.from('{bad-json');
        const req = request(
          {
            socketPath: join(dir, 'host.sock'),
            path: '/chat',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'content-length': badPayload.length,
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
        req.end(badPayload);
      });
      assert.equal(raw500.status, 500);
      assert.equal(raw500.body.code, 'host_internal_error');
      assert.ok(!/[\u4e00-\u9fff]/.test(String(raw500.body.message)));
      assert.ok(current);
    } finally {
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('RemoteBot.claim returns strict Hub deliverySchema shape without internal slot or null file', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-claim-'));
  const host = new RemoteBot(home, async () => 'reply ok');
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    const content = Buffer.from('attachment bytes');
    const sha = createHash('sha256').update(content).digest('hex');
    const ownerDir = join(
      home,
      'files',
      createHash('sha256').update('member').digest('hex'),
    );
    await mkdir(ownerDir, { recursive: true, mode: 0o700 });
    await writeFile(join(ownerDir, sha), content);

    const route: ChatRoute = {
      source: 'client',
      issuer: 'issuer-1',
      subject: 'bound-member',
    };
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'with file',
        files: [{ name: 'note.txt', size: content.length, sha256: sha }],
      },
      config,
      route,
    );
    const deadline = Date.now() + 5000;
    while (
      host.run('member', { action: 'history', conversation: current, after: 0 })
        .active
    ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for reply');
      await new Promise((ok) => setImmediate(ok));
    }

    const first = host.claim('issuer-1');
    assert.ok(first);
    assert.deepEqual(Object.keys(first).sort(), [
      'id',
      'owner',
      'receipt',
      'role',
      'subject',
      'text',
    ]);
    assert.equal('slot' in first, false);
    assert.equal('file' in first, false);
    assert.equal(first.role, 'user');
    assert.equal(first.text, 'with file');

    const second = host.claim('issuer-1');
    assert.ok(second);
    assert.deepEqual(Object.keys(second).sort(), [
      'file',
      'id',
      'owner',
      'receipt',
      'role',
      'subject',
      'text',
    ]);
    assert.equal('slot' in second, false);
    assert.deepEqual(second.file, {
      name: 'note.txt',
      size: content.length,
      sha256: sha,
    });

    const third = host.claim('issuer-1');
    assert.ok(third);
    assert.equal('file' in third, false);
    assert.equal(third.role, 'assistant');
    assert.equal(third.text, 'reply ok');
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('R1: legacy event table migrates code column, and claim/readHistory expose notice codes across all notice paths', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const legacyHome = await mkdtemp(join(tmpdir(), 'remote-bot-r1-legacy-'));
  try {
    const legacyDb = new DatabaseSync(join(legacyHome, 'chat.sqlite'));
    const convId = randomUUID();
    const interruptedReq = randomUUID();
    const queuedReq = randomUUID();
    legacyDb.exec(`
      CREATE TABLE bot(owner TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, current TEXT NOT NULL);
      CREATE TABLE conversation(id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES bot(owner), request TEXT NOT NULL, UNIQUE(owner, request));
      CREATE TABLE event(cursor INTEGER PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversation(id), id TEXT NOT NULL UNIQUE,
        request TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(conversation,request,role));
      CREATE TABLE queued(seq INTEGER PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversation(id),request TEXT NOT NULL,body TEXT NOT NULL,at TEXT NOT NULL,UNIQUE(conversation,request));
      CREATE TABLE question(id TEXT PRIMARY KEY,conversation TEXT NOT NULL REFERENCES conversation(id),request TEXT NOT NULL,call TEXT NOT NULL,answered TEXT);
      CREATE TABLE attachments(id TEXT PRIMARY KEY REFERENCES event(id),files TEXT NOT NULL);
      CREATE TABLE file_delivery(event_id TEXT NOT NULL REFERENCES event(id), slot INTEGER NOT NULL, issuer TEXT NOT NULL, subject TEXT, file TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT UNIQUE, PRIMARY KEY(event_id,slot));
      CREATE TABLE delivery(id TEXT PRIMARY KEY REFERENCES event(id), issuer TEXT NOT NULL, subject TEXT, source TEXT NOT NULL, state TEXT NOT NULL, receipt TEXT UNIQUE);
    `);
    legacyDb
      .prepare('INSERT INTO bot VALUES(?,?,?)')
      .run('owner', randomUUID(), convId);
    legacyDb
      .prepare('INSERT INTO conversation VALUES(?,?,?)')
      .run(convId, 'owner', 'default');
    legacyDb
      .prepare(
        'INSERT INTO event(conversation,id,request,role,text,at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        convId,
        randomUUID(),
        interruptedReq,
        'user',
        'in flight before restart',
        new Date().toISOString(),
      );
    legacyDb
      .prepare(
        'INSERT INTO queued(conversation,request,body,at) VALUES(?,?,?,?)',
      )
      .run(
        convId,
        queuedReq,
        JSON.stringify({ text: 'queued before restart', files: [] }),
        new Date().toISOString(),
      );
    legacyDb.close();

    const migrated = new RemoteBot(legacyHome);
    try {
      const cols = (
        migrated.db.prepare('PRAGMA table_info(event)').all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      assert.ok(cols.includes('code'));
      const hist = migrated.run('owner', {
        action: 'history',
        conversation: convId,
        after: 0,
      }) as {
        events: Array<{ role: string; code?: string; text: string }>;
      };
      assert.equal('code' in hist.events[0]!, false);
      assert.deepEqual(
        hist.events.slice(1).map((e) => ({
          role: e.role,
          code: e.code,
          text: e.text,
        })),
        [
          {
            role: 'user',
            code: undefined,
            text: 'queued before restart',
          },
          {
            role: 'notice',
            code: 'host_restarted_queued',
            text: 'host restarted while queued; message not executed',
          },
          {
            role: 'notice',
            code: 'host_restarted_interrupted',
            text: 'host restarted; previous request outcome unknown',
          },
        ],
      );
    } finally {
      await migrated.close();
    }
  } finally {
    await rm(legacyHome, { recursive: true, force: true });
  }

  const home = await mkdtemp(join(tmpdir(), 'remote-bot-r1-notices-'));
  type MockMode =
    | 'block'
    | 'ok'
    | 'bot_error_question'
    | 'bot_error_cred'
    | 'bot_error_empty'
    | 'bot_error_auth'
    | 'bot_error_model_id'
    | 'bot_error_404'
    | 'bot_error_unreachable'
    | 'bot_error_invalid_reply'
    | 'raw_error';
  let nextMode: MockMode = 'ok';
  let activeGate = deferred();
  let activeStarted = deferred();
  const host = new RemoteBot(home, async () => {
    switch (nextMode) {
      case 'block':
        activeStarted.resolve();
        await activeGate.promise;
        return 'late';
      case 'bot_error_question':
        throw new BotError(
          502,
          'model_output_blocked',
          'model did not provide a valid question',
          'model_invalid_question',
        );
      case 'bot_error_cred':
        throw new BotError(
          502,
          'model_output_blocked',
          'model reply contained credentials',
          'model_credentials_blocked',
        );
      case 'bot_error_empty':
        throw new BotError(
          502,
          'model_empty_reply',
          'model returned an empty reply',
          'model_empty_reply',
        );
      case 'bot_error_auth':
        throw new BotError(
          422,
          'model_auth_failed',
          'model endpoint rejected credentials',
          'model_auth_failed',
        );
      case 'bot_error_model_id':
        throw new BotError(
          422,
          'model_not_found',
          'model id is unavailable',
          'model_id_unavailable',
        );
      case 'bot_error_404':
        throw new BotError(
          422,
          'model_not_found',
          'endpoint or model not found',
          'model_not_found',
        );
      case 'bot_error_unreachable':
        throw new BotError(
          503,
          'model_unreachable',
          'model endpoint unreachable or timed out',
          'model_unreachable',
        );
      case 'bot_error_invalid_reply':
        throw new BotError(
          502,
          'model_unreachable',
          'model did not return a valid reply',
          'model_invalid_reply',
        );
      case 'raw_error':
        throw new Error('unexpected stream failure');
      default:
        return 'ok';
    }
  });
  const channelRoute: ChatRoute = {
    source: 'channel',
    issuer: 'issuer-1',
    subject: 'bound-1',
  };
  const clientRoute: ChatRoute = {
    source: 'client',
    issuer: 'issuer-1',
    subject: 'bound-1',
  };
  const drainClaims = () => {
    const out: Array<{ role: string; code?: string; text: string }> = [];
    for (
      let item = host.claim('issuer-1');
      item;
      item = host.claim('issuer-1')
    ) {
      out.push({
        role: item.role,
        ...(item.code ? { code: item.code } : {}),
        text: item.text,
      });
      host.delivered(item.receipt, 'issued');
    }
    return out;
  };
  const waitIdle = async (conversation: string) => {
    const deadline = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation,
          after: 0,
        }) as { active: unknown; queued: unknown[] }
      ).active ||
      (
        host.run('member', {
          action: 'history',
          conversation,
          after: 0,
        }) as { queued: unknown[] }
      ).queued.length > 0
    ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for idle');
      await new Promise<void>((ok) => setImmediate(ok));
    }
  };
  try {
    const { current: conv1 } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    host.inbound('member', randomUUID(), 'help', config, channelRoute);
    host.inbound('member', randomUUID(), '/stop', config, channelRoute);

    nextMode = 'block';
    host.inbound('member', randomUUID(), 'hold', config, channelRoute);
    await activeStarted.promise;
    host.inbound('member', randomUUID(), '/stop', config, channelRoute);
    activeGate.resolve();
    await waitIdle(conv1);

    host.inbound('member', randomUUID(), '/new', config, channelRoute);
    const { current: conv2 } = host.run('member', { action: 'discover' }) as {
      current: string;
    };

    activeGate = deferred();
    activeStarted = deferred();
    nextMode = 'block';
    host.run(
      'member',
      {
        action: 'send',
        conversation: conv2,
        request: randomUUID(),
        text: 'active before disable',
      },
      config,
      clientRoute,
    );
    await activeStarted.promise;
    host.run(
      'member',
      {
        action: 'send',
        conversation: conv2,
        request: randomUUID(),
        text: 'queued before disable',
      },
      config,
      clientRoute,
    );
    host.disable();
    activeGate.resolve();
    await waitIdle(conv2);

    const errorCases: Array<[MockMode, string, string]> = [
      [
        'bot_error_question',
        'model_invalid_question',
        'model did not provide a valid question',
      ],
      [
        'bot_error_cred',
        'model_credentials_blocked',
        'model reply contained credentials',
      ],
      ['bot_error_empty', 'model_empty_reply', 'model returned an empty reply'],
      [
        'bot_error_auth',
        'model_auth_failed',
        'model endpoint rejected credentials',
      ],
      ['bot_error_model_id', 'model_id_unavailable', 'model id is unavailable'],
      ['bot_error_404', 'model_not_found', 'endpoint or model not found'],
      [
        'bot_error_unreachable',
        'model_unreachable',
        'model endpoint unreachable or timed out',
      ],
      [
        'bot_error_invalid_reply',
        'model_invalid_reply',
        'model did not return a valid reply',
      ],
      [
        'raw_error',
        'reply_interrupted',
        'model reply interrupted; outcome unknown',
      ],
    ];
    for (const [mode] of errorCases) {
      nextMode = mode;
      host.run(
        'member',
        {
          action: 'send',
          conversation: conv2,
          request: randomUUID(),
          text: 'trigger ' + mode,
        },
        config,
        channelRoute,
      );
      await waitIdle(conv2);
    }

    // Invalid attachment digest & credential_blocked on promoted queue item.
    host.run(
      'member',
      {
        action: 'send',
        conversation: conv2,
        request: randomUUID(),
        text: 'bad digest',
        files: [{ name: 'a.txt', size: 1, sha256: 'not-a-digest' }],
      },
      config,
      channelRoute,
    );
    await waitIdle(conv2);

    const ownerDir = join(
      home,
      'files',
      createHash('sha256').update('member').digest('hex'),
    );
    await mkdir(ownerDir, { recursive: true, mode: 0o700 });
    const badFile = Buffer.from('actual');
    const badSha = createHash('sha256')
      .update(Buffer.from('other'))
      .digest('hex');
    await writeFile(join(ownerDir, badSha), badFile);
    host.run(
      'member',
      {
        action: 'send',
        conversation: conv2,
        request: randomUUID(),
        text: 'bad sha',
        files: [{ name: 'b.txt', size: badFile.length, sha256: badSha }],
      },
      config,
      channelRoute,
    );
    await waitIdle(conv2);

    activeGate = deferred();
    activeStarted = deferred();
    nextMode = 'block';
    const cfgOld: RemoteModel = { ...config, key: 'KEY-A' };
    const cfgRotated: RemoteModel = { ...config, key: 'KEY-B' };
    host.run(
      'member',
      {
        action: 'send',
        conversation: conv2,
        request: randomUUID(),
        text: 'hold for key rotation',
      },
      cfgOld,
      channelRoute,
    );
    await activeStarted.promise;
    host.run(
      'member',
      {
        action: 'send',
        conversation: conv2,
        request: randomUUID(),
        text: 'contains KEY-B later',
      },
      cfgOld,
      channelRoute,
    );
    host.configure(cfgRotated);
    activeGate.resolve();
    await waitIdle(conv2);

    // Test action: 'stop' emits exact 'reply stopped' notice and code.
    activeGate = deferred();
    activeStarted = deferred();
    nextMode = 'block';
    const stopReq = randomUUID();
    host.run(
      'member',
      {
        action: 'send',
        conversation: conv2,
        request: stopReq,
        text: 'stop via action',
      },
      config,
      channelRoute,
    );
    await activeStarted.promise;
    assert.deepEqual(
      host.run('member', {
        action: 'stop',
        conversation: conv2,
        request: stopReq,
      }),
      { stopping: true },
    );
    activeGate.resolve();
    await waitIdle(conv2);
    const stopHist = host.run('member', {
      action: 'history',
      conversation: conv2,
      after: 0,
    }) as { events: Array<{ role: string; code?: string; text: string }> };
    assert.deepEqual(stopHist.events.at(-1), {
      ...stopHist.events.at(-1)!,
      role: 'notice',
      code: 'reply_stopped',
      text: 'reply stopped',
    });

    const claims = drainClaims();
    const expectedNotices: Array<[string, string]> = [
      [
        'help',
        'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.',
      ],
      ['stop_idle', 'no active reply to stop'],
      ['stop_requested', 'requested stop for active reply'],
      ['reply_stopped', 'reply stopped'],
      ['conversation_started', 'started a new conversation'],
      ['bot_disabled_aborted', 'bot model was disabled; active reply stopped'],
      [
        'disabled_queued',
        'bot model is disabled; queued message was not executed',
      ],
      ...errorCases.map(([, c, t]) => [c, t] as [string, string]),
      ['invalid_attachment_digest', 'invalid attachment digest'],
      ['attachment_integrity_failed', 'attachment integrity check failed'],
      ['credential_blocked', 'message cannot contain bot credentials'],
      ['reply_stopped', 'reply stopped'],
    ];
    const noticeClaims = claims.filter((c) => c.role === 'notice');
    assert.deepEqual(
      noticeClaims.map((c) => [c.code, c.text]),
      expectedNotices,
    );
    // Client route queued user messages whereas channel route did not.
    assert.deepEqual(
      claims.filter((c) => c.role === 'user').map((c) => c.text),
      ['active before disable', 'queued before disable'],
    );
    const hist2 = host.run('member', {
      action: 'history',
      conversation: conv2,
      after: 0,
    }) as { events: Array<{ role: string; code?: string; text: string }> };
    const disabledNotice = hist2.events.find(
      (e) => e.code === 'bot_disabled_aborted',
    );
    assert.equal(disabledNotice?.role, 'notice');
  } finally {
    activeGate.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test(
  'R2: serveRemoteBot configure/disable/config:null frames abort in-flight AbortSignal and inbound refreshes #activeConfig',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    const { createServer, request } = await import('node:http');
    const { serveRemoteBot } = await import('../src/remote_bot_service.js');
    const dir = await mkdtemp(join(tmpdir(), 'remote-bot-r2-'));

    const seen: Array<{ auth: string; text: string }> = [];
    let holdNext = false;
    let heldResponded = false;
    let gate = deferred();
    let reqStarted = deferred();
    let reqAborted = deferred();

    const modelServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ content: string }>;
      };
      const text = String(body.messages.at(-1)?.content ?? '');
      seen.push({ auth: String(req.headers.authorization ?? ''), text });
      const held = holdNext;
      if (held) {
        holdNext = false;
        reqStarted.resolve();
        res.once('close', () => {
          if (!res.writableFinished) reqAborted.resolve();
        });
        await gate.promise;
        if (res.destroyed || res.closed) return;
        heldResponded = true;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'x',
            object: 'chat.completion.chunk',
            model: 'm',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'reply ' + text },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'x',
            object: 'chat.completion.chunk',
            model: 'm',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((ok) => modelServer.listen(0, '127.0.0.1', ok));
    const port = (modelServer.address() as { port: number }).port;
    const cfg1: RemoteModel = {
      ...config,
      endpoint: `http://127.0.0.1:${port}/v1`,
      key: 'KEY-OLD',
    };
    const cfg2: RemoteModel = {
      ...config,
      endpoint: `http://127.0.0.1:${port}/v1`,
      key: 'KEY-NEW',
    };

    const stop = await serveRemoteBot(dir);
    const call = (frame: unknown) =>
      new Promise<{ status: number; body: Record<string, unknown> }>(
        (ok, fail) => {
          const payload = Buffer.from(JSON.stringify(frame));
          const req = request(
            {
              socketPath: join(dir, 'host.sock'),
              path: '/chat',
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': payload.length,
              },
            },
            (res) => {
              const out: Buffer[] = [];
              res.on('data', (c: Buffer) => out.push(c));
              res.on('end', () =>
                ok({
                  status: res.statusCode ?? 500,
                  body: JSON.parse(Buffer.concat(out).toString('utf8')),
                }),
              );
            },
          );
          req.on('error', fail);
          req.end(payload);
        },
      );
    const waitSocketIdle = async (conversation: string) => {
      const deadline = Date.now() + 5000;
      while (true) {
        const hist = (
          await call({
            owner: 'member',
            op: { action: 'history', conversation, after: 0 },
          })
        ).body as {
          active: unknown;
          queued: unknown[];
          events: Array<{ role: string; code?: string; text: string }>;
        };
        if (!hist.active && hist.queued.length === 0) return hist;
        if (Date.now() > deadline)
          throw new Error('socket queue did not drain');
        await new Promise<void>((ok) => setImmediate(ok));
      }
    };
    try {
      const { current } = (
        await call({ owner: 'member', op: { action: 'discover' } })
      ).body as { current: string };

      // (a) configure frame (owner omitted) updates queued M2's key.
      holdNext = true;
      gate = deferred();
      reqStarted = deferred();
      reqAborted = deferred();
      await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'M1',
        },
        config: cfg1,
      });
      await reqStarted.promise;
      await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'M2',
        },
        config: cfg1,
      });
      const cfgRes = await call({ op: { action: 'configure' }, config: cfg2 });
      assert.equal(cfgRes.status, 200);
      assert.equal(cfgRes.body.configured, true);
      // test frame must NOT overwrite #activeConfig even when run after configure.
      const testRes = await call({
        owner: 'member',
        op: { action: 'test' },
        config: { ...cfg1, key: 'KEY-TEST-ONLY' },
      });
      assert.equal(testRes.status, 200);
      gate.resolve();
      await waitSocketIdle(current);
      assert.deepEqual(seen, [
        { auth: 'Bearer KEY-OLD', text: 'M1' },
        { auth: 'Bearer KEY-TEST-ONLY', text: 'reply OK' },
        { auth: 'Bearer KEY-NEW', text: 'M2' },
      ]);

      // (b) disable frame (owner omitted) aborts in-flight D1's AbortSignal and skips D2 with disabled_queued.
      seen.length = 0;
      holdNext = true;
      heldResponded = false;
      gate = deferred();
      reqStarted = deferred();
      reqAborted = deferred();
      await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'D1',
        },
        config: cfg2,
      });
      await reqStarted.promise;
      await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'D2',
        },
        config: cfg2,
      });
      const disRes = await call({ op: { action: 'disable' } });
      assert.equal(disRes.status, 200);
      assert.equal(disRes.body.disabled, true);
      let abortedWhileHeld = false;
      let releaseFallback: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        reqAborted.promise.then(() => {
          abortedWhileHeld = true;
        }),
        new Promise<void>((ok) => {
          releaseFallback = setTimeout(ok, 500);
        }),
      ]);
      if (releaseFallback !== undefined) clearTimeout(releaseFallback);
      gate.resolve();
      const afterDisable = await waitSocketIdle(current);
      const m1SettledViaAbort = !heldResponded;
      assert.equal(abortedWhileHeld, true);
      assert.equal(m1SettledViaAbort, true);
      assert.deepEqual(seen, [{ auth: 'Bearer KEY-NEW', text: 'D1' }]);
      assert.deepEqual(
        afterDisable.events.slice(-3).map((e) => [e.role, e.code]),
        [
          ['notice', 'bot_disabled_aborted'],
          ['user', undefined],
          ['notice', 'disabled_queued'],
        ],
      );

      // (c) inbound over socket refreshes #activeConfig for queued M2.
      seen.length = 0;
      holdNext = true;
      gate = deferred();
      reqStarted = deferred();
      reqAborted = deferred();
      await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'I1',
        },
        config: cfg1,
      });
      await reqStarted.promise;
      await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'I2',
        },
        config: cfg1,
      });
      await call({
        owner: 'member',
        op: { action: 'inbound', request: randomUUID(), text: 'help' },
        config: cfg2,
        route: { source: 'channel', issuer: 'i1', subject: 's1' },
      });
      gate.resolve();
      await waitSocketIdle(current);
      assert.deepEqual(seen, [
        { auth: 'Bearer KEY-OLD', text: 'I1' },
        { auth: 'Bearer KEY-NEW', text: 'I2' },
      ]);

      // (d) config: null on discover/send/configure disables a previously configured host.
      const sendWithNull = await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'after null',
        },
        config: null,
      });
      assert.equal(sendWithNull.status, 503);
      assert.equal(sendWithNull.body.code, 'bot_not_enabled');

      await call({ op: { action: 'configure' }, config: cfg2 });
      await call({
        owner: 'member',
        op: { action: 'discover' },
        config: null,
      });
      const sendAfterDiscoverNull = await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'still disabled',
        },
      });
      assert.equal(sendAfterDiscoverNull.status, 503);
      assert.equal(sendAfterDiscoverNull.body.code, 'bot_not_enabled');

      await call({ op: { action: 'configure' }, config: cfg2 });
      const cfgNull = await call({
        op: { action: 'configure' },
        config: null,
      });
      assert.equal(cfgNull.status, 200);
      const sendAfterCfgNull = await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'disabled by configure null',
        },
      });
      assert.equal(sendAfterCfgNull.status, 503);
    } finally {
      gate.resolve();
      modelServer.closeAllConnections();
      await new Promise<void>((ok) => modelServer.close(() => ok()));
      await stop();
      await rm(dir, { recursive: true, force: true });
    }

    // Direct host.inbound() refreshes #activeConfig even on non-send commands like help.
    const directHome = await mkdtemp(join(tmpdir(), 'remote-bot-r2-direct-'));
    const directGate = deferred();
    const directStarted = deferred();
    const directSeen: Array<{ key: string; text: string }> = [];
    const directHost = new RemoteBot(
      directHome,
      async (_home, cfg, messages) => {
        const text = String(messages.at(-1)?.content ?? '');
        directSeen.push({ key: cfg.key, text });
        if (text === 'M1') {
          directStarted.resolve();
          await directGate.promise;
        }
        return 'ok ' + text;
      },
    );
    try {
      const { current } = directHost.run('member', {
        action: 'discover',
      }) as { current: string };
      directHost.run(
        'member',
        {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'M1',
        },
        cfg1,
      );
      await directStarted.promise;
      directHost.run(
        'member',
        {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'M2',
        },
        cfg1,
      );
      directHost.inbound('member', randomUUID(), 'help', cfg2, {
        source: 'channel',
        issuer: 'i1',
        subject: 's1',
      });
      directGate.resolve();
      const deadline = Date.now() + 5000;
      while (
        (
          directHost.run('member', {
            action: 'history',
            conversation: current,
            after: 0,
          }) as { active: unknown; queued: unknown[] }
        ).active ||
        (
          directHost.run('member', {
            action: 'history',
            conversation: current,
            after: 0,
          }) as { queued: unknown[] }
        ).queued.length > 0
      ) {
        if (Date.now() > deadline)
          throw new Error('direct queue did not drain');
        await new Promise<void>((ok) => setImmediate(ok));
      }
      assert.deepEqual(directSeen, [
        { key: 'KEY-OLD', text: 'M1' },
        { key: 'KEY-NEW', text: 'M2' },
      ]);

      // Disabling during async attachFiles skips calling complete() completely.
      const { createHash } = await import('node:crypto');
      const { mkdir, writeFile } = await import('node:fs/promises');
      const attBytes = Buffer.from('async attach bytes');
      const attSha = createHash('sha256').update(attBytes).digest('hex');
      const ownerDir = join(
        directHome,
        'files',
        createHash('sha256').update('member').digest('hex'),
      );
      await mkdir(ownerDir, { recursive: true, mode: 0o700 });
      await writeFile(join(ownerDir, attSha), attBytes);
      directSeen.length = 0;
      directHost.run(
        'member',
        {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'disabled mid-attach',
          files: [{ name: 'a.txt', size: attBytes.length, sha256: attSha }],
        },
        cfg2,
      );
      directHost.disable();
      while (
        (
          directHost.run('member', {
            action: 'history',
            conversation: current,
            after: 0,
          }) as { active: unknown }
        ).active
      ) {
        await new Promise<void>((ok) => setImmediate(ok));
      }
      assert.deepEqual(directSeen, []);
      const postAttachHist = directHost.run('member', {
        action: 'history',
        conversation: current,
        after: 0,
      }) as { events: Array<{ role: string; code?: string }> };
      assert.equal(postAttachHist.events.at(-1)?.code, 'bot_disabled_aborted');
    } finally {
      directGate.resolve();
      await directHost.close();
      await rm(directHome, { recursive: true, force: true });
    }
  },
);

test('R5 & S15: 0-byte PNG, tampered attachments, attachment_integrity_failed 422, and 256 KiB history text replay cap', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-r5-s15-'));
  const ownerDir = join(
    home,
    'files',
    createHash('sha256').update('member').digest('hex'),
  );
  await mkdir(ownerDir, { recursive: true, mode: 0o700 });
  const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

  const emptyPng = Buffer.alloc(0);
  const emptyPngSha = sha(emptyPng);
  await writeFile(join(ownerDir, emptyPngSha), emptyPng);

  const validPng = Buffer.from('89504e470d0a1a0a', 'hex');
  const validPngSha = sha(validPng);
  await writeFile(join(ownerDir, validPngSha), validPng);

  const tamperedTarget = Buffer.from('good-bytes');
  const tamperedSha = sha(tamperedTarget);
  await writeFile(join(ownerDir, tamperedSha), Buffer.from('corrupted!'));

  // S15: direct attachFiles throws 422 attachment_integrity_failed when allowMissing=false,
  // and appends ' (file unavailable)' when allowMissing=true for 0-byte PNG, tampered, and ENOENT.
  await assert.rejects(
    attachFiles(
      home,
      'member',
      [
        {
          name: 'tampered.txt',
          size: tamperedTarget.length,
          sha256: tamperedSha,
        },
      ],
      { id: 'm1', role: 'user', content: 'hi' },
    ),
    (err: unknown) =>
      err instanceof BotError &&
      err.status === 422 &&
      err.code === 'attachment_integrity_failed' &&
      err.noticeCode === 'attachment_integrity_failed' &&
      err.message === 'attachment integrity check failed',
  );
  const replayMsg: import('../src/types.js').Message = {
    id: 'm2',
    role: 'user',
    content: 'hi',
  };
  await attachFiles(
    home,
    'member',
    [
      { name: 'zero.png', size: 0, sha256: emptyPngSha },
      {
        name: 'tampered.txt',
        size: tamperedTarget.length,
        sha256: tamperedSha,
      },
      { name: 'missing.txt', size: 10, sha256: sha(Buffer.from('missing123')) },
    ],
    replayMsg,
    { media: 1024 * 1024, text: MAX_HISTORY_TEXT_BYTES },
    true,
  );
  assert.equal(replayMsg.content.match(/ \(file unavailable\)/g)?.length, 3);
  assert.equal(replayMsg.attachments, undefined);

  const seenTurns: Array<Array<{ role: string; content: string }>> = [];
  const host = new RemoteBot(home, async (_home, _cfg, messages) => {
    seenTurns.push(
      messages.map((m) => ({ role: m.role, content: String(m.content) })),
    );
    return 'ok';
  });
  const waitIdle = async (conversation: string) => {
    const deadline = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation,
          after: 0,
        }) as { active: unknown }
      ).active
    ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for idle');
      await new Promise<void>((ok) => setImmediate(ok));
    }
  };
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };

    // Current-turn 0-byte PNG fails BEFORE calling model with attachment_unavailable (not reply_interrupted).
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'zero png',
        files: [{ name: 'zero.png', size: 0, sha256: emptyPngSha }],
      },
      config,
    );
    await waitIdle(current);
    assert.equal(seenTurns.length, 0);

    // Current-turn tampered file fails BEFORE calling model with attachment_integrity_failed.
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'tampered file',
        files: [
          {
            name: 'tampered.txt',
            size: tamperedTarget.length,
            sha256: tamperedSha,
          },
        ],
      },
      config,
    );
    await waitIdle(current);
    assert.equal(seenTurns.length, 0);

    const hBefore = host.run('member', {
      action: 'history',
      conversation: current,
      after: 0,
    }) as { events: Array<{ role: string; code?: string; text: string }> };
    assert.deepEqual(
      hBefore.events
        .filter((e) => e.role === 'notice')
        .map((e) => [e.code, e.text]),
      [
        ['attachment_unavailable', 'attachment could not be read'],
        ['attachment_integrity_failed', 'attachment integrity check failed'],
      ],
    );

    // Subsequent turn succeeds with valid PNG even though prior turns have 0-byte PNG and tampered file in history.
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'valid png turn',
        files: [{ name: 'ok.png', size: validPng.length, sha256: validPngSha }],
      },
      config,
    );
    await waitIdle(current);
    assert.equal(seenTurns.length, 1);
    assert.match(seenTurns[0]![0]!.content, /\(file unavailable\)/);

    // Now tamper the previously valid PNG on disk, and verify next turn still proceeds!
    await writeFile(join(ownerDir, validPngSha), Buffer.from('corrupt-png'));
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'after tampering history png',
      },
      config,
    );
    await waitIdle(current);
    assert.equal(seenTurns.length, 2);
    assert.ok(
      seenTurns[1]!.some(
        (m) =>
          m.content.includes('ok.png') &&
          m.content.includes('(file unavailable)'),
      ),
    );

    // Multi-turn history text replay cap (MAX_HISTORY_TEXT_BYTES = 256 KiB):
    const next = host.run('member', {
      action: 'new',
      request: randomUUID(),
    }) as { conversation: string };
    const mkTxt = async (tag: string, bytesLen: number) => {
      const content = Buffer.from(tag + ' '.repeat(bytesLen - tag.length));
      const digest = sha(content);
      await writeFile(join(ownerDir, digest), content);
      return { name: tag + '.txt', size: content.length, sha256: digest };
    };
    const f1 = await mkTxt('OLD-TURN-1', 100 * 1024);
    const f2 = await mkTxt('MID-TURN-2', 100 * 1024);
    const f3 = await mkTxt('NEW-TURN-3', 100 * 1024);
    for (const f of [f1, f2, f3]) {
      host.run(
        'member',
        {
          action: 'send',
          conversation: next.conversation,
          request: randomUUID(),
          text: 'send ' + f.name,
          files: [f],
        },
        config,
      );
      await waitIdle(next.conversation);
    }
    seenTurns.length = 0;
    host.run(
      'member',
      {
        action: 'send',
        conversation: next.conversation,
        request: randomUUID(),
        text: 'check replay budget',
      },
      config,
    );
    await waitIdle(next.conversation);
    const replayUserMsgs = seenTurns[0]!.filter((m) => m.role === 'user');
    assert.match(replayUserMsgs[0]!.content, / \(file reference only\)/);
    assert.doesNotMatch(replayUserMsgs[0]!.content, /OLD-TURN-1   /);
    assert.match(replayUserMsgs[1]!.content, /MID-TURN-2   /);
    assert.match(replayUserMsgs[2]!.content, /NEW-TURN-3   /);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('S11: remote_bot.ts and remote_bot_service.ts keep all host strings CJK-free except the 3 inbound keyword trigger arrays', async () => {
  const { readFile } = await import('node:fs/promises');
  const root = join(import.meta.dirname, '..');
  const botSrc = await readFile(join(root, 'src', 'remote_bot.ts'), 'utf8');
  const svcSrc = await readFile(
    join(root, 'src', 'remote_bot_service.ts'),
    'utf8',
  );
  const cjk = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]/;
  assert.equal(cjk.test(svcSrc), false);
  const stripped = botSrc
    .replace(/\[\s*'帮助',\s*'help'\s*\]/, '')
    .replace(
      /\[\s*'新对话',\s*'新会话',\s*'重置',\s*'\/new',\s*'\/reset'\s*\]/,
      '',
    )
    .replace(
      /\[\s*'停止',\s*'终止',\s*'强制终止',\s*'\/stop',\s*'\/kill',\s*'\/abort'\s*\]/,
      '',
    );
  assert.notEqual(stripped, botSrc);
  assert.equal(cjk.test(stripped), false);
});

test(
  'F8: serveRemoteBot enforces monotonic configVersion across configure, disable, discover, send, and inbound',
  { skip: process.platform === 'win32', timeout: 15000 },
  async () => {
    const { createServer, request } = await import('node:http');
    const { serveRemoteBot } = await import('../src/remote_bot_service.js');
    const dir = await mkdtemp(join(tmpdir(), 'remote-bot-f8-'));

    const seen: Array<{ auth: string; text: string }> = [];
    const modelServer = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        messages: Array<{ content: string }>;
      };
      const text = String(body.messages.at(-1)?.content ?? '');
      seen.push({ auth: String(req.headers.authorization ?? ''), text });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'x',
            object: 'chat.completion.chunk',
            model: 'm',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'ok ' + text },
                finish_reason: null,
              },
            ],
          }) +
          '\n\n',
      );
      res.write(
        'data: ' +
          JSON.stringify({
            id: 'x',
            object: 'chat.completion.chunk',
            model: 'm',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }) +
          '\n\n',
      );
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((ok) => modelServer.listen(0, '127.0.0.1', ok));
    const port = (modelServer.address() as { port: number }).port;
    const cfg1: RemoteModel = {
      ...config,
      endpoint: `http://127.0.0.1:${port}/v1`,
      key: 'KEY-V1',
    };
    const cfg2: RemoteModel = {
      ...config,
      endpoint: `http://127.0.0.1:${port}/v1`,
      key: 'KEY-V2',
    };

    const stop = await serveRemoteBot(dir);
    const call = (frame: unknown) =>
      new Promise<{ status: number; body: Record<string, unknown> }>(
        (ok, fail) => {
          const payload = Buffer.from(JSON.stringify(frame));
          const req = request(
            {
              socketPath: join(dir, 'host.sock'),
              path: '/chat',
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'content-length': payload.length,
              },
            },
            (res) => {
              const out: Buffer[] = [];
              res.on('data', (c: Buffer) => out.push(c));
              res.on('end', () =>
                ok({
                  status: res.statusCode ?? 500,
                  body: JSON.parse(Buffer.concat(out).toString('utf8')),
                }),
              );
            },
          );
          req.on('error', fail);
          req.end(payload);
        },
      );
    const waitSocketIdle = async (conversation: string) => {
      const deadline = Date.now() + 5000;
      while (true) {
        const hist = (
          await call({
            owner: 'member',
            op: { action: 'history', conversation, after: 0 },
          })
        ).body as { active: unknown; queued: unknown[] };
        if (!hist.active && hist.queued.length === 0) return hist;
        if (Date.now() > deadline)
          throw new Error('socket queue did not drain');
        await new Promise<void>((ok) => setImmediate(ok));
      }
    };
    try {
      const { current } = (
        await call({ owner: 'member', op: { action: 'discover' } })
      ).body as { current: string };

      const badVer = await call({
        op: { action: 'configure' },
        config: cfg1,
        configVersion: -1,
      });
      assert.equal(badVer.status, 400);
      assert.equal(badVer.body.code, 'invalid_request');

      const cfgRes1 = await call({
        op: { action: 'configure' },
        config: cfg1,
        configVersion: 1,
      });
      assert.equal(cfgRes1.status, 200);
      assert.equal(cfgRes1.body.configured, true);

      // Stale discover(null, v=0) after configure(K1, v=1) must NOT disable K1.
      const staleDiscover = await call({
        owner: 'member',
        op: { action: 'discover' },
        config: null,
        configVersion: 0,
      });
      assert.equal(staleDiscover.status, 200);

      const sendAfterStaleDiscover = await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'still-enabled',
        },
      });
      assert.equal(sendAfterStaleDiscover.status, 200);
      await waitSocketIdle(current);
      assert.deepEqual(seen, [
        { auth: 'Bearer KEY-V1', text: 'still-enabled' },
      ]);

      // disable(v=2) keeps configVersion=2; stale send/inbound carrying cfg1(v=1) must return 503 bot_not_enabled and never re-enable K1.
      const disRes = await call({
        op: { action: 'disable' },
        configVersion: 2,
      });
      assert.equal(disRes.status, 200);
      assert.equal(disRes.body.disabled, true);

      const staleSend = await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'stale-send',
        },
        config: cfg1,
        configVersion: 1,
      });
      assert.equal(staleSend.status, 503);
      assert.equal(staleSend.body.code, 'bot_not_enabled');
      assert.equal(staleSend.body.message, 'bot model is not enabled');

      const followUpSend = await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 'must-stay-disabled',
        },
      });
      assert.equal(followUpSend.status, 503);
      assert.equal(followUpSend.body.code, 'bot_not_enabled');

      const staleInbound = await call({
        owner: 'member',
        op: { action: 'inbound', request: randomUUID(), text: 'help' },
        config: cfg1,
        configVersion: 1,
        route: { source: 'channel', issuer: 'i1', subject: 's1' },
      });
      assert.equal(staleInbound.status, 503);
      assert.equal(staleInbound.body.code, 'bot_not_enabled');

      // Newer configure(cfg2, v=3) re-enables; unversioned disable must be ignored once versioned.
      const cfgRes2 = await call({
        op: { action: 'configure' },
        config: cfg2,
        configVersion: 3,
      });
      assert.equal(cfgRes2.status, 200);
      const unversionedDisable = await call({ op: { action: 'disable' } });
      assert.equal(unversionedDisable.status, 200);
      const sendV3 = await call({
        owner: 'member',
        op: {
          action: 'send',
          conversation: current,
          request: randomUUID(),
          text: 're-enabled-v3',
        },
      });
      assert.equal(sendV3.status, 200);
      await waitSocketIdle(current);
      assert.deepEqual(seen, [
        { auth: 'Bearer KEY-V1', text: 'still-enabled' },
        { auth: 'Bearer KEY-V2', text: 're-enabled-v3' },
      ]);
    } finally {
      modelServer.closeAllConnections();
      await new Promise<void>((ok) => modelServer.close(() => ok()));
      await stop();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test('F9: pre-model non-attachment errors emit reply_interrupted while missing current attachment emits attachment_unavailable', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-f9-'));
  let modelCalls = 0;
  const host = new RemoteBot(home, async () => {
    modelCalls++;
    return 'unexpected';
  });
  const waitIdle = async (conversation: string) => {
    const deadline = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation,
          after: 0,
        }) as { active: unknown }
      ).active
    ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for idle');
      await new Promise<void>((ok) => setImmediate(ok));
    }
  };
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    // Make memberHome a regular file so mkdir(memberHome) fails before model start on a text-only turn.
    const membersDir = join(home, 'members');
    await mkdir(membersDir, { recursive: true, mode: 0o700 });
    const memberHash = createHash('sha256').update('member').digest('hex');
    await writeFile(join(membersDir, memberHash), 'not-a-directory');

    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'plain text message',
      },
      config,
    );
    await waitIdle(current);
    assert.equal(modelCalls, 0);

    const histAfterMkdirFail = host.run('member', {
      action: 'history',
      conversation: current,
      after: 0,
    }) as { events: Array<{ role: string; code?: string; text: string }> };
    assert.deepEqual(histAfterMkdirFail.events.at(-1), {
      ...histAfterMkdirFail.events.at(-1)!,
      role: 'notice',
      code: 'reply_interrupted',
      text: 'model reply interrupted; outcome unknown',
    });

    // Missing current-turn attachment still emits attachment_unavailable.
    const missingSha = createHash('sha256')
      .update('missing-file')
      .digest('hex');
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'with missing file',
        files: [{ name: 'missing.txt', size: 12, sha256: missingSha }],
      },
      config,
    );
    await waitIdle(current);
    assert.equal(modelCalls, 0);

    const histAfterMissingFile = host.run('member', {
      action: 'history',
      conversation: current,
      after: 0,
    }) as { events: Array<{ role: string; code?: string; text: string }> };
    assert.deepEqual(histAfterMissingFile.events.at(-1), {
      ...histAfterMissingFile.events.at(-1)!,
      role: 'notice',
      code: 'attachment_unavailable',
      text: 'attachment could not be read',
    });
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('F10: replies exceeding 64,000 chars split cleanly without breaking surrogate pairs and all chunks pass claim()', async () => {
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-f10-'));
  let nextReply = 'A'.repeat(70_000);
  const host = new RemoteBot(home, async () => nextReply);
  const route: ChatRoute = {
    source: 'client',
    issuer: 'issuer-f10',
    subject: 'member-f10',
  };
  const waitIdle = async (conversation: string) => {
    const deadline = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation,
          after: 0,
        }) as { active: unknown }
      ).active
    ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for idle');
      await new Promise<void>((ok) => setImmediate(ok));
    }
  };
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };

    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'long reply',
      },
      config,
      route,
    );
    await waitIdle(current);

    const hist1 = host.run('member', {
      action: 'history',
      conversation: current,
      after: 0,
    }) as { events: Array<{ role: string; text: string }> };
    const assistantEvents = hist1.events.filter((e) => e.role === 'assistant');
    assert.equal(assistantEvents.length, 2);
    for (const [index, event] of assistantEvents.entries()) {
      assert.ok(event.text.length <= MAX_REPLY_DELIVERY_CHARS);
      assert.match(event.text, new RegExp(`\\n\\n\\(part ${index + 1}/2\\)$`));
      assert.doesNotMatch(event.text, /[\u4e00-\u9fff]/);
    }

    const claimedUser = host.claim('issuer-f10');
    assert.equal(claimedUser?.role, 'user');
    host.delivered(claimedUser!.receipt, 'issued');
    const claimedPart1 = host.claim('issuer-f10');
    const claimedPart2 = host.claim('issuer-f10');
    assert.equal(claimedPart1?.role, 'assistant');
    assert.equal(claimedPart2?.role, 'assistant');
    assert.ok(claimedPart1!.text.length <= MAX_REPLY_DELIVERY_CHARS);
    assert.ok(claimedPart2!.text.length <= MAX_REPLY_DELIVERY_CHARS);
    assert.equal(
      claimedPart1!.text.replace(/\n\n\(part 1\/2\)$/, '') +
        claimedPart2!.text.replace(/\n\n\(part 2\/2\)$/, ''),
      nextReply,
    );
    host.delivered(claimedPart1!.receipt, 'issued');
    host.delivered(claimedPart2!.receipt, 'issued');
    assert.equal(host.claim('issuer-f10'), null);

    // Surrogate pair crossing the 60,000-char chunk boundary stays intact and well-formed.
    const surrogateReply = 'a'.repeat(59_999) + '😀' + 'b'.repeat(10_000);
    const surrogateParts = splitReplyText(surrogateReply);
    assert.equal(surrogateParts.length, 2);
    for (const part of surrogateParts) {
      assert.ok(part.length <= MAX_REPLY_DELIVERY_CHARS);
      assert.doesNotMatch(
        part,
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
      );
    }
    assert.equal(surrogateParts[1]!.startsWith('😀'), true);
    assert.equal(
      surrogateParts[0]!.replace(/\n\n\(part 1\/2\)$/, '') +
        surrogateParts[1]!.replace(/\n\n\(part 2\/2\)$/, ''),
      surrogateReply,
    );

    // Exactly 64,000 chars stays a single unsplit assistant event.
    nextReply = 'x'.repeat(MAX_REPLY_DELIVERY_CHARS);
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'exact boundary',
      },
      config,
      route,
    );
    await waitIdle(current);
    const boundaryClaim = host.claim('issuer-f10');
    assert.equal(boundaryClaim?.role, 'user');
    const exactAssistant = host.claim('issuer-f10');
    assert.equal(exactAssistant?.role, 'assistant');
    assert.equal(exactAssistant?.text.length, MAX_REPLY_DELIVERY_CHARS);
    assert.doesNotMatch(exactAssistant!.text, /\(part 1\/1\)/);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('F11: every host notice code matches Hub deliverySchema regex /^[a-z0-9_]{1,64}$/', async () => {
  const { readFile } = await import('node:fs/promises');
  const codePattern = /^[a-z0-9_]{1,64}$/;
  const root = join(import.meta.dirname, '..');
  const botSrc = await readFile(join(root, 'src', 'remote_bot.ts'), 'utf8');
  const svcSrc = await readFile(
    join(root, 'src', 'remote_bot_service.ts'),
    'utf8',
  );

  const literalCodes = new Set<string>();
  for (const m of botSrc.matchAll(/'notice',\s*'([a-zA-Z0-9_-]+)'/g))
    literalCodes.add(m[1]!);
  for (const m of botSrc.matchAll(/\bcode:\s*'([^']+)'/g))
    literalCodes.add(m[1]!);
  for (const m of botSrc.matchAll(
    /new BotError\(\s*\d+,\s*'([^']+)'(?:\s*,\s*[^,)]+(?:\s*,\s*'([^']+)')?)?/g,
  )) {
    literalCodes.add(m[1]!);
    if (m[2]) literalCodes.add(m[2]);
  }
  for (const m of botSrc.matchAll(
    /'(help|conversation_started|stop_requested|stop_idle|disabled_queued|credential_blocked)'/g,
  ))
    literalCodes.add(m[1]!);
  for (const m of svcSrc.matchAll(
    /new BotError\(\s*\d+,\s*'([^']+)'|\bcode:\s*'([^']+)'/g,
  )) {
    const found = m[1] ?? m[2];
    if (found) literalCodes.add(found);
  }
  assert.ok(literalCodes.size >= 20);
  for (const code of literalCodes) {
    assert.match(code, codePattern, `invalid notice/error code: ${code}`);
  }

  // Also check runtime emitted notices across commands, disable, restart, and errors.
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-f11-'));
  const host = new RemoteBot(home, async () => {
    throw new Error('boom');
  });
  const route: ChatRoute = {
    source: 'channel',
    issuer: 'i-f11',
    subject: 's-f11',
  };
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    host.inbound('member', randomUUID(), 'help', config, route);
    host.inbound('member', randomUUID(), '/stop', config, route);
    host.inbound('member', randomUUID(), '/new', config, route);
    const afterNew = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    host.run(
      'member',
      {
        action: 'send',
        conversation: afterNew.current,
        request: randomUUID(),
        text: 'fail',
      },
      config,
      route,
    );
    const deadline = Date.now() + 5000;
    while (
      host.run('member', {
        action: 'history',
        conversation: afterNew.current,
        after: 0,
      }).active
    ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for idle');
      await new Promise<void>((ok) => setImmediate(ok));
    }
    const emitted: string[] = [];
    for (let item = host.claim('i-f11'); item; item = host.claim('i-f11')) {
      if (item.role === 'notice') {
        assert.ok(item.code);
        emitted.push(item.code);
        assert.match(item.code, codePattern);
      }
      host.delivered(item.receipt, 'issued');
    }
    assert.ok(emitted.includes('help'));
    assert.ok(emitted.includes('stop_idle'));
    assert.ok(emitted.includes('conversation_started'));
    assert.ok(emitted.includes('reply_interrupted'));
    assert.ok(current);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

test('T5: multi-turn media replay enforces 20 MiB MAX_MEDIA_BYTES budget across turns', async () => {
  const { createHash } = await import('node:crypto');
  const { mkdir, writeFile } = await import('node:fs/promises');
  const home = await mkdtemp(join(tmpdir(), 'remote-bot-t5-media-'));
  const ownerDir = join(
    home,
    'files',
    createHash('sha256').update('member').digest('hex'),
  );
  await mkdir(ownerDir, { recursive: true, mode: 0o700 });
  const elevenMiB = 11 * 1024 * 1024;
  const img1 = Buffer.alloc(elevenMiB, 0x41);
  const img2 = Buffer.alloc(elevenMiB, 0x42);
  const sha1 = createHash('sha256').update(img1).digest('hex');
  const sha2 = createHash('sha256').update(img2).digest('hex');
  await writeFile(join(ownerDir, sha1), img1);
  await writeFile(join(ownerDir, sha2), img2);

  const seenTurns: Array<
    Array<{ role: string; content: string; attachments: number }>
  > = [];
  const host = new RemoteBot(home, async (_home, _cfg, messages) => {
    seenTurns.push(
      messages.map((m) => ({
        role: m.role,
        content: String(m.content),
        attachments: m.attachments?.length ?? 0,
      })),
    );
    return 'ok';
  });
  const waitIdle = async (conversation: string) => {
    const deadline = Date.now() + 5000;
    while (
      (
        host.run('member', {
          action: 'history',
          conversation,
          after: 0,
        }) as { active: unknown }
      ).active
    ) {
      if (Date.now() > deadline) throw new Error('timed out waiting for idle');
      await new Promise<void>((ok) => setImmediate(ok));
    }
  };
  try {
    const { current } = host.run('member', { action: 'discover' }) as {
      current: string;
    };
    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'turn-1-image',
        files: [{ name: 'img1.png', size: img1.length, sha256: sha1 }],
      },
      config,
    );
    await waitIdle(current);

    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'turn-2-image',
        files: [{ name: 'img2.png', size: img2.length, sha256: sha2 }],
      },
      config,
    );
    await waitIdle(current);

    host.run(
      'member',
      {
        action: 'send',
        conversation: current,
        request: randomUUID(),
        text: 'turn-3-check-replay',
      },
      config,
    );
    await waitIdle(current);

    assert.equal(seenTurns.length, 3);
    // Turn 2: current img2.png (11 MiB) attached, leaving 9 MiB so replayed img1.png (11 MiB) falls back to reference-only.
    const turn2Users = seenTurns[1]!.filter((m) => m.role === 'user');
    assert.equal(turn2Users[0]!.attachments, 0);
    assert.match(turn2Users[0]!.content, / \(file reference only\)/);
    assert.equal(turn2Users[1]!.attachments, 1);
    assert.doesNotMatch(turn2Users[1]!.content, / \(file reference only\)/);

    // Turn 3: replay walks newest-first -> img2.png (11 MiB) fits in 20 MiB, leaving 9 MiB so img1.png gets reference-only.
    const turn3Users = seenTurns[2]!.filter((m) => m.role === 'user');
    assert.equal(turn3Users[0]!.attachments, 0);
    assert.match(turn3Users[0]!.content, / \(file reference only\)/);
    assert.equal(turn3Users[1]!.attachments, 1);
    assert.doesNotMatch(turn3Users[1]!.content, / \(file reference only\)/);
  } finally {
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

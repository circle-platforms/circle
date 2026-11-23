import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  BotError,
  maskKey,
  RemoteBot,
  remoteCompletion,
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
  const { serveRemoteBot } = await import('../src/remote_bot_service.js');
  void serveRemoteBot;
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

    const route: import('../src/remote_bot.js').ChatRoute = {
      source: 'desktop',
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

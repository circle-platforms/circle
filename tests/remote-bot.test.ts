import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { RemoteBot, type RemoteModel } from '../src/remote_bot.js';

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
      ['hello', 'hello [已遮盖]'],
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
    assert.match(history.events[1]!.text, /未知/);
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
    assert.match(afterHelp.events[0]!.text, /私人机器人对话/);

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
        (e) => e.role === 'notice' && e.text.includes('停止'),
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
      ['已新建对话'],
    );
    assert.equal(calls, 1);
  } finally {
    block.resolve();
    await host.close();
    await rm(home, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { makeAttachment } from '../src/media.js';
import { emptyUsage, type Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

const answer = (content = 'done'): Message => ({
  id: crypto.randomUUID(),
  role: 'assistant',
  content,
});
const picture = () =>
  makeAttachment(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xkAAAAASUVORK5CYII=',
      'base64',
    ),
    'image/png',
    'queued.png',
  );

function gate() {
  let release!: () => void;
  const waiting = new Promise<void>((done) => {
    release = done;
  });
  return { waiting, release };
}

test('editing a queued message keeps its image and folded paste in the actual next model request', async (t) => {
  const entered = gate();
  const resume = gate();
  const model = new ScriptedModel([
    async () => {
      entered.release();
      await resume.waiting;
      return { message: answer('first'), usage: emptyUsage() };
    },
    { message: answer('steering consumed') },
    { message: answer('follow-up consumed') },
  ]);
  const runtime = new AgentRuntime({
    workspace: scratch(t),
    home: scratch(t),
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const running = runtime.harness.run('initial');
  await entered.waiting;
  const paste = 'full pasted line one\nfull pasted line two';
  const original = `old request ${paste}`;
  const attachment = picture();
  runtime.harness.queue(original, 'steer', [attachment]);
  runtime.harness.shown.set(original, {
    display: 'old request [Pasted text #1 +1 lines]',
    pastes: { '1': paste },
    attachments: [attachment],
  });
  runtime.harness.queue('other steering', 'steer');
  runtime.harness.queue('follow-up', 'followUp');
  const updated = runtime.harness.editQueued(
    'steer',
    0,
    original,
    'updated request [Pasted text #1 +1 lines]',
  );
  assert.equal(updated, `updated request ${paste}`);
  assert.deepEqual(runtime.harness.queuedMessages, {
    steering: [updated, 'other steering'],
    followUp: ['follow-up'],
  });
  assert.equal(
    runtime.harness.queuedShown.steering[0],
    'updated request [Pasted text #1 +1 lines]',
  );
  resume.release();
  await running;
  const next = model.requests[1]!.messages.find(
    (message) =>
      message.role === 'user' && message.content.startsWith('updated request'),
  )!;
  assert.equal(next.content, updated);
  assert.equal(next.attachments?.[0]?.sha256, attachment.sha256);
  const saved = runtime.harness.messages.find(
    (message) =>
      message.role === 'user' && message.content.startsWith('updated request'),
  )!;
  assert.equal(saved.display, 'updated request [Pasted text #1 +1 lines]');
  assert.deepEqual(saved.pastes, { '1': paste });
  assert.equal(saved.attachments?.[0]?.sha256, attachment.sha256);
  assert.equal(
    model.requests[2]!.messages.findLast((message) => message.role === 'user')
      ?.content,
    'follow-up',
  );
});

test('a consumed queue edit rejects instead of changing the next message at that index', async (t) => {
  const entered = gate();
  const resume = gate();
  const model = new ScriptedModel([
    { message: answer('initial') },
    async () => {
      entered.release();
      await resume.waiting;
      return { message: answer('consumed'), usage: emptyUsage() };
    },
    { message: answer('other') },
  ]);
  const runtime = new AgentRuntime({
    workspace: scratch(t),
    home: scratch(t),
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.queue('already consumed', 'followUp');
  const running = runtime.harness.run('initial');
  await entered.waiting;
  runtime.harness.queue('next message', 'followUp');
  assert.throws(
    () =>
      runtime.harness.editQueued(
        'followUp',
        0,
        'already consumed',
        'must not replace next',
      ),
    /queued message changed/,
  );
  assert.deepEqual(runtime.harness.queuedMessages.followUp, ['next message']);
  resume.release();
  await running;
  assert.equal(
    model.requests[1]!.messages.findLast((message) => message.role === 'user')
      ?.content,
    'already consumed',
  );
  assert.equal(
    model.requests[2]!.messages.findLast((message) => message.role === 'user')
      ?.content,
    'next message',
  );
});

test('queue versions reject an ABA edit after an identical next message takes the same index', async (t) => {
  const entered = gate();
  const resume = gate();
  const model = new ScriptedModel([
    { message: answer('initial') },
    async () => {
      entered.release();
      await resume.waiting;
      return {
        message: answer('consumed first duplicate'),
        usage: emptyUsage(),
      };
    },
    { message: answer('consumed second duplicate') },
  ]);
  const runtime = new AgentRuntime({
    workspace: scratch(t),
    home: scratch(t),
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.queue('duplicate', 'followUp');
  runtime.harness.queue('duplicate', 'followUp');
  const frozenVersion = runtime.harness.queuedVersion;
  const running = runtime.harness.run('initial');
  await entered.waiting;
  assert.deepEqual(runtime.harness.queuedMessages.followUp, ['duplicate']);
  assert.ok(runtime.harness.queuedVersion > frozenVersion);
  assert.throws(
    () =>
      runtime.harness.editQueued(
        'followUp',
        0,
        'duplicate',
        'must not edit the second row',
        frozenVersion,
      ),
    /queued messages changed/,
  );
  assert.deepEqual(runtime.harness.queuedMessages.followUp, ['duplicate']);
  resume.release();
  await running;
  assert.equal(
    model.requests[2]!.messages.findLast((message) => message.role === 'user')
      ?.content,
    'duplicate',
  );
});

test('queue versions advance for insertion, explicit edit, removal, take-back and clear', async (t) => {
  const runtime = new AgentRuntime({
    workspace: scratch(t),
    home: scratch(t),
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  let version = runtime.harness.queuedVersion;
  const changed = () => {
    assert.ok(runtime.harness.queuedVersion > version);
    version = runtime.harness.queuedVersion;
  };
  runtime.harness.queue('one');
  changed();
  runtime.harness.editQueued('steer', 0, 'one', 'edited', version);
  changed();
  runtime.harness.removeQueued('steer', 0, 'edited');
  changed();
  runtime.harness.queue('take');
  changed();
  runtime.harness.takeBack();
  changed();
  runtime.harness.queue('clear');
  changed();
  runtime.harness.clearQueue();
  changed();
});

test('queue edit validation never drops another entry or replaces its presentation', async (t) => {
  const runtime = new AgentRuntime({
    workspace: scratch(t),
    home: scratch(t),
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const attachment = picture();
  runtime.harness.queue('with image', 'steer', [attachment]);
  runtime.harness.queue('plain', 'steer');
  for (const index of [-1, 0.5, Number.NaN, 9])
    assert.throws(
      () => runtime.harness.editQueued('steer', index, 'plain', 'new'),
      /queued message changed/,
    );
  assert.throws(
    () => runtime.harness.editQueued('steer', 1, 'plain', '   '),
    /cannot be empty/,
  );
  assert.throws(
    () => runtime.harness.editQueued('steer', 1, 'plain', 'with image'),
    /different attachments/,
  );
  assert.deepEqual(runtime.harness.queuedMessages.steering, [
    'with image',
    'plain',
  ]);
  assert.equal(
    runtime.harness.shown.get('with image')?.attachments?.[0]?.sha256,
    attachment.sha256,
  );
});

test('duplicate queued text keeps its shown paste for both real messages', async (t) => {
  const model = new ScriptedModel([{ message: answer() }]);
  const runtime = new AgentRuntime({
    workspace: scratch(t),
    home: scratch(t),
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  runtime.harness.queue('expanded content', 'steer');
  runtime.harness.queue('expanded content', 'steer');
  runtime.harness.shown.set('expanded content', {
    display: '[Pasted text #1]',
    pastes: { '1': 'expanded content' },
  });
  await runtime.harness.run();
  const messages = runtime.harness.messages.filter(
    (message) => message.role === 'user',
  );
  assert.equal(messages.length, 2);
  for (const message of messages) {
    assert.equal(message.content, 'expanded content');
    assert.equal(message.display, '[Pasted text #1]');
    assert.deepEqual(message.pastes, { '1': 'expanded content' });
  }
});

test('editing during attachment preparation cannot consume a different duplicate row', async (t) => {
  const model = new ScriptedModel([{ message: answer() }]);
  const runtime = new AgentRuntime({
    workspace: scratch(t),
    home: scratch(t),
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const entered = gate();
  const resume = gate();
  const receiver = runtime.harness as unknown as {
    attach(
      prompt: string,
      workspace: string,
      signal: AbortSignal,
      ...rest: unknown[]
    ): Promise<Pick<Message, 'content' | 'attachments'>>;
  };
  const original = receiver.attach.bind(runtime.harness);
  let blocked = false;
  t.mock.method(
    receiver,
    'attach',
    async (
      prompt: string,
      workspace: string,
      signal: AbortSignal,
      ...rest: unknown[]
    ) => {
      if (prompt === 'duplicate' && !blocked) {
        blocked = true;
        entered.release();
        await resume.waiting;
      }
      return original(prompt, workspace, signal, ...rest);
    },
  );
  runtime.harness.queue('duplicate', 'steer');
  runtime.harness.queue('duplicate', 'steer');
  const running = runtime.harness.run('initial');
  await entered.waiting;
  runtime.harness.editQueued('steer', 0, 'duplicate', 'edited first row');
  resume.release();
  await running;
  assert.deepEqual(
    model.requests[0]!.messages.filter(
      (message) => message.role === 'user',
    ).map((message) => message.content),
    ['initial', 'edited first row', 'duplicate'],
  );
});

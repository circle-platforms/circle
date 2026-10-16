import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import { AgentRuntime } from '../src/runtime.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ScriptedModel } from '../src/testing.js';
import { makeAttachment } from '../src/media.js';
import { defaultSettings } from '../src/settings.js';
import { emptyUsage, type Message } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';
const answer = (content = 'done'): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
});
const picture = (filename = 'one.png') =>
  makeAttachment(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8xkAAAAASUVORK5CYII=',
      'base64',
    ),
    'image/png',
    filename,
  );
const long = Array.from(
  { length: 600 },
  (_, i) => `pasted line ${i + 1}: full original bytes`,
).join('\n');
function runtime(
  home: string,
  workspace: string,
  model = new ScriptedModel([{ message: answer() }]),
  sessionId?: string,
) {
  return new AgentRuntime({
    home,
    userHome: home,
    workspace,
    model,
    sessionId,
    settings: defaultSettings(),
    headless: true,
    bundledExtensions: false,
    screenshot: false,
  });
}
function database(store: CheckpointStore) {
  return (store as unknown as { db: DatabaseSync }).db;
}
function next<T>(child: ReturnType<typeof spawn>, event: string): Promise<T> {
  return new Promise((resolve, reject) => {
    child.once(event, (value: T) => resolve(value));
    child.once('error', reject);
  });
}

test('shutdown preserves exact pending payloads without placing recovered inputs in a fresh Harness or sending them with a new prompt', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let running = runtime(home, workspace);
  cleanup(t, () => running.close());
  const session = running.session.id;
  const media = picture();
  running.harness.shown.set(long, {
    display: '[Pasted text #1 +599 lines]',
    pastes: { '1': long },
  });
  running.harness.queue(long, 'steer', [media]);
  running.harness.queue('next follow-up', 'followUp');
  const ids = running.store.inputs.list(session).map((item) => item.id);
  await running.close();
  const model = new ScriptedModel([
    { message: answer('fresh only') },
    { message: answer('restored steer') },
    { message: answer('restored follow-up') },
  ]);
  running = runtime(home, workspace, model, session);
  const pending = running.harness.recoverableInputs;
  assert.deepEqual(
    pending.items.map((item) => item.id),
    ids,
  );
  assert.equal(pending.items[0]!.payload.text, long);
  assert.equal(
    pending.items[0]!.payload.display,
    '[Pasted text #1 +599 lines]',
  );
  assert.deepEqual(pending.items[0]!.payload.pastes, { '1': long });
  assert.deepEqual(pending.items[0]!.payload.attachments, [media]);
  assert.equal(running.harness.pendingMessageCount, 0);
  assert.equal(model.requests.length, 0);
  await running.harness.run('an unrelated fresh prompt');
  assert.equal(model.requests.length, 1);
  assert.deepEqual(
    model.requests[0]!.messages.filter((item) => item.role === 'user').map(
      (item) => item.content,
    ),
    ['an unrelated fresh prompt'],
  );
  const request = {
    ids,
    expectedVersion: running.harness.recoverableInputs.version,
    operationId: 'human-resume',
    action: 'resume' as const,
  };
  const restored = running.harness.resolveInputs(request);
  assert.equal(restored.applied, true);
  assert.equal(running.harness.resolveInputs(request).applied, false);
  assert.equal(running.harness.pendingMessageCount, 2);
  await running.harness.run();
  const sent = model.requests
    .at(-1)!
    .messages.find((item) => item.id === ids[0])!;
  assert.equal(sent.content, long);
  assert.equal(sent.display, '[Pasted text #1 +599 lines]');
  assert.deepEqual(sent.attachments, [media]);
  assert.equal(running.store.inputs.get(session, ids[0]!)!.state, 'consumed');
  assert.equal(running.harness.recoverableInputs.items.length, 0);
});

test('same text has separate durable identities and media, and taking back one row cannot consume the other', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let running = runtime(home, workspace);
  cleanup(t, () => running.close());
  const id = running.session.id,
    first = picture('first.png'),
    second = picture('second.png');
  running.harness.queue('same text', 'steer', [first]);
  running.harness.queue('same text', 'steer', [second]);
  const inputs = running.store.inputs.list(id);
  assert.notEqual(inputs[0]!.id, inputs[1]!.id);
  const returned = running.harness.takeBack();
  assert.deepEqual(returned[0]!.attachments, [second]);
  assert.equal(running.harness.recoverableInputs.items[0]!.id, inputs[1]!.id);
  await running.harness.run();
  const messages = running.harness.messages.filter(
    (item) => item.role === 'user',
  );
  assert.equal(messages.length, 1);
  assert.equal(messages[0]!.id, inputs[0]!.id);
  assert.deepEqual(messages[0]!.attachments, [first]);
  await running.close();
  running = runtime(home, workspace, undefined, id);
  const recovery = running.harness.recoverableInputs;
  assert.equal(recovery.items.length, 1);
  assert.deepEqual(recovery.items[0]!.payload.attachments, [second]);
  const copy = running.harness.resolveInputs({
    ids: [inputs[1]!.id],
    expectedVersion: recovery.version,
    operationId: 'copy',
    action: 'returnToDraft',
  });
  assert.deepEqual(copy.items[0]!.payload.attachments, [second]);
  assert.equal(
    running.harness.recoverableInputs.items.length,
    1,
    'UI storage failure or reload must leave the original recovery item',
  );
});

test('queued consume and user checkpoint are atomic on failure and a committed input cannot be replayed', () => {
  const store = new CheckpointStore();
  const session = store.create('/tmp/input-outbox-atomic', 'scripted');
  const input = store.inputs.enqueue(session.id, 'epoch', 'steer', {
    text: 'atomic',
    display: 'atomic',
  });
  const version = store.inputs.version(session.id);
  const invalid = answer() as Message & { cycle?: unknown };
  invalid.id = input.id;
  invalid.role = 'user';
  invalid.cycle = invalid;
  assert.throws(
    () => store.appendInput(session.id, input.id, 'epoch', invalid),
    /circular/i,
  );
  assert.equal(store.inputs.get(session.id, input.id)!.state, 'queued');
  assert.equal(store.inputs.version(session.id), version);
  assert.equal(store.messages(session.id).length, 0);
  const message: Message = { id: input.id, role: 'user', content: 'atomic' };
  store.appendInput(session.id, input.id, 'epoch', message);
  assert.equal(store.inputs.get(session.id, input.id)!.state, 'consumed');
  assert.equal(store.messages(session.id)[0]!.id, input.id);
  assert.throws(
    () => store.appendInput(session.id, input.id, 'epoch', message),
    /changed before consumption/,
  );
  assert.equal(store.messages(session.id).length, 1);
  store.inputs.recover(session.id, 'new-epoch');
  assert.deepEqual(store.inputs.recoverable(session.id).items, []);
  store.close();
});

test('enqueue, edit and removal fail before changing live memory if durable writes fail', async (t) => {
  const running = runtime(scratch(t), scratch(t));
  cleanup(t, () => running.close());
  const db = database(running.store),
    harness = running.harness;
  db.exec(
    "CREATE TRIGGER reject_enqueue BEFORE INSERT ON input_outbox BEGIN SELECT RAISE(ABORT,'disk fixture failed'); END",
  );
  assert.throws(() => harness.queue('rejected'), /disk fixture failed/);
  assert.equal(harness.pendingMessageCount, 0);
  db.exec('DROP TRIGGER reject_enqueue');
  harness.queue('original');
  const before = running.store.inputs.list(running.session.id)[0]!;
  db.exec(
    "CREATE TRIGGER reject_change BEFORE UPDATE ON input_outbox BEGIN SELECT RAISE(ABORT,'disk fixture failed'); END",
  );
  assert.throws(
    () => harness.editQueued('steer', 0, 'original', 'edited'),
    /disk fixture failed/,
  );
  assert.throws(
    () => harness.removeQueued('steer', 0, 'original'),
    /disk fixture failed/,
  );
  assert.deepEqual(harness.queuedMessages.steering, ['original']);
  assert.equal(
    running.store.inputs.get(running.session.id, before.id)!.payload.text,
    'original',
  );
  db.exec('DROP TRIGGER reject_change');
  harness.editQueued('steer', 0, 'original', 'edited');
  harness.removeQueued('steer', 0, 'edited');
  assert.equal(
    running.store.inputs.get(running.session.id, before.id)!.state,
    'discarded',
  );
});

test('recovery validates owner, revision and operation identity; copied payload remains durable until explicit discard', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let running = runtime(home, workspace);
  cleanup(t, () => running.close());
  const id = running.session.id;
  running.harness.queue('pending');
  await running.close();
  running = runtime(home, workspace, undefined, id);
  const before = running.harness.recoverableInputs,
    input = before.items[0]!;
  const request = {
    ids: [input.id],
    expectedVersion: before.version,
    operationId: 'copy-safe',
    action: 'returnToDraft' as const,
  };
  const copy = running.harness.resolveInputs(request);
  assert.equal(copy.items[0]!.payload.text, 'pending');
  assert.equal(running.harness.resolveInputs(request).applied, false);
  assert.throws(
    () => running.harness.resolveInputs({ ...request, action: 'resume' }),
    /reused/,
  );
  assert.throws(
    () =>
      running.harness.resolveInputs({
        ...request,
        operationId: 'old',
        expectedVersion: before.version - 1,
      }),
    /changed/,
  );
  assert.throws(
    () =>
      running.harness.resolveInputs({
        ...request,
        operationId: 'foreign',
        ids: ['another-session-input'],
      }),
    /changed/,
  );
  assert.equal(running.harness.pendingMessageCount, 0);
  assert.equal(running.harness.recoverableInputs.items.length, 1);
  running.harness.resolveInputs({
    ...request,
    operationId: 'discard-human',
    action: 'discard',
  });
  assert.equal(running.harness.recoverableInputs.items.length, 0);
  assert.equal(running.store.inputs.get(id, input.id)!.state, 'discarded');
});

test('closing an in-flight resumed request does not replay the consumed input or unknown model result after restart', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let running = runtime(home, workspace);
  cleanup(t, () => running.close());
  const id = running.session.id;
  running.harness.queue('exactly once');
  await running.close();
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const model = new ScriptedModel([
    async (request) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      return { message: answer(), usage: emptyUsage() };
    },
  ]);
  running = runtime(home, workspace, model, id);
  const recoverable = running.harness.recoverableInputs,
    inputId = recoverable.items[0]!.id;
  const resume = {
    ids: [inputId],
    expectedVersion: recoverable.version,
    operationId: 'resume-once',
    action: 'resume' as const,
  };
  running.harness.resolveInputs(resume);
  const active = running.harness.run();
  void active.catch(() => {});
  await seen;
  await running.close();
  await active.catch(() => {});
  const reopened = new ScriptedModel();
  running = runtime(home, workspace, reopened, id);
  assert.equal(running.harness.recoverableInputs.items.length, 0);
  assert.equal(running.harness.resolveInputs(resume).applied, false);
  assert.equal(running.harness.pendingMessageCount, 0);
  assert.equal(reopened.requests.length, 0);
  assert.equal(
    running.harness.messages.filter((message) => message.id === inputId).length,
    1,
  );
});

test('SIGKILL retains acknowledged input bytes and recovers to a list without executing the model', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const runtimeUrl = pathToFileURL(join(process.cwd(), 'src/runtime.ts')).href;
  const settingsUrl = pathToFileURL(
    join(process.cwd(), 'src/settings.ts'),
  ).href;
  const testingUrl = pathToFileURL(join(process.cwd(), 'src/testing.ts')).href;
  const script = `import {AgentRuntime} from ${JSON.stringify(runtimeUrl)};import {defaultSettings} from ${JSON.stringify(settingsUrl)};import {ScriptedModel} from ${JSON.stringify(testingUrl)};const r=new AgentRuntime({home:${JSON.stringify(home)},userHome:${JSON.stringify(home)},workspace:${JSON.stringify(workspace)},settings:defaultSettings(),model:new ScriptedModel(),headless:true,bundledExtensions:false,screenshot:false});r.harness.queue('acknowledged before crash');process.send({sessionId:r.session.id,id:r.store.inputs.list(r.session.id)[0].id});setInterval(()=>{},1000);`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  cleanup(t, () => {
    if (child.exitCode === null) child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const receipt = await next<{ sessionId: string; id: string }>(
    child,
    'message',
  );
  const closed = next(child, 'close');
  child.kill('SIGKILL');
  await closed;
  assert.equal(stderr, '');
  // The killed fixture cannot release its real 30-second lease. Advance only its owned lock timestamp.
  for (const name of await readdir(join(home, 'session-locks')))
    if (name.endsWith('.lock'))
      await utimes(
        join(home, 'session-locks', name),
        new Date(Date.now() - 60000),
        new Date(Date.now() - 60000),
      );
  const model = new ScriptedModel();
  const reopened = runtime(home, workspace, model, receipt.sessionId);
  cleanup(t, () => reopened.close());
  const recovered = reopened.harness.recoverableInputs;
  assert.equal(recovered.items[0]!.id, receipt.id);
  assert.equal(recovered.items[0]!.payload.text, 'acknowledged before crash');
  assert.equal(reopened.harness.pendingMessageCount, 0);
  assert.equal(model.requests.length, 0);
});

test('the originating RPC identity stays idempotent after edit, receipt eviction and restart while equal text with a new identity stays distinct', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let running = runtime(home, workspace);
  cleanup(t, () => running.close());
  const sessionId = running.session.id,
    media = picture();
  const request = { inputId: 'original-rpc', display: 'original display' };
  running.harness.queue('same text', 'followUp', [media], request);
  running.harness.queue('same text', 'followUp', [media], request);
  assert.equal(running.harness.pendingMessageCount, 1);
  running.harness.editQueued('followUp', 0, 'same text', 'edited text');
  running.harness.queue('same text', 'followUp', [media], request);
  assert.deepEqual(running.harness.queuedMessages.followUp, ['edited text']);
  assert.throws(
    () => running.harness.queue('different', 'followUp', [media], request),
    /identity reused/,
  );
  running.harness.queue('same text', 'followUp', [media], {
    ...request,
    inputId: 'genuinely-new-rpc',
  });
  assert.equal(running.harness.pendingMessageCount, 2);
  await running.close();
  running = runtime(home, workspace, undefined, sessionId);
  running.harness.queue('same text', 'followUp', [media], request);
  assert.equal(
    running.harness.pendingMessageCount,
    0,
    'old acknowledged RPC must not auto-resume after restart',
  );
  assert.equal(running.harness.recoverableInputs.items.length, 2);
  const before = running.harness.recoverableInputs;
  running.harness.resolveInputs({
    ids: ['original-rpc'],
    expectedVersion: before.version,
    operationId: 'human-resume-rpc',
    action: 'resume',
  });
  await running.harness.run();
  running.harness.queue('same text', 'followUp', [media], request);
  assert.equal(
    running.harness.pendingMessageCount,
    0,
    'consumed original RPC must never replay',
  );
  assert.equal(
    running.harness.messages.filter((message) => message.id === 'original-rpc')
      .length,
    1,
  );
});

test('explicit user cancellation discards the current live queue while application close preserves it', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let running = runtime(home, workspace);
  cleanup(t, () => running.close());
  const sessionId = running.session.id;
  running.harness.queue('user cancelled');
  const cancelledId = running.store.inputs.list(sessionId)[0]!.id;
  await running.cancel();
  assert.equal(
    running.store.inputs.get(sessionId, cancelledId)!.state,
    'discarded',
  );
  running.harness.queue('preserve for next launch');
  await running.close();
  running = runtime(home, workspace, undefined, sessionId);
  assert.deepEqual(
    running.harness.recoverableInputs.items.map((input) => input.payload.text),
    ['preserve for next launch'],
  );
});

test('a persistence error during cancellation still aborts the running model and retains the unacknowledged discard safely', async (t) => {
  let entered!: () => void;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let aborted = false;
  const model = new ScriptedModel([
    async (request) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            reject(request.signal.reason);
          },
          { once: true },
        ),
      );
      return { message: answer(), usage: emptyUsage() };
    },
  ]);
  const running = runtime(scratch(t), scratch(t), model);
  cleanup(t, () => running.close());
  const active = running.harness.run('held');
  void active.catch(() => {});
  await seen;
  running.harness.queue('retain if disk fails');
  const db = database(running.store);
  db.exec(
    "CREATE TRIGGER reject_cancel BEFORE UPDATE ON input_outbox BEGIN SELECT RAISE(ABORT,'disk fixture failed'); END",
  );
  await assert.rejects(running.harness.cancel(), /disk fixture failed/);
  await active.catch(() => {});
  assert.equal(aborted, true);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(running.harness.queuedMessages.steering, [
    'retain if disk fails',
  ]);
  assert.equal(
    running.store.inputs.list(running.session.id)[0]!.state,
    'queued',
  );
  db.exec('DROP TRIGGER reject_cancel');
});

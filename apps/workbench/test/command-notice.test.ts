import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';

// Issue #302: a command's one-line answer must stay where it was asked. The
// toast is passing; the conversation keeps the row. A bridge stub, as in
// live-runtime.test.ts: it records commands, answers from the fixture
// snapshot, and lets the test republish the transcript as a newer full state.
function bridge(update: RuntimeUpdate) {
  const commands: RuntimeCommand[] = [];
  let listener: ((update: RuntimeUpdate) => void) | undefined;
  const host = {
    update(snapshot: RuntimeUpdate['snapshot']) {
      update = { seq: update.seq + 1, connected: true, snapshot };
      listener?.(update);
    },
    commands,
    async runtimeCommand(command: RuntimeCommand) {
      commands.push(command);
      return { id: command.id, ok: true };
    },
    async runtimeState() {
      return update;
    },
    onRuntime: (callback: (update: RuntimeUpdate) => void) => {
      listener = callback;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as DesktopBridge & {
    commands: RuntimeCommand[];
    update(snapshot: RuntimeUpdate['snapshot']): void;
  };
  return host;
}

function live() {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const host = bridge(update);
  return { runtime: new LiveRuntime(host, update), host };
}

const sessionOf = (runtime: LiveRuntime, id: string) =>
  runtime.getSnapshot().sessions.find((session) => session.id === id);
const kept = (runtime: LiveRuntime, id: string) =>
  sessionOf(runtime, id)!.messages.filter((message) =>
    message.id.startsWith('command-'),
  );

test('a command answer stays in the conversation that asked for it', () => {
  const { runtime, host } = live();
  const asking = runtime.getSnapshot().activeSessionId;
  const before = sessionOf(runtime, asking)!.messages.length;
  let heard = 0;
  runtime.subscribe(() => heard++);
  runtime.appendNotice(asking, 'unknown command /hub');
  assert.equal(heard, 1, 'the window hears the answer');
  const messages = sessionOf(runtime, asking)!.messages;
  assert.equal(messages.length, before + 1);
  assert.equal(messages.at(-1)!.role, 'notice');
  assert.equal(messages.at(-1)!.text, 'unknown command /hub');
  // The runtime republishes the same transcript: the answer is not doubled
  // and not lost when the window rebuilds its copy of the conversation.
  host.update(structuredClone(createFixtures()));
  assert.equal(kept(runtime, asking).length, 1, 'kept exactly once');
  assert.equal(
    sessionOf(runtime, 'session2')!.messages.some(
      (message) => message.text === 'unknown command /hub',
    ),
    false,
    'other conversations do not gain it',
  );
});

test('an answer reaches the conversation that asked, not the one on screen', () => {
  const { runtime } = live();
  assert.notEqual(runtime.getSnapshot().activeSessionId, 'session2');
  runtime.appendNotice('session2', 'mode · plan');
  const other = sessionOf(runtime, 'session2')!.messages;
  assert.equal(other.at(-1)!.role, 'notice');
  assert.equal(other.at(-1)!.text, 'mode · plan');
  assert.equal(
    sessionOf(runtime, 'session1')!.messages.some(
      (message) => message.text === 'mode · plan',
    ),
    false,
    'the conversation on screen gains nothing',
  );
});

test('an answer keeps its order behind the line it followed', () => {
  const { runtime, host } = live();
  const transcript = sessionOf(runtime, 'session2')!.messages.length;
  runtime.appendNotice('session2', 'first answer');
  runtime.appendNotice('session2', 'second answer');
  host.update(structuredClone(createFixtures()));
  const messages = sessionOf(runtime, 'session2')!.messages;
  assert.equal(messages.length, transcript + 2);
  assert.deepEqual(
    messages.slice(transcript).map((message) => message.text),
    ['first answer', 'second answer'],
    'the answers keep their order after the newest transcript line',
  );
});

test('an answer hides with the transcript line it followed', () => {
  const { runtime, host } = live();
  runtime.appendNotice('session2', 'transcript restored');
  const next = structuredClone(createFixtures());
  const branch = next.sessions.find((session) => session.id === 'session2')!;
  branch.messages = branch.messages.filter(
    (message) => message.id !== 'review2',
  );
  branch.leafId = 'review1';
  host.update(next);
  assert.equal(
    kept(runtime, 'session2').length,
    0,
    'a branch that hid the line hides its answer too',
  );
});

test('answers go with the conversation that held them', () => {
  const { runtime, host } = live();
  runtime.appendNotice('session3', 'session renamed');
  const next = structuredClone(createFixtures());
  next.sessions = next.sessions.filter((session) => session.id !== 'session3');
  host.update(next);
  runtime.appendNotice('session3', 'late answer');
  host.update(structuredClone(createFixtures()));
  assert.deepEqual(
    kept(runtime, 'session3'),
    [],
    'a gone conversation drops its answers, and nothing comes back',
  );
});

test('an answer in an empty conversation stays above what comes after', () => {
  const { runtime, host } = live();
  runtime.appendNotice('session3', 'no previous session');
  const next = structuredClone(createFixtures());
  const empty = next.sessions.find((session) => session.id === 'session3')!;
  empty.messages = [
    {
      id: 'later1',
      parentId: null,
      role: 'user',
      text: 'a message asked after the answer',
      at: 'today',
    },
  ];
  host.update(next);
  const messages = sessionOf(runtime, 'session3')!.messages;
  assert.equal(messages[0].role, 'notice');
  assert.equal(messages[0].text, 'no previous session');
});

test('kept answers stay bounded, newest last', () => {
  const { runtime, host } = live();
  for (let index = 1; index <= 45; index++)
    runtime.appendNotice('session1', `answer ${index}`);
  const messages = kept(runtime, 'session1');
  assert.equal(messages.length, 40, 'the oldest answers fall away');
  assert.equal(messages[0].text, 'answer 6');
  assert.equal(messages.at(-1)!.text, 'answer 45');
  host.update(structuredClone(createFixtures()));
  const rebuilt = kept(runtime, 'session1');
  assert.deepEqual(
    rebuilt.map((message) => message.text),
    messages.map((message) => message.text),
    'a republished transcript keeps the same answers in the same order',
  );
});

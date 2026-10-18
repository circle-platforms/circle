import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commandCompletions,
  ownsHomeSubmission,
} from '../src/features/composer-interaction.ts';
import { PreviewRuntime, currentSession } from '../src/model/state.ts';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';

test('home completions include the session builtins and project commands without duplicates', () => {
  const snapshot = createFixtures();
  const known = snapshot.commands[0]!;
  snapshot.commands = [
    { ...known, name: 'editor', description: 'duplicate' },
    { ...known, name: 'project-check', description: 'project command' },
  ];
  assert.equal(
    commandCompletions('/editor', snapshot).filter(
      (item) => item.name === '/editor',
    ).length,
    1,
  );
  assert.equal(
    commandCompletions('/project', snapshot)[0]?.name,
    '/project-check',
  );
  assert.deepEqual(commandCompletions('/editor argument', snapshot), []);
  assert.deepEqual(commandCompletions('plain text', snapshot), []);
});

test('successful home sends do not clear text or attachments edited while the send was pending', () => {
  const attachment = {
    id: 'a',
    name: 'a.txt',
    kind: 'file' as const,
    content: 'before',
  };
  const submitted = { text: 'original', attachments: [attachment] };
  assert.equal(ownsHomeSubmission(submitted, structuredClone(submitted)), true);
  assert.equal(
    ownsHomeSubmission(submitted, { ...submitted, text: 'new draft' }),
    false,
  );
  assert.equal(
    ownsHomeSubmission(submitted, { ...submitted, attachments: [] }),
    false,
  );
  assert.equal(
    ownsHomeSubmission(submitted, {
      ...submitted,
      attachments: [{ ...attachment, content: 'after' }],
    }),
    false,
  );
});

for (const [text, expected] of [
  ['/editor', { dialog: 'editor', selection: undefined }],
  ['/help', { page: 'help' }],
  ['/mode plan', {}],
] as const) {
  test(`preview first command ${text} changes the same command state without storing a user prompt`, () => {
    const runtime = new PreviewRuntime();
    const result = runtime.beginConversation({ text });
    assert.ok('sessionId' in result);
    assert.deepEqual(result.commandResult, expected);
    const session = currentSession(runtime.getSnapshot());
    assert.deepEqual(
      session.messages.filter((item) => item.role === 'user'),
      [],
    );
    assert.notEqual(session.state, 'waiting');
    if (text === '/mode plan') assert.equal(session.readOnly, true);
  });
}

test('live first commands dispatch to their created owner after another session becomes active', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  let update: RuntimeUpdate = { seq: 1, connected: true, snapshot };
  const commands: RuntimeCommand[] = [];
  const firstOwner = structuredClone(snapshot.sessions[0]!);
  firstOwner.id = 'home-command-owner';
  firstOwner.messages = [];
  firstOwner.draft = '';
  const host = {
    onRuntime: () => () => {},
    runtimeState: async () => update,
    runtimeCommand: async (command: RuntimeCommand) => {
      commands.push(command);
      if (command.name === 'begin-session') {
        const next = structuredClone(update.snapshot);
        next.sessions.push(firstOwner);
        // A user navigates away while session preparation is in flight.
        next.activeSessionId = snapshot.activeSessionId;
        update = { ...update, seq: update.seq + 1, snapshot: next };
        return { id: command.id, ok: true, data: { sessionId: firstOwner.id } };
      }
      return { id: command.id, ok: true };
    },
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, update);
  const result = await runtime.beginConversation({
    text: '/mode plan',
    mode: 'manual',
  });
  assert.deepEqual(result, { sessionId: firstOwner.id, commandResult: {} });
  assert.deepEqual(
    commands.map((item) => item.name),
    ['begin-session', 'set-mode'],
  );
  assert.equal(commands[0]!.payload.prepareOnly, true);
  assert.equal(commands[1]!.sessionId, firstOwner.id);
  assert.equal(commands[1]!.payload.mode, 'plan');
  assert.equal(
    commands.some((item) => item.name === 'prompt'),
    false,
  );
  assert.equal(runtime.getSnapshot().activeSessionId, snapshot.activeSessionId);
  runtime.dispose();
});

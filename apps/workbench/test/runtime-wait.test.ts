import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type {
  DesktopBridge,
  RuntimeCommandWait,
} from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeReply,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';
import { setLanguage } from '../src/i18n/index.ts';

const TIMEOUT =
  'runtime command timed out; execution state must be checked · prompt (120s)';

/** A bridge whose answers the test hands over when it wants the window to wait. */
function heldBridge() {
  const commands: RuntimeCommand[] = [];
  const deferred: {
    resolve: (reply: RuntimeReply) => void;
    command: RuntimeCommand;
  }[] = [];
  let update: RuntimeUpdate;
  let listener: ((update: RuntimeUpdate) => void) | undefined;
  let waitListener: ((wait: RuntimeCommandWait | null) => void) | undefined;
  const host = {
    commands,
    deferred,
    /** The next command goes unanswered until the test answers it. */
    hold() {
      return {
        command: deferred.at(-1)?.command,
        answer: (reply: RuntimeReply) => deferred.shift()?.resolve(reply),
      };
    },
    wait(wait: RuntimeCommandWait | null) {
      waitListener?.(wait);
    },
    publish(next: RuntimeUpdate['snapshot']) {
      update = { seq: update.seq + 1, connected: true, snapshot: next };
      listener?.(update);
    },
    async runtimeCommand(command: RuntimeCommand) {
      commands.push(command);
      return new Promise<RuntimeReply>((resolve) => {
        deferred.push({ resolve, command });
      });
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
    onRuntimeWait: (callback: (wait: RuntimeCommandWait | null) => void) => {
      waitListener = callback;
      return () => {
        waitListener = undefined;
      };
    },
  } as unknown as DesktopBridge & {
    commands: RuntimeCommand[];
    deferred: { resolve: (reply: RuntimeReply) => void }[];
    hold(): { command?: RuntimeCommand; answer(reply: RuntimeReply): void };
    wait(wait: RuntimeCommandWait | null): void;
    publish(snapshot: RuntimeUpdate['snapshot']): void;
  };
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  update = { seq: 0, connected: true, snapshot };
  return { host, update };
}

const settle = async () => {
  for (let step = 0; step < 4; step++)
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
};

test('a command the runtime keeps is said in the window, and its end takes the word back', () => {
  const { host, update } = heldBridge();
  const runtime = new LiveRuntime(host, update);
  assert.equal(runtime.getSnapshot().runtime?.waiting, undefined);
  host.wait({
    id: 'one',
    name: 'custom-command',
    sessionId: 'session-a',
    waitedMs: 4200,
  });
  const waiting = runtime.getSnapshot().runtime?.waiting;
  assert.deepEqual(
    waiting,
    { command: 'custom-command', sessionId: 'session-a', waitedMs: 4200 },
    'the wait names the conversation that asked, so only it shows the line',
  );
  host.wait({ id: 'one', name: 'custom-command', waitedMs: 9200 });
  assert.equal(
    runtime.getSnapshot().runtime?.waiting?.waitedMs,
    9200,
    'the wait is restated as it grows',
  );
  host.wait(null);
  assert.equal(runtime.getSnapshot().runtime?.waiting, undefined);
  runtime.dispose();
});

test('a command that timed out leaves a card to act on, even for a conversation the runtime never sent', async () => {
  setLanguage('en');
  const { host, update } = heldBridge();
  const runtime = new LiveRuntime(host, update);
  const first = runtime.getSnapshot().activeSessionId;
  const second = runtime.getSnapshot().sessions[1]!.id;
  runtime.updateSessionView(second, { draft: 'fix the reconnect race' });
  const sent = runtime.send('steering', second);
  await settle();
  const held = host.hold();
  assert.equal(held.command?.name, 'prompt');
  // The channel froze: the state the window has now does not carry that row.
  host.publish({
    ...runtime.getSnapshot(),
    activeSessionId: first,
    sessions: runtime
      .getSnapshot()
      .sessions.filter((session) => session.id === first),
  });
  held.answer({ id: 'x', ok: false, error: TIMEOUT });
  await assert.rejects(() => sent);
  await settle();
  const shown = runtime
    .getSnapshot()
    .sessions.find((session) => session.id === first);
  assert.ok(shown?.actionFailure, 'the failure is shown where the person is');
  assert.equal(shown!.actionFailure!.kind, 'timeout');
  assert.match(
    shown!.actionFailure!.message,
    /Circle did not answer in 120s · prompt/,
  );
  assert.equal(shown!.actionFailure!.detail, TIMEOUT);
  assert.equal(
    shown!.actionFailure!.retry,
    undefined,
    'a message that timed out may still run: sending it again could send it twice',
  );
  runtime.dispose();
});

test('a slash command that failed is retried by name, one that timed out is not', async () => {
  setLanguage('en');
  const { host, update } = heldBridge();
  const runtime = new LiveRuntime(host, update);
  const session = runtime.getSnapshot().activeSessionId;
  const failed = runtime.command('hello', 'friend', session);
  await settle();
  const held = host.hold();
  assert.equal(held.command?.name, 'custom-command');
  assert.deepEqual(held.command?.payload, { name: 'hello', args: 'friend' });
  held.answer({
    id: 'x',
    ok: false,
    error:
      'runtime command timed out; execution state must be checked · custom-command (120s)',
  });
  await assert.rejects(() => failed);
  await settle();
  assert.equal(
    runtime.getSnapshot().sessions.find((s) => s.id === session)!.actionFailure
      ?.retry,
    undefined,
  );
  const refused = runtime.command('hello', 'friend', session);
  await settle();
  host.hold().answer({ id: 'w', ok: false, error: 'hub is not reachable' });
  await assert.rejects(() => refused);
  await settle();
  const row = runtime.getSnapshot().sessions.find((s) => s.id === session)!;
  assert.deepEqual(row.actionFailure?.retry, {
    kind: 'command',
    name: 'hello',
    args: 'friend',
  });
  host.commands.length = 0;
  const retry = runtime.retryActionFailure!(session);
  await settle();
  host.hold().answer({ id: 'y', ok: true, data: {} });
  await retry;
  assert.deepEqual(
    host.commands.map((command) => [command.name, command.payload]),
    [['custom-command', { name: 'hello', args: 'friend' }]],
  );
  runtime.dispose();
});

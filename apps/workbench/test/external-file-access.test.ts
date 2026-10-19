import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';

test('external-file list and revoke preserve exact owner and prior conversation failure', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const owner = snapshot.activeSessionId;
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const calls: RuntimeCommand[] = [];
  const host = {
    onRuntime: () => () => {},
    runtimeState: async () => update,
    runtimeCommand: async (command: RuntimeCommand) => {
      calls.push(command);
      return {
        id: command.id,
        ok: false,
        error:
          command.name === 'compact'
            ? 'prior conversation failure'
            : 'synthetic file access failure',
      };
    },
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, update);
  await assert.rejects(
    runtime.request('compact', {}, owner),
    /prior conversation failure/,
  );
  const prior = runtime
    .getSnapshot()
    .sessions.find((session) => session.id === owner)?.actionError;
  assert.ok(prior?.includes('prior conversation failure'));
  const alternate = snapshot.sessions.find((session) => session.id !== owner)!;
  // Receiving a new selected owner must not retarget capability management.
  runtime.change((state) => {
    state.activeSessionId = alternate.id;
  });
  await assert.rejects(
    runtime.request('list-external-file-grants', {}, owner),
    /synthetic file access failure/,
  );
  await assert.rejects(
    runtime.request(
      'revoke-external-file-grant',
      { id: 'opaque-native-token' },
      owner,
    ),
    /synthetic file access failure/,
  );
  assert.deepEqual(
    calls.slice(-2).map((call) => ({
      name: call.name,
      sessionId: call.sessionId,
      payload: call.payload,
    })),
    [
      { name: 'list-external-file-grants', sessionId: owner, payload: {} },
      {
        name: 'revoke-external-file-grant',
        sessionId: owner,
        payload: { id: 'opaque-native-token' },
      },
    ],
  );
  assert.equal(
    runtime.getSnapshot().sessions.find((session) => session.id === owner)
      ?.actionError,
    prior,
  );
  assert.equal(
    runtime
      .getSnapshot()
      .sessions.find((session) => session.id === alternate.id)?.actionError,
    undefined,
  );
  runtime.dispose();
});

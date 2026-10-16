import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import { prepareGitHubExample } from '../src/model/github-example.ts';
import type { RuntimePort } from '../src/model/types.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
test('plugin example preserves latest draft and attachments without model or authorization requests', () => {
  const snapshot = createFixtures();
  const calls: unknown[] = [];
  const runtime = new LiveRuntime(
    {
      onRuntime: () => () => {},
      runtimeCommand: async (command: unknown) => {
        calls.push(command);
        return { ok: true };
      },
    } as unknown as DesktopBridge,
    { seq: 0, connected: true, snapshot },
  );
  const id = snapshot.activeSessionId;
  runtime.updateSessionView(id, {
    draft: 'latest human draft',
    attachments: [
      {
        id: 'keep',
        kind: 'image',
        name: 'keep.png',
        mime: 'image/png',
        content: 'bytes',
      },
    ],
  });
  const origin = {
    sessionId: id,
    epoch: (runtime as RuntimePort).presentationEpoch,
  };
  const prepared = prepareGitHubExample(runtime, origin, 'read status only');
  assert.equal(prepared.saved, true);
  const session = runtime.getSnapshot().sessions.find((s) => s.id === id)!;
  assert.equal(session.draft, 'latest human draft\n\nread status only');
  assert.equal(session.attachments[0].id, 'keep');
  assert.deepEqual(calls, []);
  runtime.dispose();
});
test('failed persistence retries the same prepared draft without duplicating text', () => {
  let fail = true;
  const storage = {
    getItem: () => null,
    setItem: () => {
      if (fail) throw Error('quota');
    },
    removeItem: () => {},
  };
  const snapshot = createFixtures();
  const runtime = new LiveRuntime(
    { onRuntime: () => () => {} } as unknown as DesktopBridge,
    { seq: 0, connected: true, snapshot },
    storage,
  );
  const origin = {
    sessionId: snapshot.activeSessionId,
    epoch: (runtime as RuntimePort).presentationEpoch,
  };
  const first = prepareGitHubExample(runtime, origin, 'read status');
  assert.equal(first.saved, false);
  runtime.updateSessionView(origin.sessionId, {
    draft: first.draft + '\nadditional human edit',
  });
  fail = false;
  const retry = prepareGitHubExample(runtime, origin, 'read status', first);
  assert.equal(retry.saved, true);
  assert.equal(retry.draft, first.draft + '\nadditional human edit');
  assert.equal(retry.draft.split('read status').length, 2);
  assert.throws(
    () =>
      prepareGitHubExample(
        runtime,
        { ...origin, epoch: (origin.epoch ?? 0) + 1 },
        'late',
      ),
    /original conversation changed/,
  );
  runtime.dispose();
});

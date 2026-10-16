import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { PreviewRuntime } from '../src/model/state.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';
test('extension setting request awaits the native save result without optimistic runtime activation', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  snapshot.extensions = [
    {
      id: 'github',
      name: 'github',
      version: '0.1.0',
      scope: 'bundled',
      enabled: false,
      tools: [],
      commands: [],
      events: [],
    },
  ];
  const calls: RuntimeCommand[] = [];
  let answer!: (reply: unknown) => void;
  const host = {
    runtimeCommand: async (command: RuntimeCommand) => {
      calls.push(command);
      return await new Promise((resolve) => {
        answer = resolve;
      });
    },
    onRuntime: () => () => {},
    runtimeState: async () => update,
  } as unknown as DesktopBridge;
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const runtime = new LiveRuntime(host, update);
  const result = runtime.request('extension.enabled', {
    name: 'github',
    enabled: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'save-settings');
  assert.deepEqual(calls[0].payload, {
    settings: {},
    extensions: [{ name: 'github', enabled: true }],
  });
  assert.equal(runtime.getSnapshot().extensions[0].enabled, false);
  answer({ id: calls[0].id, ok: false, error: 'synthetic disk failure' });
  await assert.rejects(result, /synthetic disk failure/);
  assert.equal(runtime.getSnapshot().extensions[0].enabled, false);
  assert.equal(
    runtime
      .getSnapshot()
      .sessions.find((item) => item.id === snapshot.activeSessionId)
      ?.actionError,
    undefined,
    'a settings failure is handled in its row',
  );
  runtime.dispose();
});
test('preview extension switch remains a local setting and records no executed operation', () => {
  const runtime = new PreviewRuntime();
  const name = runtime.getSnapshot().extensions[0].name;
  const id = runtime.request('extension.enabled', { name, enabled: false });
  assert.equal(
    runtime.getSnapshot().extensions.find((item) => item.name === name)
      ?.enabled,
    false,
  );
  assert.equal(
    runtime.getSnapshot().requests.find((item) => item.id === id)?.status,
    'not sent',
  );
});

test('extension row requests preserve an existing conversation failure', async () => {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const host = {
    onRuntime: () => () => {},
    runtimeState: async () => update,
    runtimeCommand: async (command: RuntimeCommand) => ({
      id: command.id,
      ok: command.name !== 'shell',
      ...(command.name === 'shell'
        ? { error: 'prior conversation command failed' }
        : {}),
    }),
  } as unknown as DesktopBridge;
  const runtime = new LiveRuntime(host, update);
  await assert.rejects(
    runtime.request('execute', { command: 'synthetic failed command' }),
    /prior conversation command failed/,
  );
  const prior = runtime
    .getSnapshot()
    .sessions.find((item) => item.id === snapshot.activeSessionId)!.actionError;
  assert.match(prior!, /prior conversation command failed/);
  await runtime.request('extension.enabled', {
    name: 'github',
    enabled: false,
  });
  assert.equal(
    runtime
      .getSnapshot()
      .sessions.find((item) => item.id === snapshot.activeSessionId)!
      .actionError,
    prior,
  );
  runtime.dispose();
});

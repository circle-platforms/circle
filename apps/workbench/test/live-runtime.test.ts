import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';

// A bridge stub that records the commands the window sends and answers them
// with the fixture snapshot, as the runtime worker would.
function bridge(update: RuntimeUpdate) {
  const commands: RuntimeCommand[] = [];
  const host = {
    commands,
    async runtimeCommand(command: RuntimeCommand) {
      commands.push(command);
      return { id: command.id, ok: true };
    },
    async runtimeState() {
      return update;
    },
    onRuntime: () => () => {},
  } as unknown as DesktopBridge & { commands: RuntimeCommand[] };
  return host;
}
function live() {
  const snapshot = createFixtures();
  snapshot.runtime = { connected: true, configured: true };
  const update: RuntimeUpdate = { seq: 0, connected: true, snapshot };
  const host = bridge(update);
  return { runtime: new LiveRuntime(host, update), host };
}

test('settings changes never carry the default workspace folders', async () => {
  const { runtime, host } = live();
  runtime.change((state) => {
    state.settings.theme = 'dark';
    // A draft that touches the controller-owned keys must not smuggle them
    // into the batched save-settings command.
    state.settings.workspaceFolder = '/tmp/forged';
    state.settings.oldWorkspaceFolder = '/tmp/also-forged';
  });
  // request() flushes the queued change first, then sends its own command.
  await runtime.request('set-default-workspace', { workspaceGrant: 'grant-1' });
  assert.deepEqual(
    host.commands.map((command) => command.name),
    ['save-settings', 'set-default-workspace'],
  );
  const settings = host.commands[0]!.payload.settings as Record<
    string,
    unknown
  >;
  assert.equal(settings.theme, 'dark');
  assert.equal('workspaceFolder' in settings, false);
  assert.equal('oldWorkspaceFolder' in settings, false);
  // The folder itself travels only as the native dialog's grant id.
  assert.deepEqual(host.commands[1]!.payload, { workspaceGrant: 'grant-1' });
});

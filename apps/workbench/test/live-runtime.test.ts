import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveRuntime } from '../src/model/live.ts';
import { createFixtures } from '../src/preview/fixtures.ts';
import type { DesktopBridge } from '../../desktop/src/contracts.ts';
import type {
  RuntimeCommand,
  RuntimeUpdate,
} from '../../desktop/src/runtime-protocol.ts';

test('hub object pages disclose byte-budget omissions instead of claiming nothing was read', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { HubProjectionNotice } = await import('../src/plugins/hub');
  const { setLanguage } = await import('../src/i18n/index.ts');
  const storage = {
    getItem: () => null,
    setItem: () => {},
  } as unknown as Storage;
  setLanguage('en', storage);
  const projection = {
    byteLimit: 65536,
    shownItems: 300,
    omittedItems: 2500,
    shortenedFields: 4,
  };
  const english = renderToStaticMarkup(
    createElement(HubProjectionNotice, { projection }),
  );
  assert.match(english, /300 shown, 2500 omitted/);
  assert.match(english, /65536 byte budget/);
  assert.match(english, /4 text fields shortened/);
  assert.match(english, /full task details and results remain on hub/);
  assert.match(english, /counts apply to the records returned by this refresh/);
  assert.equal(
    renderToStaticMarkup(createElement(HubProjectionNotice, {})),
    '',
  );
  setLanguage('zh-CN', storage);
  const chinese = renderToStaticMarkup(
    createElement(HubProjectionNotice, { projection }),
  );
  assert.match(chinese, /显示 300 项，省略 2500 项/);
  assert.match(chinese, /65536 字节预算/);
  setLanguage('en', storage);
});

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

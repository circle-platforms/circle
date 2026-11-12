// What the desktop keeps of the Hub extension's MCP entry: an entry connected with an earlier version gets the
// placeholders a Hub's skills use when the desktop starts, and the extension's switch turns the entry off and on, and
// nothing else does. In-process controller, scripted model, isolated home; the Hub's address answers nothing.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { RuntimeCommandName } from '../src/runtime-protocol.ts';

const placeholders = { url: 'HUB_URL', token: 'HUB_TOKEN' };
// Nothing listens on the discard port: connecting the entry fails at once
const legacy = {
  name: 'Hub',
  url: 'http://127.0.0.1:9/mcp',
  transport: 'streamable_http',
  enabled: true,
};

async function start(t: TestContext, hubOn: boolean, entry = legacy) {
  const root = realpathSync.native(
    await mkdtemp(join(tmpdir(), 'circle-desktop-hub-settings-')),
  );
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcp_servers = [{ ...entry }];
  settings.extensions = { ...settings.extensions, hub: { enabled: hubOn } };
  saveSettings(settings, home);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([
      { message: { id: 'idle', role: 'assistant', content: 'idle' } },
    ]),
    emit: () => {},
  });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (
    name: RuntimeCommandName,
    payload: Record<string, unknown>,
  ) => {
    const reply = await controller.dispatch({
      id: randomUUID(),
      name,
      payload,
      sessionId: controller.snapshot().activeSessionId,
    });
    assert.equal(reply.ok, true, reply.error);
    return reply;
  };
  const hub = () =>
    loadSettings(home).mcp_servers.find((row) => row.name === 'Hub');
  return { call, hub };
}

test('a Hub entry connected with an earlier version gets the placeholders when the desktop starts, while its extension is on', async (t) => {
  const on = await start(t, true);
  assert.deepEqual(on.hub(), { ...legacy, placeholders });
  // The extension off: the entry is not the extension's to change
  const off = await start(t, false);
  assert.deepEqual(off.hub(), legacy);
  // An entry that names its own placeholders keeps them
  const own = await start(t, true, {
    ...legacy,
    placeholders: { url: 'MY_HUB' },
  } as typeof legacy);
  assert.deepEqual(own.hub()?.placeholders, { url: 'MY_HUB' });
});

test("the Hub extension's switch turns its entry off and on, and switching another extension leaves it as it is", async (t) => {
  const { call, hub } = await start(t, false);
  const save = (name: string, enabled: boolean) =>
    call('save-settings', { settings: {}, extensions: [{ name, enabled }] });
  // On: the entry stays on and gets the placeholders it lacked
  await save('hub', true);
  assert.deepEqual(hub(), { ...legacy, placeholders });
  await save('hub', false);
  assert.equal(hub()?.enabled, false);
  await save('hub', true);
  assert.equal(hub()?.enabled, true);
  // Another extension's switch does not touch the Hub entry, also one turned off by hand while the extension is on
  await call('save-settings', {
    settings: {},
    mcp: [{ ...legacy, id: 'Hub', enabled: false }],
  });
  assert.equal(hub()?.enabled, false);
  await save('github', false);
  assert.equal(hub()?.enabled, false);
});

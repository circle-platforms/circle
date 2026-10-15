import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import { RuntimeController } from '../src/runtime-controller.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  saveSettings,
  trustFolder,
  defaultSettings,
} from '../../../src/settings.ts';
import {
  performanceMessages,
  PERFORMANCE_RAW_MESSAGES,
  PERFORMANCE_PROJECTED_MESSAGES,
} from './helpers/native-performance-fixture.mjs';
test('native stress fixture has ten thousand actual projected messages after tool result pairing', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'circle-perf-fixture-'));
  const home = join(temp, 'home'),
    workspace = join(temp, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const id = 'fixture-perf';
  const store = new CheckpointStore(home);
  store.create(workspace, 'fixture', 'performance history', id);
  store.append(
    id,
    performanceMessages({ png: 'AAEC', log: '600 line fixture result' }),
  );
  assert.equal(store.messages(id).length, PERFORMANCE_RAW_MESSAGES);
  store.close();
  await writeFile(
    join(home, 'desktop-session.json'),
    JSON.stringify({ workspace, sessionId: id }),
  );
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  try {
    const projected = controller
      .snapshot()
      .sessions.find((session) => session.id === id);
    assert.equal(projected.messages.length, PERFORMANCE_PROJECTED_MESSAGES);
    assert.ok(
      projected.messages.some((message) =>
        message.text.includes('PERF_HISTORY_READY'),
      ),
    );
    assert.equal(
      projected.messages.filter(
        (message) => message.tool?.output === '600 line fixture result',
      ).length,
      1,
    );
  } finally {
    await controller.close();
    await rm(temp, { recursive: true, force: true });
  }
});

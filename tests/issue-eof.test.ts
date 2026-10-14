import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionApp } from '../src/tui/session_app.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { cleanup, scratch } from './helpers.js';

test('TUI file pagination past EOF is successful, can recover, and keeps its results on disk (#21)', async (t) => {
  const home = scratch(t);
  const workspace = scratch(t);
  writeFileSync(join(workspace, 'source.txt'), 'alpha\nbeta\n');
  const model = new ScriptedModel([
    ...[2, 120, 0].map((offset, i) => ({
      message: {
        id: `read-${i}`,
        role: 'assistant' as const,
        content: '',
        tool_calls: [
          {
            id: `page-${i}`,
            name: 'read_file',
            args: { file_path: 'source.txt', offset, limit: 20 },
          },
        ],
      },
    })),
    {
      message: {
        id: 'finished',
        role: 'assistant',
        content: 'read both lines',
      },
    },
  ]);
  const settings = defaultSettings();
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  await app.attach({ workspace, home, settings, model, headless: true });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    if (ui.animation) clearInterval(ui.animation);
    ui.input.close();
    await app.runtime!.close();
  });
  await app.runtime!.harness.run('Read the file in pages');
  const results = model.requests[3]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.deepEqual(
    results.map((message) => message.status),
    ['success', 'success', 'success'],
  );
  assert.match(results[0]!.content, /offset 2.*2 lines/);
  assert.match(results[1]!.content, /offset 120.*2 lines/);
  assert.equal(results[2]!.content, '1: alpha\n2: beta');
  assert.equal(
    app.state.notices.some((line) => /exceeds file length/.test(line)),
    false,
  );
  const id = app.runtime!.session.id;
  await app.runtime!.close();
  const store = new CheckpointStore(home);
  cleanup(t, () => store.close());
  assert.deepEqual(
    store.messages(id).filter((message) => message.role === 'tool'),
    results,
  );
});

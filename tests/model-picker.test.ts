import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { stripAnsi } from '../src/ink/string_width.js';
import { matchesModel, modelScope } from '../src/model_scope.js';
import { Picker } from '../src/ink/components/picker.js';
import { AgentRuntime } from '../src/runtime.js';
import { SessionApp } from '../src/tui/session_app.js';
import { GatewayModel } from '../src/model.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  saveCredentials,
} from '../src/settings.js';
import { defaultRunOptions } from '../src/run_options.js';
import { cleanup, scratch } from './helpers.js';

test('model scopes preserve order, match case-insensitive wildcards/ranges across provider prefixes and retain unlisted explicit IDs', () => {
  assert.deepEqual(
    modelScope(
      ['openai/gpt-a', 'claude-b', 'claude-c'],
      ['CLAUDE-[b-c]', 'openai/*', 'custom', 'claude-b'],
      'unlisted',
    ),
    ['claude-b', 'claude-c', 'openai/gpt-a', 'custom'],
  );
  assert.deepEqual(modelScope(['b', 'a'], [], 'custom'), ['custom', 'b', 'a']);
  assert.deepEqual(modelScope(['a'], ['none*'], 'a'), []);
  for (const [pattern, input, expected] of [
    ['[!a]', 'b', true],
    ['[]a]', ']', true],
    ['[^a]', '^', true],
    ['x[', 'x[', true],
    ['model?', 'model1', true],
    ['model.', 'modelx', false],
  ] as const)
    assert.equal(matchesModel(pattern, input), expected);
});

test('picker action keys operate on filtered focus and preserve it when items are refreshed', () => {
  const chosen: string[] = [];
  const picker = new Picker(
    'models',
    [
      { key: 'a', label: 'model a' },
      { key: 'b', label: 'model b' },
    ],
    (item) => chosen.push(item.key),
    () => {},
    {
      hint: 'ctrl+s saves',
      keys: {
        tab: (item) => {
          if (item) chosen.push('tab:' + item.key);
        },
      },
    },
  );
  picker.handle('ctrl+n', '');
  picker.handle('tab', '');
  picker.setItems([
    { key: 'b', label: 'model b', current: true },
    { key: 'a', label: 'model a' },
  ]);
  picker.handle('enter', '');
  assert.deepEqual(chosen, ['tab:b', 'b']);
  picker.query = 'missing';
  picker.handle('tab', '');
  assert.equal(chosen.length, 2);
});

test('picker search filters every word from the cached haystack and replays a repeated query', () => {
  const picker = new Picker(
    'sessions',
    [
      { key: 'a', label: 'Session A', search: 'Alpha text about pipelines' },
      { key: 'b', label: 'Session B', search: 'Beta text' },
      { key: 'c', label: 'Session C', meta: 'alpha', search: 'Gamma' },
    ],
    () => {},
    () => {},
  );
  assert.deepEqual(
    picker.matches().map((item) => item.key),
    ['a', 'b', 'c'],
  );
  for (const char of 'ALPH') picker.handle('', char);
  assert.equal(picker.query, 'ALPH');
  assert.deepEqual(
    picker.matches().map((item) => item.key),
    ['a', 'c'],
    'the search stays case-insensitive',
  );
  const memo = picker.matches();
  assert.equal(picker.matches(), memo, 'a repeated query replays its result');
  picker.handle('', ' ');
  picker.handle('', 'g');
  assert.equal(picker.query, 'ALPH g');
  assert.deepEqual(
    picker.matches().map((item) => item.key),
    ['c'],
    'every word must appear',
  );
  assert.notEqual(picker.matches(), memo);
  // Navigation and rendering keep working from the filtered list.
  picker.handle('ctrl+u', '');
  picker.handle('', 'b');
  assert.deepEqual(
    picker.matches().map((item) => item.key),
    ['a', 'b'],
  );
  picker.handle('down', '');
  assert.equal(picker.focus, 1);
  const lines = picker.rows(60, 10).map(stripAnsi);
  assert.ok(lines.some((line) => line.includes('Session B')));
  assert.ok(!lines.some((line) => line.includes('Session C')));
  // A refreshed list filters through the same search.
  picker.setItems([{ key: 'z', label: 'Session Z', search: 'b replaced' }]);
  assert.deepEqual(
    picker.matches().map((item) => item.key),
    ['z'],
  );
});

for (const scopedRun of [false, true])
  test(`terminal model/effort actions use real discovery and preserve ${scopedRun ? 'run-only scope' : 'account defaults'}`, async (t) => {
    const root = scratch(t);
    let discoveryCount = 0;
    const server = createServer((request, response) => {
      discoveryCount++;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }));
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    cleanup(t, async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const saved = defaultSettings();
    saved.auth.base_url = `http://127.0.0.1:${address.port}/v1`;
    saved.auth.model = 'a';
    saved.theme = 'dark';
    saved.future = 'keep';
    saveSettings(saved, root);
    saveCredentials({ api_key: 'fixture' }, root);
    const settings = structuredClone(saved);
    settings.theme = 'light'; // A project override must not become an account default.
    const run = defaultRunOptions();
    if (scopedRun) run.models = ['a'];
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings,
      run,
      model: new GatewayModel(settings, root),
      headless: true,
    });
    cleanup(t, () => runtime.close());
    const app = new SessionApp(root, root, settings);
    app.runtime = runtime;
    const ui = app as any;
    ui.screen.render = () => {};
    cleanup(t, () => {
      if (ui.flashTimer) clearTimeout(ui.flashTimer);
      ui.input.close();
    });
    const key = async (value: string): Promise<void> => {
      ui.handle({ type: 'key', key: value, char: '' });
      await delay(10);
    };
    await app.command('models', '');
    assert.match(
      app.state.picker!.rows(100).map(stripAnsi).join('\n'),
      /● a · current/,
    );
    app.state.picker!.query = 'b';
    await key('tab');
    assert.deepEqual(
      scopedRun ? run.models : loadSettings(root).enabled_models,
      scopedRun ? ['a', 'b'] : ['b'],
    );
    if (scopedRun) assert.deepEqual(loadSettings(root).enabled_models, []);
    else await key('tab');
    await key('enter');
    assert.equal(runtime.harness.model.model, 'b');
    assert.equal(loadSettings(root).auth.model, 'a');
    const beforeCycle = discoveryCount;
    await key('alt+m');
    assert.equal(runtime.harness.model.model, 'a');
    assert.equal(discoveryCount, beforeCycle);
    await key('alt+t');
    assert.equal(runtime.thinkingLevel, 'minimal');
    await app.command('models', '');
    app.state.picker!.query = 'b';
    await key('alt+d');
    assert.equal(loadSettings(root).auth.model, 'b');
    assert.equal(loadSettings(root).theme, 'dark');
    assert.equal(loadSettings(root).future, 'keep');
    await app.command('effort', '');
    app.state.picker!.query = 'medium';
    await key('alt+d');
    assert.equal(loadSettings(root).default_thinking, 'medium');
    assert.equal(loadSettings(root).theme, 'dark');
    assert.equal(runtime.thinkingLevel, 'medium');
    await app.command('models', 'nosuch-model-x');
    assert.match(app.state.flash, /model set to nosuch-model-x/);
    assert.match(app.state.flash, /not listed by this endpoint/);
    assert.equal(app.state.flash.includes('  '), false, app.state.flash);
    const transcript = app.state.notices.at(-1) ?? '';
    assert.match(transcript, /model set to nosuch-model-x/);
    assert.match(transcript, /not listed by this endpoint/);
    assert.equal(transcript.includes('  '), false, transcript);
    assert.equal(runtime.harness.model.model, 'nosuch-model-x');
  });

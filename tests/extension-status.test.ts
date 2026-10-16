import { scratch } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionHost } from '../src/extensions.js';
import { ExtensionSecrets } from '../src/extension_secrets.js';
import { footerRow } from '../src/tui/status_rows.js';
import { stringWidth, stripAnsi } from '../src/ink/string_width.js';
import { emptyUsage } from '../src/types.js';

const schema = '{type:"object",properties:{}}';
const meters = {
  usage: emptyUsage(),
  costText: '$0.00',
  contextInput: 0,
  contextWindow: 0,
};

test('an extension status stays at the right of the footer, gives way to a flash and is dropped whole when it does not fit', () => {
  const status = [{ text: 'hub · tester', lamp: 'ok' as const }];
  const wide = footerRow(meters, '', 100, status);
  const plain = stripAnsi(wide);
  assert.equal(stringWidth(plain), 100);
  assert.ok(plain.endsWith('● hub · tester '));
  assert.match(plain, /^ ↑/);
  const flashing = stripAnsi(footerRow(meters, 'Copied', 100, status));
  assert.ok(!flashing.includes('hub'));
  assert.ok(flashing.trimEnd().endsWith('Copied'));
  const narrow = stripAnsi(footerRow(meters, '', 40, status));
  assert.ok(!narrow.includes('hub'));
  assert.equal(narrow, stripAnsi(footerRow(meters, '', 40)));
  const unlit = stripAnsi(
    footerRow(meters, '', 100, [{ text: 'syncing', lamp: 'none' }]),
  );
  assert.ok(unlit.endsWith(' syncing ') && !unlit.includes('●'));
});

test('setStatus keeps one line per extension, masks secrets, redraws on change and refuses unknown lamps', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  await new ExtensionSecrets(home, 'status').set('token', 'tok-9f8e7d6c5b');
  const path = join(home, 'extensions', 'status');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'extension.mjs'),
    `export function register(api){
      api.registerTool('show','show',${schema},async(args)=>{
        const token = await api.secrets.get('token');
        api.setStatus('line one\\nline two · ' + token, 'running');
        api.setStatus('line one\\nline two · ' + token, 'running');
        return 'ok';
      },{readOnly:true});
      api.registerTool('clear','clear',${schema},()=>{api.setStatus(null);return 'ok'},{readOnly:true});
      api.registerTool('bad','bad',${schema},()=>{api.setStatus('x','purple');return 'ok'},{readOnly:true});
    }`,
  );
  let redraws = 0;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
    onStatus: () => redraws++,
  }).load();
  const context = {
    signal: new AbortController().signal,
    sessionId: 'test',
  } as never;
  const tool = (name: string) =>
    host.tools().find((item) => item.name === name)!;
  await tool('show').run({}, context);
  assert.deepEqual(host.statuses(), [
    { extension: 'status', text: 'line one line two · ***', lamp: 'running' },
  ]);
  assert.equal(redraws, 1);
  await tool('clear').run({}, context);
  assert.deepEqual(host.statuses(), []);
  assert.equal(redraws, 2);
  await assert.rejects(
    async () => tool('bad').run({}, context),
    /unknown lamp/,
  );
});

test('setView publishes data for an interface of the extension, masked, bounded and redrawn on change', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  await new ExtensionSecrets(home, 'viewer').set('token', 'tok-77aa88bb99');
  const path = join(home, 'extensions', 'viewer');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'extension.mjs'),
    `export function register(api){
      api.registerTool('publish','publish',${schema},async(args)=>{
        const token = await api.secrets.get('token');
        if (args.big) { api.setView({ text: 'x'.repeat(70000) }); return 'too big'; }
        if (args.clear) { api.setView(null); return 'cleared'; }
        api.setView({ tasks: [{ id: 'task_1', phase: 'running' }], note: 'with ' + token });
        api.setView({ tasks: [{ id: 'task_1', phase: 'running' }], note: 'with ' + token });
        return 'ok';
      },{readOnly:true});
    }`,
  );
  let redraws = 0;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
    onStatus: () => redraws++,
  }).load();
  const context = {
    signal: new AbortController().signal,
    sessionId: 't',
  } as never;
  const tool = host.tools()[0]!;
  await tool.run({}, context);
  assert.deepEqual(host.view('viewer'), {
    tasks: [{ id: 'task_1', phase: 'running' }],
    note: 'with ***',
  });
  assert.equal(redraws, 1);
  await assert.rejects(
    async () => tool.run({ big: true }, context),
    /at most 64 KB/,
  );
  await tool.run({ clear: true }, context);
  assert.equal(host.view('viewer'), undefined);
  assert.equal(redraws, 2);
});

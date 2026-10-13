import { scratch, cleanup } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ExtensionHost } from '../src/extensions.js';
import { listPending } from '../src/secret_prompt.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';

const schema = '{type:"object",properties:{}}';
const context = () =>
  ({ signal: new AbortController().signal, sessionId: 'test' }) as never;
function extension(root: string, name: string, source: string): void {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'extension.mjs'), source);
}
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await delay(10);
  }
}

test('closing a host fires api.signal and waits for background work, calls in flight and handlers', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const marks = join(root, 'marks');
  mkdirSync(marks);
  extension(
    join(home, 'extensions'),
    'closer',
    `import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    export function register(api) {
      const mark = (name) => writeFileSync(join(${JSON.stringify(marks)}, name), '');
      api.registerTool('start', 'start', ${schema}, () => {
        api.background((async () => {
          await new Promise((resolve) => api.signal.addEventListener('abort', resolve, { once: true }));
          // Still at work a moment after the signal: a close that waits sees the mark.
          await delay(30);
          mark('background · ' + api.signal.reason.message);
        })());
        api.background(Promise.reject(new Error('refresh failed')));
        return 'started';
      }, { readOnly: true });
      api.registerTool('slow', 'slow', ${schema}, async () => { await delay(30); mark('tool'); return 'done'; }, { readOnly: true });
      api.registerTool('bad', 'bad', ${schema}, () => { api.background(42); }, { readOnly: true });
      api.registerCommand('slow', 'slow', async () => { await delay(30); mark('command'); });
      api.on('turn_end', async () => { await delay(30); mark('handler'); });
    }`,
  );
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
  }).load();
  const tool = (name: string) =>
    host.tools().find((item) => item.name === name)!;
  assert.equal(await tool('start').run({}, context()), 'started');
  await assert.rejects(
    async () => tool('bad').run({}, context()),
    /background needs a promise/,
  );
  const running = tool('slow').run({}, context());
  const command = host
    .commands()
    .get('slow')!
    .handler('', {
      workspace,
      toast: () => {},
      append: () => {},
      sendUserMessage: () => {},
    });
  host.emit('turn_end', {});
  assert.deepEqual(readdirSync(marks), []);
  await host.close();
  assert.deepEqual(readdirSync(marks).sort(), [
    'background · the extension was closed',
    'command',
    'handler',
    'tool',
  ]);
  assert.equal(await running, 'done');
  await command;
  assert.match(host.describe(), /background work failed: refresh failed/);
  // Closed twice is closed once; nothing is emitted any more.
  await host.close();
  host.emit('turn_end', {});
  await delay(50);
  assert.equal(readdirSync(marks).length, 4);
});

test('closing a host gives up on work that does not end once the bound is reached', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  extension(
    join(home, 'extensions'),
    'stuck',
    `export function register(api) {
      api.registerTool('hang', 'hang', ${schema}, () => { api.background(new Promise(() => {})); return 'hung'; }, { readOnly: true });
    }`,
  );
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
  }).load();
  assert.equal(await host.tools()[0]!.run({}, context()), 'hung');
  const started = Date.now();
  await host.close(50);
  assert.ok(Date.now() - started < 2000);
});

test('a secret card that is up when the host closes goes down and leaves no request behind', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  extension(
    join(home, 'extensions'),
    'asker',
    `export function register(api) {
      api.registerTool('ask', 'ask', ${schema}, async () => {
        try { return { value: await api.askSecret('Key please') }; }
        catch (error) { return { error: error.message }; }
      }, { readOnly: true });
    }`,
  );
  let shown = false;
  const host = await new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: false,
    secret: (_request, signal) =>
      new Promise<void>((resolve) => {
        shown = true;
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  }).load();
  const asking = host.tools()[0]!.run({}, context());
  await until(() => shown && listPending(home).length === 1);
  await host.close();
  assert.equal(await asking, '{"error":"the extension was closed"}');
  assert.deepEqual(listPending(home), []);
});

test('the runtime closes its extensions before loading them again and when it leaves', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const marks = join(root, 'marks');
  mkdirSync(marks);
  extension(
    join(home, 'extensions'),
    'lifetime',
    `import { writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { randomUUID } from 'node:crypto';
    export function register(api) {
      api.signal.addEventListener('abort', () => writeFileSync(join(${JSON.stringify(marks)}, 'closed-' + randomUUID()), ''), { once: true });
      api.registerTool('probe', 'probe', ${schema}, () => ({ aborted: api.signal.aborted }), { readOnly: true });
    }`,
  );
  const runtime = new AgentRuntime({
    home,
    workspace,
    settings: trustFolder(defaultSettings(), workspace),
    model: new ScriptedModel([]),
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const first = runtime.extensions;
  assert.deepEqual(readdirSync(marks), []);
  await runtime.reloadIntegrations();
  assert.notEqual(runtime.extensions, first);
  assert.equal(readdirSync(marks).length, 1);
  assert.equal(
    await runtime.extensions.tools()[0]!.run({}, context()),
    '{"aborted":false}',
  );
  await runtime.close();
  assert.equal(readdirSync(marks).length, 2);
  assert.ok(existsSync(marks));
});

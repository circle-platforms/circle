import { cleanup, scratch } from './helpers.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';

const schema = '{type:"object",properties:{}}';
const call = (name: string) => ({
  message: {
    id: 'call-' + name,
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ id: 'c-' + name, name, args: {} }],
  },
});
const say = (text: string) => ({
  message: { id: 'say-' + text, role: 'assistant' as const, content: text },
});

test('a tool an extension adds or removes after loading reaches the model from the next turn, never within the turn', async (t) => {
  const root = scratch(t);
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(workspace);
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const path = join(home, 'extensions', 'remote');
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, 'extension.mjs'),
    `export function register(api){
      api.registerTool('connect','connect',${schema},()=>{
        api.registerTool('remote_lookup','lookup',${schema},()=>'found',{readOnly:true});
        api.registerTool('remote_list','list',${schema},()=>'listed',{readOnly:true});
        return 'connected';
      },{readOnly:true});
      api.registerTool('disconnect','disconnect',${schema},()=>{
        return String(api.unregisterTool('remote_lookup')) + ',' + String(api.unregisterTool('remote_lookup'));
      },{readOnly:true});
    }`,
  );
  const model = new ScriptedModel([
    call('connect'),
    say('connected'),
    call('remote_lookup'),
    call('disconnect'),
    say('done'),
    say('after'),
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings,
    model,
    headless: false,
    bundledExtensions: false,
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  const offered = (index: number) =>
    model.requests[index]!.tools.map((tool) => tool.name);

  await runtime.harness.run('connect');
  // Both requests of the turn that registered the tools were made without them.
  assert.ok(!offered(0).includes('remote_lookup'));
  assert.ok(!offered(1).includes('remote_lookup'));
  await delay(5);
  assert.ok(
    runtime.harness.tools.some((tool) => tool.name === 'remote_lookup'),
  );

  const answer = await runtime.harness.run('use them');
  assert.equal(answer.answer, 'done');
  assert.ok(offered(2).includes('remote_lookup'));
  assert.ok(offered(2).includes('remote_list'));
  const results = runtime.harness.messages
    .filter((message) => message.role === 'tool')
    .map((message) => message.content);
  assert.ok(results.includes('found'));
  // The first removal succeeds, a second one of the same tool reports false.
  assert.ok(results.includes('true,false'));
  // Removed mid-turn: still offered until that turn ends.
  assert.ok(offered(4).includes('remote_lookup'));
  await delay(5);

  await runtime.harness.run('again');
  assert.ok(!offered(5).includes('remote_lookup'));
  assert.ok(offered(5).includes('remote_list'));
  assert.match(
    String(runtime.harness.system),
    /remote_list/,
    'the system prompt lists the tools the model now has',
  );
});

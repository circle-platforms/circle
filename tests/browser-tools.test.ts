import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserTools, type BrowserPort } from '../src/browser/tools.js';
import type { BrowserApproval } from '../src/browser/protocol.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { saveSecret } from '../src/secrets.js';
import { cleanup, scratch as made } from './helpers.js';

const scratch = (t: test.TestContext) => made(t, 'circle-browser-tools-');

test('browser_upload takes paths as the file tools do, refuses credential files and asks the person every time, also in auto mode', async (t) => {
  const root = scratch(t);
  writeFileSync(join(root, 'notes.txt'), 'notes');
  writeFileSync(join(root, '.env'), 'TOKEN=x');
  const requests: Record<string, unknown>[] = [];
  // A browser that wants approval for files, as the real ones do
  const port: BrowserPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      const approval = args.approval as { token?: string } | undefined;
      if (approval?.token === 'the-token') return { text: 'Gave the file.' };
      return {
        text: 'Giving the page files needs the user’s approval.',
        approval: {
          kind: 'upload',
          token: 'the-token',
          origin: 'https://device.lan',
          element: 'firmware',
          files: [
            {
              path: String((args.paths as string[])[0]),
              name: 'notes.txt',
              size: 5,
            },
          ],
        },
      };
    },
  };
  const asked: BrowserApproval[] = [];
  const answers: ('once' | 'always' | 'reject')[] = ['always', 'reject'];
  const call = (id: string, paths: string[]) => ({
    id,
    name: 'browser_upload',
    args: { ref: 'e3', element: 'firmware', paths },
  });
  const model = new ScriptedModel([
    {
      message: {
        id: '1',
        role: 'assistant',
        content: '',
        tool_calls: [
          call('upload', ['notes.txt']),
          call('secret', ['.env']),
          call('refused', ['notes.txt']),
        ],
      },
    },
    { message: { id: '2', role: 'assistant', content: 'done' } },
  ]);
  let runtime!: AgentRuntime;
  runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: browserTools(port, {
      confirm: async (_session, approval) => {
        asked.push(approval);
        return answers.shift()!;
      },
      files: (path) => {
        const full = runtime.sandbox.resolvePath(path);
        runtime.sandbox.checkCredentialPath(full);
        return full;
      },
    }),
  });
  cleanup(t, () => runtime.close());
  // auto mode answers the policy's questions, never this one
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('upload the notes');
  const results = Object.fromEntries(
    model.requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    ).map((message) => [message.tool_call_id, String(message.content)]),
  );
  assert.equal(results.upload, 'Gave the file.');
  assert.match(results.secret!, /'\.env' is a credential file/);
  assert.match(
    results.refused!,
    /the user did not allow giving the page these files/,
  );
  // The relative path became the workspace's file; an upload is allowed once, never for good
  const notes = runtime.sandbox.resolvePath('notes.txt');
  assert.deepEqual(requests, [
    { action: 'upload', ref: 'e3', element: 'firmware', paths: [notes] },
    {
      action: 'upload',
      ref: 'e3',
      element: 'firmware',
      paths: [notes],
      approval: { token: 'the-token', scope: 'once' },
    },
    { action: 'upload', ref: 'e3', element: 'firmware', paths: [notes] },
  ]);
  assert.equal(asked.length, 2);
  assert.equal(asked[0]!.kind, 'upload');
  // The token is the person's: it never reaches the model
  assert.equal(JSON.stringify(model.requests).includes('the-token'), false);
  const tool = model.requests[0]!.tools.find(
    (entry) => entry.name === 'browser_upload',
  );
  assert.deepEqual(Object.keys((tool!.parameters as any).properties), [
    'ref',
    'element',
    'paths',
  ]);
  // Handing the person the browser changes nothing: it never asks, and works in plan mode
  const handoff = runtime.allTools.find(
    (entry) => entry.name === 'browser_handoff',
  )!;
  assert.equal(handoff.effect, 'read');
  assert.equal(handoff.subagents, false);
  assert.deepEqual((handoff.parameters as any).required, ['reason']);
});

test('browser control is allowed site by site: the site goes to the card and the rule, and the browser gets it to check', async (t) => {
  const root = scratch(t);
  // A browser that shows the last address it was sent to
  let shown = '';
  const requests: Record<string, unknown>[] = [];
  const port: BrowserPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      if (action === 'navigate') shown = new URL(String(args.url)).origin;
      return { text: `${action} done`, origin: shown };
    },
  };
  const step = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, name, args }],
    },
  });
  const model = new ScriptedModel([
    step('a', 'browser_navigate', { url: 'https://device.lan:8443/login' }),
    step('click-a', 'browser_click', { ref: 'e1', element: 'sign in' }),
    step('b', 'browser_navigate', { url: 'https://other.example/' }),
    step('click-b', 'browser_click', { ref: 'e2', element: 'link' }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const asked: { name: string; site: unknown }[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: browserTools(port),
    // The person allows each site for the session
    approve: async (call) => {
      asked.push({ name: call.name, site: call.args.site });
      return 'always';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('use the device');
  // Asked once for each site, never again on a site already allowed
  assert.deepEqual(asked, [
    { name: 'browser_navigate', site: 'https://device.lan:8443' },
    { name: 'browser_navigate', site: 'https://other.example' },
  ]);
  // The browser is told the site each action was allowed on
  assert.deepEqual(
    requests.map((request) => [request.action, request.site]),
    [
      ['navigate', 'https://device.lan:8443'],
      ['click', 'https://device.lan:8443'],
      ['navigate', 'https://other.example'],
      ['click', 'https://other.example'],
    ],
  );
  const review = runtime.policy.review('browser_click', {
    ref: 'e1',
    site: 'https://device.lan:8443',
  });
  assert.equal(review.scope, 'browser control on https://device.lan:8443');
  assert.equal(review.pattern, 'site:https://device.lan:8443');
  // A rule for every site, from before sites were told apart, still covers them all
  const thread = 'older-session';
  runtime.policy.remember(thread, 'browser_click', { ref: 'e1' }, 'always');
  assert.equal(
    runtime.policy.needsApproval(
      'browser_type',
      { ref: 'e1', text: 'x', site: 'https://anywhere.example' },
      thread,
    ),
    false,
  );
  // The model cannot name a site itself: the schema refuses it
  const click = runtime.allTools.find((tool) => tool.name === 'browser_click')!;
  assert.equal((click.parameters as any).additionalProperties, false);
  assert.equal('site' in (click.parameters as any).properties, false);
});

test('a click that deletes on a page, or accepting a dialog that says so, asks every time in manual mode, rules aside, and never in auto mode', async (t) => {
  const root = scratch(t);
  const page = [
    '### Page',
    'tab t1 · "virtual services" · https://device.lan/vs',
    '### Snapshot',
    '| vs3 | [e4] checkbox |',
    '[e5] button "删除"',
    '[e6] button "添加"',
  ].join('\n');
  const requests: string[] = [];
  const port: BrowserPort = {
    async request(_session, action, args) {
      requests.push(`${action} ${String(args.ref ?? args.url ?? '')}`.trim());
      // Deleting opens the page's own confirmation
      // A list of tabs has no snapshot: what the refs are stays as the last snapshot said
      if (action === 'tabs')
        return {
          text: '### Tabs\n- t1 (shown) "virtual services"',
          origin: 'https://device.lan',
        };
      const text =
        action === 'click' && args.ref === 'e5'
          ? `Clicked e5 button "删除". It opened dialog d1.\n${page}\n### Dialogs waiting\n- [d1] confirm · tab t1 · from https://device.lan: "确定删除选中的虚拟服务吗？" → browser_dialog`
          : `${action} done\n${page}`;
      return { text, origin: 'https://device.lan' };
    },
  };
  const step = (id: string, name: string, args: Record<string, unknown>) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, name, args }],
    },
  });
  const model = new ScriptedModel([
    step('open', 'browser_navigate', { url: 'https://device.lan/vs' }),
    step('select', 'browser_click', { ref: 'e4', element: 'vs3' }),
    step('tabs', 'browser_tabs', { action: 'list' }),
    // The model calls it something else: the page's name decides
    step('delete', 'browser_click', { ref: 'e5', element: 'the button' }),
    step('confirm', 'browser_dialog', { accept: true }),
    step('add', 'browser_click', { ref: 'e6', element: '添加' }),
    step('again', 'browser_click', { ref: 'e5', element: '删除' }),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
    step('auto-delete', 'browser_click', { ref: 'e5', element: '删除' }),
    step('auto-confirm', 'browser_dialog', { accept: true }),
    { message: { id: 'auto-done', role: 'assistant', content: 'done' } },
  ]);
  const asked: { id: string; deletes: unknown; choices: string }[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: browserTools(port),
    // The person allows the site for the session, and allows each delete once: its card
    // offers no "for this session"
    approve: async (call) => {
      const review = runtime.policy.review(call.name, call.args);
      asked.push({
        id: call.id,
        deletes: call.args.deletes,
        choices: review.verdict,
      });
      return review.verdict === 'ASK_FORCED' ? 'approve' : 'always';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('remove vs3');
  assert.deepEqual(asked, [
    { id: 'open', deletes: undefined, choices: 'ASK' },
    { id: 'delete', deletes: '删除', choices: 'ASK_FORCED' },
    {
      id: 'confirm',
      deletes:
        '- [d1] confirm · tab t1 · from https://device.lan: "确定删除选中的虚拟服务吗？" → browser_dialog',
      choices: 'ASK_FORCED',
    },
    // A delete allowed once leaves no rule: the next one asks again
    { id: 'again', deletes: '删除', choices: 'ASK_FORCED' },
  ]);
  // Every call ran once allowed; the checkbox and 添加 were covered by the site's rule
  assert.deepEqual(requests, [
    'navigate https://device.lan/vs',
    'click e4',
    'tabs',
    'click e5',
    'dialog',
    'click e6',
    'click e5',
  ]);
  // Auto mode does not ask
  runtime.policy.setMode(runtime.session.id, 'auto');
  await runtime.harness.run('remove it again');
  assert.equal(asked.length, 4);
  assert.deepEqual(requests.slice(-2), ['click e5', 'dialog']);
  // The model cannot say what deletes: the schema refuses it
  const click = runtime.allTools.find((tool) => tool.name === 'browser_click')!;
  assert.equal('deletes' in (click.parameters as any).properties, false);
});

test('a download the model starts is kept or discarded by the person, and the model learns what its action did either way', async (t) => {
  const root = scratch(t);
  const requests: Record<string, unknown>[] = [];
  // A browser whose clicks download from a site not allowed yet, as the real ones do
  const port: BrowserPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      const approval = args.approval as
        { token?: string; scope?: string } | undefined;
      if (approval?.token === 'held')
        return {
          text:
            approval.scope === 'reject'
              ? '### Download\nThe user did not keep the download; it was discarded.'
              : '### Download\nThe download was kept.',
          origin: 'https://device.lan',
        };
      return {
        text: '### Result\nClicked "export".',
        origin: 'https://device.lan',
        approval: {
          kind: 'download',
          token: 'held',
          site: 'https://device.lan',
          files: [{ name: 'config.bin', size: 12 }],
        },
      };
    },
  };
  const answers: ('once' | 'always' | 'reject')[] = ['always', 'reject'];
  const click = (id: string) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [
        { id, name: 'browser_click', args: { ref: 'e1', element: 'export' } },
      ],
    },
  });
  const model = new ScriptedModel([
    click('kept'),
    click('discarded'),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: browserTools(port, {
      confirm: async (_session, approval) => {
        assert.equal(approval.kind, 'download');
        return answers.shift()!;
      },
    }),
    approve: async () => 'always',
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('export the configuration');
  const results = Object.fromEntries(
    model.requests
      .at(-1)!
      .messages.filter((message) => message.role === 'tool')
      .map((message) => [message.tool_call_id, String(message.content)]),
  );
  // The click happened either way: its result is kept, and the answer follows it
  assert.equal(
    results.kept,
    '### Result\nClicked "export".\n### Download\nThe download was kept.',
  );
  assert.equal(
    results.discarded,
    '### Result\nClicked "export".\n### Download\nThe user did not keep the download; it was discarded.',
  );
  // The click is not done again: the answer goes back with the token alone
  assert.deepEqual(
    requests.map((request) => [request.action, request.approval]),
    [
      ['click', undefined],
      ['click', { token: 'held', scope: 'always' }],
      ['click', undefined],
      ['click', { token: 'held', scope: 'reject' }],
    ],
  );
  assert.equal(JSON.stringify(model.requests).includes('"held"'), false);
});

test("a sign-in's password is only ever a saved secret: the browser gets the value, the model and the card see %NAME%", async (t) => {
  const root = scratch(t);
  saveSecret(root, 'LAB_PASSWORD', 'value-of-the-secret');
  const requests: Record<string, unknown>[] = [];
  const port: BrowserPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      // The page echoes what it got, as a careless one could
      return { text: `Answered sign-in d1 with ${String(args.password)}.` };
    },
  };
  const dialog = (id: string, password: string) => ({
    id,
    name: 'browser_dialog',
    args: { id: 'd1', accept: true, text: 'admin', password },
  });
  const model = new ScriptedModel([
    {
      message: {
        id: '1',
        role: 'assistant',
        content: '',
        tool_calls: [
          dialog('plain', 'typed-by-the-model'),
          dialog('mixed', 'x%LAB_PASSWORD%'),
          dialog('secret', '%LAB_PASSWORD%'),
        ],
      },
    },
    { message: { id: '2', role: 'assistant', content: 'done' } },
  ]);
  const cards: Record<string, unknown>[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: browserTools(port),
    approve: async (call) => {
      cards.push(structuredClone(call.args));
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('sign in to the device');
  const results = Object.fromEntries(
    model.requests[1]!.messages.filter(
      (message) => message.role === 'tool',
    ).map((message) => [message.tool_call_id, String(message.content)]),
  );
  for (const id of ['plain', 'mixed'])
    assert.match(
      results[id]!,
      /a sign-in's password takes only a saved secret, written %NAME%/,
    );
  assert.equal(results.secret, 'Answered sign-in d1 with %LAB_PASSWORD%.');
  // Only the secret's answer reached the browser, with the value
  assert.deepEqual(requests, [
    {
      action: 'dialog',
      id: 'd1',
      accept: true,
      text: 'admin',
      password: 'value-of-the-secret',
    },
  ]);
  assert.equal(
    JSON.stringify(model.requests).includes('value-of-the-secret'),
    false,
  );
  assert.equal(JSON.stringify(cards).includes('value-of-the-secret'), false);
  assert(cards.some((card) => card.password === '%LAB_PASSWORD%'));
});

test('a navigation written with a variable is allowed for the site it goes to, never for every site', async (t) => {
  const root = scratch(t);
  const requests: Record<string, unknown>[] = [];
  const port: BrowserPort = {
    async request(_session, action, args) {
      requests.push({ action, ...structuredClone(args) });
      return { text: `${action} done`, origin: String(args.site ?? '') };
    },
  };
  const step = (id: string, url: string) => ({
    message: {
      id,
      role: 'assistant' as const,
      content: '',
      tool_calls: [{ id, name: 'browser_navigate', args: { url } }],
    },
  });
  const model = new ScriptedModel([
    step('templated', '%BASE_URL%/login'),
    step('elsewhere', 'https://other.example/'),
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const settings = trustFolder(defaultSettings(), root);
  settings.variables = { BASE_URL: 'https://device.lan:8443' };
  const asked: unknown[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    extraTools: browserTools(port),
    approve: async (call) => {
      asked.push(call.args.site);
      return 'always';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('open the device');
  assert.deepEqual(asked, ['https://device.lan:8443', 'https://other.example']);
  assert.deepEqual(
    requests.map((request) => request.url),
    ['https://device.lan:8443/login', 'https://other.example/'],
  );
});

test('a replay whose script clicks a control that deletes asks every time in manual mode, and names those steps', async (t) => {
  const root = scratch(t);
  const port: BrowserPort = {
    async request() {
      return { text: 'done', origin: 'https://device.lan' };
    },
  };
  const write = (name: string, steps: unknown[]) => {
    const path = join(root, name);
    writeFileSync(
      path,
      JSON.stringify({ circle: 'browser-script/1', name, steps }),
    );
    return path;
  };
  const cleanupScript = write('cleanup.json', [
    { navigate: 'https://device.lan/vs' },
    { click: { role: 'checkbox', name: '' } },
    { click: { role: 'button', name: '删除' } },
    { dialog: 'accept' },
  ]);
  const setupScript = write('setup.json', [
    { navigate: 'https://device.lan/vs' },
    { click: { role: 'button', name: '添加' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: trustFolder(defaultSettings(), root),
    model: new ScriptedModel([]),
    extraTools: browserTools(port, { files: (path) => path }),
  });
  cleanup(t, () => runtime.close());
  const replay = runtime.allTools.find(
    (tool) => tool.name === 'browser_replay',
  )!;
  const facts = replay.approvalFacts!(
    { path: cleanupScript },
    runtime.session.id,
  )!;
  assert.deepEqual(facts, {
    site: 'https://device.lan',
    deletes: 'step 3: button "删除"',
  });
  const review = runtime.policy.review('browser_replay', {
    path: cleanupScript,
    ...facts,
  });
  assert.equal(review.verdict, 'ASK_FORCED');
  assert.match(review.reason, /step 3: button \\"删除\\"/);
  // A rule for the site does not cover it; auto mode does not ask
  runtime.policy.remember(
    runtime.session.id,
    'browser_navigate',
    { site: 'https://device.lan' },
    'always',
  );
  assert.equal(
    runtime.policy.needsApproval(
      'browser_replay',
      { path: cleanupScript, ...facts },
      runtime.session.id,
    ),
    true,
  );
  runtime.policy.setMode(runtime.session.id, 'auto');
  assert.equal(
    runtime.policy.needsApproval(
      'browser_replay',
      { path: cleanupScript, ...facts },
      runtime.session.id,
    ),
    false,
  );
  // A script that deletes nothing is covered by the site's rule
  runtime.policy.setMode(runtime.session.id, 'manual');
  const plain = replay.approvalFacts!(
    { path: setupScript },
    runtime.session.id,
  )!;
  assert.deepEqual(plain, { site: 'https://device.lan' });
  assert.equal(
    runtime.policy.needsApproval(
      'browser_replay',
      { path: setupScript, ...plain },
      runtime.session.id,
    ),
    false,
  );
});

test('coordinate confirmations are once only, cannot be model supplied, and rejection reaches the next request', async (t) => {
  const root = scratch(t);
  const seen: Record<string, unknown>[] = [];
  const port: BrowserPort = {
    async request(_id, action, args) {
      seen.push({ ...args });
      if ((args.approval as any)?.token === 'private-coordinate-token')
        return {
          text: 'Clicked actual span "...".',
          origin: 'https://device.lan',
        };
      return {
        text: 'Coordinate approval needed.',
        approval: {
          kind: 'coordinate',
          token: 'private-coordinate-token',
          origin: 'https://device.lan',
          element: '...',
          x: 12,
          y: 34,
          destructive: false,
        },
      };
    },
  };
  const model = new ScriptedModel([
    {
      message: {
        id: 'a',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'allow',
            name: 'browser_click_at',
            args: { x: 12, y: 34, screenshotId: 'capture1' },
          },
        ],
      },
    },
    {
      message: {
        id: 'b',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'reject',
            name: 'browser_click_at',
            args: { x: 12, y: 34, screenshotId: 'capture2' },
          },
        ],
      },
    },
    { message: { id: 'c', role: 'assistant', content: 'done' } },
  ]);
  const decisions: ('always' | 'reject')[] = ['always', 'reject'];
  const runtime = new AgentRuntime({
    home: root,
    workspace: root,
    settings: trustFolder(defaultSettings(), root),
    model,
    extraTools: browserTools(port, { confirm: async () => decisions.shift()! }),
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('click fixture');
  assert.equal((seen[1]!.approval as any).scope, 'once');
  assert.match(
    String(
      model.requests[2]!.messages.find((m) => m.tool_call_id === 'reject')!
        .content,
    ),
    /did not allow clicking/,
  );
  assert.equal(
    JSON.stringify(model.requests).includes('private-coordinate-token'),
    false,
  );
  const schema = runtime.allTools.find((t) => t.name === 'browser_click_at')!
    .parameters as any;
  assert.deepEqual(schema.required, ['x', 'y', 'screenshotId']);
  assert.equal(schema.additionalProperties, false);
  assert.equal(Object.hasOwn(schema.properties, 'approval'), false);
});

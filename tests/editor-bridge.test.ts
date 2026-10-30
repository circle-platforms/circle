import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import {
  BRIDGE_PATH,
  BRIDGE_TOKEN_HEADER,
  EditorBridge,
  allowedHost,
  allowedOrigin,
  loopbackAddress,
} from '../src/editor_bridge.js';
import { Sandbox } from '../src/sandbox.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

interface Reply {
  status: number;
  body?: { result?: any; error?: { code: number; message: string } };
}

/**
 * One message to the bridge, over the socket, the way an editor plugin sends it.
 * `node:http` and not `fetch`, so no proxy in the environment can take hold of a
 * loopback call.
 */
function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const call = httpRequest(
      url,
      {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(payload)),
          ...headers,
        },
      },
      (answer) => {
        let text = '';
        answer.setEncoding('utf8');
        answer.on('data', (chunk) => (text += chunk));
        answer.on('end', () => {
          resolve({
            status: answer.statusCode ?? 0,
            body: text ? JSON.parse(text) : undefined,
          });
        });
      },
    );
    call.on('error', reject);
    call.end(payload);
  });
}

const rpc = (method: string, params: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params,
});

const toolText = (body: Reply['body']): string =>
  body?.result?.content
    ?.map((part: { text: string }) => part.text)
    .join('\n') ?? '';

/** Ask the bridge one thing and take back the words it answered with. */
async function call(
  info: { url: string; token: string },
  name: string,
  args: Record<string, unknown> = {},
  id = 1,
): Promise<string> {
  const answer = await post(
    info.url,
    rpc('tools/call', { name, arguments: args }, id),
    { [BRIDGE_TOKEN_HEADER]: info.token },
  );
  return toolText(answer.body);
}

function folders(t: TestContext): {
  home: string;
  workspace: string;
  bridge: (home: string, workspace: string, at?: () => number) => EditorBridge;
} {
  const root = scratch(t);
  const home = join(root, 'data');
  const workspace = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return {
    home,
    workspace,
    bridge: (h, w, at) => new EditorBridge(h, w, new Sandbox(w), at),
  };
}

test('the loopback rules are said plainly', () => {
  assert.equal(loopbackAddress('127.0.0.1'), true);
  assert.equal(loopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(loopbackAddress('::1'), true);
  assert.equal(loopbackAddress('10.0.0.5'), false);
  assert.equal(loopbackAddress('203.0.113.9'), false);
  assert.equal(loopbackAddress(undefined), false);
  assert.equal(allowedHost('localhost:53124'), true);
  assert.equal(allowedHost('127.0.0.1:80'), true);
  assert.equal(allowedHost('[::1]:80'), true);
  assert.equal(allowedHost('evil.example'), false);
  // A name that happens to resolve here is not this machine named: rebinding is out.
  assert.equal(allowedHost('mybox.internal'), false);
  assert.equal(allowedOrigin(undefined), true);
  assert.equal(allowedOrigin('null'), true);
  assert.equal(allowedOrigin('http://127.0.0.1:53124'), true);
  assert.equal(allowedOrigin('https://example.com'), false);
});

test('the bridge answers only a loopback client with the right token and Host', async (t) => {
  const { home, workspace, bridge } = folders(t);
  const running = bridge(home, workspace);
  cleanup(t, () => running.stop());
  const info = await running.start();
  assert.equal(
    existsSync(join(home, 'bridge.json')),
    true,
    'an editor can find it',
  );
  assert.match(
    info.url,
    new RegExp('^http://127\\.0\\.0\\.1:\\d+' + BRIDGE_PATH + '$'),
  );
  assert.equal(info.token.length, 48);
  assert.equal((await post(info.url, rpc('ping'))).status, 401);
  assert.equal(
    (
      await post(info.url, rpc('ping'), {
        [BRIDGE_TOKEN_HEADER]: 'x'.repeat(48),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await post(info.url, rpc('ping'), {
        [BRIDGE_TOKEN_HEADER]: info.token,
        Host: 'evil.example',
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await post(info.url, rpc('ping'), {
        [BRIDGE_TOKEN_HEADER]: info.token,
        Origin: 'https://example.com',
      })
    ).status,
    403,
  );
  // A GET would ask for a stream the bridge has nothing to send down.
  const get = await new Promise<number>((resolve, reject) => {
    const call2 = httpRequest(
      info.url,
      { method: 'GET', headers: { [BRIDGE_TOKEN_HEADER]: info.token } },
      (answer) => {
        answer.resume();
        answer.on('end', () => resolve(answer.statusCode ?? 0));
      },
    );
    call2.on('error', reject);
    call2.end();
  });
  assert.equal(get, 405);
  assert.equal(
    (await post(info.url, rpc('ping'), { [BRIDGE_TOKEN_HEADER]: info.token }))
      .status,
    200,
  );
});

test('a client lists the eight tools and calls them over the socket', async (t) => {
  const { home, workspace, bridge } = folders(t);
  const running = bridge(home, workspace, () => 1_700_000_000);
  cleanup(t, () => running.stop());
  const info = await running.start();
  const init = await post(
    info.url,
    rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test editor', version: '1' },
    }),
    { [BRIDGE_TOKEN_HEADER]: info.token },
  );
  assert.equal(init.body?.result?.serverInfo?.name, 'circle-editor-bridge');
  const listed = await post(info.url, rpc('tools/list'), {
    [BRIDGE_TOKEN_HEADER]: info.token,
  });
  assert.deepEqual(
    listed.body?.result?.tools?.map((tool: { name: string }) => tool.name),
    [
      'editor_status',
      'editor_active_file',
      'editor_selection',
      'editor_open_diff',
      'editor_report_file',
      'editor_report_selection',
      'editor_pending_diffs',
      'editor_diff_decision',
    ],
  );
  const path = join(workspace, 'notes.txt');
  assert.match(await call(info, 'editor_report_file', { path }), /^ok: /);
  assert.match(
    await call(info, 'editor_report_selection', {
      path,
      text: 'the part that is wrong',
      lineStart: 4,
      lineEnd: 5,
    }),
    /^ok: 22 characters$/,
  );
  assert.match(await call(info, 'editor_status'), /"pendingDiffs": 0/);
  assert.match(await call(info, 'editor_active_file'), /notes\.txt \(0s ago\)/);
  // An unknown method is a JSON-RPC error, not a socket left hanging.
  const unknown = await post(info.url, rpc('tools/nope'), {
    [BRIDGE_TOKEN_HEADER]: info.token,
  });
  assert.equal(unknown.body?.error?.code, -32601);
});

test('a selection the editor reported reaches the model as context', async (t) => {
  const { home, workspace } = folders(t);
  writeFileSync(join(workspace, 'notes.txt'), 'line one\nline two\n');
  const model = new ScriptedModel([
    {
      message: {
        id: 'ask',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'sel', name: 'editor_selection', args: {} }],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'seen it' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(home, '..', 'user'),
    settings: {
      ...trustFolder(defaultSettings(), workspace),
      editor_bridge: true,
    },
    model,
  });
  cleanup(t, () => runtime.close());
  // The person opened the bridge; the tools were listed by the setting.
  const info = await runtime.editorBridge.start();
  // The plugin reports what the person has selected.
  assert.match(
    await call(info, 'editor_report_selection', {
      path: join(workspace, 'notes.txt'),
      text: 'line two',
      lineStart: 2,
      lineEnd: 2,
    }),
    /^ok: /,
  );
  await runtime.harness.run('fix what I selected');
  const told = model.requests[1]!.messages.filter((m) => m.role === 'tool');
  assert.equal(told.length, 1, 'the tool answered');
  assert.match(String(told[0]!.content), /notes\.txt:2-2\nline two/);
});

test('a diff the person accepts in the editor lands on disk, a reject does not', async (t) => {
  const { home, workspace } = folders(t);
  const target = join(workspace, 'src.txt');
  writeFileSync(target, 'old text\n');
  const model = new ScriptedModel([
    {
      message: {
        id: 'ask',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'diff',
            name: 'editor_open_diff',
            args: { path: 'src.txt', proposed: 'new text\n', note: 'one line' },
          },
        ],
      },
    },
    { message: { id: 'wait', role: 'assistant', content: 'waiting for you' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(home, '..', 'user'),
    settings: {
      ...trustFolder(defaultSettings(), workspace),
      editor_bridge: true,
    },
    model,
    // Asking to open a diff in the person's editor is a call the approval answers for.
    approve: async () => 'approve',
  });
  cleanup(t, () => runtime.close());
  const info = await runtime.editorBridge.start();
  await runtime.harness.run('change that file');
  const asked = model.requests[1]!.messages.find((m) => m.role === 'tool')!;
  const id = String(asked.content).match(/diff request ([0-9a-f]{12})/)![1]!;
  assert.match(String(asked.content), /nothing was written/);
  assert.equal(
    readFileSync(target, 'utf8'),
    'old text\n',
    'the ask wrote nothing',
  );

  assert.match(
    await call(info, 'editor_diff_decision', { id, accept: false }),
    /rejected/,
  );
  assert.equal(
    readFileSync(target, 'utf8'),
    'old text\n',
    'a reject wrote nothing',
  );
  assert.match(
    await call(info, 'editor_diff_decision', { id, accept: true }, 2),
    /was already reject/,
  );
  assert.equal(readFileSync(target, 'utf8'), 'old text\n');

  const again = await call(
    info,
    'editor_open_diff',
    {
      path: 'src.txt',
      proposed: 'newest text\n',
    },
    3,
  );
  const id2 = again.match(/diff request ([0-9a-f]{12})/)![1]!;
  assert.match(
    await call(info, 'editor_diff_decision', { id: id2, accept: true }, 4),
    /accepted: .*wrote 12 bytes/,
  );
  assert.equal(
    readFileSync(target, 'utf8'),
    'newest text\n',
    'the accept wrote',
  );
});

test('a bridge write stays inside the workspace, and a stale selection is refused', async (t) => {
  const { home, workspace, bridge } = folders(t);
  let clock = 1_700_000_000;
  const running = bridge(home, workspace, () => clock);
  cleanup(t, () => running.stop());
  const info = await running.start();
  assert.match(
    await call(info, 'editor_open_diff', {
      path: join(home, '..', 'outside.txt'),
      proposed: 'x',
    }),
    /outside the workspace/,
  );
  assert.match(
    await call(info, 'editor_open_diff', { path: 'notes.txt', proposed: '' }),
    /path and proposed are both needed/,
  );
  await call(info, 'editor_report_selection', {
    path: join(workspace, 'a.txt'),
    text: 'pick me',
    lineStart: 1,
    lineEnd: 1,
  });
  assert.match(await call(info, 'editor_selection'), /pick me/);
  clock += 10 * 60 + 1;
  assert.match(
    await call(info, 'editor_selection'),
    /past the 600s it counts as context/,
  );
  // A diff nobody answers is not waiting forever.
  const made = await call(info, 'editor_open_diff', {
    path: 'a.txt',
    proposed: 'later',
  });
  const id = made.match(/diff request ([0-9a-f]{12})/)![1]!;
  assert.match(await call(info, 'editor_pending_diffs'), new RegExp(id));
  // An hour old to the second it still waits; one more and it is gone.
  clock += 3600;
  assert.match(await call(info, 'editor_pending_diffs'), new RegExp(id));
  clock += 1;
  assert.doesNotMatch(await call(info, 'editor_pending_diffs'), new RegExp(id));
});
test('the four tools are offered only when the setting is on, and a closed bridge says what to do', async (t) => {
  const { home, workspace } = folders(t);
  const userHome = join(home, '..', 'user');
  const offered = async (editorBridge: boolean): Promise<string[]> => {
    const model = new ScriptedModel([
      { message: { id: 'a', role: 'assistant', content: 'seen' } },
    ]);
    const runtime = new AgentRuntime({
      home,
      workspace,
      userHome,
      settings: {
        ...trustFolder(defaultSettings(), workspace),
        editor_bridge: editorBridge,
      },
      model,
    });
    cleanup(t, () => runtime.close());
    await runtime.harness.run('what can you see?');
    return model.requests[0]!.tools.map((tool) => tool.name).filter((name) =>
      name.startsWith('editor_'),
    );
  };
  assert.deepEqual(
    await offered(false),
    [],
    'no editor tools nobody asked for',
  );
  assert.deepEqual(await offered(true), [
    'editor_status',
    'editor_active_file',
    'editor_selection',
    'editor_open_diff',
  ]);
  // Listed but not open: the answer is the instruction, not a hang and not a guess.
  const model = new ScriptedModel([
    {
      message: {
        id: 'ask',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'sel', name: 'editor_selection', args: {} }],
      },
    },
    { message: { id: 'b', role: 'assistant', content: 'told' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: {
      ...trustFolder(defaultSettings(), workspace),
      editor_bridge: true,
    },
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('what did I select?');
  const told = model.requests[1]!.messages.filter((m) => m.role === 'tool');
  assert.match(String(told[0]!.content), /the bridge is not open/);
  assert.match(String(told[0]!.content), /\/bridge start/);
});

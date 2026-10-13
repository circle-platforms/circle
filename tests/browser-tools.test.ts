import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserTools, type BrowserPort } from '../src/browser/tools.js';
import type { BrowserApproval } from '../src/browser/protocol.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';

const scratch = (t: test.TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'circle-browser-tools-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

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
  t.after(() => runtime.close());
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
});

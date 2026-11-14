import test from 'node:test';
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
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { until } from '../../../tests/helpers.ts';
import { mcpStub } from '../../../tests/mcp-stub.ts';

// #554: what a running MCP call says of its progress is on its row in the desktop, and leaves when it ends
test("a running MCP call's row carries the server's latest progress until its result is in", async (t) => {
  const root = realpathSync.native(
    await mkdtemp(join(tmpdir(), 'circle-desktop-progress-')),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  let answer: (() => void) | undefined;
  const answered = new Promise<void>((resolve) => (answer = resolve));
  t.after(() => answer?.());
  const stub = await mcpStub(t, {
    // Read-only, so it runs without a card
    tools: [
      {
        name: 'index',
        inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    before: (request) =>
      request.message?.method === 'tools/call'
        ? [1, 2].map((progress) => ({
            method: 'notifications/progress',
            params: {
              progressToken: request.message!.params!._meta!.progressToken,
              progress,
              total: 3,
              message: progress === 2 ? 'indexing' : 'reading',
            },
          }))
        : undefined,
    call: async () => {
      await answered;
      return { content: [{ type: 'text', text: 'indexed' }] };
    },
  });
  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcp_servers = [
    { name: 'files', url: stub.url, transport: 'streamable_http' },
  ];
  saveSettings(settings, home);
  const model = new ScriptedModel([
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call-1', name: 'files_index', args: {} }],
      },
    },
    { message: { id: randomUUID(), role: 'assistant', content: 'done' } },
  ]);
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    emit: () => {},
  });
  t.after(() => controller.close());
  const row = () =>
    controller
      .snapshot()
      .sessions.find(
        (session) => session.id === controller.snapshot().activeSessionId,
      )
      ?.messages.find((message) => message.tool?.id === 'call-1')?.tool;
  const sent = await controller.dispatch({
    id: randomUUID(),
    name: 'prompt',
    payload: { text: 'index it' },
    sessionId: controller.snapshot().activeSessionId,
  });
  assert.equal(sent.ok, true);
  await until(() => row()?.progress === '2/3 · indexing', { timeout: 10_000 });
  assert.equal(row()?.status, 'running');
  answer!();
  await until(() => row()?.status === 'success', { timeout: 10_000 });
  assert.equal(row()?.progress, undefined);
  assert.match(row()?.output ?? '', /indexed/);
});

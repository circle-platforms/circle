import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeController } from '../src/runtime-controller.ts';
import { AgentRuntime } from '../../../src/runtime.ts';
import { CheckpointStore } from '../../../src/checkpoint_store.ts';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
} from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import type {
  GitHubConnectionBackend,
  GitHubConnectionState,
} from '../../../src/github_connection.ts';
import type { Message as WorkbenchMessage } from '../../workbench/src/model/types.ts';
import { formatRuntimeNotice } from '../../workbench/src/model/runtime-notice.ts';
import { setLanguage } from '../../workbench/src/i18n/index.ts';
const getRuntime = (controller: RuntimeController) =>
  [
    ...(
      controller as unknown as {
        runtimes: { values(): Iterable<AgentRuntime> };
      }
    ).runtimes.values(),
  ][0]!;
test('actual bundled command stores notice provenance while identical user/model text stays unchanged after reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-github-notice-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace');
  await mkdir(workspace);
  const settings = trustFolder(defaultSettings(), workspace);
  settings.extensions.github = { enabled: true };
  saveSettings(settings, home);
  let state: GitHubConnectionState = {
    provider: 'github',
    client: 'GitHub CLI',
    epoch: 1,
    state: 'disconnected',
    repositories: [],
    remoteRevocation: 'not-requested',
  };
  const backend = {
    call: async () => structuredClone(state),
    subscribe: () => () => {},
  } as GitHubConnectionBackend;
  const model = new ScriptedModel([
    {
      message: {
        id: 'model-same-text',
        role: 'assistant',
        content: 'GitHub: connected',
      },
    },
  ]);
  let controller: RuntimeController | undefined;
  try {
    controller = new RuntimeController({
      home,
      userHome: home,
      workspace,
      model,
      emit: () => {},
    });
    const runtime = getRuntime(controller);
    runtime.options.githubConnection = backend;
    runtime.extensions.options.githubConnection = backend;
    await runtime.harness.run('GitHub: connected');
    const rawCommand: string[] = [];
    const command = runtime.extensions.commands().get('github')!;
    await command.handler('status', {
      workspace,
      append: (text) => rawCommand.push(text),
      toast: () => {},
      sendUserMessage: () => {},
    });
    assert.deepEqual(
      rawCommand,
      ['GitHub: disconnected'],
      'actual extension produces plain English; provenance must come from host',
    );
    const ids: string[] = [];
    for (const value of [
      'disconnected',
      'authorizing',
      'connected',
      'error',
    ] as const) {
      state = { ...state, state: value, epoch: state.epoch + 1 };
      const reply = await controller.dispatch({
        id: 'state-' + value,
        name: 'custom-command',
        sessionId: runtime.session.id,
        payload: { name: 'github', args: 'status' },
      });
      assert.equal(reply.ok, true, JSON.stringify(reply));
      const row: WorkbenchMessage = controller
        .snapshot()
        .sessions.find((s) => s.id === runtime.session.id)!
        .messages.at(-1)!;
      assert.equal(row.role, 'notice');
      assert.equal(row.text, 'GitHub: ' + value);
      assert.deepEqual(row.runtimeNotice, {
        source: 'bundled:github',
        kind: 'github-connection',
        state: value,
      });
      ids.push(row.id);
    }
    const rows = controller
      .snapshot()
      .sessions.find((s) => s.id === runtime.session.id)!.messages;
    assert.equal(
      rows.find(
        (m) => m.role === 'assistant' && m.text === 'GitHub: connected',
      )!.role,
      'assistant',
    );
    assert.equal(
      rows.find((m) => m.role === 'user')!.text,
      'GitHub: connected',
    );
    setLanguage('zh-CN');
    assert.deepEqual(
      rows.filter((m) => ids.includes(m.id)).map(formatRuntimeNotice),
      [
        'GitHub 已断开连接',
        '正在进行 GitHub 授权',
        '已连接 GitHub',
        'GitHub 连接出错',
      ],
    );
    assert.equal(
      formatRuntimeNotice(
        rows.find(
          (m) => m.role === 'assistant' && m.text === 'GitHub: connected',
        )!,
      ),
      'GitHub: connected',
    );
    const sessionId = runtime.session.id;
    await controller.close();
    controller = undefined;
    const store = new CheckpointStore(home);
    const persisted = store.messages(sessionId);
    assert.equal(persisted.filter((m) => m.runtimeNotice).length, 4);
    assert.equal(
      persisted.find(
        (m) =>
          m.role === 'assistant' &&
          m.content === 'GitHub: connected' &&
          !m.runtimeNotice,
      )!.runtimeNotice,
      undefined,
    );
    assert.equal(persisted.at(-1)!.content, 'GitHub: error');
    store.close();
    await writeFile(
      join(home, 'desktop-session.json'),
      JSON.stringify({ workspace, sessionId }),
    );
    settings.extensions.github = { enabled: false };
    saveSettings(settings, home);
    controller = new RuntimeController({
      home,
      userHome: home,
      workspace,
      model: new ScriptedModel([]),
      emit: () => {},
    });
    const replay = controller
      .snapshot()
      .sessions.find((s) => s.id === sessionId)!
      .messages.filter((m) => ids.includes(m.id));
    assert.equal(replay.length, 4);
    assert.equal(formatRuntimeNotice(replay[2]), '已连接 GitHub');
    setLanguage('en');
    assert.equal(formatRuntimeNotice(replay[2]), 'GitHub connected');
    assert.equal(replay[2].text, 'GitHub: connected');
  } finally {
    setLanguage('en');
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('a same-name user extension and legacy assistant status text are not localized as Circle notices', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-user-github-notice-')),
    home = join(root, 'home'),
    workspace = join(root, 'workspace');
  await mkdir(workspace);
  await mkdir(join(home, 'extensions', 'github'), { recursive: true });
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  await writeFile(
    join(home, 'extensions', 'github', 'extension.mjs'),
    "export function register(api){api.registerCommand('github','user content',(_args,context)=>context.append('GitHub: connected'));}",
  );
  const controller = new RuntimeController({
    home,
    userHome: home,
    workspace,
    model: new ScriptedModel([]),
    emit: () => {},
  });
  try {
    await controller.initialize();
    const runtime = getRuntime(controller);
    const reply = await controller.dispatch({
      id: 'user-github',
      name: 'custom-command',
      sessionId: runtime.session.id,
      payload: { name: 'github', args: 'status' },
    });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    const row = controller
      .snapshot()
      .sessions.find((s) => s.id === runtime.session.id)!
      .messages.at(-1)!;
    assert.equal(row.role, 'assistant');
    assert.equal(row.runtimeNotice, undefined);
    setLanguage('zh-CN');
    assert.equal(formatRuntimeNotice(row), 'GitHub: connected');
    assert.equal(
      formatRuntimeNotice({ ...row, role: 'notice' }),
      'GitHub: connected',
      'legacy text without provenance stays verbatim',
    );
  } finally {
    setLanguage('en');
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

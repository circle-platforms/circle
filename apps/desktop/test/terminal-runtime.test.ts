// The device terminals as the desktop application wires them: the runtime controller
// offers the tools only when a terminal host is connected, the destructive word and the
// unknown host key each raise their own card to the person, and the answer travels back.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeController } from '../src/runtime-controller.ts';
import type {
  RuntimeCommandName,
  RuntimeUpdate,
} from '../src/runtime-protocol.ts';
import type { TerminalPort } from '../../../src/terminal/tools.ts';
import type { TerminalRequest } from '../../../src/terminal/protocol.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import type { Message } from '../../../src/types.ts';

async function until(check: () => boolean, description: string) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}

const assistant = (
  content: string,
  calls?: Message['tool_calls'],
): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content,
  tool_calls: calls,
});

async function setup(
  t: TestContext,
  replies: ConstructorParameters<typeof ScriptedModel>[0],
  terminal?: TerminalPort,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-terminal-desktop-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  await mkdir(join(workspace, '.git'));
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const model = new ScriptedModel(replies);
  const updates: RuntimeUpdate[] = [];
  const controller = new RuntimeController({
    home,
    workspace,
    userHome: home,
    model,
    terminal,
    emit: (update) => updates.push(update),
  });
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = controller.snapshot().activeSessionId,
  ) => controller.dispatch({ id: randomUUID(), name, payload, sessionId });
  t.after(async () => {
    await controller.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, home, model, controller, call, updates };
}

test('terminal tools ride the terminal port: nine of them, main agent only', async (t) => {
  const absent = await setup(t, [{ message: assistant('no terminal') }]);
  await absent.call('prompt', { text: 'inspect tools' });
  await until(() => absent.model.requests.length === 1, 'model request');
  assert.equal(
    absent.model.requests[0]!.tools.some((tool) =>
      tool.name.startsWith('terminal_'),
    ),
    false,
  );
  const port: TerminalPort = {
    async request() {
      return { text: 'ok' };
    },
  };
  const connected = await setup(
    t,
    [{ message: assistant('terminal ready') }],
    port,
  );
  await connected.call('prompt', { text: 'inspect tools' });
  await until(() => connected.model.requests.length === 1, 'model request');
  const tools = connected.model.requests[0]!.tools.filter((tool) =>
    tool.name.startsWith('terminal_'),
  );
  assert.equal(tools.length, 9);
  assert(tools.every((tool) => tool.subagents === false));
});

test('a wipe-word send raises a card naming only the word, and the answer releases it', async (t) => {
  const requests: Omit<TerminalRequest, 'id'>[] = [];
  const port: TerminalPort = {
    async request(sessionId, action, args, signal) {
      signal.throwIfAborted();
      requests.push({ sessionId, action, args: structuredClone(args) });
      return { text: 'reboot accepted', host: 'sw1.lan:22', session: 't1' };
    },
  };
  const f = await setup(
    t,
    [
      {
        message: assistant('', [
          {
            id: 'reboot',
            name: 'terminal_send',
            args: { session: 't1', text: 'reboot now', enter: true },
          },
        ]),
      },
      { message: assistant('the device is restarting') },
    ],
    port,
  );
  await f.call('prompt', { text: 'reboot the switch' });
  await until(
    () => f.controller.snapshot().interactions.length > 0,
    'approval card',
  );
  const card = f.controller.snapshot().interactions[0]!;
  assert.equal(card.tool, 'terminal_send');
  assert.match(String(card.reason ?? ''), /destroy what the device holds/);
  assert.match(card.title, /terminal_send/);
  // the reason names the matched word alone, never the whole line
  assert.equal(String(card.reason ?? '').includes('reboot now'), false);
  assert.ok(card.choices?.includes('approve'));
  // a forced ask has no for-this-session answer: it asks again next time
  assert.equal(card.choices?.includes('always'), false);
  await f.call('answer', {
    id: card.id,
    revision: card.revision,
    answer: 'approve',
  });
  await until(
    () => f.model.requests.length === 2,
    'the turn resumes after the answer',
  );
  assert.deepEqual(
    requests.map((request) => [request.action, request.args.text]),
    [['send', 'reboot now']],
  );
});

test('an unknown device host key asks the person, and the tokened answer reconnects', async (t) => {
  const requests: Omit<TerminalRequest, 'id'>[] = [];
  const port: TerminalPort = {
    async request(sessionId, action, args, signal) {
      signal.throwIfAborted();
      requests.push({ sessionId, action, args: structuredClone(args) });
      if (!args.approval)
        return {
          text: 'sw1.lan:22 offered a host key nobody has trusted yet',
          host: 'sw1.lan:22',
          approval: {
            kind: 'hostkey',
            token: 'desktop-hk-token',
            host: 'sw1.lan:22',
            keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:desktopfp',
            privateHost: true,
          },
        };
      return { text: 'Connected: t1', host: 'sw1.lan:22', session: 't1' };
    },
  };
  const f = await setup(
    t,
    [
      {
        message: assistant('', [
          {
            id: 'open',
            name: 'terminal_connect',
            args: { profile: 'LAB-DEVICE-01' },
          },
        ]),
      },
      { message: assistant('connected') },
    ],
    port,
  );
  await f.call('prompt', { text: 'open the lab switch' });
  // the first card is the tool's own approval; a private device may allow it for good
  await until(
    () => f.controller.snapshot().interactions.length > 0,
    'the approval card',
  );
  const approval = f.controller.snapshot().interactions[0]!;
  assert.equal(approval.tool, 'terminal_connect');
  await f.call('answer', {
    id: approval.id,
    revision: approval.revision,
    answer: 'always',
  });
  // the connect now reaches the host, whose unknown key raises the second card
  await until(
    () =>
      f.controller
        .snapshot()
        .interactions.some(
          (row) => row.reason === 'trusts an unknown device host key',
        ),
    'the host key card',
  );
  const card = f.controller
    .snapshot()
    .interactions.find(
      (row) => row.reason === 'trusts an unknown device host key',
    )!;
  assert.equal(card.tool, 'terminal_connect');
  assert.match(
    String((card.input as Record<string, unknown>)?.sha256),
    /SHA256:/,
  );
  assert.ok(
    card.choices?.includes('always'),
    'a private device may be trusted',
  );
  await f.call('answer', {
    id: card.id,
    revision: card.revision,
    answer: 'always',
  });
  await until(() => f.model.requests.length === 2, 'the connect resumes');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]!.args.approval, {
    token: 'desktop-hk-token',
    scope: 'always',
  });
  // the person's token never reaches the model
  assert.equal(
    JSON.stringify(f.model.requests).includes('desktop-hk-token'),
    false,
  );
});

test('a refused device host key retires the paused login through the terminal port', async (t) => {
  const requests: Omit<TerminalRequest, 'id'>[] = [];
  const port: TerminalPort = {
    async request(sessionId, action, args, signal) {
      signal.throwIfAborted();
      requests.push({ sessionId, action, args: structuredClone(args) });
      if (action === 'connect' && !args.approval)
        return {
          text: 'sw1.lan:22 offered a host key nobody has trusted yet',
          host: 'sw1.lan:22',
          approval: {
            kind: 'hostkey',
            token: 'desktop-refuse-token',
            host: 'sw1.lan:22',
            keyType: 'ssh-ed25519',
            fingerprint: 'SHA256:desktopfp',
            privateHost: true,
          },
        };
      return { text: 'unused' };
    },
  };
  const f = await setup(
    t,
    [
      {
        message: assistant('', [
          {
            id: 'open',
            name: 'terminal_connect',
            args: { profile: 'LAB-DEVICE-01' },
          },
        ]),
      },
      { message: assistant('not connected') },
    ],
    port,
  );
  await f.call('prompt', { text: 'open the lab switch' });
  await until(
    () => f.controller.snapshot().interactions.length > 0,
    'the approval card',
  );
  const approval = f.controller.snapshot().interactions[0]!;
  await f.call('answer', {
    id: approval.id,
    revision: approval.revision,
    answer: 'always',
  });
  await until(
    () =>
      f.controller
        .snapshot()
        .interactions.some(
          (row) => row.reason === 'trusts an unknown device host key',
        ),
    'the host key card',
  );
  const card = f.controller
    .snapshot()
    .interactions.find(
      (row) => row.reason === 'trusts an unknown device host key',
    )!;
  await f.call('answer', {
    id: card.id,
    revision: card.revision,
    answer: 'reject',
  });
  await until(
    () => f.model.requests.length === 2,
    'the refusal finishes the turn',
  );
  assert.deepEqual(
    requests.map((request) => [request.action, request.args]),
    [
      ['connect', { profile: 'LAB-DEVICE-01' }],
      ['decline-host-key', { token: 'desktop-refuse-token' }],
    ],
  );
  assert.equal(
    JSON.stringify(f.model.requests).includes('desktop-refuse-token'),
    false,
  );
});

test('without a host to answer, the card falls closed: the person rejects and nothing runs', async (t) => {
  const port: TerminalPort = {
    async request() {
      return { text: 'unused' };
    },
  };
  const f = await setup(
    t,
    [
      {
        message: assistant('', [
          {
            id: 'reboot',
            name: 'terminal_send',
            args: { session: 't1', text: 'erase flash', enter: true },
          },
        ]),
      },
      { message: assistant('stopped') },
    ],
    port,
  );
  await f.call('prompt', { text: 'wipe it' });
  await until(
    () => f.controller.snapshot().interactions.length > 0,
    'the forced card',
  );
  const card = f.controller.snapshot().interactions[0]!;
  await f.call('answer', {
    id: card.id,
    revision: card.revision,
    answer: 'reject',
  });
  await until(
    () => f.model.requests.length === 2,
    'the refusal reaches the model',
  );
  const result = f.model.requests[1]!.messages.find(
    (message) => message.role === 'tool',
  );
  assert.match(
    String(result?.content),
    /reject|refus|not run|did not|blocked/i,
  );
});

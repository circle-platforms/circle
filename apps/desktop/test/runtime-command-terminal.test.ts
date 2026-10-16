import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadSettings, saveSettings } from '../../../src/settings.ts';
import { createCommandTerminalControllerFixture } from './helpers/command-terminal-controller-fixture.ts';
import type {
  CommandTerminalAvailable,
  CommandTerminalCommandReply,
  CommandTerminalResolution,
  CommandTerminalTarget,
} from '../../workbench/src/command-terminal-target.ts';
import type {
  TerminalReplay,
  TerminalSnapshot,
} from '../src/workspace/terminal.ts';

const native = {
  skip:
    process.platform === 'win32'
      ? 'bounded POSIX PTY capability is explicitly unavailable on Windows'
      : false,
};
function available(
  result: CommandTerminalResolution,
): asserts result is CommandTerminalAvailable {
  assert.equal(result.available, true, JSON.stringify(result));
}

test(
  'original execute resolves to the same real PTY, accepts input and stops without replaying the command',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    const started = await f.startParent();
    const before = f.controller.snapshot().activeSessionId;
    const result = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(result);
    assert.equal(result.target.executionSessionId, f.parentId);
    assert.equal(result.target.toolCallId, f.toolCallId);
    assert.deepEqual(result.capabilities, {
      read: true,
      input: true,
      stop: true,
      addToDraft: true,
    });
    assert.equal(f.controller.snapshot().activeSessionId, before);
    const action = <T = unknown>(action: string, params = {}) =>
      f.service<CommandTerminalCommandReply<T>>('terminal', 'command', {
        target: result.target,
        action,
        params,
      });
    const listing = await action<TerminalSnapshot[]>('list');
    available(listing);
    assert.equal(listing.value.length, 1);
    const snapshot = listing.value[0]!;
    assert.equal(snapshot.managedCommand?.commandPid, started.pid);
    assert.equal(snapshot.id, result.target.terminal.id);
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    const selected = '同一个进程输入\r\n';
    await action('write', { data: selected });
    await f.until(
      async () => (await f.read(f.workspace, f.files.input)) === selected,
      'exact original process stdin',
    );
    await action('resize', { cols: 101, rows: 31 });
    const resized = await action<TerminalSnapshot[]>('list');
    available(resized);
    assert.equal(resized.value[0]!.cols, 101);
    assert.equal(resized.value[0]!.rows, 31);
    const replay = await action<TerminalReplay>('replay', {
      afterSequence: 0,
      limit: 2000,
    });
    available(replay);
    assert.ok(
      replay.value.events.some(
        (event) => event.kind === 'data' && event.data?.includes('READY'),
      ),
    );
    assert.equal(replay.value.snapshot.managedCommand?.commandPid, started.pid);
    const closed = await action<TerminalSnapshot>('close');
    available(closed);
    assert.equal(closed.capabilities.input, false);
    assert.equal(closed.capabilities.stop, false);
    assert.ok(closed.value.managedCommand?.completion.rootExit);
    assert.ok(closed.value.managedCommand?.completion.controlledGroupEmpty);
    assert.ok(closed.value.managedCommand?.completion.transportAndLogClosed);
    assert.ok(
      ['unknown', 'unmanaged'].includes(
        closed.value.managedCommand!.completion.descendantCoverage.state,
      ),
    );
    const after = await action<TerminalReplay>('replay', {
      afterSequence: 0,
      limit: 2000,
    });
    available(after);
    assert.ok(
      after.value.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data)
        .join('')
        .includes('ECHO:同一个进程输入'),
    );
    const lateInput = await f.serviceReply('terminal', 'command', {
      target: result.target,
      action: 'write',
      params: { data: 'late' },
    });
    assert.equal(lateInput.ok, false);
    const restart = await f.serviceReply('terminal', 'restart', {
      id: snapshot.id,
    });
    assert.equal(restart.ok, false);
    // OperationLedger deliberately exposes its safe error rather than transport details.
    assert.match(restart.error!, /operation failed/);
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    assert.equal(Number(await f.read(f.workspace, f.files.pid)), started.pid);
    assert.equal(f.controller.snapshot().activeSessionId, before);
  },
);

test(
  'real TaskService child ownership and identical tool call IDs stay bound to separate original processes',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t, {
      childAssistantContent: 'actual child model output\n'.repeat(80),
    });
    const parent = await f.startParent();
    const parentTarget = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(parentTarget);
    await f.enqueueChild();
    const child = await f.startChild();
    const result = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: child.sessionId, toolCallId: f.toolCallId },
    );
    available(result);
    assert.notEqual(result.target.executionId, parentTarget.target.executionId);
    assert.notEqual(result.target.terminal.id, parentTarget.target.terminal.id);
    assert.notEqual(result.workspaceId, parentTarget.workspaceId);
    assert.equal(result.target.executionSessionId, child.sessionId);
    assert.equal(result.capabilities.addToDraft, false);
    const input = 'only-child\n';
    const written = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      { target: result.target, action: 'write', params: { data: input } },
    );
    available(written);
    await f.until(
      async () => (await f.read(child.workspace, f.files.input)) === input,
      'child original PTY input',
    );
    assert.equal(await f.read(f.workspace, f.files.input), '');
    assert.equal(Number(await f.read(child.workspace, f.files.pid)), child.pid);
    assert.equal(Number(await f.read(f.workspace, f.files.pid)), parent.pid);
    assert.equal(await f.read(child.workspace, f.files.starts), 'once\n');
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    assert.equal(f.controller.snapshot().activeSessionId, f.parentId);
    const reversed = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
      child.sessionId,
    );
    assert.equal(reversed.available, false);
    const wrongSource = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      {
        target: parentTarget.target,
        action: 'write',
        params: { data: 'forged' },
      },
      child.sessionId,
    );
    assert.equal(wrongSource.available, false);
    assert.equal(await f.read(f.workspace, f.files.input), '');
    const own = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: child.sessionId, toolCallId: f.toolCallId },
      child.sessionId,
    );
    available(own);
    assert.equal(own.capabilities.addToDraft, true);
    assert.deepEqual(own.target, result.target);
    await f.service('terminal', 'command', {
      target: result.target,
      action: 'close',
    });
    await f.until(
      () =>
        f.model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === 'assistant' &&
              message.content.includes('actual child model output'),
          ),
        ),
      'the actual child model continuation after stop',
    );
    assert.ok(
      f.model.requests.some((request) =>
        request.messages.some(
          (message) =>
            message.role === 'assistant' &&
            message.content.includes('actual child model output'),
        ),
      ),
    );
    const parentStillRunning = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(parentStillRunning);
    assert.equal(parentStillRunning.capabilities.input, true);
  },
);

test(
  'every handoff action rejects forged epochs, sessions and resource fields before any process effect',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    await f.startParent();
    const result = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(result);
    const variants: CommandTerminalTarget[] = [
      { ...result.target, executionId: randomUUID() },
      { ...result.target, epoch: randomUUID() },
      { ...result.target, executionSessionId: randomUUID() },
      { ...result.target, toolCallId: randomUUID() },
      {
        ...result.target,
        terminal: { ...result.target.terminal, epoch: randomUUID() },
      },
      {
        ...result.target,
        terminal: { ...result.target.terminal, id: randomUUID() },
      },
    ];
    for (const target of variants) {
      const reply = await f.service<CommandTerminalCommandReply>(
        'terminal',
        'command',
        { target, action: 'write', params: { data: 'must not arrive' } },
      );
      assert.equal(reply.available, false);
    }
    for (const params of [
      { target: result.target, action: 'create' },
      { target: result.target, action: 'restart' },
      {
        target: result.target,
        action: 'write',
        params: { data: 'forged', id: randomUUID() },
      },
      { target: { ...result.target, pid: process.pid }, action: 'close' },
      { target: result.target, action: 'signal', params: { signal: 'SIGHUP' } },
      {
        target: result.target,
        action: 'replay',
        params: { afterSequence: -1 },
      },
    ]) {
      const reply = await f.serviceReply('terminal', 'command', params);
      assert.equal(reply.ok, false, JSON.stringify(params));
    }
    assert.equal(await f.read(f.workspace, f.files.input), '');
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    const current = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(current);
    assert.equal(current.capabilities.input, true);
  },
);

test(
  'an original legacy execute is explicitly unavailable and resolving it never allocates another shell',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t, {
      native: false,
    });
    const started = await f.startParent();
    const result = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    assert.deepEqual(result, { available: false, reason: 'not-native' });
    const terminals = await f.service<TerminalSnapshot[]>('terminal', 'list');
    assert.deepEqual(terminals, []);
    assert.equal(Number(await f.read(f.workspace, f.files.pid)), started.pid);
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
  },
);

test(
  'an idempotent input operation reaches the original process once and emergency stop survives trust removal',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    await f.startParent();
    const resolved = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(resolved);
    const operation = {
      id: randomUUID(),
      name: 'workspace-service' as const,
      sessionId: f.parentId,
      payload: {
        service: 'terminal',
        method: 'command',
        params: {
          target: resolved.target,
          action: 'write',
          params: { data: 'one-input' },
        },
      },
    };
    const [first, duplicate] = await Promise.all([
      f.controller.dispatch(operation),
      f.controller.dispatch(operation),
    ]);
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(duplicate, first);
    await f.until(
      async () => (await f.read(f.workspace, f.files.input)) === 'one-input',
      'idempotent exact stdin',
    );
    const settings = loadSettings(f.home);
    settings.trusted_folders = [];
    saveSettings(settings, f.home);
    const blocked = await f.serviceReply('terminal', 'command', {
      target: resolved.target,
      action: 'write',
      params: { data: 'blocked' },
    });
    assert.equal(blocked.ok, false);
    const stopped = await f.service<
      CommandTerminalCommandReply<TerminalSnapshot>
    >('terminal', 'command', { target: resolved.target, action: 'close' });
    available(stopped);
    assert.equal(stopped.capabilities.stop, false);
    assert.ok(stopped.value.managedCommand?.completion.transportAndLogClosed);
    assert.equal(await f.read(f.workspace, f.files.input), 'one-input');
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
  },
);

test(
  'a different same-workspace conversation does not inherit command control through the notification owner',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    await f.startParent();
    const original = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(original);
    const opened = await f.call('new-session');
    assert.equal(opened.ok, true, opened.error);
    const unrelated = f.controller.snapshot().activeSessionId;
    assert.notEqual(unrelated, f.parentId);
    const resolve = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
      unrelated,
    );
    assert.equal(resolve.available, false);
    const stopped = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      { target: original.target, action: 'close' },
      unrelated,
    );
    assert.equal(stopped.available, false);
    const retained = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(retained);
    assert.equal(retained.capabilities.input, true);
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
  },
);

test(
  'stored command receipt and persisted double-epoch terminal restore read-only without replaying any process',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    const started = await f.startParent();
    const original = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(original);
    await f.service('terminal', 'command', {
      target: original.target,
      action: 'write',
      params: { data: 'saved history 原文\n' },
    });
    await f.until(
      async () =>
        (await f.read(f.workspace, f.files.input)) === 'saved history 原文\n',
      'real history input',
    );
    const stopped = await f.service<
      CommandTerminalCommandReply<TerminalSnapshot>
    >('terminal', 'command', { target: original.target, action: 'close' });
    available(stopped);
    assert.equal(
      stopped.value.managedCommand?.executionEpoch,
      original.target.epoch,
    );
    await f.until(
      () =>
        f.model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.commandExecutions?.some(
                (receipt) =>
                  receipt.executionId === original.target.executionId,
              ),
          ),
        ),
      'durable command receipt enters actual next model request',
    );
    const beforeReplay = await f.service<
      CommandTerminalCommandReply<TerminalReplay>
    >('terminal', 'command', {
      target: original.target,
      action: 'replay',
      params: { limit: 2000 },
    });
    available(beforeReplay);
    const raw = beforeReplay.value.events
      .filter((event) => event.kind === 'data')
      .map((event) => event.data)
      .join('');
    const requestCount = f.model.requests.length;
    await f.restart();
    const restored = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(restored);
    assert.deepEqual(restored.target, original.target);
    assert.deepEqual(restored.capabilities, {
      read: true,
      input: false,
      stop: false,
      addToDraft: true,
    });
    const replay = await f.service<CommandTerminalCommandReply<TerminalReplay>>(
      'terminal',
      'command',
      { target: restored.target, action: 'replay', params: { limit: 2000 } },
    );
    available(replay);
    assert.equal(
      replay.value.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data)
        .join(''),
      raw,
    );
    assert.equal(replay.value.snapshot.managedCommand?.commandPid, started.pid);
    for (const action of [
      { action: 'write', params: { data: 'must not execute' } },
      { action: 'resize', params: { cols: 42, rows: 15 } },
      { action: 'signal', params: { signal: 'SIGINT' } },
      { action: 'signal', params: { signal: 'SIGTERM' } },
      { action: 'close' },
      { action: 'restart' },
    ]) {
      const reply = await f.serviceReply('terminal', 'command', {
        target: restored.target,
        ...action,
      });
      assert.equal(reply.ok, false, action.action);
    }
    const wrongEpoch = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      { target: { ...restored.target, epoch: randomUUID() }, action: 'replay' },
    );
    assert.equal(wrongEpoch.available, false);
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    assert.equal(
      await f.read(f.workspace, f.files.input),
      'saved history 原文\n',
    );
    assert.equal(f.model.requests.length, requestCount);
  },
);

test(
  'an archived real child ledger grants only read-only original output after a controller restart',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    await f.enqueueChild();
    const child = await f.startChild();
    const original = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: child.sessionId, toolCallId: f.toolCallId },
    );
    available(original);
    await f.service('terminal', 'command', {
      target: original.target,
      action: 'close',
    });
    await f.until(
      () =>
        f.model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.commandExecutions?.some(
                (receipt) =>
                  receipt.executionId === original.target.executionId,
              ),
          ),
        ),
      'actual child durable receipt',
    );
    await f.restart();
    const restored = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: child.sessionId, toolCallId: f.toolCallId },
    );
    available(restored);
    assert.deepEqual(restored.target, original.target);
    assert.deepEqual(restored.capabilities, {
      read: true,
      input: false,
      stop: false,
      addToDraft: false,
    });
    const replay = await f.service<CommandTerminalCommandReply<TerminalReplay>>(
      'terminal',
      'command',
      { target: restored.target, action: 'replay' },
    );
    available(replay);
    assert.ok(
      replay.value.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data)
        .join('')
        .includes('READY'),
    );
    const stopped = await f.serviceReply('terminal', 'command', {
      target: restored.target,
      action: 'close',
    });
    assert.equal(stopped.ok, true);
    assert.equal((stopped.data as CommandTerminalResolution).available, false);
    assert.equal(await f.read(child.workspace, f.files.starts), 'once\n');
    assert.equal(f.controller.snapshot().activeSessionId, f.parentId);
    const selected = await f.call('select-session', { id: child.sessionId });
    assert.equal(selected.ok, true, selected.error);
    const trusted = await f.call('trust', { enabled: true }, child.sessionId);
    assert.equal(trusted.ok, true, trusted.error);
    const prompted = await f.call(
      'prompt',
      { text: 'command terminal fixture: start the parent command' },
      child.sessionId,
    );
    assert.equal(prompted.ok, true, prompted.error);
    await f.approve(child.sessionId);
    await f.until(
      async () =>
        (await f.read(child.workspace, f.files.starts)) === 'once\nonce\n' &&
        Number(await f.read(child.workspace, f.files.pid)) !== child.pid,
      'manually reopened actual child starts a new approved process',
    );
    const snapshots = await f.service<TerminalSnapshot[]>(
      'terminal',
      'list',
      {},
      child.sessionId,
    );
    const newSnapshot = snapshots.find(
      (snapshot) =>
        snapshot.managedCommand?.executionId !== original.target.executionId &&
        snapshot.managedCommand?.toolCallId === f.toolCallId,
    )!;
    assert.ok(newSnapshot?.managedCommand?.executionEpoch);
    const newTarget: CommandTerminalTarget = {
      executionId: newSnapshot.managedCommand.executionId,
      epoch: newSnapshot.managedCommand.executionEpoch,
      executionSessionId: child.sessionId,
      toolCallId: f.toolCallId,
      terminal: { id: newSnapshot.id, epoch: newSnapshot.epoch },
    };
    const parentWrite = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      {
        target: newTarget,
        action: 'write',
        params: { data: 'old parent cannot control the reopened child' },
      },
    );
    assert.equal(parentWrite.available, false);
    assert.equal(await f.read(child.workspace, f.files.input), '');
    const selfWrite = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      {
        target: newTarget,
        action: 'write',
        params: { data: 'new actual child owner' },
      },
      child.sessionId,
    );
    available(selfWrite);
    await f.until(
      async () =>
        (await f.read(child.workspace, f.files.input)) ===
        'new actual child owner',
      'reopened child self controls its exact new process',
    );
    await f.service(
      'terminal',
      'command',
      { target: newTarget, action: 'close' },
      child.sessionId,
    );
  },
);

test(
  'history refuses missing or changed Registry epoch and terminal identity instead of granting live control',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    await f.startParent();
    const original = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(original);
    const stopped = await f.service<
      CommandTerminalCommandReply<TerminalSnapshot>
    >('terminal', 'command', { target: original.target, action: 'close' });
    available(stopped);
    await f.until(
      () =>
        f.model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.commandExecutions?.some(
                (receipt) =>
                  receipt.executionId === original.target.executionId,
              ),
          ),
        ),
      'stored original receipt',
    );
    await f.controller.close();
    const metadataPath = join(dirname(stopped.value.logPath), 'metadata.json');
    const metadata = JSON.parse(
      await readFile(metadataPath, 'utf8'),
    ) as TerminalSnapshot;
    const missing = structuredClone(metadata);
    delete missing.managedCommand!.executionEpoch;
    const wrongRegistry = structuredClone(metadata);
    wrongRegistry.managedCommand!.executionEpoch = randomUUID();
    const wrongTerminal = structuredClone(metadata);
    wrongTerminal.epoch = randomUUID();
    const wrongOwner = structuredClone(metadata);
    wrongOwner.managedCommand!.toolCallId = 'another-call';
    for (const changed of [missing, wrongRegistry, wrongTerminal, wrongOwner]) {
      await f.controller.close();
      await writeFile(metadataPath, JSON.stringify(changed));
      await f.restart();
      const resolved = await f.service<CommandTerminalResolution>(
        'terminal',
        'resolveCommand',
        { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
      );
      assert.equal(resolved.available, false);
      const replay: CommandTerminalCommandReply =
        await f.service<CommandTerminalCommandReply>('terminal', 'command', {
          target: original.target,
          action: 'replay',
        });
      assert.equal(replay.available, false);
      assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    }
    await f.controller.close();
    await writeFile(metadataPath, JSON.stringify(metadata));
    await f.restart();
    const restored = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(restored);
    assert.equal(restored.capabilities.input, false);
    assert.equal(restored.capabilities.stop, false);
    assert.deepEqual(restored.target, original.target);
  },
);

test(
  'a reused provider call ID after restart cannot rebind an old command card to a new live process',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    const first = await f.startParent();
    const original = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(original);
    await f.service('terminal', 'command', {
      target: original.target,
      action: 'close',
    });
    await f.until(
      () =>
        f.model.requests.some((request) =>
          request.messages.some(
            (message) =>
              message.role === 'tool' &&
              message.commandExecutions?.some(
                (receipt) =>
                  receipt.executionId === original.target.executionId,
              ),
          ),
        ),
      'first stored execution',
    );
    await f.restart();
    await f.startParent();
    await f.until(
      async () =>
        (await f.read(f.workspace, f.files.starts)) === 'once\nonce\n' &&
        Number(await f.read(f.workspace, f.files.pid)) !== first.pid,
      'second actual process with a reused provider call ID',
    );
    const resolve = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    assert.equal(resolve.available, false);
    const oldTarget = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      {
        target: original.target,
        action: 'write',
        params: { data: 'must not reach the newer process' },
      },
    );
    assert.equal(oldTarget.available, false);
    assert.equal(await f.read(f.workspace, f.files.input), '');
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\nonce\n');
  },
);

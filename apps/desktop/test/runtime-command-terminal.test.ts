import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('a quiet human command request executes once after cache eviction and controller restart, and its private result is encrypted', async (t) => {
  const f = await createCommandTerminalControllerFixture(t, { native: false });
  const secret = 'QUIET_PRIVATE_COMMAND_中文_7c9241';
  await writeFile(
    join(f.workspace, 'manual-once.cjs'),
    `const fs=require('node:fs');fs.appendFileSync('manual-effect','once\\n');console.log(${JSON.stringify(secret)});process.exit(7);`,
  );
  const executable =
    process.platform === 'win32'
      ? `"${process.execPath}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
  const command = {
    id: randomUUID(),
    sessionId: f.parentId,
    name: 'shell' as const,
    payload: { command: `${executable} manual-once.cjs`, quiet: true },
  };
  const [first, concurrent] = await Promise.all([
    f.controller.dispatch(command),
    f.controller.dispatch(command),
  ]);
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(concurrent.data, first.data);
  assert.equal((first.data as { exit_code: number }).exit_code, 7);
  for (let i = 0; i < 105; i++) await f.service('terminal', 'list');
  const evicted = await f.controller.dispatch(command);
  assert.equal(evicted.ok, true, evicted.error);
  assert.deepEqual(evicted.data, first.data);
  assert.equal(await f.read(f.workspace, 'manual-effect'), 'once\n');
  await f.restart();
  const restored = await f.controller.dispatch(command);
  assert.equal(restored.ok, true, restored.error);
  assert.deepEqual(restored.data, first.data);
  assert.equal(await f.read(f.workspace, 'manual-effect'), 'once\n');
  for (const payload of [
    { ...command.payload, quiet: false },
    { ...command.payload, command: `${executable} manual-once.cjs changed` },
  ]) {
    const reply = await f.controller.dispatch({ ...command, payload });
    assert.equal(reply.ok, false);
    assert.match(
      reply.error!,
      /reused with different input|identity was reused/,
    );
  }
  assert.equal(await f.read(f.workspace, 'manual-effect'), 'once\n');
  assert.equal(f.model.requests.length, 0);
  assert.equal(
    f.controller
      .snapshot()
      .sessions.find((session) => session.id === f.parentId)!
      .messages.some((message) => message.shell),
    false,
  );
  const operation = (
    await f.service<
      { id: string; service: string; method: string; state: string }[]
    >('operations', 'list')
  ).find((entry) => entry.id === command.id);
  assert.equal(operation?.state, 'completed');
  assert.equal(operation?.service, 'shell');
  assert.equal(operation?.method, 'run');
  const directory = join(f.data, 'workspace-operations');
  const inspect = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else {
        const bytes = await readFile(path);
        assert.equal(bytes.includes(Buffer.from(secret)), false);
        assert.equal(
          bytes.includes(Buffer.from(command.payload.command)),
          false,
        );
      }
    }
  };
  await inspect(directory);
});

test('a real human command effect interrupted before ledger completion remains reviewable and cannot run again after restart', async (t) => {
  const f = await createCommandTerminalControllerFixture(t, { native: false });
  const retained = await f.call('shell', { command: 'echo retained-owner' });
  assert.equal(retained.ok, true, retained.error);
  await f.controller.close();
  await writeFile(
    join(f.workspace, 'manual-unknown.cjs'),
    "require('node:fs').appendFileSync('manual-unknown-effect','once\\n');console.log('effect completed');",
  );
  const executable =
    process.platform === 'win32'
      ? `"${process.execPath}"`
      : `'${process.execPath.replaceAll("'", "'\\''")}'`;
  const command = {
    id: randomUUID(),
    sessionId: f.parentId,
    name: 'shell' as const,
    payload: { command: `${executable} manual-unknown.cjs`, quiet: true },
  };
  const moduleUrl = (path: string) =>
    pathToFileURL(fileURLToPath(new URL(path, import.meta.url))).href;
  const crash = join(f.root, 'human-ledger-crash.mts');
  await writeFile(
    crash,
    `import {RuntimeController} from ${JSON.stringify(moduleUrl('../src/runtime-controller.ts'))};
import {OperationLedger} from ${JSON.stringify(moduleUrl('../src/workspace/operation-ledger.ts'))};
import {ScriptedModel} from ${JSON.stringify(moduleUrl('../../../src/testing.ts'))};
import {writeFileSync} from 'node:fs';
const run=OperationLedger.prototype.run;
OperationLedger.prototype.run=function(identity,action){return run.call(this,identity,async()=>{const result=await action();if(identity.id===${JSON.stringify(command.id)}){writeFileSync(${JSON.stringify(join(f.root, 'actual-crash-result.json'))},JSON.stringify(result));process.exit(23);}return result;});};
const controller=new RuntimeController({...${JSON.stringify({ home: f.home, userHome: f.home, workspace: f.workspace, dataFolder: f.data })},model:new ScriptedModel(),emit:()=>{}});
const reply=await controller.dispatch(${JSON.stringify(command)});throw Error(JSON.stringify(reply));
`,
  );
  const tsx = fileURLToPath(
    new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
  );
  const crashed = spawnSync(process.execPath, [tsx, crash], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(crashed.status, 23, crashed.stderr);
  assert.equal(
    JSON.parse(await readFile(join(f.root, 'actual-crash-result.json'), 'utf8'))
      .exit_code,
    0,
  );
  assert.equal(await f.read(f.workspace, 'manual-unknown-effect'), 'once\n');
  await f.restart();
  const reply = await f.controller.dispatch(command);
  assert.equal(reply.ok, false);
  assert.match(
    reply.error!,
    /needs review|requires review|outcome needs review/,
  );
  assert.equal(await f.read(f.workspace, 'manual-unknown-effect'), 'once\n');
  const operation = (
    await f.service<{ id: string; state: string }[]>('operations', 'list')
  ).find((entry) => entry.id === command.id);
  assert.equal(operation?.state, 'needs_review');
  assert.equal(f.model.requests.length, 0);
  assert.equal(
    f.controller
      .snapshot()
      .sessions.find((session) => session.id === f.parentId)!
      .messages.filter((message) => message.shell).length,
    1,
    'only the unrelated explicitly shared retention command enters history',
  );
});

for (const guard of ['busy', 'plan'] as const)
  test(
    `human ${guard} rejection keeps its original feedback and cannot become a delayed command after cache eviction or restart`,
    native,
    async (t) => {
      const f = await createCommandTerminalControllerFixture(t);
      if (guard === 'busy') await f.startParent();
      else
        assert.equal(
          (await f.call('set-plan-mode', { enabled: true })).ok,
          true,
        );
      const modelRequests = f.model.requests.length;
      const request = {
        id: randomUUID(),
        sessionId: f.parentId,
        name: 'shell' as const,
        payload: { command: 'printf started > guard-effect', quiet: true },
      };
      const rejected = await f.controller.dispatch(request);
      assert.equal(rejected.ok, false);
      assert.equal(
        rejected.error,
        guard === 'busy'
          ? 'Busy · run it when the turn has finished'
          : 'Plan mode is active: shell execute is blocked. Use /plan off.',
      );
      await assert.rejects(readFile(join(f.workspace, 'guard-effect')), {
        code: 'ENOENT',
      });
      assert.equal(
        f.controller
          .snapshot()
          .sessions.find((session) => session.id === f.parentId)!
          .messages.some((message) => message.shell),
        false,
      );
      if (guard === 'busy') assert.equal((await f.call('abort')).ok, true);
      else
        assert.equal(
          (await f.call('set-plan-mode', { enabled: false })).ok,
          true,
        );
      for (let i = 0; i < 105; i++) await f.service('terminal', 'list');
      const evicted = await f.controller.dispatch(request);
      assert.equal(evicted.ok, false);
      assert.equal(evicted.error, rejected.error);
      await f.restart();
      const restored = await f.controller.dispatch(request);
      assert.equal(restored.ok, false);
      assert.equal(restored.error, rejected.error);
      const operation = (
        await f.service<{ id: string; state: string }[]>('operations', 'list')
      ).find((entry) => entry.id === request.id);
      assert.equal(operation?.state, 'rejected');
      await assert.rejects(readFile(join(f.workspace, 'guard-effect')), {
        code: 'ENOENT',
      });
      assert.equal(f.model.requests.length, modelRequests);
      assert.equal(
        f.controller
          .snapshot()
          .sessions.find((session) => session.id === f.parentId)!
          .messages.some((message) => message.shell),
        false,
      );
    },
  );

test(
  'a human command card addresses its original PTY and restores only read access to the shared command after restart',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    await writeFile(
      join(f.workspace, 'human-input.cjs'),
      `const fs = require('node:fs');
fs.appendFileSync('human-starts', 'once\\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
fs.writeFileSync('human-pid', String(process.pid));
process.stdin.on('data', bytes => {
  fs.appendFileSync('human-input', bytes);
  process.stdout.write('HUMAN-ECHO:' + bytes.toString('utf8'), () => process.exit(7));
});
console.log('HUMAN-READY');
process.stdin.resume();
`,
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const running = f.call('shell', {
      command: `exec ${quote(process.execPath)} human-input.cjs`,
    });
    const projected = () =>
      f.controller
        .snapshot()
        .sessions.find((session) => session.id === f.parentId)
        ?.messages.find((message) => message.shell?.interactive);
    await f.until(
      async () => !!(await f.read(f.workspace, 'human-pid')) && !!projected(),
      'actual human process and its original card',
    );
    const card = projected()!;
    const shellId = card.shell!.id!;
    assert.equal(card.id, 'user-shell-' + shellId);
    assert.equal(card.shell!.sourceSessionId, f.parentId);
    assert.equal(card.tool, undefined);
    assert.equal(f.model.requests.length, 0);
    const resolved = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      {
        sourceSessionId: f.parentId,
        userShellId: shellId,
      },
    );
    available(resolved);
    assert.equal(resolved.target.origin, 'user-shell');
    assert.equal(resolved.target.userShellId, shellId);
    assert.equal(resolved.target.toolCallId, undefined);
    const listing = await f.service<
      CommandTerminalCommandReply<TerminalSnapshot[]>
    >('terminal', 'command', {
      target: resolved.target,
      action: 'list',
    });
    available(listing);
    const terminal = listing.value[0]!;
    assert.equal(
      terminal.managedCommand?.commandPid,
      Number(await f.read(f.workspace, 'human-pid')),
    );
    assert.equal(terminal.managedCommand?.userShellId, shellId);
    assert.equal(terminal.managedCommand?.toolCallId, undefined);
    assert.equal(
      (
        await f.serviceReply('terminal', 'resolveCommand', {
          sourceSessionId: f.parentId,
          userShellId: shellId,
          toolCallId: f.toolCallId,
        })
      ).ok,
      false,
    );
    const forged = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      {
        sourceSessionId: f.parentId,
        userShellId: randomUUID(),
      },
    );
    assert.equal(forged.available, false);
    const stale = await f.service<CommandTerminalCommandReply>(
      'terminal',
      'command',
      {
        target: { ...resolved.target, epoch: randomUUID() },
        action: 'write',
        params: { data: 'must not reach the process' },
      },
    );
    assert.equal(stale.available, false);
    const input = '人工命令的原进程输入\r\n';
    await f.service('terminal', 'command', {
      target: resolved.target,
      action: 'write',
      params: { data: input },
    });
    const completed = await running;
    assert.equal(completed.ok, true, completed.error);
    assert.equal((completed.data as { exit_code: number }).exit_code, 7);
    assert.equal(await f.read(f.workspace, 'human-input'), input);
    assert.equal(await f.read(f.workspace, 'human-starts'), 'once\n');
    const shared = f.controller
      .snapshot()
      .sessions.find((session) => session.id === f.parentId)!
      .messages.find((message) => message.shell?.id === shellId)!;
    // Stored rows retain their existing checkpoint ID; the actual command ID
    // is stable across the transient and persisted projections.
    assert.equal(shared.shell!.id, card.shell!.id);
    assert.equal(shared.shell!.status, 'error');
    assert.equal(shared.shell!.exitCode, 7);
    assert.ok(shared.shell!.output.includes('HUMAN-ECHO:人工命令的原进程输入'));
    assert.equal(f.model.requests.length, 0);
    await f.restart();
    const restored = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      {
        sourceSessionId: f.parentId,
        userShellId: shellId,
      },
    );
    available(restored);
    assert.deepEqual(restored.target, resolved.target);
    assert.equal(restored.capabilities.input, false);
    assert.equal(restored.capabilities.stop, false);
    const replay = await f.service<CommandTerminalCommandReply<TerminalReplay>>(
      'terminal',
      'command',
      {
        target: restored.target,
        action: 'replay',
        params: { afterSequence: 0, limit: 2000 },
      },
    );
    available(replay);
    assert.ok(
      replay.value.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data)
        .join('')
        .includes('HUMAN-ECHO:人工命令的原进程输入'),
    );
    assert.equal(replay.value.snapshot.managedCommand?.userShellId, shellId);
    for (const request of [
      { action: 'write', params: { data: 'historical input' } },
      { action: 'resize', params: { cols: 99, rows: 31 } },
      { action: 'close' },
      { action: 'restart' },
    ])
      assert.equal(
        (
          await f.serviceReply('terminal', 'command', {
            target: restored.target,
            ...request,
          })
        ).ok,
        false,
      );
    assert.equal(await f.read(f.workspace, 'human-starts'), 'once\n');
    assert.equal(f.model.requests.length, 0);
    assert.equal(
      f.controller
        .snapshot()
        .sessions.find((session) => session.id === f.parentId)!
        .messages.find((message) => message.shell?.id === shellId)!.shell!.id,
      shellId,
    );
  },
);

test(
  'quiet human PTYs retain their existing terminal journal without adding a model-history message or a fabricated tool call',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    const reply = await f.call('shell', {
      command: 'printf quiet-human-output',
      quiet: true,
    });
    assert.equal(reply.ok, true, reply.error);
    const card = f.controller
      .snapshot()
      .sessions.find((session) => session.id === f.parentId)!
      .messages.find((message) => message.shell)!;
    assert.equal(card.shell!.quiet, true);
    assert.equal(card.shell!.output, 'quiet-human-output');
    const shellId = card.shell!.id!;
    const resolved = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, userShellId: shellId },
    );
    available(resolved);
    assert.equal(resolved.capabilities.input, false);
    await f.restart();
    assert.equal(f.model.requests.length, 0);
    assert.equal(
      f.controller
        .snapshot()
        .sessions.find((session) => session.id === f.parentId)!
        .messages.some((message) => message.shell),
      false,
    );
    const absent = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, userShellId: shellId },
    );
    assert.equal(absent.available, false);
    const history = await f.service<TerminalSnapshot[]>('terminal', 'list');
    const original = history.find(
      (snapshot) => snapshot.managedCommand?.userShellId === shellId,
    )!;
    assert.ok(original);
    assert.equal(original.managedCommand!.toolCallId, undefined);
    const replay = await f.service<TerminalReplay>('terminal', 'replay', {
      id: original.id,
      afterSequence: 0,
      limit: 2000,
    });
    assert.ok(
      replay.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data)
        .join('')
        .includes('quiet-human-output'),
    );
  },
);

test(
  'stopping a human command through its original terminal preserves the stopped local card and no shared history',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t);
    const running = f.call('shell', { command: f.command });
    const pid = await f.ready(f.workspace);
    const card = f.controller
      .snapshot()
      .sessions.find((session) => session.id === f.parentId)!
      .messages.find((message) => message.shell?.interactive)!;
    const shellId = card.shell!.id!;
    const resolved = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, userShellId: shellId },
    );
    available(resolved);
    const stopped = await f.service<
      CommandTerminalCommandReply<TerminalSnapshot>
    >('terminal', 'command', { target: resolved.target, action: 'close' });
    available(stopped);
    assert.equal(stopped.value.managedCommand?.commandPid, pid);
    assert.ok(stopped.value.managedCommand?.completion.rootExit);
    assert.ok(stopped.value.managedCommand?.completion.controlledGroupEmpty);
    assert.ok(stopped.value.managedCommand?.completion.transportAndLogClosed);
    assert.equal((await running).ok, true);
    const local = f.controller
      .snapshot()
      .sessions.find((session) => session.id === f.parentId)!
      .messages.find((message) => message.shell?.id === shellId)!;
    assert.equal(local.shell!.status, 'stopped');
    assert.equal(local.id, card.id);
    assert.equal(f.model.requests.length, 0);
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    await f.restart();
    assert.equal(
      f.controller
        .snapshot()
        .sessions.find((session) => session.id === f.parentId)!
        .messages.some((message) => message.shell?.id === shellId),
      false,
    );
    const terminals = await f.service<TerminalSnapshot[]>('terminal', 'list');
    const original = terminals.find(
      (terminal) => terminal.managedCommand?.userShellId === shellId,
    )!;
    assert.ok(original);
    assert.equal(original.managedCommand?.toolCallId, undefined);
    const replay = await f.service<TerminalReplay>('terminal', 'replay', {
      id: original.id,
      limit: 2000,
    });
    assert.ok(
      replay.events.some(
        (event) => event.kind === 'data' && event.data?.includes('READY'),
      ),
    );
    assert.equal(f.model.requests.length, 0);
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
  },
);

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
  'a retained shell root and its distinct application child share the original PTY and preserve their real identities in history',
  native,
  async (t) => {
    const f = await createCommandTerminalControllerFixture(t, {
      commandRoot: 'shell-child',
    });
    const application = await f.startParent();
    const rootPid = Number(await f.read(f.workspace, f.files.shellPid));
    await f.until(
      async () => Number(await f.read(f.workspace, f.files.parentPid)) > 0,
      'application records its actual parent',
    );
    const actualParentPid = Number(
      await f.read(f.workspace, f.files.parentPid),
    );
    assert.equal(actualParentPid, rootPid);
    assert.notEqual(rootPid, application.pid);
    const result = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(result);
    const listing = await f.service<
      CommandTerminalCommandReply<TerminalSnapshot[]>
    >('terminal', 'command', { target: result.target, action: 'list' });
    available(listing);
    assert.equal(listing.value.length, 1);
    const snapshot = listing.value[0]!;
    assert.equal(snapshot.managedCommand?.commandPid, rootPid);
    assert.notEqual(snapshot.pid, rootPid);
    const lineage = execFileSync(
      '/bin/ps',
      [
        '-p',
        [snapshot.pid, rootPid, application.pid].join(','),
        '-o',
        'pid=,ppid=,pgid=',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number));
    const root = lineage.find(([pid]) => pid === rootPid)!;
    const child = lineage.find(([pid]) => pid === application.pid)!;
    assert.equal(root[1], snapshot.pid);
    assert.equal(child[1], rootPid);
    assert.equal(root[2], snapshot.pid);
    assert.equal(child[2], root[2]);
    t.diagnostic(
      JSON.stringify({
        kind: 'real retained shell and application lineage',
        transportPid: snapshot.pid,
        commandPid: rootPid,
        applicationPid: application.pid,
        actualParentPid,
        lineage,
        terminalId: snapshot.id,
        executionId: result.target.executionId,
      }),
    );
    const input = '原 shell 子进程 exact input\r\n';
    await f.service('terminal', 'command', {
      target: result.target,
      action: 'write',
      params: { data: input },
    });
    await f.until(
      async () => (await f.read(f.workspace, f.files.input)) === input,
      'original application child receives exact input through its original PTY',
    );
    const stopped = await f.service<
      CommandTerminalCommandReply<TerminalSnapshot>
    >('terminal', 'command', { target: result.target, action: 'close' });
    available(stopped);
    assert.equal(stopped.value.managedCommand?.commandPid, rootPid);
    assert.ok(stopped.value.managedCommand?.completion.rootExit);
    assert.ok(stopped.value.managedCommand?.completion.controlledGroupEmpty);
    assert.ok(stopped.value.managedCommand?.completion.transportAndLogClosed);
    await f.until(
      () =>
        f.model.requests.some((request) =>
          request.messages.some((message) =>
            message.commandExecutions?.some(
              (receipt) => receipt.executionId === result.target.executionId,
            ),
          ),
        ),
      'retained-shell receipt reaches the next actual model request',
    );
    const requestCount = f.model.requests.length;
    await f.restart();
    const restored = await f.service<CommandTerminalResolution>(
      'terminal',
      'resolveCommand',
      { sourceSessionId: f.parentId, toolCallId: f.toolCallId },
    );
    available(restored);
    assert.deepEqual(restored.target, result.target);
    assert.equal(restored.capabilities.input, false);
    assert.equal(restored.capabilities.stop, false);
    const replay = await f.service<CommandTerminalCommandReply<TerminalReplay>>(
      'terminal',
      'command',
      { target: restored.target, action: 'replay', params: { limit: 2000 } },
    );
    available(replay);
    assert.equal(replay.value.snapshot.managedCommand?.commandPid, rootPid);
    assert.equal(replay.value.snapshot.pid, snapshot.pid);
    assert.ok(
      replay.value.events
        .filter((event) => event.kind === 'data')
        .map((event) => event.data)
        .join('')
        .includes('ECHO:原 shell 子进程 exact input'),
    );
    assert.equal(await f.read(f.workspace, f.files.starts), 'once\n');
    assert.equal(
      Number(await f.read(f.workspace, f.files.pid)),
      application.pid,
    );
    assert.equal(await f.read(f.workspace, f.files.input), input);
    assert.equal(f.model.requests.length, requestCount);
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
    const original = result.target;
    if (original.origin === 'user-shell') throw Error('expected a tool target');
    const variants: CommandTerminalTarget[] = [
      { ...original, executionId: randomUUID() },
      { ...original, epoch: randomUUID() },
      { ...original, executionSessionId: randomUUID() },
      { ...original, toolCallId: randomUUID() },
      {
        ...original,
        terminal: { ...original.terminal, epoch: randomUUID() },
      },
      {
        ...original,
        terminal: { ...original.terminal, id: randomUUID() },
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

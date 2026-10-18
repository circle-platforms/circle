import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection, type Socket } from 'node:net';
import { JobRegistry } from '../../../src/jobs.js';
import { Sandbox } from '../../../src/sandbox.js';
import { AgentRuntime } from '../../../src/runtime.js';
import { ScriptedModel } from '../../../src/testing.js';
import { defaultSettings } from '../../../src/settings.js';
import { saveSecret } from '../../../src/secrets.js';
import {
  TerminalManager,
  type TerminalEvent,
} from '../src/workspace/terminal.ts';
import {
  createTerminalCommandLauncher,
  type TerminalCommandLauncherOptions,
} from '../src/workspace/command-terminal.ts';
import type { CommandExecution } from '../../../src/command_process.js';
import { signalProcessGroup } from '../../../src/process_group.js';

const unix = process.platform !== 'win32';
const supervisorPath = fileURLToPath(
  new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 8000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end)
      throw Error('managed PTY fixture timed out: ' + label);
    await delay(10);
  }
}
async function read(path: string) {
  return readFile(path, 'utf8').catch(() => '');
}
async function setup(
  t: TestContext,
  corruptLog = false,
  overrides: Partial<
    Pick<TerminalCommandLauncherOptions, 'supervisorPath' | 'readyTimeoutMs'>
  > = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-command-pty-')),
    workspace = join(root, 'workspace'),
    home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  const events: TerminalEvent[] = [],
    snapshots: CommandExecution[] = [];
  const terminals = new TerminalManager(
    {
      workspaceRoot: workspace,
      logRoot: join(root, 'terminal'),
      shellAllowlist: ['/bin/sh'],
      env: { HOME: home, HISTFILE: '/dev/null' },
      stopGraceMs: 150,
    },
    (event) => {
      events.push(event);
    },
  );
  let jobs!: JobRegistry,
    stopDelegations = 0;
  const launcher = createTerminalCommandLauncher({
    terminals,
    runtimeExecutable: process.execPath,
    supervisorPath,
    ...overrides,
    stopExecution: async (owner, id, reason) => {
      stopDelegations++;
      return jobs.stopExecution(owner, id, reason);
    },
  });
  jobs = new JobRegistry(
    new Sandbox(workspace, join(root, 'data')),
    () => {},
    16,
    undefined,
    {
      commandLauncher: async (request) => {
        if (corruptLog) {
          await rm(request.outputPath);
          await mkdir(request.outputPath);
        }
        return launcher(request);
      },
      onExecution: (state) => snapshots.push(state),
    },
  );
  let unknownCleanup: (() => Promise<void>) | undefined;
  let beforeCleanup: (() => Promise<void>) | undefined;
  t.after(async () => {
    await beforeCleanup?.();
    if (unknownCleanup) {
      await unknownCleanup();
      await assert.rejects(jobs.close());
      await assert.rejects(terminals.dispose(), /some terminals did not stop/);
    } else {
      await jobs.close();
      await terminals.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });
  const command = async (body: string, name = 'program') => {
    const path = join(workspace, name + '.cjs');
    await writeFile(path, body);
    return quote(process.execPath) + ' ' + quote(path);
  };
  return {
    root,
    workspace,
    home,
    events,
    snapshots,
    terminals,
    jobs,
    launcher,
    command,
    stopDelegations: () => stopDelegations,
    unknownCleanup: (cleanup: () => Promise<void>) => {
      unknownCleanup = cleanup;
    },
    beforeCleanup: (cleanup: () => Promise<void>) => {
      beforeCleanup = cleanup;
    },
  };
}
async function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

test(
  'one real managed PTY keeps actual shell identity, interactive stdin, original inode and complete Unicode output through promotion',
  { skip: !unix },
  async (t) => {
    const f = await setup(t),
      tail = 'TAIL_' + '中🙂'.repeat(10000) + '_END';
    const command = await f.command(
      String.raw`const fs=require('fs');fs.appendFileSync('starts','once\n');console.log('READY');process.stdin.once('data',data=>{fs.writeFileSync('input',data);fs.writeSync(1,${JSON.stringify(tail)});process.stdin.destroy();});`,
    );
    const running = f.jobs.execute(
      command,
      {
        sessionId: 'parent',
        origin: {
          executionSessionId: 'child',
          toolCallId: 'same-process',
          displayCommand: 'approved command',
        },
      },
      new AbortController().signal,
    );
    await until(
      () => f.snapshots.some((state) => !!state.terminal),
      'same PTY reference',
    );
    const before = f.jobs.executionFor('child', 'same-process')!;
    await until(
      () => f.events.some((event) => event.data?.includes('READY')),
      'real stdout',
    );
    const native = (await f.terminals.list('child'))[0]!;
    assert.equal((await f.terminals.list('parent')).length, 0);
    assert.equal(native.managedCommand!.executionId, before.executionId);
    assert.equal(native.managedCommand!.ownership, 'pty-group');
    assert.notEqual(
      native.pid,
      before.pid,
      'supervisor transport PID and actual shell PID are explicit separate identities',
    );
    await assert.rejects(
      f.terminals.write('parent', native.id, 'wrong\r'),
      /not found/,
    );
    const originalPath = f.events.find(
      (event) => event.terminalId === native.id && event.kind === 'created',
    )!.snapshot!.logPath;
    const first = (await f.jobs.execution(before.executionId))!;
    f.jobs.backgroundForeground();
    const promoted = await running;
    const inode = (await stat(promoted.job!.outputPath)).ino;
    assert.equal(promoted.execution!.executionId, first.executionId);
    assert.equal(promoted.execution!.pid, before.pid);
    await f.terminals.write('child', native.id, 'continue 中文\r');
    await f.jobs.wait([promoted.job!.id], 5, new AbortController().signal);
    assert.equal(await read(join(f.workspace, 'starts')), 'once\n');
    assert.equal(await read(join(f.workspace, 'input')), 'continue 中文\n');
    const raw = await read(promoted.job!.outputPath);
    assert.ok(
      raw.endsWith(tail),
      'original complete 70KB Unicode tail is retained',
    );
    assert.equal(
      await read(originalPath),
      raw,
      'PTY log and original Job log have identical complete bytes',
    );
    assert.equal((await stat(promoted.job!.outputPath)).ino, inode);
    assert.equal(f.jobs.get(promoted.job!.id)!.status, 'done');
    assert.equal(f.jobs.execution(before.executionId)!.pid, before.pid);
  },
);

test(
  'actual shell exit adopts its still-live grandchild without closing the same PTY or truncating later output',
  { skip: !unix },
  async (t) => {
    const f = await setup(t);
    await writeFile(
      join(f.workspace, 'server.cjs'),
      `const fs=require('fs'),net=require('net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{fs.writeFileSync('port',String(server.address().port));console.log('GRANDCHILD_READY');});process.stdin.once('data',data=>{fs.writeFileSync('late-input',data);fs.writeSync(1,'AFTER_PARENT_EXIT_TAIL');server.close();process.stdin.destroy();});`,
    );
    const command = await f.command(
      `const {spawn}=require('child_process');const child=spawn(process.execPath,['server.cjs'],{stdio:'inherit'});child.unref();console.log('SHELL_DONE');`,
    );
    const result = await f.jobs.execute(
      command,
      {
        sessionId: 'parent',
        origin: { executionSessionId: 'child', toolCallId: 'adopt-pty' },
      },
      new AbortController().signal,
    );
    assert.equal(result.how, 'adopted');
    const native = (await f.terminals.list('child'))[0]!;
    await until(
      async () => !!(await read(join(f.workspace, 'port'))),
      'grandchild actual bound port',
    );
    const port = Number(await read(join(f.workspace, 'port')));
    assert.equal(await portOpen(port), true);
    assert.equal(
      native.status,
      'running',
      'supervisor keeps original PTY open after actual shell exited',
    );
    await f.terminals.write('child', native.id, 'later\r');
    await f.jobs.wait([result.job!.id], 5, new AbortController().signal);
    assert.equal(await read(join(f.workspace, 'late-input')), 'later\n');
    assert.ok(
      (await read(result.job!.outputPath)).endsWith('AFTER_PARENT_EXIT_TAIL'),
    );
    assert.equal(await portOpen(port), false);
    assert.equal(f.jobs.get(result.job!.id)!.status, 'done');
  },
);

test(
  'original managed terminal Stop delegates to the Registry once, blocks replay-as-restart and releases a real descendant port',
  { skip: !unix },
  async (t) => {
    const f = await setup(t);
    const command = await f.command(
      `const fs=require('fs'),net=require('net');process.on('SIGTERM',()=>{});const s=net.createServer();s.listen(0,'127.0.0.1',()=>{fs.writeFileSync('port',String(s.address().port));console.log('READY');});`,
    );
    const running = f.jobs.execute(
      command,
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'stop-pty' },
      },
      new AbortController().signal,
    );
    await until(
      async () =>
        !!(await read(join(f.workspace, 'port'))) &&
        f.snapshots.some((state) => !!state.terminal),
      'actual service port and binding',
    );
    const before = f.jobs.executionFor('one', 'stop-pty')!,
      native = (await f.terminals.list('one'))[0]!;
    const port = Number(await read(join(f.workspace, 'port')));
    assert.equal(await portOpen(port), true);
    await assert.rejects(
      f.terminals.restart('one', native.id),
      /original task/,
    );
    assert.equal(f.stopDelegations(), 0);
    assert.equal(
      await portOpen(port),
      true,
      'forbidden restart neither kills nor reexecutes the original command',
    );
    await f.terminals.close('one', native.id);
    const result = await running;
    assert.equal(result.execution!.executionId, before.executionId);
    assert.equal(result.execution!.status, 'stopped');
    assert.equal(
      await portOpen(port),
      false,
      'stop confirms actual inherited child port release',
    );
    assert.equal(
      f.stopDelegations(),
      1,
      'transport stop cannot recurse through public close',
    );
    assert.equal(
      (await f.terminals.list('one')).length,
      1,
      'no replacement terminal was spawned',
    );
  },
);

test(
  'forced stop observes real exec-root exit before killing a resistant grandchild group and preserves the complete original tail',
  { skip: !unix },
  async (t) => {
    const f = await setup(t),
      tail = 'FORCE_TAIL_' + '中🙂'.repeat(10000) + '_END';
    await writeFile(
      join(f.workspace, 'resistant-child.cjs'),
      "const fs=require('fs'),net=require('net');process.on('SIGTERM',()=>{});const s=net.createServer();s.listen(0,'127.0.0.1',()=>{fs.writeFileSync('grandchild-pid',String(process.pid));fs.writeFileSync('port',String(s.address().port));console.log('GRANDCHILD_READY');});",
    );
    const command =
      'exec ' +
      (await f.command(
        "const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync('root-pid',String(process.pid));fs.writeSync(1," +
          JSON.stringify(tail) +
          ");require('child_process').spawn(process.execPath,['resistant-child.cjs'],{stdio:'inherit'});setInterval(()=>{},1000);",
      ));
    const running = f.jobs.execute(
      command,
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'forced-root' },
      },
      new AbortController().signal,
    );
    void running.catch(() => {});
    await until(
      async () =>
        !!(await read(join(f.workspace, 'port'))) &&
        !!f.jobs.executionFor('one', 'forced-root')?.terminal,
      'root and resistant grandchild actual start',
    );
    const before = f.jobs.executionFor('one', 'forced-root')!,
      native = (await f.terminals.list('one'))[0]!,
      port = Number(await read(join(f.workspace, 'port')));
    assert.equal(
      before.pid,
      Number(await read(join(f.workspace, 'root-pid'))),
      'Registry PID identifies the actual exec root, not the PTY wrapper',
    );
    assert.notEqual(
      before.pid,
      Number(await read(join(f.workspace, 'grandchild-pid'))),
    );
    assert.equal(await portOpen(port), true);
    const stopped = await Promise.all([
      f.terminals.close('one', native.id),
      f.jobs.stopExecution('one', before.executionId),
    ]);
    const result = await running,
      scope = result.execution!.completion!;
    assert.equal(
      scope.rootExit!.signal,
      9,
      'real direct-child wait status is retained',
    );
    assert.equal(
      scope.rootExit!.controlledGroupAtExit,
      'active',
      'the surviving grandchild was still in the original group when the root exited',
    );
    assert.ok(scope.controlledGroupEmpty);
    assert.ok(scope.transportAndLogClosed);
    assert.equal(result.execution!.status, 'stopped');
    assert.equal(await portOpen(port), false);
    const after = (await f.terminals.list('one'))[0]!;
    assert.equal(
      after.signal,
      9,
      'wrapper group is killed only after actual root status is observed',
    );
    assert.equal(after.managedCommand!.completion.rootExit!.signal, 9);
    assert.equal(after.managedCommand!.commandPid, before.pid);
    assert.ok((await read(after.logPath)).includes(tail));
    const original = f.snapshots.find(
      (state) => state.executionId === before.executionId,
    )!.outputPath;
    const path = join(f.jobs.folder, original.split('/').at(-1)!);
    assert.equal(
      await read(path),
      await read(after.logPath),
      'both original logs retain the entire forced-stop tail',
    );
    assert.equal(f.stopDelegations(), 1);
    assert.equal(stopped[1]!.executionId, before.executionId);
    assert.equal((await f.terminals.list('one')).length, 1);
  },
);

test(
  'natural root exit racing repeated stop never replaces its real zero exit with a wrapper signal',
  { skip: !unix },
  async (t) => {
    const f = await setup(t);
    await writeFile(
      join(f.workspace, 'remaining.cjs'),
      "const fs=require('fs'),net=require('net');process.on('SIGTERM',()=>{});const s=net.createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync('port',String(s.address().port)));",
    );
    const result = await f.jobs.execute(
      await f.command(
        "require('child_process').spawn(process.execPath,['remaining.cjs'],{stdio:'inherit'}).unref();",
      ),
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'natural-stop-race' },
      },
      new AbortController().signal,
    );
    assert.equal(result.how, 'adopted');
    await until(
      async () => !!(await read(join(f.workspace, 'port'))),
      'remaining real service after natural root exit',
    );
    const before = f.jobs.executionFor('one', 'natural-stop-race')!,
      native = (await f.terminals.list('one'))[0]!,
      port = Number(await read(join(f.workspace, 'port')));
    assert.equal(before.completion!.rootExit!.exitCode, 0);
    assert.equal(before.completion!.rootExit!.signal, undefined);
    await Promise.all([
      f.terminals.close('one', native.id),
      f.jobs.stopExecution('one', before.executionId),
      f.jobs.stopExecution('one', before.executionId),
    ]);
    const after = f.jobs.execution(before.executionId)!;
    assert.deepEqual(after.completion!.rootExit, before.completion!.rootExit);
    assert.ok(after.completion!.controlledGroupEmpty);
    assert.ok(after.completion!.transportAndLogClosed);
    assert.equal(await portOpen(port), false);
    assert.equal((await f.terminals.list('one'))[0]!.signal, 9);
  },
);

async function supervisorFixture(
  t: TestContext,
  name: string,
  transform: (source: string) => string,
) {
  const source = await readFile(supervisorPath, 'utf8'),
    changed = transform(source);
  assert.notEqual(
    changed,
    source,
    'fixture must change the exact intended control delivery',
  );
  const root = await mkdtemp(join(tmpdir(), 'circle-scope-' + name + '-')),
    path = join(root, 'supervisor.mjs');
  await writeFile(path, changed);
  t.after(() => rm(root, { recursive: true, force: true }));
  return path;
}

test(
  'delayed actual root-exit delivery waits for host acknowledgement without fabricating early closure',
  { skip: !unix },
  async (t) => {
    const delayed = await supervisorFixture(t, 'delay', (source) =>
      source.replace(
        "send({ kind: 'root-exit', ...shellExit, controlledGroupAtExit });",
        "setTimeout(() => send({ kind: 'root-exit', ...shellExit, controlledGroupAtExit }), 350);",
      ),
    );
    const f = await setup(t, false, { supervisorPath: delayed });
    let returned = false;
    const running = f.jobs
      .execute(
        await f.command("console.log('DELAY_READY');"),
        {
          sessionId: 'one',
          origin: { executionSessionId: 'one', toolCallId: 'delayed-exit' },
        },
        new AbortController().signal,
      )
      .then((result) => {
        returned = true;
        return result;
      });
    void running.catch(() => {});
    await until(
      () => f.events.some((event) => event.data?.includes('DELAY_READY')),
      'actual producer output before delayed control packet',
    );
    assert.equal(returned, false);
    assert.equal(
      f.jobs.executionFor('one', 'delayed-exit')!.completion!.rootExit,
      undefined,
    );
    const result = await running;
    assert.equal(result.exit_code, 0);
    assert.ok(result.execution!.completion!.rootExit);
    assert.ok(result.execution!.completion!.controlledGroupEmpty);
    assert.ok(result.execution!.completion!.transportAndLogClosed);
    assert.equal(result.execution!.status, 'done');
  },
);

test(
  'lost root-exit connection remains failed with absent root and group proof while actual output stays available',
  { skip: !unix },
  async (t) => {
    const disconnected = await supervisorFixture(t, 'disconnect', (source) =>
      source.replace(
        "send({ kind: 'root-exit', ...shellExit, controlledGroupAtExit });",
        'socket.destroy();',
      ),
    );
    const f = await setup(t, false, { supervisorPath: disconnected }),
      tail = 'LOST_CONTROL_' + '中🙂'.repeat(5000) + '_END';
    const outcome = await f.jobs
      .execute(
        await f.command(
          "require('fs').writeSync(1," + JSON.stringify(tail) + ');',
        ),
        {
          sessionId: 'one',
          origin: { executionSessionId: 'one', toolCallId: 'lost-exit' },
        },
        new AbortController().signal,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    assert.ok('error' in outcome);
    const state = f.jobs.executionFor('one', 'lost-exit')!,
      native = (await f.terminals.list('one'))[0]!;
    f.unknownCleanup(async () => {
      await until(
        async () => (await f.terminals.list('one'))[0]!.status !== 'running',
        'fixture actual natural wrapper exit after lost connection',
        6000,
      );
    });
    assert.equal(state.status, 'failed');
    assert.equal(state.completion!.rootExit, undefined);
    assert.equal(state.completion!.controlledGroupEmpty, undefined);
    assert.equal(state.completion!.descendantCoverage.state, 'unknown');
    await until(
      async () => (await f.terminals.list('one'))[0]!.status !== 'running',
      'wrapper bounded natural completion without host source proof',
      6000,
    );
    assert.ok((await read(native.logPath)).includes(tail));
    const metadata = JSON.parse(
      await read(join(f.root, 'terminal', native.id, 'metadata.json')),
    );
    assert.equal(metadata.managedCommand.completion.rootExit, undefined);
    assert.equal(
      metadata.managedCommand.completion.controlledGroupEmpty,
      undefined,
    );
  },
);

test(
  'native approved argv and environment stay private while next ScriptedModel request keeps original source and redaction',
  { skip: !unix },
  async (t) => {
    const f = await setup(t),
      secret = 'managed-private-expanded-value';
    saveSecret(f.home, 'MANAGED_SECRET', secret);
    const command =
      (await f.command(
        "require('fs').writeFileSync('received-secret',process.argv[2]);console.log('complete');",
      )) + ' "%MANAGED_SECRET%"';
    const model = new ScriptedModel([
      {
        message: {
          id: 'invoke',
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'native-secret', name: 'execute', args: { command } },
          ],
        },
      },
      { message: { id: 'done', role: 'assistant', content: 'done' } },
    ]);
    let runtime!: AgentRuntime;
    const launcher = createTerminalCommandLauncher({
      terminals: f.terminals,
      runtimeExecutable: process.execPath,
      supervisorPath,
      stopExecution: (owner, id, reason) =>
        runtime.jobs.stopExecution(owner, id, reason),
    });
    const states: CommandExecution[] = [];
    runtime = new AgentRuntime({
      workspace: f.workspace,
      home: f.home,
      settings: defaultSettings(),
      model,
      headless: true,
      commandLauncher: launcher,
      onCommandExecution: (state) => states.push(state),
    });
    t.after(() => runtime.close());
    runtime.policy.setYolo(runtime.session.id, true);
    await runtime.harness.run('run approved private argv');
    assert.equal(await read(join(f.workspace, 'received-secret')), secret);
    assert.equal(JSON.stringify(states).includes(secret), false);
    assert.ok(
      states.some((state) =>
        state.displayCommand?.includes('%MANAGED_SECRET%'),
      ),
    );
    assert.equal(JSON.stringify(model.requests).includes(secret), false);
    const toolMessage = runtime.store
      .messages(runtime.session.id)
      .find((message) => message.tool_call_id === 'native-secret')!;
    const receipt = toolMessage.commandExecutions![0]!;
    assert.equal(receipt.completion.kind, 'pty-group');
    assert.ok(receipt.completion.rootExit);
    assert.ok(receipt.completion.controlledGroupEmpty);
    assert.ok(receipt.completion.transportAndLogClosed);
    assert.equal(receipt.completion.descendantCoverage.state, 'unknown');
    assert.deepEqual(
      model.requests[1]!.messages.find(
        (message) => message.tool_call_id === 'native-secret',
      )!.commandExecutions,
      toolMessage.commandExecutions,
    );
    const native = (await f.terminals.list(runtime.session.id))[0]!;
    assert.equal(JSON.stringify(native).includes(secret), false);
    assert.deepEqual(native.args, []);
    assert.equal(native.command, undefined);
    assert.equal(native.owner, runtime.session.id);
    assert.equal(native.managedCommand!.toolCallId, 'native-secret');
    assert.equal(
      (
        await read(join(f.root, 'terminal', native.id, 'metadata.json'))
      ).includes(secret),
      false,
    );
    assert.equal(
      (
        await read(join(f.root, 'terminal', native.id, 'events.jsonl'))
      ).includes(secret),
      false,
    );
    assert.equal(
      JSON.stringify(runtime.store.messages(runtime.session.id)).includes(
        secret,
      ),
      false,
    );
  },
);

test('managed terminal rejects mixed human and tool origins before any process allocation', async (t) => {
  const f = await setup(t);
  await assert.rejects(
    f.terminals.createManagedCommand({
      owner: 'owner',
      sessionId: 'owner',
      executionId: 'mixed',
      toolCallId: 'provider-call',
      userShellId: 'human-command',
      completion: {
        kind: 'pty-group',
        descendantCoverage: {
          state: 'unknown',
          reason: 'coverage-unavailable',
          observedAt: Date.now(),
        },
      },
      launch: {
        file: process.execPath,
        args: ['-e', "require('fs').writeFileSync('must-not-run','started')"],
      },
      cwd: f.workspace,
      env: {},
      outputPath: join(f.workspace, 'unused.log'),
      signal: new AbortController().signal,
      stop: async () => {},
    }),
    /both tool and human origins/,
  );
  assert.deepEqual(await f.terminals.list('owner'), []);
  assert.equal(f.events.length, 0);
  await assert.rejects(readFile(join(f.workspace, 'must-not-run')), {
    code: 'ENOENT',
  });
});

test(
  'Windows native adapter fails before allocating a PTY without claiming shell exit proves owned tree exit',
  { skip: unix },
  async () => {
    let creates = 0;
    const launcher = createTerminalCommandLauncher({
      terminals: {
        createManagedCommand: async () => {
          creates++;
          throw Error('must not allocate');
        },
      } as unknown as TerminalManager,
      runtimeExecutable: process.execPath,
      supervisorPath,
      stopExecution: async () => {},
    });
    await assert.rejects(
      launcher({
        executionId: 'one',
        origin: { executionSessionId: 'one' },
        notificationOwner: { sessionId: 'one' },
        command: 'echo unavailable',
        cwd: process.cwd(),
        env: {},
        outputPath: 'unused',
        signal: new AbortController().signal,
      }),
      /ownership is unavailable on Windows/,
    );
    assert.equal(creates, 0);
  },
);

test(
  'native cancellation awaits the same real command group and confirms actual port release',
  { skip: !unix },
  async (t) => {
    const f = await setup(t),
      abort = new AbortController();
    const command = await f.command(
      "const fs=require('fs'),net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync('port',String(s.address().port)));setInterval(()=>{},1000);",
    );
    const running = f.jobs.execute(
      command,
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'cancel-native' },
      },
      abort.signal,
    );
    const rejected = assert.rejects(running, /cancel-native/);
    await until(
      async () => !!(await read(join(f.workspace, 'port'))),
      'actual native port before cancellation',
    );
    const before = f.jobs.executionFor('one', 'cancel-native')!;
    const port = Number(await read(join(f.workspace, 'port')));
    assert.equal(await portOpen(port), true);
    abort.abort(Error('cancel-native'));
    await rejected;
    assert.equal(await portOpen(port), false);
    assert.equal(f.jobs.execution(before.executionId)!.status, 'stopped');
    assert.equal(
      f.jobs.execution(before.executionId)!.terminal!.id,
      before.terminal!.id,
    );
    assert.equal((await f.terminals.list('one')).length, 1);
  },
);

test(
  'an unwritable original Job log fails before starting the actual command and retains explicit failure',
  { skip: !unix },
  async (t) => {
    const f = await setup(t, true);
    const command = await f.command(
      "require('fs').writeFileSync('must-not-start','bad');",
    );
    await assert.rejects(
      f.jobs.execute(
        command,
        {
          sessionId: 'one',
          origin: {
            executionSessionId: 'one',
            toolCallId: 'native-broken-log',
          },
        },
        new AbortController().signal,
      ),
      /diagnostic output unavailable/,
    );
    assert.equal(await read(join(f.workspace, 'must-not-start')), '');
    assert.equal(
      f.jobs.executionFor('one', 'native-broken-log')!.status,
      'failed',
    );
    assert.equal(
      f.events.some((event) => event.kind === 'created'),
      false,
      'no PTY process can outlive an unallocated logger',
    );
  },
);

test(
  'an observed outside daemon stays unmanaged and alive while only the original controlled PTY group is stopped',
  { skip: !unix },
  async (t) => {
    const f = await setup(t);
    await writeFile(
      join(f.workspace, 'escaped.cjs'),
      "const fs=require('fs'),net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{fs.writeFileSync('escaped-pid',String(process.pid));fs.writeFileSync('escaped-port',String(s.address().port));});setInterval(()=>{},1000);",
    );
    const command = await f.command(
      "require('child_process').spawn(process.execPath,['escaped.cjs'],{detached:true,stdio:'ignore'}).unref();setInterval(()=>{},1000);",
    );
    const running = f.jobs.execute(
      command,
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'escape-unmanaged' },
      },
      new AbortController().signal,
    );
    const rejected = running.catch((error) => error);
    await until(
      async () =>
        !!(await read(join(f.workspace, 'escaped-port'))) &&
        f.snapshots.some(
          (state) => state.completion?.descendantCoverage.state === 'unmanaged',
        ),
      'observed live outside daemon',
    );
    const native = (await f.terminals.list('one'))[0]!,
      pid = Number(await read(join(f.workspace, 'escaped-pid'))),
      port = Number(await read(join(f.workspace, 'escaped-port')));
    f.beforeCleanup(async () => {
      // The fixture owns this outside process. Product group-stop must leave it alive.
      if (await portOpen(port)) process.kill(pid, 'SIGKILL');
      await until(
        async () => !(await portOpen(port)),
        'fixture-owned outside daemon cleanup',
      );
    });
    const before = f.jobs.executionFor('one', 'escape-unmanaged')!;
    assert.equal(await portOpen(port), true);
    await f.terminals.close('one', native.id);
    const result = await running;
    assert.equal(result.execution!.executionId, before.executionId);
    assert.equal(result.execution!.status, 'stopped');
    assert.equal(
      result.execution!.completion!.descendantCoverage.state,
      'unmanaged',
    );
    assert.ok(result.execution!.completion!.rootExit);
    assert.ok(result.execution!.completion!.controlledGroupEmpty);
    assert.ok(result.execution!.completion!.transportAndLogClosed);
    assert.equal(
      await portOpen(port),
      true,
      'bounded stop cannot kill or claim cleanup of an outside daemon',
    );
    const persisted = JSON.parse(
      await read(join(f.root, 'terminal', native.id, 'metadata.json')),
    );
    assert.equal(persisted.managedCommand.ownership, 'pty-group');
    assert.equal(persisted.managedCommand.commandPid, before.pid);
    assert.equal(
      persisted.managedCommand.completion.descendantCoverage.state,
      'unmanaged',
    );
    assert.ok(persisted.managedCommand.completion.rootExit);
    assert.ok(persisted.managedCommand.completion.controlledGroupEmpty);
    assert.ok(persisted.managedCommand.completion.transportAndLogClosed);
    assert.equal(
      'remainingProcesses' in persisted.managedCommand.completion.rootExit,
      false,
    );
    await f.terminals.dispose();
    const restored = new TerminalManager(
      {
        workspaceRoot: f.workspace,
        logRoot: join(f.root, 'terminal'),
        shellAllowlist: ['/bin/sh'],
      },
      () => {},
    );
    try {
      const reloaded = (await restored.list('one'))[0]!;
      assert.deepEqual(
        reloaded.managedCommand,
        persisted.managedCommand,
        'reopening metadata keeps bounded facts and outside coverage without replay',
      );
      assert.equal(reloaded.id, native.id);
      assert.equal(reloaded.epoch, native.epoch);
      assert.equal(
        await portOpen(port),
        true,
        'restoring terminal history must neither replay nor kill its outside process',
      );
    } finally {
      await restored.dispose();
    }
    void rejected;
  },
);

for (let attempt = 1; attempt <= 3; attempt++)
  test(
    `instant detached daemon attempt ${attempt} preserves bounded facts and live outside port without claiming full tree cleanup`,
    { skip: !unix },
    async (t) => {
      const f = await setup(t);
      await writeFile(
        join(f.workspace, 'instant.cjs'),
        "const fs=require('fs'),net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{fs.writeFileSync('outside-pid',String(process.pid));fs.writeFileSync('outside-port',String(s.address().port));});setInterval(()=>{},1000);",
      );
      let pid = 0,
        port = 0;
      f.beforeCleanup(async () => {
        if (pid && (await portOpen(port))) process.kill(pid, 'SIGKILL');
        if (port)
          await until(
            async () => !(await portOpen(port)),
            'separate fixture instant-daemon cleanup',
          );
      });
      const result = await f.jobs.execute(
        await f.command(
          "require('child_process').spawn(process.execPath,['instant.cjs'],{detached:true,stdio:'ignore'}).unref();",
        ),
        {
          sessionId: 'one',
          origin: { executionSessionId: 'one', toolCallId: 'instant' },
        },
        new AbortController().signal,
      );
      await until(
        async () => !!(await read(join(f.workspace, 'outside-port'))),
        'real instant outside port',
      );
      pid = Number(await read(join(f.workspace, 'outside-pid')));
      port = Number(await read(join(f.workspace, 'outside-port')));
      assert.equal(result.exit_code, 0);
      assert.equal(await portOpen(port), true);
      const scope = result.execution!.completion!;
      assert.equal(scope.kind, 'pty-group');
      assert.equal(scope.rootExit!.exitCode, 0);
      assert.ok(scope.controlledGroupEmpty);
      assert.ok(scope.transportAndLogClosed);
      assert.ok(
        ['unknown', 'unmanaged'].includes(scope.descendantCoverage.state),
      );
      assert.equal('remainingProcesses' in scope.rootExit!, false);
      const native = (await f.terminals.list('one'))[0]!;
      const metadata = JSON.parse(
        await read(join(f.root, 'terminal', native.id, 'metadata.json')),
      );
      assert.equal(
        metadata.managedCommand.executionId,
        result.execution!.executionId,
      );
      assert.equal(metadata.managedCommand.completion.kind, 'pty-group');
      assert.equal(metadata.managedCommand.completion.rootExit.exitCode, 0);
      assert.ok(metadata.managedCommand.completion.controlledGroupEmpty);
      assert.ok(metadata.managedCommand.completion.transportAndLogClosed);
      assert.ok(
        ['unknown', 'unmanaged'].includes(
          metadata.managedCommand.completion.descendantCoverage.state,
        ),
      );
      t.diagnostic(
        JSON.stringify({
          attempt,
          executionId: result.execution!.executionId,
          terminalId: native.id,
          rootExit: scope.rootExit,
          controlledGroupEmpty: scope.controlledGroupEmpty,
          transportAndLogClosed: scope.transportAndLogClosed,
          descendantCoverage: scope.descendantCoverage,
          outsidePid: pid,
          outsidePort: port,
          outsidePortStillLive: true,
          productDidNotCleanOutsideDaemon: true,
        }),
      );
    },
  );

test(
  'startup acknowledgement timeout still stops the actual command through its authenticated supervisor',
  { skip: !unix },
  async (t) => {
    const source = await readFile(supervisorPath, 'utf8');
    const missing = source.replace(
      "send({ kind: 'started', pid: child.pid, group: process.pid })",
      'undefined',
    );
    assert.notEqual(
      missing,
      source,
      'fixture omits only the real supervisor startup acknowledgement',
    );
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'circle-missing-start-')),
      fixture = join(fixtureRoot, 'supervisor.mjs');
    await writeFile(fixture, missing);
    t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
    const f = await setup(t, false, {
      supervisorPath: fixture,
      readyTimeoutMs: 1200,
    });
    const command = await f.command(
      "const fs=require('fs'),net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>fs.writeFileSync('port',String(s.address().port)));setInterval(()=>{},1000);",
    );
    const running = f.jobs
      .execute(
        command,
        {
          sessionId: 'one',
          origin: { executionSessionId: 'one', toolCallId: 'missing-start' },
        },
        new AbortController().signal,
      )
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
    await until(
      async () => !!(await read(join(f.workspace, 'port'))),
      'actual process before missing start timeout',
    );
    const port = Number(await read(join(f.workspace, 'port'))),
      native = (await f.terminals.list('one'))[0]!;
    f.beforeCleanup(async () => {
      if (await portOpen(port)) {
        await signalProcessGroup(native.pid!, 'SIGKILL');
        await until(
          async () => (await f.terminals.list('one'))[0]!.status !== 'running',
          'failed startup fixture actual process exit',
        );
      }
    });
    const outcome = await running;
    assert.ok('error' in outcome);
    assert.equal(
      await portOpen(port),
      false,
      'a lost startup acknowledgement must not prevent authenticated cleanup',
    );
    assert.equal(f.jobs.executionFor('one', 'missing-start')!.status, 'failed');
  },
);

test(
  'an unauthenticated local connection cannot keep normal command settlement waiting forever',
  { skip: !unix },
  async (t) => {
    const f = await setup(t);
    let unauthenticated: Socket | undefined;
    const original = f.terminals.createManagedCommand.bind(f.terminals);
    t.mock.method(
      f.terminals,
      'createManagedCommand',
      async (
        options: Parameters<TerminalManager['createManagedCommand']>[0],
      ) => {
        unauthenticated = createConnection(options.launch.args![1]!);
        await new Promise<void>((resolve, reject) => {
          unauthenticated!.once('connect', resolve);
          unauthenticated!.once('error', reject);
        });
        return original(options);
      },
    );
    const command = await f.command("console.log('actual complete');");
    const running = f.jobs.execute(
      command,
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'untrusted-control' },
      },
      new AbortController().signal,
    );
    let outcome;
    try {
      outcome = await Promise.race([
        running.then((value) => ({ value })),
        delay(1200).then(() => ({ timeout: true })),
      ]);
    } finally {
      unauthenticated?.destroy();
    }
    const result = await running;
    assert.ok(
      'value' in outcome!,
      'control cleanup must not wait for a client which never authenticated',
    );
    assert.equal(result.exit_code, 0);
    assert.match(result.output, /actual complete/);
  },
);

test(
  'private control pipe preserves a large Unicode command across actual socket chunks',
  { skip: !unix },
  async (t) => {
    const f = await setup(t),
      value = '中文🙂'.repeat(9000);
    const command =
      (await f.command(
        "require('fs').writeFileSync('unicode-argv',process.argv[2]);console.log('complete');",
      )) +
      ' ' +
      quote(value);
    const result = await f.jobs.execute(
      command,
      {
        sessionId: 'one',
        origin: {
          executionSessionId: 'one',
          toolCallId: 'unicode-control',
          displayCommand: 'unicode fixture',
        },
      },
      new AbortController().signal,
    );
    assert.equal(result.exit_code, 0);
    assert.equal(
      await read(join(f.workspace, 'unicode-argv')),
      value,
      'no replacement characters may enter the approved actual command',
    );
  },
);

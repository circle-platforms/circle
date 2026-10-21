import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import {
  spawn,
  execFileSync,
  execFile,
  type ChildProcess,
} from 'node:child_process';
import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { JobRegistry } from '../src/jobs.js';
import { Sandbox } from '../src/sandbox.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { saveSecret } from '../src/secrets.js';
import type {
  CommandExecution,
  CommandExit,
  CommandLauncher,
  CommandLaunchRequest,
} from '../src/command_process.js';
import { cleanup, scratch } from './helpers.js';
import { signalProcessGroup } from '../src/process_group.js';

const exec = promisify(execFile);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(check: () => boolean, label: string) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end)
      throw Error('actual transport fixture timed out: ' + label);
    await delay(5);
  }
}
function command(root: string, body: string, name = 'program') {
  const file = join(root, name + '.cjs');
  writeFileSync(file, body);
  return `"${process.execPath}" "${file}"`;
}
function groupAlive(pid: number) {
  if (process.platform === 'win32') return false;
  const rows = execFileSync('/bin/ps', ['-A', '-o', 'pgid=,stat='], {
    encoding: 'utf8',
  });
  return rows.split('\n').some((row) => {
    const [group, state] = row.trim().split(/\s+/);
    return Number(group) === pid && !state?.startsWith('Z');
  });
}

// The newline seals a complete fixture record. File existence (or even a
// positive integer prefix) cannot establish that writeFileSync has finished.
function readFixturePort(path: string): number | undefined {
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, 'utf8');
  if (!/^\d+\n$/.test(text)) return undefined;
  const port = Number(text);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** Real Node pipes exercise the optional contract; this fixture is deliberately not a PTY. */
function pipeLauncher(
  options: {
    beforeReady?: Promise<void>;
    afterSpawn?: Promise<void>;
    flush?: Promise<void>;
    separateOutput?: boolean;
  } = {},
) {
  const launches: {
    request: CommandLaunchRequest;
    child: ChildProcess;
    stops: number;
    lifecycle: { event: string; at: number }[];
    shellClosed: boolean;
    originalSettled: boolean;
  }[] = [];
  const launcher: CommandLauncher = async (request) => {
    await options.beforeReady;
    request.signal.throwIfAborted();
    const producer =
      options.flush || options.separateOutput
        ? request.outputPath + '.producer'
        : request.outputPath;
    const fd = openSync(producer, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(request.command, {
        cwd: request.cwd,
        env: request.env,
        shell: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    const record = {
      request,
      child,
      stops: 0,
      lifecycle: [{ event: 'allocated', at: Date.now() }],
      shellClosed: false,
      originalSettled: false,
    };
    launches.push(record);
    const observed = (event: string) =>
      record.lifecycle.push({ event, at: Date.now() });
    child.once('spawn', () => observed('spawn'));
    const shellExit = deferred<CommandExit>();
    let shellClosed = false;
    child.once('error', (error) => {
      throw error;
    });
    child.once('exit', (code, signal) => {
      observed('exit');
      shellExit.resolve({
        exitCode: code ?? 130,
        ...(signal ? { signal: 15 } : {}),
        remainingProcesses: !!child.pid && groupAlive(child.pid),
      });
    });
    child.once('close', () => {
      shellClosed = true;
      record.shellClosed = true;
      observed('close');
    });
    const settled = (async () => {
      await shellExit.promise;
      await until(
        () => shellClosed && (!child.pid || !groupAlive(child.pid)),
        'owned tree exit',
      );
      if (options.flush) {
        await options.flush;
        await writeFile(request.outputPath, await readFile(producer));
      }
      record.originalSettled = true;
      observed('original-settled');
    })();
    // Keep the handle private until ready. The Registry must still own cleanup
    // if cancellation occurred while a transport was allocating its resources.
    await options.afterSpawn;
    let stopping: Promise<void> | undefined;
    return {
      pid: child.pid,
      shellExit: shellExit.promise,
      settled,
      stop: () =>
        (stopping ??= (async () => {
          record.stops++;
          observed('stop-requested');
          if (process.platform === 'win32') {
            if (!shellClosed && child.pid)
              await exec('taskkill', ['/PID', String(child.pid), '/T', '/F']);
          } else if (child.pid && groupAlive(child.pid)) {
            await signalProcessGroup(child.pid, 'SIGTERM');
            await delay(30);
            if (groupAlive(child.pid))
              await signalProcessGroup(child.pid, 'SIGKILL');
          }
          await settled;
          observed('stop-resolved');
        })()),
    };
  };
  return { launcher, launches };
}
function registry(
  t: TestContext,
  options: Parameters<typeof pipeLauncher>[0] = {},
  maxRunning = 16,
) {
  const root = scratch(t),
    transport = pipeLauncher(options),
    snapshots: CommandExecution[] = [];
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    () => {},
    maxRunning,
    undefined,
    {
      commandLauncher: transport.launcher,
      onExecution: (state) => snapshots.push(state),
    },
  );
  cleanup(t, () => jobs.close().then(() => {}));
  return { root, jobs, snapshots, ...transport };
}

test('optional real pipe transport keeps one execution, PID and log across foreground promotion and actual stdin', async (t) => {
  const f = registry(t);
  const tail = 'TAIL_' + '中🙂'.repeat(8000) + '_END';
  const script = command(
    f.root,
    `const fs=require('fs');fs.appendFileSync('starts','once\\n');fs.writeFileSync('actual-pid',String(process.pid));console.log('READY');process.stdin.once('data',d=>{fs.writeFileSync('actual-input',d);fs.writeSync(1,${JSON.stringify(tail)});process.stdin.destroy();});`,
  );
  const result = f.jobs.execute(
    script,
    {
      sessionId: 'parent',
      parent: 'task-1',
      startedBy: 'model',
      origin: { executionSessionId: 'child', toolCallId: 'execute-1' },
    },
    new AbortController().signal,
  );
  await until(
    () =>
      f.launches.length === 1 &&
      readFileSync(f.launches[0]!.request.outputPath, 'utf8').includes('READY'),
    'actual ready output',
  );
  const before = f.jobs.executionFor('child', 'execute-1')!;
  assert.equal(before.ownerSessionId, 'parent');
  assert.equal(before.executionSessionId, 'child');
  assert.equal(before.status, 'running');
  assert.equal(f.jobs.executionFor('parent', 'execute-1'), undefined);
  assert.equal(
    before.displayCommand,
    undefined,
    'expanded command is not a public fallback',
  );
  assert.equal(f.jobs.backgroundForeground(), 1);
  const promoted = await result;
  assert.equal(promoted.job!.execution!.executionId, before.executionId);
  assert.equal(promoted.job!.execution!.pid, before.pid);
  assert.equal(promoted.job!.execution!.outputPath, before.outputPath);
  assert.equal(promoted.job!.title, 'command');
  f.launches[0]!.child.stdin!.write('continue 中文\n');
  await f.jobs.wait([promoted.job!.id], 5, new AbortController().signal);
  assert.equal(readFileSync(join(f.root, 'starts'), 'utf8'), 'once\n');
  assert.equal(
    readFileSync(join(f.root, 'actual-input'), 'utf8'),
    'continue 中文\n',
  );
  assert.ok(readFileSync(promoted.job!.outputPath, 'utf8').endsWith(tail));
  assert.equal(f.jobs.get(promoted.job!.id)!.status, 'done');
  assert.equal(f.jobs.takeNotices('child').length, 0);
  assert.equal(f.jobs.takeNotices('parent').length, 1);
  assert.equal(f.jobs.takeNotices('parent').length, 0);
  assert.equal(f.jobs.execution(before.executionId)!.pid, before.pid);
  assert.equal(f.launches.length, 1);
});

test('custom transport final output waits for real log flush even after the original PID has exited', async (t) => {
  const flush = deferred<void>();
  const f = registry(t, { flush: flush.promise });
  const tail = 'FLUSH_' + 'x'.repeat(65536) + '_END';
  let returned = false;
  const result = f.jobs
    .execute(
      command(f.root, `require('fs').writeSync(1,${JSON.stringify(tail)});`),
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'flush' },
      },
      new AbortController().signal,
    )
    .then((value) => {
      returned = true;
      return value;
    });
  await until(() => f.launches.length === 1, 'spawn');
  await until(
    () => f.launches[0]!.child.exitCode !== null,
    'native process exit',
  );
  await delay(160); // Cross an actual Registry monitor tick while the log is incomplete.
  assert.equal(returned, false);
  assert.equal(f.jobs.executionFor('one', 'flush')!.status, 'running');
  assert.equal(readFileSync(f.launches[0]!.request.outputPath, 'utf8'), '');
  flush.resolve();
  const completed = await result;
  assert.equal(completed.output, tail);
  assert.equal(completed.exit_code, 0);
  assert.equal(completed.execution!.status, 'done');
});

test('pending ready reserves capacity and cancel-before-ready cannot launch a late process', async (t) => {
  const ready = deferred<void>();
  const f = registry(t, { beforeReady: ready.promise }, 1);
  const signal = new AbortController();
  const pending = f.jobs.execute(
    command(f.root, "require('fs').writeFileSync('forbidden','bad');"),
    {
      sessionId: 'one',
      origin: { executionSessionId: 'child', toolCallId: 'pending' },
    },
    signal.signal,
  );
  await assert.rejects(
    f.jobs.startShell('echo forbidden', { sessionId: 'two' }),
    /already running/,
  );
  assert.equal(f.launches.length, 0);
  signal.abort(new Error('cancel-before-ready'));
  ready.resolve();
  await assert.rejects(pending, /cancel-before-ready/);
  assert.equal(f.launches.length, 0);
  assert.equal(existsSync(join(f.root, 'forbidden')), false);
  assert.equal(f.jobs.executionFor('child', 'pending')!.status, 'stopped');
});

test('cancellation after allocation waits for the late owned handle and stops it once', async (t) => {
  const ready = deferred<void>();
  const f = registry(t, { afterSpawn: ready.promise });
  const signal = new AbortController();
  let returned = false;
  const pending = f.jobs
    .execute(
      command(f.root, "console.log('READY');setInterval(()=>{},1000);"),
      { sessionId: 'one' },
      signal.signal,
    )
    .catch((error) => {
      returned = true;
      throw error;
    });
  await until(() => f.launches.length === 1, 'allocated process');
  signal.abort(new Error('cancel-after-spawn'));
  await delay(30);
  assert.equal(
    returned,
    false,
    'no success/exit before the owned process handle is known',
  );
  ready.resolve();
  await assert.rejects(pending, /cancel-after-spawn/);
  assert.equal(f.launches[0]!.stops, 1);
  assert.notEqual(
    f.launches[0]!.child.exitCode ?? f.launches[0]!.child.signalCode,
    null,
  );
});

test('approved Runtime transports use the actual tool identity and keep expanded secrets out of public execution snapshots and model requests', async (t) => {
  const root = scratch(t),
    transport = pipeLauncher(),
    snapshots: CommandExecution[] = [];
  const secret = 'private-expanded-launch-value';
  saveSecret(root, 'EXEC_SECRET', secret);
  const run =
    command(
      root,
      "require('fs').writeFileSync('actual-secret',process.argv[2]);console.log(process.argv[2]);",
    ) + ' "%EXEC_SECRET%"';
  const model = new ScriptedModel([
    {
      message: {
        id: 'call',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'execute-secret', name: 'execute', args: { command: run } },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'received' } },
  ]);
  const approvals: string[] = [];
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    commandLauncher: transport.launcher,
    onCommandExecution: (state) => snapshots.push(state),
    approve: async (call) => {
      approvals.push(String(call.args.command));
      return 'approve';
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('run the owned command');
  assert.equal(transport.launches.length, 1);
  assert.equal(
    transport.launches[0]!.request.origin.executionSessionId,
    runtime.session.id,
  );
  assert.equal(
    transport.launches[0]!.request.origin.toolCallId,
    'execute-secret',
  );
  assert.deepEqual(transport.launches[0]!.request.origin.secretNames, [
    'EXEC_SECRET',
  ]);
  assert.ok(
    transport.launches[0]!.request.command.includes(secret),
    'real launcher receives the actual approved expansion privately',
  );
  assert.equal(readFileSync(join(root, 'actual-secret'), 'utf8'), secret);
  assert.equal(JSON.stringify(snapshots).includes(secret), false);
  assert.ok(
    snapshots.some((state) => state.displayCommand?.includes('%EXEC_SECRET%')),
  );
  assert.equal(JSON.stringify(model.requests).includes(secret), false);
  assert.equal(JSON.stringify(approvals).includes(secret), false);
  assert.equal(
    model.requests[1]!.messages.find(
      (m) => m.tool_call_id === 'execute-secret',
    )!.content.includes('%EXEC_SECRET%'),
    true,
  );
});

test('a real fixture listener is not ready from an empty or partially written port record', async (t) => {
  const root = scratch(t),
    path = join(root, 'port');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `const fs=require('node:fs'),net=require('node:net');
const server=net.createServer();let fd,port;
server.listen(0,'127.0.0.1',()=>{port=server.address().port;fd=fs.openSync('port','w');process.send({stage:'empty',pid:process.pid,port});});
process.on('message',stage=>{if(stage==='prefix'){fs.writeSync(fd,String(port).slice(0,1));process.send({stage});}else if(stage==='complete'){fs.writeSync(fd,String(port).slice(1)+'\\n');fs.closeSync(fd);process.send({stage});}});`,
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  const closed = new Promise<void>((resolve) => child.once('close', resolve));
  cleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  const next = () =>
    new Promise<{ stage: string; pid?: number; port?: number }>((resolve) =>
      child.once('message', resolve),
    );
  const listening = await next();
  assert.equal(listening.stage, 'empty');
  assert.equal(listening.pid, child.pid);
  assert.ok(listening.port);
  const actualPort = listening.port;
  assert.equal(existsSync(path), true);
  assert.equal(readFileSync(path, 'utf8'), '');
  assert.equal(Number(readFileSync(path, 'utf8')), 0);
  assert.equal(await portOpen(0), false, 'the old exists-only oracle fails');
  assert.equal(
    await portOpen(actualPort),
    true,
    'the actual child is listening',
  );
  assert.equal(readFixturePort(path), undefined);
  let observed = next();
  child.send('prefix');
  assert.equal((await observed).stage, 'prefix');
  assert.equal(readFileSync(path, 'utf8'), String(actualPort).slice(0, 1));
  assert.equal(readFixturePort(path), undefined);
  observed = next();
  child.send('complete');
  assert.equal((await observed).stage, 'complete');
  assert.equal(readFixturePort(path), actualPort);
  assert.equal(await portOpen(actualPort), true);
  t.diagnostic(
    JSON.stringify({
      kind: 'real listener empty and positive-prefix port-file negative control',
      pid: child.pid,
      actualPort,
      emptyRead: '',
      prefixRead: String(actualPort).slice(0, 1),
      completeRead: readFileSync(path, 'utf8'),
    }),
  );
  child.kill();
  await closed;
  assert.equal(await portOpen(actualPort), false);
});

test(
  'optional transport adoption retains the original process group and stop releases a real grandchild port without killing a foreign process',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = registry(t);
    const grandchild = join(f.root, 'grandchild.cjs');
    writeFileSync(
      grandchild,
      "const net=require('net'),fs=require('fs');const server=net.createServer();server.listen(0,'127.0.0.1',()=>{fs.writeFileSync('listener.json',JSON.stringify({pid:process.pid,port:server.address().port}));fs.writeFileSync('port',String(server.address().port)+'\\n');});setInterval(()=>{},1000);\n",
    );
    const foreign = spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      { detached: true, stdio: 'ignore' },
    );
    const foreignClosed = new Promise<void>((resolve) =>
      foreign.once('close', () => resolve()),
    );
    cleanup(t, async () => {
      foreign.kill();
      await foreignClosed;
    });
    const parent = command(
      f.root,
      `const {spawn}=require('child_process');spawn(process.execPath,[${JSON.stringify(grandchild)}],{stdio:'inherit'}).unref();console.log('PARENT_DONE');`,
      'parent',
    );
    const result = await f.jobs.execute(
      parent,
      {
        sessionId: 'parent',
        origin: { executionSessionId: 'child', toolCallId: 'adopt' },
      },
      new AbortController().signal,
    );
    assert.equal(result.how, 'adopted');
    assert.equal(result.job!.kind, 'adopted');
    const execution = result.execution!;
    assert.equal(result.job!.execution!.executionId, execution.executionId);
    const portPath = join(f.root, 'port'),
      observedPortValues: string[] = [];
    await until(() => {
      if (existsSync(portPath)) {
        const raw = readFileSync(portPath, 'utf8');
        if (observedPortValues.at(-1) !== raw) observedPortValues.push(raw);
      }
      return readFixturePort(portPath) !== undefined;
    }, 'grandchild complete actual listener record');
    const port = readFixturePort(portPath)!;
    const listener = JSON.parse(
      readFileSync(join(f.root, 'listener.json'), 'utf8'),
    ) as { pid: number; port: number };
    assert.equal(listener.port, port);
    assert.ok(Number.isSafeInteger(listener.pid) && listener.pid > 0);
    assert.doesNotThrow(() => process.kill(listener.pid, 0));
    t.diagnostic(
      JSON.stringify({
        kind: 'actual adopted grandchild port readiness',
        listener,
        observedPortValues,
      }),
    );
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    assert.equal(connected, true);
    await Promise.all([
      f.jobs.stop(result.job!.id, 'user'),
      f.jobs.stop(result.job!.id, 'user'),
    ]);
    const open = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    assert.equal(open, false, 'owned grandchild port is actually released');
    assert.doesNotThrow(() => process.kill(foreign.pid!, 0));
    assert.equal(f.launches.length, 1);
    assert.equal(
      f.launches[0]!.stops,
      1,
      'concurrent stop reuses the same physical cleanup',
    );
    assert.equal(f.jobs.execution(execution.executionId)!.pid, execution.pid);
    assert.equal(f.jobs.get(result.job!.id)!.status, 'stopped');
  },
);

test('optional transport foreground timeout stops the actual process and never promotes a replacement', async (t) => {
  const f = registry(t);
  const result = await f.jobs.execute(
    command(f.root, "console.log('started');setInterval(()=>{},1000);"),
    { sessionId: 'one' },
    new AbortController().signal,
    0.05,
  );
  assert.equal(result.job, undefined);
  assert.match(result.output, /Command ended: timeout/);
  assert.equal(result.execution!.status, 'failed');
  assert.equal(result.execution!.reason, 'timeout');
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0]!.stops, 1);
  assert.notEqual(
    f.launches[0]!.child.exitCode ?? f.launches[0]!.child.signalCode,
    null,
  );
});

for (const mode of ['reject', 'plan'] as const)
  test(`original ${mode} enforcement prevents optional transport allocation and actual file writes`, async (t) => {
    const root = scratch(t),
      transport = pipeLauncher();
    const model = new ScriptedModel([
      {
        message: {
          id: 'call',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'blocked-execute',
              name: 'execute',
              args: {
                command: command(
                  root,
                  "require('fs').writeFileSync('forbidden','bad');",
                ),
              },
            },
          ],
        },
      },
      { message: { id: 'done', role: 'assistant', content: 'blocked' } },
    ]);
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      model,
      commandLauncher: transport.launcher,
      approve: async () => 'reject',
    });
    cleanup(t, () => runtime.close());
    if (mode === 'plan') runtime.harness.planMode = true;
    await runtime.harness.run('attempt the command');
    assert.equal(transport.launches.length, 0);
    assert.equal(existsSync(join(root, 'forbidden')), false);
    const result = model.requests[1]!.messages.find(
      (m) => m.tool_call_id === 'blocked-execute',
    )!;
    assert.equal(result.status, 'error');
    assert.match(
      result.content,
      mode === 'plan' ? /read-only|plan mode/ : /rejected/,
    );
  });

test('credential classification remains before transport allocation', async (t) => {
  const root = scratch(t),
    transport = pipeLauncher();
  writeFileSync(join(root, '.env'), 'private');
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data'), ['.env']),
    () => {},
    16,
    undefined,
    { commandLauncher: transport.launcher },
  );
  cleanup(t, () => jobs.close().then(() => {}));
  await assert.rejects(
    jobs.execute(
      'cat .env',
      { sessionId: 'one' },
      new AbortController().signal,
    ),
    /credential|secret|protected|sensitive/i,
  );
  assert.equal(transport.launches.length, 0);
  assert.equal(jobs.list().length, 0);
});

test('transport log failure plus an unconfirmed stop rejects the original call without releasing an active resource', async (t) => {
  const root = scratch(t),
    transport = pipeLauncher(),
    trigger = deferred<void>();
  let actual!: Awaited<ReturnType<CommandLauncher>>;
  const failedLog = (async () => {
    await trigger.promise;
    await readFile(join(root, 'missing', 'log'));
  })();
  void failedLog.catch(() => {});
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    () => {},
    1,
    undefined,
    {
      commandLauncher: async (request) => {
        actual = await transport.launcher(request);
        return {
          ...actual,
          settled: failedLog,
          stop: async () => {
            throw Error('fixture owned stop unconfirmed');
          },
        };
      },
    },
  );
  cleanup(t, async () => {
    await actual.stop('fixture cleanup');
    await assert.rejects(jobs.close(), /fixture owned stop unconfirmed/);
  });
  const running = jobs
    .execute(
      command(root, "console.log('READY');setInterval(()=>{},1000);"),
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'broken-log' },
      },
      new AbortController().signal,
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await until(
    () =>
      transport.launches.length === 1 &&
      readFileSync(transport.launches[0]!.request.outputPath, 'utf8').includes(
        'READY',
      ),
    'actual process before log failure',
  );
  trigger.resolve();
  const outcome = await Promise.race([
    running,
    delay(600).then(() => ({ timeout: true })),
  ]);
  assert.ok(
    'error' in outcome,
    'transport failure must reach the original call, rather than leaving it waiting forever',
  );
  assert.equal(jobs.executionFor('one', 'broken-log')!.status, 'failed');
  assert.doesNotThrow(
    () => process.kill(actual.pid!, 0),
    'fixture verifies failed stop really left the original owned process alive',
  );
  await assert.rejects(
    jobs.startShell('echo another', { sessionId: 'one' }),
    /already running/,
  );
});

test('asynchronous launch snapshots trusted origin and notification ownership before a caller can mutate them', async (t) => {
  const ready = deferred<void>();
  const f = registry(t, { beforeReady: ready.promise });
  const owner = {
    sessionId: 'parent',
    origin: {
      executionSessionId: 'child',
      toolCallId: 'original-call',
      displayCommand: 'safe display',
    },
  };
  const result = f.jobs.execute(
    command(f.root, "console.log('done');"),
    owner,
    new AbortController().signal,
  );
  owner.sessionId = 'forged-parent';
  owner.origin.executionSessionId = 'forged-child';
  owner.origin.displayCommand = 'forged display';
  ready.resolve();
  await result;
  assert.equal(f.launches[0]!.request.notificationOwner.sessionId, 'parent');
  assert.equal(f.launches[0]!.request.origin.executionSessionId, 'child');
  assert.equal(f.launches[0]!.request.origin.displayCommand, 'safe display');
  assert.equal(
    f.jobs.executionFor('child', 'original-call')!.ownerSessionId,
    'parent',
  );
});

test('a genuinely unwritable original log cannot prevent transport failure from stopping its real process', async (t) => {
  const root = scratch(t),
    transport = pipeLauncher({ separateOutput: true }),
    trigger = deferred<void>(),
    stopReasons: string[] = [];
  let actual!: Awaited<ReturnType<CommandLauncher>>;
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    () => {},
    1,
    undefined,
    {
      commandLauncher: async (request) => {
        actual = await transport.launcher(request);
        const settled = (async () => {
          await trigger.promise;
          await writeFile(request.outputPath, 'actual logger write');
        })();
        void settled.catch(() => {});
        return {
          ...actual,
          settled,
          stop: (reason: string) => {
            stopReasons.push(reason);
            return actual.stop(reason);
          },
        };
      },
    },
  );
  cleanup(t, async () => {
    await actual?.stop('fixture cleanup');
    await jobs.close();
  });
  // Hold only execute's synchronous foreground deadline. Restore real timers
  // before the asynchronous launcher runs, so readiness and process cleanup
  // still follow actual OS events. A slow host must not replace the log failure
  // this test is exercising with an unrelated one-second timeout.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const running = jobs
    .execute(
      command(root, "console.log('READY');setInterval(()=>{},1000);"),
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'directory-log' },
      },
      new AbortController().signal,
      1,
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  t.mock.timers.reset();
  await until(
    () =>
      transport.launches.length === 1 &&
      readFileSync(
        transport.launches[0]!.request.outputPath + '.producer',
        'utf8',
      ).includes('READY'),
    'actual ready before original log corruption',
  );
  const path = transport.launches[0]!.request.outputPath;
  const initialProcessIdentity =
    process.platform === 'win32'
      ? undefined
      : execFileSync(
          '/bin/ps',
          [
            '-p',
            String(actual.pid),
            '-o',
            'pid=,ppid=,pgid=,stat=,lstart=,command=',
          ],
          { encoding: 'utf8' },
        );
  await rm(path);
  await mkdir(path);
  trigger.resolve();
  // The real failing write is the only event allowed to stop this command.
  const outcome = await running;
  assert.ok(
    'error' in outcome,
    'the real log write error must reject the call',
  );
  const failures = (error: unknown): unknown[] =>
    error instanceof AggregateError ? error.errors.flatMap(failures) : [error];
  assert.ok(
    failures(outcome.error).some(
      (error) =>
        (error as NodeJS.ErrnoException).path === path &&
        ['EISDIR', 'EPERM', 'EACCES'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        ),
    ),
    `the rejection carries the real write error: ${String(outcome.error)}`,
  );
  assert.equal(
    stopReasons[0],
    'transport error',
    'the transport failure, not the deadline, stops the process',
  );
  assert.equal(
    transport.launches[0]!.stops,
    1,
    'diagnostic append failure must not prevent owned cleanup',
  );
  try {
    // Keep the original immediate OS probe. Diagnostics run only after that
    // exact assertion failed, so observation cannot provide an extra wait.
    assert.throws(() => process.kill(actual.pid!, 0), /ESRCH/);
  } catch (error) {
    const launch = transport.launches[0]!;
    const observation = {
      test: t.name,
      at: Date.now(),
      platform: process.platform,
      architecture: process.arch,
      pid: actual.pid,
      childPid: launch.child.pid,
      nativeExitCode: launch.child.exitCode,
      nativeSignalCode: launch.child.signalCode,
      lifecycle: launch.lifecycle,
      shellClosed: launch.shellClosed,
      originalSettled: launch.originalSettled,
      stops: launch.stops,
      execution: jobs.executionFor('one', 'directory-log')?.status,
      processIdentity: '',
      initialProcessIdentity,
    };
    if (process.platform !== 'win32') {
      try {
        observation.processIdentity = execFileSync(
          '/bin/ps',
          [
            '-p',
            String(actual.pid),
            '-o',
            'pid=,ppid=,pgid=,stat=,lstart=,command=',
          ],
          { encoding: 'utf8' },
        );
      } catch (identityError) {
        observation.processIdentity = String(identityError);
      }
    }
    const evidence = process.env.CIRCLE_NATIVE_TEST_PROGRESS_DIR ?? root;
    try {
      await mkdir(evidence, { recursive: true });
      const path = join(
        evidence,
        `command-unwritable-log-${randomUUID()}.json`,
      );
      await writeFile(path, JSON.stringify(observation, null, 2));
      t.diagnostic(JSON.stringify({ evidence: path, ...observation }));
    } catch (persistenceError) {
      t.diagnostic(
        JSON.stringify({
          persistenceError: String(persistenceError),
          ...observation,
        }),
      );
    }
    throw error;
  }
  assert.equal(jobs.executionFor('one', 'directory-log')!.status, 'failed');
});

test('a startup error still finishes its entry when its diagnostic log is a directory', async (t) => {
  const root = scratch(t),
    trigger = deferred<void>();
  let outputPath = '';
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    () => {},
    1,
    undefined,
    {
      commandLauncher: async (request) => {
        outputPath = request.outputPath;
        await trigger.promise;
        throw Error('actual startup failure');
      },
    },
  );
  cleanup(t, () => jobs.close().then(() => {}));
  const running = jobs
    .execute(
      'not spawned',
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'startup-log' },
      },
      new AbortController().signal,
      1,
    )
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await until(() => !!outputPath, 'launcher entry allocated');
  await rm(outputPath);
  await mkdir(outputPath);
  trigger.resolve();
  const outcome = await Promise.race([
    running,
    delay(600).then(() => ({ timeout: true })),
  ]);
  assert.ok(
    'error' in outcome,
    'startup diagnostic failure must not leave the original call waiting',
  );
  assert.equal(jobs.executionFor('one', 'startup-log')!.status, 'failed');
});

test('an actual ScriptedModel background launch cancelled before ready cannot spawn after cancellation', async (t) => {
  const root = scratch(t),
    ready = deferred<void>(),
    transport = pipeLauncher({ beforeReady: ready.promise });
  let requested = false;
  const model = new ScriptedModel([
    {
      message: {
        id: 'background-call',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'pending-background',
            name: 'execute',
            args: {
              command: command(
                root,
                "require('fs').writeFileSync('late-spawn','bad');",
              ),
              background: true,
            },
          },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    commandLauncher: async (request) => {
      requested = true;
      return transport.launcher(request);
    },
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  const running = runtime.harness.run('start a background command');
  const interrupted = assert.rejects(running, /Interrupted/);
  await until(() => requested, 'background startup held before actual spawn');
  const cancelled = runtime.cancel();
  ready.resolve();
  await cancelled;
  await interrupted;
  assert.equal(
    transport.launches.length,
    0,
    'cancelled pending launch must not create a late process',
  );
  assert.equal(existsSync(join(root, 'late-spawn')), false);
  const state = runtime.jobs.executionFor(
    runtime.session.id,
    'pending-background',
  )!;
  assert.equal(state.status, 'stopped');
  assert.equal(state.reason, 'cancelled');
});

test('only the actual execution session can stop the same foreground process, without promoting it', async (t) => {
  const f = registry(t);
  const running = f.jobs.execute(
    command(f.root, "console.log('READY');setInterval(()=>{},1000);"),
    {
      sessionId: 'parent',
      origin: { executionSessionId: 'child', toolCallId: 'foreground-handoff' },
    },
    new AbortController().signal,
  );
  await until(
    () =>
      f.launches.length === 1 &&
      readFileSync(f.launches[0]!.request.outputPath, 'utf8').includes('READY'),
    'actual foreground before handoff stop',
  );
  const before = f.jobs.executionFor('child', 'foreground-handoff')!;
  await assert.rejects(
    f.jobs.stopExecution('parent', before.executionId),
    /no command execution in this session/,
  );
  assert.doesNotThrow(() => process.kill(before.pid!, 0));
  const [first, second] = await Promise.all([
    f.jobs.stopExecution('child', before.executionId),
    f.jobs.stopExecution('child', before.executionId),
  ]);
  const result = await running;
  assert.equal(first.status, 'stopped');
  assert.equal(first.pid, before.pid);
  assert.equal(first.executionId, second.executionId);
  assert.equal(result.execution!.executionId, before.executionId);
  assert.equal(result.job, undefined);
  assert.equal(
    f.jobs.list().length,
    0,
    'handoff stop must not manufacture a background job',
  );
  assert.equal(f.launches[0]!.stops, 1);
  assert.throws(() => process.kill(before.pid!, 0), /ESRCH/);
  assert.equal(
    (await f.jobs.stopExecution('child', before.executionId)).status,
    'stopped',
  );
  assert.equal(f.launches[0]!.stops, 1);
});

test('an accepted background transport keeps its original lifetime after the initiating call is cancelled', async (t) => {
  const f = registry(t),
    signal = new AbortController();
  const job = await f.jobs.startShell(
    command(f.root, "console.log('READY');setInterval(()=>{},1000);"),
    { sessionId: 'one' },
    undefined,
    signal.signal,
  );
  signal.abort();
  assert.equal(f.jobs.get(job.id)!.status, 'running');
  assert.doesNotThrow(() => process.kill(job.execution!.pid!, 0));
  assert.equal(f.launches[0]!.stops, 0);
  await f.jobs.stop(job.id, 'user');
  assert.equal(f.launches[0]!.stops, 1);
});

test('a real timeout stop failure reaches the original command and never claims the still-running process exited', async (t) => {
  const root = scratch(t),
    transport = pipeLauncher();
  let actual!: Awaited<ReturnType<CommandLauncher>>;
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    () => {},
    1,
    undefined,
    {
      commandLauncher: async (request) => {
        actual = await transport.launcher(request);
        return {
          ...actual,
          stop: async () => {
            throw Error('fixture timeout stop unconfirmed');
          },
        };
      },
    },
  );
  cleanup(t, async () => {
    await actual.stop('fixture cleanup');
    await delay(5);
    await jobs.close();
  });
  await assert.rejects(
    jobs.execute(
      command(root, "console.log('READY');setInterval(()=>{},1000);"),
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'timeout-failure' },
      },
      new AbortController().signal,
      0.1,
    ),
    /command transport failed; cleanup failed/,
  );
  assert.doesNotThrow(() => process.kill(actual.pid!, 0));
  assert.equal(jobs.executionFor('one', 'timeout-failure')!.status, 'failed');
  assert.equal(
    jobs.executionFor('one', 'timeout-failure')!.reason,
    'transport cleanup failed',
  );
  await assert.rejects(
    jobs.startShell('echo another', { sessionId: 'one' }),
    /already running/,
  );
});

test('a real scripted child tool keeps its execution session separate from the original parent notification owner', async (t) => {
  const root = scratch(t),
    transport = pipeLauncher(),
    snapshots: CommandExecution[] = [];
  const script = command(
    root,
    "require('fs').writeFileSync('child-effect','one');console.log('child output');",
  );
  const model = new ScriptedModel([
    {
      message: {
        id: 'parent-start',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'child-task',
            name: 'task',
            args: {
              subagent_type: 'general-purpose',
              description: 'run the child command',
            },
          },
        ],
      },
    },
    {
      message: {
        id: 'child-start',
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'actual-child-execute',
            name: 'execute',
            args: { command: script },
          },
        ],
      },
    },
    {
      message: {
        id: 'child-end',
        role: 'assistant',
        content: 'child complete',
      },
    },
    {
      message: {
        id: 'parent-end',
        role: 'assistant',
        content: 'parent complete',
      },
    },
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    commandLauncher: transport.launcher,
    onCommandExecution: (state) => snapshots.push(state),
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  const result = await runtime.harness.run('delegate one command');
  assert.equal(result.answer, 'parent complete');
  assert.equal(transport.launches.length, 1);
  const request = transport.launches[0]!.request;
  assert.equal(request.notificationOwner.sessionId, runtime.session.id);
  assert.notEqual(request.origin.executionSessionId, runtime.session.id);
  assert.equal(request.origin.toolCallId, 'actual-child-execute');
  const child = runtime.store.get(request.origin.executionSessionId)!;
  assert.equal(child.parent_id, runtime.session.id);
  assert.equal(
    runtime.jobs.executionFor(
      request.origin.executionSessionId,
      'actual-child-execute',
    )!.ownerSessionId,
    runtime.session.id,
  );
  assert.equal(
    runtime.jobs.executionFor(runtime.session.id, 'actual-child-execute'),
    undefined,
  );
  assert.equal(readFileSync(join(root, 'child-effect'), 'utf8'), 'one');
  assert.ok(
    snapshots.some(
      (state) =>
        state.status === 'done' && state.executionSessionId === child.id,
    ),
  );
});

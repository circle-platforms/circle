import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  mkdirSync,
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { JobRegistry } from '../src/jobs.js';
import { Sandbox } from '../src/sandbox.js';
import { AgentRuntime } from '../src/runtime.js';
import { Harness } from '../src/harness.js';
import { ApprovalPolicy, ApprovalStore } from '../src/approvals.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { ScriptedModel } from '../src/testing.js';
import { GatewayModel } from '../src/model.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import type { Message } from '../src/types.js';
import { saveSecret } from '../src/secrets.js';
import {
  commandExecutionReceipt,
  type CommandExecution,
  type CommandLauncher,
  type CommandDescendantCoverage,
  type CommandPtyGroupProcessHandle,
} from '../src/command_process.js';
import { scratch, cleanup } from './helpers.js';
import { signalProcessGroup } from '../src/process_group.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function until(check: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > end)
      throw Error('bounded command fixture timed out: ' + label);
    await delay(5);
  }
}
function command(root: string, body: string, name = 'program') {
  const path = join(root, name + '.cjs');
  writeFileSync(path, body);
  return `"${process.execPath}" "${path}"`;
}
function groupAlive(group: number) {
  return execFileSync('/bin/ps', ['-A', '-o', 'pgid=,stat='], {
    encoding: 'utf8',
  })
    .split('\n')
    .some((line) => {
      const [pid, state] = line.trim().split(/\s+/);
      return Number(pid) === group && !state?.startsWith('Z');
    });
}
async function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    let finished = false;
    const end = (open: boolean) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => end(true));
    socket.once('error', () => end(false));
    socket.setTimeout(200, () => end(false));
  });
}

/** Exercise both SDK serializers over actual HTTP, rather than a ScriptedModel snapshot. */
async function providerScopePayloads(t: TestContext, messages: Message[]) {
  const payloads: {
    path: string;
    body: { messages: { role: string; content: unknown }[] };
  }[] = [];
  const server = createServer(async (request, response) => {
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const path = request.url!;
    payloads.push({
      path,
      body: JSON.parse(Buffer.concat(parts).toString('utf8')),
    });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (path.startsWith('/openai/')) {
      response.write(
        'data: ' +
          JSON.stringify({
            choices: [
              { index: 0, delta: { content: 'done' }, finish_reason: 'stop' },
            ],
          }) +
          '\n\n',
      );
      response.end('data: [DONE]\n\n');
    } else {
      const event = (type: string, fields: object) =>
        response.write(
          'event: ' +
            type +
            '\ndata: ' +
            JSON.stringify({ type, ...fields }) +
            '\n\n',
        );
      event('message_start', {
        message: {
          id: 'scope',
          type: 'message',
          role: 'assistant',
          model: 'gateway',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      });
      event('content_block_start', {
        index: 0,
        content_block: { type: 'text', text: '' },
      });
      event('content_block_delta', {
        index: 0,
        delta: { type: 'text_delta', text: 'done' },
      });
      event('content_block_stop', { index: 0 });
      event('message_delta', {
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      });
      event('message_stop', {});
      response.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup(t, () => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const home = scratch(t),
    base = `http://127.0.0.1:${address.port}`;
  saveCredentials({ api_key: 'local-test-key' }, home);
  for (const protocol of ['openai', 'anthropic'] as const) {
    const settings = defaultSettings();
    settings.auth = {
      ...settings.auth,
      protocol,
      model: 'gateway',
      base_url: base + (protocol === 'openai' ? '/openai/v1' : '/anthropic'),
    };
    const result = await new GatewayModel(settings, home).complete({
      system: 'system',
      messages,
      tools: [],
      signal: new AbortController().signal,
      token: () => {},
    });
    assert.equal(result.message.content, 'done');
  }
  return payloads;
}

/** Actual Node pipes test the core protocol; this fixture does not claim native PTY validation. */
function transport(
  options: {
    ioGate?: Promise<void>;
    groupGate?: Promise<void>;
    stopFailure?: boolean;
  } = {},
) {
  const launches: {
    child: ChildProcess;
    outputPath: string;
    actualStop: () => Promise<void>;
  }[] = [];
  let coverage: CommandDescendantCoverage = { state: 'unknown' };
  const listeners = new Set<() => void>(),
    pastListeners: (() => void)[] = [];
  const launcher: CommandLauncher = async (request) => {
    request.signal.throwIfAborted();
    const producer = request.outputPath + '.producer',
      fd = openSync(producer, 'a', 0o600);
    let child: ChildProcess;
    try {
      child = spawn(request.command, {
        cwd: request.cwd,
        env: request.env,
        shell: true,
        detached: true,
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    const exit = deferred<{
      exitCode: number;
      signal?: number;
      controlledGroupAtExit: 'active' | 'empty' | 'unknown';
    }>();
    const closed = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    child.once('exit', (code, signal) =>
      exit.resolve({
        exitCode: code ?? 130,
        ...(signal ? { signal: 15 } : {}),
        controlledGroupAtExit:
          child.pid && groupAlive(child.pid) ? 'active' : 'empty',
      }),
    );
    const actualEmpty = (async () => {
      await exit.promise;
      await until(
        () => !child.pid || !groupAlive(child.pid),
        'actual controlled group empty',
      );
    })();
    const controlledGroupEmpty = (async () => {
      await actualEmpty;
      await options.groupGate;
    })();
    const transportAndLogClosed = (async () => {
      await closed;
      await actualEmpty;
      await options.ioGate;
      await writeFile(request.outputPath, await readFile(producer));
    })();
    let stop: Promise<void> | undefined;
    const actualStop = () =>
      (stop ??= (async () => {
        if (child.pid && groupAlive(child.pid)) {
          await signalProcessGroup(child.pid, 'SIGTERM');
          await delay(25);
          if (groupAlive(child.pid))
            await signalProcessGroup(child.pid, 'SIGKILL');
        }
        await closed;
        await actualEmpty;
      })());
    launches.push({ child, outputPath: request.outputPath, actualStop });
    const handle: CommandPtyGroupProcessHandle = {
      kind: 'pty-group',
      pid: child.pid,
      rootExit: exit.promise,
      controlledGroupEmpty,
      transportAndLogClosed,
      descendantCoverage: {
        snapshot: () => ({ ...coverage }),
        subscribe: (listener) => {
          listeners.add(listener);
          pastListeners.push(listener);
          return () => listeners.delete(listener);
        },
      },
      stop: async () => {
        if (options.stopFailure)
          throw Error('actual controlled stop unconfirmed');
        await actualStop();
      },
    };
    return handle;
  };
  return {
    launcher,
    launches,
    change: (next: CommandDescendantCoverage) => {
      coverage = next;
      for (const listener of listeners) listener();
    },
    lateChange: (next: CommandDescendantCoverage) => {
      coverage = next;
      for (const listener of pastListeners) listener();
    },
  };
}

test(
  'human command identity follows its actual execution and shared receipt while quiet background work stays out of history',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t),
      host = transport(),
      model = new ScriptedModel([
        { message: { id: 'seen-shared', role: 'assistant', content: 'seen' } },
        { message: { id: 'after-quiet', role: 'assistant', content: 'done' } },
      ]);
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      model,
      commandLauncher: host.launcher,
    });
    cleanup(t, () => runtime.close());
    const shared = await runtime.userShells.run(
      command(root, "console.log('shared human exact 中文');", 'shared-human'),
    );
    const view = runtime.userShells.views[0]!;
    assert.equal(shared.execution!.pid, host.launches[0]!.child.pid);
    assert.equal(view.execution!.executionId, shared.execution!.executionId);
    assert.equal(view.execution!.userShellId, view.id);
    assert.equal(view.execution!.toolCallId, undefined);
    const stored = runtime.store.messages(runtime.session.id)[0]!;
    assert.equal(stored.shell!.id, view.id);
    assert.equal(stored.shell!.output, 'shared human exact 中文\n');
    assert.equal(stored.commandExecutions![0]!.userShellId, view.id);
    assert.equal(stored.commandExecutions![0]!.toolCallId, undefined);
    assert.ok(!('outputPath' in stored.commandExecutions![0]!));
    await runtime.harness.run('Use my shared command');
    assert.deepEqual(
      model.requests[0]!.messages.find((message) => message.shell)
        ?.commandExecutions,
      stored.commandExecutions,
    );
    const quiet = runtime.userShells.run(
      command(
        root,
        "const fs=require('node:fs');fs.writeFileSync('quiet-human-ready','yes');const timer=setInterval(()=>{if(fs.existsSync('quiet-human-release')){clearInterval(timer);console.log('QUIET_HUMAN_PRIVATE');}},5);",
        'quiet-human',
      ),
      true,
    );
    await until(
      () => existsSync(join(root, 'quiet-human-ready')),
      'quiet human process started',
    );
    const quietView = runtime.userShells.views.at(-1)!;
    const original = structuredClone(quietView.execution!);
    assert.equal(original.userShellId, quietView.id);
    assert.equal(original.pid, host.launches[1]!.child.pid);
    assert.equal(runtime.jobs.backgroundForeground(), 1);
    const background = await quiet;
    assert.equal(background.execution!.executionId, original.executionId);
    assert.equal(background.job!.execution!.userShellId, quietView.id);
    writeFileSync(join(root, 'quiet-human-release'), 'release');
    await until(() => quietView.status === 'done', 'quiet human completion');
    assert.equal(quietView.execution!.executionId, original.executionId);
    assert.equal(quietView.execution!.epoch, original.epoch);
    assert.ok(quietView.output.includes('QUIET_HUMAN_PRIVATE'));
    assert.equal(runtime.jobs.hasNotices(runtime.session.id), false);
    await runtime.harness.run('After quiet work');
    assert.ok(!JSON.stringify(model.requests).includes('QUIET_HUMAN_PRIVATE'));
    assert.ok(
      !JSON.stringify(runtime.store.messages(runtime.session.id)).includes(
        quietView.id,
      ),
    );
    const before = structuredClone(view.execution!);
    runtime.userShells.executionChanged({
      ...before,
      executionSessionId: 'foreign-session',
      status: 'failed',
    });
    runtime.userShells.executionChanged({
      ...before,
      epoch: 'stale-registry',
      status: 'failed',
    });
    assert.deepEqual(view.execution, before);
    const sessionId = runtime.session.id;
    await runtime.close();
    const launches = host.launches.length;
    const reopened = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      sessionId,
      model: new ScriptedModel(),
      commandLauncher: host.launcher,
    });
    cleanup(t, () => reopened.close());
    assert.equal(
      host.launches.length,
      launches,
      'history reopening never launches a command',
    );
    assert.deepEqual(
      reopened.store.messages(sessionId)[0]!.commandExecutions,
      stored.commandExecutions,
    );
    assert.equal(reopened.store.messages(sessionId)[0]!.shell!.id, view.id);
  },
);

function fixture(
  t: TestContext,
  options: Parameters<typeof transport>[0] = {},
  observerThrows = false,
  maxRunning = 16,
) {
  const root = scratch(t),
    host = transport(options),
    snapshots: CommandExecution[] = [];
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    () => {},
    maxRunning,
    undefined,
    {
      commandLauncher: host.launcher,
      onExecution: (state) => {
        snapshots.push(state);
        if (observerThrows) throw Error('view is gone');
      },
    },
  );
  cleanup(t, async () => {
    await Promise.all(host.launches.map((launch) => launch.actualStop()));
    await jobs.close();
  });
  return { root, host, jobs, snapshots };
}

test(
  'explicit PTY group records independent root, group and I/O facts without promoting unknown coverage to a tree claim',
  { skip: process.platform === 'win32' },
  async (t) => {
    const gate = deferred<void>(),
      f = fixture(t, { ioGate: gate.promise }, true),
      tail = 'TAIL_' + '中🙂'.repeat(8000) + '_END';
    let returned = false;
    const running = f.jobs
      .execute(
        command(f.root, `require('fs').writeSync(1,${JSON.stringify(tail)});`),
        {
          sessionId: 'one',
          origin: { executionSessionId: 'one', toolCallId: 'four-facts' },
        },
        new AbortController().signal,
      )
      .then((value) => {
        returned = true;
        return value;
      });
    await until(
      () =>
        !!f.jobs.executionFor('one', 'four-facts')?.completion
          ?.controlledGroupEmpty,
      'actual root exit and actual group empty',
    );
    const before = f.jobs.executionFor('one', 'four-facts')!;
    assert.equal(before.completion!.rootExit!.exitCode, 0);
    assert.equal(before.completion!.rootExit!.controlledGroupAtExit, 'empty');
    assert.equal(before.completion!.transportAndLogClosed, undefined);
    assert.equal(before.completion!.descendantCoverage.state, 'unknown');
    assert.equal(readFileSync(f.host.launches[0]!.outputPath, 'utf8'), '');
    await delay(140);
    assert.equal(
      returned,
      false,
      'dead root PID cannot substitute for actual original-log flush',
    );
    gate.resolve();
    const result = await running;
    assert.equal(result.output, tail);
    assert.equal(result.exit_code, 0);
    assert.equal(result.execution!.status, 'done');
    assert.ok(result.execution!.completion!.transportAndLogClosed!.observedAt);
    assert.equal(
      result.execution!.completion!.descendantCoverage.state,
      'unknown',
    );
    assert.equal(
      JSON.stringify(result.execution).includes('remainingProcesses'),
      false,
    );
  },
);

test(
  'PTY stop awaits confirmed controlled group and original I/O closure instead of claiming full descendant cleanup',
  { skip: process.platform === 'win32' },
  async (t) => {
    const io = deferred<void>(),
      group = deferred<void>(),
      f = fixture(t, { ioGate: io.promise, groupGate: group.promise });
    const running = f.jobs.execute(
      command(f.root, "console.log('READY');setInterval(()=>{},1000);"),
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'stop-facts' },
      },
      new AbortController().signal,
    );
    await until(
      () =>
        f.host.launches.length === 1 &&
        readFileSync(
          f.host.launches[0]!.outputPath + '.producer',
          'utf8',
        ).includes('READY'),
      'real running root',
    );
    const id = f.jobs.executionFor('one', 'stop-facts')!.executionId;
    let stopped = false;
    const stopping = f.jobs.stopExecution('one', id).then((value) => {
      stopped = true;
      return value;
    });
    await until(
      () => f.jobs.execution(id)!.completion!.rootExit !== undefined,
      'actual signalled root exit',
    );
    assert.equal(stopped, false);
    group.resolve();
    await until(
      () => !!f.jobs.execution(id)!.completion!.controlledGroupEmpty,
      'group close event',
    );
    assert.equal(stopped, false);
    assert.equal(
      f.jobs.execution(id)!.completion!.transportAndLogClosed,
      undefined,
    );
    io.resolve();
    const state = await stopping;
    await running;
    assert.equal(state.status, 'stopped');
    assert.equal(state.completion!.descendantCoverage.state, 'unknown');
  },
);

test(
  'instant detached descendant can remain alive after bounded command completion and its unknown/unmanaged coverage remains explicit',
  { skip: process.platform === 'win32' },
  async (t) => {
    const io = deferred<void>(),
      f = fixture(t, { ioGate: io.promise });
    writeFileSync(
      join(f.root, 'daemon.cjs'),
      "const fs=require('fs'),net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{fs.writeFileSync('daemon-pid',String(process.pid));fs.writeFileSync('daemon-port',String(s.address().port));});setInterval(()=>{},1000);",
    );
    let pid = 0,
      port = 0;
    cleanup(t, async () => {
      if (pid) {
        process.kill(pid, 'SIGKILL');
        await until(
          async () => !(await portOpen(port)),
          'fixture-owned outside daemon exit',
        );
      }
    });
    const running = f.jobs.execute(
      command(
        f.root,
        "require('child_process').spawn(process.execPath,['daemon.cjs'],{detached:true,stdio:'ignore'}).unref();",
      ),
      {
        sessionId: 'one',
        origin: { executionSessionId: 'one', toolCallId: 'outside' },
      },
      new AbortController().signal,
    );
    await until(
      () => existsSync(join(f.root, 'daemon-port')),
      'actual detached listener',
    );
    pid = Number(readFileSync(join(f.root, 'daemon-pid'), 'utf8'));
    port = Number(readFileSync(join(f.root, 'daemon-port'), 'utf8'));
    assert.equal(await portOpen(port), true);
    f.host.change({ state: 'unmanaged', reason: 'outside-controlled-group' });
    const firstOutside = f.jobs.executionFor('one', 'outside')!.completion!
      .descendantCoverage;
    f.host.change({ state: 'unknown' });
    assert.deepEqual(
      f.jobs.executionFor('one', 'outside')!.completion!.descendantCoverage,
      firstOutside,
      'live downgrade cannot erase an observed unmanaged descendant or its first observation',
    );
    io.resolve();
    const result = await running;
    assert.equal(result.exit_code, 0);
    assert.equal(result.execution!.completion!.kind, 'pty-group');
    assert.ok(result.execution!.completion!.rootExit);
    assert.ok(result.execution!.completion!.controlledGroupEmpty);
    assert.ok(result.execution!.completion!.transportAndLogClosed);
    assert.equal(
      result.execution!.completion!.descendantCoverage.state,
      'unmanaged',
    );
    assert.equal(
      await portOpen(port),
      true,
      'bounded group completion must never be described as killing the outside daemon',
    );
    const saved = structuredClone(result.execution!);
    f.host.lateChange({ state: 'unknown' });
    assert.deepEqual(
      f.jobs.execution(saved.executionId),
      saved,
      'finished epoch cannot accept a stale coverage callback',
    );
  },
);

test(
  'failed bounded stop retains the active resource and unresolved facts',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = fixture(t, { stopFailure: true }, false, 1);
    const running = f.jobs
      .execute(
        command(f.root, "console.log('READY');setInterval(()=>{},1000);"),
        {
          sessionId: 'one',
          origin: { executionSessionId: 'one', toolCallId: 'stop-failed' },
        },
        new AbortController().signal,
      )
      .catch((error) => error);
    await until(
      () =>
        f.host.launches.length === 1 &&
        readFileSync(
          f.host.launches[0]!.outputPath + '.producer',
          'utf8',
        ).includes('READY'),
      'actual process before failed stop',
    );
    const id = f.jobs.executionFor('one', 'stop-failed')!.executionId;
    await assert.rejects(f.jobs.stopExecution('one', id), /stop unconfirmed/);
    await running;
    const state = f.jobs.execution(id)!;
    assert.equal(state.status, 'failed');
    assert.equal(state.completion!.rootExit, undefined);
    assert.equal(state.completion!.controlledGroupEmpty, undefined);
    assert.equal(state.completion!.transportAndLogClosed, undefined);
    assert.doesNotThrow(() => process.kill(f.host.launches[0]!.child.pid!, 0));
    await assert.rejects(
      f.jobs.startShell('echo no capacity', { sessionId: 'one' }),
      /already running/,
    );
    await f.host.launches[0]!.actualStop();
    await until(
      () => !!f.jobs.execution(id)!.completion!.transportAndLogClosed,
      'fixture-owned physical close after refused stop',
    );
    assert.equal(
      f.jobs.execution(id)!.status,
      'failed',
      'later physical group closure cannot rewrite a failed stop as a successful user stop',
    );
  },
);

test(
  'failed real original-log closure cannot release a bounded execution as confirmed closed',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t),
      gate = deferred<void>(),
      host = transport({ ioGate: gate.promise });
    const jobs = new JobRegistry(
      new Sandbox(root, join(root, 'data')),
      () => {},
      1,
      undefined,
      { commandLauncher: host.launcher },
    );
    let logReplaced = false;
    cleanup(t, async () => {
      gate.resolve();
      await Promise.all(host.launches.map((launch) => launch.actualStop()));
      if (logReplaced) await assert.rejects(jobs.close(), /EISDIR/);
      else await jobs.close();
    });
    const running = jobs
      .execute(
        command(root, "console.log('actual producer tail');"),
        {
          sessionId: 'one',
          origin: { executionSessionId: 'one', toolCallId: 'log-closure' },
        },
        new AbortController().signal,
      )
      .catch((error) => error);
    await until(
      () =>
        !!jobs.executionFor('one', 'log-closure')?.completion
          ?.controlledGroupEmpty,
      'actual group exit before rejected log closure',
    );
    const launch = host.launches[0]!;
    unlinkSync(launch.outputPath);
    mkdirSync(launch.outputPath);
    logReplaced = true;
    gate.resolve();
    const failure = await running;
    assert.match(String(failure), /command transport failed/);
    assert.ok(failure instanceof AggregateError);
    assert.ok(
      failure.errors
        .flatMap((error) =>
          error instanceof AggregateError ? error.errors : [error],
        )
        .some((error) => String(error).includes('EISDIR')),
      'the actual original-log filesystem failure must remain available',
    );
    await until(
      () =>
        jobs.executionFor('one', 'log-closure')?.reason ===
        'transport cleanup failed',
      'actual failed log cleanup status',
    );
    const execution = jobs.executionFor('one', 'log-closure')!;
    assert.equal(execution.status, 'failed');
    assert.ok(execution.completion!.rootExit);
    assert.ok(execution.completion!.controlledGroupEmpty);
    assert.equal(execution.completion!.transportAndLogClosed, undefined);
    await assert.rejects(
      jobs.startShell('echo capacity must remain reserved', {
        sessionId: 'one',
      }),
      /already running/,
    );
    assert.equal(
      host.launches.length,
      1,
      'a failed closure cannot silently admit a replacement command',
    );
  },
);

test(
  'bounded receipts reach both actual provider HTTP payloads and stored history without private metadata or replay on restart',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = scratch(t),
      host = transport(),
      secret = 'bounded-private-value';
    saveSecret(root, 'PTY_SECRET', secret);
    const script =
      command(
        root,
        "const fs=require('fs');fs.appendFileSync('starts','one');fs.writeFileSync('private-argv',process.argv[2]);console.log('complete');",
      ) + ' "%PTY_SECRET%"';
    const model = new ScriptedModel([
      {
        message: {
          id: 'call',
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'history-facts', name: 'execute', args: { command: script } },
          ],
        },
      },
      { message: { id: 'end', role: 'assistant', content: 'done' } },
    ]);
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      model,
      headless: true,
      commandLauncher: host.launcher,
    });
    cleanup(t, () => runtime.close());
    runtime.policy.setYolo(runtime.session.id, true);
    const legacy = {
      id: 'legacy',
      role: 'user' as const,
      content: 'old history without execution metadata',
    };
    runtime.store.append(runtime.session.id, [legacy]);
    await runtime.harness.run('execute a bounded command');
    const message = runtime.store
      .messages(runtime.session.id)
      .find((item) => item.tool_call_id === 'history-facts')!;
    const receipt = message.commandExecutions![0]!;
    assert.equal(receipt.executionSessionId, runtime.session.id);
    assert.equal(receipt.toolCallId, 'history-facts');
    assert.equal(receipt.completion.kind, 'pty-group');
    assert.equal(receipt.completion.descendantCoverage.state, 'unknown');
    assert.ok(receipt.completion.rootExit);
    assert.ok(receipt.completion.transportAndLogClosed);
    assert.ok(receipt.completion.controlledGroupEmpty);
    assert.deepEqual(
      model.requests[1]!.messages.find(
        (item) => item.tool_call_id === 'history-facts',
      )!.commandExecutions,
      message.commandExecutions,
    );
    const originalContent = message.content;
    const payloads = await providerScopePayloads(
      t,
      model.requests[1]!.messages,
    );
    assert.deepEqual(
      payloads.map((payload) => payload.path),
      ['/openai/v1/chat/completions', '/anthropic/v1/messages'],
    );
    for (const payload of payloads) {
      const content = payload.path.startsWith('/openai/')
        ? payload.body.messages.find((item) => item.role === 'tool')!.content
        : payload.body.messages
            .flatMap((item) =>
              Array.isArray(item.content) ? item.content : [],
            )
            .find((item: { type: string }) => item.type === 'tool_result')
            .content;
      assert.equal(typeof content, 'string');
      const match = (content as string).match(
        /<circle-command-execution-scope>\n(.+)\n<\/circle-command-execution-scope>/,
      );
      assert.ok(
        match,
        'the actual provider request must carry the host scope facts',
      );
      assert.deepEqual(
        JSON.parse(match[1]!),
        JSON.parse(JSON.stringify(message.commandExecutions)),
      );
      assert.equal((content as string).includes(secret), false);
    }
    assert.equal(
      message.content,
      originalContent,
      'provider metadata cannot alter the stored/default tool text',
    );
    assert.equal(
      message.content.includes('<circle-command-execution-scope>'),
      false,
    );
    for (const field of [
      'outputPath',
      'displayCommand',
      'reason',
      'command',
      'cwd',
      'env',
    ])
      assert.equal(field in receipt, false);
    assert.equal(JSON.stringify(receipt).includes(secret), false);
    assert.equal(readFileSync(join(root, 'private-argv'), 'utf8'), secret);
    const id = runtime.session.id;
    await runtime.close();
    let relaunched = 0;
    const restored = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      session: id,
      model: new ScriptedModel(),
      headless: true,
      commandLauncher: async () => {
        relaunched++;
        throw Error('must not replay');
      },
    });
    cleanup(t, () => restored.close());
    assert.deepEqual(
      restored.store
        .messages(id)
        .find((item) => item.tool_call_id === 'history-facts')!
        .commandExecutions,
      message.commandExecutions,
    );
    assert.equal(
      restored.store.messages(id).find((item) => item.id === 'legacy')!
        .commandExecutions,
      undefined,
    );
    assert.equal(relaunched, 0);
    assert.equal(readFileSync(join(root, 'starts'), 'utf8'), 'one');
  },
);

test(
  'bounded background notice carries group scope to the actual owner and both provider HTTP payloads',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = fixture(t);
    const job = await f.jobs.startShell(
      command(f.root, "console.log('background finished');"),
      {
        sessionId: 'parent',
        origin: { executionSessionId: 'child', toolCallId: 'background-call' },
      },
    );
    await until(
      () => f.jobs.get(job.id)?.status === 'done',
      'actual background completion',
    );
    assert.deepEqual(f.jobs.takeNotices('child'), []);
    const notices = f.jobs.takeNotices('parent');
    assert.equal(notices.length, 1);
    const receipt = notices[0]!.commandExecutions![0]!;
    assert.equal(receipt.ownerSessionId, 'parent');
    assert.equal(receipt.executionSessionId, 'child');
    assert.equal(receipt.toolCallId, 'background-call');
    assert.equal(receipt.completion.descendantCoverage.state, 'unknown');
    assert.ok(receipt.completion.rootExit);
    assert.ok(receipt.completion.controlledGroupEmpty);
    assert.ok(receipt.completion.transportAndLogClosed);
    const payloads = await providerScopePayloads(t, notices);
    for (const payload of payloads) {
      const user = payload.body.messages.find((item) => item.role === 'user')!;
      const content =
        typeof user.content === 'string'
          ? user.content
          : (user.content as { type: string; text: string }[])
              .filter((item) => item.type === 'text')
              .map((item) => item.text)
              .join('\n');
      const match = content.match(
        /<circle-command-execution-scope>\n(.+)\n<\/circle-command-execution-scope>/,
      );
      assert.ok(match);
      assert.deepEqual(
        JSON.parse(match[1]!),
        JSON.parse(JSON.stringify([receipt])),
      );
    }
    assert.equal(
      notices[0]!.content.includes('<circle-command-execution-scope>'),
      false,
    );
    assert.deepEqual(f.jobs.takeNotices('parent'), []);
  },
);

test('safe receipt projection excludes extra fields at every source depth', () => {
  const base = {
    executionId: 'e',
    epoch: 'epoch',
    ownerSessionId: 'owner',
    executionSessionId: 'actual',
    toolCallId: 'call',
    status: 'done',
    started: 1,
    outputPath: '/protected',
    displayCommand: 'private',
    reason: 'private',
    env: 'private',
    terminal: { id: 'terminal', epoch: 't', secret: 'private' },
    completion: {
      kind: 'pty-group',
      rootExit: {
        exitCode: 0,
        controlledGroupAtExit: 'empty',
        observedAt: 2,
        private: 'secret',
      },
      transportAndLogClosed: { observedAt: 3, private: 'secret' },
      controlledGroupEmpty: { observedAt: 3, private: 'secret' },
      descendantCoverage: {
        state: 'unknown',
        observedAt: 1,
        private: 'secret',
      },
      private: 'secret',
    },
  } as unknown as CommandExecution;
  const receipt = commandExecutionReceipt(base)!;
  assert.equal(JSON.stringify(receipt).includes('private'), false);
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
  assert.equal(
    commandExecutionReceipt({
      ...base,
      completion: { ...base.completion!, kind: 'owned-tree' },
    } as unknown as CommandExecution),
    undefined,
  );
});

for (const mismatch of ['session', 'call', 'epoch', 'previous'] as const)
  test(
    'history does not bind ' + mismatch + ' execution metadata to another call',
    async (t) => {
      const root = scratch(t),
        store = new CheckpointStore(root),
        session = store.create(root, 'scripted');
      cleanup(t, () => store.close());
      const model = new ScriptedModel([
        {
          message: {
            id: 'call',
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'actual', name: 'read', args: {} }],
          },
        },
        { message: { id: 'done', role: 'assistant', content: 'done' } },
      ]);
      let ran = false;
      const execution = {
        executionId: 'old',
        epoch: mismatch === 'epoch' ? 'other' : 'epoch',
        ownerSessionId: session.id,
        executionSessionId: mismatch === 'session' ? 'other' : session.id,
        toolCallId: mismatch === 'call' ? 'other' : 'actual',
        status: 'done',
        started: 1,
        outputPath: '/private',
        completion: {
          kind: 'pty-group',
          descendantCoverage: { state: 'unknown', observedAt: 1 },
        },
      } as CommandExecution;
      const harness = new Harness({
        model,
        store,
        session,
        system: 'test',
        headless: true,
        policy: new ApprovalPolicy(
          new ApprovalStore(join(root, 'approvals')),
          root,
        ),
        tools: [
          {
            name: 'read',
            description: 'fixture',
            parameters: { type: 'object', properties: {} },
            effect: 'read',
            run: async () => {
              ran = true;
              return 'actual result';
            },
          },
        ],
        commandExecution: {
          epoch: 'epoch',
          forCall: () =>
            ran || mismatch === 'previous' ? execution : undefined,
        },
      });
      await harness.run('read');
      const message = store
        .messages(session.id)
        .find((item) => item.tool_call_id === 'actual')!;
      assert.equal(message.content, 'actual result');
      assert.equal(message.commandExecutions, undefined);
    },
  );

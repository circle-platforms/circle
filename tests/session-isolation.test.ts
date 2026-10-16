import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  readdirSync,
  statSync,
  utimesSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentRuntime } from '../src/runtime.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { SessionRuntimeManager } from '../src/session_manager.js';
import { SessionOccupiedError, sessionOccupied } from '../src/session_lock.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
} from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import {
  emptyUsage,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

function gate() {
  let entered!: () => void;
  let finish!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return {
    ready,
    finish,
    reply: async (request: ModelRequest): Promise<ModelResponse> => {
      entered();
      await Promise.race([
        released,
        new Promise<never>((_, reject) => {
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
      ]);
      request.signal.throwIfAborted();
      return {
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: 'done',
        },
        usage: emptyUsage(),
      };
    },
  };
}
function child(script: string, home: string, workspace: string): ChildProcess {
  return spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CIRCLE_HOME: home,
        TEST_HOME: home,
        TEST_WORKSPACE: workspace,
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    },
  );
}
async function message(process: ChildProcess): Promise<any> {
  const result = await Promise.race([
    once(process, 'message'),
    once(process, 'exit').then(([code]) => {
      throw new Error(`child exited ${code} before replying`);
    }),
  ]);
  return result[0];
}
const moduleUrl = (name: string) =>
  JSON.stringify(pathToFileURL(join(process.cwd(), 'src', name + '.ts')).href);

test('session manager runs same-directory sessions concurrently with separate requests and stored histories', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const a = gate(),
    b = gate();
  const modelA = new ScriptedModel([a.reply]),
    modelB = new ScriptedModel([b.reply]);
  const models = [modelA, modelB];
  const manager = new SessionRuntimeManager(
    (workspace, session) =>
      new AgentRuntime({
        workspace,
        home,
        session,
        settings: defaultSettings(),
        model: models.shift(),
        headless: true,
      }),
  );
  cleanup(t, () => manager.close());
  const first = manager.create(workspace);
  const runningA = first.harness.run('only A');
  await a.ready;
  await assert.rejects(first.newSession(), /a turn is running/);
  const second = manager.create(workspace);
  const runningB = second.harness.run('only B');
  await b.ready;
  assert.equal(manager.open(workspace, first.session.id), first);
  assert.equal(first.busy, true);
  assert.equal(second.busy, true);
  assert.deepEqual(
    modelA.requests[0]!.messages.filter((item) => item.role === 'user').map(
      (item) => item.content,
    ),
    ['only A'],
  );
  assert.deepEqual(
    modelB.requests[0]!.messages.filter((item) => item.role === 'user').map(
      (item) => item.content,
    ),
    ['only B'],
  );
  b.finish();
  await runningB;
  assert.equal(first.busy, true);
  a.finish();
  await runningA;
  assert.deepEqual(
    first.store
      .messages(first.session.id)
      .filter((item) => item.role === 'user')
      .map((item) => item.content),
    ['only A'],
  );
  assert.deepEqual(
    second.store
      .messages(second.session.id)
      .filter((item) => item.role === 'user')
      .map((item) => item.content),
    ['only B'],
  );
});

test('deletion blocks new work, cancels only the target and keeps its lease until history is deleted', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const a = gate(),
    b = gate();
  const models = [new ScriptedModel([a.reply]), new ScriptedModel([b.reply])];
  const manager = new SessionRuntimeManager(
    (workspace, session) =>
      new AgentRuntime({
        workspace,
        home,
        session,
        settings: defaultSettings(),
        model: models.shift(),
        headless: true,
      }),
  );
  cleanup(t, () => manager.close());
  const first = manager.create(workspace),
    second = manager.create(workspace);
  const runningA = first.harness.run('A').catch(() => {});
  const runningB = second.harness.run('B');
  await Promise.all([a.ready, b.ready]);
  await assert.rejects(manager.delete(first.session.id), /confirm stopping/);
  const deletion = manager.delete(first.session.id, { confirmed: true });
  assert.equal(manager.lifecycle(first.session.id), 'deleting');
  assert.throws(() => manager.open(workspace, first.session.id), /deleting/);
  assert.equal(sessionOccupied(home, first.session.id), true);
  await deletion;
  await runningA;
  assert.equal(manager.lifecycle(first.session.id), 'deleted');
  assert.equal(sessionOccupied(home, first.session.id), false);
  const reader = new CheckpointStore(home);
  cleanup(t, () => reader.close());
  assert.equal(reader.get(first.session.id), undefined);
  assert.equal(second.busy, true);
  await assert.rejects(first.harness.run('late prompt'), /closing/);
  await assert.rejects(first.userShells.run('echo late'), /Busy/);
  await assert.rejects(first.compact(), /closing/);
  await assert.rejects(first.initialize(), /closing/);
  await assert.rejects(first.reloadIntegrations(), /closing/);
  b.finish();
  await runningB;
  assert.equal(reader.messages(second.session.id).at(-1)?.content, 'done');
});

test('failed deletion preserves history and ownership and can retry cleanup', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const manager = new SessionRuntimeManager(
    (workspace, session) =>
      new AgentRuntime({
        workspace,
        home,
        session,
        settings: defaultSettings(),
        model: new ScriptedModel(),
        headless: true,
      }),
  );
  cleanup(t, () => manager.close());
  const runtime = manager.create(workspace),
    id = runtime.session.id;
  const original = runtime.jobs.close.bind(runtime.jobs);
  runtime.jobs.close = async () => {
    throw new Error('cleanup failed');
  };
  await assert.rejects(manager.delete(id), /cleanup failed/);
  assert.ok(runtime.store.get(id));
  assert.equal(sessionOccupied(home, id), true);
  assert.equal(manager.lifecycle(id), 'deleting');
  runtime.jobs.close = original;
  await manager.delete(id);
  assert.equal(manager.lifecycle(id), 'deleted');
  assert.equal(sessionOccupied(home, id), false);
});

test('external deletion cleanup runs before history removal and lease release, and failure is retryable', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  let fail = true;
  let runtime!: AgentRuntime;
  const manager = new SessionRuntimeManager(
    (workspace, session) =>
      new AgentRuntime({
        workspace,
        home,
        session,
        settings: defaultSettings(),
        model: new ScriptedModel(),
        headless: true,
        beforeDelete: async () => {
          assert.ok(runtime.store.get(runtime.session.id));
          assert.equal(sessionOccupied(home, runtime.session.id), true);
          assert.equal(runtime.busy, false);
          if (fail) throw new Error('external browser cleanup failed');
        },
      }),
  );
  cleanup(t, () => manager.close());
  runtime = manager.create(workspace);
  const id = runtime.session.id;
  await assert.rejects(manager.delete(id), /external browser cleanup failed/);
  assert.ok(runtime.store.get(id));
  assert.equal(sessionOccupied(home, id), true);
  fail = false;
  await manager.delete(id);
  assert.equal(manager.lifecycle(id), 'deleted');
  assert.equal(sessionOccupied(home, id), false);
});

test('shutdown cannot race a deletion into reporting deleted while history remains', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const manager = new SessionRuntimeManager(
    (workspace, session) =>
      new AgentRuntime({
        workspace,
        home,
        session,
        settings: defaultSettings(),
        model: new ScriptedModel(),
        headless: true,
      }),
  );
  const runtime = manager.create(workspace),
    id = runtime.session.id;
  const closing = manager.close();
  await assert.rejects(manager.delete(id), /manager is closing/);
  await assert.rejects(runtime.deleteSession(), /already closing/);
  await closing;
  const reader = new CheckpointStore(home);
  cleanup(t, () => reader.close());
  assert.ok(reader.get(id));
});

test('deleting a session removes only its own and its descendants approval records', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const manager = new SessionRuntimeManager(
    (workspace, session) =>
      new AgentRuntime({
        workspace,
        home,
        session,
        settings: defaultSettings(),
        model: new ScriptedModel(),
        headless: true,
      }),
  );
  cleanup(t, () => manager.close());
  const first = manager.create(workspace),
    second = manager.create(workspace);
  const childSession = first.store.create(
    workspace,
    'scripted',
    'child',
    undefined,
    first.session.id,
  );
  for (const id of [first.session.id, childSession.id, second.session.id])
    first.policy.store.record(id, 'always', 'execute', 'echo *', 'test');
  await manager.delete(first.session.id);
  assert.deepEqual(second.policy.store.rules(first.session.id), []);
  assert.deepEqual(second.policy.store.log(first.session.id), []);
  assert.deepEqual(second.policy.store.rules(childSession.id), []);
  assert.equal(second.policy.store.rules(second.session.id).length, 1);
});

for (const leaseOwner of ['root', 'child'] as const) {
  test(`a compromised ${leaseOwner} heartbeat stops owned processes and extensions without affecting other sessions or readable history`, async (t) => {
    const home = scratch(t),
      workspace = scratch(t),
      pending = gate();
    const model = new ScriptedModel([pending.reply]);
    const runtime = new AgentRuntime({
      workspace,
      home,
      settings: defaultSettings(),
      model,
      headless: true,
    });
    cleanup(t, () => runtime.close());
    const leaseId =
      leaseOwner === 'root'
        ? runtime.session.id
        : runtime.store.create(
            workspace,
            'scripted',
            '',
            undefined,
            runtime.session.id,
          ).id;
    const otherPending = gate();
    const other = new AgentRuntime({
      workspace,
      home,
      settings: defaultSettings(),
      model: new ScriptedModel([otherPending.reply]),
      headless: true,
    });
    cleanup(t, () => other.close());
    const otherRunning = other.harness.run('other session stays in flight');
    await otherPending.ready;
    const script = join(workspace, 'background.cjs');
    writeFileSync(
      script,
      `const fs = require('node:fs');
    fs.writeFileSync('background.pid', String(process.pid));
    setInterval(() => { if (fs.existsSync('trigger')) fs.writeFileSync('forbidden', 'late write'); }, 10);`,
    );
    const job = runtime.jobs.startShell(
      `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      { sessionId: runtime.session.id, startedBy: 'model' },
    );
    const readyDeadline = Date.now() + 5000;
    while (!existsSync(join(workspace, 'background.pid'))) {
      assert.ok(Date.now() < readyDeadline, 'background process started');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const pid = Number(readFileSync(join(workspace, 'background.pid'), 'utf8'));
    let extensionsAborted = false;
    const originalExtensionClose = runtime.extensions.close.bind(
      runtime.extensions,
    );
    runtime.extensions.close = async (...args) => {
      extensionsAborted = true;
      await originalExtensionClose(...args);
    };
    const lost = new Promise<void>((resolve) =>
      runtime.bus.subscribe((event) => {
        if (event.payload.session_ownership_lost) resolve();
      }),
    );
    const running = runtime.harness
      .run('blocked until cancellation')
      .catch(() => {});
    await pending.ready;
    const lock = join(
      home,
      'session-locks',
      createHash('sha256').update(leaseId).digest('hex') + '.lock',
    );
    rmSync(lock, { recursive: true });
    await Promise.race([
      lost,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('ownership compromise was not detected')),
          10000,
        );
        timer.unref();
      }),
    ]);
    await running;
    const stoppedDeadline = Date.now() + 5000;
    while (
      runtime.jobs.get(job.id)?.status === 'running' ||
      !extensionsAborted
    ) {
      assert.ok(Date.now() < stoppedDeadline, 'ownership cleanup finished');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.throws(() => process.kill(pid, 0));
    writeFileSync(join(workspace, 'trigger'), '');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(existsSync(join(workspace, 'forbidden')), false);
    assert.equal(other.busy, true);
    assert.ok(runtime.store.get(runtime.session.id));
    assert.ok(runtime.store.messages(runtime.session.id).length > 0);
    assert.throws(
      () =>
        runtime.jobs.startShell('echo late', { sessionId: runtime.session.id }),
      /closed/,
    );
    await assert.rejects(runtime.harness.run('must not send another request'));
    await assert.rejects(runtime.compact());
    await assert.rejects(runtime.initialize());
    await assert.rejects(runtime.reloadIntegrations());
    await assert.rejects(runtime.userShells.run('echo must-not-run'), /Busy/);
    assert.equal(model.requests.length, 1);
    otherPending.finish();
    await otherRunning;
  });
}

test('deletion holds the parent lease while collecting and deleting descendants', (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const store = new CheckpointStore(home),
    other = new CheckpointStore(home);
  cleanup(t, () => store.close());
  cleanup(t, () => other.close());
  const parent = store.create(workspace, 'scripted');
  const childSession = store.create(
    workspace,
    'scripted',
    '',
    undefined,
    parent.id,
  );
  store.delete(parent.id, (ids) => {
    assert.deepEqual(new Set(ids), new Set([parent.id, childSession.id]));
    assert.throws(
      () => other.create(workspace, 'scripted', '', 'late-child', parent.id),
      SessionOccupiedError,
    );
  });
  assert.equal(other.get(parent.id), undefined);
  assert.equal(other.get(childSession.id), undefined);
  assert.equal(other.get('late-child'), undefined);
});

test('resuming a session deleted after discovery fails before constructing runtime resources and releases ownership', (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const store = new CheckpointStore(home),
    session = store.create(workspace, 'scripted');
  cleanup(t, () => store.close());
  const original = CheckpointStore.prototype.claimSession;
  CheckpointStore.prototype.claimSession = function (id, compromised) {
    if (id === session.id) store.delete(id);
    original.call(this, id, compromised);
  };
  try {
    assert.throws(
      () =>
        new AgentRuntime({
          workspace,
          home,
          session: session.id,
          settings: defaultSettings(),
          model: new ScriptedModel(),
          headless: true,
        }),
      /unknown session/,
    );
  } finally {
    CheckpointStore.prototype.claimSession = original;
  }
  assert.equal(sessionOccupied(home, session.id), false);
});

test('a live child process owns its session; other sessions and history readers remain independent', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const worker = child(
    `
    import { AgentRuntime } from ${moduleUrl('runtime')};
    import { defaultSettings } from ${moduleUrl('settings')};
    import { ScriptedModel } from ${moduleUrl('testing')};
    const runtime = new AgentRuntime({ workspace:process.env.TEST_WORKSPACE, home:process.env.TEST_HOME, settings:defaultSettings(), model:new ScriptedModel(), headless:true });
    process.send({ id:runtime.session.id });
    process.on('message', async () => { await runtime.close(); process.send({ closed:true }); process.disconnect(); });
  `,
    home,
    workspace,
  );
  cleanup(t, async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const exited = once(worker, 'exit');
      worker.kill('SIGKILL');
      await exited;
    }
  });
  const { id } = await message(worker);
  const reader = new CheckpointStore(home);
  cleanup(t, () => reader.close());
  assert.ok(reader.get(id));
  assert.throws(
    () =>
      new AgentRuntime({
        workspace,
        home,
        session: id,
        settings: defaultSettings(),
        model: new ScriptedModel(),
        headless: true,
      }),
    SessionOccupiedError,
  );
  assert.throws(
    () =>
      reader.append(id, [
        { id: 'foreign', role: 'user', content: 'wrong writer' },
      ]),
    SessionOccupiedError,
  );
  assert.throws(() => reader.select(id, null), SessionOccupiedError);
  assert.throws(() => reader.delete(id), SessionOccupiedError);
  assert.throws(
    () => reader.create(workspace, 'scripted', '', id),
    SessionOccupiedError,
  );
  assert.throws(
    () => reader.create(workspace, 'scripted', '', 'foreign-child', id),
    SessionOccupiedError,
  );
  const independent = new AgentRuntime({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([
      { message: { id: 'ok', role: 'assistant', content: 'independent' } },
    ]),
    headless: true,
  });
  await independent.harness.run('other terminal');
  await independent.close();
  assert.equal(sessionOccupied(home, id), true);
  const closed = message(worker);
  worker.send('close');
  assert.deepEqual(await closed, { closed: true });
  const resumed = new AgentRuntime({
    workspace,
    home,
    session: id,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
  });
  await resumed.close();
});

test('a killed owner can be recovered after the heartbeat lease becomes stale', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const worker = child(
    `
    import { acquireSessionLease } from ${moduleUrl('session_lock')};
    acquireSessionLease(process.env.TEST_HOME, 'crashed');
    process.send({ ready:true });
    setInterval(() => {}, 1000);
  `,
    home,
    workspace,
  );
  cleanup(t, () => {
    worker.kill('SIGKILL');
  });
  await message(worker);
  const lock = join(
    home,
    'session-locks',
    readdirSync(join(home, 'session-locks'))[0]!,
  );
  const initial = statSync(lock).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 5600));
  assert.ok(
    statSync(lock).mtimeMs > initial,
    'the live owner refreshes its heartbeat',
  );
  const exited = once(worker, 'exit');
  worker.kill('SIGKILL');
  await exited;
  assert.equal(sessionOccupied(home, 'crashed'), true);
  // Advance only this synthetic dead owner's lease age; no live lease is forced away.
  const stale = new Date(Date.now() - 60000);
  utimesSync(lock, stale, stale);
  assert.equal(sessionOccupied(home, 'crashed'), false);
  const { acquireSessionLease } = await import('../src/session_lock.js');
  const lease = acquireSessionLease(home, 'crashed');
  lease.assertActive();
  lease.release();
});

test('settings changes from real concurrent processes retain every read-modify-write update', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  saveSettings(defaultSettings(), home);
  const workers = ['A', 'B'].map((name) =>
    child(
      `
    import { saveSettingsChange } from ${moduleUrl('settings')};
    process.send({ ready:true });
    process.on('message', () => {
      for (let i=0; i<15; i++) saveSettingsChange(process.env.TEST_HOME, saved => {
        saved.variables[${JSON.stringify(name)}] = String(Number(saved.variables[${JSON.stringify(name)}] || 0) + 1);
        saved.counter = Number(saved.counter || 0) + 1;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2);
      });
      process.send({ done:true }); process.disconnect();
    });
  `,
      home,
      workspace,
    ),
  );
  cleanup(t, () => {
    for (const worker of workers) worker.kill('SIGKILL');
  });
  await Promise.all(workers.map(message));
  const completed = workers.map(message);
  for (const worker of workers) worker.send('start');
  await Promise.all(completed);
  const saved = loadSettings(home);
  assert.equal(saved.counter, 30);
  assert.deepEqual(saved.variables, { A: '15', B: '15' });
});

test('an occupied session opens view-only and a turn names how to fork it', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const owner = new AgentRuntime({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([
      { message: { id: 'ok', role: 'assistant', content: 'stored reply' } },
    ]),
    headless: true,
  });
  cleanup(t, () => owner.close());
  await owner.harness.run('hello from the owner');
  const viewer = new AgentRuntime({
    workspace,
    home,
    session: owner.session.id,
    settings: defaultSettings(),
    model: new ScriptedModel(),
    headless: true,
    inspect: true,
  });
  cleanup(t, () => viewer.close());
  assert.equal(viewer.viewOnly, true);
  assert.match(
    viewer.harness.messages.map((message) => message.content).join('\n'),
    /hello from the owner/,
  );
  assert.match(
    viewer.harness.messages.map((message) => message.content).join('\n'),
    /stored reply/,
  );
  await assert.rejects(
    () => viewer.harness.run('continue here'),
    /circle --fork/,
  );
  assert.equal(sessionOccupied(home, owner.session.id), true);
  await viewer.close();
  assert.equal(sessionOccupied(home, owner.session.id), true);
});

test('leaving an idle session releases it for another terminal', async (t) => {
  const home = scratch(t),
    workspace = scratch(t);
  const owner = new AgentRuntime({
    workspace,
    home,
    settings: defaultSettings(),
    model: new ScriptedModel([
      { message: { id: 'ok', role: 'assistant', content: 'stored reply' } },
    ]),
    headless: true,
  });
  cleanup(t, () => owner.close());
  await owner.harness.run('hello from the owner');
  assert.equal(sessionOccupied(home, owner.session.id), true);
  owner.yieldLease();
  assert.equal(sessionOccupied(home, owner.session.id), false);
  const next = new AgentRuntime({
    workspace,
    home,
    session: owner.session.id,
    settings: defaultSettings(),
    model: new ScriptedModel([
      { message: { id: 'next', role: 'assistant', content: 'taken over' } },
    ]),
    headless: true,
  });
  cleanup(t, () => next.close());
  assert.equal(next.viewOnly, false);
  await next.harness.run('continue here');
  assert.equal(owner.resumeLease(), false);
  assert.equal(owner.viewOnly, true);
  await next.close();
  assert.equal(owner.resumeLease(), true);
  assert.equal(owner.viewOnly, false);
});

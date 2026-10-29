import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  BrowserFixture,
  BrowserFixtureDeadline,
  type BrowserFixtureRecord,
} from './browser-fixture.js';
import { createServer as createHttp } from 'node:http';
import { cleanup, cleanupServer, scratch } from './helpers.js';
import { listenForBrowser } from './browser-port.mjs';

const childProgram = `
process.on('message', () => {});
process.on('disconnect', () => process.exit(0));
process.send('ready');
`;
const exited = (child: ChildProcess) =>
  child.exitCode !== null || child.signalCode !== null;

async function stopOwnedChild(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const stopped = once(child, 'exit');
  child.kill('SIGKILL');
  await stopped;
}

async function ownedChild(t: TestContext): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', childProgram], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  cleanup(t, () => stopOwnedChild(child));
  await once(child, 'message');
  return child;
}

function fixture(
  close: () => Promise<void>,
  roots: () => Iterable<ChildProcess> = () => [],
) {
  const records: BrowserFixtureRecord[] = [];
  return {
    value: new BrowserFixture({
      budgetMs: 10_000,
      state: () => ({}),
      close,
      ownedRoots: roots,
      report: (record) => records.push(record),
    }),
    records,
  };
}

// A page's own server says whether the browser's request came at all: a phase that times
// out records it, so its failure tells the runner, the fixture and the page's load apart.
test('a phase deadline records what the loopback servers saw of the browser', async (t) => {
  const site = createHttp(() => {});
  cleanupServer(t, site);
  const port = await listenForBrowser(site);
  const { value, records } = fixture(async () => {});
  await assert.rejects(
    value.run(
      { phase: 'home', action: 'navigate' },
      () => new Promise(() => {}),
      50,
    ),
    (error) => {
      assert(error instanceof BrowserFixtureDeadline);
      const page = error.fixturePhase.loopback?.find(
        (server) => server.port === port,
      );
      // No connection: the request never reached the page's server
      assert.deepEqual(page?.events, []);
      return true;
    },
  );
  // Only the failure's records carry it
  assert.deepEqual(
    Object.fromEntries(
      records.map((record) => [record.status, record.loopback !== undefined]),
    ),
    {
      before: false,
      timeout: true,
      'cleanup-before': false,
      'cleanup-after': false,
      error: true,
    },
  );
});

test('a failed browser fixture close disposes each owned real root and still rejects the original error', async (t) => {
  const first = await ownedChild(t);
  const second = await ownedChild(t);
  const unregistered = await ownedChild(t);
  const roots = new Set([first, second]);
  const original = Error('production browser close refused');
  const kills = [first, second].map((child) =>
    t.mock.method(child, 'kill', child.kill.bind(child)),
  );
  const { value } = fixture(
    async () => {
      roots.clear();
      throw original;
    },
    () => [...roots, first],
  );
  await assert.rejects(value.close(), (error) => error === original);
  assert(exited(first));
  assert(exited(second));
  assert.equal(exited(unregistered), false);
  for (const kill of kills) {
    assert.equal(kill.mock.callCount(), 1);
    assert.deepEqual(kill.mock.calls[0]!.arguments, ['SIGKILL']);
  }
  await assert.rejects(value.close(), (error) => error === original);
  for (const kill of kills) assert.equal(kill.mock.callCount(), 1);
});

test('a successful production fixture close does not invoke emergency disposal', async (t) => {
  const child = await ownedChild(t);
  const kill = t.mock.method(child, 'kill', child.kill.bind(child));
  const { value } = fixture(
    async () => {},
    () => [child],
  );
  await value.close();
  assert.equal(kill.mock.callCount(), 0);
  assert.equal(exited(child), false);
});

test('emergency disposal failure retains both the production error and the actual disposal error', async (t) => {
  const child = await ownedChild(t);
  const other = await ownedChild(t);
  const original = Error('production close failed');
  const disposal = Error('owned native stop refused');
  const kill = t.mock.method(child, 'kill', () => {
    throw disposal;
  });
  const { value } = fixture(
    async () => {
      throw original;
    },
    () => [child, other],
  );
  try {
    await assert.rejects(value.close(), (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, disposal]);
      return true;
    });
    assert.equal(exited(child), false);
    assert(exited(other));
  } finally {
    kill.mock.restore();
  }
});

test('an undefined native disposal failure is retained as a failure value', async (t) => {
  const child = await ownedChild(t);
  const original = Error(
    'production close failed before undefined disposal failure',
  );
  const kill = t.mock.method(child, 'kill', () => {
    throw undefined;
  });
  const { value } = fixture(
    async () => {
      throw original;
    },
    () => [child],
  );
  try {
    await assert.rejects(value.close(), (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [original, undefined]);
      return true;
    });
    assert.equal(exited(child), false);
  } finally {
    kill.mock.restore();
  }
});

test('an expiring real phase deadline retains its cleanup failure and awaits the owned child exit', async (t) => {
  const child = await ownedChild(t);
  const cleanupError = Error('cleanup failed during actual phase expiration');
  const { value, records } = fixture(
    async () => {
      throw cleanupError;
    },
    () => [child],
  );
  let phase: unknown;
  await assert.rejects(
    value.run(
      { phase: 'actual pending phase' },
      () => new Promise(() => {}),
      1,
    ),
    (error) => {
      assert(error instanceof BrowserFixtureDeadline);
      phase = error;
      assert.equal(error, value.signal.reason);
      assert.equal(error.limitMs, 1);
      assert.equal((error as any).browserFixtureCleanup, cleanupError);
      return true;
    },
  );
  assert(exited(child));
  assert(records.some((record) => record.status === 'timeout'));
  assert(records.some((record) => record.status === 'cleanup-error'));
  await assert.rejects(value.close(), (error) => error === phase);
});

for (const phase of [
  Error('original fixture phase failed', {
    cause: Error('original phase cause'),
  }),
  new BrowserFixtureDeadline(
    {
      phase: 'original phase deadline',
      status: 'timeout',
      elapsed: 1,
      state: {},
    },
    1,
  ),
])
  test(`a cleanup failure preserves ${phase.constructor.name} identity and reports its second cause`, async (t) => {
    const child = await ownedChild(t);
    const close = Error('original fixture cleanup failed');
    const originalCause = phase.cause;
    const { value } = fixture(
      async () => {
        throw close;
      },
      () => [child],
    );
    await assert.rejects(
      value.run({ phase: 'original action' }, async () => {
        throw phase;
      }),
      (error) => {
        assert.equal(error, phase);
        assert.equal((error as any).browserFixtureCleanup, close);
        assert.equal(phase.cause, originalCause);
        return true;
      },
    );
    assert(exited(child));
    await assert.rejects(value.close(), (error) => error === phase);
  });

for (const phase of [
  Object.freeze(Error('frozen phase failed')),
  'phase value',
])
  test(`unmodifiable phase ${typeof phase} retains both original values when cleanup fails`, async () => {
    const close = Error('cleanup failed after unmodifiable phase');
    const { value } = fixture(async () => {
      throw close;
    });
    await assert.rejects(
      value.run({ phase: 'unmodifiable action' }, async () => {
        throw phase;
      }),
      (error) => {
        assert(error instanceof AggregateError);
        assert.equal(error.errors[0], phase);
        assert.equal(error.errors[1], close);
        return true;
      },
    );
  });

test('the real Node reporter remains red for cleanup failure after the owned child actually exits', (t) => {
  const root = scratch(t);
  const file = join(root, 'fixture-report.test.mjs');
  const module = new URL('./browser-fixture.ts', import.meta.url).href;
  writeFileSync(
    file,
    `
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { BrowserFixture } from ${JSON.stringify(module)};
const exited = child => child.exitCode !== null || child.signalCode !== null;
for (const phaseFailure of [false, true]) {
  test(phaseFailure ? 'retain phase and cleanup failures' : 'retain cleanup failure', async t => {
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    await once(child, 'message');
    const original = Error('reporter original production close refused');
    const phase = Error('reporter original fixture phase failed');
    const fixture = new BrowserFixture({
      budgetMs: 10_000,
      state: () => ({}),
      close: async () => { throw original; },
      ownedRoots: () => [child],
      report: () => {},
    });
    t.after(async () => {
      let caught;
      try { await fixture.close(); }
      catch (error) { caught = error; throw error; }
      finally {
        const exitObservedAtFixtureReturn = exited(child);
        // A regression must fail without leaving its real process alive. This safety
        // disposal is recorded and must remain unused for this test to pass.
        if (!exitObservedAtFixtureReturn) {
          const stopped = once(child, 'exit');
          child.kill('SIGKILL');
          await stopped;
        }
        writeFileSync(${JSON.stringify(root)} + '/' + (phaseFailure ? 'phase' : 'cleanup') + '.json', JSON.stringify({
          pid: child.pid,
          exitObservedAtFixtureReturn,
          exitObservedFinally: exited(child),
          originalIdentity: caught === (phaseFailure ? phase : original),
          cleanupIdentity: !phaseFailure || caught?.browserFixtureCleanup === original,
        }));
      }
    });
    if (phaseFailure) await fixture.run({ phase: 'reporter phase' }, async () => { throw phase; });
  });
}
`,
  );
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    CIRCLE_HOME: join(root, 'reporter-home'),
  };
  delete environment.NODE_TEST_CONTEXT;
  const report = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-isolation=none',
      '--test-reporter=spec',
      file,
    ],
    { encoding: 'utf8', env: environment, timeout: 10_000 },
  );
  const output = report.stdout + report.stderr;
  assert.equal(report.error, undefined, output);
  assert.equal(report.status, 1, output);
  assert.match(output, /reporter original production close refused/);
  assert.match(output, /reporter original fixture phase failed/);
  assert.match(output, /browserFixtureCleanup/);
  for (const name of ['phase', 'cleanup']) {
    const receipt = JSON.parse(
      readFileSync(join(root, name + '.json'), 'utf8'),
    );
    assert.equal(receipt.exitObservedAtFixtureReturn, true, name);
    assert.equal(receipt.exitObservedFinally, true, name);
    assert.equal(receipt.originalIdentity, true, name);
    assert.equal(receipt.cleanupIdentity, true, name);
  }
});

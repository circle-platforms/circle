import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DeliveryLogin,
  type LoginPty,
} from '../src/workspace/delivery-login.ts';
function fake() {
  let data: (s: string) => void = () => {};
  let exit: (e: { exitCode: number }) => void = () => {};
  let killed = false;
  const writes: string[] = [];
  const pty: LoginPty = {
    onData(cb) {
      data = cb;
    },
    onExit(cb) {
      exit = cb;
    },
    write(s) {
      writes.push(s);
    },
    kill() {
      killed = true;
      exit({ exitCode: 1 });
    },
  };
  return {
    pty,
    emit: (s: string) => data(s),
    finish: () => exit({ exitCode: 0 }),
    writes,
    get killed() {
      return killed;
    },
  };
}
test('device code flow encrypts then removes dedicated config before completion', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-login-test-'));
  try {
    const gh = path.join(root, 'gh');
    await writeFile(
      gh,
      `#!${process.execPath}\nprocess.stdout.write('test-secret-not-returned\\n');`,
    );
    await chmod(gh, 0o755);
    const child = fake();
    let dir = '';
    let saved = '';
    const login = new DeliveryLogin(
      (_file, args, opts) => {
        assert.ok(args.includes('--insecure-storage'));
        assert.equal(args[args.indexOf('--scopes') + 1], 'workflow');
        dir = (opts.env as Record<string, string>).GH_CONFIG_DIR;
        return child.pty;
      },
      gh,
      root,
      {
        get: async () => undefined,
        put: async (token) => {
          saved = token;
        },
      },
      async (file, args, options) => {
        assert.equal(file, gh);
        assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']);
        assert.equal(options.env.GH_CONFIG_DIR, dir);
        return promisify(execFile)(process.execPath, [gh, ...args], options);
      },
    );
    const state = await login.start();
    child.emit(
      'First copy your one-time code: ABCD-1234\nPress Enter to open browser',
    );
    assert.equal(login.poll(state.id).code, 'ABCD-1234');
    assert.deepEqual(child.writes, ['\r']);
    child.finish();
    for (let i = 0; i < 100 && login.poll(state.id).status !== 'complete'; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(
      login.poll(state.id).status,
      'complete',
      JSON.stringify(login.poll(state.id)),
    );
    assert.equal(login.poll(state.id).storage, 'encrypted');
    assert.equal(saved, 'test-secret-not-returned');
    assert.ok(!JSON.stringify(login.poll(state.id)).includes(saved));
    await assert.rejects(access(dir));
    await login.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('cancel removes temporary credentials and terminates only login helper', async () => {
  const child = fake();
  let dir = '';
  const login = new DeliveryLogin(
    (_f, _a, opts) => {
      dir = (opts.env as Record<string, string>).GH_CONFIG_DIR;
      return child.pty;
    },
    'unused',
    tmpdir(),
  );
  const state = await login.start();
  await login.cancel(state.id);
  assert.equal(child.killed, true);
  assert.equal(login.poll(state.id).status, 'cancelled');
  await assert.rejects(access(dir));
  await login.dispose();
});

test('explicit cancellation shares one real directory cleanup with the exit callback', async (t) => {
  const child = fake();
  let directory = '';
  const login = new DeliveryLogin(
    (_file, _args, options) => {
      directory = (options.env as Record<string, string>).GH_CONFIG_DIR;
      return child.pty;
    },
    'unused',
    tmpdir(),
  );
  const state = await login.start();
  const originalRm = fsPromises.rm.bind(fsPromises);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let cleaning = false,
    calls = 0;
  const interception = t.mock.method(
    fsPromises,
    'rm',
    async (
      target: Parameters<typeof fsPromises.rm>[0],
      options: Parameters<typeof fsPromises.rm>[1],
    ) => {
      if (String(target) !== directory) return originalRm(target, options);
      calls++;
      if (cleaning)
        throw Object.assign(Error('overlapping Windows directory cleanup'), {
          code: 'EPERM',
        });
      cleaning = true;
      started();
      await gate;
      return originalRm(target, options);
    },
  );
  syncBuiltinESMExports();
  try {
    let settled = false;
    const cancelling = login.cancel(state.id).then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    await entered;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      settled,
      false,
      'cancel waits for actual temporary directory removal',
    );
    release();
    const result = await cancelling;
    assert.equal(result.error, undefined);
    assert.equal(result.value?.status, 'cancelled');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(login.poll(state.id).status, 'cancelled');
    assert.equal(
      calls,
      1,
      'exit and cancel must not race separate filesystem removals',
    );
    await assert.rejects(access(directory));
  } finally {
    release();
    interception.mock.restore();
    syncBuiltinESMExports();
    await login.dispose();
    await originalRm(directory, { recursive: true, force: true });
  }
});

test('two cancellation callers wait for the delayed exit and share cleanup', async () => {
  const child = fake();
  let kills = 0,
    directory = '';
  child.pty.kill = () => {
    kills++;
  };
  const login = new DeliveryLogin(
    (_file, _args, options) => {
      directory = (options.env as Record<string, string>).GH_CONFIG_DIR;
      return child.pty;
    },
    'unused',
    tmpdir(),
  );
  try {
    const state = await login.start();
    child.emit('First copy your one-time code: ABCD-1234');
    assert.equal(login.poll(state.id).status, 'waiting');
    let completed = 0;
    const first = login.cancel(state.id).then((value) => {
      completed++;
      return value;
    });
    const second = login.cancel(state.id).then((value) => {
      completed++;
      return value;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(kills, 1);
    assert.equal(completed, 0);
    await access(directory);
    child.finish();
    const states = await Promise.all([first, second]);
    assert.ok(states.every((value) => value.status === 'cancelled'));
    await assert.rejects(access(directory));
  } finally {
    child.finish();
    await login.dispose();
  }
});

for (const phase of ['before-code', 'waiting-code']) {
  test(`cancel ${phase} waits for a real local helper PID and removes its config`, async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), 'circle-login-real-cancel-'),
    );
    let pid: number | undefined,
      directory = '';
    const login = new DeliveryLogin(
      (_file, args, options) => {
        assert.ok(args.includes('--web'));
        directory = (options.env as Record<string, string>).GH_CONFIG_DIR;
        const child = spawn(
          process.execPath,
          [
            '-e',
            "setTimeout(()=>process.stdout.write('First copy your one-time code: ABCD-1234\\nPress Enter to open browser\\n'),50);setInterval(()=>{},1000)",
          ],
          {
            cwd: root,
            env: options.env as NodeJS.ProcessEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );
        pid = child.pid;
        return {
          onData: (cb) => child.stdout.on('data', (data) => cb(String(data))),
          onExit: (cb) =>
            child.once('close', (code) => cb({ exitCode: code ?? 1 })),
          write: (value) => {
            child.stdin.write(value);
          },
          kill: () => {
            child.kill();
          },
        };
      },
      'synthetic-gh',
      root,
      undefined,
      async () => {
        throw Error('cancelled helper must never request a credential');
      },
    );
    try {
      const state = await login.start();
      assert.ok(pid);
      assert.doesNotThrow(() => process.kill(pid!, 0));
      if (phase === 'waiting-code') {
        for (
          let n = 0;
          n < 100 && login.poll(state.id).status !== 'waiting';
          n++
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(login.poll(state.id).status, 'waiting');
      }
      assert.equal((await login.cancel(state.id)).status, 'cancelled');
      assert.throws(() => process.kill(pid!, 0));
      await assert.rejects(access(directory));
    } finally {
      await login.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('failed encrypted persistence never silently becomes a session grant and explicit session storage never writes credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-login-explicit-'));
  let puts = 0;
  let child = fake();
  const login = new DeliveryLogin(
    () => child.pty,
    'fake-gh',
    root,
    {
      get: async () => undefined,
      put: async () => {
        puts++;
        throw Error('secure store unavailable');
      },
      delete: async () => {},
    },
    async () => ({ stdout: 'synthetic-explicit-token' }),
  );
  try {
    const encrypted = await login.start({ storage: 'encrypted' });
    child.finish();
    for (
      let i = 0;
      i < 100 && login.poll(encrypted.id).status !== 'failed';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(login.poll(encrypted.id).status, 'failed');
    assert.equal(await login.token(), undefined);
    assert.equal(puts, 1);
    child = fake();
    const session = await login.start({ storage: 'session' });
    child.finish();
    for (
      let i = 0;
      i < 100 && login.poll(session.id).status !== 'complete';
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(login.poll(session.id).storage, 'session');
    assert.equal(puts, 1);
    await login.disconnect();
    assert.equal(await login.token(), undefined);
  } finally {
    await login.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('known Git credential prompts decline helper configuration once; unknown prompts receive no input', async () => {
  for (const prompt of [
    '? Authenticate Git with your GitHub credentials? (Y/n) ',
    'Authenticate Git with your GitHub credentials? (default: yes) [Y/n] ',
    '\u001b[32m? Authenticate Git with your GitHub credentials?\u001b[0m (y/N) ',
  ]) {
    const child = fake();
    const login = new DeliveryLogin(
      (_file, _args, options) => {
        assert.equal(
          (options.env as NodeJS.ProcessEnv).GH_ACCESSIBLE_PROMPTER,
          '1',
        );
        return child.pty;
      },
      'unused',
      tmpdir(),
    );
    try {
      const started = await login.start({ storage: 'session' });
      child.emit('Unknown confirmation? (Y/n)\nPress Enter to open browser');
      assert.deepEqual(child.writes, []);
      for (const chunk of [prompt.slice(0, 18), prompt.slice(18)])
        child.emit(chunk);
      assert.deepEqual(child.writes, ['n\n']);
      child.emit(prompt);
      assert.deepEqual(child.writes, ['n\n']);
      child.emit(
        '\n! First copy your one-time code: ABCD-1234\nPress Enter to open https://github.com/login/device in your browser...',
      );
      assert.equal(login.poll(started.id).code, 'ABCD-1234');
      assert.deepEqual(child.writes, ['n\n', '\r']);
      child.emit('Press Enter to open browser');
      assert.deepEqual(child.writes, ['n\n', '\r']);
    } finally {
      await login.dispose();
    }
  }
});

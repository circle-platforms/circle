import { execFile } from 'node:child_process';
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

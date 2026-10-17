import test from 'node:test';
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeGitHubConnection } from '../src/workspace/github-connection.ts';

for (const mode of ['abort', 'abort-stubborn', 'dispose'] as const) {
  test(`owned GitHub child is closed before ${mode} completes`, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-gh-owned-close-'));
    // Windows paths already need JSON escaping; exercise the same argv boundary
    // on POSIX with a literal backslash in an owned fixture filename.
    const marker = path.join(
      root,
      process.platform === 'win32' ? 'pid' : 'pid\\marker',
    );
    const closedPids = new Set<number>();
    const emit = ChildProcess.prototype.emit;
    t.mock.method(
      ChildProcess.prototype,
      'emit',
      function (
        this: ChildProcess,
        event: string | symbol,
        ...args: unknown[]
      ) {
        if (event === 'close' && typeof this.pid === 'number')
          closedPids.add(this.pid);
        return Reflect.apply(emit, this, [event, ...args]);
      },
    );
    const native = new NativeGitHubConnection({
      dataDir: root,
      ghPath: process.execPath,
      spawn: () => {
        throw Error('authorization is not used');
      },
    });
    let pending: Promise<string> | undefined;
    try {
      await native.status();
      const state = native as unknown as {
        active: boolean;
        state: { state: string; epoch: number };
        login: { token: () => Promise<string> };
      };
      state.active = true;
      state.state.state = 'connected';
      state.state.epoch = 3;
      state.login.token = async () => 'synthetic-private-child-grant';
      const abort = new AbortController();
      pending = native.run(
        [
          '-e',
          `${mode === 'abort-stubborn' ? "process.on('SIGTERM',()=>{});" : ''}require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
        ],
        3,
        root,
        abort.signal,
      );
      const rejected = assert.rejects(pending, /cancel|failed|changed|abort/i);
      let pid: number | undefined;
      for (let attempt = 0; attempt < 200 && !pid; attempt++) {
        try {
          pid = Number(await readFile(marker, 'utf8'));
        } catch {
          await delay(10);
        }
      }
      assert(pid, 'actual owned child must start');
      if (mode !== 'dispose') {
        abort.abort();
        await rejected;
        assert.equal(
          closedPids.has(pid),
          true,
          'run cancellation must await this actual child close',
        );
      }
      const first = native.dispose();
      const second = native.dispose();
      assert.equal(second, first, 'dispose callers share the owned cleanup');
      await Promise.all([first, second]);
      assert.equal(
        closedPids.has(pid),
        true,
        'all dispose callers must await this actual child close',
      );
      assert.throws(() => process.kill(pid!, 0));
      await rejected;
    } finally {
      await native.dispose();
      await pending?.catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('account verification cancellation waits for its actual owned child close', async (t) => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'circle-gh-verification-close-'),
  );
  const marker = path.join(root, 'pid');
  const closed = new Set<number>();
  const emit = ChildProcess.prototype.emit;
  t.mock.method(
    ChildProcess.prototype,
    'emit',
    function (this: ChildProcess, event: string | symbol, ...args: unknown[]) {
      if (event === 'close' && typeof this.pid === 'number')
        closed.add(this.pid);
      return Reflect.apply(emit, this, [event, ...args]);
    },
  );
  const native = new NativeGitHubConnection({
    dataDir: root,
    ghPath: process.execPath,
    spawn: () => {
      throw Error('no authorization in this synthetic verification test');
    },
  });
  const internal = native as unknown as {
    state: { state: string; epoch: number; authorizationPhase: string };
    login: { token: () => Promise<string> };
    command: (
      args: string[],
      env: NodeJS.ProcessEnv,
      cwd: string,
      signal?: AbortSignal,
    ) => Promise<string>;
    verify: (epoch: number) => Promise<unknown>;
  };
  let pending: Promise<unknown> | undefined;
  try {
    await native.status();
    internal.state.state = 'authorizing';
    internal.state.epoch = 3;
    internal.state.authorizationPhase = 'verifying-account';
    internal.login.token = async () => 'synthetic-only';
    const run = internal.command.bind(internal);
    t.mock.method(
      internal,
      'command',
      (
        _args: string[],
        env: NodeJS.ProcessEnv,
        cwd: string,
        signal?: AbortSignal,
      ) =>
        run(
          [
            '-e',
            `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
          ],
          env,
          cwd,
          signal,
        ),
    );
    pending = internal.verify(3);
    const rejected = assert.rejects(pending, /abort|cancel|changed/i);
    let pid: number | undefined;
    for (let i = 0; i < 200 && !pid; i++) {
      try {
        pid = Number(await readFile(marker, 'utf8'));
      } catch {
        await delay(10);
      }
    }
    assert(pid, 'actual verification child must start');
    const result = await native.cancel(3);
    assert.equal(result.state, 'disconnected');
    assert.equal(
      closed.has(pid),
      true,
      'cancel completion must follow this verification child close',
    );
    assert.throws(() => process.kill(pid!, 0));
    await rejected;
  } finally {
    await native.dispose();
    await pending?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

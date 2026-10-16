import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeGitHubConnection } from '../src/workspace/github-connection.ts';
import { githubWorkspaceBackend } from '../src/workspace/github-backend.ts';
import { DeliveryService } from '../src/workspace/delivery.ts';
import { AgentRuntime } from '../../../src/runtime.js';
import {
  defaultSettings,
  trustFolder,
  saveSettings,
} from '../../../src/settings.js';
import { ScriptedModel } from '../../../src/testing.js';
import type { LoginPty } from '../src/workspace/delivery-login.ts';
const TOKEN = 'synthetic-github-token-never-in-model';
async function until<T>(read: () => Promise<T | false>) {
  for (let i = 0; i < 100; i++) {
    const result = await read();
    if (result) return result;
    await delay(25);
  }
  throw Error('fixture condition did not occur');
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-github-connection-'));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const helpers: {
    finish: () => void;
    emit: (text: string) => void;
    directory: string;
    killed: boolean;
  }[] = [];
  const calls: {
    args: string[];
    cwd: string;
    token: boolean;
    host: string;
    config: string;
    repo?: string;
  }[] = [];
  let persisted: string | undefined,
    puts = 0,
    deletes = 0,
    head = '';
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(call);
    let result: unknown;
    if (call.args[0] === 'api') result = { login: 'fixture', id: 7 };
    else if (call.args[0] === 'pr' && call.args[1] === 'view')
      result = {
        number: 1,
        url: 'https://github.com/fixture/repo/pull/1',
        isDraft: true,
        headRefOid: head,
        headRefName: 'codex/fixture',
        state: 'OPEN',
      };
    else if (call.args[0] === 'pr' && call.args[1] === 'checks')
      result = [{ name: 'test', bucket: 'pass', state: 'SUCCESS' }];
    else result = { ok: true };
    res.end(JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string');
  const connection = new NativeGitHubConnection({
    dataDir: path.join(root, 'profile'),
    ghPath: 'synthetic-gh',
    credentialStore: {
      get: async () => persisted,
      put: async (token) => {
        puts++;
        persisted = token;
      },
      delete: async () => {
        deletes++;
        persisted = undefined;
      },
    },
    credentialCommand: async () => ({ stdout: TOKEN }),
    spawn: (_file, _args, options) => {
      let data = (_text: string) => {},
        exit = (_event: { exitCode: number }) => {};
      const helper = {
        finish: () => exit({ exitCode: 0 }),
        emit: (text: string) => data(text),
        directory: (options.env as NodeJS.ProcessEnv).GH_CONFIG_DIR!,
        killed: false,
      };
      helpers.push(helper);
      const pty: LoginPty = {
        onData: (callback) => {
          data = callback;
        },
        onExit: (callback) => {
          exit = callback;
        },
        write: () => {},
        kill: () => {
          helper.killed = true;
          exit({ exitCode: 1 });
        },
      };
      return pty;
    },
    command: async (args, env, cwd) => {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: 'POST',
        body: JSON.stringify({
          args,
          cwd,
          token: env.GH_TOKEN === TOKEN,
          host: env.GH_HOST,
          config: env.GH_CONFIG_DIR,
          repo: env.GH_REPO,
        }),
      });
      return response.text();
    },
  });
  return {
    root,
    workspace,
    connection,
    helpers,
    calls,
    get puts() {
      return puts;
    },
    get deletes() {
      return deletes;
    },
    set head(value: string) {
      head = value;
    },
    close: async () => {
      await connection.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
test('one explicit local connection verifies actual HTTP identity and feeds real Harness tools, state and disconnect', async () => {
  const f = await fixture();
  let runtime: AgentRuntime | undefined;
  try {
    const delivery = new DeliveryService(f.workspace, 'synthetic-gh', {
      connection: f.connection,
      spawn: () => {
        throw Error('must not separately login');
      },
    });
    await delivery.git.git(['init']);
    await delivery.git.git(['config', 'user.name', 'Fixture']);
    await delivery.git.git(['config', 'user.email', 'fixture@example.invalid']);
    await delivery.git.git(['config', 'core.autocrlf', 'false']);
    await writeFile(path.join(f.workspace, 'file'), 'fixture\n');
    await delivery.git.git(['add', '--', 'file']);
    await delivery.git.git(['commit', '-m', 'Create fixture']);
    await delivery.git.git(['switch', '-c', 'codex/fixture']);
    await delivery.git.git([
      'remote',
      'add',
      'origin',
      'https://github.com/fixture/repo.git',
    ]);
    f.head = (await delivery.git.snapshot()).head;
    const backend = githubWorkspaceBackend({
      connection: f.connection,
      delivery: async () => delivery,
    });
    const release = backend.subscribe(() => {});
    const state = await backend.call('connect', {
      storage: 'session',
      repositories: ['fixture/repo'],
    });
    assert.equal(state.state, 'authorizing');
    f.helpers[0]!.emit(
      '! First copy your one-time code: ABCD-EFGH\nhttps://github.com/login/device\n',
    );
    f.helpers[0]!.finish();
    const connected = await until(async () => {
      const s = await backend.call('status', {});
      return s.state === 'connected' ? s : false;
    });
    assert.equal(connected.account?.login, 'fixture');
    assert.equal(f.puts, 0);
    assert.equal(connected.storage, 'session');
    await assert.rejects(access(f.helpers[0]!.directory), { code: 'ENOENT' });
    const modelReplies = [
      {
        message: {
          id: 'one',
          role: 'assistant',
          content: 'connected tools inspected',
        },
      },
      {
        message: {
          id: 'two',
          role: 'assistant',
          content: 'disconnected tools inspected',
        },
      },
    ];
    const model = new ScriptedModel(
      modelReplies as ConstructorParameters<typeof ScriptedModel>[0],
    );

    const settings = trustFolder(defaultSettings(), f.workspace);
    settings.extensions.github = { enabled: true };
    runtime = new AgentRuntime({
      home: path.join(f.root, 'home'),
      workspace: f.workspace,
      settings,
      model,
      githubConnection: backend,
      bundledExtensions: path.resolve('src/extensions'),
    });
    await runtime.harness.run('inspect connected GitHub capabilities');
    const tools = model.requests[0]!.tools;
    assert(tools.some((tool) => tool.name === 'github_connection'));
    assert(
      tools.some(
        (tool) => tool.name === 'github_checks' && tool.effect === 'read',
      ),
    );
    assert(
      tools.some(
        (tool) =>
          tool.name === 'github_publish' &&
          tool.approval === true &&
          tool.effect === 'unknown',
      ),
    );
    assert(!JSON.stringify(model.requests).includes(TOKEN));
    assert(!JSON.stringify(model.requests).includes('ABCD-EFGH'));
    const checks = await backend.call('checks', {
      epoch: connected.epoch,
      repository: 'fixture/repo',
      head: (await delivery.git.snapshot()).head,
    });
    assert.equal(checks.checks[0]?.state, 'SUCCESS');
    assert(
      f.calls
        .filter((call) => call.args[0] === 'pr')
        .every((call) => call.cwd === f.workspace),
    );
    assert(
      f.calls.every(
        (call) =>
          call.token &&
          call.host === 'github.com' &&
          (call.args[0] === 'api'
            ? !call.repo
            : call.repo === 'fixture/repo') &&
          call.config.startsWith(f.root),
      ),
    );
    release();
    settings.extensions.github = { enabled: false };
    saveSettings(settings, runtime.options.home);
    await runtime.reloadIntegrations();
    await assert.rejects(
      backend.call('checks', {
        epoch: connected.epoch,
        repository: 'fixture/repo',
        head: (await delivery.git.snapshot()).head,
      }),
      /disabled/,
    );
    await runtime.harness.run('inspect disabled GitHub extension');
    assert(
      !model.requests[1]!.tools.some((tool) => tool.name.startsWith('github_')),
    );
    settings.extensions.github = { enabled: true };
    saveSettings(settings, runtime.options.home);
    await runtime.reloadIntegrations();
    const off = await backend.call('disconnect', { epoch: connected.epoch });
    assert.equal(off.state, 'disconnected');
    assert.equal(f.deletes, 1);
    assert(off.epoch > connected.epoch);
    await assert.rejects(
      backend.call('checks', {
        epoch: connected.epoch,
        repository: 'fixture/repo',
        head: 'a'.repeat(40),
      }),
      /changed/,
    );
    modelReplies.push({
      message: {
        id: 'three',
        role: 'assistant' as const,
        content: 'disconnected tools inspected',
      },
    });
    await runtime.harness.run('inspect disconnected GitHub capabilities');
    assert(
      model.requests[2]!.tools.some(
        (tool) => tool.name === 'github_connection',
      ),
    );
    assert(
      !model.requests[2]!.tools.some((tool) => tool.name === 'github_publish'),
    );
  } finally {
    await runtime?.close();
    await f.close();
  }
});
test('cancelled verification and stale token awaits never dispatch late operations; failed metadata cannot skip secret cleanup', async () => {
  const f = await fixture();
  try {
    const state = await f.connection.connect({
      storage: 'encrypted',
      repositories: ['fixture/repo'],
    });
    f.helpers[0]!.finish();
    const connected = await until(async () => {
      const s = await f.connection.status();
      return s.state === 'connected' ? s : false;
    });
    assert.equal(f.puts, 1);
    const internals = f.connection as unknown as {
      login: { token: () => Promise<string | undefined> };
    };
    const actual = internals.login.token.bind(internals.login);
    let release!: (value: string) => void;
    let entered!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    internals.login.token = () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const count = f.calls.length;
    const pending = f.connection.run(
      ['pr', 'checks'],
      connected.epoch,
      f.workspace,
    );
    await seen;
    await mkdir(
      path.join(
        f.root,
        'profile',
        'github-connection.json.' + (state.epoch + 1) + '.tmp',
      ),
    );
    const off = await f.connection.disconnect(connected.epoch);
    assert.equal(off.state, 'disconnected');
    assert.match(off.error ?? '', /removal/);
    assert.equal(f.deletes, 1);
    release(TOKEN);
    await assert.rejects(pending, /changed/);
    assert.equal(f.calls.length, count);
    internals.login.token = actual;
  } finally {
    await f.close();
  }
});

test('native owned gh subprocess actually exits on cancellation and no operation can run after dispose', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-github-cancel-pid-'));
  let native: NativeGitHubConnection | undefined;
  try {
    native = new NativeGitHubConnection({
      dataDir: root,
      ghPath: process.execPath,
      spawn: () => {
        throw Error('no authorization in this process-control test');
      },
    });
    await native.status();
    const internals = native as unknown as {
      active: boolean;
      state: { state: string; epoch: number };
      login: { token: () => Promise<string | undefined> };
    };
    internals.active = true;
    internals.state.state = 'connected';
    internals.state.epoch = 3;
    internals.login.token = async () => TOKEN;
    const marker = path.join(root, 'child-pid');
    const abort = new AbortController();
    const command = native.run(
      [
        '-e',
        `require('fs').writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`,
      ],
      3,
      root,
      abort.signal,
    );
    const rejected = assert.rejects(command, /cancel|failed|changed|abort/i);
    const pid = await until(async () => {
      try {
        return Number(
          await (await import('node:fs/promises')).readFile(marker, 'utf8'),
        );
      } catch {
        return false;
      }
    });
    abort.abort();
    await rejected;
    await until(async () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await native.dispose();
    await assert.rejects(
      native.run(['--version'], 3, root),
      /expired|disconnected/,
    );
  } finally {
    await native?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('known authorization expiry invalidates the epoch while permission failure remains separate and sanitized', async () => {
  const f = await fixture();
  try {
    await f.connection.connect({
      storage: 'session',
      repositories: ['fixture/repo'],
    });
    f.helpers[0]!.finish();
    const connected = await until(async () => {
      const state = await f.connection.status();
      return state.state === 'connected' ? state : false;
    });
    const internals = f.connection as unknown as {
      command: () => Promise<string>;
    };
    internals.command = async () => {
      throw Object.assign(Error('synthetic permission detail ' + TOKEN), {
        status: 403,
      });
    };
    await assert.rejects(
      f.connection.run(['pr', 'checks'], connected.epoch, f.workspace),
      /permission denied/,
    );
    assert.equal((await f.connection.status()).state, 'connected');
    assert(!JSON.stringify(await f.connection.status()).includes(TOKEN));
    internals.command = async () => {
      throw Object.assign(Error('synthetic expired detail ' + TOKEN), {
        status: 401,
      });
    };
    await assert.rejects(
      f.connection.run(['pr', 'checks'], connected.epoch, f.workspace),
      /expired/,
    );
    const expired = await f.connection.status();
    assert.equal(expired.state, 'error');
    assert(expired.epoch > connected.epoch);
    assert.equal(expired.account, undefined);
    assert.equal(f.deletes, 1);
    assert(!JSON.stringify(expired).includes(TOKEN));
  } finally {
    await f.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeGitHubConnection } from '../src/workspace/github-connection.ts';
import { githubWorkspaceBackend } from '../src/workspace/github-backend.ts';
import { OperationLedger } from '../src/workspace/operation-ledger.ts';
import { createHash } from 'node:crypto';
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
    head = '',
    failRerun = false;
  let requestGate: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const call = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(call);
    if (requestGate) await requestGate;
    if (failRerun && call.args[0] === 'run' && call.args[1] === 'rerun') {
      res.destroy();
      return;
    }
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
    else if (call.args[0] === 'run' && call.args[1] === 'view')
      result = { headSha: head };
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
    command: async (args, env, cwd, signal) => {
      const response = await fetch(`http://127.0.0.1:${address.port}`, {
        method: 'POST',
        signal,
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
    set requestGate(value: Promise<void> | undefined) {
      requestGate = value;
    },
    set failRerun(value: boolean) {
      failRerun = value;
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
  const ledger = await OperationLedger.open({
    directory: path.join(f.root, 'operations'),
  });
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
      runWrite: (method, params, callId, action) =>
        ledger.run(
          {
            id: callId,
            sessionId: 'fixture-session',
            service: 'github',
            method,
            paramsHash: createHash('sha256')
              .update(JSON.stringify(params))
              .digest('hex'),
          },
          action,
        ),
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
          tool_calls: [
            {
              id: 'actual-harness-call',
              name: 'github_retry',
              args: {
                epoch: connected.epoch,
                repository: 'fixture/repo',
                head: (await delivery.git.snapshot()).head,
                runId: 123,
              },
            },
          ],
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
    runtime.policy.setYolo(runtime.session.id, true);
    await runtime.harness.run('inspect connected GitHub capabilities');
    assert.equal(ledger.list()[0]?.id, 'actual-harness-call');
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
    const retry = {
      epoch: connected.epoch,
      repository: 'fixture/repo',
      head: (await delivery.git.snapshot()).head,
      runId: 123,
    };
    await assert.rejects(
      backend.call('retry', retry),
      /trusted operation identity/,
    );
    const context = {
      signal: new AbortController().signal,
      callId: 'actual-harness-call',
    };
    const results = await Promise.all([
      backend.call('retry', retry, context),
      backend.call('retry', retry, context),
    ]);
    assert.deepEqual(results[0], results[1]);
    await backend.call('retry', retry, context);
    assert.equal(
      f.calls.filter((c) => c.args[0] === 'run' && c.args[1] === 'rerun')
        .length,
      1,
    );
    await assert.rejects(
      backend.call('retry', { ...retry, runId: 124 }, context),
      /reused with different input/,
    );
    f.failRerun = true;
    const uncertain = { signal: context.signal, callId: 'uncertain-write' };
    await assert.rejects(
      backend.call('retry', { ...retry, runId: 125 }, uncertain),
      /inspect effects/,
    );
    f.failRerun = false;
    const callsAfterUnknown = f.calls.length;
    await assert.rejects(
      backend.call('retry', { ...retry, runId: 125 }, uncertain),
      /review/,
    );
    assert.equal(f.calls.length, callsAfterUnknown);

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
    modelReplies.push({
      message: { id: 'disabled', role: 'assistant', content: 'disabled' },
    });
    await runtime.harness.run('inspect disabled GitHub extension');
    assert(
      !model.requests[2]!.tools.some((tool) => tool.name.startsWith('github_')),
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
      model.requests[3]!.tools.some(
        (tool) => tool.name === 'github_connection',
      ),
    );
    assert(
      !model.requests[3]!.tools.some((tool) => tool.name === 'github_publish'),
    );
  } finally {
    await runtime?.close();
    await ledger.close();
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

test('profile disable unloads only GitHub in two controller runtimes and freezes old operation generations', async () => {
  const { RuntimeController } = await import('../src/runtime-controller.ts');
  const f = await fixture(),
    home = path.join(f.root, 'controller-home');
  const settings = trustFolder(defaultSettings(), f.workspace);
  settings.extensions.github = { enabled: true };
  saveSettings(settings, home);
  await mkdir(path.join(home, 'extensions', 'observer'), { recursive: true });
  await writeFile(
    path.join(home, 'extensions', 'observer', 'extension.mjs'),
    `export function register(api){api.registerTool('observer_alive','observer',{type:'object',properties:{}},()=>String(api.signal.aborted),{readOnly:true});api.background(new Promise(resolve=>api.signal.addEventListener('abort',resolve,{once:true})));}`,
  );
  const model = new ScriptedModel(
    Array.from({ length: 4 }, (_, i) => ({
      message: {
        id: String(i),
        role: 'assistant' as const,
        content: 'inspected',
      },
    })),
  );
  const controller = new RuntimeController({
    home,
    workspace: f.workspace,
    userHome: home,
    model,
    emit: () => {},
  });
  const internal = controller as unknown as {
    githubProfile?: NativeGitHubConnection;
    runtimes: { values(): Iterable<AgentRuntime> };
    githubBackend(
      workspace: string,
      owner: () => string,
    ): ReturnType<typeof githubWorkspaceBackend>;
    githubInvocation(id: string): { signal: AbortSignal; assertActive(): void };
    githubAvailable(id: string): boolean;
  };
  internal.githubProfile = f.connection;
  controller.options.workspaceTools = {
    nodeExecutable: process.execPath,
    runtimeExecutable: process.execPath,
    adapterPath: 'unused',
    ghPath: 'synthetic-gh',
  };
  try {
    const a = [...internal.runtimes.values()][0]!;
    const backendA = internal.githubBackend(f.workspace, () => a.session.id);
    a.extensions.options.githubConnection = backendA;
    a.options.githubConnection = backendA;
    await a.reloadIntegrations();
    await a.harness.run('inspect A');
    await controller.dispatch({
      id: 'new-b',
      name: 'new-session',
      sessionId: a.session.id,
      payload: {},
    });
    const b = [...internal.runtimes.values()].find((r) => r !== a)!;
    await b.harness.run('inspect B');
    const listeners = () =>
      (f.connection as unknown as { listeners: Set<unknown> }).listeners.size;
    assert.equal(
      listeners(),
      2,
      JSON.stringify([
        a.extensions.extensions.map((e) => [e.name, e.enabled, e.error]),
        b.extensions.extensions.map((e) => [e.name, e.enabled, e.error]),
      ]),
    );
    assert(internal.githubAvailable(a.session.id));
    assert(internal.githubAvailable(b.session.id));
    await backendA.call('connect', {
      storage: 'session',
      repositories: ['fixture/repo'],
    });
    f.helpers[0]!.finish();
    const account = await until(async () => {
      const s = await backendA.call('status', {});
      return s.state === 'connected' ? s : false;
    });
    const old = internal.githubInvocation(a.session.id);
    const oldUI = new DeliveryService(f.workspace, 'synthetic-gh', {
      connection: f.connection,
      epoch: account.epoch,
      spawn: () => {
        throw Error('login belongs in settings');
      },
      ...old,
    });
    const oldCycle = new DeliveryService(f.workspace, 'synthetic-gh', {
      connection: f.connection,
      epoch: account.epoch,
      spawn: () => {
        throw Error('login belongs in settings');
      },
      ...internal.githubInvocation(a.session.id),
    });
    await oldUI.git.git(['init']);
    await oldUI.git.git([
      'remote',
      'add',
      'origin',
      'https://github.com/fixture/repo.git',
    ]);
    let unblock!: () => void;
    f.requestGate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const started = f.calls.length;
    const inflight = oldUI.gh(['pr', 'view']);
    const rejected = assert.rejects(inflight);
    await until(async () => (f.calls.length > started ? true : false));

    const observerA = a.extensions.extensions.find(
      (e) => e.name === 'observer',
    );
    const before = f.calls.length;
    const off = await controller.dispatch({
      id: 'off',
      name: 'save-settings',
      sessionId: b.session.id,
      payload: {
        settings: {},
        extensions: [{ name: 'github', enabled: false }],
      },
    });
    assert.equal(off.ok, true);
    await rejected;
    unblock();
    f.requestGate = undefined;
    assert(old.signal.aborted);
    assert.throws(old.assertActive);
    assert.equal(listeners(), 0);
    await a.harness.run('inspect A off');
    await b.harness.run('inspect B off');
    for (const request of model.requests.slice(2)) {
      assert(!request.tools.some((t) => t.name.startsWith('github_')));
      assert(request.tools.some((t) => t.name === 'observer_alive'));
    }
    assert.equal(
      a.extensions.extensions.find((e) => e.name === 'observer'),
      observerA,
    );
    assert.equal(
      await a.extensions
        .tools()
        .find((t) => t.name === 'observer_alive')!
        .run(
          {},
          { signal: new AbortController().signal, sessionId: a.session.id },
        ),
      'false',
    );
    const on = await controller.dispatch({
      id: 'on',
      name: 'save-settings',
      sessionId: b.session.id,
      payload: {
        settings: {},
        extensions: [{ name: 'github', enabled: true }],
      },
    });
    assert.equal(on.ok, true);
    const freshBackend = internal.githubBackend(
      f.workspace,
      () => a.session.id,
    );
    const release = freshBackend.subscribe(() => {});
    assert(internal.githubAvailable(a.session.id));
    assert.throws(old.assertActive);
    assert(old.signal.aborted);
    assert.doesNotThrow(internal.githubInvocation(a.session.id).assertActive);
    await assert.rejects(oldUI.gh(['pr', 'view']));
    await assert.rejects(oldCycle.gh(['pr', 'view']));
    await assert.rejects(backendA.call('status', {}), /disabled/);
    release();
    assert.equal(f.calls.length, before);
  } finally {
    await controller.close();
    await f.close();
  }
});

test('account connects without a repository and explicit repository configuration preserves the grant while advancing epoch', async () => {
  const f = await fixture();
  let runtime: AgentRuntime | undefined;
  try {
    const backend = githubWorkspaceBackend({
      connection: f.connection,
      delivery: async () => {
        throw Error('repository adapter must not be invoked');
      },
    });
    const settings = trustFolder(defaultSettings(), f.workspace);
    settings.extensions.github = { enabled: true };
    const model = new ScriptedModel(
      Array.from({ length: 3 }, (_, i) => ({
        message: {
          id: String(i),
          role: 'assistant' as const,
          content: 'inspect',
        },
      })),
    );
    runtime = new AgentRuntime({
      home: path.join(f.root, 'model-home'),
      workspace: f.workspace,
      settings,
      model,
      githubConnection: backend,
      bundledExtensions: path.resolve('src/extensions'),
    });
    await runtime.initialize();
    await backend.call('connect', { storage: 'session', repositories: [] });
    f.helpers[0]!.finish();
    let state = await until(async () => {
      const state = await backend.call('status', {});
      return state.state === 'connected' ? state : false;
    });
    assert.deepEqual(state.repositories, []);
    assert.equal(state.account?.login, 'fixture');
    await runtime.harness.run('account without project');
    assert.deepEqual(
      model.requests[0]!.tools.filter((t) => t.name.startsWith('github_')).map(
        (t) => t.name,
      ),
      ['github_connection'],
    );
    const old = state.epoch;
    state = await backend.call('configure', {
      epoch: old,
      repositories: ['fixture/repo'],
    });
    assert(state.epoch > old);
    assert.equal(f.helpers.length, 1);
    assert.equal(f.puts, 0);
    await assert.rejects(
      backend.call('configure', { epoch: old, repositories: ['another/repo'] }),
      /changed/,
    );
    await runtime.harness.run('configured project');
    assert(model.requests[1]!.tools.some((t) => t.name === 'github_publish'));
    state = await backend.call('configure', {
      epoch: state.epoch,
      repositories: [],
    });
    assert.equal(state.state, 'connected');
    assert.equal(state.account?.login, 'fixture');
    await runtime.harness.run('project removed');
    assert(!model.requests[2]!.tools.some((t) => t.name === 'github_publish'));
    assert.throws(
      () => f.connection.assertGrant(state.epoch, 'fixture/repo'),
      /permission changed/,
    );
    const metadata = path.join(f.root, 'profile', 'github-connection.json');
    await rm(metadata);
    await mkdir(metadata);
    await assert.rejects(
      backend.call('configure', {
        epoch: state.epoch,
        repositories: ['unexpected/repo'],
      }),
      /could not be saved/,
    );
    const failed = await backend.call('status', {});
    assert.deepEqual(failed.repositories, []);
    assert.equal(failed.state, 'connected');
    assert(failed.epoch > state.epoch);
    assert.throws(
      () => f.connection.assertGrant(failed.epoch, 'unexpected/repo'),
      /permission changed/,
    );
    assert.equal(f.helpers.length, 1);
    assert(f.calls.every((c) => c.args[0] === 'api'));
  } finally {
    await runtime?.close();
    await f.close();
  }
});

test('disable during pending extension registration cannot publish late GitHub tools or subscriptions', async () => {
  const f = await fixture();
  let runtime: AgentRuntime | undefined;
  let release!: () => void;
  const signal = new AbortController();
  let enabled = true,
    entered = false;
  const original = f.connection.status.bind(f.connection);
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.connection.status = async () => {
    entered = true;
    await gate;
    return original();
  };
  try {
    const backend = githubWorkspaceBackend({
      connection: f.connection,
      delivery: async () => {
        throw Error('unused');
      },
      assertEnabled: () => {
        if (!enabled) throw Error('disabled');
      },
      providerSignal: () => signal.signal,
    });
    const settings = trustFolder(defaultSettings(), f.workspace);
    settings.extensions.github = { enabled: true };
    const model = new ScriptedModel([
      { message: { id: 'after', role: 'assistant', content: 'inspect' } },
    ]);
    runtime = new AgentRuntime({
      home: path.join(f.root, 'home'),
      workspace: f.workspace,
      settings,
      model,
      githubConnection: backend,
      bundledExtensions: path.resolve('src/extensions'),
    });
    const loading = runtime.initialize();
    await until(async () => (entered ? true : false));
    enabled = false;
    signal.abort();
    release();
    await loading;
    await runtime.harness.run('inspect disabled during initialization');
    assert(!model.requests[0]!.tools.some((t) => t.name.startsWith('github_')));
    assert.equal(
      (f.connection as unknown as { listeners: Set<unknown> }).listeners.size,
      0,
    );
  } finally {
    release();
    await runtime?.close();
    await f.close();
  }
});

test('trusted Git push rechecks the frozen invocation after the actual repository lock and never writes the local bare remote after disable', async () => {
  const { GitWorkspaceService } = await import('../src/workspace/git.ts');
  const { serializeGitMutation } = await import('../src/workspace/git.ts');
  const { realpath } = await import('node:fs/promises');
  const f = await fixture();
  let unlock!: () => void;
  try {
    const git = new GitWorkspaceService(f.workspace);
    await git.git(['init']);
    await git.git(['config', 'user.name', 'Fixture']);
    await git.git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(f.workspace, 'file'), 'fixture\n');
    await git.git(['add', '--', 'file']);
    await git.git(['commit', '-m', 'Create fixture']);
    await git.git(['switch', '-c', 'codex/frozen']);
    const bare = path.join(f.root, 'remote.git');
    await git.git(['init', '--bare', bare]);
    await git.git(['remote', 'add', 'origin', bare]);
    const state = await git.snapshot();
    const common = await realpath(
      path.resolve(
        f.workspace,
        (await git.git(['rev-parse', '--git-common-dir'])).trim(),
      ),
    );
    let locked!: () => void;
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    const gate = new Promise<void>((r) => {
      unlock = r;
    });
    const held = serializeGitMutation(common, async () => {
      locked();
      await gate;
    });
    await ready;
    const old = new AbortController();
    let enabled = true;
    const attempted = git.call(
      'push',
      { revision: state.revision },
      {
        signal: old.signal,
        assertActive: () => {
          if (!enabled) throw Error('disabled');
        },
      },
    );
    const rejected = assert.rejects(attempted);
    await delay(20);
    enabled = false;
    old.abort();
    enabled = true;
    unlock();
    await held;
    await rejected;
    assert.equal(
      (await git.git(['ls-remote', '--heads', 'origin'])).trim(),
      '',
    );
    // A new explicit operation remains possible; the failed old one is never replayed.
    await git.call(
      'push',
      { revision: (await git.snapshot()).revision },
      { signal: new AbortController().signal },
    );
    assert(
      (await git.git(['ls-remote', '--heads', 'origin'])).includes(state.head),
    );
  } finally {
    unlock?.();
    await f.close();
  }
});

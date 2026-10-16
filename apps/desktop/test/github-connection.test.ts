import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  access,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import type {
  DeliveryLogin,
  LoginPty,
} from '../src/workspace/delivery-login.ts';
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
    args: string[];
  }[] = [];
  const calls: {
    args: string[];
    cwd: string;
    token: boolean;
    host: string;
    config: string;
    repo?: string;
  }[] = [];
  let failPut = false;
  let persisted: string | undefined,
    puts = 0,
    deletes = 0,
    head = '',
    failRerun = false;
  let scopeHeader: string | undefined;
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
    res.end(
      call.args[0] === 'api' && scopeHeader !== undefined
        ? `HTTP/2.0 200 OK\r\nX-OAuth-Scopes: ${scopeHeader}\r\nX-Fixture: ignored\r\n\r\n${JSON.stringify(result)}\n`
        : JSON.stringify(result),
    );
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
        if (failPut)
          throw Object.assign(Error('ENCRYPTION_UNAVAILABLE ' + TOKEN), {
            code: 'ENCRYPTION_UNAVAILABLE',
          });
      },
      delete: async () => {
        deletes++;
        persisted = undefined;
      },
    },
    credentialCommand: async () => ({ stdout: TOKEN }),
    spawn: (_file, args, options) => {
      let data = (_text: string) => {},
        exit = (_event: { exitCode: number }) => {};
      const helper = {
        finish: () => exit({ exitCode: 0 }),
        emit: (text: string) => data(text),
        directory: (options.env as NodeJS.ProcessEnv).GH_CONFIG_DIR!,
        killed: false,
        args: [...args],
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
    set failPut(value: boolean) {
      failPut = value;
    },
    set scopeHeader(value: string | undefined) {
      scopeHeader = value;
    },
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
  f.scopeHeader = 'repo, read:org, gist, workflow';
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
    assert.deepEqual(connected.requestedAdditionalScopes, ['workflow']);
    assert.deepEqual(connected.grantedScopes, [
      'repo',
      'read:org',
      'gist',
      'workflow',
    ]);
    assert.equal(connected.scopeVerification, 'reported');
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
              id: 'actual-scope-metadata',
              name: 'github_connection',
              args: {},
            },
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
      bundledExtensions: fileURLToPath(
        new URL('../../../src/extensions', import.meta.url),
      ),
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
    assert(
      JSON.stringify(model.requests).includes('requestedAdditionalScopes'),
    );
    assert(JSON.stringify(model.requests).includes('grantedScopes'));
    assert(JSON.stringify(model.requests).includes('workflow'));
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
    assert.equal(
      (await f.connection.status()).error,
      'GitHub permission denied for this repository',
    );
    assert(!JSON.stringify(await f.connection.status()).includes(TOKEN));
    internals.command = async () => {
      throw Error('synthetic network detail ' + TOKEN);
    };
    await assert.rejects(
      f.connection.run(['pr', 'checks'], connected.epoch, f.workspace),
      {
        message:
          'GitHub request failed; check the connection and retry the read',
      },
    );
    assert.equal((await f.connection.status()).state, 'connected');
    assert(!JSON.stringify(await f.connection.status()).includes(TOKEN));
    const login = (
      f.connection as unknown as {
        login: { token(): Promise<string | undefined> };
      }
    ).login;
    const actualToken = login.token.bind(login);
    login.token = async () => undefined;
    let dispatched = false;
    try {
      await assert.rejects(
        f.connection
          .gitPushAuthentication(connected.epoch, 'fixture/repo')
          .withCredentials(async () => {
            dispatched = true;
            return '';
          }),
        { message: 'connect GitHub in the GitHub plugin details' },
      );
      assert.equal(dispatched, false);
    } finally {
      login.token = actualToken;
    }
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
    assert.equal(
      expired.error,
      'GitHub authorization expired; reconnect in the GitHub plugin details',
    );
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
    services(
      workspace: string,
    ): import('../src/workspace/workspace-services.ts').WorkspaceServices;
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
    const oldMetadataTool = a.extensions
      .tools()
      .find((tool) => tool.name === 'github_connection')!;
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
    await oldUI.git.git(['config', 'user.name', 'Fixture']);
    await oldUI.git.git(['config', 'user.email', 'fixture@example.invalid']);
    const services = internal.services(a.options.workspace);
    const record = (await services.call(a.session.id, 'cycles', 'create', {
      id: 'controller-bound-cycle',
      operationId: 'controller-bind-create',
      title: 'Check native cycle binding',
      body: '',
      acceptanceCriteria: ['exercise actual controller bridge'],
    })) as { id: string };
    const advanced = (await services.call(a.session.id, 'cycles', 'advance', {
      id: record.id,
    })) as { state: string; reason?: string };
    assert.equal(advanced.state, 'needs_review');
    assert(
      !/authorization scope is missing/.test(advanced.reason ?? ''),
      advanced.reason,
    );

    await assert.rejects(
      oldMetadataTool.run(
        {},
        { signal: new AbortController().signal, sessionId: a.session.id },
      ),
      /abort|disabled|closed/i,
    );
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
      bundledExtensions: fileURLToPath(
        new URL('../../../src/extensions', import.meta.url),
      ),
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
      bundledExtensions: fileURLToPath(
        new URL('../../../src/extensions', import.meta.url),
      ),
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

test('actual secure persistence failure reaches the extension view without secrets and only an explicit session grant can recover', async () => {
  const f = await fixture();
  let runtime: AgentRuntime | undefined;
  try {
    f.failPut = true;
    const backend = githubWorkspaceBackend({
      connection: f.connection,
      delivery: async () => {
        throw Error('must not dispatch');
      },
    });
    const settings = trustFolder(defaultSettings(), f.workspace);
    settings.extensions.github = { enabled: true };
    const model = new ScriptedModel([
      {
        message: {
          id: 'storage-error',
          role: 'assistant',
          content: 'inspect state',
        },
      },
    ]);
    runtime = new AgentRuntime({
      home: path.join(f.root, 'home'),
      workspace: f.workspace,
      settings,
      model,
      githubConnection: backend,
      bundledExtensions: fileURLToPath(
        new URL('../../../src/extensions', import.meta.url),
      ),
    });
    await runtime.initialize();
    await backend.call('connect', { storage: 'encrypted', repositories: [] });
    f.helpers[0]!.finish();
    const failed = await until(async () => {
      const state = await backend.call('status', {});
      return state.state === 'error' ? state : false;
    });
    assert.equal(failed.error, 'secure credential storage is unavailable');
    assert.equal(failed.account, undefined);
    assert.equal(failed.storage, 'encrypted');
    assert.equal(f.puts, 1);
    assert(f.deletes > 0);
    const view = runtime.extensions.extensions.find(
      (e) => e.name === 'github',
    )!.view;
    assert.equal((view as { error: string }).error, failed.error);
    assert(!JSON.stringify(view).includes(TOKEN));
    assert.equal(
      await (
        f.connection as unknown as {
          login: { token(): Promise<string | undefined> };
        }
      ).login.token(),
      undefined,
    );
    assert.equal(f.calls.length, 0);
    await runtime.harness.run('inspect failed storage');
    assert(!model.requests[0]!.tools.some((t) => t.name === 'github_publish'));
    assert(!JSON.stringify(model.requests).includes(TOKEN));
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(f.root, 'profile', 'github-connection.json'),
          'utf8',
        ),
      ).resume,
      false,
    );
    await backend.call('connect', { storage: 'session', repositories: [] });
    f.helpers[1]!.finish();
    const recovered = await until(async () => {
      const state = await backend.call('status', {});
      return state.state === 'connected' ? state : false;
    });
    assert.equal(recovered.storage, 'session');
    assert.equal(recovered.account?.login, 'fixture');
    assert.equal(f.puts, 1);
  } finally {
    await runtime?.close();
    await f.close();
  }
});

test('metadata persistence failures stay distinct from secure storage and never expose a connected account or retain its grant', async (t) => {
  for (const phase of ['before-helper', 'after-verification'])
    await t.test(phase, async () => {
      const f = await fixture();
      const states: string[] = [];
      const backend = githubWorkspaceBackend({
        connection: f.connection,
        delivery: async () => {
          throw Error('must not dispatch');
        },
      });
      const release = backend.subscribe((state) => states.push(state.state));
      try {
        await backend.call('status', {});
        const metadata = path.join(f.root, 'profile', 'github-connection.json');
        if (phase === 'before-helper') {
          await mkdir(metadata);
          await assert.rejects(
            backend.call('connect', { storage: 'encrypted', repositories: [] }),
            /connection settings could not be saved/,
          );
          assert.equal(f.helpers.length, 0);
        } else {
          await backend.call('connect', {
            storage: 'encrypted',
            repositories: [],
          });
          await rm(metadata);
          await mkdir(metadata);
          f.helpers[0]!.finish();
          await until(async () => {
            const state = await backend.call('status', {});
            return state.state === 'error' ? state : false;
          });
          assert.equal(f.puts, 1);
          assert(f.deletes > 0);
          assert.equal(f.calls.length, 1);
        }
        const failed = await backend.call('status', {});
        assert.equal(failed.state, 'error');
        assert.equal(failed.account, undefined);
        assert.equal(
          failed.error,
          'GitHub connection settings could not be saved',
        );
        assert(!states.includes('connected'));
        assert(!JSON.stringify(failed).includes(TOKEN));
        assert.equal(
          await (
            f.connection as unknown as {
              login: { token(): Promise<string | undefined> };
            }
          ).login.token(),
          undefined,
        );
        await assert.rejects(
          f.connection.run(['pr', 'view'], failed.epoch, f.workspace),
          /disconnected|expired/,
        );
      } finally {
        release();
        await f.close();
      }
    });
});

test('the original settings toggle loads only GitHub into the existing runtime and pending enable cannot survive a later off', async () => {
  const { RuntimeController } = await import('../src/runtime-controller.ts');
  const root = await mkdtemp(path.join(tmpdir(), 'circle-enable-native-')),
    home = path.join(root, 'home'),
    workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const settings = trustFolder(defaultSettings(), workspace);
  settings.extensions.github = { enabled: false };
  saveSettings(settings, home);
  await mkdir(path.join(home, 'extensions', 'observer'), { recursive: true });
  await writeFile(
    path.join(home, 'extensions', 'observer', 'extension.mjs'),
    `export function register(api){api.registerTool('observer_alive','observer',{type:'object',properties:{}},()=>String(api.signal.aborted),{readOnly:true});api.background(new Promise(resolve=>api.signal.addEventListener('abort',resolve,{once:true})));}`,
  );
  const model = new ScriptedModel(
    Array.from({ length: 3 }, (_, i) => ({
      message: {
        id: String(i),
        role: 'assistant' as const,
        content: 'inspect actual tools',
      },
    })),
  );
  const controller = new RuntimeController({
    home,
    userHome: home,
    workspace,
    model,
    workspaceTools: {
      nodeExecutable: process.execPath,
      runtimeExecutable: process.execPath,
      adapterPath: 'unused',
      ghPath: 'synthetic-never-executed',
    },
    emit: () => {},
  });
  const internal = controller as unknown as {
    runtimes: { values(): Iterable<AgentRuntime> };
    githubProfile: NativeGitHubConnection;
  };
  const runtime = [...internal.runtimes.values()][0]!;
  let release!: () => void;
  let sequence = 0;
  const toggle = (enabled: boolean) =>
    controller.dispatch({
      id: 'toggle-' + ++sequence,
      name: 'save-settings',
      sessionId: runtime.session.id,
      payload: { settings: {}, extensions: [{ name: 'github', enabled }] },
    });
  const state = () =>
    controller
      .snapshot()
      .extensions.find((e) => e.name === 'github' && e.scope === 'bundled');
  try {
    await runtime.harness.run('ordinary turn before enabling');
    const observer = runtime.extensions.extensions.find(
      (e) => e.name === 'observer',
    );
    assert.equal(state()?.enabled, false);
    assert(
      !model.requests[0]!.tools.some((t) => t.name === 'github_connection'),
    );
    const initialStatus = internal.githubProfile.status.bind(
      internal.githubProfile,
    );
    let initialEntered = false;
    let initialRelease!: () => void;
    const initialGate = new Promise<void>((resolve) => {
      initialRelease = resolve;
    });
    release = initialRelease;
    internal.githubProfile.status = async () => {
      initialEntered = true;
      await initialGate;
      return initialStatus();
    };
    const activated = await toggle(true);
    assert.equal(activated.ok, true, JSON.stringify(activated));
    const immediateTurn = runtime.harness.run(
      'ordinary next turn immediately after original toggle',
    );
    await until(async () => (initialEntered ? true : false));
    await delay(20);
    assert.equal(
      model.requests.length,
      1,
      'the current runtime waits for its actual requested provider before the next model request',
    );
    initialRelease();
    await immediateTurn;
    await until(async () =>
      state()?.enabled &&
      (state()?.view as { provider?: string })?.provider === 'github'
        ? true
        : false,
    );
    assert.equal(state()?.error, undefined);
    assert(runtime.extensions.commands().has('github'));
    assert(
      model.requests[1]!.tools.some((t) => t.name === 'github_connection'),
    );
    assert.equal(
      runtime.extensions.extensions.find((e) => e.name === 'observer'),
      observer,
    );
    assert.equal(
      await runtime.extensions
        .tools()
        .find((t) => t.name === 'observer_alive')!
        .run(
          {},
          {
            signal: new AbortController().signal,
            sessionId: runtime.session.id,
          },
        ),
      'false',
    );
    assert.equal((await toggle(false)).ok, true);
    assert.equal(state()?.enabled, false);
    const original = internal.githubProfile.status.bind(internal.githubProfile);
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    internal.githubProfile.status = async () => {
      entered = true;
      await gate;
      return original();
    };
    assert.equal((await toggle(true)).ok, true);
    await until(async () => (entered ? true : false));
    const cancelledTurn = runtime.harness.run(
      'cancel a turn waiting for provider',
    );
    let cancelled = false;
    const rejected = assert
      .rejects(cancelledTurn, /interrupt|abort|cancel/i)
      .then(() => {
        cancelled = true;
      });
    await delay(20);
    assert.equal(model.requests.length, 2);
    const cancelling = runtime.cancel();
    await until(async () => (cancelled ? true : false));
    await cancelling;
    await rejected;
    const turnWhileLoading = runtime.harness.run(
      'ordinary turn waiting for pending enable',
    );
    await delay(20);
    assert.equal(model.requests.length, 2);
    assert.equal((await toggle(false)).ok, true);
    await until(async () => (model.requests.length === 3 ? true : false));
    await turnWhileLoading;
    release();
    await until(async () =>
      state()?.enabled === false &&
      (internal.githubProfile as unknown as { listeners: Set<unknown> })
        .listeners.size === 0
        ? true
        : false,
    );
    assert(!model.requests[2]!.tools.some((t) => t.name.startsWith('github_')));
    assert.equal(
      runtime.extensions.extensions.find((e) => e.name === 'observer'),
      observer,
    );
    assert.equal((await toggle(true)).ok, true);
    await until(async () =>
      state()?.enabled &&
      (state()?.view as { provider?: string })?.provider === 'github'
        ? true
        : false,
    );
    assert.equal(state()?.error, undefined);
    const previousSession = controller.snapshot().activeSessionId;
    const created = await controller.dispatch({
      id: 'new-enabled-session',
      name: 'new-session',
      sessionId: previousSession,
      payload: {},
    });
    assert.equal(created.ok, true);
    assert.notEqual(controller.snapshot().activeSessionId, previousSession);
    await until(async () =>
      state()?.enabled &&
      (state()?.view as { provider?: string })?.provider === 'github'
        ? true
        : false,
    );
    const fresh = [...internal.runtimes.values()].find(
      (owner) => owner.session.id === controller.snapshot().activeSessionId,
    )!;
    assert(fresh.extensions.commands().has('github'));
    assert(
      fresh.extensions
        .tools()
        .some((tool) => tool.name === 'github_connection'),
    );
  } finally {
    release?.();
    await controller.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('one connection startup owns its helper and rejects competing storage choices without changing its grant', async (t) => {
  for (const storage of ['session', 'encrypted'] as const) {
    await t.test(storage, async () => {
      const f = await fixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const login = (f.connection as unknown as { login: DeliveryLogin }).login;
      const original = login.start.bind(login);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      t.mock.method(
        login,
        'start',
        async (options: Parameters<DeliveryLogin['start']>[0]) => {
          const value = await original(options);
          entered();
          await held;
          return value;
        },
      );
      try {
        const first = f.connection.connect({
          storage,
          repositories: ['fixture/first'],
        });
        await started;
        const before = f.connection.snapshot();
        await assert.rejects(
          f.connection.connect({
            storage: storage === 'session' ? 'encrypted' : 'session',
            repositories: ['fixture/second'],
          }),
          /authorization is already starting/,
        );
        assert.deepEqual(f.connection.snapshot(), before);
        assert.equal(f.helpers.length, 1);
        assert.equal(f.helpers[0]!.killed, false);
        release();
        const authorization = await first;
        assert.equal(authorization.storage, storage);
        assert.deepEqual(authorization.repositories, ['fixture/first']);
        f.helpers[0]!.finish();
        const connected = await until(async () => {
          const state = await f.connection.status();
          return state.state === 'connected' ? state : false;
        });
        assert.equal(connected.storage, storage);
        assert.deepEqual(connected.repositories, ['fixture/first']);
        assert.equal(connected.account?.login, 'fixture');
        assert.equal(f.puts, storage === 'encrypted' ? 1 : 0);
      } finally {
        release();
        await f.close();
      }
    });
  }
});

test('cancellation drains a held connection startup and a failed startup releases ownership for a real retry', async (t) => {
  for (const action of ['cancel', 'disconnect'] as const) {
    await t.test(action, async () => {
      const f = await fixture();
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const login = (f.connection as unknown as { login: DeliveryLogin }).login;
      const original = login.start.bind(login);
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      t.mock.method(
        login,
        'start',
        async (options: Parameters<DeliveryLogin['start']>[0]) => {
          const value = await original(options);
          entered();
          await held;
          return value;
        },
      );
      try {
        const first = f.connection.connect({
          storage: 'session',
          repositories: [],
        });
        await started;
        let settled = false;
        const cleanup = f.connection[action](
          f.connection.snapshot().epoch,
        ).then(() => {
          settled = true;
        });
        await delay(10);
        assert.equal(settled, false);
        release();
        const late = await first;
        assert.equal(late.state, 'disconnected');
        assert.equal(late.lastAuthorizationOutcome, 'cancelled-before-code');
        await cleanup;
        assert.equal(f.connection.snapshot().state, 'disconnected');
        assert(f.helpers.every((helper) => helper.killed));
        assert.equal(await login.token(), undefined);
      } finally {
        release();
        await f.close();
      }
    });
  }
  await t.test('startup failure permits retry', async () => {
    const f = await fixture();
    const login = (f.connection as unknown as { login: DeliveryLogin }).login;
    const original = login.start.bind(login);
    let fail = true;
    t.mock.method(
      login,
      'start',
      async (options: Parameters<DeliveryLogin['start']>[0]) => {
        if (fail) {
          fail = false;
          throw Error('synthetic startup failure');
        }
        return original(options);
      },
    );
    try {
      await assert.rejects(
        f.connection.connect({ storage: 'session', repositories: [] }),
        /authorization could not start/,
      );
      assert.equal(f.connection.snapshot().state, 'error');
      const next = await f.connection.connect({
        storage: 'session',
        repositories: ['fixture/retry'],
      });
      assert.equal(next.state, 'authorizing');
      f.helpers[0]!.finish();
      await until(
        async () => (await f.connection.status()).state === 'connected',
      );
      assert.deepEqual(f.connection.snapshot().repositories, ['fixture/retry']);
    } finally {
      await f.close();
    }
  });
});

test('workflow is an explicit additional device scope while granted scopes come only from verified response headers', async (t) => {
  for (const header of [
    undefined,
    'repo, read:org, gist, workflow',
    'repo',
    '',
    TOKEN,
  ] as const) {
    await t.test(
      header === undefined
        ? 'legacy JSON is unknown'
        : header === TOKEN
          ? 'secret-shaped header is not exposed'
          : 'reported ' + header,
      async () => {
        const f = await fixture();
        f.scopeHeader = header;
        try {
          const starting = await f.connection.connect({
            storage: 'session',
            repositories: [],
          });
          assert.deepEqual(starting.requestedAdditionalScopes, ['workflow']);
          assert.equal(starting.scopeVerification, 'not-reported');
          const args = f.helpers[0]!.args;
          assert.equal(args[args.indexOf('--scopes') + 1], 'workflow');
          f.helpers[0]!.finish();
          const state = await until(async () => {
            const s = await f.connection.status();
            return s.state === 'connected' ? s : false;
          });
          assert.equal(state.account?.login, 'fixture');
          assert.deepEqual(f.calls[0]!.args, [
            'api',
            'user',
            '--include',
            '--jq',
            '{login: .login, id: .id}',
          ]);
          const valid = header !== undefined && header !== TOKEN;
          assert.equal(
            state.scopeVerification,
            valid ? 'reported' : 'not-reported',
          );
          assert.deepEqual(
            state.grantedScopes,
            valid
              ? header
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
          );
          assert(!JSON.stringify(state).includes(TOKEN));
          if (header === 'repo')
            assert(
              !state.grantedScopes!.includes('workflow'),
              'a request is never presented as a grant',
            );
          await f.connection.disconnect(state.epoch);
          const disconnected = f.connection.snapshot();
          assert.equal(disconnected.grantedScopes, undefined);
          assert.equal(disconnected.scopeVerification, 'not-reported');
          assert.deepEqual(disconnected.requestedAdditionalScopes, [
            'workflow',
          ]);
        } finally {
          await f.close();
        }
      },
    );
  }
});

test('authorization phases and cancellation outcomes reflect actual code preparation without claiming a remote revocation', async () => {
  const f = await fixture();
  try {
    await f.connection.connect({ storage: 'session', repositories: [] });
    assert.equal(f.connection.snapshot().authorizationPhase, 'preparing-code');
    const cancelled = await f.connection.cancel(f.connection.snapshot().epoch);
    assert.equal(cancelled.lastAuthorizationOutcome, 'cancelled-before-code');
    assert.equal(cancelled.remoteRevocation, 'not-requested');
    assert.equal(cancelled.authorizationPhase, undefined);
    assert(f.helpers[0].killed);
    await f.connection.connect({ storage: 'session', repositories: [] });
    f.helpers[1].emit('First copy your one-time code: ABCD-1234');
    // Cancel before the profile's polling tick: the helper already owns a code.
    const afterCode = await f.connection.cancel(f.connection.snapshot().epoch);
    assert.equal(afterCode.lastAuthorizationOutcome, 'cancelled');
    assert.equal(afterCode.remoteRevocation, 'unconfirmed');
    await f.connection.connect({ storage: 'session', repositories: [] });
    const historical = await f.connection.cancel(f.connection.snapshot().epoch);
    assert.equal(historical.lastAuthorizationOutcome, 'cancelled-before-code');
    assert.equal(historical.remoteRevocation, 'unconfirmed');
    assert(f.helpers.every((helper) => helper.killed));
  } finally {
    await f.close();
  }
});

test('Harness inspects the opaque candidate revision before publishing and rejects stale or foreign candidates without dispatch', async (t) => {
  const f = await fixture();
  let runtime: AgentRuntime | undefined;
  const ledger = await OperationLedger.open({
    directory: path.join(f.root, 'candidate-operations'),
  });
  try {
    const delivery = new DeliveryService(f.workspace, 'synthetic-gh', {
      connection: f.connection,
      spawn: () => {
        throw Error('no separate login');
      },
    });
    await delivery.git.git(['init']);
    await delivery.git.git(['config', 'user.name', 'Fixture']);
    await delivery.git.git(['config', 'user.email', 'fixture@example.invalid']);
    await writeFile(path.join(f.workspace, 'file'), 'base\n');
    await delivery.git.git(['add', '--', 'file']);
    await delivery.git.git(['commit', '-m', 'Base']);
    await delivery.git.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await delivery.git.git(['switch', '-c', 'codex/fixture']);
    await writeFile(path.join(f.workspace, 'file'), 'changed\n');
    await delivery.git.git(['add', '--', 'file']);
    await delivery.git.git(['commit', '-m', 'Feature']);
    await delivery.git.git([
      'remote',
      'add',
      'origin',
      'https://github.com/fixture/repo.git',
    ]);
    const bare = path.join(f.root, 'remote.git');
    await delivery.git.git(['init', '--bare', bare]);
    t.mock.method(f.connection, 'gitPushAuthentication', () => ({
      repository: 'fixture/repo',
      withCredentials: async (
        run: (env: NodeJS.ProcessEnv, config: string[]) => Promise<string>,
      ) =>
        run({ ...process.env, GH_TOKEN: undefined, GITHUB_TOKEN: undefined }, [
          '-c',
          `url.${bare.replaceAll('\\', '/')}.insteadOf=https://github.com/fixture/repo.git`,
        ]),
    }));
    f.head = (await delivery.git.snapshot()).head;
    const backend = githubWorkspaceBackend({
      connection: f.connection,
      delivery: async () => delivery,
      runWrite: (method, params, callId, action) =>
        ledger.run(
          {
            id: callId,
            sessionId: 'candidate-owner',
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
    await backend.call('connect', {
      storage: 'session',
      repositories: ['fixture/repo'],
    });
    f.helpers[0].finish();
    const connected = await until(async () => {
      const s = await backend.call('status', {});
      return s.state === 'connected' ? s : false;
    });
    let inspected:
      Awaited<ReturnType<typeof backend.call<'candidate'>>> | undefined;
    const model = new ScriptedModel([
      {
        message: {
          id: 'inspect',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'inspect-candidate',
              name: 'github_candidate',
              args: { epoch: connected.epoch, repository: 'fixture/repo' },
            },
          ],
        },
      },
      async (request) => {
        const message = request.messages.find(
          (m) => m.tool_call_id === 'inspect-candidate',
        );
        assert(message && message.status !== 'error', message?.content);
        inspected = JSON.parse(message.content);
        assert(inspected);
        assert.notEqual(inspected.revision, inspected.head);
        assert.deepEqual(inspected.paths, ['file']);
        assert.equal(inspected.base, 'origin/main');
        assert.equal(inspected.publishable, true);
        return {
          message: {
            id: 'publish',
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'publish-inspected',
                name: 'github_publish',
                args: {
                  epoch: connected.epoch,
                  repository: 'fixture/repo',
                  head: inspected.head,
                  branch: inspected.branch,
                  revision: inspected.revision,
                  paths: inspected.paths,
                  title: 'Fixture',
                  body: 'Fixture',
                },
              },
            ],
          },
          usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
        };
      },
      { message: { id: 'done', role: 'assistant', content: 'done' } },
    ]);
    const settings = trustFolder(defaultSettings(), f.workspace);
    settings.extensions.github = { enabled: true };
    runtime = new AgentRuntime({
      home: path.join(f.root, 'candidate-home'),
      workspace: f.workspace,
      settings,
      model,
      githubConnection: backend,
      bundledExtensions: fileURLToPath(
        new URL('../../../src/extensions', import.meta.url),
      ),
    });
    runtime.policy.setYolo(runtime.session.id, true);
    await runtime.harness.run('inspect then publish the reviewed candidate');
    assert(
      model.requests[0].tools.some(
        (tool) => tool.name === 'github_candidate' && tool.effect === 'read',
      ),
    );
    assert.equal(
      ledger.list().find((x) => x.id === 'publish-inspected')?.state,
      'completed',
    );
    assert.equal(
      (
        await delivery.git.git([
          '--git-dir',
          bare,
          'rev-parse',
          'refs/heads/codex/fixture',
        ])
      ).trim(),
      inspected?.head,
    );
    const beforeCalls = f.calls.length;
    assert(inspected);
    for (const [id, head, revision] of [
      ['sha-is-not-revision', inspected.head, inspected.head],
      ['old-head', '0'.repeat(40), inspected.revision],
    ]) {
      await assert.rejects(
        backend.call(
          'publish',
          {
            epoch: connected.epoch,
            repository: 'fixture/repo',
            head,
            revision,
            branch: inspected.branch,
            paths: inspected.paths,
            title: 'Fixture',
            body: 'Fixture',
          },
          { signal: new AbortController().signal, callId: id },
        ),
        /read github_candidate/,
      );
      assert.equal(ledger.list().find((x) => x.id === id)?.state, 'rejected');
    }
    const foreignRoot = path.join(f.root, 'foreign-owner');
    await mkdir(foreignRoot);
    const foreignDelivery = new DeliveryService(foreignRoot, 'synthetic-gh');
    await foreignDelivery.git.git(['init']);
    await foreignDelivery.git.git([
      'remote',
      'add',
      'origin',
      'https://github.com/fixture/foreign.git',
    ]);
    const foreignBackend = githubWorkspaceBackend({
      connection: f.connection,
      delivery: async () => foreignDelivery,
    });
    const releaseForeign = foreignBackend.subscribe(() => {});
    try {
      await assert.rejects(
        foreignBackend.call('candidate', {
          epoch: connected.epoch,
          repository: 'fixture/repo',
        }),
        /trusted workspace remote/,
      );
    } finally {
      releaseForeign();
    }
    await writeFile(path.join(f.workspace, 'file'), 'later manual edit\n');
    await assert.rejects(
      backend.call(
        'publish',
        {
          epoch: connected.epoch,
          repository: 'fixture/repo',
          head: inspected.head,
          branch: inspected.branch,
          revision: inspected.revision,
          paths: inspected.paths,
          title: 'Fixture',
          body: 'Fixture',
        },
        { signal: new AbortController().signal, callId: 'stale-inspected' },
      ),
      /read github_candidate/,
    );
    assert.equal(
      ledger.list().find((x) => x.id === 'stale-inspected')?.state,
      'rejected',
    );
    assert.equal(f.calls.length, beforeCalls);
    assert.equal(
      (
        await backend.call('candidate', {
          epoch: connected.epoch,
          repository: 'fixture/repo',
        })
      ).dirty,
      true,
    );
    await assert.rejects(
      backend.call('candidate', {
        epoch: connected.epoch,
        repository: 'fixture/foreign',
      }),
      /permission|repository/,
    );
    assert.equal(f.calls.length, beforeCalls);
    release();
  } finally {
    await runtime?.close();
    await ledger.close();
    await f.close();
  }
});

test('cancelling held account verification aborts only that attempt and a fresh login progresses before its stale reply', async (t) => {
  const f = await fixture();
  let releaseOld!: () => void, releaseNew!: () => void;
  const oldGate = new Promise<void>((resolve) => (releaseOld = resolve)),
    newGate = new Promise<void>((resolve) => (releaseNew = resolve));
  const signals: AbortSignal[] = [];
  const internal = f.connection as unknown as {
    command: (
      args: string[],
      env: NodeJS.ProcessEnv,
      cwd: string,
      signal: AbortSignal,
    ) => Promise<string>;
    poll: () => Promise<void>;
    attempt?: { id: string };
    login: DeliveryLogin;
  };
  t.mock.method(
    internal,
    'command',
    async (
      _args: string[],
      _env: NodeJS.ProcessEnv,
      _cwd: string,
      signal: AbortSignal,
    ) => {
      signals.push(signal);
      const number = signals.length;
      // Deliberately ignore abort to simulate a late reply from an uncooperative transport.
      await (number === 1 ? oldGate : newGate);
      return JSON.stringify({
        login: number === 1 ? 'stale-account' : 'fresh-account',
        id: number,
      });
    },
  );
  const helperComplete = async (index: number) => {
    f.helpers[index].finish();
    await until(async () =>
      internal.attempt &&
      internal.login.poll(internal.attempt.id).status === 'complete'
        ? true
        : false,
    );
  };
  try {
    await f.connection.connect({ storage: 'session', repositories: [] });
    await helperComplete(0);
    const oldPoll = internal.poll();
    await until(async () => (signals.length === 1 ? true : false));
    let cancelCompleted = false;
    const cancelling = f.connection
      .cancel(f.connection.snapshot().epoch)
      .then(() => {
        cancelCompleted = true;
      });
    await until(async () =>
      f.connection.snapshot().state === 'disconnected' ? true : false,
    );
    assert.equal(
      signals[0].aborted,
      true,
      'cancel must abort the verification transport',
    );
    assert.equal(f.connection.snapshot().state, 'disconnected');
    await f.connection.connect({ storage: 'session', repositories: [] });
    await helperComplete(1);
    const newPoll = internal.poll();
    await until(async () => (signals.length === 2 ? true : false));
    assert.equal(
      signals[1].aborted,
      false,
      'old cancellation must not abort the fresh attempt',
    );
    assert.equal(
      cancelCompleted,
      false,
      'cancellation waits for its captured old transport completion',
    );
    releaseOld();
    await oldPoll;
    await cancelling;
    assert.equal(f.connection.snapshot().state, 'authorizing');
    await internal.poll();
    assert.equal(
      signals.length,
      2,
      'stale finally must not clear fresh polling ownership',
    );
    releaseNew();
    await newPoll;
    assert.equal(f.connection.snapshot().account?.login, 'fresh-account');
    assert.equal(f.connection.snapshot().state, 'connected');
  } finally {
    releaseOld();
    releaseNew();
    await f.close();
  }
});

test('an old cancellation cleanup failure reports to its caller without overwriting a fresh connected account', async (t) => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const internal = f.connection as unknown as {
    command: (
      args: string[],
      env: NodeJS.ProcessEnv,
      cwd: string,
      signal?: AbortSignal,
    ) => Promise<string>;
    poll: () => Promise<void>;
    attempt?: { id: string };
    login: DeliveryLogin;
  };
  let calls = 0;
  t.mock.method(internal, 'command', async () => {
    const n = ++calls;
    if (n === 1) await gate;
    return JSON.stringify({
      login: n === 1 ? 'old-account' : 'fresh-account',
      id: n,
    });
  });
  const original = internal.login.disconnect.bind(internal.login);
  let failCleanup = true;
  t.mock.method(internal.login, 'disconnect', async () => {
    if (failCleanup) {
      failCleanup = false;
      throw Error('synthetic-old-cleanup-failure');
    }
    await original();
  });
  const complete = async (index: number) => {
    f.helpers[index].finish();
    await until(async () =>
      internal.attempt &&
      internal.login.poll(internal.attempt.id).status === 'complete'
        ? true
        : false,
    );
  };
  try {
    await f.connection.connect({ storage: 'session', repositories: [] });
    await complete(0);
    const oldPoll = internal.poll();
    await until(async () => (calls === 1 ? true : false));
    const cancelling = f.connection.cancel(f.connection.snapshot().epoch);
    cancelling.catch(() => {});
    await until(async () =>
      f.connection.snapshot().state === 'disconnected' ? true : false,
    );
    await f.connection.connect({ storage: 'session', repositories: [] });
    await complete(1);
    await internal.poll();
    assert.equal(f.connection.snapshot().account?.login, 'fresh-account');
    release();
    await oldPoll;
    const callerError = await cancelling.then(
      () => '',
      (error) => String(error),
    );
    assert.equal(f.connection.snapshot().state, 'connected');
    assert.equal(f.connection.snapshot().account?.login, 'fresh-account');
    assert.equal(
      f.connection.snapshot().error,
      undefined,
      'late old cleanup must not overwrite the fresh account status',
    );
    assert.match(
      callerError,
      /cancellation cleanup requires attention.*current connection was not changed/,
    );
  } finally {
    release();
    await f.close();
  }
});

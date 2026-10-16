import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, access, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const bundledGh =
  process.env.CIRCLE_TEST_BUNDLED_GH ??
  fileURLToPath(
    new URL(
      `../dist/tools/gh/bin/${process.platform === 'win32' ? 'gh.exe' : 'gh'}`,
      import.meta.url,
    ),
  );
import { withGitHubPushCredentials } from '../src/workspace/git-push-auth.ts';
import { GitWorkspaceService } from '../src/workspace/git.ts';
const TOKEN = 'synthetic-owned-gh-push-grant';
function git(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  input?: string,
) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      'git',
      args,
      { env, cwd, encoding: 'utf8' },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    child.stdin?.end(input);
  });
}
test('owned gh credential helper serves only the exact HTTPS repository and cleans private helpers without writing Git configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-private-push-'));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GH_CONFIG_DIR: root,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
  };
  try {
    await git(['init'], env, root);
    const marker = path.join(root, 'untrusted-helper-ran');
    const unwantedHelper = path.join(root, 'untrusted-helper.cjs');
    await writeFile(
      unwantedHelper,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called')`,
    );
    await git(
      [
        'config',
        'credential.helper',
        `!\"${process.execPath}\" \"${unwantedHelper}\"`,
      ],
      env,
      root,
    );
    const before = await readFile(path.join(root, '.git', 'config'));
    let privateDirectory = '';
    await withGitHubPushCredentials(
      {
        repository: 'fixture/repo',
        token: TOKEN,
        ghPath: bundledGh,
        env,
        assertActive() {},
      },
      async (childEnv, config) => {
        privateDirectory = config
          .find((value) => value.startsWith('core.hooksPath='))!
          .slice('core.hooksPath='.length);
        assert.equal(childEnv.GH_TOKEN, TOKEN);
        assert(
          !(
            await readFile(
              path.join(privateDirectory, 'credential.cjs'),
              'utf8',
            )
          ).includes(TOKEN),
        );
        assert.equal(await readFile(childEnv.GIT_CONFIG_GLOBAL!, 'utf8'), '');
        assert(!config.join(' ').includes(TOKEN));
        const credentials = await git(
          [...config, 'credential', 'fill'],
          childEnv,
          root,
          'protocol=https\nhost=github.com\npath=fixture/repo.git\n\n',
        );
        assert(credentials.includes('password=' + TOKEN));
        for (const input of [
          'protocol=http\nhost=github.com\npath=fixture/repo\n\n',
          'protocol=https\nhost=evil.example\npath=fixture/repo\n\n',
          'protocol=https\nhost=github.com\npath=fixture/other\n\n',
        ])
          await assert.rejects(
            git([...config, 'credential', 'fill'], childEnv, root, input),
          );
        return 'complete';
      },
    );
    await assert.rejects(access(privateDirectory));
    await assert.rejects(access(marker));
    assert.deepEqual(await readFile(path.join(root, '.git', 'config')), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('actual Git HTTP 401 challenge cannot borrow an owned GitHub grant for another host', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-push-challenge-'));
  const headers: (string | undefined)[] = [];
  let redirected = 0;
  const server = createServer((req, res) => {
    headers.push(req.headers.authorization);
    if (req.url?.startsWith('/redirect/')) {
      res.writeHead(302, { Location: '/unexpected-target' });
      res.end();
      return;
    }
    if (req.url?.startsWith('/unexpected-target')) redirected++;
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="owned-fixture"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GH_CONFIG_DIR: root,
    GH_HOST: 'github.com',
  };
  try {
    await writeFile(
      path.join(root, process.platform === 'win32' ? '_netrc' : '.netrc'),
      'machine 127.0.0.1 login fixture-host password synthetic-host-cache',
      { mode: 0o600 },
    );
    await assert.rejects(
      withGitHubPushCredentials(
        {
          repository: 'fixture/repo',
          token: TOKEN,
          ghPath: bundledGh,
          env,
          assertActive() {},
        },
        async (childEnv, config) => {
          // Allow HTTP only for this transport negative control. The production
          // configuration is HTTPS-only and the helper still rejects this host.
          return git(
            [
              ...config,
              '-c',
              'protocol.http.allow=always',
              'ls-remote',
              `http://127.0.0.1:${address.port}/fixture/repo`,
            ],
            childEnv,
            root,
          );
        },
      ),
      /GitHub push failed/,
    );
    await assert.rejects(
      withGitHubPushCredentials(
        {
          repository: 'fixture/repo',
          token: TOKEN,
          ghPath: bundledGh,
          env,
          assertActive() {},
        },
        async (childEnv, config) =>
          git(
            [
              ...config,
              '-c',
              'protocol.http.allow=always',
              'ls-remote',
              `http://127.0.0.1:${address.port}/redirect/repo`,
            ],
            childEnv,
            root,
          ),
      ),
      /GitHub push failed/,
    );
    assert.equal(redirected, 0);
    assert(headers.length > 0);
    assert(headers.every((value) => value === undefined));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
test('authenticated Git push rejects unapproved or multiple actual push destinations before obtaining a grant', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-push-dest-'));
  const env = { ...process.env, HOME: root, USERPROFILE: root };
  try {
    await git(['init'], env, root);
    await git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Seed',
      ],
      env,
      root,
    );
    await git(
      ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git'],
      env,
      root,
    );
    const service = new GitWorkspaceService(root);
    let grants = 0;
    const invocation = {
      pushAuthentication: {
        repository: 'fixture/repo',
        withCredentials: async () => {
          grants++;
          return '';
        },
      },
    };
    await git(
      [
        'config',
        'remote.origin.pushurl',
        'https://evil.example/fixture/repo.git',
      ],
      env,
      root,
    );
    await assert.rejects(
      service.call(
        'push',
        { revision: (await service.snapshot()).revision },
        invocation,
      ),
      /destination does not match/,
    );
    await git(
      [
        'config',
        '--add',
        'remote.origin.pushurl',
        'https://github.com/fixture/repo.git',
      ],
      env,
      root,
    );
    await assert.rejects(
      service.call(
        'push',
        { revision: (await service.snapshot()).revision },
        invocation,
      ),
      /destination does not match/,
    );
    assert.equal(grants, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('private credential context strips injected command and tracing settings and cleans up after cancellation', async () => {
  let callbackCount = 0;
  let directory = '';
  const controller = new AbortController();
  const env = {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '!untrusted',
    GIT_TRACE: '1',
    GIT_CURL_VERBOSE: '1',
    GIT_ASKPASS: 'untrusted',
    NODE_OPTIONS: '--require=untrusted',
    Gh_Token: 'untrusted-alias',
    GH_DEBUG: 'api',
  };
  await assert.rejects(
    withGitHubPushCredentials(
      {
        repository: 'fixture/repo',
        token: TOKEN,
        ghPath: 'not-executed',
        env,
        signal: controller.signal,
        assertActive() {},
      },
      async (childEnv, config) => {
        callbackCount++;
        directory = config
          .find((value) => value.startsWith('core.hooksPath='))!
          .slice('core.hooksPath='.length);
        for (const key of [
          'GIT_CONFIG_COUNT',
          'GIT_CONFIG_KEY_0',
          'GIT_CONFIG_VALUE_0',
          'GIT_TRACE',
          'GIT_CURL_VERBOSE',
          'NODE_OPTIONS',
          'Gh_Token',
          'GH_DEBUG',
        ])
          assert.equal(childEnv[key], undefined);
        assert.equal(childEnv.GIT_ASKPASS, 'false');
        controller.abort();
        return TOKEN;
      },
    ),
    /cancelled/,
  );
  assert.equal(callbackCount, 1);
  await assert.rejects(access(directory));
  await assert.rejects(
    withGitHubPushCredentials(
      {
        repository: 'fixture/repo',
        token: TOKEN,
        ghPath: 'not-executed',
        env,
        signal: controller.signal,
        assertActive() {},
      },
      async () => {
        callbackCount++;
        return '';
      },
    ),
  );
  assert.equal(callbackCount, 1);
});

test('private push configuration suppresses repository push signing programs while a real nonce-advertising bare remote receives the branch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-push-signing-'));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GIT_TERMINAL_PROMPT: '0',
  };
  const remote = path.join(root, 'remote.git');
  try {
    await git(['init'], env, root);
    await git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Seed',
      ],
      env,
      root,
    );
    await git(['init', '--bare', remote], env, root);
    await git(
      [
        '--git-dir',
        remote,
        'config',
        'receive.certNonceSeed',
        'synthetic-nonce',
      ],
      env,
      root,
    );
    await git(['config', 'push.gpgSign', 'true'], env, root);
    await git(['config', 'gpg.program', process.execPath], env, root);
    await git(['config', 'user.signingKey', 'fixture'], env, root);
    // Node is deliberately not a GPG signer. A nonce-advertising remote makes
    // unguarded Git actually attempt that configured external program.
    await assert.rejects(
      git(['push', remote, 'HEAD:refs/heads/accepted'], env, root),
      /signed push|gpg|sign/i,
    );
    await withGitHubPushCredentials(
      {
        repository: 'fixture/repo',
        token: TOKEN,
        ghPath: bundledGh,
        env,
        assertActive() {},
      },
      async (childEnv, config) => {
        assert(config.includes('push.gpgSign=false'));
        return git(
          [
            ...config,
            '-c',
            'protocol.file.allow=always',
            'push',
            remote,
            'HEAD:refs/heads/accepted',
          ],
          childEnv,
          root,
        );
      },
    );
    assert.equal(
      (
        await git(
          ['--git-dir', remote, 'rev-parse', 'refs/heads/accepted'],
          env,
          root,
        )
      ).trim(),
      (await git(['rev-parse', 'HEAD'], env, root)).trim(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('credential waits recheck the accepted candidate and authenticated pushes cannot overwrite a diverged remote', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-push-candidate-'));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GIT_TERMINAL_PROMPT: '0',
  };
  const remote = path.join(root, 'remote.git');
  const url = 'https://github.com/fixture/repo.git';
  try {
    await git(['init'], env, root);
    await git(['checkout', '-b', 'codex/accepted'], env, root);
    await git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Accepted',
      ],
      env,
      root,
    );
    await git(['init', '--bare', remote], env, root);
    await git(['remote', 'add', 'origin', url], env, root);
    const service = new GitWorkspaceService(root);
    const accepted = await service.snapshot();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    // Trusted fixture transport only: actual Git still pushes to the owned bare
    // repository, with no token and without relaxing production URL guards.
    const authentication = {
      repository: 'fixture/repo',
      withCredentials: async (
        run: (env: NodeJS.ProcessEnv, config: string[]) => Promise<string>,
      ) => {
        entered();
        await held;
        return run(env, [
          '-c',
          `url.${remote.replaceAll('\\', '/')}.insteadOf=${url}`,
        ]);
      },
    };
    const pushing = service.call(
      'push',
      { revision: accepted.revision },
      { pushAuthentication: authentication },
    );
    const rejected = assert.rejects(
      pushing,
      /repository changed while authorizing/,
    );
    await preparing;
    await git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Unreviewed',
      ],
      env,
      root,
    );
    release();
    await rejected;
    await assert.rejects(
      git(
        ['--git-dir', remote, 'rev-parse', 'refs/heads/codex/accepted'],
        env,
        root,
      ),
    );
    const fresh = await service.snapshot();
    await service.call(
      'push',
      { revision: fresh.revision },
      { pushAuthentication: authentication },
    );
    assert.equal(
      (
        await git(
          ['--git-dir', remote, 'rev-parse', 'refs/heads/codex/accepted'],
          env,
          root,
        )
      ).trim(),
      fresh.head,
    );
    // Advance only the remote to a distinct commit with the same parent, then
    // prove a fresh explicit candidate push remains non-force.
    const tree = (await git(['rev-parse', 'HEAD^{tree}'], env, root)).trim();
    const competing = (
      await git(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit-tree',
          tree,
          '-p',
          fresh.head,
          '-m',
          'Remote work',
        ],
        env,
        root,
      )
    ).trim();
    await git(
      ['push', remote, `${competing}:refs/heads/codex/accepted`],
      env,
      root,
    );
    await assert.rejects(
      service.call(
        'push',
        { revision: (await service.snapshot()).revision },
        { pushAuthentication: authentication },
      ),
      /rejected|non-fast-forward|fetch first/i,
    );
    assert.equal(
      (
        await git(
          ['--git-dir', remote, 'rev-parse', 'refs/heads/codex/accepted'],
          env,
          root,
        )
      ).trim(),
      competing,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('repository HTTP credentials are an actual transport override and authenticated service pushes reject them before obtaining a grant', async () => {
  const root = await mkdtemp(
    path.join(tmpdir(), 'circle-push-http-overrides-'),
  );
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    GIT_TERMINAL_PROMPT: '0',
  };
  let marker = false;
  const server = createServer((req, res) => {
    marker ||= req.headers.authorization === 'synthetic-repository-header';
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    await git(['init'], env, root);
    await git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Seed',
      ],
      env,
      root,
    );
    await git(
      ['remote', 'add', 'origin', 'https://github.com/fixture/repo.git'],
      env,
      root,
    );
    await git(
      [
        'config',
        'http.extraHeader',
        'Authorization: synthetic-repository-header',
      ],
      env,
      root,
    );
    await assert.rejects(
      git(['ls-remote', `http://127.0.0.1:${port}/repo`], env, root),
    );
    assert.equal(
      marker,
      true,
      'real Git used the repository header without asking the owned helper',
    );
    await git(['config', '--unset', 'http.extraHeader'], env, root);
    const service = new GitWorkspaceService(root);
    let grants = 0;
    const invocation = {
      pushAuthentication: {
        repository: 'fixture/repo',
        withCredentials: async () => {
          grants++;
          return '';
        },
      },
    };
    for (const key of [
      'http.extraHeader',
      'http.https://github.com/fixture/repo.git.extraHeader',
      'http.cookieFile',
      'http.sslCert',
      'http.sslKey',
    ]) {
      await git(['config', key, 'synthetic-only'], env, root);
      await assert.rejects(
        service.call(
          'push',
          { revision: (await service.snapshot()).revision },
          invocation,
        ),
        /remove repository HTTP credential overrides/,
      );
      await git(['config', '--unset', key], env, root);
    }
    assert.equal(grants, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

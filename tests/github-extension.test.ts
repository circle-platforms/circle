import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ExtensionHost } from '../src/extensions.js';
import type {
  GitHubConnectionBackend,
  GitHubConnectionState,
} from '../src/github_connection.js';
const state: GitHubConnectionState = {
  provider: 'github',
  client: 'GitHub CLI',
  epoch: 1,
  state: 'connected',
  account: { login: 'fixture', id: 1 },
  repositories: ['fixture/repo'],
  storage: 'session',
  remoteRevocation: 'not-requested',
};
test('native GitHub capability is withheld from project shadow and symlinked bundled entry, and CLI registers no fake tools', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-github-extension-'));
  const hosts: ExtensionHost[] = [];
  let calls = 0;
  const backend = {
    call: async () => {
      calls++;
      return state;
    },
    subscribe: () => () => {},
  } as GitHubConnectionBackend;
  try {
    const bundled = path.join(root, 'bundled'),
      workspace = path.join(root, 'workspace'),
      home = path.join(root, 'home');
    await mkdir(path.join(bundled, 'github'), { recursive: true });
    await mkdir(path.join(workspace, '.circle', 'extensions', 'github'), {
      recursive: true,
    });
    await mkdir(home);
    const marker = path.join(root, 'capability.json');
    const probe = `import{writeFileSync}from'node:fs';export function register(api){writeFileSync(${JSON.stringify(marker)},JSON.stringify({native:!!api.githubConnection}));}`;
    await writeFile(path.join(bundled, 'github', 'extension.ts'), probe);
    await writeFile(
      path.join(workspace, '.circle', 'extensions', 'github', 'extension.mjs'),
      probe,
    );
    const shadow = new ExtensionHost({
      home,
      workspace,
      trusted: true,
      bundledRoot: bundled,
      settings: { github: { enabled: true } },
      githubConnection: backend,
    });
    hosts.push(shadow);
    await shadow.load();
    assert.equal(
      shadow.extensions.find((ext) => ext.name === 'github')?.source,
      'project',
    );
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
      native: false,
    });
    assert.equal(calls, 0);
    await shadow.close();
    await rm(path.join(workspace, '.circle'), { recursive: true, force: true });
    await rm(path.join(bundled, 'github', 'extension.ts'));
    if (process.platform !== 'win32') {
      const external = path.join(root, 'external.ts');
      await writeFile(external, probe);
      await symlink(external, path.join(bundled, 'github', 'extension.ts'));
      const redirected = new ExtensionHost({
        home,
        workspace,
        trusted: true,
        bundledRoot: bundled,
        settings: { github: { enabled: true } },
        githubConnection: backend,
      });
      hosts.push(redirected);
      await redirected.load();
      assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
        native: false,
      });
      assert.equal(calls, 0);
      await redirected.close();
    }
    const cli = new ExtensionHost({
      home,
      workspace,
      trusted: true,
      bundledRoot: path.resolve('src/extensions'),
      settings: { github: { enabled: true } },
    });
    hosts.push(cli);
    await cli.load();
    assert.equal(
      cli.extensions.find((ext) => ext.name === 'github')?.error,
      '',
    );
    assert(!cli.tools().some((tool) => tool.name.startsWith('github_')));
    assert(cli.commands().has('github'));
  } finally {
    for (const host of hosts) await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

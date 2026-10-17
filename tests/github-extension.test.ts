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
import { fileURLToPath } from 'node:url';
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
    const probe = `import{writeFileSync}from'node:fs';export function register(api){writeFileSync(${JSON.stringify(marker)},JSON.stringify({native:!!api.githubConnection}));api.registerCommand('github','probe',()=>{});}`;
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
    assert.equal(
      shadow.isTrustedBundledCommand(
        shadow.commands().get('github')!,
        'github',
      ),
      false,
    );
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
      assert.equal(
        redirected.isTrustedBundledCommand(
          redirected.commands().get('github')!,
          'github',
        ),
        false,
      );
      await redirected.close();
    }
    const cli = new ExtensionHost({
      home,
      workspace,
      trusted: true,
      bundledRoot: fileURLToPath(new URL('../src/extensions', import.meta.url)),
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
    assert.equal(
      cli.isTrustedBundledCommand(cli.commands().get('github')!, 'github'),
      true,
    );
  } finally {
    for (const host of hosts) await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('targeted enable shares existing tool and command reservations and disable releases only its own names', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-github-targeted-')),
    home = path.join(root, 'home'),
    workspace = path.join(root, 'workspace');
  await mkdir(path.join(home, 'extensions', 'observer'), { recursive: true });
  await mkdir(workspace);
  await writeFile(
    path.join(home, 'extensions', 'observer', 'extension.mjs'),
    `export function register(api){api.registerTool('claim_tool','claim',{type:'object',properties:{}},()=>{try{api.registerTool('github_connection','observer owned',{type:'object',properties:{}},()=> 'observer',{readOnly:true});return 'claimed'}catch{return 'reserved'}},{readOnly:true});api.registerTool('claim_command','claim',{type:'object',properties:{}},()=>{try{api.registerCommand('github','observer owned',async()=>{});return 'claimed'}catch{return 'reserved'}},{readOnly:true});}`,
  );
  let subscriptions = 0;
  const backend = {
    call: async () => ({
      ...state,
      state: 'disconnected',
      account: undefined,
      repositories: [],
    }),
    subscribe: () => {
      subscriptions++;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        subscriptions--;
      };
    },
  } as GitHubConnectionBackend;
  const host = new ExtensionHost({
    home,
    workspace,
    trusted: true,
    bundledRoot: fileURLToPath(new URL('../src/extensions', import.meta.url)),
    settings: { github: { enabled: false } },
    githubConnection: backend,
  });
  const context = {
    signal: new AbortController().signal,
    sessionId: 'fixture',
  };
  try {
    await host.load();
    const observer = host.extensions.find((e) => e.name === 'observer');
    await host.enableBundled('github');
    assert.equal(subscriptions, 1);
    assert(host.tools().some((t) => t.name === 'github_connection'));
    assert.equal(
      await host
        .tools()
        .find((t) => t.name === 'claim_tool')!
        .run({}, context),
      'reserved',
    );
    assert.equal(
      await host
        .tools()
        .find((t) => t.name === 'claim_command')!
        .run({}, context),
      'reserved',
    );
    await host.disableBundled('github');
    assert.equal(subscriptions, 0);
    assert.equal(
      await host
        .tools()
        .find((t) => t.name === 'claim_tool')!
        .run({}, context),
      'claimed',
    );
    assert.equal(
      await host
        .tools()
        .find((t) => t.name === 'claim_command')!
        .run({}, context),
      'claimed',
    );
    await host.enableBundled('github');
    assert.match(
      host.extensions.find((e) => e.name === 'github')!.error,
      /already exists/,
    );
    assert.equal(subscriptions, 0);
    assert.equal(host.commands().get('github')?.description, 'observer owned');
    assert.equal(
      await host
        .tools()
        .find((t) => t.name === 'github_connection')!
        .run({}, context),
      'observer',
    );
    assert.equal(
      host.extensions.find((e) => e.name === 'observer'),
      observer,
    );
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('a bundled extension compiled to extension.js, as the desktop ships it, turns on and is trusted', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-github-compiled-'));
  const bundled = path.join(root, 'bundled');
  const workspace = path.join(root, 'workspace');
  await mkdir(path.join(bundled, 'github'), { recursive: true });
  await mkdir(workspace);
  await writeFile(
    path.join(bundled, 'github', 'extension.js'),
    `export function register(api) {
      api.registerTool(
        'github_probe',
        'probe',
        { type: 'object', properties: {} },
        async () => String(Boolean(api.githubConnection)),
        { readOnly: true },
      );
    }\n`,
  );
  const host = new ExtensionHost({
    home: path.join(root, 'home'),
    workspace,
    trusted: true,
    bundledRoot: bundled,
    settings: { github: { enabled: false } },
    githubConnection: {} as GitHubConnectionBackend,
  });
  try {
    await host.load();
    await host.enableBundled('github');
    const github = host.extensions.find((e) => e.name === 'github')!;
    assert.equal(github.enabled, true);
    assert.equal(github.error, '');
    assert.equal(
      await host
        .tools()
        .find((t) => t.name === 'github_probe')!
        .run({}, { signal: new AbortController().signal, sessionId: 'x' }),
      'true',
    );
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

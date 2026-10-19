import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import type { TerminalSnapshot } from '../src/workspace/terminal.ts';
test('bundled npm launches nested npm and a real HTTP service with only system PATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-bundled-npm-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-bundled-npm-data-'));
  const runtime = fileURLToPath(
    new URL(
      '../dist/tools/node/bin/' +
        (process.platform === 'win32' ? 'node.exe' : 'node'),
      import.meta.url,
    ),
  );
  const runtimeReal = await realpath(runtime);
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  const systemPath =
    process.platform === 'win32'
      ? [
          path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
          process.env.SystemRoot ?? 'C:\\Windows',
        ].join(path.delimiter)
      : '/usr/bin:/bin:/usr/sbin:/sbin';
  const originalPath = process.env.PATH;
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    runtimeExecutable: runtime,
    ghPath: 'unused',
    terminalEnv: {
      PATH: systemPath,
      HOME: root,
      USERPROFILE: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      NPM_CONFIG_AUDIT: 'false',
    },
    emit: () => {},
  });
  try {
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: { dev: 'npm run serve', serve: 'node server.cjs' },
      }),
    );
    await writeFile(
      path.join(root, 'server.cjs'),
      `require('http').createServer((q,s)=>s.end(JSON.stringify({execPath:require('fs').realpathSync(process.execPath),version:process.version}))).listen(${port},'127.0.0.1',()=>console.log('NESTED_READY'))`,
    );
    // On Windows the outer CLI is invoked through Node argv; npm itself uses the standard cmd.exe script shell to resolve the inner npm.cmd.
    const command =
      process.platform === 'win32'
        ? {
            file: runtime,
            args: [
              path.resolve(
                path.dirname(runtime),
                '../lib/node_modules/npm/bin/npm-cli.js',
              ),
              'run',
              'dev',
            ],
          }
        : { file: 'npm', args: ['run', 'dev'] };
    const started = (await service.call('npm-session', 'terminal', 'create', {
      command,
      readiness: { pattern: 'NESTED_READY', port, timeoutMs: 15000 },
    })) as TerminalSnapshot;
    let ready = false;
    for (let i = 0; i < 750; i++) {
      const entries = (await service.call(
        'npm-session',
        'terminal',
        'list',
      )) as TerminalSnapshot[];
      const current = entries.find((entry) => entry.id === started.id);
      if (current?.readiness?.state === 'ready') {
        ready = true;
        break;
      }
      if (current?.status === 'failed' || current?.status === 'exited')
        throw Error(
          'nested npm exited before readiness: ' + JSON.stringify(current),
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(ready, true);
    const result = (await (await fetch(`http://127.0.0.1:${port}`)).json()) as {
      execPath: string;
      version: string;
    };
    assert.equal(result.execPath, runtimeReal);
    assert.equal(process.env.PATH, originalPath);
    await service.releaseSession('npm-session');
    assert.throws(() => process.kill(started.pid!, 0));
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

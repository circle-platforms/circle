import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceServices } from '../src/workspace/workspace-services.ts';
import type { TerminalSnapshot } from '../src/workspace/terminal.ts';
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('no port');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}
test('workspace service command preserves argv, reaches real readiness and restarts with owned lifetime', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-service-route-'));
  const data = await mkdtemp(path.join(tmpdir(), 'circle-service-route-data-'));
  const port = await freePort();
  const service = new WorkspaceServices({
    workspaceRoot: root,
    dataDir: data,
    runtimeExecutable: process.execPath,
    ghPath: 'unused',
    terminalEnv: {
      HOME: root,
      ZDOTDIR: root,
      HISTFILE: path.join(root, '.history'),
      ENV: '',
      BASH_ENV: '',
    },
    emit: () => {},
  });
  try {
    const marker = "literal spaces '$()'";
    const script =
      "require('http').createServer((q,s)=>s.end(process.argv[1])).listen(" +
      port +
      ",'127.0.0.1',()=>console.log('SERVICE_READY'))";
    let terminal = (await service.call('a', 'terminal', 'create', {
      command: { file: process.execPath, args: ['-e', script, marker] },
      readiness: { pattern: 'SERVICE_READY', port, timeoutMs: 5000 },
    })) as TerminalSnapshot;
    const original = terminal;
    async function ready(id: string) {
      for (let i = 0; i < 250; i++) {
        const all = (await service.call(
          'a',
          'terminal',
          'list',
        )) as TerminalSnapshot[];
        const target = all.find((t) => t.id === id);
        if (target?.readiness?.state === 'ready') return target;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw Error('service did not become ready');
    }
    terminal = await ready(terminal.id);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      marker,
    );
    terminal = (await service.call('a', 'terminal', 'restart', {
      id: terminal.id,
    })) as TerminalSnapshot;
    assert.notEqual(terminal.id, original.id);
    assert.notEqual(terminal.epoch, original.epoch);
    assert.equal(terminal.serviceId, original.serviceId);
    terminal = await ready(terminal.id);
    assert.equal(
      await (await fetch(`http://127.0.0.1:${port}`)).text(),
      marker,
    );
    await service.releaseSession('a');
    assert.equal(await service.hasActiveSession('a'), false);
    assert.throws(() => process.kill(terminal.pid!, 0));
    await assert.rejects(fetch(`http://127.0.0.1:${port}`));
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

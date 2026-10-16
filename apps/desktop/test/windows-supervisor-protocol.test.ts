import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Socket } from 'node:net';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

for (const mode of ['no-command-grant', 'abort-before-start'] as const)
  test(
    `Windows supervisor protocol ${mode} closes the real quiescent Node without PID signalling`,
    { timeout: 9000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'circle-win-supervisor-')),
        script = join(directory, 'supervisor.mjs');
      const source = await readFile(
        new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
        'utf8',
      );
      // Execute the exact Windows control branch on this host. This verifies the
      // cross-platform protocol only, not Win32/ConPTY or native Job behavior.
      await writeFile(
        script,
        source.replace("if (process.platform === 'win32')", 'if (true)'),
      );
      const path =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\circle-supervisor-test-${randomUUID()}`
          : join(directory, 'control.sock');
      const sockets = new Set<Socket>();
      let hello = false;
      const server = createServer((socket) => {
        sockets.add(socket);
        socket.setEncoding('utf8');
        socket.on('data', (part) => {
          const message = JSON.parse(part.toString().trim());
          assert.equal(message.kind, 'hello');
          hello = true;
          if (mode === 'abort-before-start')
            socket.write(JSON.stringify({ kind: 'abort-before-start' }) + '\n');
        });
      });
      await new Promise<void>((resolve) => server.listen(path, resolve));
      const child = spawn(process.execPath, [script, path], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_OPTIONS: '',
          NODE_PATH: '',
          CIRCLE_COMMAND_CONTROL_TOKEN: 'synthetic',
        },
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (part) => (stderr += part));
      t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      });
      const exit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
      });
      assert.equal(hello, true);
      assert.deepEqual(exit, { code: 1, signal: null });
      assert.equal(stderr, '');
    },
  );

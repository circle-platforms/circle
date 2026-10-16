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

test(
  'Windows control branch forwards a signal-only actual wait without inventing an exit code',
  { skip: process.platform === 'win32', timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(
        join(tmpdir(), 'circle-win-exit-protocol-'),
      ),
      script = join(directory, 'supervisor.mjs');
    const source = await readFile(
      new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
      'utf8',
    );
    await writeFile(
      script,
      source.replace("if (process.platform === 'win32')", 'if (true)'),
    );
    const path = join(directory, 'control.sock');
    const sockets = new Set<Socket>();
    let actual: Record<string, unknown> | undefined;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (part) => {
        buffer += part;
        for (let index; (index = buffer.indexOf('\n')) >= 0;) {
          const message = JSON.parse(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
          if (message.kind === 'hello')
            socket.write(
              JSON.stringify({
                kind: 'start',
                command: `exec '${process.execPath}' -e 'setInterval(()=>{},1000)'`,
                env: { ...process.env },
              }) + '\n',
            );
          else if (message.kind === 'started')
            socket.write(JSON.stringify({ kind: 'stop' }) + '\n');
          else if (message.kind === 'root-exit') {
            actual = message;
            socket.write(
              JSON.stringify({ kind: 'root-exit-ack' }) +
                '\n' +
                JSON.stringify({ kind: 'finish' }) +
                '\n',
            );
          } else
            assert.fail(
              'unexpected Windows protocol message: ' + JSON.stringify(message),
            );
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const child = spawn(process.execPath, [script, path], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        ComSpec: '/bin/sh',
        NODE_OPTIONS: '',
        NODE_PATH: '',
        CIRCLE_COMMAND_CONTROL_TOKEN: 'synthetic',
      },
    });
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        assert.equal(code, 0);
        resolve();
      });
    });
    assert.equal(actual?.exitCode, null);
    assert.equal(actual?.signal, 'SIGKILL');
  },
);

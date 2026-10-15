import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkspaceDebugService } from '../src/workspace/debug.ts';

const adapterPath =
  process.env.CIRCLE_JS_DEBUG_ADAPTER ??
  '/tmp/circle-native-debugger-adapter/js-debug/src/dapDebugServer.js';
test(
  'Node project launch hits breakpoint, inspects locals, steps and stops',
  {
    timeout: 40000,
    skip:
      !existsSync(adapterPath) &&
      'set CIRCLE_JS_DEBUG_ADAPTER to the pinned standalone adapter',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-'));
    const file = path.join(root, 'fixture.cjs');
    await writeFile(
      file,
      'const value = 41;\nconst answer = value + 1;\nconsole.log(answer);\nsetInterval(()=>{},1000);\n',
    );
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      adapterPath,
    });
    try {
      await service.handle('setBreakpoints', { path: file, lines: [2] });
      await service.handle('launch', { program: file });
      const deadline = Date.now() + 15000;
      while (service.snapshot().status !== 'paused' && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 30));
      assert.equal(
        service.snapshot().status,
        'paused',
        JSON.stringify(service.snapshot()),
      );
      const stack = await service.handle('stackTrace');
      assert.ok(stack.stackFrames.length > 0);
      const scopes = await service.handle('scopes', {
        frameId: stack.stackFrames[0].id,
      });
      const locals = await service.handle('variables', {
        variablesReference: scopes.scopes[0].variablesReference,
      });
      assert.ok(
        locals.variables.some(
          (v: any) => v.name === 'value' && v.value === '41',
        ),
      );
      await service.handle('next');
      await new Promise((r) => setTimeout(r, 100));
      await service.handle('continue');
      await new Promise((r) => setTimeout(r, 100));
      assert.match(service.snapshot().output, /42/);
      await service.handle('stop');
      assert.equal(service.snapshot().status, 'stopped');
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('rejects sources outside workspace and malformed launches without spawning', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-boundary-'));
  const outside = path.join(tmpdir(), `circle-outside-${Date.now()}.cjs`);
  await writeFile(outside, '');
  const service = new WorkspaceDebugService({
    workspaceRoot: root,
    nodeExecutable: process.execPath,
    adapterPath: 'missing',
  });
  try {
    await assert.rejects(
      service.handle('setBreakpoints', { path: outside, lines: [1] }),
      /outside/,
    );
    await assert.rejects(service.handle('attach', { port: 0 }), /port/);
    await assert.rejects(
      service.handle('launch', { program: outside, args: [1] }),
      /outside/,
    );
    assert.equal(service.snapshot().status, 'idle');
  } finally {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside);
  }
});

test(
  'PTY callback launches owned debuggee and adapter stop kills it',
  {
    timeout: 15000,
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-terminal-'));
    const { spawn } = await import('node:child_process');
    let child: ReturnType<typeof spawn> | undefined;
    await writeFile(
      path.join(root, 'fixture.cjs'),
      'setInterval(()=>{},1000);\n',
    );
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      adapterPath,
      runInTerminal: async (args) => {
        const env = { ...process.env };
        for (const [key, value] of Object.entries(args.env ?? {})) {
          if (value === null) delete env[key];
          else env[key] = value;
        }
        child = spawn(args.args[0], args.args.slice(1), {
          cwd: args.cwd,
          env,
          stdio: 'ignore',
        });
        return { processId: child.pid! };
      },
    });
    try {
      await service.handle('launch', {
        program: 'fixture.cjs',
        stopOnEntry: true,
      });
      const until = Date.now() + 5000;
      while (service.snapshot().status !== 'paused' && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(service.snapshot().status, 'paused');
      assert.ok(child?.pid);
      await service.stop();
      const ended = Date.now() + 3000;
      while (
        child?.exitCode === null &&
        child?.signalCode === null &&
        Date.now() < ended
      )
        await new Promise((r) => setTimeout(r, 20));
      assert.ok(
        child?.exitCode !== null || child?.signalCode !== null,
        'debuggee must exit',
      );
    } finally {
      child?.kill();
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'attach pauses existing local process and detaches without killing owner',
  {
    timeout: 15000,
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-attach-'));
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['--inspect=127.0.0.1:0', '-e', 'setInterval(()=>{},1000)'],
      { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    const port = await new Promise<number>((resolve, reject) => {
      let output = '';
      child.stderr!.on('data', (chunk) => {
        output += chunk;
        const m = /127\.0\.0\.1:(\d+)/.exec(output);
        if (m) resolve(+m[1]);
      });
      child.once('error', reject);
    });
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      adapterPath,
    });
    try {
      await service.handle('attach', { port });
      const until = Date.now() + 5000;
      let threads: any;
      do {
        threads = await service.handle('threads');
        if (!threads.threads.length)
          await new Promise((r) => setTimeout(r, 30));
      } while (!threads.threads.length && Date.now() < until);
      assert.ok(threads.threads.length);
      await service.handle('pause', { threadId: threads.threads[0].id });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(service.snapshot().status, 'paused');
      await service.stop();
      assert.doesNotThrow(() => process.kill(child.pid!, 0));
    } finally {
      child.kill();
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'TypeScript source maps bind original source breakpoint',
  {
    timeout: 15000,
    skip: !existsSync(adapterPath) && 'set CIRCLE_JS_DEBUG_ADAPTER',
  },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'circle-debug-sourcemap-'));
    const ts = await import('typescript');
    const source =
      'const value: number = 41;\nconst answer = value + 1;\nconsole.log(answer);\nsetInterval(()=>{},1000);\n';
    const compiled = ts.transpileModule(source, {
      fileName: 'fixture.ts',
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        sourceMap: true,
        inlineSources: true,
      },
    });
    await writeFile(path.join(root, 'fixture.ts'), source);
    await writeFile(path.join(root, 'fixture.js'), compiled.outputText);
    await writeFile(path.join(root, 'fixture.js.map'), compiled.sourceMapText!);
    const service = new WorkspaceDebugService({
      workspaceRoot: root,
      nodeExecutable: process.execPath,
      adapterPath,
    });
    try {
      await service.handle('setBreakpoints', {
        path: 'fixture.ts',
        lines: [2],
      });
      await service.handle('launch', { program: 'fixture.js' });
      const until = Date.now() + 5000;
      while (service.snapshot().status !== 'paused' && Date.now() < until)
        await new Promise((r) => setTimeout(r, 20));
      assert.equal(service.snapshot().status, 'paused');
      const stack = await service.handle('stackTrace');
      assert.ok(stack.stackFrames[0].source.path.endsWith('fixture.ts'));
      assert.equal(stack.stackFrames[0].line, 2);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

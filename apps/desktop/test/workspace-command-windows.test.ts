import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'node:net';
import { TerminalManager } from '../src/workspace/terminal.ts';
import { createTerminalCommandLauncher } from '../src/workspace/command-terminal.ts';

const win = { skip: process.platform !== 'win32', timeout: 20000 };
async function until(fn: () => Promise<boolean>, label: string) {
  const end = Date.now() + 7000;
  while (!(await fn())) {
    if (Date.now() > end)
      throw Error('Windows native fixture timed out: ' + label);
    await delay(20);
  }
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'circle-win-job-')),
    workspace = join(root, 'workspace'),
    home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  const output = join(root, 'original.log');
  await writeFile(output, '');
  const terminals = new TerminalManager(
    {
      workspaceRoot: workspace,
      logRoot: join(root, 'terminals'),
      shellAllowlist: [process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe'],
      env: { HOME: home, USERPROFILE: home },
    },
    () => {},
  );
  let active:
    | Awaited<ReturnType<ReturnType<typeof createTerminalCommandLauncher>>>
    | undefined;
  const launcher = createTerminalCommandLauncher({
    terminals,
    runtimeExecutable: process.execPath,
    supervisorPath: fileURLToPath(
      new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
    ),
    executionEpoch: 'windows-real-job-test',
    windowsJobObject: true,
    stopExecution: async () => {
      if (!active) throw Error('fixture has no original handle');
      await active.stop('fixture cleanup');
    },
  });
  t.after(async () => {
    try {
      await active?.stop('fixture cleanup');
    } finally {
      await terminals.dispose();
    }
    await rm(root, { recursive: true, force: true });
  });
  const run = async (body: string, extraEnv: NodeJS.ProcessEnv = {}) => {
    await writeFile(join(workspace, 'program.cjs'), body);
    active = await launcher({
      executionId: 'windows-original',
      origin: { executionSessionId: 'owner', toolCallId: 'call' },
      notificationOwner: { sessionId: 'owner' },
      command: 'node program.cjs',
      cwd: workspace,
      env: {
        ...process.env,
        ...extraEnv,
        HOME: home,
        USERPROFILE: home,
        PATH: dirname(process.execPath) + delimiter + process.env.PATH,
      },
      outputPath: output,
      signal: new AbortController().signal,
    });
    return active;
  };
  return { root, workspace, terminals, output, run };
}
function portOpen(port: number) {
  return new Promise<boolean>((resolve) => {
    const c = createConnection({ port, host: '127.0.0.1' });
    c.once('connect', () => {
      c.destroy();
      resolve(true);
    });
    c.once('error', () => resolve(false));
  });
}

test(
  'Windows original ConPTY input and resistant inherited service stop use real root exit and Job-empty facts',
  win,
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.workspace, 'service.cjs'),
      "const fs=require('fs');require('net').createServer(()=>{}).listen(0,'127.0.0.1',function(){fs.writeFileSync('port',String(this.address().port));});",
    );
    const handle = await f.run(
      "const fs=require('fs');fs.appendFileSync('starts','once\\n');require('child_process').spawn(process.execPath,['service.cjs'],{detached:true,stdio:'inherit'});require('readline').createInterface({input:process.stdin}).on('line',line=>fs.writeFileSync('input',line));console.log('READY');process.stdout.write('尾'.repeat(24000));setInterval(()=>{},1000);",
    );
    assert.equal(handle.kind, 'pty-group');
    if (handle.kind !== 'pty-group') throw Error('wrong process handle');
    await until(async () => {
      try {
        return Number(await readFile(join(f.workspace, 'port'), 'utf8')) > 0;
      } catch {
        return false;
      }
    }, 'real inherited port');
    const port = Number(await readFile(join(f.workspace, 'port'), 'utf8'));
    assert.equal(await portOpen(port), true);
    await f.terminals.write(
      'owner',
      handle.terminal!.id,
      'same original input\r',
    );
    await until(async () => {
      try {
        return (
          (await readFile(join(f.workspace, 'input'), 'utf8')) ===
          'same original input'
        );
      } catch {
        return false;
      }
    }, 'original stdin');
    await handle.stop('manual stop');
    const exit = await handle.rootExit;
    assert.ok(Number.isInteger(exit.exitCode));
    await handle.controlledGroupEmpty;
    await handle.transportAndLogClosed;
    assert.equal(await portOpen(port), false);
    assert.equal(await readFile(join(f.workspace, 'starts'), 'utf8'), 'once\n');
    assert.equal(handle.descendantCoverage.snapshot().state, 'unknown');
    const snapshot = (await f.terminals.list('owner'))[0]!;
    assert.ok(snapshot.managedCommand!.completion.rootExit);
    assert.ok(snapshot.managedCommand!.completion.controlledGroupEmpty);
    assert.ok(snapshot.managedCommand!.completion.transportAndLogClosed);
    assert.ok((await readFile(f.output, 'utf8')).includes('尾'.repeat(24000)));
    assert.equal(
      await readFile(f.output, 'utf8'),
      await readFile(snapshot.logPath, 'utf8'),
    );
  },
);

test(
  'Windows natural completion waits for actual root ACK, wrapper exit, Job empty and original log closure',
  win,
  async (t) => {
    const f = await fixture(t),
      handle = await f.run(
        "require('fs').writeFileSync('ran','once');console.log('natural-output');",
      );
    if (handle.kind !== 'pty-group') throw Error('wrong process handle');
    assert.equal((await handle.rootExit).exitCode, 0);
    await handle.controlledGroupEmpty;
    await handle.transportAndLogClosed;
    assert.equal(await readFile(join(f.workspace, 'ran'), 'utf8'), 'once');
    assert.match(await readFile(f.output, 'utf8'), /natural-output/);
    const snapshot = (await f.terminals.list('owner'))[0]!;
    assert.equal(snapshot.managedCommand!.completion.rootExit!.exitCode, 0);
    assert.equal(
      'remainingProcesses' in snapshot.managedCommand!.completion.rootExit!,
      false,
    );
  },
);

test(
  'Windows supervisor cannot preload command Node options before Job assignment',
  win,
  async (t) => {
    const f = await fixture(t),
      preload = join(f.workspace, 'preload.cjs');
    await writeFile(
      preload,
      "require('fs').appendFileSync('preloaded-pids',String(process.pid)+'\\n');",
    );
    const handle = await f.run("console.log('preloaded command done');", {
      NODE_OPTIONS: '--require="' + preload + '"',
    });
    if (handle.kind !== 'pty-group') throw Error('wrong process handle');
    await handle.rootExit;
    await handle.controlledGroupEmpty;
    await handle.transportAndLogClosed;
    const pids = (await readFile(join(f.workspace, 'preloaded-pids'), 'utf8'))
      .trim()
      .split('\n')
      .map(Number);
    assert.ok(
      pids.length > 0,
      'actual command preserves its own Node options after assignment',
    );
    const wrapper = (await f.terminals.list('owner'))[0]!.pid;
    assert.equal(
      pids.includes(wrapper!),
      false,
      'quiescent supervisor did not execute the command preload',
    );
  },
);

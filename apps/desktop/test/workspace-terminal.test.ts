import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { terminalInputChunks } from '../../workbench/src/model/terminal-stream.ts';
import {
  TerminalManager,
  type TerminalEvent,
  type TerminalManagerOptions,
  type TerminalSnapshot,
} from '../src/workspace/terminal.ts';

const owner = 'human:test-workspace';
const unix = process.platform !== 'win32';
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (script: string) =>
  `${quote(process.execPath)} -e ${quote(script)}\r`;

async function wait(
  check: () => boolean | Promise<boolean>,
  description: string,
  timeout = 8000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw Error(`timed out: ${description}`);
    await delay(15);
  }
}

async function setup(
  t: TestContext,
  overrides: Partial<TerminalManagerOptions> = {},
  callback?: (event: TerminalEvent) => void | Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'circle-pty-'));
  const workspace = join(root, 'workspace');
  const logRoot = join(root, 'logs');
  const home = join(root, 'home');
  await mkdir(workspace);
  await mkdir(home);
  const events: TerminalEvent[] = [];
  const options: TerminalManagerOptions = {
    workspaceRoot: workspace,
    logRoot,
    shellAllowlist: ['/bin/sh'],
    env: {
      HOME: home,
      PS1: 'CIRCLE_TEST> ',
      HISTFILE: '/dev/null',
      ENV: '/dev/null',
    },
    stopGraceMs: 150,
    ...overrides,
  };
  const manager = new TerminalManager(options, async (event) => {
    events.push(event);
    await callback?.(event);
  });
  t.after(async () => {
    await manager.dispose();
    await rm(root, { recursive: true, force: true });
  });
  return { manager, root, workspace, logRoot, events, options };
}

async function shell(
  manager: TerminalManager,
  log: TerminalEvent[],
): Promise<TerminalSnapshot> {
  const terminal = await manager.create({ owner, sessionId: 'session-a' });
  await manager.write(
    owner,
    terminal.id,
    "stty -echo; printf '__ECHO_OFF__\\n'\r",
  );
  await wait(
    () => log.some((event) => event.data?.includes('__ECHO_OFF__\r\n')),
    'disable command echo',
  );
  return terminal;
}

test(
  'real PTY accepts interactive input and reports both terminal streams',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    await manager.write(
      owner,
      terminal.id,
      node(
        "console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY); process.stdin.once('data',d=>{console.log('READ:'+d.toString().trim());process.exit(0)})",
      ),
    );
    await wait(
      () => events.some((event) => event.data?.includes('TTY:true:true')),
      'real isTTY',
    );
    await manager.write(owner, terminal.id, 'hello terminal\r');
    await wait(
      () => events.some((event) => event.data?.includes('READ:hello terminal')),
      'actual stdin delivery',
    );
    await manager.write(owner, terminal.id, "printf 'SHELL_STILL_ALIVE\\n'\r");
    await wait(
      () => events.some((event) => event.data?.includes('SHELL_STILL_ALIVE')),
      'shell remains available',
    );
    assert.equal((await manager.list(owner))[0]!.status, 'running');
  },
);

test(
  'resize reaches the real PTY and Ctrl+C interrupts foreground command without ending shell',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    await manager.resize(owner, terminal.id, 119, 37);
    await manager.write(owner, terminal.id, 'stty size\r');
    await wait(
      () => events.some((event) => /37 119/.test(event.data ?? '')),
      'PTY resize',
    );
    await manager.write(
      owner,
      terminal.id,
      node("console.log('COMMAND_WAITING');setInterval(()=>{},1000)"),
    );
    await wait(
      () => events.some((event) => event.data?.includes('COMMAND_WAITING')),
      'foreground running',
    );
    const request = await manager.signal(owner, terminal.id, 'SIGINT');
    assert.equal(request.status, 'running');
    await manager.write(owner, terminal.id, "printf 'AFTER_INTERRUPT\\n'\r");
    await wait(
      () => events.some((event) => event.data?.includes('AFTER_INTERRUPT')),
      'shell returned after interrupt',
    );
    assert.equal(
      events.some((event) => event.kind === 'exit'),
      false,
    );
  },
);

test(
  'large multilingual paste crosses bounded input messages without losing bytes',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    const payload = '😃中'.repeat(50000);
    const expected = createHash('sha256').update(payload).digest('hex');
    const script = `let b=Buffer.alloc(0);process.stdin.setRawMode(true);console.log('INPUT_READY');process.stdin.on('data',d=>{b=Buffer.concat([b,d]);if(b.length>=${Buffer.byteLength(payload)}){console.log('INPUT_SHA:'+require('node:crypto').createHash('sha256').update(b).digest('hex'));process.stdin.setRawMode(false);process.exit(0)}})`;
    await manager.write(owner, terminal.id, node(script));
    await wait(
      () => events.some((event) => event.data?.includes('INPUT_READY')),
      'raw input reader',
    );
    for (const part of terminalInputChunks(payload))
      await manager.write(owner, terminal.id, part);
    await wait(
      () =>
        events.some((event) => event.data?.includes(`INPUT_SHA:${expected}`)),
      'large input actual checksum',
    );
  },
);

test(
  'real exit code and stop requests are distinct and ordered',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    await manager.write(owner, terminal.id, 'exit 7\r');
    await wait(
      async () => (await manager.list(owner))[0]?.status === 'exited',
      'shell exit',
    );
    const stopped = await manager.close(owner, terminal.id);
    assert.equal(stopped.exitCode, 7);
    assert.equal(stopped.signal, undefined);
    assert.equal(stopped.requestedSignal, undefined);
    const replay = await manager.replay(owner, terminal.id);
    assert.equal(replay.events.at(-1)?.kind, 'exit');
    assert.equal(replay.events.at(-1)?.snapshot?.exitCode, 7);
    assert.ok(events.every((event, index) => event.sequence === index + 1));
    await assert.rejects(
      manager.write(owner, terminal.id, 'anything'),
      /not running/,
    );
  },
);

test(
  'owner, directory and shell boundaries are enforced before any process is started',
  { skip: !unix },
  async (t) => {
    const { manager, workspace, root } = await setup(t);
    const terminal = await manager.create({ owner, sessionId: 'session-a' });
    assert.deepEqual(await manager.list('other-owner'), []);
    await assert.rejects(
      manager.write('other-owner', terminal.id, 'echo leak\r'),
      /not found/,
    );
    await assert.rejects(
      manager.resize('other-owner', terminal.id, 80, 24),
      /not found/,
    );
    await assert.rejects(
      manager.replay('other-owner', terminal.id),
      /not found/,
    );
    await assert.rejects(
      manager.close('other-owner', terminal.id),
      /not found/,
    );
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', cwd: root }),
      /outside/,
    );
    const outside = join(root, 'outside');
    await mkdir(outside);
    await symlink(outside, join(workspace, 'escape'));
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', cwd: join(workspace, 'escape') }),
      /outside/,
    );
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', shell: '/usr/bin/env' }),
      /not allowed/,
    );
    await assert.rejects(
      manager.create({ owner, sessionId: 'a', args: ['-c', 'echo bypass'] }),
      /startup flags/,
    );
    await assert.rejects(
      manager.resize(owner, terminal.id, 0, 24),
      /dimensions/,
    );
    await assert.rejects(
      manager.write(owner, terminal.id, 'a'.repeat(300000)),
      /too large/,
    );
  },
);

test(
  'complete logs replay beyond the bounded ring and survive application restart',
  { skip: !unix },
  async (t) => {
    const { manager, events, options } = await setup(t, { ringBytes: 32768 });
    const terminal = await shell(manager, events);
    const expected = Array.from(
      { length: 2000 },
      (_, index) =>
        `ROW_${String(index).padStart(4, '0')}_${'x'.repeat(160)}😃`,
    ).join('\r\n');
    await manager.write(
      owner,
      terminal.id,
      node(
        "for(let i=0;i<2000;i++)console.log('ROW_'+String(i).padStart(4,'0')+'_'+'x'.repeat(160)+'😃');console.log('LOG_COMPLETE')",
      ),
    );
    await wait(
      () => events.some((event) => event.data?.includes('LOG_COMPLETE')),
      'large output',
    );
    await manager.close(owner, terminal.id);
    const raw = await readFile(terminal.logPath, 'utf8');
    assert.ok(raw.includes(expected));
    let cursor = 0;
    let text = '';
    const sequences: number[] = [];
    for (;;) {
      const replay = await manager.replay(owner, terminal.id, cursor, 7);
      for (const event of replay.events) {
        text += event.kind === 'data' ? (event.data ?? '') : '';
        sequences.push(event.sequence);
      }
      cursor = replay.nextSequence;
      if (!replay.hasMore) break;
    }
    assert.ok(text.includes(expected));
    assert.equal(new Set(sequences).size, sequences.length);
    assert.ok(sequences.every((value, index) => value === index + 1));
    await manager.dispose();
    const restored = new TerminalManager(options, () => undefined);
    t.after(() => restored.dispose());
    const saved = (await restored.list(owner))[0]!;
    assert.equal(saved.status, 'exited');
    assert.equal(saved.id, terminal.id);
    const first = await restored.replay(owner, terminal.id, 0, 5);
    assert.equal(first.events[0]?.kind, 'created');
    assert.equal(first.hasMore, true);
    assert.deepEqual(await restored.list('other-owner'), []);
  },
);

test(
  'slow or failed views preserve full output and do not kill the shell',
  { skip: !unix },
  async (t) => {
    let delayed = 0;
    const { manager, events } = await setup(
      t,
      { eventHighWaterBytes: 32768, ringBytes: 32768 },
      async (event) => {
        if (event.kind === 'data') {
          delayed++;
          await delay(3);
          if (delayed === 2) throw Error('renderer reloaded');
        }
      },
    );
    const terminal = await shell(manager, events);
    await manager.write(
      owner,
      terminal.id,
      node("process.stdout.write('START'+('😃'.repeat(100000))+'END\\n')"),
    );
    await wait(
      async () => (await readFile(terminal.logPath, 'utf8')).includes('END'),
      'output under backpressure',
    );
    await manager.close(owner, terminal.id);
    const text = await readFile(terminal.logPath, 'utf8');
    assert.ok(text.includes('START' + '😃'.repeat(100000) + 'END'));
    assert.equal(text.includes('\uFFFD'), false);
    assert.ok(delayed > 2);
  },
);

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function portAvailable(port: number): Promise<boolean> {
  const server = createServer();
  return new Promise<boolean>((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

test(
  'service readiness, stopping and restart are proven by the real port lifecycle',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    const port = await freePort();
    const command = node(
      `require('node:http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1',()=>console.log('SERVICE_READY'))`,
    );
    await manager.write(owner, terminal.id, command);
    await wait(
      () => events.some((event) => event.data?.includes('SERVICE_READY')),
      'real service ready',
    );
    assert.equal(await portAvailable(port), false);
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok');
    await manager.close(owner, terminal.id);
    await wait(() => portAvailable(port), 'service port released');
    const restarted = await manager.restart(owner, terminal.id);
    assert.equal(restarted.restartOf, terminal.id);
    assert.notEqual(restarted.id, terminal.id);
    assert.equal(
      await portAvailable(port),
      true,
      'restart must not silently replay the previous command',
    );
    await manager.write(owner, restarted.id, command);
    await wait(
      async () => !(await portAvailable(port)),
      'service ready after explicit restart input',
    );
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'ok');
    await manager.close(owner, restarted.id);
    await wait(() => portAvailable(port), 'restarted service released');
  },
);

test(
  'restoring an unconfirmed old process never reexecutes commands or signals an old PID',
  { skip: !unix },
  async (t) => {
    const { manager, options, logRoot } = await setup(t);
    const terminal = await manager.create({ owner, sessionId: 'session-a' });
    await manager.close(owner, terminal.id);
    const path = join(logRoot, terminal.id, 'metadata.json');
    const metadata = JSON.parse(
      await readFile(path, 'utf8'),
    ) as TerminalSnapshot;
    metadata.status = 'running';
    metadata.pid = process.pid;
    const lastSequence = metadata.lastSequence;
    metadata.lastSequence = 0;
    await writeFile(path, JSON.stringify(metadata));
    await appendFile(
      join(logRoot, terminal.id, 'events.jsonl'),
      '{"sequence":999999',
    );
    const restored = new TerminalManager(options, () => undefined);
    t.after(() => restored.dispose());
    const saved = (await restored.list(owner))[0]!;
    assert.equal(saved.status, 'interrupted');
    assert.equal(saved.pid, undefined);
    assert.equal(saved.lastSequence, lastSequence);
    assert.match(saved.error!, /not confirmed/);
    await restored.close(owner, terminal.id);
  },
);

test(
  'closing owns only its PTY descendants, including background jobs that ignore graceful stop',
  { skip: !unix },
  async (t) => {
    const { manager, events } = await setup(t);
    const terminal = await shell(manager, events);
    const port = await freePort();
    const unrelated = createServer();
    await new Promise<void>((resolve) =>
      unrelated.listen(0, '127.0.0.1', resolve),
    );
    const unrelatedPort = (unrelated.address() as { port: number }).port;
    t.after(
      () => new Promise<void>((resolve) => unrelated.close(() => resolve())),
    );
    const script = `process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});require('node:net').createServer().listen(${port},'127.0.0.1',()=>console.log('BACKGROUND_READY'))`;
    await manager.write(
      owner,
      terminal.id,
      `${quote(process.execPath)} -e ${quote(script)} &\r`,
    );
    await wait(
      async () => !(await portAvailable(port)),
      'background port ready',
    );
    const stopped = await manager.close(owner, terminal.id);
    assert.equal(stopped.status, 'exited');
    assert.equal(await portAvailable(port), true);
    assert.equal(await portAvailable(unrelatedPort), false);
  },
);

test(
  'parallel owners remain independent and create limits include in-flight creation',
  { skip: !unix },
  async (t) => {
    const { manager } = await setup(t, { maxActive: 2 });
    const results = await Promise.allSettled([
      manager.create({ owner, sessionId: 'session-a' }),
      manager.create({ owner: 'session-b', sessionId: 'session-b' }),
      manager.create({ owner: 'session-c', sessionId: 'session-c' }),
    ]);
    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      2,
    );
    assert.equal(
      results.filter((result) => result.status === 'rejected').length,
      1,
    );
    const a = (await manager.list(owner))[0]!;
    const b = (await manager.list('session-b'))[0]!;
    await manager.close(owner, a.id);
    assert.equal((await manager.list('session-b'))[0]!.status, 'running');
    await manager.write('session-b', b.id, 'exit\r');
    await wait(
      async () => (await manager.list('session-b'))[0]?.status === 'exited',
      'independent shell exits',
    );
  },
);

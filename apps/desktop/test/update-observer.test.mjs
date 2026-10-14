import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { ownedProcesses } from './helpers/update-observer.mjs';

const helper = new URL('./helpers/update-observer.mjs', import.meta.url).href;
const helperPath = fileURLToPath(
  new URL('./helpers/update-observer.mjs', import.meta.url),
);
async function fixture(t, source) {
  const folder = await mkdtemp(join(tmpdir(), 'circle-update-observer-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', source(folder)],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) =>
            /^(PATH|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|USERPROFILE|HOME|LANG|LC_ALL|PATHEXT)$/i.test(
              name,
            ),
          ),
        ),
        CIRCLE_HOME: join(folder, 'home'),
        CIRCLE_WORKBENCH_DATA_DIR: join(folder, 'data'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const closed = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const ended = Promise.race([
    closed,
    new Promise((_resolve, reject) => {
      const timeout = setTimeout(
        () => reject(Error(`observer fixture exceeded its bound: ${output}`)),
        process.platform === 'win32' ? 120000 : 12000,
      );
      timeout.unref();
    }),
  ]);
  return { folder, child, closed: ended, output: () => output };
}

test('an independent observer captures a blocked Node, ignores heartbeat progress and ends only its owned processes', async (t) => {
  const f = await fixture(
    t,
    (folder) => `
    import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';
    import {startUpdateObserver,writeProgress} from ${JSON.stringify(helper)};
    const folder=${JSON.stringify(folder)};
    const owned=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(folder+'/owned-pid',String(owned.pid));
    writeProgress(folder,'stage','restarting to update');
    await startUpdateObserver(folder,{timeoutMs:300,pollMs:50});
    console.log('observer ready');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  `,
  );
  const sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  t.after(() => sentinel.kill());
  const timer = setInterval(async () => {
    await writeFile(
      join(f.folder, 'heartbeat.json'),
      JSON.stringify({ kind: 'heartbeat', time: Date.now() }),
    );
    // The independent producer keeps the log moving while the target event loop is stuck.
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      join(f.folder, 'progress.log'),
      JSON.stringify({
        kind: 'heartbeat',
        time: Date.now(),
        text: 'still waiting',
      }) + '\n',
    );
  }, 40);
  t.after(() => clearInterval(timer));
  const end = await f.closed;
  clearInterval(timer);
  assert.notEqual(end.code, 0, f.output());
  assert.match(f.output(), /observer ready/);
  let evidence;
  const until = Date.now() + 3000;
  do {
    evidence = JSON.parse(
      await readFile(join(f.folder, 'observer', 'evidence.json'), 'utf8'),
    );
    if (!evidence.complete)
      await new Promise((resolve) => setTimeout(resolve, 10));
  } while (!evidence.complete && Date.now() < until);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.reason, 'stage stalled');
  assert.equal(evidence.stage.text, 'restarting to update');
  assert.ok(evidence.owner.pid === f.child.pid);
  assert.ok(evidence.owner.executable);
  assert.ok(evidence.owner.createdAt);
  const ownedPid = Number(await readFile(join(f.folder, 'owned-pid'), 'utf8'));
  assert.ok(evidence.processes.some((p) => p.pid === ownedPid));
  assert.ok(
    evidence.termination.some((p) => p.pid === f.child.pid && p.terminated),
  );
  assert.equal(sentinel.exitCode, null);
  assert.doesNotThrow(() => process.kill(sentinel.pid, 0));
  const capture = await readFile(
    join(f.folder, 'observer', 'progress.log'),
    'utf8',
  );
  assert.match(capture, /heartbeat/);
  const dump = JSON.parse(
    await readFile(join(f.folder, 'observer', 'dump.json'), 'utf8'),
  );
  assert.match(dump.status, /unavailable|captured/);
});

test('known ancestry rejects an unrelated older child and a reused parent identity', () => {
  const owner = {
    pid: 10,
    parentPid: 1,
    createdAt: '2026-10-14T00:00:02Z',
    executable: 'node',
  };
  const previous = {
    pid: 11,
    parentPid: 10,
    createdAt: '2026-10-14T00:00:03Z',
    executable: 'app',
  };
  const rows = [
    owner,
    {
      pid: 12,
      parentPid: 10,
      createdAt: '2026-10-14T00:00:01Z',
      executable: 'unrelated',
    },
    {
      ...previous,
      parentPid: 999,
      createdAt: '2026-10-14T00:00:04Z',
      executable: 'another',
    },
    {
      pid: 13,
      parentPid: 11,
      createdAt: '2026-10-14T00:00:04Z',
      executable: 'unrelated-child',
    },
  ];
  assert.deepEqual(
    ownedProcesses(rows, owner, [previous]).map((row) => row.pid),
    [10],
  );
  assert.ok(
    !ownedProcesses(rows, owner, [previous]).some((row) => row.pid === 13),
  );
});

test('real stage progress postpones capture and allows a healthy owned process to stop normally', async (t) => {
  const f = await fixture(
    t,
    (folder) => `
    import {startUpdateObserver,writeProgress} from ${JSON.stringify(helper)};
    const folder=${JSON.stringify(folder)};writeProgress(folder,'stage','started');
    const observer=await startUpdateObserver(folder,{timeoutMs:200,pollMs:25});
    for(let i=0;i<6;i++){writeProgress(folder,'stage','completed step '+i);await new Promise(resolve=>setTimeout(resolve,75));}
    await observer.stop();console.log('all stages completed');
  `,
  );
  const end = await f.closed;
  assert.equal(end.code, 0, f.output());
  assert.match(f.output(), /all stages completed/);
});

test('an observer refuses a reused PID identity and leaves that live process alone', async (t) => {
  const f = await fixture(
    t,
    (folder) => `
    import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';
    import {processIdentity,writeProgress} from ${JSON.stringify(helper)};
    const folder=${JSON.stringify(folder)};writeProgress(folder,'stage','fixture');
    const owner=processIdentity(process.pid,folder);owner.createdAt='different-process-creation-time';
    const config=folder+'/observer-plan.json';writeFileSync(config,JSON.stringify({folder,owner,known:[owner],token:'fixture-token',timeoutMs:100,pollMs:20}));
    const observer=spawn(process.execPath,[${JSON.stringify(helperPath)},'--observe',config],{stdio:'inherit'});
    const code=await new Promise(resolve=>observer.on('close',resolve));console.log('observer refused identity '+code);process.exit(0);
  `,
  );
  const end = await f.closed;
  assert.equal(end.code, 0, f.output());
  const evidence = JSON.parse(
    await readFile(join(f.folder, 'observer', 'evidence.json'), 'utf8'),
  );
  assert.equal(evidence.reason, 'owner identity changed');
  assert.deepEqual(evidence.termination, []);
});

test('normal observer shutdown does not terminate the test process', async (t) => {
  const f = await fixture(
    t,
    (folder) => `
    import {startUpdateObserver,writeProgress} from ${JSON.stringify(helper)};
    const folder=${JSON.stringify(folder)};writeProgress(folder,'stage','fixture');
    const observer=await startUpdateObserver(folder,{timeoutMs:1000,pollMs:25});await observer.stop();console.log('stopped safely');
  `,
  );
  const end = await f.closed;
  assert.equal(end.code, 0, f.output());
  assert.match(f.output(), /stopped safely/);
});

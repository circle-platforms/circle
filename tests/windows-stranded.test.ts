import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { JobRegistry, type CommandTree } from '../src/jobs.js';
import { Sandbox } from '../src/sandbox.js';
import {
  loadChildrenApi,
  strandedTree,
  WindowsCommandTree,
  type WindowsChildrenApi,
  type WindowsJobApi,
} from '../src/windows_stranded.js';
import { cleanup, scratch, until } from './helpers.js';

const shell = { pid: 100, started: 10_000, ended: 20_000 };
interface Row {
  pid: number;
  parent: number;
  started?: number;
  name?: string;
}
const api = (processes: Row[], job?: WindowsJobApi): WindowsChildrenApi => ({
  processes: () =>
    processes.map(({ pid, parent, name }) => ({
      pid,
      parent,
      name: name ?? 'node.exe',
    })),
  started: (pid) => processes.find((entry) => entry.pid === pid)?.started,
  ...(job ? { job } : {}),
});
const pids = (result: { live: { pid: number }[] }): number[] =>
  result.live.map((process) => process.pid).sort((a, b) => a - b);

test('a program a stopped Windows shell started while it ran is found, and no other process', () => {
  const result = strandedTree(
    api([
      // Started by the shell after taskkill had looked: it outlived the shell.
      { pid: 200, parent: 100, started: 15_000 },
      // Its recorded start lags the clock Circle read by less than a tick.
      { pid: 201, parent: 100, started: 9_950 },
      // The PID was reused after the shell ended, and that process started this one.
      { pid: 202, parent: 100, started: 20_500 },
      // An earlier process with the same PID started this one before the shell existed.
      { pid: 203, parent: 100, started: 5_000 },
      // Ended before it could be read.
      { pid: 204, parent: 100 },
      { pid: 205, parent: 7, started: 15_000 },
      { pid: 100, parent: 100, started: 15_000 },
      // The console host Windows started for the shell belongs to the console, not to the
      // command: it ends by itself once nothing uses that console.
      { pid: 206, parent: 100, started: 10_010, name: 'conhost.exe' },
      { pid: 207, parent: 100, started: 10_010, name: 'CONHOST.EXE' },
      { pid: 208, parent: 100, started: 15_000, name: 'cmd.exe' },
    ]),
    shell,
  );
  assert.deepEqual(pids(result), [200, 201, 208]);
  assert.deepEqual(result.roots, [200, 201, 208]);
});

test('the whole stranded tree is found through processes that have ended, and a reused PID links nothing', () => {
  const table: Row[] = [
    // Listed before its parent: the walk does not depend on the order of the list.
    { pid: 302, parent: 301, started: 11_200 },
    // `cmd /c start /b node`: the inner cmd (150) has ended, its program points at it.
    { pid: 300, parent: 150, started: 10_060 },
    { pid: 301, parent: 300, started: 10_070 },
    // The console host of that program is still left alone.
    { pid: 303, parent: 300, started: 10_065, name: 'conhost.exe' },
    // A cmd still running between the shell and its program.
    { pid: 210, parent: 100, started: 11_000, name: 'cmd.exe' },
    { pid: 211, parent: 210, started: 11_500 },
    // Points at the live cmd's PID but started before it: an earlier holder of the PID.
    { pid: 212, parent: 210, started: 10_500 },
    // 160 was in the tree and has ended; an unrelated process (started at 25 s) has its PID now.
    { pid: 160, parent: 4, started: 25_000 },
    // Started by the new holder of 160: not the command's.
    { pid: 500, parent: 160, started: 26_000 },
    // Started by the recorded 160 before it ended: the command's.
    { pid: 501, parent: 160, started: 12_000 },
    // 170 was seen to end at 11 s; this one started later from a process with its PID.
    { pid: 600, parent: 170, started: 12_000 },
    // Its parent ended, but nothing recorded that parent as the command's.
    { pid: 400, parent: 999, started: 15_000 },
    { pid: 700, parent: 7, started: 15_000 },
  ];
  const result = strandedTree(api(table), shell, [
    { pid: 150, started: 10_050 },
    { pid: 160, started: 10_100 },
    { pid: 170, started: 10_200, ended: 11_000 },
  ]);
  assert.deepEqual(pids(result), [210, 211, 300, 301, 302, 501]);
  assert.deepEqual(
    [...result.roots].sort((a, b) => a - b),
    [210, 300, 501],
  );
  // What was seen is kept, so a later walk can link through 210 and 300 once they end.
  const later = strandedTree(
    api(
      table
        .filter((row) => ![210, 300].includes(row.pid))
        .concat([
          // A new process took 300's PID after it ended.
          { pid: 300, parent: 4, started: 30_000 },
          { pid: 800, parent: 300, started: 31_000 },
        ]),
    ),
    shell,
    result.known,
  );
  assert.deepEqual(pids(later), [211, 301, 302, 501]);
  assert.deepEqual(
    [...later.roots].sort((a, b) => a - b),
    [211, 301, 501],
  );
});

/** A fake process table and Job: a terminated or killed process leaves the table. */
function fakeWindows(table: Row[], members: number[] | 'refused') {
  const calls: string[] = [];
  const job: WindowsJobApi = {
    create: () => 7n,
    assign: (_job, pid) => {
      calls.push(`assign ${pid}`);
      return members !== 'refused';
    },
    members: () =>
      members === 'refused'
        ? []
        : members.filter((pid) => table.some((row) => row.pid === pid)),
    terminate: (_job, pid) => {
      calls.push(`terminate ${pid}`);
      const index = table.findIndex((row) => row.pid === pid);
      if (index < 0 || members === 'refused' || !members.includes(pid))
        return false;
      table.splice(index, 1);
      return true;
    },
    close: () => calls.push('close'),
  };
  const kill = async (pid: number): Promise<void> => {
    calls.push(`kill ${pid}`);
    const gone = new Set([pid]);
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table)
        if (!gone.has(row.pid) && gone.has(row.parent)) {
          gone.add(row.pid);
          grew = true;
        }
    }
    for (let i = table.length - 1; i >= 0; i--)
      if (gone.has(table[i]!.pid)) table.splice(i, 1);
  };
  return { api: api(table, job), calls, kill, table };
}

test('a shell is put in a Job, and ending its tree ends every member and what is outside the Job', async () => {
  const table: Row[] = [
    // The reported case: node's parent, the inner cmd, ended before anything looked.
    { pid: 300, parent: 150, started: 10_060 },
    { pid: 301, parent: 300, started: 10_065, name: 'conhost.exe' },
    // Started before the shell was put in the Job.
    { pid: 400, parent: 100, started: 10_001 },
    { pid: 401, parent: 400, started: 10_002 },
    { pid: 700, parent: 7, started: 15_000 },
  ];
  const fake = fakeWindows(table, [300, 301]);
  const tree = new WindowsCommandTree(
    fake.api,
    { pid: 100, started: 10_000 },
    fake.kill,
  );
  assert.deepEqual(fake.calls, ['assign 100']);
  assert.equal(tree.record(20_000), true);
  assert.deepEqual(await tree.end(20_000), [300, 400]);
  assert.deepEqual(fake.calls, ['assign 100', 'terminate 300', 'kill 400']);
  // The console host and the unrelated process are left.
  assert.deepEqual(
    table.map((row) => row.pid),
    [301, 700],
  );
  assert.equal(tree.record(20_000), false);
  tree.dispose();
  tree.dispose();
  assert.equal(fake.calls.filter((call) => call === 'close').length, 1);
});

test('without a Job, ending the tree still ends what the shell started and what it recorded', async () => {
  const table: Row[] = [
    { pid: 150, parent: 100, started: 10_050, name: 'cmd.exe' },
    { pid: 300, parent: 150, started: 10_060 },
    { pid: 700, parent: 7, started: 15_000 },
  ];
  const fake = fakeWindows(table, 'refused');
  const tree = new WindowsCommandTree(
    fake.api,
    { pid: 100, started: 10_000 },
    fake.kill,
  );
  // Windows refused the assignment: the Job is closed and not used.
  assert.deepEqual(fake.calls, ['assign 100', 'close']);
  // Seen when the shell ended, while the inner cmd still ran.
  assert.equal(tree.record(20_000), true);
  table.splice(0, 1);
  assert.deepEqual(await tree.end(20_000), [300]);
  assert.deepEqual(
    table.map((row) => row.pid),
    [700],
  );
});

test('ending a Windows tree waits for the terminated Job member to exit', async () => {
  const table: Row[] = [{ pid: 300, parent: 100, started: 10_060 }];
  const fake = fakeWindows(table, [300]);
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let terminating!: () => void;
  const requested = new Promise<void>((resolve) => {
    terminating = resolve;
  });
  fake.api.job!.terminate = async (_job, pid) => {
    assert.equal(pid, 300);
    terminating();
    await exited;
    table.splice(0, 1);
    return true;
  };
  const tree = new WindowsCommandTree(
    fake.api,
    { pid: 100, started: 10_000 },
    fake.kill,
  );
  let ended = false;
  const stopping = tree.end(20_000).then((pids) => {
    ended = true;
    return pids;
  });
  await requested;
  await Promise.resolve();
  assert.equal(
    ended,
    false,
    'a successful termination request is not process exit',
  );
  assert.equal(
    tree.record(20_000),
    true,
    'the still-exiting member remains owned',
  );
  finish();
  assert.deepEqual(await stopping, [300]);
  assert.equal(tree.record(20_000), false);
  assert.equal(
    fake.calls.some((call) => call.startsWith('kill ')),
    false,
  );
  tree.dispose();
});

test('a failed Windows Job member exit observation does not report a finished tree', async () => {
  const fake = fakeWindows([{ pid: 300, parent: 100, started: 10_060 }], [300]);
  const failure = Error('exit observation failed');
  fake.api.job!.terminate = async () => {
    throw failure;
  };
  const tree = new WindowsCommandTree(
    fake.api,
    { pid: 100, started: 10_000 },
    async () => {
      // The fallback also cannot confirm exit, so the member must stay owned.
      throw failure;
    },
  );
  await assert.rejects(
    tree.end(20_000),
    (error) =>
      error instanceof AggregateError && error.errors.includes(failure),
  );
  assert.equal(tree.record(20_000), true);
  tree.dispose();
});

test('an exit observation failure still ends the other Job members and outside trees', async () => {
  const table: Row[] = [
    { pid: 300, parent: 100, started: 10_060 },
    { pid: 301, parent: 100, started: 10_070 },
    { pid: 400, parent: 100, started: 10_080 },
  ];
  const fake = fakeWindows(table, [300, 301]);
  const observed: number[] = [];
  const failure = Error('exit observation failed');
  fake.api.job!.terminate = async (_job, pid) => {
    observed.push(pid);
    if (pid === 300) throw failure;
    table.splice(
      table.findIndex((row) => row.pid === pid),
      1,
    );
    return true;
  };
  const tree = new WindowsCommandTree(
    fake.api,
    { pid: 100, started: 10_000 },
    fake.kill,
  );
  await assert.rejects(
    tree.end(20_000),
    (error) =>
      error instanceof AggregateError && error.errors.includes(failure),
  );
  assert.deepEqual(observed, [300, 301]);
  assert.ok(fake.calls.includes('kill 400'));
  tree.dispose();
});

/** Records what the registry asks of each shell's tree. */
function trees(left: boolean) {
  const made: { pid: number; calls: string[] }[] = [];
  const factory = (shell: { pid: number }): CommandTree => {
    const calls: string[] = [];
    made.push({ pid: shell.pid, calls });
    return {
      record: () => {
        calls.push('record');
        return left;
      },
      end: async () => {
        calls.push('end');
      },
      dispose: () => calls.push('dispose'),
    };
  };
  return { made, factory };
}
function registry(
  t: TestContext,
  factory: (shell: { pid: number; started: number }) => CommandTree | undefined,
) {
  const root = scratch(t);
  const jobs = new JobRegistry(
    new Sandbox(root, join(root, 'data')),
    () => {},
    16,
    JobRegistry.outputLimit(),
    { commandTree: factory },
  );
  cleanup(t, () => jobs.close().then(() => {}));
  return { jobs, root };
}
const quick = `"${process.execPath}" -e "0"`;

test('what a finished command left running is ended when its job is stopped, its owner ends and Circle leaves', async (t) => {
  const { made, factory } = trees(true);
  const { jobs } = registry(t, factory);
  const job = await jobs.startShell(quick, { sessionId: 'one' });
  await until(() => jobs.get(job.id)!.status !== 'running', {
    timeout: 10_000,
  });
  assert.equal(jobs.get(job.id)!.status, 'done');
  assert.deepEqual(made[0]!.calls, ['record']);
  // Stopping a finished job no longer returns at once: it ends what its shell left.
  await jobs.stop(job.id, 'user');
  assert.deepEqual(made[0]!.calls, ['record', 'end', 'dispose']);
  assert.equal(jobs.get(job.id)!.status, 'done');
  await jobs.stop(job.id, 'user');
  assert.deepEqual(made[0]!.calls, ['record', 'end', 'dispose']);

  const owned = await jobs.startShell(quick, {
    sessionId: 'one',
    parent: 'agent-1',
  });
  const other = await jobs.startShell(quick, { sessionId: 'one' });
  await until(
    () =>
      jobs.get(owned.id)!.status !== 'running' &&
      jobs.get(other.id)!.status !== 'running',
    { timeout: 10_000 },
  );
  await jobs.stopOwned('agent-1');
  const callsOf = (id: string) =>
    made.find((tree) => tree.pid === jobs.get(id)!.execution?.pid)!.calls;
  assert.deepEqual(callsOf(owned.id), ['record', 'end', 'dispose']);
  assert.deepEqual(callsOf(other.id), ['record']);

  // A foreground command has no job; what it left is ended when Circle leaves.
  const result = await jobs.execute(
    quick,
    { sessionId: 'one' },
    new AbortController().signal,
  );
  assert.equal(result.exit_code, 0);
  await jobs.close();
  assert.deepEqual(callsOf(other.id), ['record', 'end', 'dispose']);
  assert.deepEqual(made.at(-1)!.calls, ['record', 'end', 'dispose']);
});

test('a command that leaves nothing lets its tree go, and a stopped command ends its tree once', async (t) => {
  const { made, factory } = trees(false);
  const { jobs, root } = registry(t, factory);
  const job = await jobs.startShell(quick, { sessionId: 'one' });
  await until(() => jobs.get(job.id)!.status !== 'running', {
    timeout: 10_000,
  });
  assert.deepEqual(made[0]!.calls, ['record', 'dispose']);
  await jobs.stop(job.id, 'user');
  assert.deepEqual(made[0]!.calls, ['record', 'dispose']);
  const wait = join(root, 'wait.cjs');
  writeFileSync(wait, 'setTimeout(() => {}, 30000);');
  const running = await jobs.startShell(`"${process.execPath}" "${wait}"`, {
    sessionId: 'one',
  });
  await jobs.stop(running.id, 'user');
  assert.equal(jobs.get(running.id)!.status, 'stopped');
  assert.deepEqual(made[1]!.calls, ['end', 'dispose']);
  await jobs.close();
  assert.deepEqual(made[1]!.calls, ['end', 'dispose']);
});

const windowsOnly = {
  skip: process.platform !== 'win32' && 'uses the Windows process list',
};
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** A program that writes its PID to a file and keeps running for a minute. */
function orphanScript(t: TestContext, root: string) {
  const pidFile = join(root, 'orphan.pid');
  const script = join(root, 'orphan.cjs');
  writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`,
  );
  let pid: number | undefined;
  t.after(() => {
    if (pid && alive(pid)) process.kill(pid);
  });
  return {
    // `cmd /c` inside the shell: the inner cmd ends at once, and the program's parent PID
    // points at it, out of reach of `taskkill /T` on the shell.
    command: `cmd /c start "" /b "${process.execPath}" "${script}"`,
    pid: async (): Promise<number> => {
      await until(
        () =>
          existsSync(pidFile) && /^\d+$/.test(readFileSync(pidFile, 'utf8')),
        { timeout: 10_000 },
      );
      pid = Number(readFileSync(pidFile, 'utf8'));
      return pid;
    },
  };
}

test(
  'on Windows a program left running by an ended shell is found and ended',
  windowsOnly,
  async (t) => {
    const api = await loadChildrenApi();
    const started = Date.now();
    // start /b leaves node running after cmd ends, as a program the shell started just after
    // taskkill had looked at its tree.
    const line = `start "" /b "${process.execPath}" -e "console.log(process.pid); setTimeout(function () {}, 30000)"`;
    const shellProcess = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    const tree = new WindowsCommandTree(api, {
      pid: shellProcess.pid!,
      started,
    });
    t.after(() => tree.dispose());
    let output = '';
    shellProcess.stdout.on('data', (chunk: Buffer) => (output += chunk));
    await once(shellProcess, 'exit');
    const ended = Date.now();
    while (!/^\d+\s*$/m.test(output)) await delay(20);
    const orphan = Number(/^(\d+)/m.exec(output)![1]);
    t.after(() => {
      if (alive(orphan)) process.kill(orphan);
    });
    assert.ok(alive(orphan), 'the program outlived its shell');
    // What the ended shell left: its program and, without a console to inherit, the console
    // host Windows started for it.
    const left = api
      .processes()
      .filter((entry) => entry.parent === shellProcess.pid);
    const names = JSON.stringify(left);
    assert.ok(
      left.some((entry) => entry.pid === orphan),
      `the program is listed: ${names}`,
    );
    assert.ok(
      left.every(
        (entry) =>
          entry.pid === orphan || entry.name.toLowerCase() === 'conhost.exe',
      ),
      `nothing else was left: ${names}`,
    );
    assert.equal(tree.record(ended), true);
    // Only the command's program is ended.
    assert.deepEqual(await tree.end(ended), [orphan], names);
    await until(() => !alive(orphan), { timeout: 10_000 });
  },
);

test(
  'on Windows stopping a finished job ends a program whose parent cmd had already ended',
  windowsOnly,
  async (t) => {
    await loadChildrenApi();
    const root = scratch(t);
    const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
    cleanup(t, () => jobs.close().then(() => {}));
    const orphan = orphanScript(t, root);
    const job = await jobs.startShell(orphan.command, { sessionId: 'one' });
    const pid = await orphan.pid();
    await until(() => jobs.get(job.id)!.status !== 'running', {
      timeout: 10_000,
    });
    assert.equal(jobs.get(job.id)!.status, 'done');
    assert.ok(alive(pid), 'the program outlived both cmds');
    await jobs.stop(job.id, 'user');
    await until(() => !alive(pid), { timeout: 10_000 });
  },
);

test(
  'on Windows cancelling a running command ends a program whose parent cmd had already ended',
  windowsOnly,
  async (t) => {
    await loadChildrenApi();
    const root = scratch(t);
    const jobs = new JobRegistry(new Sandbox(root, join(root, 'data')));
    cleanup(t, () => jobs.close().then(() => {}));
    const orphan = orphanScript(t, root);
    const wait = join(root, 'wait.cjs');
    writeFileSync(wait, 'setTimeout(() => {}, 60000);');
    const controller = new AbortController();
    // The outer shell keeps running after the inner cmd has ended.
    const run = jobs.execute(
      `${orphan.command} & "${process.execPath}" "${wait}"`,
      { sessionId: 'one' },
      controller.signal,
    );
    const pid = await orphan.pid();
    assert.ok(alive(pid));
    controller.abort(new Error('Interrupted'));
    await assert.rejects(run, /Interrupted/);
    await until(() => !alive(pid), { timeout: 10_000 });
  },
);

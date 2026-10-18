import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { WorkspaceDebugService } from '../src/workspace/debug.ts';

test('debug stop is shared and remains stopping until owned process cleanup completes', async () => {
  const adapter = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  await once(adapter, 'spawn');
  const debuggee = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    stdio: 'ignore',
  });
  await once(debuggee, 'spawn');
  const debuggeeExited = once(debuggee, 'exit');
  const exited = once(adapter, 'exit');
  let finishCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  let enteredCleanup!: () => void;
  const entered = new Promise<void>((resolve) => {
    enteredCleanup = resolve;
  });
  const statuses: string[] = [];
  const service = new WorkspaceDebugService({
    workspaceRoot: process.cwd(),
    nodeExecutable: process.execPath,
    adapterPath: 'unused',
    emit: (snapshot) => statuses.push(snapshot.status),
    stopTerminals: async () => {
      enteredCleanup();
      await cleanup;
      debuggee.kill();
      await debuggeeExited;
    },
  });
  // A live owned adapter, without requiring a downloaded DAP executable.
  (service as any).adapter = adapter;
  try {
    const first = service.stop();
    const second = service.stop();
    assert.equal(first, second, 'parallel stop requests share one teardown');
    await entered;
    await exited;
    assert.equal(service.snapshot().status, 'stopping');
    assert.equal(statuses.includes('stopped'), false);
    assert.throws(() => process.kill(adapter.pid!, 0), /ESRCH/);
    await assert.rejects(service.handle('attach', { port: 9229 }), /stopping/);
    finishCleanup();
    await first;
    assert.equal(service.snapshot().status, 'stopped');
    assert.throws(() => process.kill(debuggee.pid!, 0), /ESRCH/);
    assert.deepEqual(statuses, ['stopping', 'stopped']);
  } finally {
    finishCleanup();
    await service.dispose();
    adapter.kill();
    debuggee.kill();
  }
});

test('attach stop detaches without claiming ownership; cleanup failure is not stopped', async () => {
  const calls: unknown[] = [];
  let fail = true;
  const service = new WorkspaceDebugService({
    workspaceRoot: process.cwd(),
    nodeExecutable: process.execPath,
    adapterPath: 'unused',
    stopTerminals: async () => {
      if (fail) throw Error('owned terminal could not exit');
    },
  });
  (service as any).dap = {
    request: async (_method: string, params: unknown) => calls.push(params),
  };
  await assert.rejects(service.stop(), /could not exit/);
  assert.deepEqual(calls, [{ terminateDebuggee: false }]);
  assert.equal(service.snapshot().status, 'failed');
  assert.match(service.snapshot().reason!, /could not exit/);
  fail = false;
  await service.stop();
  assert.equal(service.snapshot().status, 'stopped');
});

test('adapter cleanup failure still closes owned debug terminals', async () => {
  let closed = false;
  const service = new WorkspaceDebugService({
    workspaceRoot: process.cwd(),
    nodeExecutable: process.execPath,
    adapterPath: 'unused',
    stopTerminals: async () => {
      closed = true;
    },
  });
  const adapter = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill() {
      queueMicrotask(() => adapter.emit('error', Error('cannot stop adapter')));
    },
  });
  (service as any).adapter = adapter;
  await assert.rejects(service.stop(), /cannot stop adapter/);
  assert.equal(closed, true);
  assert.equal(service.snapshot().status, 'failed');
  (service as any).adapter = undefined;
  await service.dispose();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startNativePerformanceCpuProfile,
  stopNativePerformanceCpuProfile,
} from './helpers/native-performance-cpu-profile.mjs';

test('owned CDP profiler saves samples, detaches, and evidence failure cannot bypass synthetic cleanup', async () => {
  const calls = [],
    report = {};
  const session = {
    send: async (name) => {
      calls.push(name);
      return name === 'Profiler.stop'
        ? { profile: { nodes: [], samples: [1] } }
        : {};
    },
    detach: async () => calls.push('detach'),
  };
  const handle = await startNativePerformanceCpuProfile(
    { context: () => ({ newCDPSession: async () => session }) },
    report,
  );
  try {
  } finally {
    await stopNativePerformanceCpuProfile(
      handle,
      '/owned/synthetic',
      report,
      async () => {
        throw Object.assign(Error('full'), { code: 'ENOSPC' });
      },
    );
    calls.push('clipboard-restored', 'owned-app-closed');
  }
  assert.deepEqual(calls, [
    'Profiler.enable',
    'Profiler.start',
    'Profiler.stop',
    'detach',
    'clipboard-restored',
    'owned-app-closed',
  ]);
  assert.equal(report.cpuProfile.saved, false);
  assert.equal(report.diagnosticWriteErrors[0].code, 'ENOSPC');
});
test('profiler start and stop failures stay diagnostic and detach their owned session', async () => {
  for (const failing of ['Profiler.start', 'Profiler.stop']) {
    const calls = [],
      report = {};
    const session = {
      send: async (name) => {
        calls.push(name);
        if (name === failing) throw Error('synthetic profiler unavailable');
        return {};
      },
      detach: async () => calls.push('detach'),
    };
    const handle = await startNativePerformanceCpuProfile(
      { context: () => ({ newCDPSession: async () => session }) },
      report,
    );
    await stopNativePerformanceCpuProfile(handle, '/owned', report);
    assert.equal(calls.at(-1), 'detach');
    assert.ok(report.cpuProfile.unavailable || report.cpuProfile.stopError);
  }
});

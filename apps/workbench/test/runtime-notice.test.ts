import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRuntimeNotice,
  runtimeStoppedNotice,
} from '../src/model/runtime-notice.ts';
import { setLanguage } from '../src/i18n/index.ts';
import { githubStatusNotice } from '../../../src/runtime_notice.ts';
test('runtime status localization requires the exact persisted source and canonical text, never a matching model sentence', () => {
  try {
    setLanguage('zh-CN');
    const runtimeNotice = githubStatusNotice('GitHub: connected', true)!;
    assert.equal(
      formatRuntimeNotice({
        role: 'notice',
        text: 'GitHub: connected',
        runtimeNotice,
      }),
      '已连接 GitHub',
    );
    for (const role of ['user', 'assistant', 'tool'] as const)
      assert.equal(
        formatRuntimeNotice({ role, text: 'GitHub: connected', runtimeNotice }),
        'GitHub: connected',
      );
    assert.equal(
      formatRuntimeNotice({ role: 'notice', text: 'GitHub: connected' }),
      'GitHub: connected',
    );
    assert.equal(
      formatRuntimeNotice({
        role: 'notice',
        text: 'model description GitHub: connected',
        runtimeNotice,
      }),
      'model description GitHub: connected',
    );
    assert.equal(
      formatRuntimeNotice({
        role: 'notice',
        text: 'GitHub: disconnected',
        runtimeNotice,
      }),
      'GitHub: disconnected',
    );
    assert.equal(githubStatusNotice('GitHub: connected', false), undefined);
    assert.equal(githubStatusNotice('GitHub: unknown', true), undefined);
  } finally {
    setLanguage('en');
  }
});

test('a stopped desktop runtime is described in the interface language with its exit code', () => {
  const runtime = {
    connected: false,
    configured: true,
    error: 'Circle runtime crashed (4294930435 (0xFFFF7003))',
    stopped: {
      reason: 'crashed' as const,
      code: '4294930435 (0xFFFF7003)',
      restarting: true,
      at: '2026-10-19T00:00:00.000Z',
    },
  };
  try {
    setLanguage('en');
    assert.equal(
      runtimeStoppedNotice(runtime),
      'Circle runtime crashed (4294930435 (0xFFFF7003)) · restarting…',
    );
    assert.equal(
      runtimeStoppedNotice({
        ...runtime,
        stopped: {
          ...runtime.stopped,
          reason: 'out-of-memory',
          restarting: false,
        },
      }),
      'Circle runtime ran out of memory (4294930435 (0xFFFF7003)) · restart it from the sidebar',
    );
    setLanguage('zh-CN');
    assert.equal(
      runtimeStoppedNotice(runtime),
      'Circle 运行时崩溃 (4294930435 (0xFFFF7003)) · 正在重启…',
    );
    // A running runtime, or one that never stopped, has no such notice.
    assert.equal(
      runtimeStoppedNotice({ ...runtime, connected: true }),
      undefined,
    );
    assert.equal(
      runtimeStoppedNotice({ connected: false, configured: false }),
      undefined,
    );
  } finally {
    setLanguage('en');
  }
});

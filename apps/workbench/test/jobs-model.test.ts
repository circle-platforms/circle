import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionJobs } from '../src/model/jobs.ts';
import type { Job } from '../src/model/types.ts';

const job = (id: string, extra: Partial<Job> = {}): Job =>
  ({
    id,
    sessionId: 's1',
    kind: 'command',
    title: `npm run ${id}`,
    state: 'running',
    elapsed: '1m 32s',
    output: '',
    outputPath: '',
    stopRequested: false,
    ...extra,
  }) as Job;

test("the background jobs mode lists this conversation's commands, going ones first", () => {
  const { running, ended } = sessionJobs('s1', [
    job('j1', { state: 'completed' }),
    job('j2', { state: 'failed' }),
    job('j6'),
    job('j7', { state: 'waiting' }),
    job('j8', { state: 'stopping' }),
    job('other', { sessionId: 's2' }),
    job('watch', { kind: 'watch' }),
    job('agent', { kind: 'agent' }),
  ]);
  assert.deepEqual(
    running.map((item) => item.id),
    ['j6', 'j7', 'j8'],
  );
  // The latest that ended comes first.
  assert.deepEqual(
    ended.map((item) => item.id),
    ['j2', 'j1'],
  );
  assert.deepEqual(sessionJobs('s1', []), { running: [], ended: [] });
});

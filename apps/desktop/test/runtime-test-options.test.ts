import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runtimeTestArguments } from '../scripts/runtime-test-options.mjs';
const exec = promisify(execFile);
const tsx = fileURLToPath(
  new URL('../../../node_modules/tsx/dist/cli.mjs', import.meta.url),
);

test('runtime test runner retains every file, uses two real file workers and emits immediate TAP failures', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'circle-runtime-workers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = join(directory, 'events.jsonl');
  const files = await Promise.all(
    [0, 1, 2].map(async (id) => {
      const file = join(directory, `worker-${id}.test.mjs`);
      await writeFile(
        file,
        `import test from 'node:test';import assert from 'node:assert/strict';import {appendFileSync} from 'node:fs';import {setTimeout} from 'node:timers/promises';
    const record=event=>appendFileSync(${JSON.stringify(events)},JSON.stringify({event,id:${id}})+'\\n');
    test('real worker ${id}',async()=>{record('start');try{await setTimeout(500);${id === 2 ? "assert.equal('observed','expected');" : ''}}finally{record('end')}});`,
      );
      return file;
    }),
  );
  const args = runtimeTestArguments(tsx, files, { ci: true });
  assert.deepEqual(args.slice(-3), files);
  assert.ok(args.includes('--test-concurrency=2'));
  let output = '';
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  await assert.rejects(
    exec(process.execPath, args, { timeout: 15_000, env }),
    (error: unknown) => {
      const failed = error as { code: number; stdout: string };
      assert.equal(failed.code, 1);
      output = failed.stdout;
      return true;
    },
  );
  assert.match(output, /not ok .*real worker 2/);
  assert.match(output, /expected: 'expected'/);
  assert.match(output, /actual: 'observed'/);
  const live = new Set<number>();
  const completed = new Set<number>();
  let peak = 0;
  for (const line of (await readFile(events, 'utf8')).trim().split('\n')) {
    const entry = JSON.parse(line) as { id: number; event: string };
    if (entry.event === 'start') live.add(entry.id);
    else {
      live.delete(entry.id);
      completed.add(entry.id);
    }
    peak = Math.max(peak, live.size);
  }
  assert.equal(peak, 2);
  assert.deepEqual([...completed].sort(), [0, 1, 2]);
  assert.equal(live.size, 0);
  assert.equal(
    runtimeTestArguments(tsx, files).includes('--test-reporter=tap'),
    false,
  );
});

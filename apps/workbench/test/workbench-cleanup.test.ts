import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

for (const failure of ['warm', 'launch', 'close']) {
  test(`failed ${failure} closes the listening Vite server before any Page exists`, async (t) => {
    const scratch = await mkdtemp(join(tmpdir(), 'circle-workbench-cleanup-'));
    t.after(() => rm(scratch, { recursive: true, force: true }));
    const env = { ...process.env };
    // This child owns its test runner, rather than the parent's IPC reporter.
    delete env.NODE_TEST_CONTEXT;
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          '--test',
          '--test-isolation=none',
          '--test-reporter=spec',
          'test/helpers/workbench-failure-fixture.ts',
        ],
        {
          cwd: fileURLToPath(new URL('..', import.meta.url)),
          env: {
            ...env,
            CIRCLE_HOME: join(scratch, 'home'),
            CIRCLE_WORKBENCH_DATA_DIR: join(scratch, 'desktop'),
            CIRCLE_FIXTURE_ROOT: scratch,
            CIRCLE_FIXTURE_FAILURE: failure,
          },
          timeout: 15000,
          windowsHide: true,
        },
      ),
      (error: unknown) => {
        const result = error as Error & {
          code?: number;
          killed?: boolean;
          stdout?: string;
        };
        assert.equal(result.code, 1, result.message);
        assert.notEqual(result.killed, true, 'failed test must exit itself');
        assert.match(
          result.stdout ?? '',
          failure === 'warm'
            ? /missing-entry/
            : failure === 'launch'
              ? /fixture browser launch failed/
              : /workbench cleanup failed/,
        );
        return true;
      },
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(scratch, 'closed.json'), 'utf8')),
      {
        listening: false,
      },
    );
    const port = Number(await readFile(join(scratch, 'port.txt'), 'utf8'));
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

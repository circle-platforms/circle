import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { scripts } = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
);

for (const command of ['test', 'test:runtime']) {
  test(`${command} finishes cold Electron preparation before any parallel test worker starts`, async (t) => {
    const directory = await mkdtemp(
      join(tmpdir(), 'circle-electron-preflight-'),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const electron = join(directory, 'node_modules', 'electron');
    await mkdir(electron, { recursive: true });
    // A worker must never perform extraction. The marker represents the
    // completed download/extraction that Electron's synchronous require awaits.
    await writeFile(
      join(electron, 'index.js'),
      `const fs = require('node:fs');
const path = require('node:path');
const ready = path.join(__dirname, 'ready.json');
if (!fs.existsSync(ready)) {
  if (process.env.NODE_TEST_CONTEXT) throw Error('worker reached cold Electron');
  fs.writeFileSync(ready, JSON.stringify({pid: process.pid}));
}
module.exports = process.execPath;
`,
    );
    for (const worker of [1, 2]) {
      await writeFile(
        join(directory, `worker-${worker}.test.cjs`),
        `const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
test('worker ${worker}', () => {
  assert.equal(require('electron'), process.execPath);
  const ready = JSON.parse(fs.readFileSync('node_modules/electron/ready.json', 'utf8'));
  assert.notEqual(ready.pid, process.pid);
  fs.writeFileSync('worker-${worker}.json', JSON.stringify({pid: process.pid, preparedBy: ready.pid}));
});
`,
      );
    }
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          [`pre${command}`]: scripts[`pre${command}`],
          [command]:
            'node --test --test-concurrency=2 worker-1.test.cjs worker-2.test.cjs',
        },
      }),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', command],
      {
        cwd: directory,
        env,
        shell: process.platform === 'win32',
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const [first, second] = await Promise.all(
      [1, 2].map(async (worker) =>
        JSON.parse(
          await readFile(join(directory, `worker-${worker}.json`), 'utf8'),
        ),
      ),
    );
    assert.notEqual(first.pid, second.pid);
    assert.equal(first.preparedBy, second.preparedBy);
  });
}

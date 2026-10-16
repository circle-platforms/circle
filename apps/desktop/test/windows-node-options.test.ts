import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('Windows-shaped preload paths use Node option escaping, not shell quoting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-node-options-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const preload = join(
    root,
    process.platform === 'win32' ? 'pre load.cjs' : 'C:\\Users\\pre load.cjs',
  );
  await writeFile(preload, "console.log('ACTUAL_PRELOAD');");
  const raw = spawnSync(
    process.execPath,
    ['-e', "console.log('ACTUAL_BODY')"],
    {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--require="' + preload + '"' },
    },
  );
  assert.equal(
    raw.status,
    1,
    'unescaped backslashes are consumed by the real Node option parser',
  );
  assert.match(raw.stderr, /MODULE_NOT_FOUND/);
  const escaped = spawnSync(
    process.execPath,
    ['-e', "console.log('ACTUAL_BODY')"],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: '--require=' + JSON.stringify(preload),
      },
    },
  );
  assert.equal(escaped.status, 0, escaped.stderr);
  assert.match(escaped.stdout, /ACTUAL_PRELOAD[\r\n]+ACTUAL_BODY/);
});

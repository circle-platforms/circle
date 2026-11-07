import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readDebuggingPort } from './helpers/debugging-port.mjs';

const failing = (code) => async () => {
  throw Object.assign(Error(code), { code });
};

test('the debugging port is read from the file Chromium writes', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-debugging-port-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const file = join(folder, 'DevToolsActivePort');
  assert.equal(await readDebuggingPort(file), undefined);
  await writeFile(file, '');
  assert.equal(await readDebuggingPort(file), undefined);
  await writeFile(file, '49747\n/devtools/browser/fixture\n');
  assert.equal(await readDebuggingPort(file), 49747);
});

test('a file Chromium still holds is not written yet', async () => {
  assert.equal(
    await readDebuggingPort('DevToolsActivePort', failing('EBUSY')),
    undefined,
  );
});

test('any other read failure is not mistaken for waiting', async () => {
  await assert.rejects(
    readDebuggingPort('DevToolsActivePort', failing('EACCES')),
    { code: 'EACCES' },
  );
});

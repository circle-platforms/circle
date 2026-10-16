import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';
import { previewPort } from './preview-port.ts';

test('a preview port is free unless one was requested', async () => {
  assert.equal(await previewPort('4217'), 4217);
  await assert.rejects(() => previewPort('nope'), /nope is not a port/);
  const port = await previewPort('');
  assert.equal(Number.isInteger(port) && port > 0, true);
  const held = createServer();
  await new Promise<void>((resolve, reject) => {
    held.once('error', reject);
    held.listen(port, '127.0.0.1', () => resolve());
  });
  try {
    const other = await previewPort('');
    assert.notEqual(other, port);
  } finally {
    await new Promise<void>((resolve, reject) =>
      held.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

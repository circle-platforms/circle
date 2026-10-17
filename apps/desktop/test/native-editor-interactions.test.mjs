import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createNativeEditorInteractionsFixture,
  interactionFile,
  interactionSource,
} from './helpers/native-editor-interactions.mjs';
test('native keyboard fixture creates an isolated module and refuses to replace developer content', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-editor-interactions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createNativeEditorInteractionsFixture(root);
  const file = join(root, interactionFile);
  assert.equal(await readFile(file, 'utf8'), interactionSource);
  await writeFile(file, 'developer owned content');
  await assert.rejects(createNativeEditorInteractionsFixture(root), {
    code: 'EEXIST',
  });
  assert.equal(await readFile(file, 'utf8'), 'developer owned content');
});

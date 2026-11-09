import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NOT_TEXT,
  pictureType,
  WorkspaceDocuments,
} from '../src/workspace/documents.ts';
import { workspaceFileToReveal } from '../src/reveal.ts';

const windows = process.platform === 'win32';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=',
  'base64',
);

// A workspace with a picture, a file whose name says picture and is not one, a file that is
// not text, a large picture, and a picture beside the workspace reached by a link
async function fixture(t: TestContext) {
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), 'circle-file-types-')),
  );
  const root = join(scratch, 'workspace');
  await mkdir(join(root, 'designs'), { recursive: true });
  await writeFile(join(root, 'designs', 'a-light.png'), PNG);
  await writeFile(join(root, 'designs', 'fake.png'), 'not a picture\n');
  await writeFile(
    join(root, 'designs', 'blob.bin'),
    Buffer.from([0xff, 0xfe, 0x00, 0x81]),
  );
  await writeFile(
    join(root, 'designs', 'big.png'),
    Buffer.concat([PNG, Buffer.alloc(64)]),
  );
  await writeFile(join(scratch, 'outside.png'), PNG);
  // Windows makes a file link only with rights a runner may not have
  if (!windows)
    await symlink(
      join(scratch, 'outside.png'),
      join(root, 'designs', 'link.png'),
    );
  const documents = new WorkspaceDocuments(root, { maxPictureBytes: 100 });
  t.after(async () => {
    documents.close();
    await rm(scratch, { recursive: true, force: true });
  });
  return { scratch, root, documents };
}

test('a picture is read as its bytes when its name and its first bytes agree', async (t) => {
  const { documents } = await fixture(t);
  assert.deepEqual(await documents.readImage('designs/a-light.png'), {
    path: 'designs/a-light.png',
    mime: 'image/png',
    data: PNG.toString('base64'),
    size: PNG.length,
  });
  assert.equal(pictureType('x/Y.JPEG'), 'image/jpeg');
  assert.equal(pictureType('x/y.svg'), undefined);
  await assert.rejects(
    documents.readImage('designs/fake.png'),
    /not the picture its name says/,
  );
  await assert.rejects(
    documents.readImage('designs/blob.bin'),
    /not a picture the window shows/,
  );
  await assert.rejects(documents.readImage('designs/big.png'), /too large/);
  // The same checks as a text read: no link out of the workspace, no parent folder
  if (!windows)
    await assert.rejects(
      documents.readImage('designs/link.png'),
      /symbolic link/,
    );
  await assert.rejects(documents.readImage('../outside.png'));
});

test("a file that is not text says so in words, not the decoder's, and is still found", async (t) => {
  const { documents } = await fixture(t);
  await assert.rejects(documents.read('designs/blob.bin'), {
    message: NOT_TEXT,
  });
  await assert.rejects(documents.read('designs/a-light.png'), {
    message: NOT_TEXT,
  });
  // Found without being read as text, so the window can open it by its type
  assert.deepEqual(await documents.locate('designs/a-light.png'), {
    path: 'designs/a-light.png',
  });
  assert.deepEqual(await documents.locate('designs/blob.bin'), {
    path: 'designs/blob.bin',
  });
  await assert.rejects(documents.locate('designs'), /not a regular file/);
  await assert.rejects(documents.locate('designs/missing.png'));
});

test('a file is shown in its folder only while it is in the workspace', async (t) => {
  const { scratch, root } = await fixture(t);
  assert.equal(
    await workspaceFileToReveal(root, 'designs/blob.bin'),
    join(root, 'designs', 'blob.bin'),
  );
  for (const path of [
    '',
    '../outside.png',
    'designs/../../outside.png',
    join(scratch, 'outside.png'),
    ...(windows ? [] : ['designs/link.png']),
  ])
    await assert.rejects(
      workspaceFileToReveal(root, path),
      /not a file of this workspace/,
      path,
    );
  await assert.rejects(
    workspaceFileToReveal(root, 'designs/missing.png'),
    /does not exist/,
  );
});

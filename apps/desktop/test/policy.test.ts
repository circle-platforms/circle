import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assetPath,
  boundedText,
  safeExternalUrl,
  trustedAppUrl,
  validSaveName,
} from '../src/policy.ts';
import { nativeFile, WorkspaceGrants } from '../src/files.ts';

test('only the application frame URL is trusted', () => {
  assert.equal(trustedAppUrl('circle://workbench/index.html#/session/a'), true);
  for (const value of [
    'https://example.test',
    'file:///tmp/index.html',
    'circle://other/index.html',
    'circle://workbench/assets/evil.html',
  ])
    assert.equal(trustedAppUrl(value), false);
});
test('local protocol assets cannot escape the bundled renderer', () => {
  assert.equal(
    assetPath('/app/renderer', 'circle://workbench/assets/app.js'),
    '/app/renderer/assets/app.js',
  );
  for (const url of [
    'circle://other/index.html',
    'circle://workbench/%2e%2e%2fsecret',
    'circle://workbench/%5csecret',
    'circle://workbench/%00secret',
  ])
    assert.throws(() => assetPath('/app/renderer', url));
});
test('exports require a filename and bounded content', () => {
  assert.equal(validSaveName('session.md'), 'session.md');
  for (const value of ['../secret', 'a/b', 'a\\b', '..', 'a\0b', ''])
    assert.throws(() => validSaveName(value));
  assert.equal(boundedText('ok', 2), 'ok');
  assert.throws(() => boundedText('exceeds', 3));
  assert.throws(() => boundedText({ text: 'x' }, 100));
});
test('external links only admit ordinary HTTP URLs', () => {
  assert.equal(
    safeExternalUrl('https://example.test/docs'),
    'https://example.test/docs',
  );
  for (const url of [
    'javascript:alert(1)',
    'file:///tmp/x',
    'data:text/html,evil',
    'https://user:secret@example.test',
  ])
    assert.equal(safeExternalUrl(url), undefined);
});
test('workspace grants reject unknown, cross-workspace and escaped handles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-grants-'));
  try {
    const a = join(root, 'a'),
      b = join(root, 'b');
    await mkdir(a);
    await mkdir(b);
    await writeFile(join(a, 'note.md'), '# granted content');
    await writeFile(join(b, 'outside.md'), 'outside');
    await symlink(join(b, 'outside.md'), join(a, 'outside-link.md'));
    const grants = new WorkspaceGrants();
    const first = await grants.open(a),
      second = await grants.open(b);
    assert.equal(first.files.length, 1);
    const file = await grants.read(first.id, first.files[0]!.id);
    assert.equal(file.content, '# granted content');
    await assert.rejects(
      () => grants.read(second.id, first.files[0]!.id),
      /not granted/,
    );
    await assert.rejects(
      () => grants.read(first.id, '../../outside.md'),
      /not granted/,
    );
    await rm(join(a, 'note.md'));
    await symlink(join(b, 'outside.md'), join(a, 'note.md'));
    await assert.rejects(
      () => grants.read(first.id, first.files[0]!.id),
      /symbolic link/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('native text preview discloses truncation and supports full import text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-file-'));
  try {
    const path = join(root, 'large.md');
    await writeFile(path, 'x'.repeat(300_000));
    const preview = await nativeFile(path);
    assert.equal(preview.truncated, true);
    assert.equal(preview.content.length, 256_000);
    const imported = await nativeFile(path, 4_000_000);
    assert.equal(imported.truncated, false);
    assert.equal(imported.content.length, 300_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chosen pictures and PDFs go whole up to 20 MB, other files up to 4 MB', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-native-files-'));
  try {
    const picture = join(root, 'screen.png');
    await writeFile(picture, Buffer.alloc(6_000_000, 1));
    const chosen = await nativeFile(picture);
    assert.equal(chosen.kind, 'image');
    assert.equal(chosen.size, 6_000_000);
    const pdf = join(root, 'paper.pdf');
    await writeFile(pdf, '%PDF-1.7 a small paper');
    const document = await nativeFile(pdf);
    assert.equal(document.kind, 'document');
    assert.equal(
      document.content,
      'data:application/pdf;base64,' +
        Buffer.from('%PDF-1.7 a small paper').toString('base64'),
    );
    const large = join(root, 'large.png');
    await writeFile(large, Buffer.alloc(21 * 1024 * 1024, 1));
    await assert.rejects(nativeFile(large), /large\.png is over 20 MB/);
    const notes = join(root, 'notes.txt');
    await writeFile(notes, Buffer.alloc(4_100_000, 97));
    await assert.rejects(nativeFile(notes), /notes\.txt is over 4 MB/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

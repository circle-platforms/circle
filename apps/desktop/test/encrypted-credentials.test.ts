import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  EncryptedCredentialStore,
  nativeHttpsUrl,
} from '../src/encrypted-credentials';
function cipher() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const b = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), b]);
    },
    decryptString(value: Buffer) {
      const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(
        'utf8',
      );
    },
  };
}
test('credential persists encrypted bytes, serializes writes and deletes only its own key', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    const store = new EncryptedCredentialStore(folder, cipher());
    assert.equal(await store.get('github'), undefined);
    await Promise.all([
      store.put('github', 'private-secret-first'),
      store.put('github', 'private-secret-final'),
    ]);
    await store.put('other', 'other-private-token');
    assert.equal(await store.get('github'), 'private-secret-final');
    const files = await readdir(folder);
    assert.equal(files.length, 2);
    for (const file of files) {
      assert.match(file, /^[a-f0-9]{64}\.bin$/);
      assert(
        !(await readFile(join(folder, file))).includes(
          Buffer.from('private-secret'),
        ),
      );
      if (process.platform !== 'win32')
        assert.equal((await stat(join(folder, file))).mode & 0o777, 0o600);
    }
    await store.delete('github');
    assert.equal(await store.get('github'), undefined);
    assert.equal(await store.get('other'), 'other-private-token');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('missing secure backend and plaintext Linux fallback refuse persistence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    for (const storage of [
      { ...cipher(), isEncryptionAvailable: () => false },
      { ...cipher(), getSelectedStorageBackend: () => 'basic_text' },
    ]) {
      const store = new EncryptedCredentialStore(folder, storage);
      await assert.rejects(store.put('github', 'secret'), /unavailable/);
      assert.deepEqual(await readdir(folder), []);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
test('credential identities, values and HTTPS native links are bounded and validated', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    const store = new EncryptedCredentialStore(folder, cipher());
    await assert.rejects(store.put('', 'token'), /identity/);
    await assert.rejects(store.put('a', 'x'.repeat(1048577)), /value/);
    assert.equal(
      nativeHttpsUrl('https://github.com/example/repo/pull/1'),
      'https://github.com/example/repo/pull/1',
    );
    for (const value of [
      'http://github.com',
      'file:///tmp/a',
      'javascript:alert(1)',
      'https://token@github.com',
      null,
      'https://' + 'a'.repeat(8200),
    ])
      assert.throws(() => nativeHttpsUrl(value));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

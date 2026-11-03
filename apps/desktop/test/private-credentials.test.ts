import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import {
  CredentialReentryRequired,
  OwnerOnlyCredentialStore,
  PRIVATE_CREDENTIALS_FILE,
  credentialsAfter,
  migrateEncryptedCredentials,
} from '../src/private-credentials';
import { nativeHttpsUrl } from '../src/native-links';
import {
  CREDENTIAL_REENTRY,
  RuntimeCredentialClient,
  executeCredentialRequest,
} from '../src/runtime-private-channel';

// A fake of the earlier safeStorage cipher; the fixture store is written with it.
function cipher() {
  const key = randomBytes(32);
  let decrypts = 0;
  return {
    get decrypts() {
      return decrypts;
    },
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const b = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), b]);
    },
    decryptString(value: Buffer) {
      decrypts++;
      const c = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      c.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([c.update(value.subarray(28)), c.final()]).toString(
        'utf8',
      );
    },
  };
}
const legacyName = (key: string) =>
  createHash('sha256').update(key).digest('hex') + '.bin';
async function legacyStore(
  folder: string,
  entries: Record<string, Buffer>,
): Promise<string> {
  const legacy = join(folder, 'private-credentials');
  await mkdir(legacy, { recursive: true, mode: 0o700 });
  for (const [name, bytes] of Object.entries(entries))
    await writeFile(join(legacy, name), bytes, { mode: 0o600 });
  return legacy;
}
const ownerOnly = async (path: string) =>
  process.platform === 'win32' || ((await stat(path)).mode & 0o777) === 0o600;

test('credentials are kept in one owner-only file, serialized, and deleted only by their own key', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    const home = join(folder, 'runtime-home');
    const store = new OwnerOnlyCredentialStore(home);
    assert.equal(await store.get('github.com'), undefined);
    await Promise.all([
      store.put('github.com', 'synthetic-secret-first'),
      store.put('github.com', 'synthetic-secret-final'),
    ]);
    await store.put('other', 'synthetic-other-token');
    assert.equal(await store.get('github.com'), 'synthetic-secret-final');
    const path = join(home, PRIVATE_CREDENTIALS_FILE);
    assert.equal(store.path, path);
    assert.match(PRIVATE_CREDENTIALS_FILE, /\.secrets\.json$/);
    // Stored as they are, as the terminal stores credentials.json and secrets.json.
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), {
      credentials: {
        'github.com': 'synthetic-secret-final',
        other: 'synthetic-other-token',
      },
    });
    assert.ok(await ownerOnly(path), 'the file is readable only by its owner');
    assert.deepEqual(
      (await readdir(home)).filter((name) => !name.endsWith('.lock')),
      [PRIVATE_CREDENTIALS_FILE],
    );
    await store.delete('github.com');
    assert.equal(await store.get('github.com'), undefined);
    assert.equal(await store.get('other'), 'synthetic-other-token');
    assert.ok(await ownerOnly(path));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('the first start moves the encrypted store into the owner-only file and removes it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    const fake = cipher();
    const legacy = await legacyStore(folder, {
      [legacyName('github.com')]: fake.encryptString('synthetic-github-token'),
      // An entry no key of the desktop names: nothing could read it, it goes with the folder.
      [legacyName('retired')]: fake.encryptString('synthetic-retired'),
    });
    const store = new OwnerOnlyCredentialStore(join(folder, 'runtime-home'));
    assert.deepEqual(await migrateEncryptedCredentials(legacy, store, fake), {
      moved: ['github.com'],
      reenter: [],
    });
    assert.equal(await store.get('github.com'), 'synthetic-github-token');
    await assert.rejects(stat(legacy), { code: 'ENOENT' });
    assert.ok(await ownerOnly(store.path));
    assert.equal(fake.decrypts, 1);
    // Once moved, a later start finds no store and does not touch the cipher.
    assert.deepEqual(await migrateEncryptedCredentials(legacy, store, fake), {
      moved: [],
      reenter: [],
    });
    assert.equal(fake.decrypts, 1);
    assert.equal(await store.get('github.com'), 'synthetic-github-token');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('an entry that cannot be decrypted asks for re-entry until it is entered again', async () => {
  for (const refusal of ['denied', 'unavailable', 'corrupt'] as const) {
    const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
    try {
      const fake = cipher();
      const legacy = await legacyStore(folder, {
        [legacyName('github.com')]:
          refusal === 'corrupt'
            ? Buffer.from('synthetic opaque ciphertext')
            : fake.encryptString('synthetic-github-token'),
      });
      const store = new OwnerOnlyCredentialStore(join(folder, 'runtime-home'));
      const result = await migrateEncryptedCredentials(legacy, store, {
        // The keychain refusing access, as when the person denies the prompt
        isEncryptionAvailable: () => refusal !== 'unavailable',
        decryptString: (value) => {
          if (refusal === 'denied') throw Error('keychain access denied');
          return fake.decryptString(value);
        },
      });
      assert.deepEqual(result, { moved: [], reenter: ['github.com'] });
      await assert.rejects(stat(legacy), { code: 'ENOENT' });
      await assert.rejects(
        store.get('github.com'),
        (error: unknown) =>
          error instanceof CredentialReentryRequired &&
          error.message === CREDENTIAL_REENTRY,
      );
      assert.doesNotMatch(await readFile(store.path, 'utf8'), /synthetic/);
      await store.put('github.com', 'synthetic-entered-again');
      assert.equal(await store.get('github.com'), 'synthetic-entered-again');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
});

test('a move whose file cannot be written keeps the encrypted store for the next start', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    const fake = cipher();
    const legacy = await legacyStore(folder, {
      [legacyName('github.com')]: fake.encryptString('synthetic-github-token'),
    });
    // The runtime home is a file here, so nothing can be written under it.
    const blocked = join(folder, 'runtime-home');
    await writeFile(blocked, 'not a folder');
    await assert.rejects(
      migrateEncryptedCredentials(
        legacy,
        new OwnerOnlyCredentialStore(blocked),
        fake,
      ),
    );
    assert.deepEqual(await readdir(legacy), [legacyName('github.com')]);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('the runtime is answered only after the move, and re-entry crosses the private channel by name', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    const store = new OwnerOnlyCredentialStore(folder);
    let finish!: () => void;
    const order: string[] = [];
    const waiting = credentialsAfter(
      store,
      new Promise<void>((resolve) => {
        finish = () => {
          order.push('moved');
          resolve();
        };
      }),
    );
    const read = waiting.get('github.com').then((value) => {
      order.push('read');
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, []);
    finish();
    assert.equal(await read, undefined);
    assert.deepEqual(order, ['moved', 'read']);
    await store.markReentry(['github.com']);
    const reply = await executeCredentialRequest(
      {
        type: 'credential-request',
        id: 'r1',
        operation: 'get',
        key: 'github.com',
      },
      store,
    );
    assert.deepEqual(reply, {
      type: 'credential-reply',
      id: 'r1',
      ok: false,
      error: CREDENTIAL_REENTRY,
    });
    const client = new RuntimeCredentialClient((request) => {
      void executeCredentialRequest(request, store).then((answer) =>
        client.receive(answer),
      );
    });
    await assert.rejects(client.get('github.com'), {
      message: CREDENTIAL_REENTRY,
    });
    // Other failures stay unnamed: no stored text crosses the channel.
    const broken = {
      get: async () => {
        throw Error('synthetic-secret in an error');
      },
      put: async () => {},
      delete: async () => {},
    };
    const other = await executeCredentialRequest(
      {
        type: 'credential-request',
        id: 'r2',
        operation: 'get',
        key: 'github.com',
      },
      broken,
    );
    assert.equal(other?.error, 'native credential operation failed');
    client.close();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('credential identities, values and HTTPS native links are bounded and validated', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'circle-credential-'));
  try {
    const store = new OwnerOnlyCredentialStore(folder);
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

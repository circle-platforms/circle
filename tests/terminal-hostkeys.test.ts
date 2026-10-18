import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TrustedHostKeys } from '../src/terminal/hostkeys.js';
import { scratch as made } from './helpers.js';

const scratch = (t: test.TestContext) => made(t, 'circle-terminal-hostkeys-');

test('a private device key trusted for good comes back after a reload', (t) => {
  const path = join(scratch(t), 'terminal-host-keys.json');
  const keys = new TrustedHostKeys(path);
  assert.equal(keys.has('sw1.lan:22', 'SHA256:aaa'), false);
  keys.add('sw1.lan:22', 'SHA256:aaa', 'ssh-ed25519');
  assert.equal(keys.has('sw1.lan:22', 'SHA256:aaa'), true);
  assert.equal(keys.has('SW1.LAN:22', 'SHA256:aaa'), true);
  assert.equal(keys.has('sw1.lan:22', 'SHA256:bbb'), false);
  assert.equal(keys.has('sw1.lan:23', 'SHA256:aaa'), false);
  const again = new TrustedHostKeys(path);
  assert.equal(again.has('sw1.lan:22', 'SHA256:aaa'), true);
  const saved = JSON.parse(readFileSync(path, 'utf8')) as {
    keys: {
      host: string;
      key_type?: string;
      keyType: string;
      fingerprint: string;
    }[];
  };
  assert.deepEqual(saved.keys, [
    {
      host: 'sw1.lan:22',
      fingerprint: 'SHA256:aaa',
      keyType: 'ssh-ed25519',
    },
  ]);
  if (process.platform !== 'win32')
    assert.equal(statSync(path).mode & 0o777, 0o600);
});

test('a public host is never trusted for good, and nothing writable is never written', (t) => {
  const path = join(scratch(t), 'terminal-host-keys.json');
  const keys = new TrustedHostKeys(path);
  keys.add('router.example.com:22', 'SHA256:aaa');
  keys.add('sw1.lan:22', '');
  assert.equal(keys.has('router.example.com:22', 'SHA256:aaa'), false);
  assert.equal(keys.has('sw1.lan:22', ''), false);
  assert.equal(existsSync(path), false);
  // A hand-written public entry is dropped the next time something real is saved
  writeFileSync(
    path,
    JSON.stringify({
      keys: [
        {
          host: 'router.example.com:22',
          fingerprint: 'SHA256:pub',
          keyType: '',
        },
      ],
    }),
  );
  const store = new TrustedHostKeys(path);
  assert.equal(store.has('router.example.com:22', 'SHA256:pub'), false);
  store.add('sw1.lan:22', 'SHA256:ok');
  const saved = JSON.parse(readFileSync(path, 'utf8')) as {
    keys: { host: string }[];
  };
  assert.deepEqual(
    saved.keys.map((entry) => entry.host),
    ['sw1.lan:22'],
  );
});

test('a store without a file keeps answers for the run only', () => {
  const keys = new TrustedHostKeys();
  keys.add('10.0.0.5:23', 'SHA256:zz');
  assert.equal(keys.has('10.0.0.5:23', 'SHA256:zz'), true);
});

test('a malformed trust file is nothing, not an error', (t) => {
  const path = join(scratch(t), 'terminal-host-keys.json');
  writeFileSync(path, 'no json at all');
  const keys = new TrustedHostKeys(path);
  assert.equal(keys.has('sw1.lan:22', 'SHA256:aaa'), false);
  writeFileSync(
    path,
    JSON.stringify({
      keys: [
        { host: 'public.example.com:22', fingerprint: 'SHA256:pub' },
        { host: 'a.lan:22', fingerprint: 'SHA256:ok', keyType: 'ssh-rsa' },
        { host: 'no-fp.lan:22' },
      ],
    }),
  );
  const reloaded = new TrustedHostKeys(path);
  assert.equal(reloaded.has('a.lan:22', 'SHA256:ok'), true);
  assert.equal(reloaded.has('public.example.com:22', 'SHA256:pub'), false);
});

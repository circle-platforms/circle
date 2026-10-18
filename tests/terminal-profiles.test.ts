import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  findProfile,
  loadProfiles,
  profileTarget,
  saveProfiles,
  type TerminalProfile,
} from '../src/terminal/profiles.js';
import { scratch as made } from './helpers.js';

const scratch = (t: test.TestContext) => made(t, 'circle-terminal-profiles-');
const file = (t: test.TestContext) =>
  join(scratch(t), 'terminal-sessions.json');

const profile: TerminalProfile = {
  name: 'LAB-DEVICE-01',
  transport: 'ssh',
  host: 'sw1.lan',
  port: 22,
  user: 'operator',
  passwordSecret: 'DEV_PASS',
  keyPath: '/home/op/.ssh/id_ed25519',
  passphraseSecret: 'DEV_KEY_PASS',
  cols: 100,
  rows: 30,
};

test('a saved profile round-trips, defaults come back unstored', (t) => {
  const path = file(t);
  saveProfiles(path, [profile]);
  assert.deepEqual(loadProfiles(path), [profile]);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    sessions: Record<string, unknown>[];
  };
  assert.deepEqual(Object.keys(raw.sessions[0]!), [
    'name',
    'transport',
    'host',
    'port',
    'user',
    'auth',
    'cols',
    'rows',
  ]);
  if (process.platform !== 'win32')
    assert.equal(statSync(path).mode & 0o777, 0o600);
  const plain: TerminalProfile = {
    name: 'console',
    transport: 'telnet',
    host: '10.0.0.5',
    port: 23,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  };
  saveProfiles(path, [plain]);
  assert.deepEqual(loadProfiles(path), [plain]);
  const stored = JSON.parse(readFileSync(path, 'utf8')) as {
    sessions: Record<string, unknown>[];
  };
  assert.equal('auth' in stored.sessions[0]!, false);
  assert.equal('cols' in stored.sessions[0]!, false);
});

test('a secret name is only ever a NAME: a value in the file is dropped', (t) => {
  const path = file(t);
  saveProfiles(path, [profile]);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as {
    sessions: Record<string, unknown>[];
  };
  raw.sessions[0]!.auth = {
    password: 'hunter2',
    passphrase: 'lower_case',
    key: profile.keyPath,
  };
  writeFileSync(path, JSON.stringify(raw));
  const loaded = loadProfiles(path);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.passwordSecret, undefined);
  assert.equal(loaded[0]!.passphraseSecret, undefined);
  assert.equal(loaded[0]!.keyPath, profile.keyPath);
  assert.equal(JSON.stringify(loaded).includes('hunter2'), false);
});

test('a malformed entry or file loads as nothing, never as a partial trust', (t) => {
  const path = file(t);
  writeFileSync(path, 'not json');
  assert.deepEqual(loadProfiles(path), []);
  writeFileSync(path, JSON.stringify({ sessions: 'no' }));
  assert.deepEqual(loadProfiles(path), []);
  writeFileSync(
    path,
    JSON.stringify({
      sessions: [
        { name: 'bad host', transport: 'ssh', host: 'http://x/y', port: 22 },
        { name: 'bad port', transport: 'ssh', host: 'a.lan', port: 70000 },
        { name: 'no transport', host: 'a.lan' },
        { name: 'ok', transport: 'ssh', host: 'a.lan' },
        { name: 'ok', transport: 'telnet', host: 'b.lan' },
        { name: '  ', transport: 'ssh', host: 'c.lan' },
        { name: 'ctl', transport: 'ssh', host: 'c\x01.lan' },
      ],
    }),
  );
  const loaded = loadProfiles(path);
  assert.deepEqual(
    loaded.map((p) => p.name),
    ['ok'],
  );
  assert.equal(loaded[0]!.port, 22);
  assert.equal(loaded[0]!.cols, DEFAULT_COLS);
});

test('a missing or half-written file is simply nothing', (t) => {
  assert.deepEqual(loadProfiles(join(scratch(t), 'none.json')), []);
});

test('the target names the device for approvals, and a profile is found by any case', () => {
  assert.equal(profileTarget(profile), 'sw1.lan:22');
  assert.equal(
    profileTarget({ ...profile, host: 'Mixed.Example.COM' }),
    'mixed.example.com:22',
  );
  assert.equal(findProfile([profile], ' lab-device-01 ')?.name, profile.name);
  assert.equal(findProfile([profile], 'other'), undefined);
});

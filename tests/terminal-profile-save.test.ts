// The saved profiles, and the profile-save action that writes them from a tool call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { TerminalSessions } from '../src/terminal/sessions.js';
import type { TerminalTransport } from '../src/terminal/transport.js';
import { join } from 'node:path';
import { loadProfiles, saveProfiles } from '../src/terminal/profiles.js';
import { scratch as made } from './helpers.js';

const scratch = (t: test.TestContext) => made(t, 'circle-terminal-save-');
const file = (t: test.TestContext) =>
  join(scratch(t), 'terminal-sessions.json');

const signal = new AbortController().signal;

const quietTransport = (): TerminalTransport => ({
  onData: () => {},
  onEnd: () => {},
  write: () => {},
  resize: () => {},
  close: () => {},
});

function saving(t: test.TestContext, path: string) {
  const seen: { passwordSecret?: string }[] = [];
  const sessions = new TerminalSessions({
    connectors: {
      ssh: async (target) => {
        seen.push({ passwordSecret: target.passwordSecret });
        return { transport: quietTransport() };
      },
      telnet: async () => ({ transport: quietTransport() }),
    },
    profiles: () => loadProfiles(path),
    save: (list) => saveProfiles(path, list),
    secret: (name) => (name === 'DEV_85_PASS' ? 'the-device-pass' : ''),
    keyFile: (p) => p,
    onChange: () => {},
  });
  t.after(() => sessions.close());
  return { sessions, seen };
}
test('a profile-save links a device to a secret name, and a connect signs in by it', async (t) => {
  const path = file(t);
  const { sessions, seen } = saving(t, path);
  const saved = await sessions.request(
    'c1',
    'profile-save',
    {
      name: 'lab85',
      transport: 'ssh',
      host: '172.16.6.85:22',
      user: 'admin',
      password_secret: 'DEV_85_PASS',
    },
    signal,
    true,
  );
  assert.match(
    saved.text,
    /^Saved profile lab85: ssh 172\.16\.6\.85:22 as admin, signing in with the secret DEV_85_PASS/,
  );
  // The value never enters the file; only the secret name does
  assert.equal(readFileSync(path, 'utf8').includes('the-device-pass'), false);
  assert.deepEqual(
    loadProfiles(path).map((p) => [
      p.name,
      p.host,
      p.port,
      p.user,
      p.passwordSecret,
    ]),
    [['lab85', '172.16.6.85', 22, 'admin', 'DEV_85_PASS']],
  );
  // The model can now connect by the name: the connector sees the secret name
  const connected = await sessions.request(
    'c1',
    'connect',
    { profile: 'lab85' },
    signal,
    true,
  );
  assert.match(connected.text, /^Connected: /);
  assert.deepEqual(seen, [{ passwordSecret: 'DEV_85_PASS' }]);
  // A later save under the same name, whatever its case, replaces it in place
  const again = await sessions.request(
    'c1',
    'profile-save',
    {
      name: 'LAB85',
      transport: 'ssh',
      host: '172.16.6.85',
      port: 2222,
      user: 'admin',
      password_secret: 'DEV_85_PASS',
    },
    signal,
    true,
  );
  assert.match(again.text, /^Updated profile LAB85: ssh 172\.16\.6\.85:2222/);
  assert.deepEqual(
    loadProfiles(path).map((p) => [p.name, p.port]),
    [['LAB85', 2222]],
  );
});
test('a profile-save refuses what cannot sign in or is not a device', async (t) => {
  const path = file(t);
  const { sessions } = saving(t, path);
  // SSH with no secret name and no key has no way to sign in
  await assert.rejects(
    sessions.request(
      'c1',
      'profile-save',
      { name: 'x', transport: 'ssh', host: '172.16.6.85' },
      signal,
      true,
    ),
    /needs a way to sign in/,
  );
  // A scheme is not a device address
  await assert.rejects(
    sessions.request(
      'c1',
      'profile-save',
      {
        name: 'x',
        transport: 'ssh',
        host: 'ssh://172.16.6.85',
        password_secret: 'DEV_85_PASS',
      },
      signal,
      true,
    ),
    /is not one/,
  );
  // A malformed secret name cannot make the profile carry a password
  await assert.rejects(
    sessions.request(
      'c1',
      'profile-save',
      {
        name: 'x',
        transport: 'ssh',
        host: 'a.lan',
        password_secret: 'lower case with spaces',
      },
      signal,
      true,
    ),
    /needs a way to sign in/,
  );
  // No name at all is malformed
  await assert.rejects(
    sessions.request(
      'c1',
      'profile-save',
      { name: '', transport: 'telnet', host: 'a.lan' },
      signal,
      true,
    ),
    /incomplete or malformed/,
  );
  assert.equal(existsSync(path), false);
  // A host that keeps no profiles says so instead of losing the write
  const nowhere = new TerminalSessions({
    connectors: {
      ssh: async () => ({ transport: quietTransport() }),
      telnet: async () => ({ transport: quietTransport() }),
    },
    profiles: () => [],
    secret: () => '',
    keyFile: (p) => p,
    onChange: () => {},
  });
  t.after(() => nowhere.close());
  await assert.rejects(
    nowhere.request(
      'c1',
      'profile-save',
      { name: 'x', transport: 'telnet', host: 'a.lan' },
      signal,
      true,
    ),
    /keeps no saved profiles/,
  );
});

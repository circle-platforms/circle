// Byte-level evidence against a real SSH conversation: an ssh2 Server in this process, on
// 127.0.0.1 with a generated host key, is the device. Nothing here leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { TerminalSessions } from '../src/terminal/sessions.js';
import { sshConnector } from '../src/terminal/ssh.js';
import { telnetConnector } from '../src/terminal/telnet.js';
import { TrustedHostKeys } from '../src/terminal/hostkeys.js';
import type { TerminalProfile } from '../src/terminal/profiles.js';
import { scratch } from './helpers.js';

// Default-imported: ssh2 is CommonJS with loop-copied exports.
const { Server } = ssh2;

const PASSWORD = 'sw1pass-never-shown-to-the-model';
// ssh2 reads PKCS#1 and OpenSSH keys; PKCS#8 RSA is refused
const HOST_KEY = Buffer.from(
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey,
);

interface Device {
  port: number;
  authed: string[];
  input: string[];
  pty: { cols: number; rows: number; term: string }[];
  windowChanges: { cols: number; rows: number }[];
  close: () => Promise<void>;
}

/** One fake console device: answers a password login, runs lines, keeps a prompt. */
function startDevice(t: test.TestContext, accepts = PASSWORD): Promise<Device> {
  const device: Device = {
    port: 0,
    authed: [],
    input: [],
    pty: [],
    windowChanges: [],
    close: () => Promise.resolve(),
  };
  const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === accepts) {
        device.authed.push(String(ctx.username ?? ''));
        return ctx.accept();
      }
      ctx.reject(['password']);
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acceptPty, _reject, info) => {
        device.pty.push({ cols: info.cols, rows: info.rows, term: info.term });
        acceptPty();
      });
      session.on('window-change', (acceptChange, _reject, info) => {
        device.windowChanges.push({ cols: info.cols, rows: info.rows });
        // A size report answers nothing: ssh2 hands no accept for it. Calling one
        // anyway throws inside the connection and cuts the console — do not.
        if (typeof acceptChange === 'function') acceptChange();
      });
      session.on('shell', (acceptShell) => {
        const stream = acceptShell();
        // A banner, a prompt, and what the console actually received, one line per Enter
        stream.write('LAB-DEVICE banner\r\nsh> ');
        let typed = '';
        stream.on('data', (bytes: Buffer) => {
          typed += bytes.toString('utf8');
          let cut = typed.search(/[\r\n]/);
          while (cut !== -1) {
            const line = typed.slice(0, cut).trim();
            typed = typed.slice(cut + 1);
            device.input.push(line);
            if (line === 'color')
              // A red word and a wide one: the emulator has to take them both
              stream.write(`\x1b[31mRED\x1b[0m 中\r\nsh> `);
            else stream.write(`ran: ${line}\r\nsh> `);
            cut = typed.search(/[\r\n]/);
          }
        });
      });
    });
  });
  // ssh2's Server keeps its net.Server inside _srv: watch it for live sockets, so a
  // failing assertion cannot leave a console pinning the server shut and the run hung
  const live = new Set<import('node:net').Socket>();
  (
    server as unknown as {
      _srv: {
        on(e: 'connection', l: (s: import('node:net').Socket) => void): void;
      };
    }
  )._srv.on('connection', (socket) => {
    live.add(socket);
    socket.on('close', () => live.delete(socket));
    socket.on('error', () => {});
  });
  let closed: Promise<void> | undefined;
  device.close = () =>
    (closed ??= new Promise<void>((done) => {
      for (const socket of live) socket.destroy();
      server.close(() => done());
    }));
  t.after(() => device.close());
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address !== 'object')
        return reject(Error('no fixture address'));
      device.port = address.port;
      resolve(device);
    });
  });
}

function manager(
  t: test.TestContext,
  profiles: TerminalProfile[],
  overrides: { secret?: (name: string) => string; trustFile?: string } = {},
) {
  const sessions = new TerminalSessions({
    connectors: { ssh: sshConnector, telnet: telnetConnector },
    profiles: () => profiles,
    secret: overrides.secret ?? (() => ''),
    keyFile: (path) => path,
    onChange: () => {},
    ...(overrides.trustFile
      ? { hostkeys: new TrustedHostKeys(overrides.trustFile) }
      : {}),
  });
  t.after(() => sessions.close());
  return sessions;
}

const signal = new AbortController().signal;

// The runner is busy when the whole suite goes at once: wait for what actually happened,
// never for a guessed number of milliseconds.
async function until(
  what: () => boolean,
  message: string,
  ms = 8000,
): Promise<void> {
  const stop = Date.now() + ms;
  while (!what()) {
    if (Date.now() >= stop) throw Error(message);
    await new Promise((done) => setTimeout(done, 25));
  }
}

function profile(port: number, name = 'LAB-DEVICE-01'): TerminalProfile {
  return {
    name,
    transport: 'ssh',
    host: '127.0.0.1',
    port,
    user: 'operator',
    passwordSecret: 'SW1_PASS',
    cols: 80,
    rows: 24,
  };
}

test('a first SSH login stops at an unknown host key; trusting it lets the same connect through', async (t) => {
  const root = scratch(t);
  const device = await startDevice(t);
  const trustFile = join(root, 'terminal-host-keys.json');
  const sessions = manager(t, [profile(device.port)], {
    secret: (name) => (name === 'SW1_PASS' ? PASSWORD : ''),
    trustFile,
  });
  const ask = await sessions.request(
    'c1',
    'connect',
    { profile: 'LAB-DEVICE-01' },
    signal,
  );
  assert.equal(ask.approval?.kind, 'hostkey');
  assert.match(ask.approval!.fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
  assert.equal(ask.approval!.privateHost, true);
  assert.match(ask.text, /login stopped/);
  assert.equal(existsSync(trustFile), false);
  assert.deepEqual(device.authed, []);
  // The person answers for good; the tools carry the token back, as a browser's do
  const second = await sessions.request(
    'c1',
    'connect',
    {
      profile: 'LAB-DEVICE-01',
      approval: { token: ask.approval!.token, scope: 'always' },
    },
    signal,
  );
  assert.match(second.text, /^Connected: /);
  assert.equal(second.approval, undefined);
  assert.deepEqual(device.authed, ['operator']);
  assert.deepEqual(device.pty, [
    { cols: 80, rows: 24, term: 'xterm-256color' },
  ]);
  const trusted = JSON.parse(readFileSync(trustFile, 'utf8')) as {
    keys: { host: string; keyType: string; fingerprint: string }[];
  };
  assert.deepEqual(trusted.keys, [
    {
      host: `127.0.0.1:${device.port}`,
      keyType: 'ssh-rsa',
      fingerprint: ask.approval!.fingerprint,
    },
  ]);
  // Nothing was typed yet; the console answers what the model sends. A loaded runner
  // can pass the send's own settle before the device replies: wait for the answer.
  await sessions.request(
    'c1',
    'send',
    { session: 't1', text: 'show version', enter: true },
    signal,
  );
  const ran = await sessions.request(
    'c1',
    'wait',
    { session: 't1', pattern: 'ran: show version', timeout_ms: 10000 },
    signal,
  );
  assert.match(ran.text, /matched ran: show version/);
  assert.deepEqual(device.input, ['show version']);
  await sessions.request(
    'c1',
    'send',
    { session: 't1', text: 'color', enter: true },
    signal,
  );
  const colored = await sessions.request(
    'c1',
    'wait',
    { session: 't1', pattern: 'RED 中', timeout_ms: 10000 },
    signal,
  );
  assert.match(colored.text, /RED 中/);
  assert.equal(colored.text.includes('\x1b'), false);
  assert.equal(colored.text.includes('\r'), false);
  const read = await sessions.request('c1', 'read', { session: 't1' }, signal);
  assert.match(read.text, /### Prompt\nsh>/);
  assert.equal(JSON.stringify(read).includes(PASSWORD), false);
  // Size changes reach the device's pseudo-terminal
  sessions.resize('c1', 't1', 100, 30);
  await until(
    () => device.windowChanges.some((w) => w.cols === 100 && w.rows === 30),
    `no window-change in ${JSON.stringify(device.windowChanges)}`,
  );
  // A second conversation trusts the stored key: nobody is asked again
  const again = await sessions.request(
    'c2',
    'connect',
    { profile: 'LAB-DEVICE-01' },
    signal,
  );
  assert.equal(again.approval, undefined);
  assert.match(again.text, /^Connected: /);
  // The screen is readable after a disconnect, and the events came with the results
  const gone = await sessions.request(
    'c1',
    'disconnect',
    { session: 't1' },
    signal,
  );
  assert.match(gone.text, /cut off/);
  const after = await sessions
    .request('c1', 'send', { session: 't1', text: 'x', enter: true }, signal)
    .then(
      () => 'sent to a closed console',
      (error: Error) => error.message,
    );
  assert.match(after, /is closed/);
});

test('a once answer trusts nothing on disk, and the next conversation is asked again', async (t) => {
  const root = scratch(t);
  const device = await startDevice(t);
  const trustFile = join(root, 'terminal-host-keys.json');
  const sessions = manager(t, [profile(device.port, 'lab')], {
    secret: () => PASSWORD,
    trustFile,
  });
  const ask = await sessions.request(
    'c1',
    'connect',
    { profile: 'lab' },
    signal,
  );
  const once = await sessions.request(
    'c1',
    'connect',
    { profile: 'lab', approval: { token: ask.approval!.token, scope: 'once' } },
    signal,
  );
  assert.match(once.text, /^Connected: /);
  assert.equal(existsSync(trustFile), false);
  const other = await sessions.request(
    'c2',
    'connect',
    { profile: 'lab' },
    signal,
  );
  assert.equal(other.approval?.kind, 'hostkey');
});

test('an absent secret or a refused login is a clear refusal, before anything is typed', async (t) => {
  const device = await startDevice(t, 'another-pass');
  const nosuch = manager(t, [profile(device.port, 'lab')], {
    secret: () => '',
  });
  await assert.rejects(
    nosuch.request('c1', 'connect', { profile: 'lab' }, signal),
    /no saved secret SW1_PASS/,
  );
  // The host key gets its one allowed answer, then the wrong password refuses
  const sessions = manager(t, [profile(device.port, 'lab')], {
    secret: () => PASSWORD,
  });
  const ask = await sessions.request(
    'c1',
    'connect',
    { profile: 'lab' },
    signal,
  );
  await assert.rejects(
    sessions.request(
      'c1',
      'connect',
      {
        profile: 'lab',
        approval: { token: ask.approval!.token, scope: 'once' },
      },
      signal,
    ),
    /refused the connection/,
  );
  assert.deepEqual(device.input, []);
});

test('the person holds a console: the model parks, and the events name the act, never the words', async (t) => {
  const device = await startDevice(t);
  const sessions = manager(t, [profile(device.port, 'lab')], {
    secret: () => PASSWORD,
  });
  const ask = await sessions.request(
    'c1',
    'connect',
    { profile: 'lab' },
    signal,
  );
  const connected = await sessions.request(
    'c1',
    'connect',
    { profile: 'lab', approval: { token: ask.approval!.token, scope: 'once' } },
    signal,
  );
  assert.match(connected.text, /^Connected: /);
  assert.equal(sessions.attach('c1', 't1'), true);
  assert.equal(sessions.input('c1', 't1', 'secret words\r'), true);
  // An action the person is holding parks until they give it back: wait until it has
  // actually parked, then only release it by detaching
  let parked = false;
  const pending = sessions
    .request(
      'c1',
      'send',
      { session: 't1', text: 'later', enter: true },
      signal,
    )
    .then((result) => {
      parked = true;
      return result;
    });
  await until(
    () => (sessions.session('c1', 't1')?.wakers.size ?? 0) > 0,
    'the action never parked on the holder',
  );
  assert.equal(parked, false);
  sessions.detach('c1', 't1');
  const resumed = await pending;
  await until(
    () => device.input.includes('later'),
    `device saw only ${JSON.stringify(device.input)}`,
  );
  assert.deepEqual(device.input, ['secret words', 'later']);
  assert.match(resumed.text, /the user typed/);
  assert.match(resumed.text, /took the terminal/);
  // The events tell what happened, not what was typed; only the device's own echo,
  // like any console's, puts words on the screen the model can then read
  const events = resumed.text.split('### Events')[1] ?? '';
  assert.equal(events.includes('secret words'), false);
  assert.equal(events.includes(PASSWORD), false);
  assert.equal(resumed.text.includes(PASSWORD), false);
});

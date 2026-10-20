// The desktop main process's terminal host: a real Telnet console on 127.0.0.1 driven
// through the same object main.ts wires to the supervisor and the preload bridge. The
// renderer is not in the room: what is tested is what it would see and may ask for.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TerminalPanelHost } from '../src/terminal.ts';
import {
  saveProfiles,
  type TerminalProfile,
} from '../../../src/terminal/profiles.ts';
import type { TerminalEvent } from '../src/contracts.ts';
import ssh2 from 'ssh2';

// Default-imported: ssh2 is CommonJS with loop-copied exports.
const { Server: SshServer } = ssh2;

async function until(check: () => boolean, description: string) {
  const end = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > end) throw Error(`timed out: ${description}`);
    await delay(10);
  }
}

/** One console server: greets a newcomer and records the lines it is given. */
async function consoleServer(t: TestContext) {
  const typed: string[] = [];
  let banner = 'TELNET banner\r\ncon> ';
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    // Strip telnet negotiation (IAC <cmd>, IAC SB ... IAC SE), keeping only typed data,
    // so a NAWS size byte never masquerades as a character.
    let negotiation = Buffer.alloc(0);
    let input = '';
    const strip = (chunk: Buffer): number[] => {
      const bytes = Buffer.concat([negotiation, chunk]);
      const out: number[] = [];
      let at = 0;
      while (at < bytes.length) {
        const byte = bytes[at]!;
        if (byte !== 255) {
          out.push(byte);
          at += 1;
          continue;
        }
        const start = at;
        const command = bytes[at + 1];
        if (command === undefined) break;
        at += 2;
        if (command === 255) {
          out.push(255);
          continue;
        }
        if (command === 250) {
          let end = -1;
          for (let scan = at; scan < bytes.length - 1; scan++)
            if (bytes[scan] === 255 && bytes[scan + 1] === 240) {
              end = scan + 2;
              break;
            }
          if (end === -1) {
            at = start; // an unfinished sub-negotiation: keep it for the next packet
            break;
          }
          at = end;
          continue;
        }
        if (bytes[at] === undefined) {
          at = start;
          break;
        }
        at += 1;
      }
      negotiation =
        at < bytes.length ? Buffer.from(bytes.subarray(at)) : Buffer.alloc(0);
      return out;
    };
    socket.on('data', (raw: Buffer) => {
      input += Buffer.from(strip(raw)).toString('utf8');
      let cut = input.search(/[\r\n]/);
      while (cut !== -1) {
        typed.push(input.slice(0, cut).trim());
        input = input.slice(cut + 1);
        cut = input.search(/[\r\n]/);
      }
    });
    socket.write(Buffer.from(banner, 'utf8'));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address !== 'object')
    throw Error('no fixture address');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    port: address.port,
    typed,
    setBanner: (text: string) => {
      banner = text;
    },
  };
}

const SSH_PASSWORD = 'quick-connect-pass-never-in-a-window';

/** One SSH device on 127.0.0.1 with a key nobody trusts yet: a password login, a prompt. */
async function sshDevice(t: TestContext) {
  const authed: string[] = [];
  // ssh2 reads PKCS#1 and OpenSSH keys; PKCS#8 RSA is refused
  const hostKey = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {});
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === SSH_PASSWORD) {
        authed.push(ctx.username);
        return ctx.accept();
      }
      ctx.reject(['password']);
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (acceptPty) => acceptPty());
      session.on('window-change', (acceptChange) => {
        if (typeof acceptChange === 'function') acceptChange();
      });
      session.on('shell', (acceptShell) => acceptShell().write('sh> '));
    });
  });
  // ssh2's Server keeps its net.Server inside _srv: close its sockets so the run ends
  const sockets = new Set<Socket>();
  (
    server as unknown as {
      _srv: { on(e: 'connection', l: (s: Socket) => void): void };
    }
  )._srv.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address !== 'object')
    throw Error('no fixture address');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return { port: address.port, authed };
}

async function makeHost(
  t: TestContext,
  profiles: TerminalProfile[],
): Promise<{ panel: TerminalPanelHost; events: TerminalEvent[] }> {
  const root = await mkdtemp(join(tmpdir(), 'circle-terminal-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'runtime-home');
  await mkdir(home, { recursive: true });
  saveProfiles(join(home, 'terminal-sessions.json'), profiles);
  const events: TerminalEvent[] = [];
  const panel = new TerminalPanelHost(
    (event) => events.push(event),
    home,
    join(root, 'terminal-host-keys.json'),
    () => '',
    () => 'manual',
  );
  t.after(() => panel.close());
  return { panel, events };
}

test('a panel connect opens a real console; bytes arrive batched and only the holder types', async (t) => {
  const device = await consoleServer(t);
  const profile: TerminalProfile = {
    name: 'rack',
    transport: 'telnet',
    host: '127.0.0.1',
    port: device.port,
    cols: 80,
    rows: 24,
  };
  const { panel, events } = await makeHost(t, [profile]);
  const state = await panel.connect('c1', 'rack');
  const row = state.sessions[0]!;
  assert.equal(row.state, 'ready');
  assert.equal(row.target, `127.0.0.1:${device.port}`);
  // the banner reached the renderer as one data batch
  await until(
    () => events.some((event) => event.kind === 'data'),
    'a data event',
  );
  const data = events.find((event) => event.kind === 'data')!;
  assert(data.kind === 'data');
  assert.equal(data.session, row.id);
  assert.match(
    Buffer.from(data.bytes, 'base64').toString('utf8'),
    /TELNET banner/,
  );
  // typing before attaching changes nothing on the wire
  assert.equal(panel.input('c1', row.id, 'whois'), false);
  // (a deepEqual with an empty-array literal would narrow typed to never[])
  assert.equal(device.typed.length, 0);
  // the person takes it; their keys reach the device
  const held = panel.attach('c1', row.id);
  assert.equal(held.sessions[0]!.held, 'attach');
  assert.equal(panel.input('c1', row.id, 'show clock\r'), true);
  await until(() => device.typed.includes('show clock'), 'the typed line');
  // while the person holds it, the model's next action waits
  let parkedDone = false;
  const parked = panel
    .agent(
      {
        id: 'park-1',
        sessionId: 'c1',
        action: 'send',
        args: { session: row.id, text: 'model line', enter: true },
      },
      new AbortController().signal,
    )
    .then((result) => {
      parkedDone = true;
      return result;
    });
  await delay(120);
  assert.equal(parkedDone, false);
  panel.detach('c1', row.id);
  await parked;
  assert.ok(device.typed.includes('model line'));
  // sizes reach the console; a delete releases it
  panel.resize('c1', row.id, 100, 30);
  assert.deepEqual(
    [panel.state('c1').sessions[0]!.cols, panel.state('c1').sessions[0]!.rows],
    [100, 30],
  );
  await panel.releaseSession('c1');
  assert.equal(panel.state('c1').sessions.length, 0);
});

test('an agent request from the runtime drives the same host and reports state', async (t) => {
  const device = await consoleServer(t);
  device.setBanner('press return\r\n');
  const { panel, events } = await makeHost(t, []);
  const result = await panel.agent(
    {
      id: 'a1',
      sessionId: 'c2',
      action: 'connect',
      args: { host: '127.0.0.1', transport: 'telnet', port: device.port },
    },
    new AbortController().signal,
  );
  assert.match(result.text, /^Connected: t1/);
  assert.equal(result.host, `127.0.0.1:${device.port}`);
  const read = await panel.agent(
    { id: 'a2', sessionId: 'c2', action: 'read', args: { session: 't1' } },
    new AbortController().signal,
  );
  assert.match(read.text, /press return/);
  const send = await panel.agent(
    {
      id: 'a3',
      sessionId: 'c2',
      action: 'send',
      args: { session: 't1', text: 'show ver', enter: true },
    },
    new AbortController().signal,
  );
  assert.match(send.text, /t1 ·/);
  assert.ok(device.typed.includes('show ver'));
  // the changes reached the renderer as state events for the right conversation
  const states = events.filter(
    (event): event is Extract<TerminalEvent, { kind: 'state' }> =>
      event.kind === 'state',
  );
  assert.ok(states.length > 0);
  assert.equal(states.at(-1)!.state.conversation, 'c2');
});

test('saved profile display names with spaces, Unicode and the full allowed length connect and carry real input', async (t) => {
  const device = await consoleServer(t);
  const names = [
    'a synthetic console with a long display name',
    '本地 console',
    'x'.repeat(100),
  ];
  const { panel } = await makeHost(
    t,
    names.map((name) => ({
      name,
      transport: 'telnet',
      host: '127.0.0.1',
      port: device.port,
      cols: 80,
      rows: 24,
    })),
  );
  assert.deepEqual(
    panel.profiles().map((profile) => profile.name),
    names,
  );
  for (const [index, name] of names.entries()) {
    const state = await panel.connect('c1', name);
    const row = state.sessions.at(-1)!;
    assert.equal(row.state, 'ready');
    panel.attach('c1', row.id);
    const mark = `profile-${index}`;
    assert.equal(panel.input('c1', row.id, mark + '\r'), true);
    await until(
      () => device.typed.includes(mark),
      'the profile console receives input',
    );
  }
  for (const name of ['', ' leading', 'bad\nname', 'x'.repeat(101), null])
    await assert.rejects(panel.connect('c1', name), /invalid terminal profile/);
  assert.equal(panel.state('c1').sessions.length, names.length);
});

test('the bridge refuses strangers: ids are gated before anything reads or writes', async (t) => {
  const { panel } = await makeHost(t, []);
  for (const bad of ['', 'x'.repeat(121), 'not an id', '../etc']) {
    assert.throws(() => panel.state(bad), /invalid conversation/);
    assert.throws(
      () => panel.input('c1', bad, 'x'),
      /invalid terminal/,
      `session ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(
    () => panel.input('c1', 't1', {} as unknown as string),
    /invalid terminal input/,
  );
  panel.resize('c1', 't1', 0, 9999); // out-of-bounds sizes are dropped, not thrown
  assert.equal(panel.snapshot('c1', 't9'), '');
});

test('a quick connect password signs in through the host key question and never reaches a window', async (t) => {
  const device = await sshDevice(t);
  const { panel, events } = await makeHost(t, []);
  const asked = await panel.connectTarget('c1', {
    transport: 'ssh',
    host: '127.0.0.1',
    port: device.port,
    user: 'operator',
    password: SSH_PASSWORD,
  });
  // the login stopped at the key: the window is asked, nothing was sent yet
  assert.equal(asked.pendingKey?.host, `127.0.0.1:${device.port}`);
  assert.deepEqual(device.authed, []);
  // connect once: the password held here for the retry signs in
  const done = await panel.hostKey('c1', 'once');
  assert.equal(done.pendingKey, undefined);
  assert.equal(done.sessions.length, 1);
  assert.deepEqual(device.authed, ['operator']);
  // what the windows got, the question and every state push, never carries it
  assert(events.some((event) => event.kind === 'state'));
  assert.doesNotMatch(
    JSON.stringify([asked, done, events]),
    new RegExp(SSH_PASSWORD),
  );
});

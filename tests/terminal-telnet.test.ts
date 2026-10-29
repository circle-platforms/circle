// A console server on 127.0.0.1 answers the telnet client byte for byte: what it sends
// of negotiation must never reach the screen, and what the client sends must be the
// window-size report it promised.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { telnetConnector } from '../src/terminal/telnet.js';
import type { ConnectEnv } from '../src/terminal/transport.js';
import { cleanup, until } from './helpers.js';

const IAC = 255;
const WILL = 251;
const WONT = 252;
const DO = 253;
const SB = 250;
const SE = 240;
const ECHO = 1;
const NAWS = 31;

function env(): ConnectEnv {
  return {
    secret: () => '',
    keyFile: (path) => path,
    trusted: () => true,
    signal: new AbortController().signal,
  };
}

// A busy runner delays sockets: wait for the bytes, not for guessed milliseconds.

const target = (port: number, cols = 80, rows = 24) => ({
  transport: 'telnet' as const,
  host: '127.0.0.1',
  port,
  target: `127.0.0.1:${port}`,
  cols,
  rows,
});

/** One console server; records every byte the client sends. */
async function consoleServer(t: test.TestContext) {
  const sockets: Socket[] = [];
  const received: Buffer[] = [];
  let onSocket: ((socket: Socket) => void) | undefined;
  const server: NetServer = createServer((socket) => {
    sockets.push(socket);
    received.length = 0;
    socket.on('data', (bytes) => received.push(Buffer.from(bytes)));
    socket.on('error', () => {});
    onSocket?.(socket);
  });
  cleanup(t, () => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((done) => server.close(() => done()));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address !== 'object') throw Error('no address');
  return {
    port: address.port,
    all: () => Buffer.concat(received),
    wait: (handler: (socket: Socket) => void) => {
      onSocket = handler;
    },
    // the client's connect can beat the server's accept: only kill once a socket landed
    ready: () => sockets.length > 0,
    kill: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}

test('the client offers its window, answers negotiation, and keeps raw data whole', async (t) => {
  const device = await consoleServer(t);
  let socket!: Socket;
  device.wait((one) => {
    socket = one;
    // Ask for the client's echo (should be declined) and send a banner
    socket.write(Buffer.from([IAC, DO, ECHO]));
    socket.write('TELNET banner\r\ncon> ');
  });
  const outcome = await telnetConnector(target(device.port), env());
  assert.ok('transport' in outcome);
  const console = (
    outcome as {
      transport: import('../src/terminal/transport.js').TerminalTransport;
    }
  ).transport;
  const screen: Buffer[] = [];
  console.onData((bytes) => screen.push(bytes));
  // Negotiation reaches the screen nowhere: what does is the banner, IAC IAC intact
  await until(() => Buffer.concat(screen).length >= 18, {
    timeout: 8000,
    label: () =>
      `18 bytes on the screen (saw ${JSON.stringify(Buffer.concat(screen).toString('latin1'))})`,
  });
  const shown = Buffer.concat(screen).toString('latin1');
  assert.equal(shown, 'TELNET banner\r\ncon> ');
  assert.equal(shown.includes(String.fromCharCode(IAC)), false);
  // WILL NAWS was promised, the window reported, and DO ECHO declined
  await until(() => device.all().includes(Buffer.from([IAC, WONT, ECHO])), {
    timeout: 8000,
    label: () => `WONT ECHO (saw ${device.all().toString('hex')})`,
  });
  const sent = device.all();
  assert.ok(
    sent.includes(Buffer.from([IAC, WILL, NAWS])),
    `no WILL NAWS in ${sent.toString('hex')}`,
  );
  assert.ok(
    sent.includes(Buffer.from([IAC, SB, NAWS, 0, 80, 0, 24, IAC, SE])),
    'no initial NAWS report',
  );
  console.write('show version\r');
  await until(() => device.all().includes(Buffer.from('show version\r')), {
    timeout: 8000,
    label: 'the device to get the typed line',
  });
  // A resize reports the new window
  console.resize(132, 43);
  await until(
    () =>
      device
        .all()
        .includes(Buffer.from([IAC, SB, NAWS, 0, 132, 0, 43, IAC, SE])),
    { timeout: 8000, label: 'the resized NAWS' },
  );
  console.close();
});

test('negotiation split across packets is stitched, not shown', async (t) => {
  const device = await consoleServer(t);
  device.wait((socket) => {
    // WILL + option split, and an escaped 0xFF written as its own IAC pair
    socket.write(Buffer.from([IAC, WILL]));
    socket.write(Buffer.from([NAWS]));
    socket.write(Buffer.from(['a'.charCodeAt(0), IAC, IAC, 'b'.charCodeAt(0)]));
    socket.write(Buffer.from([IAC, SB, NAWS, 0, 80, 0, 24]));
    socket.write(Buffer.from([IAC, SE, 'c'.charCodeAt(0)]));
  });
  const outcome = await telnetConnector(target(device.port), env());
  const console = (
    outcome as {
      transport: import('../src/terminal/transport.js').TerminalTransport;
    }
  ).transport;
  const screen: Buffer[] = [];
  console.onData((bytes) => screen.push(bytes));
  await until(() => Buffer.concat(screen).length >= 4, {
    timeout: 8000,
    label: () =>
      `4 bytes on the screen (saw ${Buffer.concat(screen).toString('hex')})`,
  });
  // 'a', one literal 0xFF, 'b', 'c': the split negotiation vanished as it should
  assert.deepEqual(
    [...Buffer.concat(screen)],
    [0x61, 0xff, 0x62, 0x63],
    Buffer.concat(screen).toString('hex'),
  );
});

test('a closed console says so and typing stops', async (t) => {
  const device = await consoleServer(t);
  device.wait((socket) => socket.write('bye\r\n'));
  const outcome = await telnetConnector(target(device.port), env());
  const console = (
    outcome as {
      transport: import('../src/terminal/transport.js').TerminalTransport;
    }
  ).transport;
  let ended = '';
  console.onEnd((reason) => {
    ended = reason;
  });
  await until(() => device.ready(), {
    timeout: 8000,
    label: 'the server to take the socket',
  });
  device.kill();
  for (let at = 0; at < 320 && !ended; at++)
    await new Promise((done) => setTimeout(done, 25));
  // a torn socket says reset or hang up, a politely closed one says closed:
  // either way the console knows it ended, and the run must not end silent
  assert.match(ended, /closed|reset|hang up|ECONN/i, `ended as: ${ended}`);
});

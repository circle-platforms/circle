// Telnet over a plain TCP socket: enough of the protocol for console servers. The client
// offers its window size (NAWS) and nothing else; option requests are refused or ignored
// so the server keeps echoing and line-buffering as a console expects. Binary and 8-bit
// streams are left as they come: the IAC parser is the only thing taken apart.
import { createConnection, type Socket } from 'node:net';
import type { Connector, TerminalTransport } from './transport.js';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;
const NAWS = 31;

const naws = (cols: number, rows: number): Buffer =>
  Buffer.from([
    IAC,
    SB,
    NAWS,
    (cols >> 8) & 0xff,
    cols & 0xff,
    (rows >> 8) & 0xff,
    rows & 0xff,
    IAC,
    SE,
  ]);

class TelnetConsole implements TerminalTransport {
  private data: (bytes: Buffer) => void = () => {};
  private ended: (reason: string) => void = () => {};
  private closed = false;
  // Where a split IAC sequence stopped in the last chunk, so the next chunk continues it
  private pending = Buffer.alloc(0);
  constructor(
    private socket: Socket,
    private cols: number,
    private rows: number,
  ) {
    socket.on('data', (chunk: Buffer) => this.feed(chunk));
    socket.on('close', () => this.finish('the device closed the connection'));
    socket.on('error', (error) =>
      this.finish(error instanceof Error ? error.message : String(error)),
    );
  }
  onData(handler: (bytes: Buffer) => void): void {
    this.data = handler;
  }
  onEnd(handler: (reason: string) => void): void {
    this.ended = handler;
  }
  write(bytes: Buffer | string): void {
    if (!this.closed) this.socket.write(bytes);
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (!this.closed) this.socket.write(naws(cols, rows));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
  }
  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ended(reason);
  }
  /** Pull the option negotiation out of the stream; keep everything else, IAC IAC as 0xFF. */
  private feed(chunk: Buffer): void {
    const bytes = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : chunk;
    const plain: number[] = [];
    let at = 0;
    while (at < bytes.length) {
      if (bytes[at] !== IAC) {
        plain.push(bytes[at]!);
        at++;
        continue;
      }
      const command = bytes[at + 1];
      if (command === undefined) break; // a split IAC: the next chunk decides
      at += 2;
      if (command === IAC) {
        plain.push(IAC);
        continue;
      }
      if (
        command === WILL ||
        command === WONT ||
        command === DO ||
        command === DONT
      ) {
        const option = bytes[at];
        if (option === undefined) {
          at -= 2; // split mid-command; let the next chunk complete it
          break;
        }
        at += 1;
        // What we do is report the window size; everything else we decline.
        if (command === DO)
          this.socket.write(
            Buffer.from([IAC, option === NAWS ? WILL : WONT, option]),
          );
        continue;
      }
      if (command === SB) {
        // A sub-negotiation: consumed whole; the server's view of our window is not ours.
        let end = -1;
        for (let scan = at; scan < bytes.length - 1; scan++)
          if (bytes[scan] === IAC && bytes[scan + 1] === SE) {
            end = scan;
            break;
          }
        if (end === -1) break; // split inside a sub-negotiation
        at = end + 2;
        continue;
      }
      // Any other command: one operand at most, then it is consumed.
      if (bytes[at] === undefined) {
        at -= 2;
        break;
      }
      at += 1;
    }
    // A copy: the socket's buffer is not ours to keep referring to.
    this.pending =
      at < bytes.length ? Buffer.from(bytes.subarray(at)) : Buffer.alloc(0);
    if (plain.length) this.data(Buffer.from(plain));
  }
}

/** The connector the runtime uses for `transport: telnet`. */
export const telnetConnector: Connector = (target, env) =>
  new Promise((resolve, reject) => {
    if (env.signal.aborted)
      return reject(env.signal.reason ?? Error('stopped'));
    const socket = createConnection({
      host: target.host,
      port: target.port,
    });
    let settled = false;
    const abort = () => {
      socket.destroy();
      if (!settled) reject(env.signal.reason ?? Error('stopped'));
    };
    env.signal.addEventListener('abort', abort, { once: true });
    socket.setTimeout(20000, () => {
      socket.destroy();
      if (!settled)
        reject(Error('the device did not answer within 20 seconds'));
    });
    socket.once('connect', () => {
      settled = true;
      env.signal.removeEventListener('abort', abort);
      socket.setTimeout(0);
      const console = new TelnetConsole(socket, target.cols, target.rows);
      // Offer the window size; the console answers on its own about echo and line mode.
      socket.write(Buffer.from([IAC, WILL, NAWS]));
      socket.write(naws(target.cols, target.rows));
      resolve({ transport: console });
    });
    socket.once('error', (error) => {
      env.signal.removeEventListener('abort', abort);
      if (!settled)
        reject(
          Error(
            `the device at ${target.target} did not answer: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    });
  });

// SSH with ssh2: one shell channel with a pseudo-terminal, the person's trust of the
// device's host key checked before anything is sent. A password comes only from a saved
// secret's name; a key file is taken as the file tools take it. An unknown host key stops
// the login and hands back a challenge, answered the way a browser certificate warning is.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ssh2 from 'ssh2';
import type { Channel } from 'ssh2';
import type {
  Connector,
  HostKeyChallenge,
  TerminalTransport,
} from './transport.js';

// Default-imported: the package is CommonJS and its exports are copied in a loop, which
// the named-import detector cannot always see. The types are a separate declaration file.
const { Client } = ssh2;

/** OpenSSH's own form: `SHA256:` and the key's SHA-256 in base64 without padding. */
export function hostKeyFingerprint(key: Buffer): string {
  return (
    'SHA256:' +
    createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
  );
}

/** The algorithm name of a host key: the first field of its SSH wire blob. */
function keyType(key: Buffer): string {
  if (key.length < 4) return '';
  const length = key.readUInt32BE(0);
  if (length <= 0 || 4 + length > key.length) return '';
  return key.subarray(4, 4 + length).toString('latin1');
}

class SshConsole implements TerminalTransport {
  private data: (bytes: Buffer) => void = () => {};
  private ended: (reason: string) => void = () => {};
  private closed = false;
  constructor(
    private client: InstanceType<typeof Client>,
    private channel: Channel,
  ) {
    channel.on('data', (bytes: Buffer) => this.data(bytes));
    channel.on('close', () => this.finish('the device closed the session'));
    channel.on('error', (error: Error) =>
      this.finish(error.message || 'the channel failed'),
    );
    client.on('error', (error: Error) =>
      this.finish(error.message || 'the SSH connection failed'),
    );
    client.on('close', () => this.finish('the SSH connection ended'));
  }
  onData(handler: (bytes: Buffer) => void): void {
    this.data = handler;
  }
  onEnd(handler: (reason: string) => void): void {
    this.ended = handler;
  }
  write(bytes: Buffer | string): void {
    if (!this.closed) this.channel.write(bytes);
  }
  resize(cols: number, rows: number): void {
    if (this.closed) return;
    try {
      this.channel.setWindow(rows, cols, 0, 0);
    } catch {
      /* The channel is gone; the end handler says so. */
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      /* Already gone. */
    }
    this.client.end();
    this.ended('disconnected');
  }
  private finish(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.ended(reason);
  }
}

/** The connector the runtime uses for `transport: ssh`. */
export const sshConnector: Connector = async (target, env) => {
  const client = new Client();
  let password = '';
  if (target.passwordSecret) {
    password = env.secret(target.passwordSecret);
    if (!password)
      throw Error(
        `no saved secret ${target.passwordSecret} for ${target.target}: ask the user to save it (/secrets)`,
      );
  }
  let privateKey: Buffer | undefined;
  let passphrase: string | undefined;
  if (target.keyPath) {
    privateKey = Buffer.from(readFileSync(env.keyFile(target.keyPath)));
    if (target.passphraseSecret) {
      passphrase = env.secret(target.passphraseSecret) || undefined;
      if (!passphrase)
        throw Error(
          `no saved secret ${target.passphraseSecret} for the key of ${target.target}`,
        );
    }
  }
  if (!password && !privateKey)
    throw Error(
      `${target.target}: the profile gives no way to sign in, no password secret and no key`,
    );
  // The host key is seen before anything else: unknown, it stops the login here and the
  // connect gives back the challenge instead of a console.
  let challenge: HostKeyChallenge | undefined;
  const opened = await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    // A refused connect leaves the socket in TIME_WAIT-ish churn: a late ECONNRESET can
    // arrive after the test or turn has moved on. Silence it and close the client for good.
    const seal = () => {
      client.removeAllListeners('error');
      client.on('error', () => {});
      client.destroy();
    };
    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      env.signal.removeEventListener('abort', abort);
      seal();
      reject(error);
    };
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      env.signal.removeEventListener('abort', abort);
      if (!value) seal();
      resolve(value);
    };
    const abort = () => stop(env.signal.reason ?? Error('stopped'));
    env.signal.addEventListener('abort', abort, { once: true });
    client.once('ready', () => finish(true));
    client.once('error', (error: Error) => {
      // A refused host key is not a failure: the person gets asked about it.
      if (challenge) return finish(false);
      stop(
        Error(
          `the device ${target.target} refused the connection: ${
            error.message || 'no reason given'
          }`,
        ),
      );
    });
    client.connect({
      host: target.host,
      port: target.port,
      username: target.user,
      ...(password ? { password, tryKeyboard: true } : {}),
      ...(privateKey
        ? { privateKey, ...(passphrase ? { passphrase } : {}) }
        : {}),
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      hostVerifier: (key: Buffer, verify: (trusted: boolean) => void) => {
        const fingerprint = hostKeyFingerprint(key);
        if (
          env.trusted(target.target, fingerprint) ||
          env.approval?.fingerprint === fingerprint
        )
          return verify(true);
        challenge = {
          host: target.target,
          keyType: keyType(key),
          fingerprint,
        };
        verify(false);
      },
    });
    // Some devices run a login through keyboard prompts rather than the password
    // method; the saved secret answers the ones that ask for it. ssh2 emits this
    // event but the typed overloads for Client do not list it.
    if (password)
      (client as EventEmitter).on(
        'keyboard-interactive',
        (
          _name: string,
          _instructions: string,
          _lang: string,
          prompts: { prompt: string; echo: boolean }[],
          finish: (responses: string[]) => void,
        ) => {
          finish(
            prompts.map((ask) =>
              /password/i.test(ask.prompt) || !ask.echo ? password : '',
            ),
          );
        },
      );
  });
  if (!opened) {
    client.destroy();
    if (!challenge) throw Error('no host key to ask about');
    return { hostkey: challenge };
  }
  const channel = await new Promise<Channel>((resolve, reject) => {
    client.shell(
      { rows: target.rows, cols: target.cols, term: 'xterm-256color' },
      (error, stream) =>
        error
          ? reject(
              Error(
                `the device ${target.target} opened no shell: ${error.message}`,
              ),
            )
          : resolve(stream),
    );
  });
  return { transport: new SshConsole(client, channel) };
};

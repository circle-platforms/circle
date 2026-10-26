// SSH with ssh2: one shell channel with a pseudo-terminal, the person's trust of the
// device's host key checked before anything is sent. A password comes only from a saved
// secret's name; a key file is taken the way the file tools take it. An unknown host key
// pauses the login inside its handshake and leaves a question: the answer resumes that
// very connection, the way OpenSSH asks "are you sure you want to continue connecting"
// without starting over. A wait that runs out, or a wire the device hung up, leaves the
// answer to log in from scratch instead.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import ssh2 from 'ssh2';
import type { Channel } from 'ssh2';
import type {
  Connector,
  HostKeyChallenge,
  LiveHostKey,
  TerminalTransport,
} from './transport.js';

// Default-imported: the package is CommonJS and its exports are copied in a loop, which
// the named-import detector cannot always see. The types are a separate declaration file.
const { Client } = ssh2;

// How long the device gets to answer a handshake. ssh2's own readyTimeout cannot tell a
// slow device apart from a person thinking, so the client is given readyTimeout 0 and
// the waits are guarded here: this much before the question, this much after the answer.
const READY_MS = 20000;
// How long a login paused at a host key question keeps its wire open for the answer.
// Past that the socket goes; an answer still works, it just logs in from scratch.
const ASK_HOLD_MS = 60000;

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
      `${target.target}: nothing to sign in with: SSH needs a saved profile carrying a password secret name or a key; save one with terminal_profile_save`,
    );
  // The handshake ends three ways: the device let us in, the wire failed, or the
  // host key stopped the login and the person's answer is awaited on the open socket.
  let failure: Error | undefined;
  let markReady!: () => void;
  let markGone!: (error: Error) => void;
  const open = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    markGone = (error) => {
      if (failure) return;
      failure = error;
      reject(error);
    };
  });
  // A failure nobody waits on yet - the first connect learns of it through `ended`.
  open.catch(() => {});
  let markPaused!: () => void;
  const paused = new Promise<void>((resolve) => {
    markPaused = resolve;
  });
  const ended = Promise.race([
    open.then(
      () => 'ready' as const,
      () => 'failed' as const,
    ),
    paused.then(() => 'paused' as const),
  ]);
  let guard: ReturnType<typeof setTimeout> | undefined;
  let succeeded = false;
  const seal = () => {
    clearTimeout(guard);
    // A refused connect leaves the socket in TIME_WAIT-ish churn: a late ECONNRESET can
    // arrive after the test or turn has moved on. Silence it and close the client for good.
    client.removeAllListeners('error');
    client.on('error', () => {});
    client.destroy();
  };
  const arm = (ms: number, why: string) => {
    clearTimeout(guard);
    guard = setTimeout(() => {
      markGone(Error(why));
      seal();
    }, ms);
  };
  const abort = () => {
    markGone(env.signal.reason ?? Error('stopped'));
    if (!succeeded) seal();
  };
  env.signal.addEventListener('abort', abort, { once: true });
  // Once the console is handed over, the transport's own end says everything the
  // signal might: the connect is done and stops listening.
  const stopListening = () => {
    succeeded = true;
    clearTimeout(guard);
    env.signal.removeEventListener('abort', abort);
  };
  client.once('ready', () => {
    clearTimeout(guard);
    markReady();
  });
  client.on('error', (error: Error) => {
    markGone(error);
    if (!succeeded) seal();
  });
  client.on('close', () => {
    markGone(Error('the SSH connection ended'));
    if (!succeeded) seal();
  });
  const openShell = async (): Promise<TerminalTransport> => {
    try {
      return await new Promise<Channel>((resolve, reject) => {
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
      }).then((stream) => new SshConsole(client, stream));
    } catch (error) {
      stopListening();
      seal();
      throw error;
    }
  };
  // The host key is seen before anything else: unknown, the handshake waits there and
  // the connect gives back the challenge with the live login still open behind it.
  let challenge: HostKeyChallenge | undefined;
  let resumeVerify: ((trust: boolean) => void) | undefined;
  // The key the person has answered for on this connection, for a later re-key.
  let approved: string | undefined;
  client.connect({
    host: target.host,
    port: target.port,
    username: target.user,
    ...(password ? { password, tryKeyboard: true } : {}),
    ...(privateKey
      ? { privateKey, ...(passphrase ? { passphrase } : {}) }
      : {}),
    // The guards above: ssh2's own timer cannot be re-armed across the person's wait.
    readyTimeout: 0,
    keepaliveInterval: 15000,
    hostVerifier: (key: Buffer, verify: (trusted: boolean) => void) => {
      const fingerprint = hostKeyFingerprint(key);
      if (
        env.trusted(target.target, fingerprint) ||
        env.approval?.fingerprint === fingerprint ||
        // A re-key on a resumed login presents the same key: the person's answer
        // covers this connection, even though a 'once' answer trusts nothing kept
        approved === fingerprint
      )
        return verify(true);
      challenge = {
        host: target.target,
        keyType: keyType(key),
        fingerprint,
      };
      // Leave the handshake paused: returning undefined tells ssh2 the answer is
      // coming later, and the wire stays open for it.
      arm(ASK_HOLD_MS, 'nobody answered the host key question');
      resumeVerify = verify;
      markPaused();
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
  // The socket is armed here, not before connect: a key that will not parse throws
  // synchronously and must not leave a timer behind.
  arm(READY_MS, 'no answer in time');
  const end = await ended;
  if (end === 'ready') {
    stopListening();
    return { transport: await openShell() };
  }
  if (end === 'failed') {
    stopListening();
    seal();
    if (env.signal.aborted) throw failure ?? Error('stopped');
    throw Error(
      `the device ${target.target} refused the connection: ${
        failure?.message || 'no reason given'
      }`,
    );
  }
  if (!challenge) throw Error('no host key to ask about');
  const asked = challenge;
  const live: LiveHostKey = {
    resume: async () => {
      if (failure) throw failure;
      const verify = resumeVerify;
      if (!verify) throw Error('the paused login is no longer waiting');
      resumeVerify = undefined;
      approved = asked.fingerprint;
      arm(READY_MS, 'the device did not finish the handshake in time');
      verify(true);
      await open;
      stopListening();
      return openShell();
    },
    decline: () => {
      const verify = resumeVerify;
      resumeVerify = undefined;
      if (!verify) return;
      markGone(Error('the host key was refused'));
      verify(false);
      seal();
    },
  };
  return { hostkey: asked, live };
};

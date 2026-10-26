/**
 * One open device console: raw bytes in both directions, size changes, close. The SSH and
 * Telnet transports implement it; tests hand in a fake through the same seam.
 */
export interface TerminalTransport {
  onData(handler: (bytes: Buffer) => void): void;
  /** Called once when the console ends, by the device or by an error. */
  onEnd(handler: (reason: string) => void): void;
  write(bytes: Buffer | string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

/** A device's host key the person has not allowed yet: the login stops and asks. */
export interface HostKeyChallenge {
  /** The device, as `host:port`. */
  host: string;
  keyType: string;
  fingerprint: string;
}

/**
 * The login a connect paused mid-handshake on an unknown host key, still open for the
 * person's answer: resuming it does the sign-in on the wire already built, so an
 * approval does not pay for a second TCP connection and key exchange.
 */
export interface LiveHostKey {
  /**
   * Resume the paused handshake with the person's answer and give the open console.
   * Rejects when the wire died or the wait ran out: the connect must then start over.
   */
  resume(): Promise<TerminalTransport>;
  /** The person said no: drop the paused login. */
  decline(): void;
}

/** What one connect gives back: an open console, or the host key to ask about first. */
export type ConnectOutcome =
  | { transport: TerminalTransport }
  | { hostkey: HostKeyChallenge; live?: LiveHostKey };

/** The person's answer to a host key challenge, carried into the connect asked again. */
export interface HostKeyApproval {
  fingerprint: string;
  scope: 'once' | 'always';
}

/** What a connector may need of the runtime that hosts it, all by the runtime's policy. */
export interface ConnectEnv {
  /** A saved secret's value by name; '' when the name is not saved. */
  secret(name: string): string;
  /** A key file's path, as the file tools take it; throws for a credential file. */
  keyFile(path: string): string;
  /** Whether this exact host key is already trusted for good. */
  trusted(host: string, fingerprint: string): boolean;
  /** The host key the person just allowed, on the connect that asks again. */
  approval?: HostKeyApproval;
  signal: AbortSignal;
}

/**
 * Opens one device console for a profile. The fake the tests use answers through the same
 * type, so nothing above a connector knows which transport ran.
 */
export type Connector = (
  target: TerminalTarget,
  env: ConnectEnv,
) => Promise<ConnectOutcome>;

/** What a transport takes to open a console: a profile's wire-level half, already checked. */
export interface TerminalTarget {
  transport: 'ssh' | 'telnet';
  host: string;
  port: number;
  /** `host:port`, lower case: what approvals, the trust store and the tools go by. */
  target: string;
  user?: string;
  /** A saved secret's NAME holding the password; the value is read through env. */
  passwordSecret?: string;
  keyPath?: string;
  passphraseSecret?: string;
  cols: number;
  rows: number;
}

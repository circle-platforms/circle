// Host keys the person trusted for good, each on one device (`host:port`) by its SHA-256
// fingerprint, kept in `terminal-host-keys.json`. Only devices on this network are kept: a
// public host's key is asked about every time, as a browser's certificate warning is.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateHost } from '../browser/hosts.js';

export interface HostKeyEntry {
  /** The device, as `host:port`, lower case. */
  host: string;
  keyType: string;
  /** `SHA256:` and the base64 fingerprint, as OpenSSH writes it. */
  fingerprint: string;
}

export class TrustedHostKeys {
  private entries = new Map<string, HostKeyEntry>();
  constructor(private file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        keys?: Partial<HostKeyEntry>[];
      };
      for (const entry of saved.keys ?? [])
        if (
          typeof entry.host === 'string' &&
          typeof entry.fingerprint === 'string' &&
          privateHost(entry.host)
        )
          this.entries.set(
            key(entry.host, entry.fingerprint),
            normalize(entry.host, entry.fingerprint, entry.keyType),
          );
    } catch {
      /* Nothing trusted yet. */
    }
  }
  has(host: string, fingerprint: string): boolean {
    return !!fingerprint && this.entries.has(key(host, fingerprint));
  }
  /**
   * The keys a device holds, whatever their type: a key that changed with the same
   * fingerprint is the same key re-offered.
   */
  add(host: string, fingerprint: string, keyType = ''): void {
    if (!fingerprint || !privateHost(host)) return;
    this.entries.set(
      key(host, fingerprint),
      normalize(host.toLowerCase(), fingerprint, keyType),
    );
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.file,
      JSON.stringify({ keys: [...this.entries.values()] }, null, 2) + '\n',
      { mode: 0o600 },
    );
  }
}

function normalize(
  host: string,
  fingerprint: string,
  keyType: unknown,
): HostKeyEntry {
  return {
    host,
    fingerprint,
    keyType: typeof keyType === 'string' ? keyType : '',
  };
}

const key = (host: string, fingerprint: string) =>
  host.toLowerCase() + '\n' + fingerprint;

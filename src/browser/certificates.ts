import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { privateHost } from './hosts.js';

/**
 * Certificates the person trusted for good, each on one host (`name:port`) by its SHA-256
 * fingerprint, kept in `browser-certificates.json`. Only hosts on this network are kept:
 * a public site's warning is asked about every time.
 */
export class TrustedCertificates {
  private keys = new Set<string>();
  constructor(private file?: string) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as {
        certificates?: { host?: unknown; fingerprint?: unknown }[];
      };
      for (const entry of saved.certificates ?? [])
        if (
          typeof entry.host === 'string' &&
          typeof entry.fingerprint === 'string' &&
          privateHost(entry.host)
        )
          this.keys.add(key(entry.host, entry.fingerprint));
    } catch {
      /* Nothing trusted yet. */
    }
  }
  has(host: string, fingerprint: string): boolean {
    return !!fingerprint && this.keys.has(key(host, fingerprint));
  }
  add(host: string, fingerprint: string): void {
    if (!fingerprint || !privateHost(host)) return;
    this.keys.add(key(host, fingerprint));
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.file,
      JSON.stringify(
        {
          certificates: [...this.keys].map((entry) => {
            const [host, fingerprint] = entry.split('\n');
            return { host, fingerprint };
          }),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
  }
}
const key = (host: string, fingerprint: string) =>
  host.toLowerCase() + '\n' + fingerprint;

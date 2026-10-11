// Values an extension keeps between runs: a token it signed in with, a key the user gave it.
// Each extension has its own file under the Circle home, private to the user; nothing here is
// in settings.json, credentials.json, a session or a request to the model.
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';
import { isRecord, readJson, writePrivateJson } from './settings.js';

export class ExtensionSecretError extends Error {}
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_VALUE_BYTES = 4096;
export const extensionSecretsDir = (home: string): string =>
  join(home, 'extension_secrets');

function checkName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !NAME.test(name))
    throw new ExtensionSecretError(
      `invalid secret name '${String(name)}': use letters, digits, _, . and -`,
    );
}
export function checkSecretValue(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value)
    throw new ExtensionSecretError('a secret value must be a non-empty string');
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES)
    throw new ExtensionSecretError('a secret value may be at most 4096 bytes');
  if (value.includes('\0'))
    throw new ExtensionSecretError('a secret value may not contain NUL');
}

export class ExtensionSecrets {
  constructor(
    private readonly home: string,
    private readonly extension: string,
    // Every value read or written is shown to the extension's masking (see ExtensionAPI).
    private readonly remember: (value: string) => void = () => {},
  ) {}
  private get path(): string {
    // The name ends in .secrets.json, a credential file name: the model's tools refuse it.
    return join(
      extensionSecretsDir(this.home),
      this.extension + '.secrets.json',
    );
  }
  private read(): Record<string, string> {
    if (!existsSync(this.path)) return {};
    const raw = readJson(this.path);
    if (!isRecord(raw))
      throw new ExtensionSecretError(
        `${this.path} must contain an object of names and values`,
      );
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(raw))
      if (NAME.test(name) && typeof value === 'string' && value)
        values[name] = value;
    return values;
  }
  private async locked<T>(operation: () => T): Promise<T> {
    const directory = extensionSecretsDir(this.home);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(directory, {
      lockfilePath: join(directory, '.node-lock'),
      retries: { retries: 100, minTimeout: 10, maxTimeout: 30 },
      stale: 10000,
    });
    try {
      return operation();
    } finally {
      await release();
    }
  }
  async get(name: string): Promise<string | undefined> {
    checkName(name);
    const value = await this.locked(() => this.read()[name]);
    if (value !== undefined) this.remember(value);
    return value;
  }
  async set(name: string, value: string): Promise<void> {
    checkName(name);
    checkSecretValue(value);
    this.remember(value);
    await this.locked(() =>
      writePrivateJson(this.path, { ...this.read(), [name]: value }),
    );
  }
  async delete(name: string): Promise<boolean> {
    checkName(name);
    return this.locked(() => {
      const values = this.read();
      if (!(name in values)) return false;
      delete values[name];
      writePrivateJson(this.path, values);
      return true;
    });
  }
  async names(): Promise<string[]> {
    return this.locked(() => Object.keys(this.read()).sort());
  }
}

// Replaces each remembered value with *** in text an extension hands to the model or the
// screen. A value shorter than four characters is not masked: it would mangle ordinary text
// and is no secret worth the name.
export class SecretMask {
  private values = new Set<string>();
  remember(value: string): void {
    if (value.length >= 4) this.values.add(value);
  }
  get size(): number {
    return this.values.size;
  }
  text(text: string): string {
    if (!this.values.size || !text) return text;
    let masked = text;
    for (const value of [...this.values].sort((a, b) => b.length - a.length))
      masked = masked.replaceAll(value, '***');
    return masked;
  }
  value(value: unknown): unknown {
    if (!this.values.size || value === null || value === undefined)
      return value;
    if (typeof value === 'string') return this.text(value);
    const json = JSON.stringify(value);
    if (json === undefined) return value;
    // Inside JSON a value with quotes or backslashes is escaped, so look for both forms.
    let masked = this.text(json);
    for (const secret of [...this.values].sort((a, b) => b.length - a.length))
      masked = masked.replaceAll(JSON.stringify(secret).slice(1, -1), '***');
    if (masked === json) return value;
    try {
      return JSON.parse(masked);
    } catch {
      return masked;
    }
  }
}

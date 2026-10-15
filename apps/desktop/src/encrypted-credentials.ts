import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { join } from 'node:path';
export interface NativeCredentialCipher {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
/** Only the main process owns this adapter; no renderer IPC can read credentials. */
export class EncryptedCredentialStore {
  private writes = new Map<string, Promise<unknown>>();
  constructor(
    private directory: string,
    private cipher: NativeCredentialCipher,
  ) {}
  private path(key: string) {
    if (
      typeof key !== 'string' ||
      !key.length ||
      key.length > 200 ||
      /[\0\r\n]/.test(key)
    )
      throw Error('invalid credential identity');
    if (
      !this.cipher.isEncryptionAvailable() ||
      this.cipher.getSelectedStorageBackend?.() === 'basic_text'
    )
      throw Error('secure operating-system credential storage is unavailable');
    return join(
      this.directory,
      createHash('sha256').update(key).digest('hex') + '.bin',
    );
  }
  async get(key: string): Promise<string | undefined> {
    const path = this.path(key);
    await this.writes.get(key)?.catch(() => {});
    try {
      return this.cipher.decryptString(await readFile(path));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw Error('saved credential could not be read securely');
    }
  }
  private async mutate(key: string, operation: () => Promise<void>) {
    const previous = this.writes.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.writes.set(key, next);
    try {
      await next;
    } finally {
      if (this.writes.get(key) === next) this.writes.delete(key);
    }
  }
  async put(key: string, value: string): Promise<void> {
    const path = this.path(key);
    if (typeof value !== 'string' || Buffer.byteLength(value) > 1048576)
      throw Error('invalid credential value');
    const encrypted = this.cipher.encryptString(value);
    await this.mutate(key, async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const temporary = path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(() => {});
      }
    });
  }
  async delete(key: string): Promise<void> {
    const path = this.path(key);
    await this.mutate(key, async () => {
      try {
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw Error('saved credential could not be removed');
      }
    });
  }
}
export function nativeHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192)
    throw Error('invalid external link');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error('invalid external link');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw Error('external links require HTTPS without credentials');
  return url.href;
}

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isRecord,
  readJson,
  withPrivateJsonLock,
  writePrivateJson,
} from '../../../src/settings.js';
import {
  CREDENTIAL_REENTRY,
  type RuntimeCredentialStore,
} from './runtime-private-channel';

// The desktop keeps its private credentials as the terminal keeps credentials.json and
// secrets.json: a JSON file in Circle's data folder that only the owner can read (mode
// 0600). Values are stored as they are, not encrypted; there is no keychain, libsecret or
// DPAPI. The name ends in .secrets.json, a credential file name the model's tools refuse.
export const PRIVATE_CREDENTIALS_FILE = 'desktop.secrets.json';
/** The keys the desktop has kept so far; a legacy entry is found by its key's hash. */
export const DESKTOP_CREDENTIAL_KEYS = ['github.com'] as const;
const MAX_VALUE_BYTES = 1024 * 1024;

/** A saved credential could not be carried over and has to be entered again. */
export class CredentialReentryRequired extends Error {
  constructor() {
    super(CREDENTIAL_REENTRY);
  }
}
interface Contents {
  credentials: Record<string, string>;
  reenter: string[];
}
function identity(key: unknown): asserts key is string {
  if (
    typeof key !== 'string' ||
    !key.length ||
    key.length > 200 ||
    /[\0\r\n]/.test(key)
  )
    throw Error('invalid credential identity');
}

/** Only the main process owns this store; no renderer IPC can read credentials. */
export class OwnerOnlyCredentialStore implements RuntimeCredentialStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;
  constructor(private readonly home: string) {
    this.path = join(home, PRIVATE_CREDENTIALS_FILE);
  }
  private read(): Contents {
    if (!existsSync(this.path)) return { credentials: {}, reenter: [] };
    let raw: unknown;
    try {
      raw = readJson(this.path);
    } catch {
      throw Error('saved credentials could not be read');
    }
    const credentials: Record<string, string> = {};
    const entries =
      isRecord(raw) && isRecord(raw.credentials) ? raw.credentials : {};
    for (const [key, value] of Object.entries(entries))
      if (typeof value === 'string' && value) credentials[key] = value;
    const reenter =
      isRecord(raw) && Array.isArray(raw.reenter)
        ? raw.reenter.filter((key): key is string => typeof key === 'string')
        : [];
    return { credentials, reenter };
  }
  private write(contents: Contents) {
    mkdirSync(this.home, { recursive: true, mode: 0o700 });
    writePrivateJson(this.path, {
      credentials: contents.credentials,
      ...(contents.reenter.length ? { reenter: contents.reenter } : {}),
    });
  }
  /** One change at a time in this process, and under the file's lock across processes. */
  private serial<T>(operation: () => T): Promise<T> {
    const next = this.queue
      .catch(() => {})
      .then(() => {
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
        return withPrivateJsonLock(this.path, operation);
      });
    this.queue = next;
    return next;
  }
  async get(key: string): Promise<string | undefined> {
    identity(key);
    return this.serial(() => {
      const contents = this.read();
      if (contents.reenter.includes(key)) throw new CredentialReentryRequired();
      return contents.credentials[key];
    });
  }
  async put(key: string, value: string): Promise<void> {
    identity(key);
    if (
      typeof value !== 'string' ||
      !value ||
      Buffer.byteLength(value) > MAX_VALUE_BYTES
    )
      throw Error('invalid credential value');
    await this.serial(() => {
      const contents = this.read();
      contents.credentials[key] = value;
      contents.reenter = contents.reenter.filter((name) => name !== key);
      this.write(contents);
    });
  }
  async delete(key: string): Promise<void> {
    identity(key);
    await this.serial(() => {
      const contents = this.read();
      if (!(key in contents.credentials) && !contents.reenter.includes(key))
        return;
      delete contents.credentials[key];
      contents.reenter = contents.reenter.filter((name) => name !== key);
      this.write(contents);
    });
  }
  /** Marks keys whose saved values could not be carried over, so their forms ask again. */
  async markReentry(keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    await this.serial(() => {
      const contents = this.read();
      for (const key of keys) {
        identity(key);
        if (!(key in contents.credentials) && !contents.reenter.includes(key))
          contents.reenter.push(key);
      }
      this.write(contents);
    });
  }
}

export interface LegacyCipher {
  isEncryptionAvailable(): boolean;
  decryptString(value: Buffer): string;
}
const legacyFile = (key: string) =>
  createHash('sha256').update(key).digest('hex') + '.bin';
/**
 * Moves what the earlier encrypted store (Electron safeStorage, one `<sha256(key)>.bin` per
 * key) held into the owner-only file, once: each entry is decrypted, written, and the old
 * folder is removed. An entry that cannot be decrypted, as when the keychain refuses, is
 * marked for re-entry instead. Nothing is removed unless the new file was written.
 */
export async function migrateEncryptedCredentials(
  legacyDirectory: string,
  store: OwnerOnlyCredentialStore,
  cipher: LegacyCipher,
  keys: readonly string[] = DESKTOP_CREDENTIAL_KEYS,
): Promise<{ moved: string[]; reenter: string[] }> {
  let names: string[];
  try {
    names = await readdir(legacyDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { moved: [], reenter: [] };
    throw error;
  }
  const moved: string[] = [],
    reenter: string[] = [];
  for (const key of keys) {
    if (!names.includes(legacyFile(key))) continue;
    let value: string | undefined;
    try {
      const encrypted = await readFile(join(legacyDirectory, legacyFile(key)));
      if (!cipher.isEncryptionAvailable()) throw Error('unavailable');
      value = cipher.decryptString(encrypted);
    } catch {
      value = undefined;
    }
    if (value) {
      await store.put(key, value);
      moved.push(key);
    } else reenter.push(key);
  }
  await store.markReentry(reenter);
  await rm(legacyDirectory, { recursive: true, force: true });
  return { moved, reenter };
}
/** The store, answering only once the one-time move has finished, whatever it came to. */
export function credentialsAfter(
  store: RuntimeCredentialStore,
  ready: Promise<unknown>,
): RuntimeCredentialStore {
  const settled = ready.catch(() => {});
  return {
    get: async (key) => {
      await settled;
      return store.get(key);
    },
    put: async (key, value) => {
      await settled;
      return store.put(key, value);
    },
    delete: async (key) => {
      await settled;
      return store.delete(key);
    },
  };
}

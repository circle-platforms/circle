import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { decodeSyncObject } from './canonical.js';
import { isObjectId, SYNC_LIMITS } from './protocol.js';
import type { SyncObject } from './types.js';

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error('knowledge directory is not a private directory');
  chmodSync(path, 0o700);
}
function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Retry only filesystem sharing violations; no protocol operation or failed test is retried here. */
export function renameObject(
  from: string,
  to: string,
  rename: (from: string, to: string) => void = renameSync,
  pause: (ms: number) => void = (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') || attempt >= 4)
        throw error;
      pause(10 * (attempt + 1));
    }
  }
}
/** Caller holds its SQLite write transaction while publishing or recovering files. */
export class ObjectFiles {
  constructor(readonly directory: string) {
    privateDirectory(directory);
  }
  path(id: string): string {
    if (!isObjectId(id))
      throw new TypeError('invalid knowledge object identity');
    return join(this.directory, id);
  }
  readBytes(id: string): Buffer {
    const path = this.path(id),
      stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > SYNC_LIMITS.objectBytes
    )
      throw Error('invalid knowledge object file');
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const bytes = readFileSync(fd);
      decodeSyncObject(bytes, id);
      return bytes;
    } finally {
      closeSync(fd);
    }
  }
  read(id: string): SyncObject {
    return decodeSyncObject(this.readBytes(id), id);
  }
  publish(id: string, bytes: Buffer): void {
    const path = this.path(id);
    decodeSyncObject(bytes, id);
    if (existsSync(path)) {
      if (!this.readBytes(id).equals(bytes))
        throw Error('existing knowledge object differs');
      return;
    }
    const temporary = join(this.directory, `.tmp-${randomUUID()}`);
    const fd = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameObject(temporary, path);
      syncDirectory(this.directory);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  recover(registered: (id: string) => boolean): number {
    let removed = 0;
    for (const name of readdirSync(this.directory)) {
      if (
        !/^\.tmp-[0-9a-f-]{36}$/.test(name) &&
        !(isObjectId(name) && !registered(name))
      )
        continue;
      const path = join(this.directory, name);
      // Never follow a file substituted by a link, even in a scratch home.
      if (!lstatSync(path).isFile())
        throw Error('invalid orphan knowledge object');
      rmSync(path);
      removed++;
    }
    if (removed) syncDirectory(this.directory);
    return removed;
  }
}

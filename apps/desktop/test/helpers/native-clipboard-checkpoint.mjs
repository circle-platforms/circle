import { mkdtemp, chmod, open, lstat, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

const digest = (text) => createHash('sha256').update(text).digest('hex');
export function validateClipboardPayload(payload) {
  if (!Array.isArray(payload))
    throw Error('invalid clipboard checkpoint items');
  let bytes = 0;
  if (
    payload.length > 64 ||
    payload.reduce(
      (n, item) => n + (Array.isArray(item) ? item.length : 0),
      0,
    ) > 256
  )
    throw Error('clipboard checkpoint exceeds format limit');
  for (const item of payload) {
    if (!Array.isArray(item) || !item.length)
      throw Error('invalid clipboard checkpoint item');
    for (const entry of item) {
      if (
        typeof entry.type !== 'string' ||
        !entry.type ||
        typeof entry.readType !== 'string' ||
        !entry.readType
      )
        throw Error('invalid clipboard checkpoint format');
      if (entry.kind === 'bytes') {
        if (
          typeof entry.mime !== 'string' ||
          !Array.isArray(entry.bytes) ||
          !entry.bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
        )
          throw Error('invalid clipboard checkpoint bytes');
        bytes += entry.bytes.length;
      } else if (entry.kind === 'bookmark') {
        if (
          typeof entry.value?.title !== 'string' ||
          typeof entry.value?.url !== 'string'
        )
          throw Error('invalid clipboard bookmark');
        bytes += entry.value.title.length * 2 + entry.value.url.length * 2;
      } else throw Error('unsupported clipboard checkpoint value');
      if (bytes > 16 * 1024 * 1024)
        throw Error('clipboard checkpoint exceeds byte limit');
    }
  }
  return payload;
}
export async function writeClipboardCheckpoint(
  payload,
  { parent = tmpdir() } = {},
) {
  validateClipboardPayload(payload);
  const directory = await realpath(
    await mkdtemp(join(parent, 'circle-private-clipboard-')),
  );
  try {
    await chmod(directory, 0o700);
    const file = join(directory, 'checkpoint.json');
    const text = JSON.stringify(payload);
    const handle = await open(file, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ version: 1, sha256: digest(text), payload }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') {
      const parentHandle = await open(directory, 'r');
      try {
        await parentHandle.sync();
      } finally {
        await parentHandle.close();
      }
    }
    await readClipboardCheckpoint({ directory, file });
    return { directory, file };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function readClipboardCheckpoint({ directory, file }) {
  if (
    basename(file) !== 'checkpoint.json' ||
    resolve(dirname(file)) !== resolve(directory)
  )
    throw Error('invalid clipboard checkpoint path');
  for (const path of [directory, file]) {
    const info = await lstat(path);
    if (
      info.isSymbolicLink() ||
      (path === file &&
        (!info.isFile() || info.nlink !== 1 || info.size > 96 * 1024 * 1024)) ||
      (path === directory && !info.isDirectory())
    )
      throw Error('unsafe clipboard checkpoint path');
    if (
      process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid()))
    )
      throw Error('clipboard checkpoint permissions are unsafe');
  }
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let record;
  try {
    const info = await handle.stat();
    if (
      info.nlink !== 1 ||
      info.size > 96 * 1024 * 1024 ||
      (process.platform !== 'win32' &&
        ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))
    )
      throw Error('unsafe clipboard checkpoint file');
    record = JSON.parse(await handle.readFile('utf8'));
  } finally {
    await handle.close();
  }
  if (
    record.version !== 1 ||
    record.sha256 !== digest(JSON.stringify(record.payload))
  )
    throw Error('clipboard checkpoint integrity check failed');
  return validateClipboardPayload(record.payload);
}
export async function removeClipboardCheckpoint(record) {
  await rm(record.directory, { recursive: true });
}

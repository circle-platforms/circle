import { constants, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { FileMutationTools } from './file_mutations.js';
import { protectedWorkspaceName } from './file_patterns.js';
import { mediaType } from './media.js';
import type { Sandbox } from './sandbox.js';
import type { ToolContext } from './types.js';

/**
 * A read as the desktop allows it: Circle's own offloaded output (history, large results,
 * job logs, saved pictures) is read directly, since it is never a workspace or granted
 * external file; anything else asks the native backend, and an external grant covers an
 * existing text file only. Without a native backend (the terminal) every read is allowed.
 * Returns the backend that decided, when there is one.
 */
export async function authorizeFileRead(
  sandbox: Sandbox,
  mutations: FileMutationTools | undefined,
  path: string,
  context: ToolContext,
): Promise<FileMutationTools | undefined> {
  const native = sandbox.isOffloadOutput(path) ? undefined : mutations;
  if (native) await native.authorize(path, context, 'read');
  if (
    native &&
    !sandbox.isInside(path) &&
    (statSync(path).isDirectory() || mediaType(path))
  )
    throw Error('native external file grants support existing text files only');
  return native;
}

/**
 * The bytes of a file a tool sends on, read under read_file's rules: the path taken as the
 * file tools take it (a `..` is refused), a credential file refused by name, and with a
 * native backend a file outside the workspace only with the person's grant. With a native
 * backend a workspace file is also refused as read_file's text reads there refuse it: under
 * `.git` or `.circle`, a credential name in any case where the file system ignores case, or
 * a file with other names on disk (a hard link, whose other name could be one the model may
 * not read). Only a regular file of at most `limit` bytes is read, as it is when read: one
 * that grows past the limit while it is read is refused.
 */
export async function readFileBytes(
  sandbox: Sandbox,
  mutations: FileMutationTools | undefined,
  raw: string,
  context: ToolContext,
  limit: number,
): Promise<{ path: string; bytes: Buffer }> {
  context.signal.throwIfAborted();
  const path = sandbox.resolvePath(raw);
  sandbox.checkCredentialPath(path);
  const native = await authorizeFileRead(sandbox, mutations, path, context);
  const workspace = native !== undefined && sandbox.isInside(path);
  if (workspace)
    for (const name of relative(sandbox.workspace, path).split(sep))
      if (
        protectedWorkspaceName(name, sandbox.credentialFiles, process.platform)
      )
        throw new Error(`file is not available in this workspace: ${name}`);
  const tooLarge = (size: number) =>
    new Error(
      `${raw} is ${size} bytes; this server takes files of at most ${limit} bytes`,
    );
  const notFile = () => new Error(`${raw} is not a regular file`);
  const found = await stat(path).catch((error: NodeJS.ErrnoException) => {
    throw error.code === 'ENOENT' ? new Error(`no such file: ${raw}`) : error;
  });
  if (!found.isFile()) throw notFile();
  if (found.size > limit) throw tooLarge(found.size);
  // Not blocking, and checked again once open: a path changed to a FIFO in between is refused
  // instead of waiting for a writer. In the workspace with a native backend, a path changed
  // to a symbolic link is not followed either, as that backend does not follow one.
  const handle = await open(
    path,
    constants.O_RDONLY |
      (constants.O_NONBLOCK ?? 0) |
      (workspace ? (constants.O_NOFOLLOW ?? 0) : 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw notFile();
    if (workspace && info.nlink > 1)
      throw new Error('hard-linked files were not granted');
    if (info.size > limit) throw tooLarge(info.size);
    const chunks: Buffer[] = [];
    const chunk = Buffer.allocUnsafe(Math.min(1 << 20, limit + 1));
    let size = 0;
    for (;;) {
      context.signal.throwIfAborted();
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > limit) throw tooLarge(size);
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return { path, bytes: Buffer.concat(chunks, size) };
  } finally {
    await handle.close();
  }
}

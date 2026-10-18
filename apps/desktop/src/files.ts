import { discoverWorkspace } from './workspace-discovery.ts';
import { readFile, stat, lstat, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NativeFile, NativeWorkspace } from './contracts';
import { MAX_FILE_BYTES, MAX_MEDIA_BYTES, MAX_TEXT_PREVIEW } from './policy.ts';
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
export async function nativeFile(
  path: string,
  maxTextBytes = MAX_TEXT_PREVIEW,
): Promise<NativeFile> {
  const info = await stat(path);
  const extension = extname(path).toLowerCase();
  const media = Boolean(imageTypes[extension]) || extension === '.pdf';
  if (!info.isFile()) throw Error('not a regular file');
  if (info.size > (media ? MAX_MEDIA_BYTES : MAX_FILE_BYTES))
    throw Error(
      media
        ? `${basename(path)} is over 20 MB`
        : `${basename(path)} is over 4 MB`,
    );
  const bytes = await readFile(path);
  const mime =
    imageTypes[extension] ??
    (extension === '.pdf' ? 'application/pdf' : 'text/plain');
  if (imageTypes[extension])
    return {
      id: randomUUID(),
      name: basename(path),
      mime,
      size: bytes.length,
      content: `data:${mime};base64,${bytes.toString('base64')}`,
      kind: 'image',
      truncated: false,
    };
  // The core sends a PDF to the model whole, as it does a mentioned one
  if (extension === '.pdf')
    return {
      id: randomUUID(),
      name: basename(path),
      mime,
      size: bytes.length,
      content: `data:${mime};base64,${bytes.toString('base64')}`,
      kind: 'document',
      truncated: false,
    };
  return {
    id: randomUUID(),
    name: basename(path),
    mime,
    size: bytes.length,
    content: bytes.subarray(0, maxTextBytes).toString('utf8'),
    kind: 'file',
    truncated: bytes.length > maxTextBytes,
  };
}
export class WorkspaceGrants {
  private roots = new Map<string, string>();
  private rootIdentities = new Map<string, string>();
  private rootHandles = new Map<string, string>();
  private fileHandles = new Map<string, string>();
  private files = new Map<string, { workspaceId: string; path: string }>();
  private pages = new Map<
    string,
    {
      workspace: NativeWorkspace;
      iterator: AsyncGenerator<string>;
      state: { truncated: boolean };
      check: () => void;
      rootIdentity: string;
    }
  >();
  async open(
    path: string,
    check: () => void = () => {},
  ): Promise<NativeWorkspace> {
    check();
    // Bound abandoned chooser/list continuations and close their directory handles.
    while (this.pages.size >= 8)
      await this.cancel(this.pages.keys().next().value!);
    const root = await realpath(path);
    const info = await stat(root);
    if (!info.isDirectory()) throw Error('workspace is not a folder');
    const known = this.rootHandles.get(root);
    const id =
      known && this.rootIdentities.get(known) === `${info.dev}:${info.ino}`
        ? known
        : randomUUID();
    this.rootHandles.set(root, id);
    const state = { truncated: false };
    const workspace: NativeWorkspace = {
      id,
      name: basename(root),
      path: root,
      files: [],
      truncated: false,
    };
    this.roots.set(id, root);
    this.rootIdentities.set(id, `${info.dev}:${info.ino}`);
    const cursor = randomUUID();
    this.pages.set(cursor, {
      workspace,
      iterator: discoverWorkspace(root, state, check),
      state,
      check,
      rootIdentity: `${info.dev}:${info.ino}`,
    });
    return this.nextPage(cursor, check);
  }
  async cancel(cursor: string): Promise<void> {
    const page = this.pages.get(cursor);
    this.pages.delete(cursor);
    await page?.iterator.return(undefined);
  }
  async nextPage(
    cursor: string,
    check: () => void = () => {},
  ): Promise<NativeWorkspace> {
    const page = this.pages.get(cursor);
    if (!page) throw Error('file listing cursor expired');
    this.pages.delete(cursor);
    const result: NativeWorkspace = {
      ...page.workspace,
      files: [],
      truncated: false,
    };
    try {
      page.check();
      check();
      const root = await realpath(result.path),
        info = await stat(root);
      if (
        root !== result.path ||
        `${info.dev}:${info.ino}` !== page.rootIdentity
      )
        throw Error('workspace root changed; reopen the folder');
      let done = false;
      for (let count = 0; count < 2000; count++) {
        page.check();
        check();
        const next = await page.iterator.next();
        if (next.done) {
          done = true;
          break;
        }
        const target = next.value;
        const key = `${result.id}\0${target}`;
        const fileId = this.fileHandles.get(key) ?? randomUUID();
        this.fileHandles.set(key, fileId);
        this.files.set(fileId, { workspaceId: result.id, path: target });
        const extension = extname(target).slice(1);
        result.files.push({
          id: fileId,
          path: relative(root, target).split('\\').join('/'),
          language:
            (
              {
                ts: 'typescript',
                tsx: 'typescript',
                js: 'javascript',
                json: 'json',
                md: 'markdown',
                py: 'python',
              } as Record<string, string>
            )[extension] ?? 'text',
        });
      }
      page.check();
      check();
      result.truncated = page.state.truncated;
      result.complete = done;
      if (!done) {
        const nextCursor = randomUUID();
        this.pages.set(nextCursor, page);
        result.nextCursor = nextCursor;
      }
      return result;
    } catch (error) {
      await page.iterator.return(undefined);
      throw error;
    }
  }
  async read(workspaceId: string, fileId: string) {
    const root = this.roots.get(workspaceId);
    const grant = this.files.get(fileId);
    if (!root || !grant || grant.workspaceId !== workspaceId)
      throw Error('file is not granted to this workspace');
    const rootInfo = await lstat(root);
    if (
      rootInfo.isSymbolicLink() ||
      (await realpath(root)) !== root ||
      `${rootInfo.dev}:${rootInfo.ino}` !== this.rootIdentities.get(workspaceId)
    )
      throw Error('workspace root changed; reopen the folder');
    if ((await lstat(grant.path)).isSymbolicLink())
      throw Error('symbolic link was not granted');
    const path = await realpath(grant.path);
    const local = relative(root, path);
    if (local.startsWith('..') || isAbsolute(local))
      throw Error('file moved outside the selected workspace');
    const value = await nativeFile(path);
    return { ...value, id: fileId, name: local.split('\\').join('/') };
  }
}

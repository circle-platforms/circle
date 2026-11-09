import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

/**
 * A file of a workspace, named by its path there, as Finder or Explorer is asked to show
 * it: never a file outside the workspace, by an absolute path, a `..` or a link out.
 */
export async function workspaceFileToReveal(
  workspace: string,
  path: string,
): Promise<string> {
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.split(/[\\/]/).includes('..')
  )
    throw Error('not a file of this workspace');
  const root = await realpath(workspace);
  let full: string;
  try {
    full = await realpath(resolve(root, path));
  } catch {
    throw Error('file does not exist');
  }
  const inside = relative(root, full);
  if (!inside || inside.startsWith('..') || isAbsolute(inside))
    throw Error('not a file of this workspace');
  return full;
}

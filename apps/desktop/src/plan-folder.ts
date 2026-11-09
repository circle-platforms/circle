import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { projectDataDir } from '../../../src/paths.js';
import { PLAN_FOLDER } from '../../../src/plan_file.js';

/** Larger than any plan or note; a file past it is not one Circle wrote to be read here. */
export const PLAN_FOLDER_MAX_BYTES = 2 * 1024 * 1024;

/**
 * A file of a conversation's plan folder, named as the model names it
 * (`/session_plans/<name>`), read for the window to show. The folder is Circle's, in its
 * data folder and out of the workspace: the window reads it here, never writes it, and
 * nothing outside the folder is reached by a name, a `..` or a link.
 */
export async function readPlanFolderFile(
  workspace: string,
  home: string,
  file: string,
  maxBytes = PLAN_FOLDER_MAX_BYTES,
): Promise<{ file: string; text: string; updatedAt: string }> {
  const name = new RegExp(`^/*${PLAN_FOLDER}[\\\\/]([^\\\\/]+)$`).exec(
    file,
  )?.[1];
  if (!name || name === '.' || name === '..' || name.includes('\0'))
    throw Error('not a file of the plan folder');
  const shown = `/${PLAN_FOLDER}/${name}`;
  const folder = join(projectDataDir(workspace, home), PLAN_FOLDER);
  let root: string;
  let target: string;
  try {
    root = await realpath(folder);
    target = await realpath(join(folder, name));
  } catch {
    throw Error(`${shown} does not exist`);
  }
  const inside = relative(root, target);
  if (
    !inside ||
    inside.startsWith('..') ||
    isAbsolute(inside) ||
    inside.includes(sep)
  )
    throw Error('not a file of the plan folder');
  const handle = await open(
    target,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw Error('not a file of the plan folder');
    if (info.size > maxBytes) throw Error(`${shown} is too large to show`);
    const bytes = await handle.readFile();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw Error(`${shown} is not a text file`);
    }
    if (text.includes('\0')) throw Error(`${shown} is not a text file`);
    return { file: shown, text, updatedAt: info.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

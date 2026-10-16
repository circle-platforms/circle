import { readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function metadataLine(value: string, name: string): string {
  const line = value.replace(/\r?\n$/, '');
  if (!line || /[\r\n\0]/.test(line))
    throw Error(`invalid cycle repository ${name}`);
  return line;
}

/** Fresh on every ownership check: no subprocess, cached path or cached branch. */
export async function cycleRepositoryIdentity(root: string): Promise<{
  directory: string;
  common: string;
  head: string;
}> {
  // Git's environment overrides -C. Filesystem ownership must never silently
  // validate a different repository from the commands that mutate it later.
  if (
    ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'].some(
      (key) => process.env[key],
    )
  )
    throw Error('cycle repository environment overrides are not supported');
  const marker = join(root, '.git');
  const markerStat = await stat(marker);
  let directory: string;
  if (markerStat.isDirectory()) directory = await realpath(marker);
  else if (markerStat.isFile()) {
    const pointer = metadataLine(await readFile(marker, 'utf8'), 'gitdir');
    if (!pointer.startsWith('gitdir: ') || pointer.length === 8)
      throw Error('invalid cycle repository gitdir');
    directory = await realpath(resolve(root, pointer.slice(8)));
  } else throw Error('invalid cycle repository gitdir');
  if (!(await stat(directory)).isDirectory())
    throw Error('cycle repository gitdir is not a directory');
  let commonPointer: string | undefined;
  try {
    commonPointer = await readFile(join(directory, 'commondir'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Only an absent file means main repository; a present dangling pointer fails.
  const common =
    commonPointer === undefined
      ? directory
      : await realpath(
          resolve(directory, metadataLine(commonPointer, 'commondir')),
        );
  if (!(await stat(common)).isDirectory())
    throw Error('cycle repository common directory is not a directory');
  // Permission/I/O failures remain failures; configuration contents stay private.
  await readFile(join(common, 'config'));
  const head = metadataLine(
    await readFile(join(directory, 'HEAD'), 'utf8'),
    'HEAD',
  );
  return { directory, common, head };
}

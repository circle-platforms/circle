import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let probe;

/**
 * Why this account cannot create a file symbolic link, or undefined when it
 * can. Windows refuses one with EPERM unless Developer Mode is on or the
 * process is elevated; only that refusal counts, every other error is thrown.
 */
export function fileSymlinkRefusal() {
  probe ??= (async () => {
    const root = await mkdtemp(join(tmpdir(), 'circle-symlink-probe-'));
    try {
      const target = join(root, 'target.txt');
      await writeFile(target, 'probe');
      await symlink(target, join(root, 'link.txt'), 'file');
      return undefined;
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
      return process.platform === 'win32'
        ? 'this Windows account may not create symbolic links (EPERM): turn on Developer Mode or run elevated'
        : 'this account may not create symbolic links (EPERM)';
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  })();
  return probe;
}

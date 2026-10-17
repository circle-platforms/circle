import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
/** Output is disposable except the tool cache, which the build revalidates before use. */
export async function resetDesktopOutput(dist) {
  await mkdir(dist, { recursive: true });
  for (const entry of await readdir(dist, { withFileTypes: true })) {
    if (entry.name !== 'tools' || !entry.isDirectory())
      await rm(join(dist, entry.name), { recursive: true, force: true });
  }
}

// The folders the bundled runtime reads beside itself. Its modules find them from the
// bundle's own URL (`new URL('./prompts/', import.meta.url)` and the like), so they sit
// next to runtime-worker.mjs: in dist/, and in a package inside app.asar.
import { cp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const sourceRoot = fileURLToPath(new URL('../../../src/', import.meta.url));

/** prompts and data as the terminal ships them, and the skills that ship with Circle. */
export const RUNTIME_ASSETS = ['prompts', 'data', 'builtin_skills'];

/** Copy the runtime's folders into the folder that holds the bundled runtime. */
export async function copyRuntimeAssets(dist) {
  for (const folder of RUNTIME_ASSETS)
    await cp(join(sourceRoot, folder), join(dist, folder), { recursive: true });
}

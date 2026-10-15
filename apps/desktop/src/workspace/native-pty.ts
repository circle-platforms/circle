import { createRequire as createPtyRequire } from 'node:module';
import type * as NodePty from 'node-pty';

let native: typeof NodePty | undefined;

/** Keep optional native dependencies out of workers until a terminal is opened. */
export const spawnPty: typeof NodePty.spawn = (...args) => {
  // esbuild also emits the main process as CJS; its module filename resolves
  // dist/node_modules while the ESM runtime worker resolves from import.meta.url.
  const requireNative = createPtyRequire(
    typeof __filename === 'string' ? __filename : import.meta.url,
  );
  native ??= requireNative('node-pty') as typeof NodePty;
  return native.spawn(...args);
};

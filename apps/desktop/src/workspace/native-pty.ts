import { createRequire as createPtyRequire } from 'node:module';
import type * as NodePty from 'node-pty';
import {
  assertSupportedWindowsPtyVersion,
  hasExitedWindowsPtyProcess,
  installWindowsPtyExitCleanup,
} from './pty-exit-cleanup.mjs';

let native: typeof NodePty | undefined;
let version: unknown;

/** Keep optional native dependencies out of workers until a terminal is opened. */
export function spawnPty(
  ...args: [
    ...Parameters<typeof NodePty.spawn>,
    onError?: (error: Error) => void,
  ]
): NodePty.IPty {
  // esbuild also emits the main process as CJS; its module filename resolves
  // dist/node_modules while the ESM runtime worker resolves from import.meta.url.
  const requireNative = createPtyRequire(
    typeof __filename === 'string' ? __filename : import.meta.url,
  );
  native ??= requireNative('node-pty') as typeof NodePty;
  version ??= (requireNative('node-pty/package.json') as { version: unknown })
    .version;
  assertSupportedWindowsPtyVersion(version);
  const terminal = native.spawn(args[0], args[1], args[2]);
  installWindowsPtyExitCleanup(terminal, { version, onError: args[3] });
  return terminal;
}

export function hasNativePtyProcessExited(terminal: NodePty.IPty): boolean {
  return hasExitedWindowsPtyProcess(terminal, { version });
}

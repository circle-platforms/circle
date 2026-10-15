import type { IPty, IDisposable } from 'node-pty';
export function assertSupportedWindowsPtyVersion(
  version: unknown,
  platform?: string,
): void;
export function installWindowsPtyExitCleanup(
  terminal: IPty,
  options: { version: unknown; platform?: string },
): IDisposable;

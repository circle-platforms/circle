import type { Plugin } from 'esbuild';

export function buildBundledExtensions(dist: string): Promise<void>;
export function shareExtensionError(): Plugin;

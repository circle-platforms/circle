import type { Plugin } from 'esbuild';

export function buildBundledExtensions(dist: string): Promise<void>;
export function keepExtensionImports(): Plugin;
export function shareExtensionError(): Plugin;

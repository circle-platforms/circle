export const NODE_PTY_VERSION: '1.1.0';
export const PRISTINE_SHA256: string;
export const PATCHED_SHA256: string;
export function patchNodePtySource(text: string): string;
export function repairNodePtyOnMacos(
  root: string,
  options?: {
    platform?: string;
    archs?: string[];
    run?: (
      file: string,
      args: string[],
      options: Record<string, unknown>,
    ) => unknown;
    gyp?: () => string;
  },
): Promise<boolean>;

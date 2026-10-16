export type PtyEnvironmentLayer = Record<string, string | null | undefined>;

/** Merge in launch priority order, using the child platform's environment identity. */
export function ptyEnvironment(
  platform: NodeJS.Platform,
  ...layers: (PtyEnvironmentLayer | undefined)[]
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const layer of layers) {
    for (const [name, value] of Object.entries(layer ?? {})) {
      const key = platform === 'win32' ? name.toUpperCase() : name;
      if (value === null || value === undefined) delete result[key];
      else
        Object.defineProperty(result, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
  }
  return result;
}

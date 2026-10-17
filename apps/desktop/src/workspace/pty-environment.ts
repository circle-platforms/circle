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

/**
 * A terminal's text is UTF-8. An application started from the Dock or Finder has no locale,
 * and a shell then reads each byte of typed non-ASCII text as a meta key. A locale the
 * person set is kept as it is.
 */
export function withTextLocale(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (
    platform !== 'win32' &&
    !environment.LC_ALL &&
    !environment.LC_CTYPE &&
    !environment.LANG
  )
    environment.LC_CTYPE = platform === 'darwin' ? 'UTF-8' : 'C.UTF-8';
  return environment;
}

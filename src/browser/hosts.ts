import { isIP } from 'node:net';

/**
 * A host only an address on this network can have: a private, loopback or link-local IP,
 * a name without dots, or a `.local`/`.lan`/`.internal`/`.home.arpa` name. Only such a
 * host's certificate can be trusted for good; a public one is asked about every time.
 */
export function privateHost(host: string): boolean {
  // `[v6]:port`, `v4:port` or `name:port`, as URL.host writes them
  const lower = host.toLowerCase();
  const bracketed = lower.match(/^\[([^\]]+)\](?::\d+)?$/);
  const name = bracketed
    ? bracketed[1]!
    : lower.split(':').length === 2
      ? lower.replace(/:\d+$/, '')
      : lower;
  if (isIP(name) === 4) {
    const [a, b] = name.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(name) === 6)
    return (
      name === '::1' ||
      /^f[cd][0-9a-f]{2}:/.test(name) ||
      /^fe[89ab][0-9a-f]:/.test(name)
    );
  return (
    !!name &&
    !name.includes(':') &&
    (!name.includes('.') ||
      /\.(local|lan|internal|intranet|corp|home\.arpa)$/.test(name))
  );
}

/** The URL the browser may open: http or https, with no user name or password in it. */
export function webUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

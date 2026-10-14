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

/** A page's site: `https://host:port` for a web address, else nothing. */
/**
 * The site a download comes from: its address's, or for a blob: the page's that made it.
 * Nothing for a data: address, which says nothing of where it came from.
 */
export const downloadSite = (url: string): string => {
  try {
    const origin = new URL(url).origin;
    return /^https?:\/\//.test(origin) ? origin : '';
  } catch {
    return '';
  }
};
export const siteOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
};

/** An address's host as URL.host writes it, lower case; nothing for no address. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}
/**
 * Why a saved secret goes into no page on this host, or nothing: on a public address whose
 * certificate was not trusted the page may be someone's in between, as it may not on this
 * network. Asked before a secret is typed or a sign-in answered with one, in every mode.
 */
export function secretRefused(host: string, untrusted: boolean): string {
  return untrusted && host && !privateHost(host)
    ? `a saved secret goes into no page on ${host}: its certificate is not trusted and it is a public address, so the page may not be the site's. Tell the user; nothing was typed.`
    : '';
}

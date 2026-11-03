/** A link the window may open outside itself: HTTPS only, with no credentials in it. */
export function nativeHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192)
    throw Error('invalid external link');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Error('invalid external link');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw Error('external links require HTTPS without credentials');
  return url.href;
}

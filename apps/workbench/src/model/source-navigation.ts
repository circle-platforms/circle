/** Local source links never go through the external browser. */
export interface SourceLocation {
  path: string;
  line?: number;
  column?: number;
}
export function sourceLocation(href: string): SourceLocation | null {
  if (
    !href ||
    href.startsWith('#') ||
    (/^[a-z][a-z\d+.-]*:/i.test(href) &&
      !href.startsWith('file:') &&
      !/^[^:/]+\.[^:/]+:\d+(?::\d+)?$/.test(href))
  )
    return null;
  let value = href;
  if (value.startsWith('file:')) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  const anchor = value.match(
    /(?:#L(\d+)(?:[C:](\d+))?(?:-L?\d+)?|:(\d+)(?::(\d+))?)$/,
  );
  const path = (anchor ? value.slice(0, anchor.index) : value).replace(
    /^\.\//,
    '',
  );
  if (!path || path.includes('\0') || path.includes('?') || path.includes('#'))
    return null;
  // Plain relative links need a filename; URL routes are not source files.
  if (
    !href.startsWith('file:') &&
    !path.startsWith('/') &&
    !/(?:^|\/)[^/]+\.[^/]+$/.test(path) &&
    !/(?:^|\/)(?:AGENTS|README|LICENSE|Dockerfile|Makefile)$/.test(path)
  )
    return null;
  const line = anchor ? Number(anchor[1] ?? anchor[3]) : undefined;
  const column =
    anchor && (anchor[2] ?? anchor[4])
      ? Number(anchor[2] ?? anchor[4])
      : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line < 1))
    return null;
  if (column !== undefined && (!Number.isSafeInteger(column) || column < 1))
    return null;
  return { path, line, column };
}
export function attachmentImage(content: string, mime?: string): string | null {
  const type = mime ?? 'image/png';
  if (!/^image\/(?:png|jpeg|gif|webp)$/.test(type)) return null;
  if (
    /^data:image\/(?:png|jpeg|gif|webp);base64,[a-zA-Z0-9+/=\s]+$/.test(content)
  )
    return content;
  return /^[a-zA-Z0-9+/=\s]+$/.test(content) && content.trim()
    ? `data:${type};base64,${content}`
    : null;
}

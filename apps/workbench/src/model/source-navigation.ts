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
      !/^file:/i.test(href) &&
      !/^[A-Za-z]:[\\/]/.test(href) &&
      !/^[^:/]+\.[^:/]+:\d+(?::\d+)?(?:[-–]L?\d+)?$/.test(href))
  )
    return null;
  let value = href;
  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = url.pathname + url.hash;
    } catch {
      return null;
    }
  }
  const anchor = value.match(
    /(?:#L(\d+)(?:[C:](\d+))?(?:-L?\d+)?|:(\d+)(?::(\d+))?(?:[-–]L?\d+)?)$/,
  );
  let path = anchor ? value.slice(0, anchor.index) : value;
  // Reject URI fragments/queries before decoding: encoded # and ? can be real
  // filename characters and must never be decoded twice or treated as anchors.
  if (path.includes('?') || path.includes('#')) return null;
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.replace(/^\.\//, '');
  if (!path || path.includes('\0')) return null;
  if (
    !/^file:/i.test(href) &&
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

/** Canonical document key relative to the granted root. Decode URI paths once;
 * plain filesystem names (including literal percent signs) are never decoded. */
export function workspaceRelativePath(
  source: string,
  workspaceRoot: string,
): string {
  let value = source;
  if (/^file:/i.test(value)) {
    const location = sourceLocation(value);
    if (!location) throw Error('unsupported source path');
    value = location.path;
  }
  if (
    !value ||
    value.includes('\0') ||
    !workspaceRoot ||
    workspaceRoot.includes('\0')
  )
    throw Error('unsupported source path');
  value = value.replaceAll('\\', '/');
  let root = workspaceRoot.replaceAll('\\', '/');
  if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  if (/^\/[A-Za-z]:\//.test(root)) root = root.slice(1);
  const windows = /^[A-Za-z]:\//.test(root) || root.startsWith('//');
  const absolute = (path: string) =>
    path.startsWith('/') || /^[A-Za-z]:\//.test(path);
  const collapse = (path: string) => {
    const prefix = path.startsWith('//')
      ? '//'
      : path.startsWith('/')
        ? '/'
        : /^[A-Za-z]:\//.test(path)
          ? path.slice(0, 3)
          : '';
    const body = path.slice(prefix.length);
    const parts: string[] = [];
    for (const part of body.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw Error('source is outside the workspace');
        parts.pop();
      } else parts.push(part);
    }
    return prefix + parts.join('/');
  };
  root = collapse(root).replace(/\/$/, '');
  if (
    !absolute(workspaceRoot.replaceAll('\\', '/')) &&
    !/^[A-Za-z]:\//.test(root)
  )
    throw Error('unsupported source path');
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[A-Za-z]:\//.test(value))
    throw Error('unsupported source path');
  let relative: string;
  if (absolute(value)) {
    value = collapse(value);
    const compare = (text: string) => (windows ? text.toLowerCase() : text);
    const prefix = root ? root + '/' : '/';
    if (!compare(value).startsWith(compare(prefix)))
      throw Error('source is outside the workspace');
    relative = value.slice(prefix.length);
  } else relative = collapse(value);
  if (
    !relative ||
    relative === '.' ||
    relative.startsWith('../') ||
    /^[A-Za-z]:/.test(relative)
  )
    throw Error('source is outside the workspace');
  return relative;
}

/** Only standalone inline-code file references become source links. Commands
 * and fenced code remain literal code; resolution still enforces the grant. */
export function inlineSourceLocation(value: string): SourceLocation | null {
  const text = value.trim().replace(/^\((.*)\)$/, '$1');
  if (
    !/^(?:file:\/\/|[A-Za-z]:[\\/]|\.?\.?[\\/]|[\\/]|[\w@.-]+[\\/])/.test(
      text,
    ) &&
    !/^(?:[\w@.-]+\.[\w-]+|AGENTS|README|LICENSE|Dockerfile|Makefile)(?:#L\d.*|:\d.*)?$/.test(
      text,
    )
  )
    return null;
  if (/[\n\r`<>]/.test(text) || /[();={}]/.test(text)) return null;
  return sourceLocation(text);
}

import { readFileSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname } from 'node:path';
export const APP_ORIGIN = 'circle://workbench';
export const MAX_FILE_BYTES = 4_000_000;
// Pictures and PDFs go to the model whole, as the core takes them
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
export const MAX_EXPORT_BYTES = 8_000_000;
export const MAX_TEXT_PREVIEW = 256_000;
export function trustedAppUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'circle:' &&
      url.host === 'workbench' &&
      url.pathname === '/index.html'
    );
  } catch {
    return false;
  }
}
// The media types of the window's own files. A module script, a worker and a
// stylesheet are refused under any other type.
const ASSET_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};
export function assetType(path: string): string {
  return ASSET_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
export function assetPath(root: string, value: string) {
  const url = new URL(value);
  if (url.protocol !== 'circle:' || url.host !== 'workbench')
    throw Error('invalid application origin');
  const pathname = decodeURIComponent(url.pathname);
  if (
    pathname.includes('\0') ||
    pathname.includes('\\') ||
    pathname.split('/').includes('..')
  )
    throw Error('invalid asset path');
  const path = resolve(
    root,
    '.' + (pathname === '/' ? '/index.html' : pathname),
  );
  const local = relative(root, path);
  if (local.startsWith('..') || isAbsolute(local))
    throw Error('asset is outside the application');
  return path;
}
/**
 * One of the window's own files, or undefined when there is none at that address. Read
 * synchronously: in the packaged application they are in the application archive, and
 * Electron's asynchronous reads from it sometimes never finish once several run at once,
 * which left the window empty with its scripts still loading. The synchronous reads do not
 * wait on them, and the files are small.
 */
export function windowFile(
  root: string,
  url: string,
): { body: Buffer<ArrayBuffer>; type: string } | undefined {
  const path = assetPath(root, url);
  try {
    if (!statSync(path).isFile()) return undefined;
    // A file read is never on shared memory
    const body = readFileSync(path) as Buffer<ArrayBuffer>;
    return { body, type: assetType(path) };
  } catch {
    return undefined;
  }
}
export function validSaveName(value: unknown) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 180 ||
    /[\\/\0\r\n]/.test(value) ||
    value === '.' ||
    value === '..'
  )
    throw Error('invalid export name');
  return value;
}
// A picture the window hands to the system: copied to the clipboard or saved to a file.
// The bytes come from a data URL of a picture type the window itself shows.
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
export function parseImageDataUrl(value: unknown): {
  mime: string;
  bytes: Buffer;
} {
  if (typeof value !== 'string' || value.length > MAX_MEDIA_BYTES * 1.4)
    throw Error('invalid image');
  const match = /^data:([a-z]+\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
    value,
  );
  if (!match || !IMAGE_TYPES.has(match[1]!)) throw Error('invalid image');
  const bytes = Buffer.from(match[2]!, 'base64');
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES)
    throw Error('invalid image');
  return { mime: match[1]!, bytes };
}
export function safeExternalUrl(value: string) {
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
export function boundedText(value: unknown, maxBytes: number) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes)
    throw Error('text exceeds the allowed size');
  return value;
}

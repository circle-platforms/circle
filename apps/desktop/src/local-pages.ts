import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workspaceFileToReveal } from './reveal';

/** The scheme a conversation's browser serves the workspace's pages under. */
export const LOCAL_SCHEME = 'circle-local';
/** Larger than any page or file a page loads that a person reads here. */
export const LOCAL_PAGE_MAX_BYTES = 50 * 1024 * 1024;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
};
/**
 * What a local page may load: its own folder's files, inline code and style, and data it
 * makes itself. No address on the network is reached, by a request, a socket, a form or a
 * frame; a page that tries is refused by the browser.
 */
export const LOCAL_PAGE_POLICY = [
  "default-src 'self' data: blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline' data:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' data: blob:",
  "connect-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/** The kind of page a workspace file opens as in the browser, if it opens there. */
export function localPageKind(path: string): 'page' | 'pdf' | undefined {
  const extension = path.split('.').pop()?.toLowerCase();
  return extension === 'html' || extension === 'htm'
    ? 'page'
    : extension === 'pdf'
      ? 'pdf'
      : undefined;
}

/**
 * The workspace pages one conversation's browser may show. A page of a workspace is served
 * under a token that stands for that workspace's folder, and only to this conversation's
 * session; a PDF opens as its own file, which Chromium's viewer shows, and only the PDFs
 * opened here are let through. Nothing else of the disk is reached.
 */
export class LocalPages {
  private roots = new Map<string, string>();
  private tokens = new Map<string, string>();
  private pdfs = new Set<string>();

  /** The address a workspace file opens at, after checking it is a page there. */
  async address(workspace: string, path: string): Promise<string> {
    const kind = localPageKind(path);
    if (!kind) throw Error('only pages and PDFs open in the browser');
    const full = await workspaceFileToReveal(workspace, path);
    const root = await realpath(workspace);
    if (kind === 'pdf') {
      const url = pathToFileURL(full).href;
      this.pdfs.add(url);
      return url;
    }
    let token = this.tokens.get(root);
    if (!token) {
      token = randomBytes(16).toString('hex');
      this.tokens.set(root, token);
      this.roots.set(token, root);
    }
    const inside = relative(root, full).split(/[\\/]/).map(encodeURIComponent);
    return `${LOCAL_SCHEME}://${token}/${inside.join('/')}`;
  }

  /** Whether an address is one of this conversation's local pages. */
  allows(url: string): boolean {
    if (this.pdfs.has(url)) return true;
    try {
      const parsed = new URL(url);
      return (
        parsed.protocol === LOCAL_SCHEME + ':' && this.roots.has(parsed.host)
      );
    } catch {
      return false;
    }
  }

  /** A file of a served workspace, for a page of it. */
  async respond(
    url: string,
    maxBytes = LOCAL_PAGE_MAX_BYTES,
  ): Promise<Response> {
    const refused = (status: number, text: string) =>
      new Response(text, {
        status,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          'content-security-policy': LOCAL_PAGE_POLICY,
        },
      });
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return refused(400, 'bad address');
    }
    const root = this.roots.get(parsed.host);
    if (!root) return refused(404, 'not found');
    let path: string;
    try {
      path = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    } catch {
      return refused(400, 'bad address');
    }
    if (
      !path ||
      path.includes('\0') ||
      path.split(/[\\/]/).includes('..') ||
      isAbsolute(path)
    )
      return refused(404, 'not found');
    let full: string;
    try {
      full = await realpath(resolve(root, path));
    } catch {
      return refused(404, 'not found');
    }
    const inside = relative(root, full);
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      return refused(404, 'not found');
    const handle = await open(
      full,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    ).catch(() => undefined);
    if (!handle) return refused(404, 'not found');
    try {
      const info = await handle.stat();
      if (!info.isFile()) return refused(404, 'not found');
      if (info.size > maxBytes) return refused(413, 'too large');
      const body = await handle.readFile();
      return new Response(body, {
        headers: {
          'content-type':
            TYPES[full.split('.').pop()!.toLowerCase()] ??
            'application/octet-stream',
          'content-security-policy': LOCAL_PAGE_POLICY,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } finally {
      await handle.close();
    }
  }
}

/**
 * Where a page may take its tab. A local page goes only to another of the conversation's
 * local pages: a link or a script never takes a page of the workspace onto the network. A
 * site never goes to a local page; only the person opens one, and that load is Circle's,
 * not the page's. Otherwise the browser's own rule decides.
 */
export function localNavigation(
  current: string,
  next: string,
  pages: Pick<LocalPages, 'allows'>,
): 'allow' | 'deny' | 'browser' {
  if (pages.allows(current)) return pages.allows(next) ? 'allow' : 'deny';
  if (pages.allows(next)) return 'deny';
  return 'browser';
}

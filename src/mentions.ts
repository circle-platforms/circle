import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MediaAttachment } from './types.js';
import {
  MAX_ATTACHMENTS,
  fitMedia,
  mediaType,
  readMedia,
  validateAttachments,
} from './media.js';
import { expandUser } from './paths.js';
const SKIP = new Set(
  '.git node_modules .venv venv __pycache__ .mypy_cache .pytest_cache .tox dist build .next .cache'.split(
    ' ',
  ),
);
/**
 * The paths a message mentions: `@path`, `@"a path with spaces"`, or `@a\ path` with its
 * spaces escaped as a dropped file is pasted. Punctuation after a bare path is not part of it.
 * No-break spaces belong to the path (macOS names screenshots `… 10.15.32\u202fAM.png`), and
 * so does `@` (`icon@2x.png`).
 */
export function mentions(text: string): string[] {
  return Array.from(
    text.matchAll(/(?<!\S)@(?:"([^"\n]+)"|((?:\\ |[\u00a0\u202f]|\S)+))/g),
    (match) =>
      match[1] ??
      match[2]!.replace(/[.,;:!?)\u00a0\u202f]+$/, '').replace(/\\ /g, ' '),
  );
}
/** `@path` for a path, quoted when it has a space in it. */
export function mention(path: string): string {
  return /[\s"]/.test(path) && !path.includes('"')
    ? `@"${path}"`
    : '@' + path.replace(/ /g, '\\ ');
}
export function attachFiles(
  text: string,
  root: string,
  allowed: (path: string) => boolean = () => true,
): string {
  root = realpathSync(root);
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const raw of mentions(text)) {
    const path = resolve(root, expandUser(raw));
    try {
      const full = realpathSync(path);
      const rel = relative(root, full);
      if (
        rel === '..' ||
        rel.startsWith('..' + sep) ||
        // another drive on Windows
        isAbsolute(rel) ||
        seen.has(full) ||
        !allowed(full) ||
        !statSync(full).isFile() ||
        statSync(full).size > 65536
      )
        continue;
      const data = readFileSync(full);
      const body = new TextDecoder('utf-8', { fatal: true }).decode(data);
      seen.add(full);
      blocks.push(
        `<file path="${rel.split(sep).join('/')}">\n${body.trimEnd()}\n</file>`,
      );
    } catch {
      /* Missing, outside, binary, or oversized attachments are omitted. */
    }
  }
  return blocks.length ? text + '\n\n' + blocks.join('\n\n') : text;
}
/**
 * A prompt as the model gets it: the text files it mentions in the workspace added after it,
 * and the images and PDFs it mentions, in the workspace or anywhere else (`@~/Desktop/a.png`),
 * as attachments. With `images` false (a model that does not read them) images are left out
 * and counted in `leftOut`; their `@path` stays in the text. A file that cannot go (too large,
 * empty, one too many) is left out and named in `problems`, so the message itself still goes.
 * A PNG scaled down to send is named with both sizes, as `read_file` names one. `given` are
 * files sent with the prompt rather than named in it (the desktop's), taken the same way.
 */
export async function attachPrompt(
  text: string,
  root: string,
  signal: AbortSignal,
  allowed: (path: string) => boolean,
  images = true,
  given: MediaAttachment[] = [],
  save?: (item: MediaAttachment) => string,
): Promise<{
  message: { content: string; attachments?: MediaAttachment[] };
  leftOut: number;
  problems: string[];
}> {
  root = realpathSync(root);
  const attachments: MediaAttachment[] = [];
  const problems: string[] = [];
  const scaled: string[] = [];
  const savedImages: string[] = [];
  const seen = new Set<string>();
  let leftOut = 0;
  for (const raw of mentions(text)) {
    let full: string;
    try {
      full = realpathSync(resolve(root, expandUser(raw)));
      if (
        seen.has(full) ||
        !allowed(full) ||
        !mediaType(full) ||
        !statSync(full).isFile()
      )
        continue;
    } catch {
      continue;
    }
    seen.add(full);
    if (!images && mediaType(full) !== 'application/pdf') leftOut++;
    else if (attachments.length >= MAX_ATTACHMENTS)
      problems.push(
        `${basename(full)} (only ${MAX_ATTACHMENTS} images or PDFs go with one message)`,
      );
    else
      try {
        const media = await readMedia(full, signal);
        attachments.push(media.attachment);
        if (media.scaled) scaled.push(`${basename(full)} ${media.size}`);
      } catch (error) {
        signal.throwIfAborted();
        problems.push(
          `${basename(full)} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
  }
  for (const item of given) {
    if (!images && item.kind === 'image') {
      leftOut++;
      // A file sent with the prompt has no path of its own: write one so the model can
      // still be told where it is. One that cannot be written stays only counted.
      if (save)
        try {
          savedImages.push(save(item));
        } catch {
          /* The notice below still says the picture was left out. */
        }
    } else if (attachments.length >= MAX_ATTACHMENTS)
      problems.push(
        `${item.filename} (only ${MAX_ATTACHMENTS} images or PDFs go with one message)`,
      );
    else
      try {
        const media = fitMedia(
          Buffer.from(item.data, 'base64'),
          item.mime_type,
          item.filename,
        );
        attachments.push(media.attachment);
        if (media.scaled) scaled.push(`${item.filename} ${media.size}`);
      } catch (error) {
        problems.push(
          `${item.filename} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
  }
  signal.throwIfAborted();
  validateAttachments(attachments);
  const content = attachFiles(
    text,
    root,
    (path) => allowed(path) && !mediaType(path),
  );
  const notes = [
    ...(scaled.length ? [`[Scaled down to send: ${scaled.join('; ')}]`] : []),
    ...(savedImages.length
      ? [
          `[Images this model does not read, saved as files: ${savedImages.join('; ')}]`,
        ]
      : []),
  ];
  return {
    message: {
      content: notes.length ? `${content}\n\n${notes.join('\n')}` : content,
      ...(attachments.length ? { attachments } : {}),
    },
    leftOut,
    problems,
  };
}
/**
 * The image and PDF files a paste names, when it names nothing else: what a terminal pastes
 * for files dragged onto it (absolute paths, quoted or with `\ ` before spaces, or
 * `file://` addresses). Undefined for any other text.
 */
export function pastedFiles(
  text: string,
  platform: NodeJS.Platform = process.platform,
): string[] | undefined {
  const words: string[] = [];
  let word: string | undefined;
  let quote = '';
  const chars = Array.from(text.trim());
  for (let at = 0; at < chars.length; at++) {
    const char = chars[at]!;
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || (char === "'" && platform !== 'win32')) {
      quote = char;
      word ??= '';
    } else if (char === '\\' && platform !== 'win32' && at + 1 < chars.length)
      word = (word ?? '') + chars[++at];
    else if (/[ \t\r\n]/.test(char)) {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? '') + char;
  }
  if (quote) return undefined;
  if (word !== undefined) words.push(word);
  if (!words.length || words.length > 16) return undefined;
  const paths: string[] = [];
  for (const raw of words) {
    let path = raw;
    if (/^file:\/\//i.test(path))
      try {
        path = fileURLToPath(path);
      } catch {
        return undefined;
      }
    path = expandUser(path);
    try {
      if (!isAbsolute(path) || !mediaType(path) || !statSync(path).isFile())
        return undefined;
    } catch {
      return undefined;
    }
    paths.push(path);
  }
  return paths;
}
export function complete(partial: string, root: string, limit = 20): string[] {
  const slash = partial.lastIndexOf('/');
  const folderPart = partial.slice(0, slash + 1);
  const prefix = partial.slice(slash + 1);
  const folder = resolve(root, folderPart || '.');
  const relFolder = relative(root, folder);
  if (relFolder === '..' || relFolder.startsWith('..' + sep)) return [];
  const found: string[] = [];
  try {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    ))
      if (
        !SKIP.has(entry.name) &&
        (!entry.name.startsWith('.') || prefix.startsWith('.')) &&
        entry.name.startsWith(prefix)
      )
        found.push(
          relative(root, join(folder, entry.name)).split(sep).join('/') +
            (entry.isDirectory() ? '/' : ''),
        );
  } catch {
    /* Search by basename below. */
  }
  if (found.length || partial.includes('/') || !partial)
    return found.slice(0, limit);
  let count = 0;
  const walk = (directory: string): void => {
    if (!existsSync(directory) || count >= 5000) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !SKIP.has(entry.name)
      )
        walk(join(directory, entry.name));
      else if (
        entry.isFile() &&
        ++count <= 5000 &&
        entry.name.toLowerCase().includes(partial.toLowerCase())
      )
        found.push(relative(root, join(directory, entry.name)));
    }
  };
  walk(root);
  return found
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
}

import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { MediaAttachment, Message } from './types.js';
import { isRecord } from './settings.js';
import { fitPng, MAX_EDGE, MAX_PIXELS } from './image_fit.js';

export const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
/** Images and PDFs one message can carry. */
export const MAX_ATTACHMENTS = 16;
const MIME: Record<string, MediaAttachment['mime_type']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
export function mediaType(
  path: string,
): MediaAttachment['mime_type'] | undefined {
  return MIME[extname(path).toLowerCase()];
}
// Messages as a summary request carries them: attachments without their bytes, and without
// the provider's own blocks or the record an imported message was read from, which can hold
// the same images again.
export function summaryMessages(messages: Message[]): unknown[] {
  return messages.map(
    ({
      attachments,
      provider_content: _provider,
      legacy_data: _legacy,
      ...message
    }) => ({
      ...message,
      ...(attachments?.length
        ? {
            attachments: attachments.map(
              ({ data: _data, ...receipt }) => receipt,
            ),
          }
        : {}),
    }),
  );
}
export function makeAttachment(
  bytes: Buffer,
  mime: MediaAttachment['mime_type'],
  filename: string,
): MediaAttachment {
  if (!Object.values(MIME).includes(mime))
    throw new Error('unsupported attachment MIME type');
  if (!bytes.length || bytes.length > MAX_MEDIA_BYTES)
    throw new Error('attachment must contain 1 byte to 20 MiB');
  return {
    kind: mime === 'application/pdf' ? 'document' : 'image',
    mime_type: mime,
    filename: basename(filename.replaceAll('\\', '/')),
    data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
export function validateAttachments(
  value: unknown,
): asserts value is MediaAttachment[] {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS)
    throw new Error('invalid attachments');
  for (const item of value) {
    if (
      !isRecord(item) ||
      !Object.values(MIME).includes(
        item.mime_type as MediaAttachment['mime_type'],
      ) ||
      item.kind !==
        (item.mime_type === 'application/pdf' ? 'document' : 'image') ||
      typeof item.filename !== 'string' ||
      !item.filename ||
      /[\x00-\x1f\x7f/\\]/.test(item.filename) ||
      typeof item.data !== 'string' ||
      item.data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 ||
      item.data.length % 4 !== 0 ||
      /[^A-Za-z0-9+/=]/.test(item.data)
    )
      throw new Error('invalid attachment');
    const bytes = Buffer.from(item.data, 'base64');
    if (
      !bytes.length ||
      bytes.toString('base64') !== item.data ||
      bytes.length > MAX_MEDIA_BYTES ||
      item.sha256 !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error('attachment bytes do not match their receipt');
  }
}
export function attachmentFromBase64(
  data: string,
  mime: MediaAttachment['mime_type'],
  filename: string,
): MediaAttachment {
  if (
    data.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 ||
    data.length % 4 !== 0 ||
    /[^A-Za-z0-9+/=]/.test(data)
  )
    throw new Error('invalid attachment base64');
  const item = makeAttachment(Buffer.from(data, 'base64'), mime, filename);
  if (item.data !== data) throw new Error('invalid attachment base64');
  validateAttachments([item]);
  return item;
}
const EXTENSION: Record<MediaAttachment['mime_type'], string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};
/**
 * A picture written under `dir` once, named by its bytes, so a path can stand for it when
 * the model in use cannot read it.
 */
export function saveMediaAttachment(
  dir: string,
  item: MediaAttachment,
): string {
  const folder = join(dir, 'images');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const target = join(
    folder,
    item.sha256.slice(0, 16) + EXTENSION[item.mime_type],
  );
  if (!existsSync(target))
    writeFileSync(target, Buffer.from(item.data, 'base64'), {
      mode: 0o600,
      flag: 'wx',
    });
  return target;
}
export async function readAttachment(
  path: string,
  signal: AbortSignal,
): Promise<MediaAttachment> {
  return (await readMedia(path, signal)).attachment;
}
// A PNG may be larger before it is scaled down: a 5K screenshot is
const MAX_PNG_READ = 64 * 1024 * 1024;
/**
 * An image or PDF file as an attachment. A large PNG (a screenshot) is scaled down to what
 * models read; `size` says how large the picture is (`2880×1800, sent as 1356×847`), or is
 * empty when it is not a PNG, and `scaled` whether it was made smaller.
 */
export async function readMedia(
  path: string,
  signal: AbortSignal,
): Promise<{ attachment: MediaAttachment; size: string; scaled: boolean }> {
  const mime = mediaType(path);
  if (!mime) throw new Error('unsupported attachment file type');
  signal.throwIfAborted();
  const limit = mime === 'image/png' ? MAX_PNG_READ : MAX_MEDIA_BYTES;
  const input = createReadStream(path, { signal });
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for await (const chunk of input) {
      length += chunk.length;
      if (length > limit)
        throw new Error(
          `attachment exceeds ${limit >> 20} MiB; use a smaller file`,
        );
      chunks.push(chunk);
    }
  } finally {
    input.destroy();
  }
  signal.throwIfAborted();
  return fitMedia(Buffer.concat(chunks), mime, path);
}
/**
 * A file's bytes as an attachment: a PNG larger than models read is scaled down, one that
 * cannot be is refused. `size` and `scaled` as for `readMedia`.
 */
export function fitMedia(
  bytes: Buffer,
  mime: MediaAttachment['mime_type'],
  filename: string,
): { attachment: MediaAttachment; size: string; scaled: boolean } {
  let size = '';
  let scaled = false;
  if (mime === 'image/png') {
    const fitted = fitPng(bytes);
    // Too large to decode, or broken: sent as it is, an endpoint would refuse it, and every
    // request after it while it stays in the conversation
    if (
      !fitted.from &&
      (Math.max(fitted.width, fitted.height) > MAX_EDGE ||
        fitted.width * fitted.height > MAX_PIXELS)
    )
      throw new Error(
        `the picture is ${fitted.width}×${fitted.height} and cannot be scaled down; crop it or use a smaller one`,
      );
    bytes = fitted.bytes;
    scaled = Boolean(fitted.from);
    if (fitted.width)
      size = fitted.from
        ? `${fitted.from.width}×${fitted.from.height}, sent as ${fitted.width}×${fitted.height}`
        : `${fitted.width}×${fitted.height}`;
  }
  if (bytes.length > MAX_MEDIA_BYTES)
    throw new Error('attachment exceeds 20 MiB; use a smaller file');
  return {
    attachment: makeAttachment(bytes, mime, basename(filename)),
    size,
    scaled,
  };
}

import type { PopoutAttachment, PopoutKind } from './contracts';
import { MAX_FILE_BYTES, parseImageDataUrl } from './policy';

// What a window of its own puts into its conversation's message box, which the main window
// keeps: a page screenshot from the browser's window, a terminal selection from the
// terminal's. The main process passes on only what the drawer itself would have added.

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export function validPopoutAttachment(
  from: PopoutKind,
  value: unknown,
): PopoutAttachment {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid attachment');
  const { id, name, kind, mime, size, content } = value as Record<
    string,
    unknown
  >;
  if (typeof id !== 'string' || !ID.test(id)) throw Error('invalid attachment');
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name.length > 300 ||
    /[\u0000-\u001f\u007f]/.test(name)
  )
    throw Error('invalid attachment name');
  if (typeof content !== 'string' || typeof size !== 'number')
    throw Error('invalid attachment');
  if (from === 'browser') {
    // A picture of the page, as the browser's capture makes it
    if (kind !== 'image' || mime !== 'image/png')
      throw Error('invalid attachment');
    const image = parseImageDataUrl(content);
    if (image.mime !== 'image/png') throw Error('invalid attachment');
    if (size !== image.bytes.length) throw Error('invalid attachment size');
  } else {
    // The text of a terminal selection, with where it came from
    if (
      kind !== 'file' ||
      mime !== 'text/plain' ||
      !id.startsWith('terminal-selection:')
    )
      throw Error('invalid attachment');
    const bytes = Buffer.byteLength(content, 'utf8');
    if (!content || bytes > MAX_FILE_BYTES || size !== bytes)
      throw Error('invalid attachment size');
  }
  return { id, name, kind, mime, size, content };
}

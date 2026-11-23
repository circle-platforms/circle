import { basename } from 'node:path';

export interface Media {
  url: string;
  aeskey?: string;
}

export interface Item {
  msgtype: string;
  text?: { content?: string };
  voice?: { content?: string };
  file?: Media;
  image?: Media;
  video?: Media;
}

export interface Frame {
  body?: Item & {
    chattype: string;
    aibotid: string;
    msgid: string;
    from: { userid: string };
    mixed?: { msg_item: Item[] };
  };
}

export interface FileRef {
  name: string;
  size: number;
  sha256: string;
}

export interface Identity {
  tenant: string;
  application: string;
  secret: string;
}

export interface Channel {
  bot: string;
  secret: string;
  token: string;
  hub: string;
}

export interface DeliveryItem {
  subject: string;
  receipt: string;
  role: string;
  text: string;
  sha256: string;
  size: number;
  file?: FileRef;
}

export function safeAttachmentName(filename?: string): string {
  const cleaned = basename(filename ?? 'attachment')
    .replace(/[\p{Cc}\\]/gu, '_')
    .slice(0, 255);
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned;
}

export function privateInput(frame: Frame, bot: string) {
  const b = frame.body;
  if (
    !b ||
    b.chattype !== 'single' ||
    b.aibotid !== bot ||
    typeof b.msgid !== 'string' ||
    !b.msgid ||
    typeof b.from?.userid !== 'string' ||
    !b.from.userid
  )
    return null;
  const items = b.msgtype === 'mixed' ? (b.mixed?.msg_item ?? []) : [b];
  const text = items
    .map((i) =>
      i.msgtype === 'voice'
        ? i.voice?.content
        : i.msgtype === 'text'
          ? i.text?.content
          : '',
    )
    .filter(Boolean)
    .join('\n');
  const media = items.flatMap((i) =>
    i.msgtype === 'file' && i.file
      ? [i.file]
      : i.msgtype === 'image' && i.image
        ? [i.image]
        : i.msgtype === 'video' && i.video
          ? [i.video]
          : [],
  );
  if (
    (!text.trim() && !media.length) ||
    text.length > 16000 ||
    media.length > 8
  )
    return null;
  if (
    media.some(
      (m) => !URL.canParse(m.url) || new URL(m.url).protocol !== 'https:',
    )
  )
    return null;
  return { platformId: b.msgid, sender: b.from.userid, text, media };
}

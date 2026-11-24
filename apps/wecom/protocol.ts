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

export interface DeliveryIntent {
  sha256: string;
  size: number;
  text_sha256: string | null;
  text_size: number;
  file_sha256: string | null;
  file_size: number | null;
  name_sha256: string | null;
}

export type ReceiptOutcome =
  'issued' | 'unknown' | 'target_rejected' | 'not_dispatched';

export interface DeliveryItem {
  subject: string;
  receipt: string;
  role: string;
  code?: string;
  text: string;
  sha256: string;
  size: number;
  file?: FileRef | null;
  intent: DeliveryIntent;
}

export function safeAttachmentName(filename?: string): string {
  const cleaned = basename(filename ?? 'attachment')
    .replace(/[\p{Cc}\\]/gu, '_')
    .slice(0, 255);
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'attachment';
  return cleaned;
}

export interface PrivateInput {
  platformId: string;
  sender: string;
  text: string;
  media: Media[];
}

export type PrivateInputRejectionReason =
  'ignored' | 'text_too_long' | 'too_many_files' | 'insecure_media_url';

export type PrivateInputResult =
  | { ok: true; value: PrivateInput }
  | {
      ok: false;
      reason: PrivateInputRejectionReason;
      platformId?: string;
      sender?: string;
    };

export function inspectPrivateInput(
  frame: Frame,
  bot: string,
): PrivateInputResult {
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
    return { ok: false, reason: 'ignored' };
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
  if (!text.trim() && !media.length) {
    return { ok: false, reason: 'ignored' };
  }
  if (text.length > 16000) {
    return {
      ok: false,
      reason: 'text_too_long',
      platformId: b.msgid,
      sender: b.from.userid,
    };
  }
  if (media.length > 8) {
    return {
      ok: false,
      reason: 'too_many_files',
      platformId: b.msgid,
      sender: b.from.userid,
    };
  }
  if (
    media.some(
      (m) => !URL.canParse(m.url) || new URL(m.url).protocol !== 'https:',
    )
  ) {
    return {
      ok: false,
      reason: 'insecure_media_url',
      platformId: b.msgid,
      sender: b.from.userid,
    };
  }
  return {
    ok: true,
    value: { platformId: b.msgid, sender: b.from.userid, text, media },
  };
}

export function privateInput(frame: Frame, bot: string) {
  const inspected = inspectPrivateInput(frame, bot);
  return inspected.ok ? inspected.value : null;
}

import type { BrowserCapture } from '../../../desktop/src/contracts';
import { t } from '../i18n';
import type { Attachment, RuntimePort } from './types';

/**
 * Puts an attachment into a conversation's message box, and says whether it could also be
 * saved with the draft. Fails when there is no message box for it to go to.
 */
export type AddToDraft = (
  sessionId: string,
  attachment: Attachment,
) => Promise<boolean>;

/**
 * The window that keeps the drafts adds the attachment to the conversation's own: shown in
 * its message box at once, or when the person goes to that conversation. The same
 * attachment again, as when a failed save is tried again, is saved again rather than
 * added twice.
 */
export function addDraftAttachment(
  runtime: RuntimePort,
  sessionId: string,
  attachment: Attachment,
): boolean {
  const target = runtime
    .getSnapshot()
    .sessions.find((item) => item.id === sessionId);
  if (!target || target.lifecycle === 'deleting')
    throw Error(t('this conversation is gone'));
  return runtime.updateSessionView(sessionId, {
    attachments: target.attachments.some((item) => item.id === attachment.id)
      ? target.attachments
      : [...target.attachments, attachment],
  });
}

/** A picture of a page the person took, as the message box takes it. */
export function screenshotAttachment(capture: BrowserCapture): Attachment {
  let site = '';
  try {
    site = new URL(capture.url).hostname;
  } catch {
    site = '';
  }
  const at = new Date(capture.observedAt);
  const stamp = Number.isNaN(at.getTime())
    ? ''
    : ` ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
  const data = capture.dataUrl.split(',')[1] ?? '';
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return {
    id: crypto.randomUUID(),
    name: `${site || t('browser page')}${stamp}.png`,
    kind: 'image',
    content: capture.dataUrl,
    mime: 'image/png',
    // The picture's bytes, as its base64 decodes
    size: Math.floor(((data.length - padding) * 3) / 4),
  };
}

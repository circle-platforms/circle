import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { copyImage, saveImage } from '../host';
import { t } from '../i18n';
import { useRuntime } from '../app/context';
import type { Attachment } from '../model/types';
import { Button, Modal } from './common';
import '../styles/image-thumb.css';

/** A picture's source: a data URL as it is, or the bare base64 a result carries. */
export function imageSource(attachment: Attachment): string {
  const content = attachment.content;
  return content.startsWith('data:')
    ? content
    : `data:${attachment.mime || 'image/png'};base64,${content}`;
}

/**
 * A picture a tool brought back (a screenshot Circle took), small in the conversation,
 * and the whole picture in a window when it is pressed, to copy or to keep.
 */
export function ImageThumb({
  attachment,
  caption,
}: {
  attachment: Attachment;
  /** What the picture is of, shown beside its name in the window. */
  caption?: string;
}) {
  const { notify } = useRuntime();
  const [open, setOpen] = useState(false);
  const source = imageSource(attachment);
  const name = attachment.name || t('screenshot');
  return (
    <>
      <button
        type="button"
        className="image-thumb"
        aria-label={t('enlarge {name}', { name })}
        title={name}
        onClick={() => setOpen(true)}
      >
        <img src={source} alt={name} />
      </button>
      <Modal open={open} onOpenChange={setOpen} title={name} wide>
        <div className="lightbox">
          {caption && <p className="lightbox-caption">{caption}</p>}
          <img src={source} alt={name} />
          <div className="lightbox-actions">
            <Button
              onClick={() =>
                void copyImage(source).then(
                  () => notify(t('image copied')),
                  () => notify(t('could not copy the image')),
                )
              }
            >
              <Copy size={13} aria-hidden /> {t('copy image')}
            </Button>
            <Button
              onClick={() =>
                void saveImage(
                  attachment.name || 'screenshot.png',
                  source,
                ).catch(() => notify(t('could not save the image')))
              }
            >
              <Download size={13} aria-hidden /> {t('save to file')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

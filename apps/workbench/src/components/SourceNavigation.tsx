import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Attachment } from '../model/types';
import { attachmentImage, sourceLocation } from '../model/source-navigation';
import { Modal, DataBlock } from './common';
import { NativeResourceBoundary } from './NativeResourceBoundary';
import { t } from '../i18n';

const Sources = createContext<{
  openFile: (path: string, line?: number, column?: number) => void;
  openAttachment: (attachment: Attachment) => void;
} | null>(null);
export function useSources() {
  return useContext(Sources);
}
export function SourceNavigation({
  children,
  onFile,
}: {
  children: ReactNode;
  onFile: (path: string, line?: number, column?: number) => void;
}) {
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const image =
    attachment?.kind === 'image'
      ? attachmentImage(attachment.content, attachment.mime)
      : null;
  return (
    <Sources.Provider
      value={{ openFile: onFile, openAttachment: setAttachment }}
    >
      {children}
      <Modal
        open={!!attachment}
        onOpenChange={(open) => {
          if (!open) setAttachment(null);
        }}
        title={attachment?.name ?? t('attachment')}
      >
        <NativeResourceBoundary
          name={t('attachment')}
          resetKey={attachment?.id}
        >
          {attachment && (
            <div className="source-preview">
              {image ? (
                <a href={image} target="_blank" rel="noreferrer">
                  <img src={image} alt={attachment.name} />
                </a>
              ) : attachment.kind === 'image' ? (
                <p role="status">{t('image data unavailable')}</p>
              ) : (
                <DataBlock title={attachment.name} value={attachment.content} />
              )}
              {attachment.truncated && (
                <p role="status">{t('attachment preview is truncated')}</p>
              )}
            </div>
          )}
        </NativeResourceBoundary>
      </Modal>
    </Sources.Provider>
  );
}
export { sourceLocation };

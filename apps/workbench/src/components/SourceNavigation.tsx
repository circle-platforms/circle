import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useStableCallback } from '../app/stable-callback';
import type { Attachment } from '../model/types';
import { attachmentImage, sourceLocation } from '../model/source-navigation';
import { Modal, DataBlock } from './common';
import {
  TerminalSelectionPreview,
  terminalSelectionDisplay,
} from './TerminalSelectionPreview';
import { NativeResourceBoundary } from './NativeResourceBoundary';
import { t } from '../i18n';

const Sources = createContext<{
  openFile: (path: string, line?: number, column?: number) => void;
  /** Opens the changes mode at a file the session changed; absent where there is none. */
  openChange?: (path: string) => void;
  openAttachment: (attachment: Attachment) => void;
} | null>(null);
export function useSources() {
  return useContext(Sources);
}
export function SourceNavigation({
  children,
  onFile,
  onChange,
}: {
  children: ReactNode;
  onFile: (path: string, line?: number, column?: number) => void;
  onChange?: (path: string) => void;
}) {
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  // One value for the life of the window: what reads it must not render with every
  // publication because the application's own render made a new `onFile`.
  const openFile = useStableCallback(onFile);
  const openChange = useStableCallback((path: string) => onChange?.(path));
  const changes = !!onChange;
  const sources = useMemo(
    () => ({
      openFile,
      openChange: changes ? openChange : undefined,
      openAttachment: setAttachment,
    }),
    [openFile, openChange, changes],
  );
  const image =
    attachment?.kind === 'image'
      ? attachmentImage(attachment.content, attachment.mime)
      : null;
  return (
    <Sources.Provider value={sources}>
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
              ) : terminalSelectionDisplay(attachment) ? (
                <TerminalSelectionPreview file={attachment} />
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

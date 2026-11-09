import { Image as ImageIcon, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { IconButton } from '../components/common';
import { t } from '../i18n';
import { formatBytes } from '../model/format';
import { currentSession } from '../model/state';
import { workspaceCall } from '../model/workspace-client';
import { ModeButtons } from './mode-chrome';
import './native-editor.css';

/** The pictures a file view draws instead of editing: their names, as the desktop reads them. */
const PICTURE = /\.(png|jpe?g|gif|webp)$/i;
export function pictureFile(path: string): boolean {
  return PICTURE.test(path);
}

/**
 * A picture of the workspace where a file opens: drawn whole, never edited. The desktop
 * reads it only when its name and its first bytes agree on the picture's type.
 */
export function PictureView({
  path,
  sessionId,
  onClose,
}: {
  path: string;
  /** The conversation whose workspace has the picture, a task's own included. */
  sessionId?: string;
  onClose: () => void;
}) {
  const { snapshot } = useRuntime();
  const owner = sessionId ?? currentSession(snapshot).id;
  const key = `${owner}\n${path}`;
  const [state, setState] = useState<{
    key: string;
    source?: string;
    size?: number;
    error?: string;
  }>({ key: '' });
  const [shape, setShape] = useState<{
    key: string;
    width: number;
    height: number;
  }>();
  useEffect(() => {
    let stale = false;
    workspaceCall<{ mime: string; data: string; size: number }>(
      owner,
      'documents',
      'readImage',
      { path },
    ).then(
      (picture) =>
        !stale &&
        setState({
          key,
          source: `data:${picture.mime};base64,${picture.data}`,
          size: picture.size,
        }),
      (error: unknown) =>
        !stale &&
        setState({
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      stale = true;
    };
  }, [key]);
  const shown = state.key === key ? state : { key };
  const name = path.split('/').pop() ?? path;
  const folder = path.split('/').slice(0, -1).join('/');
  return (
    <section className="file-view picture-view">
      <header className="file-view-heading">
        <div className="file-view-title">
          <div className="file-view-filename">
            <ImageIcon size={15} aria-hidden />
            <strong title={path}>{name}</strong>
          </div>
          <div className="file-source-summary">
            {folder && (
              <span className="file-source-folder" title={folder}>
                {folder}
              </span>
            )}
            {shown.size !== undefined && (
              <span className="file-source-folder">
                {shape?.key === key
                  ? `${shape.width} × ${shape.height} · ${formatBytes(shown.size)}`
                  : formatBytes(shown.size)}
              </span>
            )}
          </div>
        </div>
        <span className="mode-toolbar-end">
          <ModeButtons />
          <IconButton label={t('close file')} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </span>
      </header>
      {shown.source ? (
        <div
          className="picture-view-body"
          role="region"
          aria-label={name}
          tabIndex={0}
        >
          <img
            src={shown.source}
            alt={name}
            onLoad={(event) =>
              setShape({
                key,
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
        </div>
      ) : (
        <div className="empty-state" role={shown.error ? 'alert' : 'status'}>
          {shown.error ? (
            <>
              <p>{t('{file} could not be opened', { file: name })}</p>
              <p className="panel-note">{shown.error}</p>
            </>
          ) : (
            t('opening file…')
          )}
        </div>
      )}
    </section>
  );
}

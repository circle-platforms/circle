import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../app/context';
import { sessionMode } from '../model/state';
import { Button } from '../components/common';
import { t } from '../i18n';
import type { FileRewindPreview } from '../../../../src/file_rewind';
import './safe-file-undo.css';

/** File effects have their own explicit preview and confirmation, separate from chat undo. */
export function SafeFileUndo({
  sessionId,
  turnId,
  disabled,
}: {
  sessionId: string;
  turnId: string;
  disabled: boolean;
}) {
  const { runtime, snapshot } = useRuntime();
  const session = snapshot.sessions.find((row) => row.id === sessionId);
  const unavailable =
    disabled ||
    !session ||
    !!session.archivedAt ||
    session.lifecycle === 'deleting' ||
    !!session.occupied;
  const readOnly = !!session && sessionMode(session) === 'plan';
  const [preview, setPreview] = useState<FileRewindPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);
  const inFlight = useRef<number | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setPreview(null);
    setRestored(false);
    inFlight.current = null;
    setError('');
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [sessionId, turnId]);
  async function run(restore = false) {
    if (
      inFlight.current !== null ||
      unavailable ||
      (restore && (readOnly || !preview || preview.conflicts.length > 0))
    )
      return;
    const epoch = generation.current;
    inFlight.current = epoch;
    setBusy(true);
    setRestored(false);
    setError('');
    try {
      if (restore && preview) {
        const receipt = await runtime.request(
          'restore-turn-files',
          { previewId: preview.id },
          sessionId,
        );
        const receiptPaths =
          receipt && typeof receipt === 'object' && 'paths' in receipt
            ? receipt.paths
            : undefined;
        if (
          !receipt ||
          typeof receipt !== 'object' ||
          !('restored' in receipt) ||
          receipt.restored !== true ||
          !('turnId' in receipt) ||
          receipt.turnId !== turnId ||
          !Array.isArray(receiptPaths) ||
          receiptPaths.length !== preview.paths.length ||
          !preview.paths.every((path) => receiptPaths.includes(path))
        )
          throw Error(t('file restore was not confirmed'));
        if (epoch === generation.current) {
          setPreview(null);
          setRestored(true);
        }
      } else {
        const result = await runtime.request(
          'preview-file-undo',
          { turnId },
          sessionId,
        );
        const previewPaths =
          result && typeof result === 'object' && 'paths' in result
            ? result.paths
            : undefined;
        if (
          !result ||
          typeof result !== 'object' ||
          !('id' in result) ||
          typeof result.id !== 'string' ||
          !result.id ||
          !('turnId' in result) ||
          result.turnId !== turnId ||
          !Array.isArray(previewPaths) ||
          !previewPaths.length ||
          !previewPaths.every((path) => typeof path === 'string' && !!path) ||
          !('conflicts' in result) ||
          !Array.isArray(result.conflicts) ||
          !result.conflicts.every(
            (path) => typeof path === 'string' && previewPaths.includes(path),
          )
        )
          throw Error(t('file undo preview is unavailable'));
        if (epoch === generation.current)
          setPreview(result as FileRewindPreview);
      }
    } catch (err) {
      if (epoch === generation.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (epoch === generation.current) {
        inFlight.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <div className="safe-file-undo" aria-busy={busy}>
      <Button disabled={unavailable || busy} onClick={() => void run()}>
        {t('undo file changes')}
      </Button>
      {preview && (
        <section aria-label={t('file undo preview')}>
          <p>
            {t(
              'only recorded text-tool file changes will be restored. shell commands and external effects remain.',
            )}
          </p>
          <ul>
            {preview.paths.map((path) => (
              <li key={path}>
                {path}
                {preview.conflicts.includes(path) && (
                  <strong> · {t('file changed externally')}</strong>
                )}
              </li>
            ))}
          </ul>
          {preview.conflicts.length > 0 && (
            <p role="status">
              {t('resolve external changes before undoing files')}
            </p>
          )}
          {readOnly && <p role="status">{t('read-only')}</p>}
          <Button
            disabled={
              unavailable || readOnly || busy || preview.conflicts.length > 0
            }
            onClick={() => void run(true)}
          >
            {t('restore these files')}
          </Button>
          <Button disabled={busy} onClick={() => setPreview(null)}>
            {t('cancel')}
          </Button>
        </section>
      )}
      {restored && <p role="status">{t('file changes restored')}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

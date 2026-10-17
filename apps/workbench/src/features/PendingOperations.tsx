import { useEffect, useRef, useState } from 'react';
import type { WorkspaceService } from '../../../desktop/src/workspace-protocol';
import { workspaceCall } from '../model/workspace-client';
import { Button } from '../components/common';
import { operationLabel } from '../model/operation-label';
import { dateLocale, t } from '../i18n';
import './task-panel.css';

/** Safe metadata only: request parameters and fingerprints never enter this view. */
interface PendingOperation {
  cursor: number;
  id: string;
  sessionId: string;
  service: string;
  method: string;
  state: string;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
}
export function PendingOperations({
  sessionId,
  refreshKey = 0,
}: {
  sessionId: string;
  /** Changes when the panel's refresh is pressed. */
  refreshKey?: number;
}) {
  const [rows, setRows] = useState<PendingOperation[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const generation = useRef(0);
  async function refresh(epoch = generation.current, before?: number) {
    try {
      const result = await workspaceCall<PendingOperation[]>(
        sessionId,
        'operations' as WorkspaceService,
        'list',
        { state: 'needs_review', limit: 100, ...(before ? { before } : {}) },
      );
      if (epoch !== generation.current) return;
      setRows((current) => (before ? [...current, ...result] : result));
      setHasMore(result.length === 100);
      setError('');
    } catch (err) {
      if (epoch === generation.current) setError(String(err));
    }
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setRows([]);
    setNotes({});
    setError('');
    setBusy(false);
    void refresh(epoch);
    return () => {
      generation.current++;
    };
  }, [sessionId]);
  useEffect(() => {
    if (refreshKey) void refresh();
  }, [refreshKey]);
  async function review(row: PendingOperation) {
    const note = notes[row.id]?.trim();
    if (!note || busy) return;
    const epoch = generation.current;
    setBusy(true);
    setError('');
    try {
      await workspaceCall(
        sessionId,
        'operations' as WorkspaceService,
        'review',
        { id: row.id, note },
      );
      if (epoch === generation.current) await refresh(epoch);
    } catch (err) {
      if (epoch === generation.current) setError(String(err));
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  // Nothing to check: the panel shows no empty section for it.
  if (!rows.length && !error) return null;
  const diagnostic = (row: PendingOperation) =>
    void navigator.clipboard
      .writeText(
        JSON.stringify(
          {
            id: row.id,
            sessionId: row.sessionId,
            service: row.service,
            method: row.method,
            state: row.state,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            errorCode: row.errorCode,
          },
          null,
          2,
        ),
      )
      .catch((err) => setError(String(err)));
  return (
    <section
      className="task-operations panel-section"
      aria-label={t('needs your review')}
    >
      <header className="task-section-heading">
        <strong>
          {t('needs your review')}
          {rows.length > 0 && <span className="count">{rows.length}</span>}
        </strong>
      </header>
      {rows.length > 0 && (
        <p className="panel-note">
          {t(
            'these actions stopped before their result was confirmed. check what actually happened, then note it here; nothing runs again.',
          )}
        </p>
      )}
      {error && (
        <p role="alert">
          {t('could not load actions to review')}: {error}
        </p>
      )}
      {rows.map((row) => (
        <article key={row.id} className="task-operation">
          <strong>{operationLabel(row.service, row.method)}</strong>
          <p>{new Date(row.createdAt).toLocaleString(dateLocale())}</p>
          <label className="task-field">
            {t('what you found')}
            <textarea
              value={notes[row.id] ?? ''}
              onChange={(event) =>
                setNotes((current) => ({
                  ...current,
                  [row.id]: event.target.value,
                }))
              }
            />
          </label>
          <div className="tasks-actions">
            <Button
              disabled={busy || !notes[row.id]?.trim()}
              onClick={() => void review(row)}
            >
              {t('mark as checked')}
            </Button>
            <Button onClick={() => diagnostic(row)}>
              {t('copy diagnostic')}
            </Button>
          </div>
        </article>
      ))}
      {hasMore && (
        <Button
          disabled={busy}
          onClick={() => void refresh(generation.current, rows.at(-1)?.cursor)}
        >
          {t('show more')}
        </Button>
      )}
    </section>
  );
}

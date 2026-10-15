import { useEffect, useRef, useState } from 'react';
import type { WorkspaceService } from '../../../desktop/src/workspace-protocol';
import { workspaceCall } from '../model/workspace-client';
import { Button } from '../components/common';
import { operationLabel } from '../model/operation-label';
import { t } from '../i18n';

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
export function PendingOperations({ sessionId }: { sessionId: string }) {
  const [rows, setRows] = useState<PendingOperation[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
      setLoaded(true);
      setError('');
    } catch (err) {
      if (epoch === generation.current) setError(String(err));
    }
  }
  useEffect(() => {
    const epoch = ++generation.current;
    setRows([]);
    setNotes({});
    setLoaded(false);
    setError('');
    setBusy(false);
    void refresh(epoch);
    return () => {
      generation.current++;
    };
  }, [sessionId]);
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
  return (
    <section aria-label={t('operations to reconcile')}>
      <header>
        <strong>{t('operations to reconcile')}</strong>
        <Button disabled={busy} onClick={() => void refresh()}>
          {t('refresh')}
        </Button>
      </header>
      <p>
        {t(
          'inspect files, git and terminal effects before recording your review; this never repeats the operation',
        )}
      </p>
      {error && (
        <p role="alert">
          {t('operation review unavailable')}: {error}
        </p>
      )}
      {loaded && !rows.length && <p>{t('no operations awaiting review')}</p>}
      {rows.map((row) => (
        <article key={row.id}>
          <strong>{operationLabel(row.service, row.method)}</strong>
          <p>{new Date(row.createdAt).toLocaleString()}</p>
          <details>
            <summary>{t('operation details')}</summary>
            <dl>
              <dt>{t('technical operation')}</dt>
              <dd>
                {row.service} · {row.method}
              </dd>
              <dt>{t('session')}</dt>
              <dd>{row.sessionId}</dd>
              <dt>{t('operation')}</dt>
              <dd>{row.id}</dd>
              <dt>{t('state')}</dt>
              <dd>{t('needs review')}</dd>
            </dl>
            <Button
              onClick={() =>
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
                  .catch((err) => setError(String(err)))
              }
            >
              {t('copy diagnostic')}
            </Button>
          </details>
          <label>
            {t('observed effects and review evidence')}
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
          <Button
            disabled={busy || !notes[row.id]?.trim()}
            onClick={() => void review(row)}
          >
            {t('record review without replay')}
          </Button>
        </article>
      ))}
      {hasMore && (
        <Button
          disabled={busy}
          onClick={() => void refresh(generation.current, rows.at(-1)?.cursor)}
        >
          {t('load older operations')}
        </Button>
      )}
    </section>
  );
}

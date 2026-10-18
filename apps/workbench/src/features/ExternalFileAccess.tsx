import { useEffect, useRef, useState } from 'react';
import { FileKey2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { desktopHost } from '../host';
import { t } from '../i18n';
import type { NativeExternalFileGrant } from '../../../desktop/src/contracts';
import './external-file-access.css';

function validGrant(
  value: unknown,
  sessionId: string,
): value is NativeExternalFileGrant {
  if (!value || typeof value !== 'object') return false;
  const grant = value as Partial<NativeExternalFileGrant>;
  return (
    typeof grant.id === 'string' &&
    Boolean(grant.id) &&
    grant.sessionId === sessionId &&
    typeof grant.path === 'string' &&
    Boolean(grant.path) &&
    (grant.access === 'read' || grant.access === 'readwrite')
  );
}

/** All grants and receipts belong to this conversation, never a workspace or a route. */
export function ExternalFileAccessPanel() {
  const { snapshot, runtime } = useRuntime();
  const sessionId = snapshot.activeSessionId;
  if (!sessionId)
    return (
      <p className="panel-note">{t('open a session to manage file access')}</p>
    );
  return (
    <SessionFileAccess
      key={`${runtime.presentationEpoch ?? 0}:${sessionId}`}
      sessionId={sessionId}
    />
  );
}

function SessionFileAccess({ sessionId }: { sessionId: string }) {
  const { snapshot, runtime } = useRuntime();
  const session = snapshot.sessions.find((item) => item.id === sessionId);
  const host = desktopHost();
  const live = runtime.mode === 'live' && Boolean(snapshot.runtime?.connected);
  const canGrant =
    live &&
    Boolean(host?.requestExternalFileGrant) &&
    Boolean(session) &&
    !session?.readOnly &&
    !session?.archivedAt &&
    !session?.occupied &&
    session?.lifecycle !== 'deleting';
  const [grants, setGrants] = useState<NativeExternalFileGrant[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const epoch = runtime.presentationEpoch;
  const active = useRef(true);
  const generation = useRef(0);
  const current = () =>
    active.current &&
    runtime.presentationEpoch === epoch &&
    runtime.getSnapshot().activeSessionId === sessionId;
  const problem = (value: unknown) =>
    value instanceof Error ? value.message : t('action failed');
  const readGrants = async () => {
    const result = await runtime.request(
      'list-external-file-grants',
      {},
      sessionId,
    );
    if (
      !Array.isArray(result) ||
      !result.every((item) => validGrant(item, sessionId))
    )
      throw Error(t('file access receipt does not match this session'));
    return result as NativeExternalFileGrant[];
  };
  const refresh = async () => {
    const request = ++generation.current;
    setError('');
    setLoaded(false);
    setBusy(true);
    try {
      const result = await readGrants();
      if (!current() || request !== generation.current) return;
      setGrants(result);
      setLoaded(true);
    } catch (value) {
      if (current() && request === generation.current) setError(problem(value));
    } finally {
      if (current() && request === generation.current) setBusy(false);
    }
  };
  useEffect(() => {
    active.current = true;
    if (live) void refresh();
    else {
      setLoaded(false);
      setGrants([]);
      setBusy(false);
    }
    return () => {
      active.current = false;
      generation.current++;
    };
  }, [
    live,
    runtime,
    sessionId,
    session?.archivedAt,
    session?.lifecycle,
    session?.occupied,
    session?.readOnly,
  ]);
  const grant = async (access: 'read' | 'readwrite') => {
    if (busy || !canGrant || !host?.requestExternalFileGrant) return;
    const request = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // Only the native OS picker supplies a path. The renderer names scope/access.
      const receipt = await host.requestExternalFileGrant(sessionId, access);
      if (!current() || request !== generation.current) {
        // A picker opened for an older conversation must not leave a late capability.
        if (receipt && validGrant(receipt, sessionId))
          await runtime.request(
            'revoke-external-file-grant',
            { id: receipt.id },
            sessionId,
          );
        return;
      }
      if (!receipt) {
        setNotice(t('file selection cancelled'));
        return;
      }
      if (!validGrant(receipt, sessionId) || receipt.access !== access)
        throw Error(t('file access receipt does not match this session'));
      setLoaded(false);
      const result = await readGrants();
      if (!current() || request !== generation.current) return;
      if (
        !result.some(
          (item) =>
            item.id === receipt.id &&
            item.path === receipt.path &&
            item.access === receipt.access,
        )
      )
        throw Error(t('file access could not be confirmed'));
      setGrants(result);
      setLoaded(true);
      setNotice(t('file access granted'));
    } catch (value) {
      if (current() && request === generation.current) setError(problem(value));
    } finally {
      if (current() && request === generation.current) setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    if (busy || !live) return;
    setLoaded(false);
    const request = ++generation.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const receipt = await runtime.request(
        'revoke-external-file-grant',
        { id },
        sessionId,
      );
      if (
        !receipt ||
        typeof receipt !== 'object' ||
        (receipt as { revoked?: unknown }).revoked !== true
      )
        throw Error(t('file access could not be revoked'));
      const result = await readGrants();
      if (!current() || request !== generation.current) return;
      if (result.some((item) => item.id === id))
        throw Error(t('file access could not be revoked'));
      setGrants(result);
      setLoaded(true);
      setNotice(t('file access revoked'));
    } catch (value) {
      if (current() && request === generation.current) setError(problem(value));
    } finally {
      if (current() && request === generation.current) setBusy(false);
    }
  };
  return (
    <section
      className="external-file-access"
      data-session-id={sessionId}
      aria-busy={busy}
    >
      <div className="external-file-scope">
        <ShieldCheck size={16} />
        <span>
          {t('current session only')}
          <strong>{session?.title || sessionId}</strong>
        </span>
      </div>
      <p className="panel-note">
        {t(
          'Choose one exact file outside the workspace. Access expires when the app closes or the session is deleted or archived. Forks do not inherit it.',
        )}
      </p>
      <div className="external-file-actions">
        <Button disabled={!canGrant || busy} onClick={() => void grant('read')}>
          <FileKey2 size={14} />
          {t('choose read-only file')}
        </Button>
        <Button
          disabled={!canGrant || busy}
          onClick={() => void grant('readwrite')}
        >
          {t('choose read and write file')}
        </Button>
        <Button
          disabled={!live || busy}
          onClick={() => {
            setNotice('');
            void refresh();
          }}
        >
          <RefreshCw size={14} />
          {t('refresh')}
        </Button>
      </div>
      {!live ? (
        <p className="panel-note">
          {t('file access requires the connected desktop runtime')}
        </p>
      ) : !host?.requestExternalFileGrant ? (
        <p className="panel-note">
          {t('native file selection is unavailable')}
        </p>
      ) : !canGrant ? (
        <p className="panel-note">
          {t('this session cannot grant new file access')}
        </p>
      ) : null}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="external-file-notice" role="status">
          {notice}
        </p>
      )}
      {!error && live && !loaded && (
        <p className="panel-note" role="status">
          {t('loading file access…')}
        </p>
      )}
      {loaded && !grants.length && (
        <p className="panel-note">{t('no external files authorized')}</p>
      )}
      {loaded && grants.length > 0 && (
        <ul className="external-file-grants">
          {grants.map((item) => (
            <li
              key={item.id}
              className="external-file-grant"
              data-grant-id={item.id}
            >
              <div>
                <code title={item.path}>{item.path}</code>
                <small>
                  {item.access === 'read'
                    ? t('read-only')
                    : t('read and write')}{' '}
                  · {t('current session only')}
                </small>
              </div>
              <Button
                disabled={busy || !live}
                onClick={() => void revoke(item.id)}
              >
                <Trash2 size={13} />
                {t('revoke access')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

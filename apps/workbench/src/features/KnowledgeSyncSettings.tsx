import { useCallback, useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { Button, Modal } from '../components/common';
import { t } from '../i18n';
import { shownTime } from '../model/time';
import {
  knowledgeError,
  knowledgeServerBound,
  knowledgeSyncLine,
} from '../model/knowledge';
import type {
  KnowledgePreview,
  KnowledgeSyncView,
} from '../../../../src/knowledge/desktop-contract';
import './knowledge.css';
interface Settings {
  sync: KnowledgeSyncView;
  connections: { name: string }[];
}
export function KnowledgeSyncSettings() {
  const { runtime, snapshot, notify } = useRuntime();
  const [state, setState] = useState<Settings>(),
    [server, setServer] = useState(''),
    [preview, setPreview] = useState<KnowledgePreview>(),
    [checking, setChecking] = useState(false),
    [error, setError] = useState('');
  const call = useCallback(
    (p: Record<string, unknown>) =>
      runtime.mode === 'live'
        ? Promise.resolve(runtime.request('knowledge', p))
        : Promise.reject(Error('knowledge-preview-unavailable')),
    [runtime],
  );
  const load = useCallback(async () => {
    try {
      const result = (await call({ op: 'settings' })) as Settings;
      setState(result);
      setServer((prior) => prior || result.sync.server);
    } catch (e) {
      setError(knowledgeError(e));
    }
  }, [call]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);
  const run = async (action: () => Promise<unknown>) => {
    setChecking(true);
    setError('');
    try {
      return await action();
    } catch (e) {
      setError(knowledgeError(e));
    } finally {
      setChecking(false);
    }
  };
  const prepare = async (action: string, mode?: string) => {
    const result = await run(() =>
      call({ op: 'prepare', action, ...(mode ? { mode } : { server }) }),
    );
    if (result) setPreview(result as KnowledgePreview);
  };
  const cancel = () => {
    if (preview) void call({ op: 'cancel', ticket: preview.ticket });
    setPreview(undefined);
  };
  const sync = state?.sync ?? snapshot.knowledgeSync;
  const localOnly = !sync?.server || sync.mode === 'local';
  const statusVisible =
    !localOnly || sync?.clearing || sync?.condition === 'login-required';
  return (
    <section className="knowledge-sync-settings">
      <h1>{t('sync')}</h1>
      <label className="knowledge-field">
        {t('MCP connection')}
        <select
          aria-label={t('MCP connection')}
          value={server}
          onChange={(e) => setServer(e.target.value)}
        >
          <option value="">{t('select a connection')}</option>
          {state?.connections.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div className="knowledge-actions">
        <Button
          disabled={!server || checking}
          onClick={() => void prepare('connect')}
        >
          {t('use this connection…')}
        </Button>
        {sync?.server && (
          <Button
            disabled={checking}
            onClick={() =>
              void run(() => call({ op: 'disconnect' })).then(load)
            }
          >
            {t('disconnect')}
          </Button>
        )}
      </div>
      <dl className="knowledge-sync-facts">
        <div>
          <dt>{t('connection')}</dt>
          <dd>
            {sync?.server && knowledgeServerBound(sync)
              ? sync.server
              : t('sync server not connected')}
          </dd>
        </div>
        {statusVisible && (
          <div>
            <dt>{t('status')}</dt>
            <dd>
              <span className={'knowledge-state ' + sync?.condition}>
                <i />
                {knowledgeSyncLine(sync)}
              </span>
            </dd>
          </div>
        )}
        {(!localOnly || sync?.lastSyncedAt) && (
          <div>
            <dt>{t('last sync')}</dt>
            <dd>
              {sync?.lastSyncedAt
                ? shownTime(sync.lastSyncedAt)
                : t('not synced yet')}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('sync mode')}</dt>
          <dd>
            {!sync?.server
              ? t('only on this device')
              : sync.mode === null
                ? t('not checked yet')
                : sync.mode === 'local'
                  ? t('only on this device')
                  : t('sync to server')}
          </dd>
        </div>
      </dl>
      {sync?.clearing && (
        <p role="status">
          {t(
            'personal copies are being removed; local copies and team copies remain',
          )}
        </p>
      )}
      <div className="knowledge-sync-modes">
        <Button
          disabled={
            !sync?.server ||
            checking ||
            (sync.mode === 'hub' &&
              !sync.clearing &&
              sync.condition !== 'paused')
          }
          onClick={() => void prepare('mode', 'hub')}
        >
          {t('sync to server…')}
        </Button>
        <Button
          disabled={!sync?.server || checking || sync.mode === 'local'}
          onClick={() => void prepare('mode', 'local')}
        >
          {t('only on this device…')}
        </Button>
      </div>
      <div className="knowledge-actions">
        {!localOnly && (
          <Button
            disabled={!sync?.server || checking}
            onClick={() => void run(() => call({ op: 'sync' })).then(load)}
          >
            {t('sync now')}
          </Button>
        )}
        {sync?.condition === 'login-required' && (
          <Button
            disabled={!sync?.server || checking}
            onClick={() => void run(() => call({ op: 'login' })).then(load)}
          >
            {t('sign in again')}
          </Button>
        )}
      </div>
      {error && (
        <p className="knowledge-error" role="alert">
          {error}
        </p>
      )}
      <Modal
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) cancel();
        }}
        title={
          preview?.action === 'mode'
            ? preview.title === 'local'
              ? t('Keep only on this device?')
              : t('sync to server')
            : t('use this connection')
        }
        restoreFocus
        dismissOutside={false}
        className="knowledge-dialog"
      >
        {preview && (
          <>
            <div className="knowledge-dialog-body">
              {preview.impact ? (
                <>
                  <dl className="knowledge-sync-facts">
                    <div>
                      <dt>{t('personal content')}</dt>
                      <dd>
                        {t('{n} bytes', {
                          n: preview.impact.bytes.toLocaleString(),
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('folder shares that become unavailable')}</dt>
                      <dd>{preview.impact.grants.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>{t('pending team shares')}</dt>
                      <dd>
                        {preview.impact.pending === null
                          ? t('unknown')
                          : preview.impact.pending.toLocaleString()}
                      </dd>
                    </div>
                    <div>
                      <dt>{t('team copies preserved')}</dt>
                      <dd>{preview.impact.teamCopies.toLocaleString()}</dd>
                    </div>
                  </dl>
                  <p>
                    {preview.title === 'local'
                      ? t(
                          'personal copies on the sync server and folder shares are removed; local copies and independent team copies remain',
                        )
                      : t(
                          'retained local content is used for this account’s personal sync',
                        )}
                  </p>
                </>
              ) : (
                <>
                  <p>{preview.title}</p>
                  <p>
                    {t(
                      'retained local content is used for this account’s personal sync',
                    )}
                  </p>
                </>
              )}
              {error && <p role="alert">{error}</p>}
            </div>
            <footer className="knowledge-dialog-actions">
              <Button onClick={cancel}>{t('cancel')}</Button>
              <Button
                className={
                  preview.action === 'mode' && preview.title === 'local'
                    ? 'danger'
                    : 'primary'
                }
                disabled={checking}
                onClick={() =>
                  void run(() =>
                    call({
                      op: 'confirm',
                      ticket: preview.ticket,
                      confirmed: true,
                    }),
                  ).then((result) => {
                    if (result) {
                      setPreview(undefined);
                      void load();
                      notify(
                        preview.action !== 'mode'
                          ? t('connected · {name}', { name: server })
                          : preview.title === 'local'
                            ? t('kept only on this device')
                            : t('syncing to server'),
                      );
                    }
                  })
                }
              >
                {checking
                  ? t('checking…')
                  : preview.action === 'mode'
                    ? preview.title === 'local'
                      ? t('Keep only on this device')
                      : t('confirm sync to server')
                    : t('confirm connection')}
              </Button>
            </footer>
          </>
        )}
      </Modal>
    </section>
  );
}

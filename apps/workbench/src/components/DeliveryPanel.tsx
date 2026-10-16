import { deliveryPreflightText } from '../model/delivery-preflight-text';
import { useOwnerState } from '../model/owner-state';
import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../app/context';
import type { GitHubConnectionState } from '../../../../src/github_connection';
import { NavLink } from 'react-router-dom';
import { workspaceCall } from '../model/workspace-client';
import { t } from '../i18n';
import { Button, DataBlock, Status } from './common';
type PR = { url: string; number: number; isDraft: boolean };
type Check = {
  name: string;
  state: string;
  bucket: string;
  link: string;
  workflow: string;
};
export function WorkspaceServiceError({ error }: { error: string }) {
  if (!error.includes('native workspace services are not connected'))
    return <p role="alert">{deliveryPreflightText(error)}</p>;
  return (
    <div role="alert">
      <p>{t('open this workspace in Circle desktop, then refresh')}</p>
      <details>
        <summary>{t('technical details')}</summary>
        <pre tabIndex={0}>{error}</pre>
      </details>
    </div>
  );
}
export function DeliveryPanel({
  sessionId,
  revision,
  onOpenExternal,
  embedded = false,
}: {
  embedded?: boolean;
  sessionId: string;
  revision?: string;
  onOpenExternal?: (url: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [pr, setPR] = useOwnerState<PR | null>(sessionId, null);
  const [checks, setChecks] = useOwnerState<Check[]>(sessionId, []);
  const { snapshot } = useRuntime();
  const extension = snapshot.extensions.find(
    (item) => item.name === 'github' && item.scope === 'bundled',
  );
  const connection = extension?.view as GitHubConnectionState | undefined;
  const auth =
    extension?.enabled &&
    connection?.provider === 'github' &&
    connection.state === 'connected';
  const [title, setTitle] = useOwnerState(sessionId, '');
  const [body, setBody] = useOwnerState(sessionId, '');
  const [runId, setRunId] = useOwnerState(sessionId, '');
  const [logs, setLogs] = useOwnerState(sessionId, '');
  const [busy, setBusy] = useOwnerState(sessionId, false);
  const [error, setError] = useOwnerState(sessionId, '');
  const owner = useRef(sessionId);
  const generation = useRef(0);
  if (owner.current !== sessionId) {
    owner.current = sessionId;
    generation.current++;
  }
  const current = (epoch: number, session: string) =>
    generation.current === epoch && owner.current === session;
  useEffect(() => {
    setBusy(false);
  }, [sessionId]);
  async function call(method: string, extra: Record<string, unknown> = {}) {
    return workspaceCall<any>(sessionId, 'delivery', method, {
      revision,
      ...extra,
    });
  }
  async function refresh() {
    const epoch = generation.current,
      session = sessionId;
    try {
      const result = await call('status');
      if (!current(epoch, session)) return;
      const nextChecks = result.pullRequest ? await call('checks') : [];
      if (!current(epoch, session)) return;
      setPR(result.pullRequest);
      setChecks(nextChecks);
    } catch (error) {
      if (current(epoch, session)) throw error;
    }
  }
  useEffect(() => {
    if (!opened) return;
    let alive = true;
    const update = () =>
      refresh().catch((e) => {
        if (alive) setError(String(e));
      });
    void update();
    const timer = setInterval(update, 15000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sessionId, opened]);
  async function action(method: string, extra: Record<string, unknown> = {}) {
    const epoch = generation.current,
      session = sessionId;
    setBusy(true);
    setError('');
    try {
      const result = await call(method, extra);
      if (!current(epoch, session)) return;
      if (method === 'logs') setLogs(result.text);
      else await refresh();
    } catch (e) {
      if (current(epoch, session)) setError(String(e));
    } finally {
      if (current(epoch, session)) setBusy(false);
    }
  }
  function open(url: string) {
    if (/^https:\/\/github\.com\//.test(url)) onOpenExternal?.(url);
  }
  return (
    <details
      className={
        embedded
          ? 'panel-section native-delivery'
          : 'panel-section first native-delivery'
      }
      onToggle={(e) => setOpened(e.currentTarget.open)}
    >
      <summary>{t('GitHub delivery')}</summary>
      {error && <WorkspaceServiceError key={sessionId} error={error} />}
      <p>{auth ? t('GitHub connected') : t('GitHub login required')}</p>
      <NavLink to="/page/extensions?plugin=github">
        {t('manage GitHub plugin')}
      </NavLink>
      <Button
        disabled={busy}
        onClick={() => refresh().catch((e) => setError(String(e)))}
      >
        {t('connection and PR status')}
      </Button>
      {pr && (
        <p>
          <Button disabled={!onOpenExternal} onClick={() => open(pr.url)}>
            #{pr.number} {pr.isDraft ? t('draft PR') : t('ready for review')}
          </Button>
        </p>
      )}
      <label className="field-label">
        {t('PR title')}
        <input
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field-label">
        {t('PR description')}
        <textarea
          className="input"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <Button
        disabled={busy || !auth || !title.trim()}
        onClick={() => action('publish', { title, body })}
      >
        {t('publish draft PR')}
      </Button>
      <Button disabled={busy || !auth || !pr} onClick={() => action('ready')}>
        {t('request review after checks pass')}
      </Button>
      <ul className="native-delivery-checks">
        {checks.map((check, i) => (
          <li className="activity-row" key={i}>
            <span>
              {check.name}
              <small>
                {check.bucket === 'skipping' ? (
                  <span className="muted">{t('skipped')}</span>
                ) : (
                  <Status
                    value={
                      check.bucket === 'pass'
                        ? 'completed'
                        : check.bucket === 'fail'
                          ? 'failed'
                          : check.bucket === 'cancel'
                            ? 'cancelled'
                            : 'pending'
                    }
                  />
                )}{' '}
                {check.state}
              </small>
            </span>
            {check.link && (
              <Button
                disabled={!onOpenExternal}
                onClick={() => open(check.link)}
              >
                {t('open check')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <label className="field-label">
        {t('CI run id')}
        <input
          className="input"
          value={runId}
          inputMode="numeric"
          onChange={(e) => setRunId(e.target.value)}
        />
      </label>
      <Button
        disabled={busy || !/^\d+$/.test(runId)}
        onClick={() => action('logs', { runId: Number(runId) })}
      >
        {t('show failed CI logs')}
      </Button>
      <Button
        disabled={busy || !/^\d+$/.test(runId)}
        onClick={() => action('retry', { runId: Number(runId) })}
      >
        {t('retry failed CI jobs')}
      </Button>
      {logs && (
        <div tabIndex={0}>
          <DataBlock title={t('show failed CI logs')} value={logs} />
        </div>
      )}
      <p className="panel-note">{t('merging remains a human decision')}</p>
    </details>
  );
}

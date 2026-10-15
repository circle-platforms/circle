import { useEffect, useState } from 'react';
import { workspaceCall } from '../model/workspace-client';
import { t } from '../i18n';
type Login = {
  id: string;
  status: string;
  url?: string;
  code?: string;
  error?: string;
  storage?: string;
};
type PR = { url: string; number: number; isDraft: boolean };
type Check = {
  name: string;
  state: string;
  bucket: string;
  link: string;
  workflow: string;
};
export function DeliveryPanel({
  sessionId,
  revision,
  onOpenExternal,
}: {
  sessionId: string;
  revision?: string;
  onOpenExternal?: (url: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [login, setLogin] = useState<Login | null>(null);
  const [pr, setPR] = useState<PR | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [auth, setAuth] = useState<boolean | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [runId, setRunId] = useState('');
  const [logs, setLogs] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function call(method: string, extra: Record<string, unknown> = {}) {
    return workspaceCall<any>(sessionId, 'delivery', method, {
      revision,
      ...extra,
    });
  }
  async function refresh() {
    const result = await call('status');
    setAuth(result.authenticated);
    setPR(result.pullRequest);
    if (result.pullRequest) setChecks(await call('checks'));
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
  useEffect(() => {
    if (!login || !['starting', 'waiting', 'saving'].includes(login.status))
      return;
    const timer = setInterval(() => {
      call('login', { action: 'poll', id: login.id })
        .then(setLogin)
        .catch((e) => setError(String(e)));
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionId, login?.id, login?.status]);
  async function action(method: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      const result = await call(method, extra);
      if (method === 'login') setLogin(result);
      else if (method === 'logs') setLogs(result.text);
      else await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function open(url: string) {
    if (/^https:\/\/github\.com\//.test(url)) onOpenExternal?.(url);
  }
  return (
    <details onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>{t('GitHub delivery')}</summary>
      {error && <p role="alert">{error}</p>}
      <p>
        {auth === null
          ? t('checking GitHub connection')
          : auth
            ? t('GitHub connected')
            : t('GitHub login required')}
      </p>
      <button
        disabled={busy}
        onClick={() => action('login', { action: 'start' })}
      >
        {t('sign in with browser')}
      </button>
      {login && (
        <div role="status">
          <p>
            {login.status === 'waiting'
              ? t('enter this code in your browser')
              : login.status === 'complete'
                ? t('GitHub connected')
                : login.status === 'cancelled'
                  ? t('login cancelled')
                  : login.status === 'failed'
                    ? t('login failed')
                    : login.status === 'saving'
                      ? t('finishing secure login')
                      : t('starting login')}
          </p>
          {login.code && <code>{login.code}</code>}
          {login.url && (
            <>
              <p>{login.url}</p>
              <button
                disabled={!onOpenExternal}
                onClick={() => open(login.url!)}
              >
                {t('open GitHub authorization')}
              </button>
            </>
          )}
          {['starting', 'waiting'].includes(login.status) && (
            <button
              onClick={() =>
                action('login', { action: 'cancel', id: login.id })
              }
            >
              {t('cancel login')}
            </button>
          )}
          {login.error && <p role="alert">{login.error}</p>}
          {login.status === 'complete' && login.storage === 'session' && (
            <p role="status">
              {t('secure storage unavailable; signed in for this session only')}
            </p>
          )}
        </div>
      )}
      <button
        disabled={busy}
        onClick={() => refresh().catch((e) => setError(String(e)))}
      >
        {t('connection and PR status')}
      </button>
      {pr && (
        <p>
          <button disabled={!onOpenExternal} onClick={() => open(pr.url)}>
            #{pr.number} {pr.isDraft ? t('draft PR') : t('ready for review')}
          </button>
        </p>
      )}
      <label>
        {t('PR title')}
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        {t('PR description')}
        <textarea value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <button
        disabled={busy || !title.trim()}
        onClick={() => action('publish', { title, body })}
      >
        {t('publish draft PR')}
      </button>
      <button disabled={busy || !pr} onClick={() => action('ready')}>
        {t('request review after checks pass')}
      </button>
      <ul>
        {checks.map((check, i) => (
          <li key={i}>
            <span>
              {check.name} · {check.state}
            </span>
            {check.link && (
              <button
                disabled={!onOpenExternal}
                onClick={() => open(check.link)}
              >
                {t('open check')}
              </button>
            )}
          </li>
        ))}
      </ul>
      <label>
        {t('CI run id')}
        <input
          value={runId}
          inputMode="numeric"
          onChange={(e) => setRunId(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !/^\d+$/.test(runId)}
        onClick={() => action('logs', { runId: Number(runId) })}
      >
        {t('show failed CI logs')}
      </button>
      <button
        disabled={busy || !/^\d+$/.test(runId)}
        onClick={() => action('retry', { runId: Number(runId) })}
      >
        {t('retry failed CI jobs')}
      </button>
      {logs && <pre tabIndex={0}>{logs}</pre>}
      <p>{t('merging remains a human decision')}</p>
    </details>
  );
}

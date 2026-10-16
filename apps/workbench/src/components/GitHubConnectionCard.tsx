import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { GitHubConnectionState } from '../../../../src/github_connection';
import { useRuntime } from '../app/context';
import { desktopHost } from '../host';
import { t } from '../i18n';
import { Button } from './common';

export function GitHubConnectionCard() {
  const { snapshot, runtime } = useRuntime();
  const extension = snapshot.extensions.find(
    (item) => item.name === 'github' && item.scope === 'bundled',
  );
  const candidate = extension?.view as GitHubConnectionState | undefined;
  const view = candidate?.provider === 'github' ? candidate : undefined;
  const available = runtime.mode === 'live' && extension?.enabled && !!view;
  const [storage, setStorage] = useState<'encrypted' | 'session'>('encrypted');
  const [repositories, setRepositories] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function command(verb: string, params?: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const result = await runtime.command(
        'github',
        verb + (params ? ' ' + JSON.stringify(params) : ''),
      );
      if (result && 'error' in result && result.error)
        throw Error(String(result.error));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  const allowed = repositories
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const valid =
    allowed.length > 0 &&
    allowed.every((item) => /^[\w.-]+\/[\w.-]+$/.test(item));
  return (
    <section
      className="settings-block"
      id="github-connection"
      aria-labelledby="github-connection-title"
    >
      <h2 id="github-connection-title">GitHub</h2>
      {!available ? (
        <>
          <p className="panel-note">
            {t(
              'GitHub connection is unavailable; enable the bundled GitHub extension in Circle desktop.',
            )}
          </p>
          <NavLink to="/page/extensions">{t('extensions')}</NavLink>
        </>
      ) : (
        <>
          <p role="status">
            {view.state === 'connected' && view.account
              ? t('connected as {account}', { account: view.account.login })
              : view.state === 'authorizing'
                ? t('waiting for GitHub authorization')
                : t('GitHub login required')}
          </p>
          {view.repositories.length > 0 && (
            <p>
              {t('Circle allowed repositories')}: {view.repositories.join(', ')}
            </p>
          )}
          {view.storage === 'session' && (
            <p className="panel-note">
              {t('GitHub connection lasts only for this Circle session.')}
            </p>
          )}
          {view.state !== 'connected' && view.state !== 'authorizing' && (
            <>
              <label className="field-label">
                {t('Circle allowed repositories')}
                <textarea
                  className="input"
                  value={repositories}
                  placeholder="owner/repository"
                  onChange={(event) => setRepositories(event.target.value)}
                />
              </label>
              <p className="panel-note">
                {t(
                  'One owner/repository per line. This Circle allowlist does not change GitHub authorization scopes.',
                )}
              </p>
              <label className="field-label">
                {t('credential storage')}
                <select
                  value={storage}
                  onChange={(event) =>
                    setStorage(event.target.value as typeof storage)
                  }
                >
                  <option value="encrypted">{t('secure storage')}</option>
                  <option value="session">{t('this session only')}</option>
                </select>
              </label>
              <Button
                disabled={busy || !valid}
                onClick={() =>
                  command('connect', { storage, repositories: allowed })
                }
              >
                {t('sign in with browser')}
              </Button>
            </>
          )}
          {view.authorization && view.state === 'authorizing' && (
            <>
              <p>{t('enter this code in your browser')}</p>
              <div className="inline-actions">
                {view.authorization.code && (
                  <code>{view.authorization.code}</code>
                )}
                {view.authorization.url && (
                  <Button
                    disabled={!desktopHost()?.openExternal}
                    onClick={async () => {
                      try {
                        await desktopHost()?.openExternal?.(
                          view.authorization!.url!,
                        );
                      } catch (reason) {
                        setError(String(reason));
                      }
                    }}
                  >
                    {t('open GitHub authorization')}
                  </Button>
                )}
                <Button
                  disabled={busy}
                  onClick={() => command('cancel', { epoch: view.epoch })}
                >
                  {t('cancel login')}
                </Button>
              </div>
            </>
          )}
          <div className="inline-actions">
            <Button disabled={busy} onClick={() => command('status')}>
              {t('refresh')}
            </Button>
            {view.state === 'connected' && (
              <Button
                disabled={busy}
                onClick={() => command('disconnect', { epoch: view.epoch })}
              >
                {t('disconnect GitHub')}
              </Button>
            )}
          </div>
          {view.remoteRevocation === 'unconfirmed' && (
            <p className="panel-note">
              {t(
                'Disconnected from Circle. GitHub authorization revocation is not confirmed.',
              )}
            </p>
          )}
        </>
      )}
      {(error || view?.error || extension?.error) && (
        <p role="alert">{error || view?.error || extension?.error}</p>
      )}
    </section>
  );
}

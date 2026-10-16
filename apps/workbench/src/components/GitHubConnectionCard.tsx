import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { GitHubConnectionState } from '../../../../src/github_connection';
import { useRuntime } from '../app/context';
import { copyText, desktopHost } from '../host';
import { t } from '../i18n';
import { Button } from './common';

export function GitHubConnectionCard() {
  const { snapshot, runtime, perform } = useRuntime();
  const extension = snapshot.extensions.find(
    (item) => item.name === 'github' && item.scope === 'bundled',
  );
  const candidate = extension?.view as GitHubConnectionState | undefined;
  const view = candidate?.provider === 'github' ? candidate : undefined;
  const available = runtime.mode === 'live' && extension?.enabled && !!view;
  const loading =
    runtime.mode === 'live' && extension?.enabled && !extension.error && !view;
  const loadFailed =
    runtime.mode === 'live' && extension?.enabled && !!extension.error && !view;
  const [storage, setStorage] = useState<'encrypted' | 'session'>('encrypted');
  const [repositories, setRepositories] = useState('');
  const [repositoryEpoch, setRepositoryEpoch] = useState<number>();
  const [repositoryDirty, setRepositoryDirty] = useState(false);
  const pendingRepositories = useRef<string[] | undefined>(undefined);
  useEffect(() => {
    if (
      repositoryDirty &&
      pendingRepositories.current &&
      JSON.stringify(view?.repositories) ===
        JSON.stringify(pendingRepositories.current) &&
      view?.epoch !== repositoryEpoch
    ) {
      pendingRepositories.current = undefined;
      setRepositoryDirty(false);
    }
    if (!repositoryDirty) {
      setRepositories(view?.repositories.join('\n') ?? '');
      setRepositoryEpoch(view?.epoch);
    }
  }, [view?.epoch, repositoryDirty]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
  }, [view?.epoch, view?.state]);
  const failure = error || view?.error || extension?.error;
  const storageUnavailable =
    !!failure &&
    /secure (?:credential )?storage.*unavailable|encrypt.*(?:unavailable|not available)/i.test(
      failure,
    );
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
      if (verb === 'configure' || verb === 'connect')
        pendingRepositories.current = undefined;
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  }
  const allowed = repositories
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const valid = allowed.every((item) => /^[\w.-]+\/[\w.-]+$/.test(item));
  return (
    <section
      className="settings-block"
      id="github-connection"
      aria-labelledby="github-connection-title"
    >
      <h2 id="github-connection-title">GitHub</h2>
      {!available ? (
        <>
          {!loadFailed && (
            <p className="panel-note" role={loading ? 'status' : undefined}>
              {loading
                ? t('loading GitHub integration')
                : t(
                    'GitHub connection is unavailable; enable the bundled GitHub extension in Circle desktop.',
                  )}
            </p>
          )}
          {!loading && (
            <NavLink to="/page/extensions">{t('extensions')}</NavLink>
          )}
        </>
      ) : (
        <>
          <p className="panel-note">
            {t('authorization application')}: GitHub CLI
          </p>
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
          {view.state !== 'authorizing' && (
            <>
              <label className="field-label">
                {t('Circle allowed repositories (optional)')}
                <textarea
                  className="input"
                  value={repositories}
                  placeholder="owner/repository"
                  onChange={(event) => {
                    if (!repositoryDirty) setRepositoryEpoch(view.epoch);
                    setRepositoryDirty(true);
                    setRepositories(event.target.value);
                  }}
                />
              </label>
              <p className="panel-note">
                {t(
                  'One owner/repository per line. This Circle allowlist does not change GitHub authorization scopes.',
                )}
              </p>
              {view.state === 'connected' && (
                <>
                  {view.repositories.length === 0 && (
                    <p className="panel-note">
                      {t(
                        'No repositories selected; repository actions are unavailable.',
                      )}
                    </p>
                  )}
                  <Button
                    disabled={busy || !valid || !repositoryDirty}
                    onClick={() => {
                      pendingRepositories.current = allowed;
                      void command('configure', {
                        epoch: repositoryEpoch,
                        repositories: allowed,
                      });
                    }}
                  >
                    {t('save allowed repositories')}
                  </Button>
                  {repositoryDirty && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        pendingRepositories.current = undefined;
                        setRepositories(view.repositories.join('\n'));
                        setRepositoryEpoch(view.epoch);
                        setRepositoryDirty(false);
                      }}
                    >
                      {t('reset repository edits')}
                    </Button>
                  )}
                </>
              )}
            </>
          )}
          {view.state !== 'connected' && view.state !== 'authorizing' && (
            <>
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
                onClick={() => {
                  pendingRepositories.current = allowed;
                  void command('connect', { storage, repositories: allowed });
                }}
              >
                {t('start GitHub authorization')}
              </Button>
            </>
          )}
          {view.authorization && view.state === 'authorizing' && (
            <>
              <p>{t('enter this code in your browser')}</p>
              <div className="inline-actions">
                {view.authorization.code && (
                  <>
                    <code>{view.authorization.code}</code>
                    <Button
                      onClick={() =>
                        perform(() => copyText(view.authorization!.code!))
                      }
                    >
                      {t('copy authorization code')}
                    </Button>
                  </>
                )}
              </div>
              <div className="inline-actions">
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
      {failure && (
        <div role="alert">
          <p>
            {loadFailed
              ? t('GitHub integration could not be loaded.')
              : storageUnavailable
                ? t('Secure credential storage is unavailable.')
                : t('GitHub action could not be completed.')}
          </p>
          <p className="panel-note">
            {storageUnavailable
              ? t(
                  'Choose this session only if you want to continue without saving credentials, then start authorization again.',
                )
              : t(
                  'Review the connection and try the action again. Your edits are kept.',
                )}
          </p>
          <details className="context-source">
            <summary>{t('technical details')}</summary>
            <pre tabIndex={0}>{failure}</pre>
            <Button onClick={() => perform(() => copyText(failure))}>
              {t('copy error details')}
            </Button>
          </details>
        </div>
      )}
    </section>
  );
}

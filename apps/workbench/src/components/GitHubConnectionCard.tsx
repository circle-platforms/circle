import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { GitHubConnectionState } from '../../../../src/github_connection';
import { useRuntime } from '../app/context';
import { copyText, desktopHost } from '../host';
import { t } from '../i18n';
import { Button } from './common';
import { githubPermissions } from '../model/github-permissions';

export function GitHubConnectionCard({
  embedded = false,
}: {
  embedded?: boolean;
}) {
  const { snapshot, runtime, perform } = useRuntime();
  const extension = snapshot.extensions.find(
    (item) => item.name === 'github' && item.scope === 'bundled',
  );
  const candidate = extension?.view as GitHubConnectionState | undefined;
  const view = candidate?.provider === 'github' ? candidate : undefined;
  const permissions = view ? githubPermissions(view) : undefined;
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
  const expired =
    !!failure &&
    /authorization expired|HTTP 401|Bad credentials/i.test(failure);
  const denied = !!failure && /permission denied|HTTP 403/i.test(failure);
  const requestFailed =
    !!failure &&
    /GitHub request failed|network|ECONN|ENOTFOUND|fetch failed|timed? ?out/i.test(
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
      className={embedded ? 'panel-section' : 'settings-block'}
      id="github-connection"
      aria-labelledby="github-connection-title"
    >
      <h2 id="github-connection-title">
        {embedded
          ? available && view?.state === 'connected' && view.account
            ? t('connected account')
            : t('GitHub account')
          : 'GitHub'}
      </h2>
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
          <details className="context-source github-permissions">
            <summary>{t('authorization permissions')}</summary>
            <p>
              {t('additional requested permissions')}:{' '}
              {permissions?.requested === undefined
                ? t('not reported')
                : permissions.requested.length
                  ? permissions.requested.join(', ')
                  : t('none')}
            </p>
            {permissions?.requested?.includes('workflow') && (
              <p className="panel-note">
                {t(
                  'workflow allows creating or updating GitHub Actions workflow files.',
                )}
              </p>
            )}
            <p>
              {t('permissions reported by GitHub')}:{' '}
              {permissions?.granted === undefined
                ? t('GitHub has not reported granted permissions.')
                : permissions.granted.length
                  ? permissions.granted.join(', ')
                  : t('GitHub reported no OAuth scopes.')}
            </p>
            <p className="panel-note">
              {t(
                'Circle allowed repositories limit Circle actions; they do not reduce GitHub OAuth permissions.',
              )}
            </p>
          </details>
          {view.repositories.length === 0 && (
            <p className="panel-note">
              {t(
                'No repositories selected; repository actions are unavailable.',
              )}
            </p>
          )}
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
            <details
              className="context-source"
              open={embedded ? undefined : true}
            >
              <summary>{t('connection options')}</summary>
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
            </details>
          )}
          {view.state !== 'connected' && view.state !== 'authorizing' && (
            <>
              <details
                className="context-source"
                open={embedded ? undefined : true}
              >
                <summary>{t('credential storage')}</summary>
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
              </details>
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
                : expired
                  ? t('GitHub authorization has expired.')
                  : denied
                    ? t('GitHub denied access to this repository.')
                    : requestFailed
                      ? t('GitHub could not be reached or the request failed.')
                      : t('GitHub action could not be completed.')}
          </p>
          <p className="panel-note">
            {storageUnavailable
              ? t(
                  'Choose this session only if you want to continue without saving credentials, then start authorization again.',
                )
              : expired
                ? t('Reconnect this GitHub account here. Your edits are kept.')
                : denied
                  ? t(
                      'Review the account permissions and allowed repositories before retrying. Your edits are kept.',
                    )
                  : requestFailed
                    ? t(
                        'Check your network and retry the read when ready. Your edits are kept.',
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

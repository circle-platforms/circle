import './GitPanel.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import type { GitHubConnectionState } from '../../../../src/github_connection';
import { useRuntime } from '../app/context';
import { copyText, desktopHost } from '../host';
import { t } from '../i18n';
import { Badge, Button, Switch } from './common';
import { githubPermissions } from '../model/github-permissions';

const repositoryPattern = /^[\w.-]+\/[\w.-]+$/;

/** What each GitHub tool lets Circle do, in plain words. */
const capabilities = [
  [
    'github_connection',
    () => t('check the connection and Circle repository access'),
  ],
  [
    'github_candidate',
    () => t('inspect the exact commit and files before publishing'),
  ],
  ['github_checks', () => t('read pull request checks')],
  ['github_logs', () => t('read failed CI logs')],
  ['github_retry', () => t('retry failed CI jobs after approval')],
  ['github_publish', () => t('publish a reviewed draft PR after approval')],
] as const;

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
      />
    </svg>
  );
}

/**
 * The GitHub connection, laid out as a connector page: a summary with the
 * state and the one action that fits it, then repositories, sign-in and
 * permissions. `integration` adds the on/off switch when the card is the
 * plugin's page; `onTry` drafts an example once an account is connected.
 */
export function GitHubConnectionCard({
  embedded = false,
  integration,
  onTry,
  tryError,
}: {
  embedded?: boolean;
  integration?: {
    enabled: boolean;
    onToggle: (value: boolean) => void;
    feedback?: ReactNode;
  };
  onTry?: () => void;
  tryError?: string;
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
  const [repositories, setRepositories] = useState<string[]>([]);
  const [newRepository, setNewRepository] = useState('');
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
      setNewRepository('');
    }
    if (!repositoryDirty) {
      setRepositories(view?.repositories ?? []);
      setRepositoryEpoch(view?.epoch);
    }
  }, [view?.epoch, repositoryDirty]);
  const [busyAction, setBusyAction] = useState('');
  const busy = !!busyAction;
  const commandRevision = useRef(0);
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
    const revision = ++commandRevision.current;
    setBusyAction(verb);
    setError('');
    try {
      const result = await runtime.command(
        'github',
        verb + (params ? ' ' + JSON.stringify(params) : ''),
      );
      if (result && 'error' in result && result.error)
        throw Error(String(result.error));
    } catch (reason) {
      if (revision !== commandRevision.current) return;
      if (verb === 'configure' || verb === 'connect')
        pendingRepositories.current = undefined;
      setError(String(reason));
    } finally {
      if (revision === commandRevision.current) setBusyAction('');
    }
  }
  function edit(next: string[], typing = newRepository) {
    if (!repositoryDirty) setRepositoryEpoch(view?.epoch);
    setRepositoryDirty(true);
    setRepositories(next);
    setNewRepository(typing);
  }
  const typed = newRepository.trim();
  const typedValid = !typed || repositoryPattern.test(typed);
  // A repository typed but not added yet still counts, so a save or a
  // connection never drops what the person wrote.
  const allowed = [...new Set(typed ? [...repositories, typed] : repositories)];
  const valid = allowed.every((item) => repositoryPattern.test(item));
  function addRepository() {
    if (!typed || !typedValid) return;
    edit(
      repositories.includes(typed) ? repositories : [...repositories, typed],
      '',
    );
  }
  const attention = loadFailed || view?.state === 'error' || !!view?.error;
  const connected = view?.state === 'connected' && !!view.account;
  const code =
    view?.state === 'authorizing' &&
    view.authorizationPhase !== 'verifying-account'
      ? view.authorization?.code || undefined
      : undefined;
  const chip =
    !extension || runtime.mode !== 'live'
      ? { text: t('not available'), tone: 'neutral' as const }
      : !extension.enabled
        ? { text: t('turned off'), tone: 'neutral' as const }
        : loading
          ? { text: t('loading…'), tone: 'neutral' as const }
          : attention
            ? { text: t('needs attention'), tone: 'amber' as const }
            : connected
              ? {
                  text: t('connected as {account}', {
                    account: view!.account!.login,
                  }),
                  tone: 'green' as const,
                }
              : view?.state === 'authorizing'
                ? { text: t('connecting…'), tone: 'blue' as const }
                : { text: t('not connected'), tone: 'neutral' as const };
  const status = !available
    ? loading
      ? t('loading GitHub integration')
      : loadFailed
        ? ''
        : integration
          ? t('Turn on GitHub to connect your account.')
          : t(
              'GitHub connection is unavailable; enable the bundled GitHub extension in Circle desktop.',
            )
    : view.state === 'authorizing'
      ? view.authorizationPhase === 'verifying-account'
        ? t('verifying GitHub account')
        : code && view.authorization?.url
          ? t('waiting for GitHub authorization')
          : t('preparing GitHub authorization code')
      : connected
        ? view.storage === 'session'
          ? t('GitHub connection lasts only for this Circle session.')
          : t('Circle uses this account only for the repositories you allow.')
        : t(
            'Connect your GitHub account to read pull request checks and CI, and to publish reviewed changes after your approval.',
          );
  const usable = capabilities.filter(
    ([tool]) => available && !extension.error && extension.tools.includes(tool),
  );
  return (
    <section
      className={'github-connector' + (embedded ? ' embedded' : '')}
      id="github-connection"
      aria-labelledby="github-connection-title"
    >
      <div className="github-summary">
        <div className="github-summary-head">
          <span className="github-mark">
            <GitHubMark />
          </span>
          <div className="github-summary-title">
            <h2 id="github-connection-title">{t('GitHub account')}</h2>
            <span role="status">
              <Badge tone={chip.tone}>{chip.text}</Badge>
            </span>
          </div>
          {integration && (
            <Switch
              label={t('enable {name}', { name: 'GitHub' })}
              checked={integration.enabled}
              onChange={integration.onToggle}
            />
          )}
        </div>
        {integration?.feedback}
        {status && (
          <p className="github-status" role={loading ? 'status' : undefined}>
            {status}
          </p>
        )}
        {!available && !loading && !integration && (
          <NavLink to="/page/extensions">{t('extensions')}</NavLink>
        )}
        {available && code && (
          <div className="github-device-code">
            <p>{t('enter this code in your browser')}</p>
            <code>{code}</code>
          </div>
        )}
        {failure && (
          <div className="github-alert" role="alert">
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
                        ? t(
                            'GitHub could not be reached or the request failed.',
                          )
                        : t('GitHub action could not be completed.')}
            </p>
            <p className="panel-note">
              {storageUnavailable
                ? t(
                    'To continue without saving your sign-in, choose sign out when Circle closes, then start again.',
                  )
                : expired
                  ? t(
                      'Reconnect this GitHub account here. Your edits are kept.',
                    )
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
        {available && (
          <div className="github-actions">
            {view.state === 'authorizing' ? (
              <>
                {code && view.authorization?.url && (
                  <Button
                    className="primary"
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
                    {t('open GitHub')}
                  </Button>
                )}
                {code && (
                  <Button onClick={() => perform(() => copyText(code))}>
                    {t('copy code')}
                  </Button>
                )}
                <Button
                  disabled={busy && busyAction !== 'connect'}
                  onClick={() => command('cancel', { epoch: view.epoch })}
                >
                  {t('cancel')}
                </Button>
              </>
            ) : view.state === 'connected' ? (
              <>
                {onTry && (
                  <Button className="github-try" onClick={onTry}>
                    {t('try in a conversation')}
                  </Button>
                )}
                <Button disabled={busy} onClick={() => command('status')}>
                  {t('refresh')}
                </Button>
                <Button
                  className="danger github-disconnect"
                  disabled={busy}
                  onClick={() => command('disconnect', { epoch: view.epoch })}
                >
                  {t('disconnect')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  className="primary"
                  disabled={busy || !valid}
                  onClick={() => {
                    pendingRepositories.current = allowed;
                    void command('connect', { storage, repositories: allowed });
                  }}
                >
                  {t('connect GitHub')}
                </Button>
                <Button disabled={busy} onClick={() => command('status')}>
                  {t('refresh')}
                </Button>
              </>
            )}
          </div>
        )}
        {tryError && (
          <p className="github-message" role="alert">
            {tryError}
          </p>
        )}
        {available &&
          view.lastAuthorizationOutcome === 'cancelled-before-code' && (
            <p className="github-message" role="status">
              {t(
                'GitHub authorization was cancelled before a code was ready. No new connection was established.',
              )}
            </p>
          )}
        {available && view.lastAuthorizationOutcome === 'cancelled' && (
          <p className="github-message" role="status">
            {t('GitHub authorization was cancelled.')}
          </p>
        )}
        {available &&
          view.state === 'disconnected' &&
          view.remoteRevocation === 'unconfirmed' && (
            <p className="github-message">
              {t(
                'Disconnected from Circle. GitHub authorization revocation is not confirmed.',
              )}
            </p>
          )}
      </div>
      {available && view.state !== 'authorizing' && (
        <section
          className="github-section"
          aria-labelledby="github-repositories-title"
        >
          <h3 id="github-repositories-title">{t('repositories')}</h3>
          <p className="github-section-note">
            {t(
              'Circle works only with the repositories listed here. This does not change what your GitHub account allows.',
            )}
          </p>
          {repositories.length ? (
            <ul className="github-repositories">
              {repositories.map((repository) => (
                <li key={repository}>
                  <span>{repository}</span>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={t('remove {name}', { name: repository })}
                    disabled={busy}
                    onClick={() =>
                      edit(repositories.filter((item) => item !== repository))
                    }
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="github-empty">
              {t(
                'No repositories selected; repository actions are unavailable.',
              )}
            </p>
          )}
          <div className="github-add-repository">
            <input
              className="input"
              aria-label={t('add repository')}
              aria-invalid={!typedValid || undefined}
              value={newRepository}
              placeholder="owner/repository"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => edit(repositories, event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addRepository();
              }}
            />
            <Button disabled={!typed || !typedValid} onClick={addRepository}>
              {t('add')}
            </Button>
          </div>
          {!typedValid && (
            <p className="github-field-error">
              {t('Write it as owner/repository, for example octo-org/app.')}
            </p>
          )}
          {view.state === 'connected' && (
            <div className="github-actions end">
              {repositoryDirty && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    pendingRepositories.current = undefined;
                    setRepositories(view.repositories);
                    setNewRepository('');
                    setRepositoryEpoch(view.epoch);
                    setRepositoryDirty(false);
                  }}
                >
                  {t('reset')}
                </Button>
              )}
              <Button
                className="primary"
                disabled={busy || !valid || !repositoryDirty}
                onClick={() => {
                  pendingRepositories.current = allowed;
                  void command('configure', {
                    epoch: repositoryEpoch,
                    repositories: allowed,
                  });
                }}
              >
                {t('save')}
              </Button>
            </div>
          )}
        </section>
      )}
      {available &&
        view.state !== 'connected' &&
        view.state !== 'authorizing' && (
          <section
            className="github-section"
            aria-labelledby="github-sign-in-title"
          >
            <h3 id="github-sign-in-title">{t('sign-in')}</h3>
            <div
              className="github-choices"
              role="radiogroup"
              aria-labelledby="github-sign-in-title"
            >
              {(
                [
                  [
                    'encrypted',
                    t('stay signed in on this computer'),
                    t('Your sign-in is kept in secure storage.'),
                  ],
                  [
                    'session',
                    t('sign out when Circle closes'),
                    t('You sign in again the next time.'),
                  ],
                ] as const
              ).map(([value, title, note]) => (
                <label
                  key={value}
                  className={
                    'github-choice' + (storage === value ? ' active' : '')
                  }
                >
                  <input
                    type="radio"
                    aria-label={title}
                    name="github-storage"
                    value={value}
                    checked={storage === value}
                    onChange={() => setStorage(value)}
                  />
                  <span>
                    <strong>{title}</strong>
                    <small>{note}</small>
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}
      {available && (
        <section
          className="github-section"
          aria-labelledby="github-permissions-title"
        >
          <h3 id="github-permissions-title">{t('permissions')}</h3>
          {usable.length > 0 && (
            <>
              <p className="github-section-note">{t('what Circle can do')}</p>
              <ul className="github-capabilities">
                {usable.map(([tool, label]) => (
                  <li key={tool}>
                    <Check size={14} aria-hidden="true" />
                    <span>{label()}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {!connected && (
            <p className="github-section-note">
              {t(
                'Repository tools appear after connecting an account and allowing specific repositories. Writes require approval; merging remains your decision.',
              )}
            </p>
          )}
          <details className="context-source github-permissions">
            <summary>{t('permission details')}</summary>
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
                  : t('GitHub reported no permissions.')}
            </p>
          </details>
        </section>
      )}
    </section>
  );
}

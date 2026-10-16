import { useRef, useState } from 'react';
import { Blocks } from 'lucide-react';
import { useRuntime } from '../app/context';
import { GitHubConnectionCard } from '../components/GitHubConnectionCard';
import { Button, Switch } from '../components/common';
import {
  prepareGitHubExample,
  type PreparedGitHubExample,
} from '../model/github-example';
import { t } from '../i18n';
import type { PluginDetailProps, WorkbenchPlugin } from './types';

export function GitHubPluginDetails({
  enabled,
  onToggle,
  feedback,
}: PluginDetailProps) {
  const { snapshot, runtime, act } = useRuntime();
  const origin = useRef({
    sessionId: snapshot.activeSessionId,
    epoch: runtime.presentationEpoch,
  });
  const pending = useRef<PreparedGitHubExample | undefined>(undefined);
  const [error, setError] = useState('');
  const extension = snapshot.extensions.find(
    (item) => item.name === 'github' && item.scope === 'bundled',
  );
  const ready =
    runtime.mode === 'live' &&
    enabled &&
    extension?.enabled &&
    !extension.error &&
    extension.tools.includes('github_connection') &&
    (extension.view as { provider?: string } | undefined)?.provider ===
      'github';
  function tryExample() {
    setError('');
    try {
      pending.current = prepareGitHubExample(
        runtime,
        origin.current,
        t(
          'Check the GitHub connection and list the repositories Circle may access. Do not change any repository.',
        ),
        pending.current,
      );
      if (!pending.current.saved) {
        setError(
          t(
            'the example could not be saved; retry to keep it in the same draft',
          ),
        );
        return;
      }
      act(() => {
        if (
          runtime.getSnapshot().activeSessionId !== origin.current.sessionId ||
          runtime.presentationEpoch !== origin.current.epoch
        )
          throw Error(
            t(
              'the original conversation changed; return to it before trying the plugin',
            ),
          );
        return {
          openSession: true,
          focusComposer: true,
          notice: t('example added to your unsent draft; send it when ready'),
        };
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  const capabilities = [
    [
      'github_connection',
      () => t('check the connection and Circle repository access'),
    ],
    ['github_checks', () => t('read pull request checks')],
    ['github_logs', () => t('read failed CI logs')],
    ['github_retry', () => t('retry failed CI jobs after approval')],
    ['github_publish', () => t('publish a reviewed draft PR after approval')],
  ] as const;
  const available = capabilities.filter(
    ([tool]) => ready && extension?.tools.includes(tool),
  );
  return (
    <section aria-label={t('GitHub plugin')}>
      <div className="inline-actions">
        <details className="context-source">
          <summary>{t('manage')}</summary>
          <Switch
            label={t('enable {name}', { name: 'github' })}
            checked={enabled}
            onChange={onToggle}
          />
        </details>
        <Button disabled={!ready} onClick={tryExample}>
          {t('try now')}
        </Button>
      </div>
      {feedback}
      {error && <p role="alert">{error}</p>}
      <GitHubConnectionCard embedded />
      <section className="panel-section">
        <h2>{t('capabilities')}</h2>
        <p>
          {t(
            'Use GitHub connection status, draft pull requests and CI results in your Circle conversation.',
          )}
        </p>
        {available.length ? (
          <ul>
            {available.map(([tool, label]) => (
              <li key={tool}>{label()}</li>
            ))}
          </ul>
        ) : (
          <p className="panel-note">
            {!enabled
              ? t('Enable the plugin to see its available tools.')
              : extension?.error
                ? t('GitHub integration could not be loaded.')
                : t(
                    'GitHub tools are loading or unavailable. Review the integration status above.',
                  )}
          </p>
        )}
        <p className="panel-note">
          {t(
            'Repository tools appear after connecting an account and allowing specific repositories. Writes require approval; merging remains your decision.',
          )}
        </p>
        <p className="panel-note">
          {t(
            'Try now prepares a read-only connection example. Nothing is sent automatically.',
          )}
        </p>
      </section>
    </section>
  );
}
export const githubPlugin: WorkbenchPlugin = {
  id: 'github',
  apiVersion: 1,
  version: '0.1.0',
  runtimeExtension: 'github',
  get title() {
    return 'GitHub';
  },
  get description() {
    return t(
      'GitHub connection, reviewed pull requests and CI in your conversation.',
    );
  },
  icon: Blocks,
  detail: GitHubPluginDetails,
};

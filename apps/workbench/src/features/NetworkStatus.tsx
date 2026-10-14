import { useRuntime } from '../app/context';
import { t, tn } from '../i18n';

/** Read-only state of the worker's actual transport, including startup configuration problems. */
export function NetworkStatus() {
  const { snapshot } = useRuntime();
  const network = snapshot.runtime?.network;
  if (!network) return null;
  return (
    <details className="network-status">
      <summary>
        {t('network trust')} ·{' '}
        {tn(network.authorities, '{n} authority', '{n} authorities')} ·{' '}
        {network.proxy ? t('proxy enabled') : t('direct connection')}
      </summary>
      <dl className="facts">
        {network.sources.map((source, index) => (
          <div key={`${source.name}-${index}`}>
            <dt>{source.name}</dt>
            <dd>
              {source.certificates}
              {source.path ? ` · ${source.path}` : ''}
            </dd>
          </div>
        ))}
        {network.bundle && (
          <div>
            <dt>{t('child process bundle')}</dt>
            <dd>{network.bundle}</dd>
          </div>
        )}
      </dl>
      {network.problems.map((problem, index) => (
        <p key={index} className="error-text">
          {problem}
        </p>
      ))}
    </details>
  );
}

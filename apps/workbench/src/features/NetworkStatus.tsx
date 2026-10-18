import { useRuntime } from '../app/context';
import { t, tn } from '../i18n';

// Where the authorities come from, in words: the names themselves are settings
// and environment variables, so they stay as written.
const SOURCE_TEXT: Record<string, () => string> = {
  default: () => t('the roots Node.js ships with'),
  SSL_CERT_FILE: () => t('the PEM bundle named by SSL_CERT_FILE'),
  SSL_CERT_DIR: () => t('the PEM files in the folder named by SSL_CERT_DIR'),
  NODE_EXTRA_CA_CERTS: () => t('the file named by NODE_EXTRA_CA_CERTS'),
  trust_cert_files: () => t('the files named by trust_cert_files in settings'),
  CIRCLE_TRUST_CERTS: () =>
    t('the files named by CIRCLE_TRUST_CERTS for this run'),
};

/**
 * Read-only state of the worker's actual transport: what a server's certificate is
 * checked against, how requests leave the machine, and any startup problem with
 * those settings.
 */
export function NetworkStatus() {
  const { snapshot } = useRuntime();
  const network = snapshot.runtime?.network;
  if (!network) return null;
  const extra = network.sources.filter((source) => source.name !== 'default');
  return (
    <details className="network-status">
      <summary>
        {t('network trust')} ·{' '}
        {tn(network.authorities, '{n} authority', '{n} authorities')} ·{' '}
        {network.proxy ? t('proxy enabled') : t('direct connection')}
      </summary>
      <p className="panel-note">
        {t(
          'Circle checks a server against these before it sends anything: its model, the model list, updates, a page it opens, and a server it reaches by URL. Certificates are never accepted without this check, and Circle never changes the trust of the operating system itself.',
        )}
      </p>
      <dl className="facts">
        <div>
          <dt>{t('trusted in total')}</dt>
          <dd>
            {tn(network.authorities, '{n} authority', '{n} authorities')} ·{' '}
            {network.certificates
              ? t('{n} added by Circle', { n: network.certificates })
              : t('none added by Circle')}
          </dd>
        </div>
        <div>
          <dt>{t('route')}</dt>
          <dd>
            {network.proxy
              ? [
                  t('through a proxy'),
                  network.proxyFrom,
                  network.proxyHost &&
                    t('at {host}', { host: network.proxyHost }),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : t('no proxy: Circle reaches the server itself')}
          </dd>
        </div>
        {network.bundle && (
          <div>
            <dt>{t('child process bundle')}</dt>
            <dd>{network.bundle}</dd>
          </div>
        )}
      </dl>
      <table className="source-table">
        <thead>
          <tr>
            <th>{t('source')}</th>
            <th>{t('certificates')}</th>
          </tr>
        </thead>
        <tbody>
          {network.sources.map((source, index) => (
            <tr key={`${source.name}-${index}`}>
              <th scope="row">
                <code>{source.name}</code>
                <small>
                  {SOURCE_TEXT[source.name]?.() ?? t('named by a setting')}
                  {source.path ? ` · ${source.path}` : ''}
                </small>
              </th>
              <td>
                {tn(source.certificates, '{n} certificate', '{n} certificates')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {network.problems.map((problem, index) => (
        <p key={index} className="error-text">
          {problem}
        </p>
      ))}
      <p className="panel-note">
        {extra.length
          ? t(
              'Circle adds these to the roots it already trusts, and hands the whole set to every command and tool it starts.',
            )
          : t(
              'Nothing of your own is trusted yet beyond the defaults. Name a PEM file in trust_cert_files, or set SSL_CERT_FILE, and restart Circle to add your own.',
            )}
      </p>
    </details>
  );
}

import './HubConnectionCard.css';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useRuntime } from '../app/context';
import { desktopHost } from '../host';
import { t, tn } from '../i18n';
import { Badge, Button, CopyButton, DeviceCode, Switch } from './common';

/** The MCP entry the Hub extension keeps (src/hub_connection.ts). */
export const HUB_SERVER = 'Hub';

/** The Hub's address as a person reads it: the origin of its MCP endpoint. */
function hubAddress(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * The Hub connection: a Hub's address becomes the MCP entry named Hub, and its sign-in shows here, with the code to
 * type on the Hub's page when the Hub offers sign-in by code. No address is built in.
 */
export function HubConnectionCard({
  integration,
}: {
  integration: {
    enabled: boolean;
    onToggle: (enabled: boolean) => void;
    feedback?: ReactNode;
  };
}) {
  const { snapshot, runtime } = useRuntime();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const extension = snapshot.extensions.find(
    (item) => item.name === 'hub' && item.scope === 'bundled',
  );
  const available =
    runtime.mode === 'live' &&
    integration.enabled &&
    !!extension?.enabled &&
    !extension.error;
  const row = snapshot.mcp.find((item) => item.name === HUB_SERVER);
  const signIn = row?.signIn;
  const chip: { tone: 'neutral' | 'green' | 'amber' | 'blue'; text: string } =
    !row
      ? { tone: 'neutral', text: t('not connected') }
      : row.status === 'connected'
        ? { tone: 'green', text: t('connected') }
        : signIn
          ? { tone: 'blue', text: t('waiting for sign-in') }
          : row.status === 'reload required'
            ? { tone: 'amber', text: t('reload required') }
            : row.status === 'error'
              ? { tone: 'amber', text: t('not connected') }
              : { tone: 'neutral', text: t('not connected') };
  async function run(kind: string, payload: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      await runtime.request(kind, payload);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function connect(event: FormEvent) {
    event.preventDefault();
    if (await run('hub-connect', { address })) setAddress('');
  }
  const https = signIn?.url.startsWith('https://') ?? false;
  return (
    <section
      className="hub-connector"
      id="hub-connection"
      aria-labelledby="hub-connection-title"
    >
      <div className="hub-summary">
        <div className="hub-summary-head">
          <div className="hub-summary-title">
            <h2 id="hub-connection-title">{t('Hub connection')}</h2>
            <span role="status">
              <Badge tone={chip.tone}>{chip.text}</Badge>
            </span>
          </div>
          <Switch
            label={t('enable {name}', { name: 'Hub' })}
            checked={integration.enabled}
            onChange={integration.onToggle}
          />
        </div>
        {integration.feedback}
        {!row && (
          <p className="hub-status">
            {t(
              'Type the address of your Circle Hub. Circle then shows a code to enter on the Hub’s page; no address is built in.',
            )}
          </p>
        )}
        {available && !row && (
          <form className="hub-address" onSubmit={connect}>
            <label htmlFor="hub-address">{t('hub address')}</label>
            <div className="hub-address-row">
              <input
                id="hub-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="https://hub.example.com"
                autoComplete="off"
                spellCheck={false}
                maxLength={2048}
                disabled={busy}
              />
              <Button
                className="primary"
                type="submit"
                disabled={busy || !address.trim()}
              >
                {busy ? t('connecting…') : t('connect')}
              </Button>
            </div>
          </form>
        )}
        {row && (
          <p className="hub-status">
            {t('Hub at {address}', { address: hubAddress(row.url) })}
            {row.status === 'connected' &&
              ' · ' +
                tn(
                  row.tools.length,
                  '{n} tool available',
                  '{n} tools available',
                )}
          </p>
        )}
        {available && signIn?.code && (
          <DeviceCode
            prompt={t('enter this code on the Hub’s page')}
            code={signIn.code}
          />
        )}
        {available && signIn && !signIn.code && (
          <p className="hub-status">
            {t('finish the sign-in on the Hub’s page')}
          </p>
        )}
        {available && row?.status === 'error' && !signIn && row.error && (
          <div className="hub-alert" role="alert">
            <p>{t('The Hub could not be connected.')}</p>
            <pre tabIndex={0}>{row.error}</pre>
          </div>
        )}
        {error && (
          <p className="hub-message" role="alert">
            {error}
          </p>
        )}
        {available && row && (
          <div className="hub-actions">
            {signIn && (
              <>
                <Button
                  className="primary"
                  disabled={!https || !desktopHost()?.openExternal}
                  onClick={async () => {
                    try {
                      await desktopHost()?.openExternal?.(signIn.url);
                    } catch (reason) {
                      setError(String(reason));
                    }
                  }}
                >
                  {t('open the Hub’s page')}
                </Button>
                <CopyButton text={signIn.url} label={t('copy link')} />
              </>
            )}
            {(row.status === 'error' || row.status === 'reload required') &&
              !signIn && (
                <Button disabled={busy} onClick={() => void run('reload')}>
                  {t('retry')}
                </Button>
              )}
            <Button
              className="hub-disconnect"
              disabled={busy}
              onClick={() => void run('hub-disconnect')}
            >
              {t('disconnect')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

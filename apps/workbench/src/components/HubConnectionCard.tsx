import './HubConnectionCard.css';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRuntime } from '../app/context';
import { desktopHost } from '../host';
import { locale, t, tn } from '../i18n';
import type { McpServer } from '../model/types';
import { Badge, Button, CopyButton, DeviceCode, Switch } from './common';

/** The MCP entry the Hub extension keeps (src/hub_connection.ts). */
export const HUB_SERVER = 'Hub';

/**
 * The state of a connection an extension keeps as an MCP server entry, as its card shows it: connected, waiting for its
 * sign-in, needing a reload to take a change, or not connected (also when there is no entry yet).
 */
export function connectionChip(row: McpServer | undefined): {
  tone: 'neutral' | 'green' | 'amber' | 'blue';
  text: string;
} {
  return !row
    ? { tone: 'neutral', text: t('not connected') }
    : row.status === 'connected'
      ? { tone: 'green', text: t('connected') }
      : row.signIn
        ? { tone: 'blue', text: t('waiting for sign-in') }
        : row.status === 'reload required'
          ? { tone: 'amber', text: t('reload required') }
          : row.status === 'error'
            ? { tone: 'amber', text: t('not connected') }
            : { tone: 'neutral', text: t('not connected') };
}

/** What finding a Hub at a typed address says (src/hub_connection.ts), in the window's language; anything else as it is. */
export function hubErrorText(message: string): string {
  const nowhere = /no Circle Hub answers at (.+)$/.exec(message);
  if (nowhere)
    return t('no Circle Hub answers at {addresses}', {
      // The addresses tried, as a list in the window's language
      addresses: new Intl.ListFormat(locale(), { type: 'disjunction' }).format(
        (nowhere[1] ?? '').split(/, | or /),
      ),
    });
  const known: [string, () => string][] = [
    [
      'type the address of a Circle Hub',
      () => t('type the IP address of your Hub'),
    ],
    [
      'that is not a web address',
      () => t('that is not an IP address or a web address'),
    ],
    [
      'a Hub address starts with https:// or http://',
      () => t('a Hub address starts with https:// or http://'),
    ],
    [
      'a Hub address carries no user name or password',
      () =>
        t(
          'type your user name and password on the Hub’s page, not in its address',
        ),
    ],
    [
      'a Hub address has no query or fragment',
      () => t('a Hub address has no query or fragment'),
    ],
    [
      'type the Hub address without a path',
      () => t('type the Hub address without a path'),
    ],
  ];
  return known.find(([english]) => message.includes(english))?.[1]() ?? message;
}

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
  // What finding a Hub said belongs to the address form: once there is a Hub, it is past
  const present = !!row;
  useEffect(() => {
    if (present) setError('');
  }, [present]);
  const chip = connectionChip(row);
  async function run(kind: string, payload: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      await runtime.request(kind, payload);
      return true;
    } catch (reason) {
      setError(
        hubErrorText(reason instanceof Error ? reason.message : String(reason)),
      );
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
              'Type your Hub’s IP address. Circle then opens the Hub’s page, where you sign in with your Hub user name and password.',
            )}
          </p>
        )}
        {available && !row && (
          <form className="hub-address" onSubmit={connect}>
            <label htmlFor="hub-address">{t('hub IP address')}</label>
            <div className="hub-address-row">
              <input
                id="hub-address"
                value={address}
                onChange={(event) => setAddress(event.target.value)}
                placeholder="192.0.2.10"
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
        {available && signIn && (
          <p className="hub-status">
            {t(
              'sign in on the Hub’s page with your Hub user name and password',
            )}
          </p>
        )}
        {available && signIn?.code && (
          <DeviceCode
            prompt={t('then enter this code there')}
            code={signIn.code}
          />
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

import { useState, type FormEvent } from 'react';
import { Button } from '../components/common';
import { t } from '../i18n';
import type { TerminalTargetRow } from '../../../desktop/src/contracts';

/**
 * A quick connect: reach a device by its address, as SecureCRT does. Nothing is saved;
 * the devices that stay come from the saved profiles. A Telnet console asks for its own
 * login; SSH signs in from a saved device, which is said under the fields.
 */
export function TerminalConnect({
  onConnect,
  onCancel,
}: {
  /** Rejects with the reason a connection could not be started. */
  onConnect: (target: TerminalTargetRow) => Promise<void>;
  onCancel: () => void;
}) {
  const [transport, setTransport] = useState<'ssh' | 'telnet'>('ssh');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const number = port.trim() ? Number(port.trim()) : undefined;
    setProblem('');
    setBusy(true);
    onConnect({
      transport,
      host: host.trim(),
      ...(number ? { port: number } : {}),
      // A Telnet console asks for its own login on the screen.
      ...(transport === 'ssh' && user.trim() ? { user: user.trim() } : {}),
      ...(transport === 'ssh' && password ? { password } : {}),
    }).then(
      () => {
        setBusy(false);
        setPassword('');
      },
      (error) => {
        setBusy(false);
        setProblem(error instanceof Error ? error.message : String(error));
      },
    );
  };
  return (
    <form className="term-connect" onSubmit={submit}>
      <h3>{t('connect new device')}</h3>
      <div className="term-connect-field">
        <span className="term-connect-label" id="term-connect-protocol">
          {t('protocol')}
        </span>
        <div
          className="segmented"
          role="group"
          aria-labelledby="term-connect-protocol"
        >
          {(['ssh', 'telnet'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={transport === value ? 'active' : ''}
              aria-pressed={transport === value}
              onClick={() => setTransport(value)}
            >
              {value === 'ssh' ? 'SSH' : 'Telnet'}
            </button>
          ))}
        </div>
      </div>
      <div className="term-connect-row">
        <label className="term-connect-field">
          <span className="term-connect-label">{t('address')}</span>
          <input
            required
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={host}
            onChange={(event) => setHost(event.target.value)}
          />
        </label>
        <label className="term-connect-field">
          <span className="term-connect-label">{t('port')}</span>
          <input
            inputMode="numeric"
            spellCheck={false}
            placeholder={transport === 'ssh' ? '22' : '23'}
            value={port}
            onChange={(event) =>
              setPort(event.target.value.replace(/[^0-9]/g, ''))
            }
          />
        </label>
      </div>
      {/* A Telnet console asks for its login on its own screen. */}
      {transport === 'ssh' && (
        <label className="term-connect-field">
          <span className="term-connect-label">{t('user name')}</span>
          <input
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            value={user}
            onChange={(event) => setUser(event.target.value)}
          />
        </label>
      )}
      {transport === 'ssh' && (
        <label className="term-connect-field">
          <span className="term-connect-label">{t('password')}</span>
          <input
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      )}
      <p className="term-connect-note">
        {t(
          'SSH signs in with the password typed here, used for this connection and never saved; a Telnet console asks for its own login',
        )}
      </p>
      {problem && (
        <p className="term-connect-problem" role="status">
          {problem}
        </p>
      )}
      <div className="term-connect-actions">
        <Button type="button" onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          type="submit"
          className="primary"
          disabled={busy || !host.trim()}
        >
          {t('connect')}
        </Button>
      </div>
    </form>
  );
}

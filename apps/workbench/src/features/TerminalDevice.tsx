// The device terminals of this conversation, shared with the main process: every console
// the model opened, painted here by xterm.js from the raw device bytes. The person attaches
// to type on a device themselves — the model's actions wait while they hold it — and gives
// it back. A first host key is answered here, in the panel, as a certificate is.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { RefreshCw, Unplug, Hand, KeyRound, Plus, X } from 'lucide-react';
import { hexToRgb, palette, terminalAnsiHex } from '../../../../src/ink/theme';
import type { TerminalSessionRow } from '../../../desktop/src/contracts';
import { desktopHost } from '../host';
import { useTerminalState } from './useTerminalState';
import { Button, EmptyState, IconButton } from '../components/ui';
import { t } from '../i18n';
import type { PluginPanelProps } from '../plugins/types';

// The emulator's colours come from Circle's own palette, so the screen sits on the
// window: background, text and the sixteen ANSI slots alike, refreshed on a theme switch.
function xtermTheme(): Partial<ITheme> {
  const p = palette();
  const theme: Record<string, string> = {
    background: p.bg_hex,
    foreground: p.fg_hex,
    cursor: p.fg_hex,
    selectionBackground: `rgb(${hexToRgb(p.fg_hex).join(' ')} / 25%)`,
  };
  terminalAnsiHex().forEach((hex, slot) => (theme[`ansi${slot}`] = hex));
  return theme as Partial<ITheme>;
}

const bytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

function stateWord(row: TerminalSessionRow): string {
  if (row.held === 'handoff') return t('Circle handed it to you');
  if (row.held === 'attach') return t('you have the terminal');
  if (row.state === 'connecting') return t('connecting');
  if (row.state === 'ready')
    return row.quiet < 1500
      ? t('the device is answering')
      : t('quiet {time}', { time: `${Math.round(row.quiet / 1000)}s` });
  return row.state === 'error' ? row.detail || t('failed') : t('closed');
}

export function TerminalDevice({ sessionId, selection }: PluginPanelProps) {
  const host = desktopHost();
  const state = useTerminalState(sessionId);
  const rows = state?.sessions ?? [];
  const live = rows.filter(
    (row) => row.state === 'connecting' || row.state === 'ready' || row.held,
  );
  const [chosen, setChosen] = useState('');
  // A quick connect, SecureCRT-style: reach a device by address with no profile.
  const [form, setForm] = useState<{
    transport: 'ssh' | 'telnet';
    host: string;
    port: string;
    user: string;
  } | null>(null);
  const [problem, setProblem] = useState('');
  const active =
    live.find((row) => row.id === (selection || chosen)) ?? live[0];
  const activeId = active?.id ?? '';
  const screenRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const holder = useRef({ activeId: '', held: '', sessionId });
  holder.current = {
    activeId,
    held: active?.held ?? '',
    sessionId,
  };

  useEffect(() => {
    const el = screenRef.current;
    if (!el || termRef.current) return;
    const term = new Terminal({
      fontSize: 13,
      fontFamily: 'Menlo, Consolas, "DejaVu Sans Mono", monospace',
      scrollback: 2000,
      disableStdin: true,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    termRef.current = term;
    fitRef.current = fit;
    // What the person types goes to the device they hold; nobody else's keystrokes move.
    term.onData((data) => {
      const now = holder.current;
      if (now.held && now.activeId)
        void desktopHost()?.terminalInput(now.sessionId, now.activeId, data);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sizeSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        fit.fit();
        const now = holder.current;
        if (!now.activeId) return;
        // The manager ignores a size it already has, so this may fire freely.
        void desktopHost()?.terminalResize(
          now.sessionId,
          now.activeId,
          term.cols,
          term.rows,
        );
      }, 120);
    };
    const observer = new ResizeObserver(sizeSoon);
    observer.observe(el);
    const darkWatch = new MutationObserver(() => {
      term.options.theme = xtermTheme();
    });
    darkWatch.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      darkWatch.disconnect();
      term.dispose();
      termRef.current = undefined;
      fitRef.current = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Raw device bytes, in the main process's coalesced batches, straight to the emulator.
  useEffect(() => {
    if (!host) return;
    return host.onTerminalEvent((event) => {
      if (
        event.kind === 'data' &&
        event.conversation === sessionId &&
        event.session === holder.current.activeId
      )
        termRef.current?.write(bytes(event.bytes));
    });
  }, [host, sessionId]);

  // A newly seen console paints its screen from the recent raw stream: the panel never
  // waits for the device to speak again to show where it stands.
  useEffect(() => {
    const term = termRef.current;
    if (!term || !host || !activeId) return;
    let gone = false;
    term.reset();
    void host
      .terminalSnapshot(sessionId, activeId)
      .then((raw) => {
        if (!gone && raw) term.write(bytes(raw));
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [host, sessionId, activeId]);

  // Typing is only live while the person holds this very console.
  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !(active?.held ?? '');
  }, [active?.held]);

  if (!host)
    return (
      <EmptyState title={t('no device terminals yet')}>
        {t('the desktop application shows Circle device terminals here')}
      </EmptyState>
    );
  const asking = state?.pendingKey;
  const handoff = state?.handoff;
  const refresh = () => {
    const term = termRef.current;
    if (!term || !host || !activeId) return;
    term.reset();
    void host
      .terminalSnapshot(sessionId, activeId)
      .then((raw) => raw && term.write(bytes(raw)))
      .catch(() => {});
  };
  const disconnect = (row: TerminalSessionRow) =>
    void host.terminalDisconnect(sessionId, row.id).catch(() => {});
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!form || !host) return;
    const port = form.port.trim() ? Number(form.port.trim()) : undefined;
    setProblem('');
    void host
      .terminalConnectTarget(sessionId, {
        transport: form.transport,
        host: form.host.trim(),
        ...(port ? { port } : {}),
        ...(form.user.trim() ? { user: form.user.trim() } : {}),
      })
      .then((next) => {
        const last = next.sessions.at(-1);
        if (last) setChosen(last.id);
        setForm(null);
      })
      .catch((error) =>
        setProblem(error instanceof Error ? error.message : String(error)),
      );
  };
  return (
    <section className="device-terminal">
      <div className="terminal-toolbar">
        <Button
          className={form ? 'primary' : ''}
          onClick={() => {
            setProblem('');
            setForm(
              form
                ? null
                : { transport: 'telnet', host: '', port: '', user: '' },
            );
          }}
        >
          <Plus size={13} /> {t('new connection')}
        </Button>
        {active && (
          <>
            <span className="terminal-status muted small">
              {stateWord(active)} · {active.cols}×{active.rows}
            </span>
            <span className="terminal-toolbar-actions">
              <IconButton label={t('refresh the screen')} onClick={refresh}>
                <RefreshCw size={13} />
              </IconButton>
              {active.held ? (
                <Button
                  onClick={() =>
                    void host
                      .terminalDetach(sessionId, active.id)
                      .catch(() => {})
                  }
                >
                  <Hand size={13} /> {t('give back')}
                </Button>
              ) : (
                <Button
                  disabled={active.state !== 'ready'}
                  onClick={() =>
                    void host
                      .terminalAttach(sessionId, active.id)
                      .catch(() => {})
                  }
                >
                  <Hand size={13} /> {t('take the terminal')}
                </Button>
              )}
              <Button
                disabled={active.state === 'closed'}
                onClick={() => disconnect(active)}
              >
                <Unplug size={13} /> {t('disconnect')}
              </Button>
            </span>
          </>
        )}
      </div>
      {form && (
        <form className="terminal-connect" onSubmit={submit}>
          <label>
            {t('transport')}
            <select
              value={form.transport}
              onChange={(event) =>
                setForm({
                  ...form,
                  transport: event.target.value as 'ssh' | 'telnet',
                })
              }
            >
              <option value="telnet">telnet</option>
              <option value="ssh">ssh</option>
            </select>
          </label>
          <label>
            {t('host')}
            <input
              required
              autoFocus
              spellCheck={false}
              placeholder="172.16.6.85"
              value={form.host}
              onChange={(event) =>
                setForm({ ...form, host: event.target.value })
              }
            />
          </label>
          <label>
            {t('port')}
            <input
              inputMode="numeric"
              spellCheck={false}
              placeholder={form.transport === 'ssh' ? '22' : '23'}
              value={form.port}
              onChange={(event) =>
                setForm({
                  ...form,
                  port: event.target.value.replace(/[^0-9]/g, ''),
                })
              }
            />
          </label>
          <label>
            {t('user')}
            <input
              spellCheck={false}
              value={form.user}
              onChange={(event) =>
                setForm({ ...form, user: event.target.value })
              }
            />
          </label>
          <p className="panel-note">
            {t(
              'ssh signs in from a saved profile; a telnet console answers its own login',
            )}
          </p>
          {problem && (
            <p className="field-problem" role="status">
              {problem}
            </p>
          )}
          <div className="dialog-actions">
            <Button type="button" onClick={() => setForm(null)}>
              {t('cancel')}
            </Button>
            <Button type="submit" className="primary">
              {t('connect')}
            </Button>
          </div>
        </form>
      )}
      {live.length > 0 && (
        <div
          className="terminal-tabs"
          role="tablist"
          aria-label={t('device terminals')}
        >
          {live.map((row) => (
            <div
              key={row.id}
              role="tab"
              tabIndex={0}
              aria-selected={row.id === activeId}
              className={`terminal-tab ${row.id === activeId ? 'active' : ''}`}
              onClick={() => setChosen(row.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') setChosen(row.id);
              }}
            >
              <i className={`lamp lamp-${row.held ? 'wait' : row.state}`} />
              <span className="terminal-tab-name">
                {row.id} {row.name}
              </span>
              <button
                className="terminal-tab-close"
                aria-label={t('disconnect {name}', { name: row.name })}
                onClick={(event) => {
                  event.stopPropagation();
                  disconnect(row);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {asking && (
        <div className="terminal-ask" role="alert">
          <KeyRound size={14} />
          <span>
            {t('trust this device key?')} <strong>{asking.profile}</strong> ·{' '}
            {asking.host} · {asking.keyType}
            <br />
            <code>{asking.fingerprint}</code>
          </span>
          <div>
            <Button
              onClick={() =>
                void host.terminalHostKey(sessionId, 'once').catch(() => {})
              }
            >
              {t('connect once')}
            </Button>
            {asking.privateHost && (
              <Button
                onClick={() =>
                  void host.terminalHostKey(sessionId, 'always').catch(() => {})
                }
              >
                {t('trust for good')}
              </Button>
            )}
            <Button
              onClick={() =>
                void host.terminalHostKey(sessionId, 'reject').catch(() => {})
              }
            >
              {t('reject')}
            </Button>
          </div>
        </div>
      )}
      {handoff && active && (
        <div className="terminal-handoff">
          <Hand size={14} />
          <span>
            {t('Circle hands you {name}', { name: handoff.session })}
            {handoff.reason ? `: ${handoff.reason}` : ''}
          </span>
          <Button
            onClick={() =>
              void host.terminalDetach(sessionId, active.id).catch(() => {})
            }
          >
            {t('give back')}
          </Button>
        </div>
      )}
      <div className="terminal-screen" ref={screenRef} />
      <div className="terminal-profiles">
        <h3>{t('saved profiles')}</h3>
        {state?.profiles.length ? (
          state.profiles.map((profile) => (
            <button
              key={profile.name}
              className="terminal-profile"
              onClick={() =>
                void host
                  .terminalConnect(sessionId, profile.name)
                  .then((next) => setChosen(next.sessions.at(-1)?.id ?? ''))
                  .catch(() => {})
              }
            >
              <strong>{profile.name}</strong>
              <small>
                {profile.transport} {profile.target}
                {profile.user ? ` · ${profile.user}` : ''}
              </small>
            </button>
          ))
        ) : (
          <p className="panel-note">
            {t(
              'no saved profiles yet; a new connection reaches a device by address',
            )}
          </p>
        )}
      </div>
    </section>
  );
}

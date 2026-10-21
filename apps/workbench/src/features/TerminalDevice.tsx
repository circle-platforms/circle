// The device consoles of this conversation, shared with the main process: every console
// the model opened or you opened, painted here by xterm.js from the raw device bytes. You
// take one to type on the device yourself — the model's actions wait while you hold it —
// and give it back. They are tabs of the terminal mode, beside your shells.
import { useCallback, useEffect, useRef } from 'react';
import { Hand, KeyRound } from 'lucide-react';
import { Terminal, type ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { hexToRgb, palette, terminalAnsiHex } from '../../../../src/ink/theme';
import type {
  LocalTerminalRow,
  TerminalProfileRow,
  TerminalSessionRow,
  TerminalState,
  TerminalTargetRow,
} from '../../../desktop/src/contracts';
import { desktopHost } from '../host';
import { useTerminalState } from './useTerminalState';
import { Button } from '../components/ui';
import { t } from '../i18n';
import { claimTerminalKeyboard } from '../model/terminal-keyboard';

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

/** A console that is still there to use: connecting, ready, or held by someone. */
const isLive = (row: TerminalSessionRow) =>
  row.state === 'connecting' || row.state === 'ready' || !!row.held;

export interface DeviceTerminals {
  /** The desktop application is here to hold device consoles. */
  available: boolean;
  rows: TerminalSessionRow[];
  profiles: TerminalProfileRow[];
  /** A device whose host key must be trusted before the login goes on. */
  asking: TerminalState['pendingKey'];
  /** A console Circle handed to the person. */
  handoff: TerminalState['handoff'];
  /** What Circle is doing in each of the person's own terminal tabs. */
  local: LocalTerminalRow[];
  /** Reach a saved device; the id of the console that opened. */
  connectProfile: (name: string) => Promise<string>;
  /** Reach a device by its address, without saving it; the id of the console. */
  connectTarget: (target: TerminalTargetRow) => Promise<string>;
  disconnect: (row: TerminalSessionRow) => void;
  attach: (row: TerminalSessionRow) => void;
  detach: (row: TerminalSessionRow) => void;
  /** Take one of the person's terminal tabs from Circle, or give it back. */
  takeTab: (row: LocalTerminalRow) => void;
  giveBackTab: (row: LocalTerminalRow) => void;
  /** End what Circle is doing in a tab, without taking it. */
  stopTab: (row: LocalTerminalRow) => void;
  answerHostKey: (decision: 'once' | 'always' | 'reject') => void;
}

export function useDeviceTerminals(sessionId: string): DeviceTerminals {
  const host = desktopHost();
  const state = useTerminalState(sessionId);
  const quiet = useCallback(() => {}, []);
  return {
    available: !!host,
    rows: (state?.sessions ?? []).filter(isLive),
    profiles: state?.profiles ?? [],
    asking: state?.pendingKey,
    handoff: state?.handoff,
    local: state?.local ?? [],
    connectProfile: async (name) => {
      const next = await host!.terminalConnect(sessionId, name);
      return next.sessions.at(-1)?.id ?? '';
    },
    connectTarget: async (target) => {
      const next = await host!.terminalConnectTarget(sessionId, target);
      return next.sessions.at(-1)?.id ?? '';
    },
    disconnect: (row) =>
      void host?.terminalDisconnect(sessionId, row.id).catch(quiet),
    attach: (row) => void host?.terminalAttach(sessionId, row.id).catch(quiet),
    detach: (row) => void host?.terminalDetach(sessionId, row.id).catch(quiet),
    takeTab: (row) => void host?.terminalAttach(sessionId, row.id).catch(quiet),
    giveBackTab: (row) =>
      void host?.terminalDetach(sessionId, row.id).catch(quiet),
    stopTab: (row) =>
      void host?.terminalStop?.(sessionId, row.id)?.catch(quiet),
    answerHostKey: (decision) =>
      void host?.terminalHostKey(sessionId, decision).catch(quiet),
  };
}

/** What a console says about itself, for its tab's tooltip. */
export function deviceStateWord(row: TerminalSessionRow): string {
  if (row.held === 'handoff') return t('Circle handed it to you');
  if (row.held === 'attach') return t('you have the terminal');
  if (row.state === 'connecting') return t('connecting');
  if (row.state === 'ready')
    return row.quiet < 1500
      ? t('the device is answering')
      : t('quiet {time}', { time: `${Math.round(row.quiet / 1000)}s` });
  return row.state === 'error' ? row.detail || t('failed') : t('closed');
}

/**
 * The screen of the selected console. One emulator serves every console: choosing
 * another repaints it from the recent raw stream, so it never waits for the device to
 * speak again to show where it stands. Typing is live only while you hold the console.
 */
export function DeviceSurface({
  sessionId,
  row,
  visible,
  refresh,
}: {
  sessionId: string;
  row: TerminalSessionRow | undefined;
  visible: boolean;
  /** Bumped to repaint the screen from the device's recent stream. */
  refresh?: number;
}) {
  const host = desktopHost();
  const activeId = row?.id ?? '';
  const screenRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | undefined>(undefined);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const holder = useRef({ activeId: '', held: '', sessionId });
  holder.current = { activeId, held: row?.held ?? '', sessionId };

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
    // What you type goes to the device you hold; nobody else's keystrokes move.
    term.onData((data) => {
      const now = holder.current;
      if (now.held && now.activeId)
        void desktopHost()?.terminalInput(now.sessionId, now.activeId, data);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sizeSoon = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // A hidden surface has no size to fit to.
        if (!el.clientWidth) return;
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
  }, [host, sessionId, activeId, refresh]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.disableStdin = !(row?.held ?? '');
  }, [row?.held]);

  // Showing the surface again fits it to the room it has now.
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => {
      if (screenRef.current?.clientWidth) fitRef.current?.fit();
    }, 0);
    return () => clearTimeout(timer);
  }, [visible]);

  return (
    <div
      className="device-screen"
      id={activeId ? `device-${activeId}` : undefined}
      hidden={!visible}
      ref={screenRef}
      onPointerDown={() => {
        const term = termRef.current;
        if (!term) return;
        claimTerminalKeyboard(
          () => {
            if (termRef.current === term) term.focus();
          },
          (text) => {
            if (termRef.current === term) term.input(text, true);
          },
        );
      }}
    />
  );
}

/**
 * What a device asks of you outside its screen: to trust a host key before the login goes
 * on, and the console Circle handed to you. A tab of yours that Circle handed over says why.
 */
export function DeviceNotices({
  devices,
  row,
  tab,
  tabName,
}: {
  devices: DeviceTerminals;
  row: TerminalSessionRow | undefined;
  /** What Circle is doing in the tab in front, when that is a terminal tab of yours. */
  tab?: LocalTerminalRow;
  tabName?: string;
}) {
  const { asking, handoff } = devices;
  return (
    <>
      {tab?.held === 'handoff' && (
        <div className="terminal-handoff" role="status">
          <Hand size={14} />
          <span>
            {t('Circle hands you {name}', { name: tabName ?? '' })}
            {tab.reason ? `: ${tab.reason}` : ''}
          </span>
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
            <Button onClick={() => devices.answerHostKey('once')}>
              {t('connect once')}
            </Button>
            {asking.privateHost && (
              <Button onClick={() => devices.answerHostKey('always')}>
                {t('trust for good')}
              </Button>
            )}
            <Button onClick={() => devices.answerHostKey('reject')}>
              {t('reject')}
            </Button>
          </div>
        </div>
      )}
      {handoff && row && (
        <div className="terminal-handoff">
          <Hand size={14} />
          <span>
            {t('Circle hands you {name}', { name: handoff.session })}
            {handoff.reason ? `: ${handoff.reason}` : ''}
          </span>
          <Button onClick={() => devices.detach(row)}>{t('give back')}</Button>
        </div>
      )}
    </>
  );
}

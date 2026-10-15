import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { ArrowDown, ArrowUp, Copy, Plus, Square, X } from 'lucide-react';
import stripAnsi from 'strip-ansi';
import type {
  TerminalEvent,
  TerminalReplay,
  TerminalSnapshot,
} from '../../../desktop/src/workspace/terminal';
import { palette, mix, rgbToHex } from '../../../../src/ink/theme';
import { t, useLocale } from '../i18n';
import { copyText } from '../host';
import {
  acceptTerminalEvent,
  mergeTerminalSnapshot,
  readTerminalOutput,
} from '../model/terminal-stream';
import { subscribeWorkspace, workspaceCall } from '../model/workspace-client';
import { Button, IconButton } from './ui';
import '@xterm/xterm/css/xterm.css';
import '../styles/terminal.css';

type Controls = {
  search: (text: string, previous: boolean) => boolean;
  focus: () => void;
  selection: () => string;
};

function status(snapshot: TerminalSnapshot): string {
  switch (snapshot.status) {
    case 'running':
      return t('running');
    case 'stopping':
      return t('stopping');
    case 'exited':
      return snapshot.signal
        ? t('ended by signal {signal}', { signal: snapshot.signal })
        : t('exit {code}', { code: snapshot.exitCode ?? 0 });
    case 'failed':
      return t('failed');
    case 'interrupted':
      return t('interrupted');
  }
}

/** Keep mounted across layouts. Hidden terminal views retain their screen and scroll. */
export function NativeTerminal({
  sessionId,
  active = true,
}: {
  sessionId: string;
  active?: boolean;
}) {
  useLocale();
  const [terminals, setTerminals] = useState<TerminalSnapshot[]>([]);
  const [selectedBySession, setSelected] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<
    Record<string, { busy?: boolean; error?: string; notice?: string }>
  >({});
  const busy = operations[sessionId]?.busy ?? false;
  const error = operations[sessionId]?.error ?? '';
  const notice = operations[sessionId]?.notice ?? '';
  const [opened, setOpened] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(true);
  const [reload, setReload] = useState(0);
  const controls = useRef(new Map<string, Controls>());
  const focusTarget = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const selectedId = selectedBySession[sessionId];
  const visible = terminals.filter((item) => item.sessionId === sessionId);
  const selected =
    visible.find((item) => item.id === selectedId) ?? visible.at(-1);

  const adopt = useCallback((snapshot: TerminalSnapshot) => {
    setTerminals((current) => mergeTerminalSnapshot(current, snapshot));
  }, []);

  useEffect(() => {
    if (!selected?.id) return;
    setOpened((previous) =>
      [...previous.filter((id) => id !== selected.id), selected.id].slice(-8),
    );
    if (active && focusTarget.current === selected.id) {
      controls.current.get(selected.id)?.focus();
    }
  }, [selected?.id, active]);

  useEffect(() => {
    let cancelled = false;
    setOperations((previous) => ({
      ...previous,
      [sessionId]: { ...previous[sessionId], error: '' },
    }));
    if (!sessionId) return;
    void workspaceCall<TerminalSnapshot[]>(sessionId, 'terminal', 'list')
      .then((items) => {
        if (cancelled) return;
        setTerminals((previous) => [
          ...previous.filter((item) => item.sessionId !== sessionId),
          ...items,
        ]);
        setSelected((previous) => ({
          ...previous,
          [sessionId]:
            items.find((item) => item.id === previous[sessionId])?.id ??
            items.at(-1)?.id ??
            '',
        }));
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setOperations((previous) => ({
            ...previous,
            [sessionId]: {
              ...previous[sessionId],
              error: String(reason instanceof Error ? reason.message : reason),
            },
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reload]);

  useEffect(
    () =>
      subscribeWorkspace((event) => {
        if (event.service !== 'terminal') return;
        const update = event.data as unknown as TerminalEvent;
        if (update.snapshot) adopt(update.snapshot);
      }),
    [adopt],
  );

  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    const target = sessionId;
    setOperations((previous) => ({ ...previous, [target]: { busy: true } }));
    try {
      await action();
    } catch (reason) {
      setOperations((previous) => ({
        ...previous,
        [target]: {
          ...previous[target],
          error: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    } finally {
      setOperations((previous) => ({
        ...previous,
        [target]: { ...previous[target], busy: false },
      }));
    }
  };

  const create = () =>
    run(async () => {
      const capturedSession = sessionId;
      const snapshot = await workspaceCall<TerminalSnapshot>(
        capturedSession,
        'terminal',
        'create',
      );
      focusTarget.current = snapshot.id;
      adopt(snapshot);
      setSelected((previous) => ({
        ...previous,
        [capturedSession]: snapshot.id,
      }));
    });

  const copyAll = () =>
    run(async () => {
      if (!selected) return;
      const captured = selected;
      const output = await readTerminalOutput(captured.id, (afterSequence) =>
        workspaceCall<TerminalReplay>(
          captured.sessionId,
          'terminal',
          'replay',
          { id: captured.id, afterSequence, limit: 512 },
        ),
      );
      await copyText(stripAnsi(output));
      setOperations((previous) => ({
        ...previous,
        [captured.sessionId]: {
          ...previous[captured.sessionId],
          notice: t('complete terminal output copied'),
        },
      }));
    });

  const find = (previous: boolean) => {
    if (!selected || !query) return;
    setFound(
      controls.current.get(selected.id)?.search(query, previous) ?? false,
    );
  };

  return (
    <section
      className="native-terminal"
      aria-label={t('interactive terminal')}
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'f'
        ) {
          event.preventDefault();
          event.stopPropagation();
          searchInput.current?.focus();
        }
      }}
    >
      <div className="native-terminal-toolbar">
        <div
          className="native-terminal-tabs"
          role="tablist"
          aria-label={t('terminal tabs')}
        >
          {visible.map((item, index) => (
            <button
              key={item.id}
              role="tab"
              type="button"
              aria-selected={item.id === selected?.id}
              aria-controls={`terminal-${item.id}`}
              title={`${item.cwd} · ${status(item)}`}
              onClick={() => {
                focusTarget.current = item.id;
                setSelected((previous) => ({
                  ...previous,
                  [sessionId]: item.id,
                }));
              }}
            >
              <span
                className={`native-terminal-lamp ${item.status}`}
                aria-hidden="true"
              />
              {item.label} {index + 1}
            </button>
          ))}
        </div>
        <IconButton
          label={t('new terminal')}
          disabled={busy || !sessionId}
          onClick={create}
        >
          <Plus size={15} />
        </IconButton>
        <IconButton
          label={t('interrupt command')}
          disabled={busy || selected?.status !== 'running'}
          onClick={() =>
            run(async () => {
              if (selected)
                adopt(
                  await workspaceCall<TerminalSnapshot>(
                    selected.sessionId,
                    'terminal',
                    'signal',
                    { id: selected.id, signal: 'SIGINT' },
                  ),
                );
            })
          }
        >
          <Square size={13} />
        </IconButton>
        <IconButton
          label={t('stop terminal')}
          disabled={
            busy ||
            !selected ||
            !['running', 'stopping'].includes(selected.status)
          }
          onClick={() =>
            run(async () => {
              if (selected)
                adopt(
                  await workspaceCall<TerminalSnapshot>(
                    selected.sessionId,
                    'terminal',
                    'close',
                    { id: selected.id },
                  ),
                );
            })
          }
        >
          <X size={15} />
        </IconButton>
        <IconButton
          label={t('copy complete output')}
          disabled={busy || !selected}
          onClick={copyAll}
        >
          <Copy size={14} />
        </IconButton>
      </div>
      {selected && (
        <div className="native-terminal-search">
          <input
            ref={searchInput}
            aria-label={t('find in terminal')}
            placeholder={t('find in terminal')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setFound(true);
            }}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                find(event.shiftKey);
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                controls.current.get(selected.id)?.focus();
              }
            }}
          />
          <IconButton
            label={t('previous match')}
            disabled={!query}
            onClick={() => find(true)}
          >
            <ArrowUp size={14} />
          </IconButton>
          <IconButton
            label={t('next match')}
            disabled={!query}
            onClick={() => find(false)}
          >
            <ArrowDown size={14} />
          </IconButton>
          {!found && <span role="status">{t('no matches')}</span>}
        </div>
      )}
      {error && (
        <div className="native-terminal-error" role="alert">
          <span>{error}</span>
          <Button onClick={() => setReload((value) => value + 1)}>
            {t('retry')}
          </Button>
        </div>
      )}
      {!selected && !error && (
        <div className="native-terminal-empty">
          <p>{t('run commands here while agents keep working')}</p>
          <Button disabled={busy || !sessionId} onClick={create}>
            {t('new terminal')}
          </Button>
        </div>
      )}
      <div className="native-terminal-surfaces">
        {terminals
          .filter((item) => opened.includes(item.id))
          .map((item) => (
            <TerminalSurface
              key={item.id}
              snapshot={item}
              active={
                active &&
                item.id === selected?.id &&
                item.sessionId === sessionId
              }
              visible={item.id === selected?.id && item.sessionId === sessionId}
              adopt={adopt}
              register={(value) => {
                if (value) {
                  controls.current.set(item.id, value);
                  if (
                    focusTarget.current === item.id &&
                    active &&
                    selected?.id === item.id
                  )
                    value.focus();
                } else controls.current.delete(item.id);
              }}
            />
          ))}
      </div>
      {selected && (
        <div className="native-terminal-status" role="status">
          <span title={selected.cwd}>{selected.cwd}</span>
          <span>{status(selected)}</span>
          {notice && <span>{notice}</span>}
        </div>
      )}
    </section>
  );
}

function TerminalSurface({
  snapshot,
  active,
  visible,
  adopt,
  register,
}: {
  snapshot: TerminalSnapshot;
  active: boolean;
  visible: boolean;
  adopt: (snapshot: TerminalSnapshot) => void;
  register: (controls?: Controls) => void;
}) {
  const language = useLocale();
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);
  const synchronizeRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const statusRef = useRef(snapshot.status);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  activeRef.current = active;
  statusRef.current = snapshot.status;

  useEffect(() => {
    if (!container.current) return;
    localizeTerminal();
    const terminal = new Terminal({
      cursorBlink: true,
      screenReaderMode: true,
      scrollback: 10000,
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue('--mono')
        .trim(),
      fontSize:
        Number.parseFloat(
          getComputedStyle(document.documentElement).getPropertyValue(
            '--code-size',
          ),
        ) || 13,
      theme: terminalTheme(),
      disableStdin: snapshot.status !== 'running',
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(container.current);
    instance.current = { terminal, fit };
    register({
      search: (text, previous) =>
        previous ? search.findPrevious(text) : search.findNext(text),
      focus: () => terminal.focus(),
      selection: () => terminal.getSelection(),
    });
    let cancelled = false;
    let syncing = false;
    let dirty = false;
    let cursor = 0;
    let sendInput = Promise.resolve();
    const showError = (reason: unknown) => {
      if (!cancelled)
        setError(reason instanceof Error ? reason.message : String(reason));
    };
    const synchronize = async () => {
      dirty = true;
      if (syncing || cancelled || !activeRef.current) return;
      syncing = true;
      try {
        do {
          dirty = false;
          let more: boolean;
          do {
            const page = await workspaceCall<TerminalReplay>(
              snapshot.sessionId,
              'terminal',
              'replay',
              { id: snapshot.id, afterSequence: cursor, limit: 128 },
            );
            if (cancelled) return;
            for (const event of page.events) {
              const next = acceptTerminalEvent(snapshot.id, cursor, event);
              if (next === cursor) continue;
              if (event.kind === 'data' && event.data)
                await new Promise<void>((resolve) =>
                  terminal.write(event.data!, resolve),
                );
              cursor = next;
            }
            adopt(page.snapshot);
            more = page.hasMore;
          } while (more && !cancelled && activeRef.current);
        } while (dirty && !cancelled && activeRef.current);
      } catch (reason) {
        showError(reason);
      } finally {
        syncing = false;
      }
    };
    const unsubscribe = subscribeWorkspace((event) => {
      if (
        event.service === 'terminal' &&
        event.resourceId === snapshot.id &&
        event.sessionId === snapshot.sessionId
      )
        void synchronize();
    });
    synchronizeRef.current = () => {
      void synchronize();
    };
    void synchronize();
    const input = terminal.onData((data) => {
      if (statusRef.current !== 'running') return;
      sendInput = sendInput
        .then(async () => {
          await workspaceCall(snapshot.sessionId, 'terminal', 'write', {
            id: snapshot.id,
            data,
          });
        })
        .catch(showError);
    });
    const dimensions = terminal.onResize(({ cols, rows }) => {
      if (statusRef.current !== 'running') return;
      void workspaceCall(snapshot.sessionId, 'terminal', 'resize', {
        id: snapshot.id,
        cols,
        rows,
      }).catch(showError);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      if (
        event.type === 'keydown' &&
        (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        event.key.toLowerCase() === 'c' &&
        terminal.hasSelection()
      ) {
        event.preventDefault();
        void copyText(terminal.getSelection()).catch(showError);
        return false;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f')
        return false;
      return true;
    });
    const resize = new ResizeObserver(() => {
      if (
        container.current?.clientWidth &&
        container.current.clientHeight &&
        activeRef.current
      )
        fit.fit();
    });
    resize.observe(container.current);
    const theme = new MutationObserver(() => {
      terminal.options.theme = terminalTheme();
      const fontSize = Number.parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue(
          '--code-size',
        ),
      );
      if (fontSize) terminal.options.fontSize = fontSize;
      if (activeRef.current) fit.fit();
    });
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    });
    return () => {
      cancelled = true;
      unsubscribe();
      input.dispose();
      dimensions.dispose();
      resize.disconnect();
      theme.disconnect();
      register();
      terminal.dispose();
      instance.current = null;
      synchronizeRef.current = null;
      // A view closing never closes its PTY. It can be reopened through list/replay.
    };
    // Identity alone owns this view; status updates must not recreate its screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.id, snapshot.sessionId, retry]);

  useEffect(() => {
    if (active && instance.current && container.current?.clientWidth) {
      instance.current.fit.fit();
      synchronizeRef.current?.();
    }
  }, [active, visible]);
  useEffect(() => {
    if (instance.current)
      instance.current.terminal.options.disableStdin =
        snapshot.status !== 'running';
  }, [snapshot.status]);
  useEffect(() => {
    localizeTerminal();
    container.current
      ?.querySelector('.xterm-helper-textarea')
      ?.setAttribute('aria-label', t('terminal input'));
  }, [language]);

  return (
    <div
      id={`terminal-${snapshot.id}`}
      className="native-terminal-surface"
      role="tabpanel"
      aria-label={snapshot.label}
      hidden={!visible}
    >
      {error && (
        <div className="native-terminal-error" role="alert">
          <span>{error}</span>
          <Button
            onClick={() => {
              setError('');
              setRetry((value) => value + 1);
            }}
          >
            {t('retry output')}
          </Button>
        </div>
      )}
      <div ref={container} className="native-terminal-screen" />
    </div>
  );
}

function localizeTerminal() {
  Terminal.strings.promptLabel = t('terminal input');
  Terminal.strings.tooMuchOutput = t(
    'more terminal output is available; navigate the terminal to read it',
  );
}

function terminalTheme() {
  const p = palette();
  const color = (index: number) => rgbToHex(p.rainbow_stops[index]![1]);
  return {
    background: p.bg_hex,
    foreground: p.fg_hex,
    cursor: p.fg_hex,
    cursorAccent: p.bg_hex,
    selectionBackground: mix(p.bg_hex, p.fg_hex, 0.24),
    black: p.bg_hex,
    red: color(2),
    green: color(0),
    yellow: color(3),
    blue: color(5),
    magenta: color(1),
    cyan: color(4),
    white: p.fg_hex,
    brightBlack: mix(p.fg_hex, p.bg_hex, 0.39),
    brightRed: color(2),
    brightGreen: color(0),
    brightYellow: color(3),
    brightBlue: color(5),
    brightMagenta: color(1),
    brightCyan: color(4),
    brightWhite: p.fg_hex,
  };
}

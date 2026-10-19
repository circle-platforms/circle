import { useTerminalScreenReader } from '../terminal-accessibility';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Copy,
  MessageSquarePlus,
  Plus,
  Play,
  RotateCcw,
  Search,
  Square,
  X,
} from 'lucide-react';
import { ContextMenu } from 'radix-ui';
import stripAnsi from 'strip-ansi';
import type {
  TerminalEvent,
  TerminalReplay,
  TerminalSnapshot,
} from '../../../desktop/src/workspace/terminal';
import { terminalTheme } from '../model/terminal-theme';
import {
  extraExitReason,
  folderName,
  processDetails,
  status,
} from '../model/terminal-status';
import { t, useLocale } from '../i18n';
import { copyText } from '../host';
import {
  acceptTerminalEvent,
  mergeTerminalSnapshot,
  readTerminalOutput,
  terminalInputChunks,
} from '../model/terminal-stream';
import {
  subscribeWorkspace,
  workspaceCall,
  connectWorkspaceStreams,
} from '../model/workspace-client';
import type { CommandTerminalCapabilities } from '../command-terminal-target';
import {
  commandTerminalRequest,
  type CommandTerminalView,
  type TerminalRequest,
} from '../model/command-terminal-client';
import type { TerminalSelectionCapture } from '../model/terminal-context';
import { Button, IconButton, Modal, Status } from './common';
import '@xterm/xterm/css/xterm.css';
import '../styles/terminal.css';

type Controls = {
  search: (
    text: string,
    previous: boolean,
    isCurrent: () => boolean,
  ) => Promise<boolean | undefined>;
  focus: () => void;
  selection: () => string;
  captureSelection: () => TerminalSelectionCapture | undefined;
};

type TerminalTiming = {
  terminalId: string;
  phase:
    | 'replay-request'
    | 'replay-response'
    | 'write-enqueued'
    | 'write-parsed'
    | 'write-frame'
    | 'view-active'
    | 'view-inactive';
  at: number;
  eventSequence?: number;
  cursor?: number;
  afterSequence?: number;
  viewInstanceId?: string;
  visibilityEpoch?: number;
};
type TimingVisibility = { active: boolean; epoch: number; instanceId?: string };

/** Explicit test instrumentation: metadata only, with no work when no sink is installed. */
function recordTerminalTiming(
  terminalId: string,
  phase: TerminalTiming['phase'],
  visibility: TimingVisibility,
  eventSequence?: number,
  cursor?: number,
  afterSequence?: number,
): boolean {
  const sink = (
    window as Window & {
      __circleNativeTerminalTiming?: (record: TerminalTiming) => void;
    }
  ).__circleNativeTerminalTiming;
  if (typeof sink !== 'function') return false;
  try {
    visibility.instanceId ??= crypto.randomUUID();
    sink({
      terminalId,
      phase,
      at: Date.now(),
      eventSequence,
      cursor,
      afterSequence,
      viewInstanceId: visibility.instanceId,
      visibilityEpoch: visibility.epoch,
    });
  } catch {
    // An optional test observer must never affect terminal input or output.
  }
  return true;
}

/** Keep mounted while the Inspector is hidden. Its PTYs and reading position persist. */
export function NativeTerminal({
  sessionId: parentSessionId,
  commandTerminal,
  onExitCommandTerminal,
  focusRequest,
  active = true,
  embedded = false,
  onAddToDraft,
}: {
  sessionId: string;
  commandTerminal?: CommandTerminalView;
  onExitCommandTerminal?: () => void;
  focusRequest?: { id: string; epoch: string; requestId: string };
  active?: boolean;
  embedded?: boolean;
  onAddToDraft?: (capture: TerminalSelectionCapture) => Promise<void>;
}) {
  useLocale();
  const sessionId =
    commandTerminal?.resolved.target.executionSessionId ?? parentSessionId;
  const commandKey = commandTerminal
    ? JSON.stringify([
        commandTerminal.viewSessionId,
        commandTerminal.requestId,
        commandTerminal.resolved.target,
      ])
    : '';
  const [commandCapabilities, setCommandCapabilities] = useState<{
    key: string;
    value: CommandTerminalCapabilities;
  }>();
  const capabilities =
    commandCapabilities?.key === commandKey
      ? commandCapabilities.value
      : commandTerminal?.resolved.capabilities;
  const terminalRequest: TerminalRequest = useMemo(
    () =>
      commandTerminal
        ? commandTerminalRequest(
            commandTerminal.viewSessionId,
            commandTerminal.resolved.target,
            (value) =>
              setCommandCapabilities((previous) =>
                previous?.key === commandKey &&
                previous.value.input === value.input &&
                previous.value.stop === value.stop &&
                previous.value.addToDraft === value.addToDraft
                  ? previous
                  : { key: commandKey, value },
              ),
          )
        : <T,>(method: string, params: Record<string, unknown> = {}) =>
            workspaceCall<T>(sessionId, 'terminal', method, params),
    [commandKey, sessionId],
  );
  useEffect(() => {
    if (!commandTerminal) return;
    return connectWorkspaceStreams(
      commandTerminal.resolved.workspaceId,
      sessionId,
    );
  }, [commandKey, sessionId]);
  const focusOwner = useRef<
    { requestId: string; sessionId: string } | undefined
  >(undefined);
  const focusSession = useRef(sessionId);
  if (focusSession.current !== sessionId) {
    focusSession.current = sessionId;
    // Leaving a session permanently cancels its old focus request, including
    // if the user later returns with the same prop still present.
    if (focusOwner.current) focusOwner.current.sessionId = '';
  }
  if (focusRequest && focusOwner.current?.requestId !== focusRequest.requestId)
    focusOwner.current = { requestId: focusRequest.requestId, sessionId };
  const requestedFocus =
    !commandTerminal && focusOwner.current?.sessionId === sessionId
      ? focusRequest
      : undefined;
  const focusKey = requestedFocus ? JSON.stringify(requestedFocus) : '';
  const [terminals, setTerminals] = useState<TerminalSnapshot[]>([]);
  const [selectedBySession, setSelected] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<
    Record<string, { busy?: boolean; error?: string; notice?: string }>
  >({});
  const busy = operations[sessionId]?.busy ?? false;
  const error = operations[sessionId]?.error ?? '';
  const disconnected =
    error.includes('native workspace services are not connected') ||
    error.includes('runtime not enabled');
  const notice = operations[sessionId]?.notice ?? '';
  const [opened, setOpened] = useState<string[]>([]);
  const [orderBySession, setOrderBySession] = useState<
    Record<string, string[]>
  >({});
  // Consoles the person stopped, or that a restart replaced, leave the strip.
  // One that ended by itself stays, with its exit reason, until its tab is closed.
  const [hiddenBySession, setHiddenBySession] = useState<
    Record<string, string[]>
  >({});
  const [renameFor, setRenameFor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const dragId = useRef<string | null>(null);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const focusSearch = useRef(false);
  const searchRequest = useRef(0);
  const currentSearch = useRef({ sessionId, query, selectedId: '' });
  const [reload, setReload] = useState(0);
  const [serviceOpen, setServiceOpen] = useState(false);
  const [serviceName, setServiceName] = useState('');
  const [serviceFile, setServiceFile] = useState('npm');
  const [serviceArgs, setServiceArgs] = useState(['run', 'dev']);
  const [serviceCwd, setServiceCwd] = useState('.');
  const [servicePort, setServicePort] = useState('');
  const [servicePattern, setServicePattern] = useState('');
  const controls = useRef(new Map<string, Controls>());
  const [hasSelection, setHasSelection] = useState<Record<string, boolean>>({});
  const focusTarget = useRef<string | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const tabStrip = useRef<HTMLDivElement>(null);
  const selectedId = selectedBySession[sessionId];
  // A tab is a live console. One whose process is gone is finished: its output
  // stays in the command history, where its place can be taken again.
  const live = (item: TerminalSnapshot) =>
    ['running', 'stopping'].includes(item.status);
  const sessionTerminals = terminals.filter(
    (item) =>
      item.sessionId === sessionId &&
      (!commandTerminal ||
        (item.id === commandTerminal.resolved.target.terminal.id &&
          item.epoch === commandTerminal.resolved.target.terminal.epoch)),
  );
  const order = orderBySession[sessionId] ?? [];
  const orderPosition = (id: string) => {
    const at = order.indexOf(id);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  const hidden = hiddenBySession[sessionId] ?? [];
  const visible = sessionTerminals
    .filter((item) => commandTerminal || !hidden.includes(item.id))
    .sort((a, b) => orderPosition(a.id) - orderPosition(b.id));
  const selected =
    visible.find((item) => item.id === selectedId) ?? visible.at(-1);
  const displayedCommand =
    selected?.managedCommand?.displayCommand ??
    (selected?.command
      ? [
          selected.command.file,
          ...(selected.command.args ?? []).map((arg) =>
            /\s/.test(arg) ? JSON.stringify(arg) : arg,
          ),
        ].join(' ')
      : undefined);
  currentSearch.current = { sessionId, query, selectedId: selected?.id ?? '' };
  const tabOrder = visible.map((item) => item.id).join('\n');
  useLayoutEffect(() => {
    const strip = tabStrip.current;
    if (!active || !strip) return;
    const reveal = () => {
      if (!strip.clientWidth) return;
      const tab = strip.querySelector<HTMLButtonElement>(
        '[aria-selected="true"]',
      );
      if (!tab) return;
      const viewport = strip.getBoundingClientRect();
      const item = tab.getBoundingClientRect();
      const left = viewport.left + strip.clientLeft;
      const right = left + strip.clientWidth;
      // Adjust only this horizontal scroller. scrollIntoView could move the
      // Inspector or conversation and disrupt the developer's reading position.
      if (item.width > strip.clientWidth) strip.scrollLeft += item.left - left;
      else if (item.left < left) strip.scrollLeft += item.left - left;
      else if (item.right > right) strip.scrollLeft += item.right - right;
    };
    reveal();
    let width = strip.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = strip.clientWidth;
      if (next !== width) {
        width = next;
        reveal();
      }
    });
    observer.observe(strip);
    return () => observer.disconnect();
    // Output/status updates retain the same identity/order and must not undo
    // the user's manual horizontal browsing of terminal history.
  }, [active, sessionId, selected?.id, tabOrder]);

  useEffect(() => {
    searchRequest.current++;
    setFound(true);
    return () => {
      searchRequest.current++;
    };
  }, [sessionId, selected?.id]);

  const adopt = useCallback((snapshot: TerminalSnapshot) => {
    setTerminals((current) => mergeTerminalSnapshot(current, snapshot));
    // A restart replaces its predecessor in the same tab position.
    if (snapshot.restartOf)
      setHiddenBySession((previous) => ({
        ...previous,
        [snapshot.sessionId]: [
          ...new Set([
            ...(previous[snapshot.sessionId] ?? []),
            snapshot.restartOf as string,
          ]),
        ],
      }));
    if (snapshot.restartOf)
      setOrderBySession((previous) => {
        if (previous[snapshot.sessionId]?.includes(snapshot.id))
          return previous;
        const list = [...(previous[snapshot.sessionId] ?? [])];
        const at = list.indexOf(snapshot.restartOf as string);
        if (at === -1) list.push(snapshot.id);
        else list.splice(at, 1, snapshot.id);
        return { ...previous, [snapshot.sessionId]: list };
      });
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
    setServiceOpen(false);
    setOperations((previous) => ({
      ...previous,
      [sessionId]: { ...previous[sessionId], error: '' },
    }));
    if (!sessionId) return;
    void terminalRequest<TerminalSnapshot[]>('list')
      .then((items) => {
        if (cancelled) return;
        if (commandTerminal) {
          const target = commandTerminal.resolved.target;
          if (
            items.length !== 1 ||
            items[0].id !== target.terminal.id ||
            items[0].epoch !== target.terminal.epoch ||
            items[0].sessionId !== target.executionSessionId
          )
            throw Error(t('command terminal source changed; open it again'));
          focusTarget.current = target.terminal.id;
        }
        const requested = requestedFocus
          ? items.find(
              (item) =>
                item.id === requestedFocus.id &&
                item.epoch === requestedFocus.epoch &&
                item.sessionId === sessionId,
            )
          : undefined;
        if (requestedFocus && !requested) {
          focusTarget.current = null;
          throw Error(t('terminal is no longer available'));
        }
        if (requested) {
          focusTarget.current = requested.id;
          if (active) controls.current.get(requested.id)?.focus();
        }
        setTerminals((previous) => [
          ...previous.filter((item) => item.sessionId !== sessionId),
          ...items,
        ]);
        setSelected((previous) => ({
          ...previous,
          [sessionId]:
            requested?.id ??
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
  }, [sessionId, reload, terminalRequest, focusKey]);

  useEffect(
    () =>
      subscribeWorkspace((event) => {
        if (event.service !== 'terminal') return;
        if (
          commandTerminal &&
          (event.sessionId !== sessionId ||
            event.resourceId !== commandTerminal.resolved.target.terminal.id)
        )
          return;
        const update = event.data as unknown as TerminalEvent;
        if (update.snapshot) adopt(update.snapshot);
      }),
    [adopt, commandKey, sessionId],
  );

  // Stopping waits for the shell's console to close, which takes seconds on
  // Windows; only the terminal being stopped waits, not the rest of the panel.
  const [stopping, setStopping] = useState<string[]>([]);
  const stopTerminal = async (id: string) => {
    if (stopping.includes(id)) return;
    const target = sessionId;
    setStopping((previous) => [...previous, id]);
    try {
      adopt(await terminalRequest<TerminalSnapshot>('close', { id }));
      // A stopped console leaves the strip; the history keeps its output.
      dismiss(id);
    } catch (reason) {
      setOperations((previous) => ({
        ...previous,
        [target]: {
          ...previous[target],
          error: reason instanceof Error ? reason.message : String(reason),
        },
      }));
    } finally {
      setStopping((previous) => previous.filter((item) => item !== id));
    }
  };
  const selectTerminal = (id: string) => {
    focusTarget.current = id;
    setSelected((previous) => ({ ...previous, [sessionId]: id }));
  };
  const moveTab = (from: string, to: string) => {
    const ids = visible.map((item) => item.id).filter((id) => id !== from);
    const at = ids.indexOf(to);
    ids.splice(at === -1 ? ids.length : at, 0, from);
    setOrderBySession((previous) => ({ ...previous, [sessionId]: ids }));
  };
  const dismiss = (id: string) => {
    setHiddenBySession((previous) => ({
      ...previous,
      [sessionId]: [...new Set([...(previous[sessionId] ?? []), id])],
    }));
    setOrderBySession((previous) => ({
      ...previous,
      [sessionId]: (previous[sessionId] ?? []).filter((item) => item !== id),
    }));
    setSelected((previous) =>
      previous[sessionId] === id ? { ...previous, [sessionId]: '' } : previous,
    );
  };
  const closeTab = async (id: string) => {
    const item = terminals.find((entry) => entry.id === id);
    if (item && live(item)) await stopTerminal(id);
    else dismiss(id);
  };
  const closeMany = (ids: string[]) =>
    run(async () => {
      await Promise.all(ids.map((id) => closeTab(id)));
    });
  const openRename = (id: string) => {
    setRenameValue(terminals.find((item) => item.id === id)?.label ?? '');
    setRenameFor(id);
  };
  const applyRename = () =>
    run(async () => {
      const target = renameFor;
      if (!target) return;
      adopt(
        await terminalRequest<TerminalSnapshot>('rename', {
          id: target,
          label: renameValue,
        }),
      );
      setRenameFor(null);
    });

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

  const createService = () =>
    run(async () => {
      const capturedSession = sessionId;
      const readiness =
        servicePort || servicePattern
          ? {
              ...(servicePort ? { port: Number(servicePort) } : {}),
              ...(servicePattern ? { pattern: servicePattern } : {}),
            }
          : undefined;
      const snapshot = await workspaceCall<TerminalSnapshot>(
        capturedSession,
        'terminal',
        'create',
        {
          label:
            serviceName.trim() ||
            [serviceFile, ...serviceArgs].join(' ').slice(0, 200),
          cwd: serviceCwd || '.',
          command: { file: serviceFile, args: serviceArgs },
          ...(readiness ? { readiness } : {}),
        },
      );
      focusTarget.current = snapshot.id;
      adopt(snapshot);
      setSelected((previous) => ({
        ...previous,
        [capturedSession]: snapshot.id,
      }));
      setServiceOpen(false);
    });

  const restart = () =>
    run(async () => {
      if (!selected) return;
      const snapshot = await terminalRequest<TerminalSnapshot>('restart', {
        id: selected.id,
      });
      focusTarget.current = snapshot.id;
      adopt(snapshot);
      setSelected((previous) => ({
        ...previous,
        [snapshot.sessionId]: snapshot.id,
      }));
    });

  const copyAll = () =>
    run(async () => {
      if (!selected) return;
      const captured = selected;
      const output = await readTerminalOutput(captured.id, (afterSequence) =>
        terminalRequest<TerminalReplay>('replay', {
          id: captured.id,
          afterSequence,
          limit: 512,
        }),
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

  const addToDraft = () => {
    // Capture synchronously before a toolbar click or later output changes the
    // current selection. The draft callback binds this exact originating session.
    const capture =
      selected && controls.current.get(selected.id)?.captureSelection();
    void run(async () => {
      if (!capture || !onAddToDraft)
        throw Error(t('select terminal output first'));
      await onAddToDraft(capture);
      setOperations((previous) => ({
        ...previous,
        [capture.sourceSessionId]: {
          ...previous[capture.sourceSessionId],
          notice: t('terminal selection added to draft'),
        },
      }));
    });
  };

  const find = async (previous: boolean) => {
    if (!selected || !query) return;
    const target = { sessionId, query, selectedId: selected.id };
    const request = ++searchRequest.current;
    const current = () =>
      request === searchRequest.current &&
      currentSearch.current.sessionId === target.sessionId &&
      currentSearch.current.selectedId === target.selectedId &&
      currentSearch.current.query === target.query;
    setFound(true);
    try {
      const result = await controls.current
        .get(selected.id)
        ?.search(query, previous, current);
      if (current() && result !== undefined) setFound(result);
    } catch (reason) {
      if (current())
        setOperations((previous) => ({
          ...previous,
          [target.sessionId]: {
            ...previous[target.sessionId],
            error: reason instanceof Error ? reason.message : String(reason),
          },
        }));
    }
  };

  const openSearchRef = useRef(() => {});
  const openSearch = () => {
    if (searchInput.current) {
      searchInput.current.focus();
      searchInput.current.select();
      return;
    }
    focusSearch.current = true;
    setSearchOpen(true);
  };
  openSearchRef.current = openSearch;
  const closeSearch = () => {
    searchRequest.current++;
    setSearchOpen(false);
    setQuery('');
    setFound(true);
    if (selected) controls.current.get(selected.id)?.focus();
  };

  return (
    <section
      className={`native-terminal${embedded ? ' embedded' : ''}`}
      aria-label={t('interactive terminal')}
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'f'
        ) {
          event.preventDefault();
          event.stopPropagation();
          openSearch();
        }
      }}
    >
      <div className="native-terminal-toolbar">
        {commandTerminal && onExitCommandTerminal && (
          <IconButton
            label={t('session terminals')}
            onClick={onExitCommandTerminal}
          >
            <ArrowLeft size={14} />
          </IconButton>
        )}
        {!visible.length && (
          <span className="native-terminal-title">{t('terminal')}</span>
        )}
        <div
          className="native-terminal-tabs segmented"
          ref={tabStrip}
          role="tablist"
          aria-label={t('terminal tabs')}
        >
          {visible.map((item, index) => (
            <ContextMenu.Root key={item.id}>
              <ContextMenu.Trigger asChild>
                <div
                  className={`native-terminal-tab${
                    item.id === selected?.id ? ' active' : ''
                  }`}
                  draggable={!commandTerminal}
                  onDragStart={(event) => {
                    dragId.current = item.id;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', item.id);
                  }}
                  onDragEnd={() => {
                    dragId.current = null;
                  }}
                  onDragOver={(event) => {
                    if (!dragId.current || dragId.current === item.id) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    const from = dragId.current;
                    dragId.current = null;
                    if (!from || from === item.id) return;
                    event.preventDefault();
                    moveTab(from, item.id);
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={item.id === selected?.id}
                    aria-controls={`terminal-${item.id}`}
                    className={item.id === selected?.id ? 'active' : ''}
                    tabIndex={item.id === selected?.id ? 0 : -1}
                    title={`${item.cwd} · ${status(item)}`}
                    onClick={() => selectTerminal(item.id)}
                    onKeyDown={(event) => {
                      const at = visible.findIndex(
                        (entry) => entry.id === item.id,
                      );
                      const targetIndex =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? visible.length - 1
                            : event.key === 'ArrowLeft'
                              ? (at + visible.length - 1) % visible.length
                              : event.key === 'ArrowRight'
                                ? (at + 1) % visible.length
                                : -1;
                      const next = visible[targetIndex];
                      if (!next) return;
                      event.preventDefault();
                      event.stopPropagation();
                      focusTarget.current = null;
                      selectTerminal(next.id);
                      tabStrip.current
                        ?.querySelector<HTMLElement>(
                          `[aria-controls="terminal-${next.id}"]`,
                        )
                        ?.focus();
                    }}
                  >
                    <span
                      className={`native-terminal-lamp ${item.serviceState ?? item.status}`}
                      aria-hidden="true"
                    />
                    <span className="native-terminal-tab-label">
                      {item.label} {index + 1}
                    </span>
                  </button>
                  {!commandTerminal && (
                    <button
                      type="button"
                      className="native-terminal-tab-close"
                      aria-label={t('close terminal tab {n}', {
                        n: index + 1,
                      })}
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeTab(item.id);
                      }}
                    >
                      <X size={12} />
                    </button>
                  )}
                </div>
              </ContextMenu.Trigger>
              {!commandTerminal && (
                <ContextMenu.Portal>
                  <ContextMenu.Content className="dropdown session-menu">
                    <ContextMenu.Item onSelect={() => openRename(item.id)}>
                      {t('rename…')}
                    </ContextMenu.Item>
                    <ContextMenu.Item onSelect={() => void closeTab(item.id)}>
                      {t('close')}
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      disabled={visible.length < 2}
                      onSelect={() =>
                        void closeMany(
                          visible
                            .filter((entry) => entry.id !== item.id)
                            .map((entry) => entry.id),
                        )
                      }
                    >
                      {t('close others')}
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      onSelect={() =>
                        void closeMany(visible.map((entry) => entry.id))
                      }
                    >
                      {t('close all')}
                    </ContextMenu.Item>
                    <ContextMenu.Separator className="dropdown-separator" />
                    <ContextMenu.Item onSelect={() => void create()}>
                      {t('new terminal')}
                    </ContextMenu.Item>
                  </ContextMenu.Content>
                </ContextMenu.Portal>
              )}
            </ContextMenu.Root>
          ))}
        </div>
        <IconButton
          label={t('new terminal')}
          disabled={busy || !sessionId || !!commandTerminal}
          onClick={create}
        >
          <Plus size={15} />
        </IconButton>
      </div>
      {selected && displayedCommand && (
        <div className="native-service-details">
          <code title={displayedCommand}>{displayedCommand}</code>
          {selected.readiness?.port && (
            <span>localhost:{selected.readiness.port}</span>
          )}
          {selected.readiness?.pattern && (
            <span title={selected.readiness.pattern}>
              {t('ready log text')}: {selected.readiness.pattern}
            </span>
          )}
        </div>
      )}
      {error && !serviceOpen && (
        <div className="native-terminal-error" role="alert">
          <span>{disconnected ? t('not connected') : error}</span>
          <Button onClick={() => setReload((value) => value + 1)}>
            {t('retry')}
          </Button>
          {disconnected && (
            <details className="native-terminal-error-details">
              <summary>{t('error details')}</summary>
              <pre tabIndex={0}>{error}</pre>
            </details>
          )}
        </div>
      )}
      {selected?.readiness?.error && (
        <div className="native-terminal-error" role="alert">
          {selected.readiness.error}
        </div>
      )}
      {selected?.error && (
        <div className="native-terminal-error" role="alert">
          {selected.error}
        </div>
      )}
      {!selected && !error && (
        <div className="native-terminal-empty">
          <p>{t('run commands here while agents keep working')}</p>
          <Button
            disabled={busy || !sessionId || !!commandTerminal}
            onClick={create}
          >
            {t('new terminal')}
          </Button>
        </div>
      )}
      <div className="native-terminal-surfaces">
        {terminals
          .filter(
            (item) =>
              opened.includes(item.id) &&
              visible.some((tab) => tab.id === item.id),
          )
          .map((item) => (
            <TerminalSurface
              key={item.id}
              onFind={() => openSearchRef.current()}
              snapshot={item}
              request={
                commandTerminal &&
                item.id === commandTerminal.resolved.target.terminal.id
                  ? terminalRequest
                  : undefined
              }
              inputAllowed={!commandTerminal || !!capabilities?.input}
              active={
                active &&
                item.id === selected?.id &&
                item.sessionId === sessionId
              }
              visible={item.id === selected?.id && item.sessionId === sessionId}
              adopt={adopt}
              onSelectionChange={(selected) => {
                setHasSelection((current) =>
                  current[item.id] === selected
                    ? current
                    : { ...current, [item.id]: selected },
                );
              }}
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
      <div className="native-terminal-bar">
        {selected && searchOpen ? (
          <div className="native-terminal-search find-bar">
            <input
              ref={(node) => {
                searchInput.current = node;
                if (node && focusSearch.current) {
                  focusSearch.current = false;
                  node.focus();
                }
              }}
              aria-label={t('find in terminal')}
              placeholder={t('find in terminal')}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={query}
              onChange={(event) => {
                searchRequest.current++;
                setQuery(event.target.value);
                setFound(true);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void find(event.shiftKey);
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  closeSearch();
                }
              }}
            />
            {!found && <span role="status">{t('no matches')}</span>}
            <IconButton
              label={t('previous match')}
              disabled={!query}
              onClick={() => {
                void find(true);
              }}
            >
              <ArrowUp size={14} />
            </IconButton>
            <IconButton
              label={t('next match')}
              disabled={!query}
              onClick={() => {
                void find(false);
              }}
            >
              <ArrowDown size={14} />
            </IconButton>
            <IconButton label={t('close search')} onClick={closeSearch}>
              <X size={14} />
            </IconButton>
          </div>
        ) : (
          selected && (
            <div className="native-terminal-status" role="status">
              <span
                className="native-terminal-folder"
                title={processDetails(selected)}
              >
                {folderName(selected.cwd)}
              </span>
              <span title={selected.exitReason}>
                <Status value={status(selected)} />
                {extraExitReason(selected)
                  ? ` · ${extraExitReason(selected)}`
                  : ''}
              </span>
              {notice && (
                <span className="native-terminal-notice">{notice}</span>
              )}
            </div>
          )
        )}
        <div className="native-terminal-actions">
          <IconButton
            label={t('find in terminal')}
            disabled={!selected}
            aria-expanded={searchOpen}
            onClick={openSearch}
          >
            <Search size={14} />
          </IconButton>
          <IconButton
            label={t('start service')}
            disabled={busy || !sessionId || !!commandTerminal}
            onClick={() => setServiceOpen(true)}
          >
            <Play size={14} />
          </IconButton>
          <IconButton
            label={
              selected?.kind === 'service' && !selected.managedCommand
                ? t('restart service')
                : t('restart terminal')
            }
            disabled={
              busy ||
              !selected ||
              !!commandTerminal ||
              ('managedCommand' in selected && !!selected.managedCommand) ||
              selected.status === 'stopping'
            }
            onClick={restart}
          >
            <RotateCcw size={14} />
          </IconButton>
          <IconButton
            label={t('interrupt command')}
            disabled={
              busy ||
              selected?.status !== 'running' ||
              (!!commandTerminal && !capabilities?.input)
            }
            onClick={() =>
              run(async () => {
                if (selected)
                  adopt(
                    await terminalRequest<TerminalSnapshot>('signal', {
                      id: selected.id,
                      signal: 'SIGINT',
                    }),
                  );
              })
            }
          >
            <Square size={13} />
          </IconButton>
          <IconButton
            label={
              selected?.kind === 'service' && !selected.managedCommand
                ? t('stop service')
                : t('stop terminal')
            }
            disabled={
              !selected ||
              stopping.includes(selected.id) ||
              !['running', 'stopping'].includes(selected.status) ||
              (!!commandTerminal && !capabilities?.stop)
            }
            onClick={() => {
              if (selected) void stopTerminal(selected.id);
            }}
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
          {onAddToDraft && (
            <IconButton
              label={t('add selection to chat')}
              disabled={
                busy ||
                !active ||
                !selected ||
                !hasSelection[selected.id] ||
                (!!commandTerminal && !capabilities?.addToDraft)
              }
              onClick={addToDraft}
            >
              <MessageSquarePlus size={14} />
            </IconButton>
          )}
        </div>
      </div>
      <Modal
        open={serviceOpen}
        onOpenChange={setServiceOpen}
        title={t('start service')}
      >
        <form
          className="native-service-form"
          onSubmit={(event) => {
            event.preventDefault();
            void createService();
          }}
        >
          <div className="native-service-fields form-stack">
            <label>
              {t('service name')}
              <input
                value={serviceName}
                onChange={(event) => setServiceName(event.target.value)}
                placeholder={t('optional')}
                maxLength={200}
              />
            </label>
            <label>
              {t('service executable')}
              <input
                required
                value={serviceFile}
                onChange={(event) => setServiceFile(event.target.value)}
                placeholder="npm"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <label>
              {t('service folder')}
              <input
                required
                value={serviceCwd}
                onChange={(event) => setServiceCwd(event.target.value)}
                placeholder="."
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <fieldset>
              <legend>{t('service arguments')}</legend>
              <p>
                {t(
                  'each field is one argument; spaces and quotes are kept exactly',
                )}
              </p>
              {serviceArgs.map((arg, index) => (
                <div className="native-service-argument" key={index}>
                  <input
                    aria-label={t('service argument {n}', { n: index + 1 })}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    value={arg}
                    onChange={(event) =>
                      setServiceArgs((previous) =>
                        previous.map((value, position) =>
                          position === index ? event.target.value : value,
                        ),
                      )
                    }
                  />
                  <IconButton
                    type="button"
                    label={t('remove argument {n}', { n: index + 1 })}
                    onClick={() =>
                      setServiceArgs((previous) =>
                        previous.filter((_, position) => position !== index),
                      )
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              ))}
              <Button
                type="button"
                disabled={serviceArgs.length >= 256}
                onClick={() => setServiceArgs((previous) => [...previous, ''])}
              >
                {t('add service argument')}
              </Button>
            </fieldset>
            <label>
              {t('ready port')}
              <input
                type="number"
                min={1}
                max={65535}
                value={servicePort}
                onChange={(event) => setServicePort(event.target.value)}
                placeholder={t('optional')}
              />
            </label>
            <label>
              {t('ready log text')}
              <input
                value={servicePattern}
                onChange={(event) => setServicePattern(event.target.value)}
                maxLength={512}
                placeholder={t('optional')}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            <p>
              {t(
                'when both checks are set, both must pass before the service is ready',
              )}
            </p>
            {error && (
              <p className="native-terminal-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="native-service-actions">
            <Button type="button" onClick={() => setServiceOpen(false)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || !serviceFile.trim()}>
              {t('start service')}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={renameFor !== null}
        onOpenChange={(open) => {
          if (!open) setRenameFor(null);
        }}
        title={t('rename terminal')}
      >
        <form
          className="native-service-form"
          onSubmit={(event) => {
            event.preventDefault();
            void applyRename();
          }}
        >
          <div className="native-service-fields form-stack">
            <label>
              {t('terminal name')}
              <input
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                maxLength={80}
                required
                autoFocus
              />
            </label>
            {error && (
              <p className="native-terminal-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="native-service-actions">
            <Button type="button" onClick={() => setRenameFor(null)}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || !renameValue.trim()}>
              {t('rename')}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}

function TerminalSurface({
  snapshot,
  request,
  inputAllowed = true,
  active,
  visible,
  adopt,
  register,
  onSelectionChange,
  onFind,
}: {
  snapshot: TerminalSnapshot;
  request?: TerminalRequest;
  inputAllowed?: boolean;
  active: boolean;
  visible: boolean;
  adopt: (snapshot: TerminalSnapshot) => void;
  register: (controls?: Controls) => void;
  onSelectionChange: (selected: boolean) => void;
  onFind: () => void;
}) {
  const language = useLocale();
  const onFindRef = useRef(onFind);
  onFindRef.current = onFind;
  const container = useRef<HTMLDivElement>(null);
  const screenReaderMode = useTerminalScreenReader();
  const instance = useRef<{ terminal: Terminal; fit: FitAddon } | null>(null);
  useEffect(() => {
    if (instance.current)
      instance.current.terminal.options.screenReaderMode = screenReaderMode;
  }, [screenReaderMode]);
  const synchronizeRef = useRef<(() => void) | null>(null);
  const notifySearchesRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  const requestRef = useRef(request);
  requestRef.current = request;
  const inputAllowedRef = useRef(inputAllowed);
  inputAllowedRef.current = inputAllowed;
  const statusRef = useRef(snapshot.status);
  const selectionChange = useRef(onSelectionChange);
  selectionChange.current = onSelectionChange;
  const timingVisibility = useRef<TimingVisibility>({
    active: false,
    epoch: 0,
  });
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  activeRef.current = active;
  statusRef.current = snapshot.status;

  useLayoutEffect(() => {
    const visibility = timingVisibility.current;
    const shown = active && visible;
    if (visibility.epoch && visibility.active === shown) return;
    visibility.active = shown;
    visibility.epoch++;
    recordTerminalTiming(
      snapshot.id,
      shown ? 'view-active' : 'view-inactive',
      visibility,
    );
  }, [snapshot.id, active, visible]);
  useLayoutEffect(
    () => () => {
      const visibility = timingVisibility.current;
      if (!visibility.active) return;
      visibility.active = false;
      visibility.epoch++;
      recordTerminalTiming(snapshot.id, 'view-inactive', visibility);
    },
    [snapshot.id],
  );

  useEffect(() => {
    if (!container.current) return;
    localizeTerminal();
    const terminal = new Terminal({
      cursorBlink: true,
      screenReaderMode,
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
      disableStdin: snapshot.status !== 'running' || !inputAllowed,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(search);
    terminal.open(container.current);
    instance.current = { terminal, fit };
    let cancelled = false;
    let inFlight: Promise<void> | undefined;
    let dirty = false;
    let cursor = 0;
    let timingFrames: Set<number> | undefined;
    const timingFrame = (callback: () => void) => {
      timingFrames ??= new Set();
      const frame = requestAnimationFrame(() => {
        timingFrames?.delete(frame);
        if (!cancelled) callback();
      });
      timingFrames.add(frame);
    };
    const pendingSearches = new Set<() => void>();
    const notifySearches = () => {
      for (const check of pendingSearches) check();
    };
    notifySearchesRef.current = notifySearches;
    let sendInput = Promise.resolve();
    const call = <T,>(method: string, params: Record<string, unknown>) =>
      requestRef.current
        ? requestRef.current<T>(method, params)
        : workspaceCall<T>(snapshot.sessionId, 'terminal', method, params);

    const showError = (reason: unknown) => {
      if (!cancelled)
        setError(reason instanceof Error ? reason.message : String(reason));
    };
    const synchronize = (): Promise<void> => {
      dirty = true;
      if (cancelled || !activeRef.current) return Promise.resolve();
      if (inFlight) return inFlight;
      inFlight = (async () => {
        do {
          dirty = false;
          let more: boolean;
          do {
            const afterSequence = cursor;
            recordTerminalTiming(
              snapshot.id,
              'replay-request',
              timingVisibility.current,
              undefined,
              afterSequence,
            );
            const page = await call<TerminalReplay>('replay', {
              id: snapshot.id,
              afterSequence: cursor,
              limit: 128,
            });
            recordTerminalTiming(
              snapshot.id,
              'replay-response',
              timingVisibility.current,
              undefined,
              page.nextSequence,
              afterSequence,
            );
            if (cancelled) return;
            for (const event of page.events) {
              const next = acceptTerminalEvent(snapshot.id, cursor, event);
              if (next === cursor) continue;
              if (event.kind === 'data' && event.data) {
                recordTerminalTiming(
                  snapshot.id,
                  'write-enqueued',
                  timingVisibility.current,
                  event.sequence,
                );
                await new Promise<void>((resolve) =>
                  terminal.write(event.data!, () => {
                    if (
                      !cancelled &&
                      recordTerminalTiming(
                        snapshot.id,
                        'write-parsed',
                        timingVisibility.current,
                        event.sequence,
                      ) &&
                      timingVisibility.current.active
                    ) {
                      const epoch = timingVisibility.current.epoch;
                      timingFrame(() =>
                        timingFrame(() => {
                          if (
                            activeRef.current &&
                            timingVisibility.current.active &&
                            timingVisibility.current.epoch === epoch &&
                            container.current?.isConnected &&
                            container.current.clientWidth &&
                            container.current.clientHeight
                          )
                            recordTerminalTiming(
                              snapshot.id,
                              'write-frame',
                              timingVisibility.current,
                              event.sequence,
                            );
                        }),
                      );
                    }
                    resolve();
                  }),
                );
              }
              cursor = next;
              notifySearches();
            }
            adopt(page.snapshot);
            more = page.hasMore;
          } while (more && !cancelled && activeRef.current);
        } while (dirty && !cancelled && activeRef.current);
      })().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    };
    register({
      search: async (text, previous, isCurrent) => {
        // Pin the log end for this request. Waiting for the entire live pump
        // could never finish while a service continuously produces output.
        const boundary = await call<TerminalReplay>('replay', {
          id: snapshot.id,
          afterSequence: cursor,
          limit: 1,
        });
        if (cancelled || !activeRef.current || !isCurrent()) return undefined;
        await new Promise<void>((resolve, reject) => {
          const check = () => {
            if (
              cursor >= boundary.snapshot.lastSequence ||
              cancelled ||
              !activeRef.current ||
              !isCurrent()
            ) {
              pendingSearches.delete(check);
              resolve();
            }
          };
          pendingSearches.add(check);
          check();
          void synchronize().catch((reason) => {
            pendingSearches.delete(check);
            reject(reason);
          });
        });
        if (cancelled || !activeRef.current || !isCurrent()) return undefined;
        const found = previous
          ? search.findPrevious(text)
          : search.findNext(text);
        // xterm clears selection without clearing its cached coordinates. When
        // search selects that same range again, no change event is emitted.
        // Read the actual selection after the programmatic selection completes.
        selectionChange.current(terminal.hasSelection());
        return found;
      },
      focus: () => terminal.focus(),
      selection: () => terminal.getSelection(),
      captureSelection: () => {
        const text = terminal.getSelection();
        const range = terminal.getSelectionPosition();
        if (!text || !range || cancelled || !activeRef.current) return;
        return {
          operationId: crypto.randomUUID(),
          sourceSessionId: snapshot.sessionId,
          terminalId: snapshot.id,
          terminalEpoch: snapshot.epoch,
          outputSequence: cursor,
          capturedAt: new Date().toISOString(),
          cols: terminal.cols,
          rows: terminal.rows,
          range: structuredClone(range),
          text,
        };
      },
    });
    const selection = terminal.onSelectionChange(() => {
      selectionChange.current(terminal.hasSelection());
    });
    const unsubscribe = subscribeWorkspace((event) => {
      if (
        event.service === 'terminal' &&
        event.resourceId === snapshot.id &&
        event.sessionId === snapshot.sessionId
      )
        void synchronize().catch(showError);
    });
    synchronizeRef.current = () => {
      void synchronize().catch(showError);
    };
    void synchronize().catch(showError);
    const writeInput = async (data: string) => {
      for (const part of terminalInputChunks(data))
        await call('write', { id: snapshot.id, data: part });
    };
    let pastedData: string[] | undefined;
    const input = terminal.onData((data) => {
      if (statusRef.current !== 'running' || !inputAllowedRef.current) return;
      if (pastedData) pastedData.push(data);
      else sendInput = sendInput.then(() => writeInput(data)).catch(showError);
    });
    const paste = (event: ClipboardEvent) => {
      if (
        !event.clipboardData ||
        statusRef.current !== 'running' ||
        !inputAllowedRef.current
      )
        return;
      const text = event.clipboardData.getData('text/plain');
      event.preventDefault();
      event.stopPropagation();
      sendInput = sendInput
        .then(async () => {
          // Replay terminal modes before encoding paste, including after reopening.
          await synchronize();
          if (
            cancelled ||
            statusRef.current !== 'running' ||
            !inputAllowedRef.current
          )
            return;
          const data: string[] = [];
          pastedData = data;
          try {
            terminal.paste(text);
          } finally {
            pastedData = undefined;
          }
          for (const part of data) await writeInput(part);
        })
        .catch(showError);
    };
    const pasteTarget = container.current;
    pasteTarget.addEventListener('paste', paste, true);
    const dimensions = terminal.onResize(({ cols, rows }) => {
      if (statusRef.current !== 'running') return;
      void call('resize', {
        id: snapshot.id,
        cols,
        rows,
      }).catch(showError);
    });
    terminal.attachCustomKeyEventHandler((event) => {
      // Ctrl+V and Ctrl+Shift+V paste, as in Windows Terminal: the browser's paste
      // event sends the text once, and no ^V control character goes to the shell.
      if (
        !/mac/i.test(navigator.platform) &&
        event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'v'
      )
        return false;
      if (
        event.type === 'keydown' &&
        (event.metaKey || (event.ctrlKey && event.shiftKey)) &&
        event.key.toLowerCase() === 'c'
      ) {
        event.preventDefault();
        if (terminal.hasSelection())
          void copyText(terminal.getSelection()).catch(showError);
        return false;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        // Opened here as well: the native window does not always pass this key on.
        if (event.type === 'keydown') {
          event.preventDefault();
          onFindRef.current();
        }
        return false;
      }
      return true;
    });
    let fitFrame: number | undefined;
    const resize = new ResizeObserver(() => {
      if (fitFrame !== undefined) return;
      // Fitting writes terminal dimensions. Do it outside the observer's layout
      // delivery so opening a narrow Inspector cannot cause a resize loop.
      fitFrame = requestAnimationFrame(() => {
        fitFrame = undefined;
        if (
          container.current?.clientWidth &&
          container.current.clientHeight &&
          activeRef.current
        )
          fit.fit();
      });
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
      for (const frame of timingFrames ?? []) cancelAnimationFrame(frame);
      notifySearches();
      unsubscribe();
      input.dispose();
      pasteTarget.removeEventListener('paste', paste, true);
      selection.dispose();
      selectionChange.current(false);
      dimensions.dispose();
      resize.disconnect();
      if (fitFrame !== undefined) cancelAnimationFrame(fitFrame);
      theme.disconnect();
      register();
      terminal.dispose();
      instance.current = null;
      synchronizeRef.current = null;
      notifySearchesRef.current = null;
      // A view closing never closes its PTY. It can be reopened through list/replay.
    };
    // Identity alone owns this view; status updates must not recreate its screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.id, snapshot.sessionId, retry]);

  useEffect(() => {
    if (!active) notifySearchesRef.current?.();
    if (active && instance.current && container.current?.clientWidth) {
      instance.current.fit.fit();
      synchronizeRef.current?.();
    }
  }, [active, visible]);
  useEffect(() => {
    if (instance.current)
      instance.current.terminal.options.disableStdin =
        snapshot.status !== 'running' || !inputAllowed;
  }, [snapshot.status, inputAllowed]);
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
      <div className="native-terminal-screen">
        <div ref={container} className="native-terminal-fit" />
      </div>
    </div>
  );
}

function localizeTerminal() {
  Terminal.strings.promptLabel = t('terminal input');
  Terminal.strings.tooMuchOutput = t(
    'more terminal output is available; navigate the terminal to read it',
  );
}

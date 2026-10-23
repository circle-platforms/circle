import { useTerminalScreenReader } from '../terminal-accessibility';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { DropdownMenu, Popover } from 'radix-ui';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Ellipsis,
  Plus,
  Square,
  X,
} from 'lucide-react';
import stripAnsi from 'strip-ansi';
import type {
  TerminalEvent,
  TerminalReplay,
  TerminalSnapshot,
} from '../../../desktop/src/workspace/terminal';
import { terminalTheme } from '../model/terminal-theme';
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
import { Button, IconButton, Modal } from './common';
import type {
  LocalTerminalRow,
  TerminalSessionRow,
} from '../../../desktop/src/contracts';
import {
  terminalTabName,
  terminalTabNumbers,
} from '../../../desktop/src/terminal-tabs';
import { presentHostError, quietWhenTerminalExited } from '../model/host-error';
import { claimTerminalKeyboard } from '../model/terminal-keyboard';
import { TerminalTabs, type TerminalTab } from './TerminalTabs';
import {
  DeviceNotices,
  DeviceSurface,
  deviceStateWord,
  useDeviceTerminals,
} from '../features/TerminalDevice';
import { TerminalConnect } from '../features/TerminalConnect';
import { ModeButtons } from '../features/mode-chrome';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
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

function status(snapshot: TerminalSnapshot): string {
  if (snapshot.managedCommand) {
    const root = snapshot.managedCommand.completion.rootExit;
    if (root)
      return root.signal
        ? t('ended by signal {signal}', { signal: root.signal })
        : t('exited (code {code})', { code: root.exitCode });
    if (!['running', 'stopping'].includes(snapshot.status))
      return t('terminal closed');
  }

  if (snapshot.kind === 'service') {
    if (snapshot.serviceState === 'starting') return t('service starting');
    if (snapshot.serviceState === 'ready') return t('service ready');
    if (snapshot.serviceState === 'running') return t('service running');
    if (snapshot.serviceState === 'stopped') return t('stopped');
    if (snapshot.serviceState === 'failed' && snapshot.status === 'running')
      return t('readiness failed');
  }
  switch (snapshot.status) {
    case 'running':
      return t('running');
    case 'stopping':
      return t('stopping');
    case 'exited':
      return snapshot.signal
        ? t('ended by signal {signal}', { signal: snapshot.signal })
        : t('exited (code {code})', { code: snapshot.exitCode ?? 0 });
    case 'failed':
      return t('failed');
    case 'interrupted':
      return t('interrupted');
  }
}

/**
 * A terminal tool the conversation is running or asking about, by the shell's id.
 * The tab's own state is what the runtime says; this covers the moment a tool is
 * already on screen and that state has not arrived.
 */
function toolActivity(
  messages: {
    tool?: { name: string; status: string; input: Record<string, unknown> };
  }[],
): Map<string, 'run' | 'wait'> {
  const activity = new Map<string, 'run' | 'wait'>();
  for (const message of messages) {
    const tool = message.tool;
    if (!tool?.name.startsWith('terminal_')) continue;
    if (tool.status !== 'running' && tool.status !== 'waiting') continue;
    const named = [tool.input.session, tool.input.terminal].find(
      (value): value is string =>
        typeof value === 'string' && value.startsWith('local:'),
    );
    if (!named) continue;
    const id = named.slice('local:'.length);
    if (activity.get(id) === 'wait') continue;
    activity.set(id, tool.status === 'waiting' ? 'wait' : 'run');
  }
  return activity;
}

/**
 * The shell's row as the window shows it. The runtime's row wins when you hold the
 * shell; a terminal tool the conversation is already running or asking about fills in
 * until that row arrives, so the dot and the ring are not late.
 */
function circleRow(
  id: string,
  known: Map<string, LocalTerminalRow>,
  activity: Map<string, 'run' | 'wait'>,
  numbers: Map<string, number>,
): LocalTerminalRow | undefined {
  const circle = known.get(id);
  if (circle?.held || circle?.state === 'held') return circle;
  const doing = activity.get(id);
  const state =
    circle?.state === 'waiting' || doing === 'wait'
      ? 'waiting'
      : circle?.state === 'operating' || doing === 'run'
        ? 'operating'
        : circle?.state;
  if (!state) return undefined;
  if (circle) return state === circle.state ? circle : { ...circle, state };
  return {
    id: `local:${id}`,
    terminal: id,
    ordinal: numbers.get(id) ?? 0,
    state,
    allowed: false,
  };
}

/** The exit reason adds nothing when it only restates the status line. */
function extraExitReason(snapshot: TerminalSnapshot) {
  const reason = snapshot.exitReason;
  if (!reason || snapshot.managedCommand) return '';
  const code = snapshot.exitCode ?? 0;
  const same = [
    status(snapshot),
    `exit ${code}`,
    snapshot.signal ? `signal ${snapshot.signal}` : '',
    snapshot.signal ?? '',
  ];
  return same.includes(reason) ? '' : reason;
}

/** The folder a terminal runs in, by name; the full path is in its tooltip. */
function folderName(path: string) {
  const trimmed = path.replace(/[\\/]+$/, '');
  return trimmed.split(/[\\/]/).at(-1) || path;
}

/** Process ids are for developers: they stay in the status tooltip. */
function processDetails(snapshot: TerminalSnapshot) {
  const ids = snapshot.managedCommand
    ? [
        snapshot.managedCommand.commandPid !== undefined
          ? t('command pid {pid}', {
              pid: snapshot.managedCommand.commandPid,
            })
          : '',
        snapshot.pid !== undefined
          ? t('pty pid {pid}', { pid: snapshot.pid })
          : '',
      ]
    : [
        snapshot.pid !== undefined
          ? t('process pid {pid}', { pid: snapshot.pid })
          : '',
      ];
  return [snapshot.cwd, ids.filter(Boolean).join(' · ')]
    .filter(Boolean)
    .join('\n');
}

const DISMISSED_KEY = 'circle.workbench.terminal-closed';
/** The tabs you closed: a shell that ended stays listed by the service, but not in the row. */
function readDismissed(): Set<string> {
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem(DISMISSED_KEY) ?? '[]',
    );
    return new Set(
      Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}
function rememberDismissed(ids: Set<string>) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-200)));
  } catch {
    // The row only forgets them in the next window then.
  }
}

/** Keep mounted while the Inspector is hidden. Its PTYs and reading position persist. */
export function NativeTerminal({
  sessionId: parentSessionId,
  commandTerminal,
  onExitCommandTerminal,
  active = true,
  embedded = false,
  onAddToDraft,
}: {
  sessionId: string;
  commandTerminal?: CommandTerminalView;
  onExitCommandTerminal?: () => void;
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
  const [terminals, setTerminals] = useState<TerminalSnapshot[]>([]);
  const [selectedBySession, setSelected] = useState<Record<string, string>>({});
  const [operations, setOperations] = useState<
    Record<string, { busy?: boolean; error?: string }>
  >({});
  const busy = operations[sessionId]?.busy ?? false;
  const error = operations[sessionId]?.error ?? '';
  const disconnected =
    error.includes('native workspace services are not connected') ||
    error.includes('runtime not enabled');
  const [opened, setOpened] = useState<string[]>([]);
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
  const selectedId = selectedBySession[sessionId];
  const { snapshot: appSnapshot, notify } = useRuntime();
  const [dismissed, setDismissed] = useState(readDismissed);
  // The row's order as the person dragged it, per conversation, where no main process
  // keeps it (a page without the desktop application). A tab keeps its number wherever
  // it is dragged.
  const [localOrder, setLocalOrder] = useState<Record<string, string[]>>({});
  const [renameFor, setRenameFor] = useState<string | null>(null);
  // A device console waits to be closed on purpose: the wire goes to another machine.
  const [closingDevice, setClosingDevice] = useState<TerminalSessionRow | null>(
    null,
  );
  const [renameValue, setRenameValue] = useState('');
  // Every command Circle runs has a terminal; only a command that runs in the background,
  // which has a row of its own in the jobs, is a tab. A foreground one is seen from its
  // tool row, and in the view of one command.
  const backgroundTerminals = new Set(
    appSnapshot.jobs.flatMap((job) =>
      job.kind === 'command' && job.terminal ? [job.terminal.id] : [],
    ),
  );
  // A command's tab is named by its command: the terminal knows it when Circle wrote it
  // with variables, and the job always does.
  const jobTitles = new Map(
    appSnapshot.jobs.flatMap((job) =>
      job.kind === 'command' && job.terminal
        ? [[job.terminal.id, job.title] as const]
        : [],
    ),
  );
  const visible = terminals.filter(
    (item) =>
      item.sessionId === sessionId &&
      !item.hidden &&
      !dismissed.has(item.id) &&
      (!item.managedCommand ||
        !!commandTerminal ||
        backgroundTerminals.has(item.id)) &&
      (!commandTerminal ||
        (item.id === commandTerminal.resolved.target.terminal.id &&
          item.epoch === commandTerminal.resolved.target.terminal.epoch)),
  );
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

  useEffect(() => {
    searchRequest.current++;
    setFound(true);
    return () => {
      searchRequest.current++;
    };
  }, [sessionId, selected?.id]);

  const adopt = useCallback((snapshot: TerminalSnapshot) => {
    setTerminals((current) => {
      const merged = mergeTerminalSnapshot(current, snapshot);
      // A restart replaces its terminal's tab, in this window and any other: the old
      // one leaves the row as soon as the new one is here, not after it has stopped.
      const before = snapshot.restartOf;
      return before
        ? merged.map((item) =>
            item.id === before && !item.hidden
              ? { ...item, hidden: true }
              : item,
          )
        : merged;
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
  }, [sessionId, reload, terminalRequest]);

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
      // A tab closed in the row still holds its number until hide lands. Wait
      // for that, so the shell created next takes the lowest number now free.
      const closing = terminals.filter(
        (item) =>
          item.sessionId === capturedSession &&
          dismissed.has(item.id) &&
          !item.hidden,
      );
      await Promise.all(
        closing.map((item) =>
          terminalRequest<TerminalSnapshot>('hide', { id: item.id })
            .then(adopt)
            .catch(() => undefined),
        ),
      );
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
      const previousId = selected.id;
      const snapshot = await terminalRequest<TerminalSnapshot>('restart', {
        id: previousId,
      });
      focusTarget.current = snapshot.id;
      setTerminals((current) =>
        mergeTerminalSnapshot(
          current.map((item) =>
            item.id === previousId ? { ...item, hidden: true } : item,
          ),
          snapshot,
        ),
      );
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
      notify(t('complete terminal output copied'));
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
      notify(t('terminal selection added to draft'));
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
  const wantsFind = useRef(false);
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

  // Devices, tabs and what the selected tab can be told to do.
  const devices = useDeviceTerminals(sessionId);
  const workspaceFolder = (() => {
    const owner =
      appSnapshot.sessions.find((item) => item.id === sessionId) ??
      currentSession(appSnapshot);
    const path = appSnapshot.workspaces.find(
      (item) => item.id === owner.workspaceId,
    )?.path;
    return path ? folderName(path) : '';
  })();
  const deviceRows = commandTerminal ? [] : devices.rows;
  // Cutting a console's wire and dropping its tab: what the dialog confirms and a
  // bulk close both do.
  const disconnectDevice = (row: TerminalSessionRow) => {
    if (deviceChosen === row.id) setDeviceChosen('');
    void devices
      .disconnect(row)
      .catch((error) =>
        notify(error instanceof Error ? error.message : String(error)),
      );
  };

  const [deviceChosen, setDeviceChosen] = useState('');
  const [deviceRefresh, setDeviceRefresh] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const wantsConnect = useRef(false);
  // With no shell in front, the first console is: the row never shows a blank screen.
  const deviceSelected =
    deviceRows.find((row) => row.id === deviceChosen) ??
    (selected ? undefined : deviceRows[0]);
  // The shell or command in front: none while a device console is.
  const inFront = deviceSelected ? undefined : selected;
  const selectedKey = deviceSelected
    ? `dev:${deviceSelected.id}`
    : selected
      ? `local:${selected.id}`
      : '';
  const selectDevice = (id: string) => setDeviceChosen(id);
  const selectTab = (key: string, fromKeyboard = false) => {
    if (key.startsWith('dev:')) return selectDevice(key.slice(4));
    const id = key.slice(6);
    setDeviceChosen('');
    // A click hands the keyboard to the terminal; arrows keep it on the tab row, so the
    // next arrow moves along the row instead of reaching a shell.
    focusTarget.current = fromKeyboard ? null : id;
    setSelected((previous) => ({ ...previous, [sessionId]: id }));
  };
  const closeTab = (id: string) =>
    setDismissed((previous) => {
      const next = new Set(previous).add(id);
      rememberDismissed(next);
      return next;
    });
  // The row in the person's order: the main process keeps it for every window, so a
  // reload, a visit home and a window of its own show it too. A tab it does not name
  // goes after the ones it names, in the order they came to be, and a restarted
  // terminal stands where the one it replaced stood.
  const chosen = devices.order ?? localOrder[sessionId] ?? [];
  const rank = (key: string) => {
    let at = chosen.indexOf(key);
    let id = key.startsWith('local:') ? key.slice('local:'.length) : '';
    for (let step = 0; at === -1 && id && step < 32; step++) {
      id = terminals.find((item) => item.id === id)?.restartOf ?? '';
      if (id) at = chosen.indexOf(`local:${id}`);
    }
    return at;
  };
  // When each tab came to be: a shell started after a device console stands after
  // it, rather than in front of it because it is of another kind.
  const openedAt = new Map<string, number>();
  for (const item of visible) {
    let stamp = Date.parse(item.startedAt) || 0;
    let before = item.restartOf;
    for (let step = 0; before && step < 32; step++) {
      const last = terminals.find((row) => row.id === before);
      if (!last) break;
      stamp = Date.parse(last.startedAt) || stamp;
      before = last.restartOf;
    }
    openedAt.set(`local:${item.id}`, stamp);
  }
  for (const row of deviceRows)
    openedAt.set(`dev:${row.id}`, row.startedAt ?? 0);
  // A tab keeps a stored number; a closed tab does not. The model's tools use the same rule.
  // A drag reorders the row without renumbering a tab.
  const numbers = terminalTabNumbers(
    terminals.filter(
      (item) =>
        item.sessionId === sessionId && !item.hidden && !dismissed.has(item.id),
    ),
  );
  // What Circle is doing in each of your shells, by every id the row or a tool call uses.
  const circleKnown = new Map<string, LocalTerminalRow>();
  for (const row of devices.local) {
    circleKnown.set(row.terminal, row);
    circleKnown.set(row.id, row);
    if (row.id.startsWith('local:'))
      circleKnown.set(row.id.slice('local:'.length), row);
  }
  const activity = toolActivity(
    appSnapshot.sessions.find((item) => item.id === sessionId)?.messages ?? [],
  );
  const circleIn = (id: string) =>
    circleRow(id, circleKnown, activity, numbers);
  const tabs: TerminalTab[] = [
    ...visible.map((item): TerminalTab => {
      const command = !!item.managedCommand;
      const running = ['running', 'stopping'].includes(item.status);
      const shellDead =
        !command && item.kind !== 'service' && !running && !item.hidden;
      const failed =
        shellDead ||
        item.status === 'failed' ||
        (!running && ((item.exitCode ?? 0) !== 0 || !!item.signal));
      const named = command || item.kind === 'service';
      const label = command
        ? (item.managedCommand?.displayCommand ??
          jobTitles.get(item.id) ??
          item.label)
        : named
          ? item.label
          : (terminalTabName(item) ??
            t('terminal {n}', { n: numbers.get(item.id) ?? 0 }));
      const circle = circleIn(item.id);
      return {
        key: `local:${item.id}`,
        label,
        title: `${item.cwd} · ${status(item)}`,
        // A quiet shell has no dot; what runs for you or Circle does, and so does
        // Circle waiting on you for this shell or working in it.
        state:
          circle?.state === 'waiting'
            ? 'wait'
            : circle?.state === 'operating'
              ? 'run'
              : running
                ? named
                  ? 'run'
                  : undefined
                : failed
                  ? 'fail'
                  : named
                    ? 'done'
                    : undefined,
        controls: `terminal-${item.id}`,
        // A command Circle runs cannot be closed until it ends: it has its stop.
        ...(command && running
          ? {}
          : {
              closeLabel: running
                ? t('stop {name}', { name: label })
                : t('close {name}', { name: label }),
              onClose: () => {
                if (running) void stopTerminal(item.id);
                closeTab(item.id);
                void terminalRequest<TerminalSnapshot>('hide', {
                  id: item.id,
                })
                  .then(adopt)
                  .catch(() => {});
              },
            }),
      };
    }),
    ...deviceRows.map((row): TerminalTab => ({
      key: `dev:${row.id}`,
      label: `${row.name} · ${row.transport === 'ssh' ? 'SSH' : 'Telnet'}`,
      title: `${row.target} · ${deviceStateWord(row)}`,
      state:
        row.state === 'connecting'
          ? 'run'
          : row.state === 'error'
            ? 'fail'
            : undefined,
      controls: `device-${row.id}`,
      closeLabel: t('disconnect {name}', { name: row.name }),
      // Closing a console cuts a wire to a machine: the person means to do it.
      onClose: () => setClosingDevice(row),
    })),
  ];
  // A bulk close from a tab's menu is the person's choice already: asking once for
  // every console on the row would be a wall of dialogs. The tab's × still asks.
  const closeNow = new Map<string, () => void>(
    deviceRows.map((row) => [`dev:${row.id}`, () => disconnectDevice(row)]),
  );
  const orderedTabs = tabs.sort((a, b) => {
    const left = rank(a.key);
    const right = rank(b.key);
    // Neither is named by the person: the later arrival stands later.
    if (left < 0 && right < 0)
      return (openedAt.get(a.key) ?? 0) - (openedAt.get(b.key) ?? 0);
    if (left < 0) return 1;
    if (right < 0) return -1;
    return left - right;
  });
  const shellOf = (key: string) =>
    terminals.find((item) => `local:${item.id}` === key);
  const closeExcept = (keep: string) => {
    for (const tab of orderedTabs)
      if (tab.key !== keep) (closeNow.get(tab.key) ?? tab.onClose)?.();
  };
  // A tab dropped on another takes that one's place: to its right when it came from
  // the left, so a tab can go to the end of the row, and to its left otherwise.
  const moveTab = (from: string, to: string) => {
    const keys = orderedTabs.map((tab) => tab.key);
    const at = keys.indexOf(from);
    const target = keys.indexOf(to);
    if (at === -1 || target === -1 || at === target) return;
    keys.splice(at, 1);
    keys.splice(target, 0, from);
    if (!devices.arrange(keys))
      setLocalOrder((previous) => ({ ...previous, [sessionId]: keys }));
  };
  const clearError = () =>
    setOperations((previous) => ({
      ...previous,
      [sessionId]: { ...previous[sessionId], error: '' },
    }));
  // A tab that has a name of its own starts from it; one called by its number starts
  // empty, so a name is never its number frozen in by accident.
  const openRename = (id: string) => {
    const item = terminals.find((one) => one.id === id);
    setRenameValue(
      item && (item.kind === 'service' || item.named) ? item.label : '',
    );
    clearError();
    setRenameFor(id);
  };
  const closeRename = () => {
    clearError();
    setRenameFor(null);
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
  // Right-clicking a tab offers what a person expects of a tab: name it, close
  // it, close the rest, make another. A device console is named by its profile.
  const withMenus = commandTerminal
    ? orderedTabs
    : orderedTabs.map((tab) => ({
        ...tab,
        onMove: moveTab,
        menu: [
          ...(shellOf(tab.key) && !shellOf(tab.key)?.managedCommand
            ? [
                {
                  label: t('rename…'),
                  onSelect: () => openRename(tab.key.slice(6)),
                },
              ]
            : []),
          ...(tab.onClose
            ? [{ label: t('close'), onSelect: () => tab.onClose?.() }]
            : []),
          {
            label: t('close others'),
            disabled: orderedTabs.length < 2,
            onSelect: () => closeExcept(tab.key),
          },
          {
            label: t('close all'),
            onSelect: () => closeExcept(''),
          },
          { separator: true },
          { label: t('new terminal'), onSelect: () => void create() },
        ],
      }));
  const commandRunning =
    !!inFront?.managedCommand &&
    ['running', 'stopping'].includes(inFront.status);
  // What Circle is doing in the shell in front: it asks about it, works in it, or you hold it.
  const circleInFront = inFront ? circleIn(inFront.id) : undefined;
  // Ringed orange while Circle waits for your answer about this shell, blue while it
  // works in it or a command it started runs here.
  const frame =
    circleInFront?.state === 'waiting'
      ? 'wait'
      : commandRunning || circleInFront?.state === 'operating'
        ? 'run'
        : '';
  const frontName = inFront
    ? (tabs.find((tab) => tab.key === `local:${inFront.id}`)?.label ?? '')
    : '';
  const rowActions = deviceSelected ? (
    deviceSelected.held ? (
      <Button onClick={() => devices.detach(deviceSelected)}>
        {t('give back')}
      </Button>
    ) : deviceSelected.state === 'ready' ? (
      <Button onClick={() => devices.attach(deviceSelected)}>
        {t('take over')}
      </Button>
    ) : null
  ) : commandRunning && inFront ? (
    <Button
      disabled={
        stopping.includes(inFront.id) ||
        (!!commandTerminal && !capabilities?.stop)
      }
      onClick={() => void stopTerminal(inFront.id)}
    >
      <Square size={12} aria-hidden /> {t('stop')}
    </Button>
  ) : circleInFront?.held ? (
    <Button onClick={() => devices.giveBackTab(circleInFront)}>
      {t('give back')}
    </Button>
  ) : circleInFront?.state === 'operating' ? (
    <>
      <Button onClick={() => devices.takeTab(circleInFront)}>
        {t('take over')}
      </Button>
      <Button
        aria-label={t('stop Circle in {name}', { name: frontName })}
        onClick={() => devices.stopTab(circleInFront)}
      >
        <Square size={12} aria-hidden /> {t('stop')}
      </Button>
    </>
  ) : null;
  const terminalMenu =
    deviceSelected || inFront ? (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <IconButton label={t('terminal menu')}>
            <Ellipsis size={14} />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="dropdown term-menu"
            align="end"
            sideOffset={6}
            // Find opens once the menu has handed the keyboard back to its button: opened
            // while the menu closes, the keyboard would land on the button after it.
            onCloseAutoFocus={(event) => {
              if (!wantsFind.current) return;
              event.preventDefault();
              wantsFind.current = false;
              openSearch();
            }}
          >
            {deviceSelected ? (
              <DropdownMenu.Item
                onSelect={() => setDeviceRefresh((value) => value + 1)}
              >
                {t('refresh the screen')}
              </DropdownMenu.Item>
            ) : (
              inFront && (
                <>
                  <DropdownMenu.Item
                    onSelect={() => {
                      wantsFind.current = true;
                    }}
                  >
                    {t('find in terminal')}
                  </DropdownMenu.Item>
                  {onAddToDraft && (
                    <DropdownMenu.Item
                      disabled={
                        busy ||
                        !active ||
                        !hasSelection[inFront.id] ||
                        (!!commandTerminal && !capabilities?.addToDraft)
                      }
                      onSelect={addToDraft}
                    >
                      {t('add selection to chat')}
                    </DropdownMenu.Item>
                  )}
                  <DropdownMenu.Item disabled={busy} onSelect={copyAll}>
                    {t('copy complete output')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="dropdown-separator" />
                  <DropdownMenu.Item
                    disabled={
                      busy ||
                      !!commandTerminal ||
                      !!inFront.managedCommand ||
                      inFront.status === 'stopping'
                    }
                    onSelect={restart}
                  >
                    {inFront.kind === 'service' && !inFront.managedCommand
                      ? t('restart service')
                      : t('restart terminal')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={
                      busy ||
                      inFront.status !== 'running' ||
                      (!!commandTerminal && !capabilities?.input)
                    }
                    onSelect={() =>
                      run(async () => {
                        adopt(
                          await terminalRequest<TerminalSnapshot>('signal', {
                            id: inFront.id,
                            signal: 'SIGINT',
                          }),
                        );
                      })
                    }
                  >
                    {t('interrupt command')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Item
                    disabled={busy || !sessionId || !!commandTerminal}
                    onSelect={() => setServiceOpen(true)}
                  >
                    {t('start service')}
                  </DropdownMenu.Item>
                </>
              )
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    ) : null;

  return (
    <section
      className={`native-terminal${embedded ? ' embedded' : ''}`}
      aria-label={t('interactive terminal')}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.shiftKey &&
          inFront &&
          !inFront.managedCommand &&
          inFront.kind !== 'service' &&
          !['running', 'stopping'].includes(inFront.status)
        ) {
          const target = event.target;
          // The xterm handler restarts on Enter in the screen. Handling it here
          // as well would start a second shell.
          if (
            target instanceof Element &&
            target.closest('input, button, textarea, [role="menu"], .xterm')
          )
            return;
          event.preventDefault();
          restart();
          return;
        }
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
      <TerminalTabs
        leading={
          commandTerminal && onExitCommandTerminal ? (
            <IconButton
              label={t('session terminals')}
              onClick={onExitCommandTerminal}
            >
              <ArrowLeft size={14} />
            </IconButton>
          ) : undefined
        }
        tabs={withMenus}
        selected={selectedKey}
        active={active}
        onSelect={selectTab}
        menu={
          commandTerminal ? undefined : (
            <Popover.Root open={connectOpen} onOpenChange={setConnectOpen}>
              <Popover.Anchor asChild>
                <span className="term-plus">
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <IconButton
                        label={t('new terminal or device')}
                        disabled={!sessionId}
                      >
                        <Plus size={15} />
                      </IconButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content
                        className="dropdown term-menu"
                        align="start"
                        sideOffset={6}
                        // The form opens once the menu has let go of the focus: opened
                        // while the menu closes, it would be dismissed by that hand-over.
                        onCloseAutoFocus={(event) => {
                          if (!wantsConnect.current) return;
                          event.preventDefault();
                          wantsConnect.current = false;
                          setConnectOpen(true);
                        }}
                      >
                        <DropdownMenu.Item disabled={busy} onSelect={create}>
                          {t('new local terminal')}
                          {workspaceFolder && <small>{workspaceFolder}</small>}
                        </DropdownMenu.Item>
                        {devices.available && (
                          <>
                            <DropdownMenu.Separator className="dropdown-separator" />
                            {devices.profiles.length > 0 && (
                              <DropdownMenu.Label className="dropdown-label">
                                {t('connect to a device')}
                              </DropdownMenu.Label>
                            )}
                            {devices.profiles.map((profile) => (
                              <DropdownMenu.Item
                                key={profile.name}
                                onSelect={() =>
                                  void devices
                                    .connectProfile(profile.name)
                                    .then((id) => id && selectDevice(id))
                                    .catch(() => {})
                                }
                              >
                                {profile.name}
                                <small>
                                  {profile.target} ·{' '}
                                  {profile.transport === 'ssh'
                                    ? 'SSH'
                                    : 'Telnet'}
                                </small>
                              </DropdownMenu.Item>
                            ))}
                            <DropdownMenu.Item
                              onSelect={() => {
                                wantsConnect.current = true;
                              }}
                            >
                              {t('connect new device…')}
                            </DropdownMenu.Item>
                          </>
                        )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </span>
              </Popover.Anchor>
              <Popover.Portal>
                <Popover.Content
                  className="popover term-connect-pop"
                  align="start"
                  sideOffset={6}
                >
                  <TerminalConnect
                    onCancel={() => setConnectOpen(false)}
                    onConnect={async (target) => {
                      const id = await devices.connectTarget(target);
                      if (id) selectDevice(id);
                      setConnectOpen(false);
                    }}
                  />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )
        }
        actions={rowActions}
        end={
          <>
            {terminalMenu}
            <ModeButtons popOut />
          </>
        }
      />
      {inFront && displayedCommand && !inFront.managedCommand && (
        <div className="native-service-details">
          <code title={displayedCommand}>{displayedCommand}</code>
          {inFront.readiness?.port && (
            <span>localhost:{inFront.readiness.port}</span>
          )}
          {inFront.readiness?.pattern && (
            <span title={inFront.readiness.pattern}>
              {t('ready log text')}: {inFront.readiness.pattern}
            </span>
          )}
        </div>
      )}
      {/* An ended terminal says how in a quiet line under its tabs: the exit code,
          the reason, and where it ran with its process ids in the tooltip. */}
      {inFront && !['running', 'stopping'].includes(inFront.status) && (
        <div
          className="native-terminal-exit"
          role="status"
          title={processDetails(inFront)}
        >
          {status(inFront)}
          {extraExitReason(inFront) ? ` · ${extraExitReason(inFront)}` : ''}
        </div>
      )}
      {inFront &&
        !inFront.managedCommand &&
        inFront.kind !== 'service' &&
        !['running', 'stopping'].includes(inFront.status) && (
          <div className="native-terminal-dead" tabIndex={0}>
            <p>{t('this terminal has exited')}</p>
            <p>{t('press enter to restart')}</p>
            <Button disabled={busy} onClick={restart}>
              {t('restart')}
            </Button>
          </div>
        )}
      {error && !serviceOpen && renameFor === null && (
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
      {inFront?.readiness?.error && (
        <div className="native-terminal-error" role="alert">
          {inFront.readiness.error}
        </div>
      )}
      {inFront?.error && (
        <div className="native-terminal-error" role="alert">
          {inFront.error}
        </div>
      )}
      {!commandTerminal && (
        <DeviceNotices
          devices={devices}
          row={deviceSelected}
          tab={circleInFront}
          tabName={frontName}
          onOpened={(id) => selectDevice(id)}
          onProblem={(message) => notify(message)}
        />
      )}
      {!selected && !deviceRows.length && !error && (
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
      <div className="term-frame" data-frame={frame}>
        <div className="native-terminal-surfaces">
          {terminals
            .filter((item) => opened.includes(item.id))
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
                  !deviceSelected &&
                  item.id === selected?.id &&
                  item.sessionId === sessionId
                }
                visible={
                  !deviceSelected &&
                  item.id === selected?.id &&
                  item.sessionId === sessionId
                }
                adopt={adopt}
                onRestart={
                  item.managedCommand || item.kind === 'service'
                    ? undefined
                    : restart
                }
                onUserKey={() => {
                  // Typing takes the tab whichever way the key arrives, including
                  // the short claim that sends it on before xterm has focus.
                  const circle = circleIn(item.id);
                  if (
                    !circle ||
                    circle.held ||
                    circle.state === 'held' ||
                    (circle.state !== 'operating' && circle.state !== 'waiting')
                  )
                    return;
                  devices.takeTab(circle);
                }}
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
          {(deviceRows.length > 0 || deviceChosen) && (
            <DeviceSurface
              sessionId={sessionId}
              row={deviceSelected}
              visible={!!deviceSelected}
              refresh={deviceRefresh}
            />
          )}
        </div>
        {inFront && searchOpen && (
          <div className="native-terminal-bar">
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
          </div>
        )}
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
          if (!open) closeRename();
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
                placeholder={
                  tabs.find((tab) => tab.key === `local:${renameFor}`)?.label
                }
                maxLength={80}
                required
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
            </label>
            {error && (
              <p className="native-terminal-error" role="alert">
                {error}
              </p>
            )}
          </div>
          <div className="native-service-actions">
            <Button type="button" onClick={closeRename}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={busy || !renameValue.trim()}>
              {t('rename')}
            </Button>
          </div>
        </form>
      </Modal>
      <Modal
        open={closingDevice !== null}
        onOpenChange={(open) => {
          if (!open) setClosingDevice(null);
        }}
        title={t('disconnect {name}?', { name: closingDevice?.name ?? '' })}
      >
        <p className="dialog-paragraph">
          {t(
            'Circle closes this console and stops reading the device. What runs in its foreground usually ends when the wire is cut.',
          )}
        </p>
        <div className="native-service-actions">
          <Button onClick={() => setClosingDevice(null)}>{t('cancel')}</Button>
          <Button
            className="danger"
            disabled={busy}
            onClick={() => {
              const row = closingDevice;
              setClosingDevice(null);
              if (row) disconnectDevice(row);
            }}
          >
            {t('disconnect')}
          </Button>
        </div>
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
  onRestart,
  onUserKey,
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
  onRestart?: () => void;
  /** A key the person typed into this shell, before it is written. */
  onUserKey?: () => void;
}) {
  const language = useLocale();
  const onFindRef = useRef(onFind);
  onFindRef.current = onFind;
  const onRestartRef = useRef(onRestart);
  onRestartRef.current = onRestart;
  const onUserKeyRef = useRef(onUserKey);
  onUserKeyRef.current = onUserKey;
  const deliverRef = useRef<(text: string) => void>(() => {});
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
  // The banner can land while the snapshot still says running, then the shell
  // is exited. Leaving the shell is the exited state, not a failed operation.
  useEffect(() => {
    if (snapshot.status === 'running') return;
    setError((current) => (quietWhenTerminalExited(current) ? '' : current));
  }, [snapshot.status]);

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
      if (cancelled) return;
      const message = reason instanceof Error ? reason.message : String(reason);
      // A resize or a write that races the shell exiting is not a failure.
      if (statusRef.current !== 'running' && quietWhenTerminalExited(message))
        return;
      setError(message);
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
    const noteUserKey = () => onUserKeyRef.current?.();
    // Keys the claim already wrote. The same character can also arrive from xterm
    // once focus lands in it; that copy is not a second keystroke.
    let claimed = '';
    let claimTimer: ReturnType<typeof setTimeout> | undefined;
    const deliver = (data: string, fromClaim: boolean) => {
      if (statusRef.current !== 'running' || !inputAllowedRef.current) return;
      noteUserKey();
      if (fromClaim) {
        claimed += data;
        if (claimTimer) clearTimeout(claimTimer);
        claimTimer = setTimeout(() => {
          claimed = '';
        }, 50);
      }
      sendInput = sendInput.then(() => writeInput(data)).catch(showError);
    };
    deliverRef.current = (text) => deliver(text, true);
    let pastedData: string[] | undefined;
    const input = terminal.onData((data) => {
      if (statusRef.current !== 'running' || !inputAllowedRef.current) return;
      if (pastedData) {
        pastedData.push(data);
        return;
      }
      if (claimed && claimed.startsWith(data)) {
        claimed = claimed.slice(data.length);
        return;
      }
      claimed = '';
      deliver(data, false);
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
      noteUserKey();
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
      // A shell that has exited restarts on Enter, as its button does.
      if (
        event.type === 'keydown' &&
        event.key === 'Enter' &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        statusRef.current !== 'running' &&
        statusRef.current !== 'stopping'
      ) {
        event.preventDefault();
        onRestartRef.current?.();
        return false;
      }
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
      if (claimTimer) clearTimeout(claimTimer);
      deliverRef.current = () => {};
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
          <span>{presentHostError(error)}</span>
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
      <div
        className="native-terminal-screen"
        onPointerDown={() => {
          const term = instance.current?.terminal;
          if (!term) return;
          // The click is the person's. A render after it can focus the composer
          // again before the next key; the claim types that key here instead.
          claimTerminalKeyboard(
            () => {
              if (instance.current?.terminal === term) term.focus();
            },
            (text) => {
              // Straight to the shell. term.input would also emit onData, and the
              // key would be written twice.
              if (instance.current?.terminal === term) deliverRef.current(text);
            },
          );
        }}
      >
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

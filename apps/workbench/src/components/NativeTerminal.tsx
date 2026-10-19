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
import { terminalTabNumbers } from '../../../desktop/src/terminal-tabs';
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
  const tabStrip = useRef<HTMLDivElement>(null);
  const selectedId = selectedBySession[sessionId];
  const { snapshot: appSnapshot, notify } = useRuntime();
  const [dismissed, setDismissed] = useState(readDismissed);
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
  // A shell keeps its number while others close around it, and the model's terminal tools
  // and the cards in the conversation name it the same way: terminalTabNumbers is the rule.
  const numbers = terminalTabNumbers(
    terminals.filter((item) => item.sessionId === sessionId),
  );
  // What Circle is doing in each of your shells, by the terminal's id.
  const circleIn = new Map(devices.local.map((row) => [row.terminal, row]));
  const tabs: TerminalTab[] = [
    ...visible.map((item): TerminalTab => {
      const command = !!item.managedCommand;
      const running = ['running', 'stopping'].includes(item.status);
      const failed =
        item.status === 'failed' ||
        (!running && ((item.exitCode ?? 0) !== 0 || !!item.signal));
      const named = command || item.kind === 'service';
      const label = command
        ? (item.managedCommand?.displayCommand ??
          jobTitles.get(item.id) ??
          item.label)
        : named
          ? item.label
          : t('terminal {n}', { n: numbers.get(item.id) ?? 0 });
      const circle = circleIn.get(item.id);
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
      onClose: () => devices.disconnect(row),
    })),
  ];
  const commandRunning =
    !!inFront?.managedCommand &&
    ['running', 'stopping'].includes(inFront.status);
  // What Circle is doing in the shell in front: it asks about it, works in it, or you hold it.
  const circleInFront = inFront ? circleIn.get(inFront.id) : undefined;
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
        aria-label={t('stop circle in {name}', { name: frontName })}
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
        tabs={tabs}
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

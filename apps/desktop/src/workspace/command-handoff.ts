import type { JobRegistry } from '../../../../src/jobs.js';
import type {
  CommandExecution,
  CommandExecutionReceipt,
} from '../../../../src/command_process.js';
import type {
  CommandTerminalAvailable,
  CommandTerminalCommandReply,
  CommandTerminalResolution,
  CommandTerminalTarget,
} from '../../../workbench/src/command-terminal-target.js';
import type {
  TerminalManager,
  TerminalSnapshot,
  TerminalSignal,
} from './terminal.js';

export interface CommandTerminalSource {
  jobs?: JobRegistry;
  receipts?: () => readonly CommandExecutionReceipt[];
  terminals?: TerminalManager;
  workspaceId?: string;
}

export interface CommandTerminalAccess {
  /** The controller verifies actual session and task-ledger ownership first. */
  sourceFor(
    viewSessionId: string,
    sourceSessionId: string,
  ): CommandTerminalSource | undefined;
}

function object(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error(`invalid ${label}`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !allowed.includes(key)))
    throw Error(`invalid ${label} field`);
  return result;
}
function identity(value: unknown, label: string): string {
  // Provider call IDs are opaque: trimming could bind another call's identity.
  if (
    typeof value !== 'string' ||
    !value.length ||
    value.length > 500 ||
    value.includes('\0')
  )
    throw Error(`invalid ${label}`);
  return value;
}
function parseTarget(value: unknown): CommandTerminalTarget {
  const target = object(
    value,
    [
      'executionId',
      'epoch',
      'executionSessionId',
      'toolCallId',
      'userShellId',
      'origin',
      'terminal',
    ],
    'command target',
  );
  const terminal = object(target.terminal, ['id', 'epoch'], 'command terminal');
  const base = {
    executionId: identity(target.executionId, 'execution'),
    epoch: identity(target.epoch, 'execution epoch'),
    executionSessionId: identity(
      target.executionSessionId,
      'execution session',
    ),
    terminal: {
      id: identity(terminal.id, 'terminal'),
      epoch: identity(terminal.epoch, 'terminal epoch'),
    },
  };
  if (target.origin === 'user-shell') {
    if (target.toolCallId !== undefined)
      throw Error('human command target cannot include a tool call');
    return {
      ...base,
      origin: 'user-shell',
      userShellId: identity(target.userShellId, 'human command'),
    };
  }
  if (target.origin !== undefined || target.userShellId !== undefined)
    throw Error('invalid command target origin');
  return { ...base, toolCallId: identity(target.toolCallId, 'tool call') };
}
function targetFor(execution: CommandExecution): CommandTerminalTarget {
  const base = {
    executionId: execution.executionId,
    epoch: execution.epoch,
    executionSessionId: execution.executionSessionId,
    terminal: { id: execution.terminal!.id, epoch: execution.terminal!.epoch },
  };
  return execution.userShellId
    ? { ...base, origin: 'user-shell', userShellId: execution.userShellId }
    : { ...base, toolCallId: execution.toolCallId! };
}
function sameTarget(left: CommandTerminalTarget, right: CommandTerminalTarget) {
  return (
    left.executionId === right.executionId &&
    left.epoch === right.epoch &&
    left.executionSessionId === right.executionSessionId &&
    left.toolCallId === right.toolCallId &&
    left.userShellId === right.userShellId &&
    left.origin === right.origin &&
    left.terminal.id === right.terminal.id &&
    left.terminal.epoch === right.terminal.epoch
  );
}
interface ExecutionSource {
  execution: CommandExecution;
  current: boolean;
}
type CommandOriginIdentity = { toolCallId: string } | { userShellId: string };
const originFor = (target: CommandTerminalTarget): CommandOriginIdentity =>
  target.origin === 'user-shell'
    ? { userShellId: target.userShellId }
    : { toolCallId: target.toolCallId };
function originalExecution(
  source: CommandTerminalSource,
  sessionId: string,
  origin: CommandOriginIdentity,
): ExecutionSource | undefined {
  const human = 'userShellId' in origin;
  const current = human
    ? source.jobs?.executionForUserShell(sessionId, origin.userShellId)
    : source.jobs?.executionFor(sessionId, origin.toolCallId);
  const candidates = new Map<string, CommandExecution>();
  for (const receipt of source.receipts?.() ?? []) {
    if (
      receipt.executionSessionId !== sessionId ||
      (human
        ? receipt.userShellId !== origin.userShellId ||
          receipt.toolCallId !== undefined
        : receipt.toolCallId !== origin.toolCallId ||
          receipt.userShellId !== undefined)
    )
      continue;
    candidates.set(`${receipt.epoch}\0${receipt.executionId}`, {
      ...receipt,
      outputPath: '',
    });
  }
  if (current)
    candidates.set(`${current.epoch}\0${current.executionId}`, current);
  // Reused provider call IDs across stored executions are never guessed.
  if (candidates.size !== 1) return;
  const execution = [...candidates.values()][0]!;
  return {
    execution,
    current:
      !!current &&
      current.executionId === execution.executionId &&
      current.epoch === execution.epoch,
  };
}
interface Binding {
  source: CommandTerminalSource & {
    terminals: TerminalManager;
    workspaceId: string;
  };
  execution: CommandExecution;
  snapshot: TerminalSnapshot;
  resolution: CommandTerminalAvailable;
  current: boolean;
}
async function bind(
  source: CommandTerminalSource,
  viewSessionId: string,
  execution: CommandExecution,
  current: boolean,
): Promise<Binding | undefined> {
  if (
    !source.terminals ||
    !source.workspaceId ||
    (current && execution.epoch !== source.jobs?.runName) ||
    !execution.terminal ||
    (!execution.toolCallId && !execution.userShellId) ||
    (!!execution.toolCallId && !!execution.userShellId) ||
    execution.completion?.kind !== 'pty-group'
  )
    return;
  const snapshot = (
    await source.terminals.list(execution.executionSessionId)
  ).find((snapshot) => snapshot.id === execution.terminal!.id);
  if (
    !snapshot ||
    snapshot.epoch !== execution.terminal.epoch ||
    snapshot.owner !== execution.executionSessionId ||
    snapshot.sessionId !== execution.executionSessionId ||
    snapshot.managedCommand?.executionId !== execution.executionId ||
    snapshot.managedCommand.toolCallId !== execution.toolCallId ||
    snapshot.managedCommand.userShellId !== execution.userShellId ||
    snapshot.managedCommand.ownership !== 'pty-group' ||
    (current
      ? snapshot.managedCommand.executionEpoch !== undefined &&
        snapshot.managedCommand.executionEpoch !== execution.epoch
      : snapshot.managedCommand.executionEpoch !== execution.epoch)
  )
    return;
  if (
    snapshot.managedCommand.commandPid !== undefined &&
    snapshot.managedCommand.commandPid !== execution.pid
  )
    return;
  const live =
    ['starting', 'running', 'background'].includes(execution.status) &&
    ['running', 'stopping'].includes(snapshot.status);
  return {
    source: {
      ...source,
      terminals: source.terminals,
      workspaceId: source.workspaceId,
    },
    execution,
    current,
    snapshot,
    resolution: {
      available: true,
      target: targetFor(execution),
      workspaceId: source.workspaceId,
      capabilities: {
        read: true,
        input:
          current &&
          live &&
          snapshot.status === 'running' &&
          !execution.completion.controlledGroupEmpty,
        stop: current && live,
        addToDraft: viewSessionId === execution.executionSessionId,
      },
    },
  };
}

/** Resolve an existing original execution only. There is no runtime open or spawn. */
export async function resolveCommandTerminal(
  access: CommandTerminalAccess,
  viewSessionId: string,
  value: unknown,
): Promise<CommandTerminalResolution> {
  const request = object(
    value,
    ['sourceSessionId', 'toolCallId', 'userShellId'],
    'command resolution',
  );
  const sourceId = identity(request.sourceSessionId, 'source session');
  if (request.toolCallId !== undefined && request.userShellId !== undefined)
    throw Error('command resolution must use exactly one origin');
  const origin: CommandOriginIdentity =
    request.userShellId === undefined
      ? { toolCallId: identity(request.toolCallId, 'tool call') }
      : { userShellId: identity(request.userShellId, 'human command') };
  const source = access.sourceFor(viewSessionId, sourceId);
  if (!source) return { available: false, reason: 'not-found' };
  const original = originalExecution(source, sourceId, origin);
  if (!original) return { available: false, reason: 'unavailable' }; // missing or ambiguous remains unbound
  const { execution, current } = original;
  if (!execution.terminal || execution.completion?.kind !== 'pty-group')
    return { available: false, reason: 'not-native' };
  const binding = await bind(source, viewSessionId, execution, current);
  return binding?.resolution ?? { available: false, reason: 'stale' };
}

/** Every action checks the same ledger, execution and terminal identity again. */
export async function commandTerminalAction(
  access: CommandTerminalAccess,
  viewSessionId: string,
  value: unknown,
): Promise<CommandTerminalCommandReply> {
  const request = object(
      value,
      ['target', 'action', 'params'],
      'command action',
    ),
    target = parseTarget(request.target);
  const action = identity(request.action, 'command action');
  if (
    !['list', 'replay', 'write', 'resize', 'signal', 'close'].includes(action)
  )
    throw Error(
      'unsupported original command terminal action; create and restart are forbidden',
    );
  const source = access.sourceFor(viewSessionId, target.executionSessionId);
  if (!source) return { available: false, reason: 'not-found' };
  // A complete target can recheck its exact live Registry entry directly. Do
  // not walk a long stored conversation for every PTY replay/input message.
  const exact = source.jobs?.execution(target.executionId);
  const original =
    exact?.terminal &&
    exact.epoch === source.jobs?.runName &&
    sameTarget(target, targetFor(exact))
      ? { execution: exact, current: true }
      : originalExecution(source, target.executionSessionId, originFor(target));
  if (
    !original ||
    !original.execution.terminal ||
    !sameTarget(target, targetFor(original.execution))
  )
    return { available: false, reason: 'stale' };
  const { execution, current } = original;
  const binding = await bind(source, viewSessionId, execution, current);
  if (!binding) return { available: false, reason: 'stale' };
  if (!current && action !== 'list' && action !== 'replay')
    throw Error('historical original command terminals are read-only');
  const params = request.params ?? {};
  const owner = target.executionSessionId,
    id = target.terminal.id;
  let result: unknown;
  switch (action) {
    case 'list':
      object(params, [], 'command list');
      result = [binding.snapshot];
      break;
    case 'replay': {
      const options = object(
        params,
        ['afterSequence', 'limit'],
        'command replay',
      );
      result = await binding.source.terminals.replay(
        owner,
        id,
        options.afterSequence as number | undefined,
        options.limit as number | undefined,
      );
      break;
    }
    case 'write': {
      const options = object(params, ['data'], 'command input');
      if (!binding.resolution.capabilities.input)
        throw Error('the original command is no longer accepting input');
      if (typeof options.data !== 'string')
        throw Error('invalid command input');
      result = await binding.source.terminals.write(owner, id, options.data);
      break;
    }
    case 'resize': {
      const options = object(params, ['cols', 'rows'], 'command resize');
      if (!binding.resolution.capabilities.input)
        throw Error('the original command terminal is no longer running');
      result = await binding.source.terminals.resize(
        owner,
        id,
        options.cols as number,
        options.rows as number,
      );
      break;
    }
    case 'signal': {
      const options = object(params, ['signal'], 'command signal');
      if (
        typeof options.signal !== 'string' ||
        !['SIGINT', 'SIGTERM', 'SIGKILL'].includes(options.signal)
      )
        throw Error('invalid command signal');
      if (
        options.signal === 'SIGINT'
          ? !binding.resolution.capabilities.input
          : !binding.resolution.capabilities.stop
      )
        throw Error('the original command is no longer controllable');
      result = await binding.source.terminals.signal(
        owner,
        id,
        options.signal as TerminalSignal,
      );
      break;
    }
    case 'close':
      object(params, [], 'command stop');
      if (
        !binding.resolution.capabilities.stop &&
        !(
          execution.completion?.rootExit &&
          execution.completion.controlledGroupEmpty &&
          execution.completion.transportAndLogClosed
        )
      )
        throw Error(
          'original command stop is unconfirmed; inspect its recorded state',
        );
      result = await binding.source.terminals.close(owner, id);
      break;
  }
  const latest = current
    ? source.jobs?.execution(target.executionId)
    : execution;
  const after = latest && (await bind(source, viewSessionId, latest, current));
  return after
    ? { ...after.resolution, value: result }
    : { available: false, reason: 'stale' };
}

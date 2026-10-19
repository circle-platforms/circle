import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../../src/settings.js';
import { ScriptedModel } from '../../../../src/testing.js';
import {
  emptyUsage,
  type Message,
  type ModelRequest,
  type ModelResponse,
} from '../../../../src/types.js';
import { RuntimeController } from '../../src/runtime-controller.ts';
import type {
  RuntimeCommandName,
  RuntimeReply,
  RuntimeUpdate,
} from '../../src/runtime-protocol.ts';
import type { WorkspaceServiceEvent } from '../../src/workspace-protocol.ts';
import type { TaskRecord } from '../../src/workspace/task-store.ts';

const toolCallId = 'shared-call';
const parentPrompt = 'command terminal fixture: start the parent command';
const childPrompt = 'command terminal fixture: start the child command';
const files = {
  pid: 'actual-pid',
  parentPid: 'actual-parent-pid',
  shellPid: 'actual-shell-pid',
  starts: 'starts',
  input: 'actual-input',
} as const;
const supervisorPath = fileURLToPath(
  new URL('../../src/workspace/command-supervisor.mjs', import.meta.url),
);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const assistant = (tool_calls?: Message['tool_calls']): Message => ({
  id: randomUUID(),
  role: 'assistant',
  content: '',
  ...(tool_calls ? { tool_calls } : {}),
});

export async function until(
  check: () => boolean | Promise<boolean>,
  label = 'condition',
  timeout = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw Error(`command terminal controller fixture timed out: ${label}`);
    await delay(10);
  }
}

export type CommandTerminalFixtureChild = TaskRecord & {
  runtimeSessionId: string;
  worktree: string;
};

/** A real controller and task ledger; neither command identity nor child ownership is forged. */
export async function createCommandTerminalControllerFixture(
  t: TestContext,
  options: {
    native?: boolean;
    childAssistantContent?: string;
    commandRoot?: 'exec' | 'shell-child';
  } = {},
) {
  const root = await realpath(
      await mkdtemp(join(tmpdir(), 'circle-command-controller-')),
    ),
    home = join(root, 'home'),
    workspace = join(root, 'workspace'),
    data = join(root, 'data');
  let controller: RuntimeController | undefined;
  const releaseHolds = new Set<() => void>();
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = () =>
    (cleanupPromise ??= (async () => {
      // Begin normal shutdown first so the TaskService aborts workers before a
      // held completion can reach independent verification or a build.
      const closing = controller?.close();
      for (const release of releaseHolds) release();
      await closing;
      await rm(root, { recursive: true, force: true });
    })());
  t.after(cleanup);
  await Promise.all([mkdir(home), mkdir(workspace), mkdir(data)]);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', workspace, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', '--local', 'core.autocrlf', 'false');
  await writeFile(
    join(workspace, 'command-input.cjs'),
    String.raw`const fs = require('node:fs');
fs.appendFileSync('starts', 'once\n');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on('data', (bytes) => {
  fs.appendFileSync('actual-input', bytes);
  process.stdout.write('ECHO:');
  process.stdout.write(bytes);
});
process.stdin.resume();
console.log('READY ' + process.pid);
fs.writeFileSync('actual-pid', String(process.pid));
fs.writeFileSync('actual-parent-pid', String(process.ppid));
setInterval(() => {}, 1000);
`,
  );
  git('add', 'command-input.cjs');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'Create command fixture',
  );
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const launch = [
    `HOME=${quote(home)}`,
    `CIRCLE_HOME=${quote(home)}`,
    `CIRCLE_WORKBENCH_DATA_DIR=${quote(data)}`,
    ...(options.commandRoot === 'shell-child' ? [] : ['exec']),
    quote(process.execPath),
    quote('command-input.cjs'),
  ].join(' ');
  // The ordinary fixture intentionally makes Node the shell's root process.
  // A POSIX shell is otherwise free to fork it instead of optimizing to exec.
  // The continuation forces that distinct shell/child case on every POSIX host.
  const command =
    `printf '%s' "$$" > ${quote(files.shellPid)}; ${launch}` +
    (options.commandRoot === 'shell-child' ? '; :' : '');
  const hold = (request: ModelRequest): Promise<ModelResponse> =>
    new Promise((_resolve, reject) => {
      const finish = (reason: unknown) => {
        request.signal.removeEventListener('abort', abort);
        releaseHolds.delete(release);
        reject(reason);
      };
      const abort = () => finish(request.signal.reason);
      const release = () =>
        finish(
          request.signal.reason ??
            new DOMException('command terminal fixture released', 'AbortError'),
        );
      releaseHolds.add(release);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
    });
  const route = async (request: ModelRequest): Promise<ModelResponse> => {
    request.signal.throwIfAborted();
    const turnIndex = request.messages.findLastIndex(
      (message) => message.role === 'user' && !message.internal,
    );
    const turn = request.messages.slice(turnIndex);
    const prompt = turn[0]?.content;
    assert.ok(
      prompt === parentPrompt ||
        (prompt?.startsWith('Task ') && prompt.includes(childPrompt)),
      'only the explicit parent prompt or actual TaskService worker may run',
    );
    if (
      turn.some(
        (message) =>
          message.role === 'tool' && message.tool_call_id === toolCallId,
      )
    )
      return hold(request);
    return {
      message: {
        ...assistant([
          {
            id: toolCallId,
            name: 'execute',
            args: { command, timeout: 600, background: false },
          },
        ]),
        content: prompt?.includes(childPrompt)
          ? (options.childAssistantContent ?? '')
          : '',
      },
      usage: emptyUsage(),
    };
  };
  const model = new ScriptedModel(Array.from({ length: 64 }, () => route));
  const events: WorkspaceServiceEvent[] = [],
    updates: RuntimeUpdate[] = [];
  const controllerOptions = {
    home,
    userHome: home,
    workspace,
    dataFolder: data,
    model,
    workspaceTools: {
      runtimeExecutable: process.execPath,
      ...(options.native === false
        ? {}
        : { commandSupervisorPath: supervisorPath }),
      ghPath: 'unused',
    },
    emit: (update: RuntimeUpdate) => updates.push(update),
    emitWorkspaceEvent: (event: WorkspaceServiceEvent) => events.push(event),
  };
  let owner = new RuntimeController(controllerOptions);
  controller = owner;
  const parentId = owner.snapshot().activeSessionId;
  const call = (
    name: RuntimeCommandName,
    payload: Record<string, unknown> = {},
    sessionId = parentId,
  ): Promise<RuntimeReply> =>
    owner.dispatch({ id: randomUUID(), name, payload, sessionId });
  const serviceReply = (
    name: string,
    method: string,
    params: object = {},
    sessionId = parentId,
  ): Promise<RuntimeReply> =>
    call('workspace-service', { service: name, method, params }, sessionId);
  const service = async <T = unknown>(
    name: string,
    method: string,
    params: object = {},
    sessionId = parentId,
  ): Promise<T> => {
    const reply = await serviceReply(name, method, params, sessionId);
    assert.equal(reply.ok, true, reply.error);
    return reply.data as T;
  };
  const approve = async (sessionId: string) => {
    await until(
      () =>
        owner
          .snapshot()
          .interactions.some(
            (interaction) =>
              interaction.sessionId === sessionId &&
              interaction.kind === 'approval' &&
              interaction.callId === toolCallId &&
              interaction.status === 'pending',
          ),
      `command approval for ${sessionId}`,
    );
    const approval = owner
      .snapshot()
      .interactions.find(
        (interaction) =>
          interaction.sessionId === sessionId &&
          interaction.kind === 'approval' &&
          interaction.callId === toolCallId &&
          interaction.status === 'pending',
      )!;
    const reply = await call(
      'answer',
      { id: approval.id, revision: approval.revision, answer: 'approve' },
      sessionId,
    );
    assert.equal(reply.ok, true, reply.error);
  };
  const read = (directory: string, file: string) =>
    readFile(join(directory, file), 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      },
    );
  const ready = async (directory: string) => {
    await until(
      async () => Number(await read(directory, files.pid)) > 0,
      `actual command PID in ${directory}`,
    );
    return Number(await read(directory, files.pid));
  };
  const startParent = async () => {
    const reply = await call('prompt', { text: parentPrompt });
    assert.equal(reply.ok, true, reply.error);
    await approve(parentId);
    return { sessionId: parentId, workspace, pid: await ready(workspace) };
  };
  let latestChildId: string | undefined;
  const enqueueChild = async (id = randomUUID()): Promise<string> => {
    await service<TaskRecord[]>('tasks', 'enqueue', {
      operationId: randomUUID(),
      tasks: [
        {
          id,
          prompt: childPrompt,
          access: 'write',
          acceptanceCriteria: ['the original command remains addressable'],
        },
      ],
    });
    latestChildId = id;
    return id;
  };
  const waitForChild = async (
    id = latestChildId,
  ): Promise<CommandTerminalFixtureChild> => {
    assert.ok(
      id,
      'enqueue a child before waiting for its actual ledger record',
    );
    let child: TaskRecord | undefined;
    await until(async () => {
      child = (await service<TaskRecord[]>('tasks', 'list')).find(
        (record) => record.spec.id === id,
      );
      return !!child?.runtimeSessionId && !!child.worktree;
    }, `actual child runtime and worktree for ${id}`);
    assert.ok(child?.runtimeSessionId);
    assert.ok(child.worktree);
    assert.equal(child.spec.sessionId, parentId);
    assert.notEqual(child.runtimeSessionId, parentId);
    assert.notEqual(child.worktree, workspace);
    return child as CommandTerminalFixtureChild;
  };
  const startChild = async (id = latestChildId) => {
    const child = await waitForChild(id);
    await approve(child.runtimeSessionId);
    const pid = await ready(child.worktree);
    return {
      ...child,
      sessionId: child.runtimeSessionId,
      workspace: child.worktree,
      pid,
    };
  };
  const restart = async () => {
    await owner.close();
    owner = new RuntimeController(controllerOptions);
    controller = owner;
    return owner;
  };
  return {
    get controller() {
      return owner;
    },
    restart,
    model,
    root,
    home,
    workspace,
    data,
    parentId,
    toolCallId,
    files,
    command,
    events,
    updates,
    call,
    service,
    serviceReply,
    startParent,
    enqueueChild,
    waitForChild,
    startChild,
    approve,
    ready,
    read,
    until,
    cleanup,
  };
}

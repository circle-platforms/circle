import { setTimeout as delay } from 'node:timers/promises';
import type { Tool, ToolContext } from '../../../../src/types.js';
import type { TaskRecord } from './collaboration.js';

/** The controller captures an authorized workspace. Arguments never select it. */
export interface CollaborationToolService {
  call(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
}
export interface CollaborationToolOptions {
  sessionId: string | (() => string);
  service(): CollaborationToolService | Promise<CollaborationToolService>;
}
const id = { type: 'string', minLength: 1, maxLength: 200 };
const taskSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id,
    parentId: id,
    baseline: id,
    prompt: { type: 'string', minLength: 1, maxLength: 1024 * 1024 },
    access: { type: 'string', enum: ['write', 'readonly'] },
    acceptanceCriteria: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    dependencies: { type: 'array', uniqueItems: true, items: id },
    resource: { type: 'string', enum: ['agent', 'build', 'ui', 'browser'] },
  },
  required: ['id', 'prompt', 'access', 'acceptanceCriteria'],
};

const analysisTaskSchema = {
  ...taskSchema,
  properties: {
    ...taskSchema.properties,
    access: { type: 'string', const: 'readonly' },
    resource: { type: 'string', const: 'agent' },
  },
  required: ['id', 'prompt', 'acceptanceCriteria'],
};

/** Read-effect delegation cannot inherit write or resource authority from input. */
function analysisTasks(
  args: Record<string, unknown>,
): Record<string, unknown>[] {
  if (Object.keys(args).some((key) => !['operationId', 'tasks'].includes(key)))
    throw Error('analysis cannot select task authority or execution options');
  if (
    typeof args.operationId !== 'string' ||
    !args.operationId.trim() ||
    args.operationId.length > 200
  )
    throw Error('analysis operationId is required');
  if (
    !Array.isArray(args.tasks) ||
    !args.tasks.length ||
    args.tasks.length > 1000
  )
    throw Error('analysis tasks are required');
  const allowed = new Set(Object.keys(taskSchema.properties));
  return args.tasks.map((input: unknown) => {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw Error('invalid analysis task');
    const task = input as Record<string, unknown>;
    if (Object.keys(task).some((key) => !allowed.has(key)))
      throw Error('analysis task contains ungranted fields');
    if (task.access !== undefined && task.access !== 'readonly')
      throw Error('analysis tasks must be readonly');
    if (task.resource !== undefined && task.resource !== 'agent')
      throw Error('analysis tasks use only the agent resource');
    return { ...task, access: 'readonly', resource: 'agent' };
  });
}

/** Install on the visible parent runtime only. Harness policy performs approval
 * before execution tools, plan mode admits only restricted read-only delegation,
 * and subagents never receive these tools.
 */
export function createCollaborationTools(
  options: CollaborationToolOptions,
): Tool[] {
  async function owner(context: ToolContext) {
    context.signal.throwIfAborted();
    const expected =
      typeof options.sessionId === 'function'
        ? options.sessionId()
        : options.sessionId;
    if (context.sessionId !== expected)
      throw Error('task tools belong to another parent conversation');
    const service = await options.service();
    context.signal.throwIfAborted();
    return {
      call: (method: string, params: Record<string, unknown> = {}) =>
        service.call(expected, method, params),
    };
  }
  const base = { subagents: false, variables: 'plain' as const };
  return [
    {
      ...base,
      name: 'native_tasks_enqueue',
      effect: 'execute',
      description:
        'Create a dependency graph of native agent tasks. Write tasks receive isolated Git worktrees; readonly tasks retain a pinned baseline. Supply concrete acceptance criteria and stable operationId so a retried request cannot duplicate work. Tasks start automatically; this result is scheduling state, not evidence of completion. Child tasks cannot spawn another graph. During plan mode use native_tasks_analyze for read-only parallel analysis instead; this execution tool is not permitted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operationId: id,
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: taskSchema,
          },
        },
        required: ['operationId', 'tasks'],
      },
      approvalFacts: (args) => ({
        task_count: Array.isArray(args.tasks) ? args.tasks.length : 0,
        write_tasks: Array.isArray(args.tasks)
          ? args.tasks.filter(
              (task) => (task as { access?: unknown })?.access === 'write',
            ).length
          : 0,
      }),
      async run(args, context) {
        const service = await owner(context);
        const tasks = (await service.call('enqueue', {
          operationId: args.operationId,
          tasks: args.tasks,
        })) as TaskRecord[];
        const artifacts = (
          await Promise.all(
            tasks.map((task) =>
              service.call('artifacts', { id: task.spec.id }),
            ),
          )
        ).flat();
        return JSON.stringify({ tasks, artifacts });
      },
    },
    {
      ...base,
      name: 'native_tasks_analyze',
      effect: 'read',
      description:
        'During planning, split independent investigation, code reading, diagnosis or review into parallel read-only native agent tasks. Every task is forced to readonly access and the agent resource at a pinned baseline; write tools, commands, builds, browser/UI execution and nested delegation are unavailable. Do not supply workspace, session, executor, tool, permission or resource overrides. Include concrete acceptance criteria and a stable operationId. This returns scheduling state; use native_tasks_wait or native_tasks_list for actual results and artifacts. Use native_tasks_enqueue after leaving plan mode when implementation or execution is needed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          operationId: id,
          tasks: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: analysisTaskSchema,
          },
        },
        required: ['operationId', 'tasks'],
      },
      async run(args, context) {
        const inputs = analysisTasks(args);
        const service = await owner(context);
        const tasks = (await service.call('enqueue', {
          operationId: args.operationId,
          tasks: inputs,
        })) as TaskRecord[];
        const artifacts = (
          await Promise.all(
            tasks.map((task) =>
              service.call('artifacts', { id: task.spec.id }),
            ),
          )
        ).flat();
        return JSON.stringify({ tasks, artifacts });
      },
    },
    {
      ...base,
      name: 'native_tasks_list',
      effect: 'read',
      description:
        'Read actual native task IDs, dependency state, attempts, worktrees, verification results and artifact metadata in this authorized workspace. A task that needs review has not passed acceptance.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      async run(_args, context) {
        const service = await owner(context);
        const [tasks, artifacts, limits] = await Promise.all([
          service.call('list'),
          service.call('artifacts'),
          service.call('settings'),
        ]);
        return JSON.stringify({ tasks, artifacts, limits });
      },
    },
    {
      ...base,
      name: 'native_tasks_cancel',
      effect: 'execute',
      description:
        'Cancel one native task and await its cleanup. This does not merge or remove its worktree; dependent tasks may become blocked.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id },
        required: ['id'],
      },
      async run(args, context) {
        const service = await owner(context);
        const task = await service.call('cancel', { id: args.id });
        const artifacts = await service.call('artifacts', { id: args.id });
        return JSON.stringify({ task, artifacts });
      },
    },
    {
      ...base,
      name: 'native_tasks_retry',
      effect: 'execute',
      description:
        'Retry an eligible failed native task with a stable operationId. Unknown operation outcomes require review first; do not blindly repeat the same failed approach.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { id, operationId: id },
        required: ['id', 'operationId'],
      },
      async run(args, context) {
        const service = await owner(context);
        return JSON.stringify({
          task: await service.call('retry', {
            id: args.id,
            operationId: args.operationId,
          }),
          artifacts: await service.call('artifacts', { id: args.id }),
        });
      },
    },
    {
      ...base,
      name: 'native_tasks_events',
      effect: 'read',
      description:
        'Read persisted native collaboration events after a cursor. The event cursor is separate from terminal or workspace stream sequence numbers. Use returned artifact IDs and concrete verification evidence.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          cursor: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 1000 },
        },
      },
      async run(args, context) {
        const service = await owner(context);
        return JSON.stringify({
          events: await service.call('events', {
            cursor: args.cursor ?? 0,
            limit: args.limit ?? 256,
          }),
        });
      },
    },
    {
      ...base,
      name: 'native_tasks_wait',
      effect: 'read',
      description:
        'Wait up to 30 seconds for one of the named native tasks to reach a terminal state. Returns real task states and artifacts; a timeout does not mean success or failure.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ids: { type: 'array', minItems: 1, uniqueItems: true, items: id },
          timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 },
        },
        required: ['ids'],
      },
      async run(args, context) {
        const service = await owner(context);
        const ids = args.ids as string[];
        const timeout = Number(args.timeoutMs ?? 30000);
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.some((id) => typeof id !== 'string') ||
          !Number.isSafeInteger(timeout) ||
          timeout < 0 ||
          timeout > 30000
        )
          throw Error('invalid task wait request');
        const end = Date.now() + timeout;
        let tasks: TaskRecord[] = [];
        for (;;) {
          context.signal.throwIfAborted();
          const all = (await service.call('list')) as TaskRecord[];
          tasks = all.filter((task) => ids.includes(task.spec.id));
          if (tasks.length !== ids.length)
            throw Error('task not found in this workspace');
          if (
            tasks.some((task) =>
              [
                'succeeded',
                'failed',
                'blocked',
                'cancelled',
                'interrupted',
                'needs_review',
              ].includes(task.state),
            ) ||
            Date.now() >= end
          )
            break;
          await delay(Math.min(100, end - Date.now()), undefined, {
            signal: context.signal,
          });
        }
        return JSON.stringify({
          tasks,
          artifacts: (
            await Promise.all(
              ids.map((id) => service.call('artifacts', { id })),
            )
          ).flat(),
          timedOut: !tasks.some((task) =>
            [
              'succeeded',
              'failed',
              'blocked',
              'cancelled',
              'interrupted',
              'needs_review',
            ].includes(task.state),
          ),
        });
      },
    },
  ];
}

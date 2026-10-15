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

/** Install on the visible parent runtime only. Harness policy performs approval
 * before run(), plan mode rejects execution, and subagents never receive these.
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
        'Create a dependency graph of native agent tasks. Write tasks receive isolated Git worktrees; readonly tasks retain a pinned baseline. Supply concrete acceptance criteria and stable operationId so a retried request cannot duplicate work. Tasks start automatically; this result is scheduling state, not evidence of completion. Child tasks cannot spawn another graph.',
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

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatModel, Message, ModelNotice, Tool, Usage } from './types.js';
import { CheckpointStore, type ContextState } from './checkpoint_store.js';
import type { Todo } from './tools.js';
import {
  nextPruneState,
  pruneMessages,
  type PruneOptions,
} from './middleware/tool_result_prune.js';
import { planReminder } from './middleware/plan_tail.js';
import { loopReminder } from './middleware/loop_guard.js';
import { isRecord } from './settings.js';
import type { CompactionEvent } from './compaction.js';
import {
  runningJobReminder,
  pollingJobReminder,
} from './middleware/job_notice.js';
import type { Job } from './jobs.js';
import {
  messageTokenEstimate,
  requestBudget,
  BudgetExceeded,
} from './request_budget.js';
import { CompactionEngine, type CompactionFrame } from './compaction_engine.js';
// When a request would carry more images and PDFs than MEDIA_LIMIT, the older ones are left
// out down to the newest that fit MEDIA_KEEP, all in one go, so the requests after stay the
// same (and cached) until they fill up again. The newest message keeps its own whatever size.
export const MEDIA_LIMIT = { count: 8, bytes: 16 * 1024 * 1024 };
export const MEDIA_KEEP = { count: 3, bytes: 8 * 1024 * 1024 };
export function nextMediaState(
  messages: Message[],
  state: ContextState,
): ContextState {
  const dropped = new Set(state.droppedMedia ?? []);
  const carrying = messages.filter(
    (message) => message.attachments?.length && !dropped.has(message.id),
  );
  const bytesOf = (message: Message) =>
    message.attachments!.reduce((sum, item) => sum + item.data.length, 0);
  const count = carrying.reduce(
    (sum, message) => sum + message.attachments!.length,
    0,
  );
  const bytes = carrying.reduce((sum, message) => sum + bytesOf(message), 0);
  if (count <= MEDIA_LIMIT.count && bytes <= MEDIA_LIMIT.bytes) return state;
  let keptCount = 0;
  let keptBytes = 0;
  let full = false;
  const before = dropped.size;
  for (const message of [...carrying].reverse()) {
    const size = bytesOf(message);
    full ||=
      keptCount > 0 &&
      (keptCount + message.attachments!.length > MEDIA_KEEP.count ||
        keptBytes + size > MEDIA_KEEP.bytes);
    if (full) dropped.add(message.id);
    else {
      keptCount += message.attachments!.length;
      keptBytes += size;
    }
  }
  // Over the limit with the newest message alone: nothing to leave out, nothing to store
  if (dropped.size === before) return state;
  return { ...state, droppedMedia: [...dropped] };
}
export interface ContextOptions {
  readOnly?: () => boolean;
  runningJobs?: (sessionId: string) => Job[];
  contextWindow?: number;
  autoCompact?: boolean;
  offloadChars?: number;
  prune?: PruneOptions;
  notice?: (event: ModelNotice) => void;
  progress?: (event: CompactionEvent) => void;
  priceUsage?: (
    model: string,
    usage: Usage,
  ) => import('./pricing.js').PriceReceipt;
}
export function messageTokens(messages: Message[]): number {
  return messageTokenEstimate(messages);
}
export function restoredTodos(messages: Message[]): Todo[] {
  const completed = new Set(
    messages
      .filter(
        (message) => message.role === 'tool' && message.status !== 'error',
      )
      .map((message) => message.tool_call_id),
  );
  for (const message of [...messages].reverse())
    for (const call of [...(message.tool_calls ?? [])].reverse())
      if (
        call.name === 'write_todos' &&
        completed.has(call.id) &&
        Array.isArray(call.args.todos)
      ) {
        return call.args.todos
          .filter(isRecord)
          .filter(
            (todo) =>
              typeof todo.content === 'string' &&
              ['pending', 'in_progress', 'completed'].includes(
                String(todo.status),
              ),
          )
          .map((todo) => ({
            content: String(todo.content),
            status: todo.status as Todo['status'],
          }));
      }
  return [];
}
export function restoredPlanMode(messages: Message[]): boolean {
  for (const message of [...messages].reverse())
    if (message.role === 'user' && message.internal === 'mode-boundary') {
      const match = /^\[Circle system\] Plan mode is now (ON|OFF)\./.exec(
        message.content,
      );
      if (match) return match[1] === 'ON';
    }
  return false;
}
export class ContextManager {
  readonly compactor: CompactionEngine;
  constructor(
    readonly store: CheckpointStore,
    readonly root: string,
    readonly options: ContextOptions = {},
  ) {
    this.compactor = new CompactionEngine(
      store,
      root,
      (id) => this.project(id),
      options,
    );
  }
  private recoverArtifacts(
    sessionId: string,
    raw: Message[],
    state: ContextState,
  ): void {
    const restore = (virtual: string, body: string): void => {
      if (
        !/^\/(large_tool_results|conversation_history)\/[a-f0-9]{24}\.(txt|jsonl)$/.test(
          virtual,
        )
      )
        throw new Error('invalid context artifact path');
      const path = join(this.root, virtual.slice(1));
      if (existsSync(path)) {
        if (!readFileSync(path).equals(Buffer.from(body)))
          throw new Error('context artifact does not match raw history');
        return;
      }
      mkdirSync(join(this.root, virtual.split('/')[1]!), { recursive: true });
      writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
    };
    for (const message of raw) {
      const path = state.offloaded[message.id];
      if (path) restore(path, message.content);
    }
    if (state.summary?.historyPath) {
      const cutoff = this.store.summaryCutoffIndex(sessionId, state.summary);
      if (cutoff >= 0)
        restore(
          state.summary.historyPath,
          raw
            .slice(0, cutoff + 1)
            .map((message) => JSON.stringify(message))
            .join('\n') + '\n',
        );
    }
  }
  private offload(
    messages: Message[],
    state: ContextState,
    sessionId: string,
  ): ContextState {
    let next = state;
    const changed: string[] = [];
    for (const message of messages) {
      if (
        message.role !== 'tool' ||
        ['question', 'skill'].includes(message.name || '') ||
        state.offloaded[message.id] ||
        Array.from(message.content).length <=
          (this.options.offloadChars ?? 80000)
      )
        continue;
      const name =
        createHash('sha256')
          .update(sessionId + ':' + message.id)
          .digest('hex')
          .slice(0, 24) + '.txt';
      const folder = join(this.root, 'large_tool_results');
      mkdirSync(folder, { recursive: true });
      const path = join(folder, name);
      if (existsSync(path)) {
        if (!readFileSync(path).equals(Buffer.from(message.content)))
          throw new Error('offloaded tool output does not match raw history');
      } else writeFileSync(path, message.content, { mode: 0o600, flag: 'wx' });
      if (next === state) next = structuredClone(state);
      next.offloaded[message.id] = '/large_tool_results/' + name;
      changed.push(message.id);
    }
    if (changed.length) {
      const first = messages.findIndex((message) =>
        changed.includes(message.id),
      );
      next.stripThinkingIds = [
        ...new Set([
          ...next.stripThinkingIds,
          ...messages
            .slice(first + 1)
            .filter((message) => message.role === 'assistant')
            .map((message) => message.id),
        ]),
      ];
    }
    return next;
  }
  project(sessionId: string): Message[] {
    const state = this.store.contextState(sessionId);
    return this.projectWith(this.store.projectedMessages(sessionId), state);
  }
  private projectWith(messages: Message[], state: ContextState): Message[] {
    const droppedMedia = new Set(state.droppedMedia ?? []);
    return pruneMessages(
      messages.map((message) => {
        if (droppedMedia.has(message.id) && message.attachments?.length)
          message = {
            ...message,
            attachments: undefined,
            content: `${message.content}\n\n[${message.attachments.map((item) => item.filename).join(', ')} left out of this request to make room for newer images. Read the file or call the tool again if you need to see it.]`,
          };
        const path = state.offloaded[message.id];
        if (message.role !== 'tool' || !path) return message;
        return {
          ...message,
          content: `Tool output is too large to include here. Full output saved at ${path}. Use read_file with offset and limit to recover it.\n\n${Array.from(message.content).slice(0, 1600).join('')}\n…`,
        };
      }),
      state,
    );
  }
  async prepare(
    sessionId: string,
    model: ChatModel,
    system: string,
    tools: Tool[],
    signal: AbortSignal,
    subagent = false,
  ): Promise<Message[]> {
    signal.throwIfAborted();
    const raw = this.store.messages(sessionId);
    const visible = this.store.projectedMessages(sessionId);
    const reminders = [
      planReminder(raw, visible, restoredTodos(raw), subagent),
      loopReminder(raw),
      ...(!subagent
        ? [pollingJobReminder(this.options.runningJobs?.(sessionId) ?? [], raw)]
        : []),
    ].filter((message): message is Message => message !== undefined);
    if (reminders.length) this.store.append(sessionId, reminders);
    let state = this.store.contextState(sessionId);
    const messages = this.store.projectedMessages(sessionId);
    this.recoverArtifacts(sessionId, this.store.messages(sessionId), state);
    const offloaded = this.offload(messages, state, sessionId);
    const pruned = nextPruneState(
      this.projectWith(messages, offloaded),
      offloaded,
      this.options.prune,
    );
    const next = nextMediaState(this.projectWith(messages, pruned), pruned);
    if (next !== state) {
      this.store.setContextState(sessionId, next);
      state = next;
    }
    let projected = this.project(sessionId);
    const budget = requestBudget(
      model,
      { system, tools, messages: projected },
      this.options.contextWindow,
    );
    const estimate = budget.input;
    if (
      (this.options.autoCompact ?? true) &&
      (estimate >= budget.window * 0.85 || !budget.fits)
    ) {
      await this.compact(sessionId, model, signal, '', {
        system,
        tools,
        trigger: estimate >= budget.window * 0.85 ? 'auto' : 'overflow',
      });
      projected = this.project(sessionId);
      const after = requestBudget(
        model,
        { system, tools, messages: projected },
        this.options.contextWindow,
      );
      if (!after.fits) throw new BudgetExceeded(after);
    }
    if (!subagent && this.store.contextState(sessionId).summary) {
      const reminder = runningJobReminder(
        this.options.runningJobs?.(sessionId) ?? [],
        projected,
      );
      if (reminder) {
        this.store.append(sessionId, [reminder]);
        projected = this.project(sessionId);
      }
    }
    return projected;
  }
  compact(
    sessionId: string,
    model: ChatModel,
    signal: AbortSignal,
    hint = '',
    frame: CompactionFrame = {},
  ): Promise<string> {
    return this.compactor.compact(sessionId, model, signal, hint, frame);
  }
}

import type { ModelCompletion, Usage } from './types.js';
import type { PriceReceipt } from './pricing.js';
import type { RequestBudgetSnapshot } from './request_budget.js';

export type CompactionPhase =
  | 'start'
  | 'saving'
  | 'saved'
  | 'summarizing'
  | 'chunks'
  | 'summarized'
  | 'done'
  | 'error';
export interface CompactionEvent {
  sessionId: string;
  phase: CompactionPhase;
  trigger: 'auto' | 'overflow' | 'tool';
  chunks?: number;
  tokens_before?: number;
  tokens_after?: number;
  summarized?: number;
  kept?: number;
  file?: string;
  seconds?: number;
  message?: string;
  snapshot?: CompactionSnapshot;
  /** One settled physical request; also emitted for unsuccessful summaries. */
  attempt?: CompactionAttempt;
}
const stages = {
  start: 'starting',
  saving: 'saving history',
  saved: 'history saved',
  summarizing: 'summarizing',
  summarized: 'summarized',
};
export class CompactionProgress {
  stage = 'starting';
  saved = false;
  summarized = false;
  chunks = 0;
  readonly started = Date.now();
  snapshot?: CompactionSnapshot;
  constructor(readonly trigger: CompactionEvent['trigger']) {}
  apply(event: CompactionEvent): void {
    if (event.snapshot) {
      this.snapshot = event.snapshot;
      this.stage = event.snapshot.stage;
    }
    if (event.phase === 'saved') this.saved = true;
    if (event.phase === 'summarized') this.summarized = true;
    if (event.phase === 'chunks')
      this.chunks = Math.max(this.chunks, event.chunks ?? 0);
    else if (event.phase in stages)
      this.stage = stages[event.phase as keyof typeof stages];
  }
  get label(): string {
    return this.trigger === 'tool' ? 'compacting' : 'auto-compacting';
  }
  fraction(): number {
    if (this.snapshot)
      return this.snapshot.status === 'succeeded'
        ? 1
        : Math.min(
            0.9,
            this.snapshot.sourceSize
              ? (this.snapshot.covered / this.snapshot.sourceSize) * 0.9
              : 0,
          );
    return Math.min(
      1,
      0.05 +
        (this.saved ? 0.1 : 0) +
        0.85 * (this.summarized ? 1 : 1 - Math.exp(-this.chunks / 400)),
    );
  }
  elapsed(now = Date.now()): number {
    return Math.max(
      0,
      (now - (this.snapshot?.startedAt ?? this.started)) / 1000,
    );
  }
}

export function compactionNotice(snapshot: CompactionSnapshot): string {
  const label = snapshot.trigger === 'tool' ? 'compaction' : 'auto-compaction';
  const unreported = snapshot.unknownCalls ? ' · usage unreported' : '';
  const usage =
    snapshot.trigger === 'tool' ? ' · ' + compactionUsage(snapshot) : '';
  if (snapshot.status === 'succeeded')
    return (
      compactionDone({
        sessionId: snapshot.sessionId,
        trigger: snapshot.trigger,
        phase: 'done',
        tokens_before: snapshot.tokensBefore,
        tokens_after: snapshot.tokensAfter,
        summarized: snapshot.summarized,
        kept: snapshot.kept,
        file: snapshot.historyPath,
        seconds: (snapshot.updatedAt - snapshot.startedAt) / 1000,
      }) +
      usage +
      unreported
    );
  if (snapshot.status === 'cancelled' || snapshot.status === 'interrupted')
    return `${label} interrupted; completed parts saved${usage}${unreported}`;
  return `${label} failed: ${snapshot.error ?? 'summary did not complete'}${usage}${unreported}`;
}
export function compactionUsage(snapshot: CompactionSnapshot): string {
  const show = (n: number) => {
    if (snapshot.unknownCalls && !n) return 'N/A';
    const text = n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : tokens(n);
    return text + (snapshot.unknownCalls ? '+' : '');
  };
  return `↑ ${show(snapshot.usage.input_tokens)} · ↓ ${show(snapshot.usage.output_tokens)}`;
}
const tokens = (n?: number): string =>
  n === undefined ? '?' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
export function compactionDone(event: CompactionEvent): string {
  return `${event.trigger === 'tool' ? 'compacted' : 'auto-compacted'} · ~${tokens(event.tokens_before)} → ~${tokens(event.tokens_after)} tokens · summarized ${event.summarized ?? '?'} messages, kept ${event.kept ?? '?'}${event.seconds !== undefined ? ` · ${event.seconds.toFixed(0)}s` : ''}${event.file ? ` · history: ${event.file}` : ''}`;
}
export interface CompactionSnapshot {
  operationId: string;
  ownerProcessId?: number;
  sessionId: string;
  branchHead: string;
  turnId?: string;
  trigger: 'auto' | 'overflow' | 'tool';
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  stage: 'saving' | 'summarizing' | 'merging' | 'recovering' | 'done';
  startedAt: number;
  updatedAt: number;
  completed: number;
  total: number;
  covered: number;
  sourceSize: number;
  attempts: number;
  recoveries: number;
  usage: Usage;
  unknownCalls: number;
  liveTokens: number;
  budget?: RequestBudgetSnapshot;
  error?: string;
  failureCode?: string;
  recoverable: boolean;
  historyPath?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  summarized?: number;
  kept?: number;
}
export interface CompactionOperation {
  snapshot: CompactionSnapshot;
  sourceHash: string;
  cutoffId: string;
  policy: string;
  nodes?: string[];
}
export interface CompactionRange {
  messageId: string;
  start: number;
  end: number;
}
export interface CompactionNode {
  key: string;
  sourceKey: string;
  text: string;
  ranges: CompactionRange[];
  children: string[];
  createdAt: number;
}
export interface CompactionAttempt {
  id: string;
  operationId: string;
  requestHash: string;
  nodeKey: string;
  model: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  budget?: RequestBudgetSnapshot;
  usage?: Usage;
  usageComplete?: boolean;
  cost?: PriceReceipt;
  completion?: ModelCompletion;
  error?: string;
  failureCode?: string;
  providerError?: import('./model_completion.js').ModelCompletionFailure['providerError'];
  createdAt: number;
}
export interface CompactionArchive {
  operations: CompactionOperation[];
  attempts: CompactionAttempt[];
  nodes: CompactionNode[];
}

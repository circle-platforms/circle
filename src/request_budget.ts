import { createHash } from 'node:crypto';
import type { ChatModel, Message, ModelRequest } from './types.js';
import { tokenLen } from './middleware/tool_result_prune.js';
import { ModelCompletionFailure } from './model_completion.js';

export type RequestFrame = Pick<
  ModelRequest,
  'system' | 'messages' | 'tools' | 'maxTokens' | 'effort'
>;
export interface BudgetLimits {
  model: string;
  identity: string;
  window: number;
  inputLimit: number;
  outputLimit?: number;
  windowKnown: boolean;
  output: number;
  margin: number;
}
export interface RequestBudgetSnapshot extends BudgetLimits {
  estimate: number;
  input: number;
  factor: number;
  availableInput: number;
  fits: boolean;
}
const positive = (value?: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function resolveBudget(
  model: ChatModel,
  windowOverride?: number,
): BudgetLimits {
  const facts = model.modelFacts;
  const fallback = Number(process.env.CIRCLE_CONTEXT_WINDOW || 128000);
  const window = positive(windowOverride)
    ? Math.min(
        windowOverride,
        positive(model.contextWindow) ? model.contextWindow : Infinity,
      )
    : positive(model.contextWindow)
      ? model.contextWindow
      : positive(fallback)
        ? fallback
        : 128000;
  const inputLimit = Math.min(
    window,
    model.inputLimit ?? facts?.inputLimit ?? window,
  );
  const outputLimit = model.outputLimit ?? facts?.outputLimit;
  const output = Math.max(
    1,
    Math.min(
      model.outputBudget ?? (positive(outputLimit) ? 32000 : 4096),
      Math.floor(window / 4),
      outputLimit ?? Infinity,
    ),
  );
  return {
    model: model.model,
    identity: model.budgetIdentity ?? model.model,
    window,
    inputLimit,
    outputLimit,
    windowKnown:
      positive(windowOverride) ||
      (facts?.windowKnown ?? positive(model.contextWindow)),
    output,
    margin: Math.min(16384, Math.max(256, Math.ceil(inputLimit * 0.1))),
  };
}

/** One representation of each message, never both provider blocks and tool_calls. */
export function messageTokenEstimate(messages: Message[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      4 +
      (message.provider_content
        ? tokenLen(JSON.stringify(message.provider_content))
        : tokenLen(message.content + (message.thinking ?? '')) +
          tokenLen(JSON.stringify(message.tool_calls ?? []))) +
      (message.attachments ?? []).reduce(
        (n, item) =>
          n +
          (item.kind === 'image'
            ? 2048
            : Math.max(8192, Math.ceil(item.data.length / 4))),
        0,
      ),
    0,
  );
}

/** Count the serialized provider frame, replacing opaque binary media with its estimate. */
export function providerInputEstimate(frame: unknown): number {
  let media = 0;
  const walk = (value: unknown, mediaAllowed = false): unknown => {
    if (typeof value === 'function') return undefined;
    if (Array.isArray(value))
      return value.map((item) => walk(item, mediaAllowed));
    if (!value || typeof value !== 'object') return value;
    const part = value as Record<string, unknown>;
    if (mediaAllowed) {
      if (part.type === 'image' && part.source) {
        media += 2048;
        return { type: 'image' };
      }
      if (part.type === 'document' && part.source) {
        const source = part.source as { data?: string };
        media += Math.max(8192, Math.ceil((source.data?.length ?? 0) / 4));
        return { type: 'document' };
      }
      if (part.type === 'image_url' && part.image_url) {
        media += 2048;
        return { type: 'image_url' };
      }
      if (part.type === 'file' && part.file) {
        const file = part.file as { file_data?: string };
        media += Math.max(8192, Math.ceil((file.file_data?.length ?? 0) / 4));
        return { type: 'file' };
      }
    }
    return Object.fromEntries(
      Object.entries(part).map(([key, item]) => [
        key,
        // A tool's JSON can itself contain objects named "image". It is data,
        // not a provider media block; never replace it by a fixed media estimate.
        part.type === 'tool_use' && key === 'input'
          ? item
          : walk(
              item,
              key === 'content' &&
                (typeof part.role === 'string' || part.type === 'tool_result'),
            ),
      ]),
    );
  };
  return tokenLen(JSON.stringify(walk(frame)) ?? '') + media;
}

export function requestBudget(
  model: ChatModel,
  request: RequestFrame,
  windowOverride?: number,
): RequestBudgetSnapshot {
  const limits = resolveBudget(model, windowOverride);
  const output = request.maxTokens ?? limits.output;
  const estimate = model.estimateInput
    ? model.estimateInput(request)
    : tokenLen(request.system) +
      providerInputEstimate(request.tools) +
      messageTokenEstimate(request.messages);
  return budgetForEstimate(model, limits, estimate, output);
}

export function budgetForEstimate(
  model: ChatModel,
  limits: BudgetLimits,
  estimate: number,
  output = limits.output,
): RequestBudgetSnapshot {
  const reportedFactor = model.inputEstimateFactor;
  const factor =
    reportedFactor !== undefined && Number.isFinite(reportedFactor)
      ? Math.max(1.5, reportedFactor)
      : 1.5;
  const input = Math.ceil(estimate * factor);
  const availableInput =
    Math.min(limits.inputLimit, limits.window - output) - limits.margin;
  return {
    ...limits,
    output,
    estimate,
    input,
    factor,
    availableInput,
    fits:
      output > 0 &&
      output <= (limits.outputLimit ?? Infinity) &&
      input <= availableInput,
  };
}

export class BudgetExceeded extends ModelCompletionFailure {
  constructor(readonly budget: RequestBudgetSnapshot) {
    super(
      budget.output > (budget.outputLimit ?? Infinity)
        ? 'output_limit'
        : 'context_limit',
    );
    this.message =
      this.code === 'output_limit'
        ? 'requested output exceeds the model output limit'
        : 'request does not fit the model context budget';
  }
}

/** A bounded recovery allowance shared by the compactor and transport guard. */
export class RecoveryBudget {
  used = 0;
  constructor(
    readonly limit = 8,
    private readonly changed?: (used: number) => void,
  ) {}
  take(): void {
    if (this.used >= this.limit)
      throw new Error('compaction recovery budget exhausted');
    this.used++;
    this.changed?.(this.used);
  }
}

export const contentHash = (value: unknown): string =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');

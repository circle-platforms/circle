import type { Message, ModelCompletion } from './types.js';

export type ModelCompletionFailureCode =
  | 'empty_response'
  | 'output_limit'
  | 'context_limit'
  | 'missing_finish'
  | 'filtered'
  | 'paused'
  | 'unknown_finish'
  | 'repetition_stopped';

const failureMessages: Record<ModelCompletionFailureCode, string> = {
  empty_response: 'model returned an empty response',
  output_limit: 'model output limit reached; response incomplete',
  context_limit: 'model context window exhausted; response incomplete',
  missing_finish: 'model response ended without a complete finish signal',
  filtered: 'model response was filtered',
  paused: 'model response paused before completion',
  unknown_finish: 'model response ended with an unknown finish reason',
  repetition_stopped:
    'model response stopped after repeating; response incomplete',
};

export class ModelCompletionFailure extends Error {
  providerError?: {
    code?: string;
    message: string;
    contextLimit?: number;
    inputLimit?: number;
    outputLimit?: number;
  };
  constructor(
    readonly code: ModelCompletionFailureCode,
    readonly responseId?: string,
  ) {
    super(failureMessages[code]);
    this.name = 'ModelCompletionFailure';
  }
}

/** Only explicit provider error evidence, never token-count guesses. */
export function isContextLimitError(error: unknown): boolean {
  if (error instanceof ModelCompletionFailure)
    return error.code === 'context_limit';
  if (!error || typeof error !== 'object') return false;
  const item = error as {
    status?: number;
    code?: string;
    message?: string;
    error?: { code?: string; type?: string };
  };
  const codes = providerErrorRecords(error).flatMap((row) => [
    row.code,
    row.type,
  ]);
  if (
    codes.some(
      (code) =>
        typeof code === 'string' &&
        [
          'context_length_exceeded',
          'prompt_too_long',
          'input_too_long',
          'model_context_window_exceeded',
        ].includes(code),
    )
  )
    return true;
  return (
    ([400, 413, 422].includes(item.status ?? 0) ||
      codes.includes('invalid_request_error')) &&
    /prompt is too long|maximum context length|context (?:length|window).*(?:exceed|too (?:long|large))|input.*exceeds.*token limit/i.test(
      item.message ?? '',
    )
  );
}

export function providerErrorRecords(
  error: unknown,
): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth: number) => {
    if (
      !value ||
      typeof value !== 'object' ||
      depth > 3 ||
      records.includes(value as Record<string, unknown>)
    )
      return;
    const row = value as Record<string, unknown>;
    records.push(row);
    visit(row.error, depth + 1);
    visit(row.body, depth + 1);
  };
  visit(error, 0);
  return records;
}

/** Classify only recorded evidence; never infer a provider reason from usage. */
export function completionFailure(
  message: Message,
): ModelCompletionFailure | undefined {
  const completion = message.completion;
  const failure = (code: ModelCompletionFailureCode) =>
    new ModelCompletionFailure(code, message.id);
  const reason = completion?.reason;
  const evidence = completionEvidenceFailure(completion);
  if (evidence) return failure(evidence);
  if (reason === 'tool_calls' && !message.tool_calls?.length)
    return failure('unknown_finish');
  if (message.truncated) return failure('unknown_finish');
  // Metadata is optional for custom models and old records. Their existing
  // non-empty answers and complete calls remain usable.
  if (!message.content.trim() && !message.tool_calls?.length)
    return failure('empty_response');
  return undefined;
}

/** A stored finish receipt can be classified without inventing missing response text. */
export function completionEvidenceFailure(
  completion?: ModelCompletion,
): ModelCompletionFailureCode | undefined {
  if (completion?.client_stop === 'repetition') return 'repetition_stopped';
  const reason = completion?.reason;
  return completion?.provider_reason === 'model_context_window_exceeded'
    ? 'context_limit'
    : reason === 'length'
      ? 'output_limit'
      : reason === 'missing'
        ? 'missing_finish'
        : reason === 'filter'
          ? 'filtered'
          : reason === 'pause'
            ? 'paused'
            : reason === 'unknown' ||
                (reason !== undefined &&
                  !['stop', 'tool_calls'].includes(reason))
              ? 'unknown_finish'
              : undefined;
}

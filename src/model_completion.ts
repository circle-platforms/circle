import type { Message } from './types.js';

export type ModelCompletionFailureCode =
  | 'empty_response'
  | 'output_limit'
  | 'missing_finish'
  | 'filtered'
  | 'paused'
  | 'unknown_finish'
  | 'repetition_stopped';

const failureMessages: Record<ModelCompletionFailureCode, string> = {
  empty_response: 'model returned an empty response',
  output_limit: 'model output limit reached; response incomplete',
  missing_finish: 'model response ended without a complete finish signal',
  filtered: 'model response was filtered',
  paused: 'model response paused before completion',
  unknown_finish: 'model response ended with an unknown finish reason',
  repetition_stopped:
    'model response stopped after repeating; response incomplete',
};

export class ModelCompletionFailure extends Error {
  constructor(
    readonly code: ModelCompletionFailureCode,
    readonly responseId?: string,
  ) {
    super(failureMessages[code]);
    this.name = 'ModelCompletionFailure';
  }
}

/** Classify only recorded evidence; never infer a provider reason from usage. */
export function completionFailure(
  message: Message,
): ModelCompletionFailure | undefined {
  const completion = message.completion;
  const failure = (code: ModelCompletionFailureCode) =>
    new ModelCompletionFailure(code, message.id);
  if (completion?.client_stop === 'repetition')
    return failure('repetition_stopped');
  const reason = completion?.reason;
  if (reason === 'tool_calls' && !message.tool_calls?.length)
    return failure('unknown_finish');
  const code =
    reason === 'length'
      ? 'output_limit'
      : reason === 'missing'
        ? 'missing_finish'
        : reason === 'filter'
          ? 'filtered'
          : reason === 'pause'
            ? 'paused'
            : reason === 'unknown' || message.truncated
              ? 'unknown_finish'
              : undefined;
  if (code) return failure(code);
  // Metadata is optional for custom models and old records. Their existing
  // non-empty answers and complete calls remain usable.
  if (!message.content.trim() && !message.tool_calls?.length)
    return failure('empty_response');
  return undefined;
}

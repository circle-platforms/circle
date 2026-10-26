import type { ModelCompletionFailureCode } from '../../../../src/model_completion';
import type { Message } from './types';
import { locale, t } from '../i18n/index.ts';
import { compactionOutcomeText } from './compaction';

/**
 * English is the sentence the terminal stores. Chinese uses the shared word
 * `interrupted`, not a second `✖ Interrupted` entry: another branch adds that
 * key, and two copies of it fail the desktop typecheck.
 */
export function interruptedLabel(): string {
  return locale() === 'zh-CN' ? `✖ ${t('interrupted')}` : '✖ Interrupted';
}

/** The stop line, in either language the transcript may already be holding. */
const STOP_NOTICE = new Set(['✖ Interrupted', '✖ 已中断']);

export function isStopNotice(
  message: Pick<Message, 'role' | 'text' | 'interrupted'>,
): boolean {
  return (
    message.role === 'notice' &&
    (message.interrupted === true || STOP_NOTICE.has(message.text))
  );
}

/**
 * A stopped reply draws its own mark under the stats. A second stop notice
 * after that reply — the one another session view inserts below the stats —
 * is the same mark again. A crash that saved no reply has only the notice.
 */
export function withoutDuplicateStops(messages: Message[]): Message[] {
  const out: Message[] = [];
  let stoppedReply = false;
  for (const message of messages) {
    if (message.role === 'user') stoppedReply = false;
    if (isStopNotice(message) && stoppedReply) continue;
    const showsMark =
      message.role === 'assistant' &&
      message.interrupted === true &&
      message.at !== 'streaming' &&
      Boolean(message.text.trim() || message.attachments?.length);
    if (showsMark) stoppedReply = true;
    out.push(message);
  }
  return out;
}

export function completionFailureText(
  code: ModelCompletionFailureCode,
): string | undefined {
  switch (code) {
    case 'empty_response':
      return t('model returned an empty response');
    case 'output_limit':
      return t('model output limit reached; response incomplete');
    case 'context_limit':
      return t('model context window exhausted; response incomplete');
    case 'missing_finish':
      return t('model response ended without a complete finish signal');
    case 'filtered':
      return t('model response was filtered');
    case 'paused':
      return t('model response paused before completion');
    case 'unknown_finish':
      return t('model response ended with an unknown finish reason');
    case 'repetition_stopped':
      return t('model response stopped after repeating; response incomplete');
  }
}

export function completionNoticeText(
  message: Pick<
    Message,
    | 'text'
    | 'planCompleted'
    | 'completionFailure'
    | 'interrupted'
    | 'compaction'
  >,
): string {
  if (message.compaction) return compactionOutcomeText(message.compaction);
  if (message.interrupted) return interruptedLabel();
  if (message.planCompleted !== undefined)
    return t('plan completed · {n} steps', { n: message.planCompleted });
  const failure =
    message.completionFailure &&
    completionFailureText(message.completionFailure);
  if (failure) return `✖ ${failure}`;
  // The runtime's own words for a failed turn and a failed session title.
  if (message.text === '✖ the turn failed') return t('✖ the turn failed');
  if (message.text === '✖ Interrupted') return t('✖ Interrupted');
  if (message.text.startsWith('title failed · ')) {
    const reason = message.text.slice('title failed · '.length);
    return t('title failed · {message}', {
      message:
        reason === 'could not reach the endpoint'
          ? t('could not reach the endpoint')
          : reason,
    });
  }
  return message.text;
}

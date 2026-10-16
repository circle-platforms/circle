import type { ModelCompletionFailureCode } from '../../../../src/model_completion';
import type { Message } from './types';
import { t } from '../i18n/index.ts';

export function completionFailureText(
  code: ModelCompletionFailureCode,
): string | undefined {
  switch (code) {
    case 'empty_response':
      return t('model returned an empty response');
    case 'output_limit':
      return t('model output limit reached; response incomplete');
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
  message: Pick<Message, 'text' | 'planCompleted' | 'completionFailure'>,
): string {
  if (message.planCompleted !== undefined)
    return t('plan completed · {n} steps', { n: message.planCompleted });
  const failure =
    message.completionFailure &&
    completionFailureText(message.completionFailure);
  if (failure) return `✖ ${failure}`;
  // The runtime's own words for a failed turn and a failed session title.
  if (message.text === '✖ the turn failed') return t('✖ the turn failed');
  if (message.text.startsWith('title failed · '))
    return t('title failed · {message}', {
      message: message.text.slice('title failed · '.length),
    });
  return message.text;
}

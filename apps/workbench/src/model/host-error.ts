import { t } from '../i18n';

/**
 * The main process says these in English. The window says them in its language.
 * They are the ledger's public text when an operation cannot be retried blindly.
 */
export function presentHostError(message: string): string {
  if (message === 'operation failed; inspect effects before retrying')
    return t('operation failed; inspect effects before retrying');
  if (
    message ===
    'operation outcome needs review; inspect effects before retrying'
  )
    return t('operation outcome needs review; inspect effects before retrying');
  if (
    message ===
    'stored operation result is unavailable; inspect effects before retrying'
  )
    return t(
      'stored operation result is unavailable; inspect effects before retrying',
    );
  return message;
}

/**
 * A shell that has exited is not one of these failures. A resize that races
 * the exit used to show the banner anyway.
 */
export function quietWhenTerminalExited(message: string): boolean {
  return (
    message === 'terminal is not running' ||
    message === 'terminal is stopping' ||
    message === 'operation failed; inspect effects before retrying' ||
    message === t('operation failed; inspect effects before retrying') ||
    message ===
      'operation outcome needs review; inspect effects before retrying' ||
    message ===
      t('operation outcome needs review; inspect effects before retrying') ||
    message ===
      'stored operation result is unavailable; inspect effects before retrying' ||
    message ===
      t(
        'stored operation result is unavailable; inspect effects before retrying',
      )
  );
}

import { t } from '../i18n/index.ts';

// Why the core asks, as approvals.ts words it; a reason not listed is shown as it is.
const REASONS: Record<string, () => string> = {
  'changes files in the workspace': () => t('changes files in the workspace'),
  'changes files outside the workspace': () =>
    t('changes files outside the workspace'),
  'deletes files': () => t('deletes files'),
  'runs a shell command': () => t('runs a shell command'),
  'only reads': () => t('only reads'),
  'destructive operation': () => t('destructive operation'),
  'python code deletes files': () => t('python code deletes files'),
  'encoded command': () => t('encoded command'),
  'nested too deep to read': () => t('nested too deep to read'),
  'command could not be parsed': () => t('command could not be parsed'),
  'shows the model the whole screen': () =>
    t('shows the model the whole screen'),
  'opens a page in the browser': () => t('opens a page in the browser'),
  'clicks in the browser': () => t('clicks in the browser'),
  'types in the browser': () => t('types in the browser'),
  'chooses an option in the browser': () =>
    t('chooses an option in the browser'),
  'presses a key in the browser': () => t('presses a key in the browser'),
  'answers a dialog in the browser': () => t('answers a dialog in the browser'),
  "manages the browser's tabs": () => t("manages the browser's tabs"),
  'runs a recorded browser script': () => t('runs a recorded browser script'),
  'trusts an untrusted certificate': () => t('trusts an untrusted certificate'),
  'gives the page files': () => t('gives the page files'),
  'keeps a download': () => t('keeps a download'),
  'clicks a coordinate target': () => t('clicks a coordinate target'),
  'types in your terminal': () => t('types in your terminal'),
  'types this command into your terminal': () =>
    t('types this command into your terminal'),
  'restarts this terminal and types into it': () =>
    t('restarts this terminal and types into it'),
  'restarts this terminal and types this command into it': () =>
    t('restarts this terminal and types this command into it'),
  'runs the line on the screen': () => t('runs the line on the screen'),
};
export const requestReason = (reason?: string) =>
  reason ? (REASONS[reason]?.() ?? reason) : '';

/**
 * The number of the terminal tab of yours a terminal call is for, when it is one: the
 * runtime adds `terminal` (`local:<id>`) and `ordinal` to such a call's input.
 */
export function terminalTabNumber(item: {
  tool?: string;
  input?: Record<string, unknown>;
}): number | undefined {
  const input = item.input;
  if (
    !item.tool?.startsWith('terminal_') ||
    typeof input?.terminal !== 'string' ||
    !input.terminal.startsWith('local:') ||
    typeof input.ordinal !== 'number'
  )
    return undefined;
  return input.ordinal;
}

/** What an approval card is headed with: the tool, or the terminal tab it is for. */
export function approvalHeading(item: {
  title: string;
  tool?: string;
  input?: Record<string, unknown>;
}): string {
  const tab = terminalTabNumber(item);
  return tab ? t('terminal {n}', { n: tab }) : (item.tool ?? item.title);
}

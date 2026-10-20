import { t } from '../i18n';

/**
 * An `execute` approval the person can move into a terminal tab. Prompting the model
 * to prefer the terminal tools is not enough: when their message names their own tab
 * and one is open, the card offers to type the command there instead. The main process
 * types it, and only where the line that runs is the card's.
 */
const OWN_TERMINAL =
  /我的终端|终端标签|终端页|my terminal|terminal tab|shell tab|own terminal/i;

export function asksForOwnTerminal(text: string): boolean {
  return OWN_TERMINAL.test(text);
}

export interface TerminalRedirect {
  ordinal: number;
  /** `local:<id>`, as the model's terminal tools name the tab. */
  session: string;
}

/** The first open tab, when this approval is `execute` and the person asked for their tab. */
export function executeTerminalRedirect(input: {
  tool?: string;
  command?: string;
  userText: string;
  tabs: { id: string; terminal: string; ordinal: number }[];
}): TerminalRedirect | undefined {
  if (input.tool !== 'execute') return;
  if (!input.command?.trim() || !asksForOwnTerminal(input.userText)) return;
  const tab = [...input.tabs]
    .filter((row) => row.ordinal > 0 && row.terminal)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  if (!tab) return;
  return { ordinal: tab.ordinal, session: tab.id };
}

/**
 * Why the main process typed nothing, in the interface language when it is one of the
 * reasons it gives for a tab.
 */
export function redirectRefusal(message: string, ordinal: number): string {
  if (message.includes('there is text at the prompt'))
    return t('terminal {n} has text at its prompt: clear it and try again', {
      n: ordinal,
    });
  if (message.includes('a command is still running there'))
    return t('a command is still running in terminal {n}', { n: ordinal });
  if (message.includes('the tab is not at its prompt'))
    return t('terminal {n} is not at its prompt', { n: ordinal });
  if (message.includes('Circle is using the tab'))
    return t('Circle is using terminal {n}', { n: ordinal });
  return message;
}

/**
 * An `execute` approval the person can move into a terminal tab. Prompting the model
 * to prefer the terminal tools is not enough: when their message names their own tab
 * and one is open, the card offers to type the command there instead.
 */
const OWN_TERMINAL =
  /我的终端|终端标签|终端页|my terminal|terminal tab|shell tab|own terminal/i;

export function asksForOwnTerminal(text: string): boolean {
  return OWN_TERMINAL.test(text);
}

export interface TerminalRedirect {
  ordinal: number;
  /** The terminal service id the write goes to. */
  terminal: string;
  /** `local:<id>`, as the model's terminal tools name the tab. */
  session: string;
  command: string;
  /** English the model reads when the card rejects `execute`. */
  rejection: string;
}

/** The first open tab, when this approval is `execute` and the person asked for their tab. */
export function executeTerminalRedirect(input: {
  tool?: string;
  command?: string;
  userText: string;
  tabs: { id: string; terminal: string; ordinal: number }[];
}): TerminalRedirect | undefined {
  if (input.tool !== 'execute') return;
  const command = input.command?.trim();
  if (!command || !asksForOwnTerminal(input.userText)) return;
  const tab = [...input.tabs]
    .filter((row) => row.ordinal > 0 && row.terminal)
    .sort((a, b) => a.ordinal - b.ordinal)[0];
  if (!tab) return;
  return {
    ordinal: tab.ordinal,
    terminal: tab.terminal,
    session: tab.id,
    command,
    rejection: `the user moved this command into terminal ${tab.ordinal}; it was typed there. Do not call execute. Use terminal_wait on ${tab.id} if you still need the result.`,
  };
}

/** Bytes that run the card's command in the shell, one Enter per line. */
export function commandToTerminalData(command: string): string {
  const lines = command.replace(/\r\n?/g, '\n');
  return lines.endsWith('\n')
    ? lines.replace(/\n/g, '\r')
    : `${lines.replace(/\n/g, '\r')}\r`;
}

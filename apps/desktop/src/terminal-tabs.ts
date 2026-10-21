// How a conversation's terminal tabs are numbered, for the window and for the model's
// terminal tools alike: a shell's tab is "terminal N". It imports nothing, so the
// renderer reads the same rule.

// LOCAL_TERMINAL of src/terminal/protocol.ts, spelled here so this module stays alone
const LOCAL_TERMINAL = 'local:';

/** What the numbering reads of a terminal, as the terminal service lists it. */
export interface TerminalTabSource {
  id: string;
  startedAt: string;
  managedCommand?: unknown;
}

/**
 * Each terminal's number, from 1: its place among the conversation's terminals that are
 * not a background command (`managedCommand`), oldest first. A stopped terminal keeps
 * its place while the list still has it. A shell's tab is named `terminal N` by it; a
 * service keeps its own label.
 */
export function terminalTabNumbers(
  terminals: readonly TerminalTabSource[],
): Map<string, number> {
  const tabs = terminals
    .map((terminal, index) => ({ terminal, index }))
    .filter(({ terminal }) => !terminal.managedCommand)
    .sort(
      (a, b) =>
        (a.terminal.startedAt < b.terminal.startedAt
          ? -1
          : a.terminal.startedAt > b.terminal.startedAt
            ? 1
            : 0) || a.index - b.index,
    );
  return new Map(tabs.map(({ terminal }, place) => [terminal.id, place + 1]));
}

/** The name the model's terminal tools give a terminal tab: `local:` and its id. */
export const terminalTabSession = (id: string): string => LOCAL_TERMINAL + id;

/** The terminal service's id in a tool's `local:<id>`, or undefined for anything else. */
export function terminalTabId(session: unknown): string | undefined {
  if (typeof session !== 'string' || !session.startsWith(LOCAL_TERMINAL))
    return undefined;
  const id = session.slice(LOCAL_TERMINAL.length);
  return /^[A-Za-z0-9-]{1,100}$/.test(id) ? id : undefined;
}

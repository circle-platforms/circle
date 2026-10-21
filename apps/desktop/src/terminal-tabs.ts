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
  /** Closed out of the tab row: it no longer holds a number. */
  hidden?: boolean;
  /** The number this tab was given, kept while it stays open. */
  tabNumber?: number;
  kind?: 'shell' | 'service';
  label?: string;
  /** The person named the tab: `label` is its name. */
  named?: boolean;
}

/**
 * The name a person gave a shell's tab. The tab shows it instead of `terminal N`, and the
 * model's terminal tools and the approval cards call the tab by it too, so a card always
 * names a tab the person can see. Undefined while the tab is still called by its number.
 */
export function terminalTabName(
  terminal: TerminalTabSource,
): string | undefined {
  return terminal.named === true &&
    (terminal.kind ?? 'shell') === 'shell' &&
    !terminal.managedCommand &&
    terminal.label
    ? terminal.label
    : undefined;
}

/**
 * Each open terminal's number. A background command (`managedCommand`) is not a tab, and
 * a tab the person closed (`hidden`) does not keep a number. A stored `tabNumber` stays,
 * so closing another tab does not rename this one. A tab without one takes the lowest
 * number still free, oldest first. A shell's tab is named `terminal N` by it; a service
 * keeps its own label.
 */
export function terminalTabNumbers(
  terminals: readonly TerminalTabSource[],
): Map<string, number> {
  const tabs = terminals
    .map((terminal, index) => ({ terminal, index }))
    .filter(({ terminal }) => !terminal.managedCommand && !terminal.hidden)
    .sort(
      (a, b) =>
        (a.terminal.startedAt < b.terminal.startedAt
          ? -1
          : a.terminal.startedAt > b.terminal.startedAt
            ? 1
            : 0) || a.index - b.index,
    );
  const used = new Set<number>();
  const numbers = new Map<string, number>();
  const pending: typeof tabs = [];
  for (const row of tabs) {
    const stored = row.terminal.tabNumber;
    if (stored && stored > 0 && !used.has(stored)) {
      used.add(stored);
      numbers.set(row.terminal.id, stored);
    } else pending.push(row);
  }
  for (const row of pending) {
    let number = 1;
    while (used.has(number)) number++;
    used.add(number);
    numbers.set(row.terminal.id, number);
  }
  return numbers;
}

/** The lowest number no open tab is using. A new shell is named by it. */
export function nextTerminalTabNumber(
  terminals: readonly TerminalTabSource[],
): number {
  const used = new Set(terminalTabNumbers(terminals).values());
  let number = 1;
  while (used.has(number)) number++;
  return number;
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

import type {
  TerminalEvent,
  TerminalSnapshot,
  TerminalReplay,
} from '../../../desktop/src/workspace/terminal';

/** Disk replay is authoritative; live events only wake the reader. */
export function acceptTerminalEvent(
  terminalId: string,
  cursor: number,
  event: TerminalEvent,
): number {
  if (event.terminalId !== terminalId)
    throw Error('terminal output belongs to another terminal');
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 1)
    throw Error('invalid terminal output sequence');
  if (event.sequence <= cursor) return cursor;
  if (event.sequence !== cursor + 1)
    throw Error('terminal output has a sequence gap');
  return event.sequence;
}

/** Metadata updates preserve tab order and never replace a newer state. */
export function mergeTerminalSnapshot(
  current: TerminalSnapshot[],
  incoming: TerminalSnapshot,
): TerminalSnapshot[] {
  const index = current.findIndex((item) => item.id === incoming.id);
  if (index < 0) return [...current, incoming];
  const previous = current[index]!;
  if (previous.lastSequence > incoming.lastSequence) return current;
  // A closed tab stays closed. An exit snapshot from before the close can arrive
  // later with the same sequence and would otherwise put the tab back in the row.
  const incoming_ =
    previous.hidden && !incoming.hidden
      ? { ...incoming, hidden: true }
      : incoming;
  return current.map((item, position) =>
    position === index ? incoming_ : item,
  );
}

/** Capture a fixed end cursor so copying a continuously running service finishes. */
export async function readTerminalOutput(
  terminalId: string,
  replay: (afterSequence: number) => Promise<TerminalReplay>,
): Promise<string> {
  const parts: string[] = [];
  let cursor = 0;
  let boundary: number | undefined;
  for (;;) {
    const page = await replay(cursor);
    boundary ??= page.snapshot.lastSequence;
    const previous = cursor;
    for (const event of page.events) {
      if (event.sequence > boundary) break;
      const next = acceptTerminalEvent(terminalId, cursor, event);
      if (next === cursor) continue;
      if (event.kind === 'data') parts.push(event.data ?? '');
      cursor = next;
    }
    if (cursor >= boundary) return parts.join('');
    if (cursor === previous)
      throw Error('terminal output could not be recovered');
  }
}

/** Long paste uses bounded IPC messages without splitting a Unicode character. */
export function* terminalInputChunks(data: string): Generator<string> {
  for (let offset = 0; offset < data.length;) {
    let end = Math.min(offset + 8192, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
    yield data.slice(offset, end);
    offset = end;
  }
}

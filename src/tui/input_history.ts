import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  historyFileOperation,
  withInputHistoryLock,
} from './input_history_file.js';
export class InputHistory {
  private values: string[] = [];
  private pending: string[] = [];
  persistenceError?: Error;
  get pendingCount(): number {
    return this.pending.length;
  }
  private cursor?: number;
  private draft = '';
  query?: string;
  private at = -1;
  constructor(
    readonly path: string,
    readonly maximum = 1000,
  ) {
    this.refresh();
  }
  private read(): string[] {
    const body = historyFileOperation('read', () => {
      try {
        return readFileSync(this.path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
    });
    try {
      const data: unknown = JSON.parse(body);
      if (
        data &&
        typeof data === 'object' &&
        'format' in data &&
        data.format === 'circle-history' &&
        'items' in data &&
        Array.isArray(data.items)
      )
        return data.items
          .filter(
            (item): item is string =>
              typeof item === 'string' && Boolean(item.trim()),
          )
          .slice(-this.maximum);
    } catch {
      /* Python releases and older Circle versions wrote one line per entry. */
    }
    return body
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .slice(-this.maximum);
  }
  private merged(latest: string[]): string[] {
    for (const entry of this.pending)
      if (latest.at(-1) !== entry) latest = [...latest, entry];
    return latest.slice(-this.maximum);
  }
  private refresh(): void {
    try {
      this.values = this.merged(this.read());
    } catch (error) {
      this.persistenceError =
        error instanceof Error ? error : new Error(String(error));
    }
  }
  static forHome(home: string): InputHistory {
    return new InputHistory(
      process.env.CIRCLE_HISTORY_PATH || join(home, 'history'),
    );
  }
  get items(): string[] {
    return [...this.values];
  }
  add(text: string): boolean {
    text = text.trimEnd();
    if (!text.trim()) return true;
    if (this.pending.at(-1) !== text)
      this.pending = [...this.pending, text].slice(-this.maximum);
    if (this.values.at(-1) !== text)
      this.values = [...this.values, text].slice(-this.maximum);
    this.reset();
    return this.flush();
  }
  /** Retry the retained deltas explicitly; never replace the file with a local view snapshot. */
  flush(): boolean {
    if (!this.pending.length) return true;
    try {
      historyFileOperation('directory', () =>
        mkdirSync(dirname(this.path), { recursive: true }),
      );
      withInputHistoryLock(this.path, () => {
        // Other views and terminals have their own navigation state. Merge against the
        // latest file while holding its lock, without changing their browsing snapshots.
        const merged = this.merged(this.read());
        const temporary = `${this.path}.${randomUUID()}.tmp`;
        try {
          // Keep the compact prefix older readers recognise; publish the entire history
          // atomically so another terminal never reads part of a multiline JSON entry.
          historyFileOperation('write', () =>
            writeFileSync(
              temporary,
              JSON.stringify({
                format: 'circle-history',
                version: 1,
                items: merged,
              }) + '\n',
              { mode: 0o600, flag: 'wx' },
            ),
          );
          historyFileOperation('publish', () =>
            renameSync(temporary, this.path),
          );
          // Publish succeeded. A subsequent lock cleanup failure must not replay this batch.
          this.values = merged;
          this.pending = [];
        } finally {
          historyFileOperation('temporary cleanup', () =>
            rmSync(temporary, { force: true }),
          );
        }
      });
      this.persistenceError = undefined;
      return true;
    } catch (error) {
      this.persistenceError =
        error instanceof Error ? error : new Error(String(error));
      return false;
    }
  }
  reset(): void {
    this.cursor = undefined;
    this.draft = '';
  }
  up(current: string): string | undefined {
    if (this.cursor === undefined) this.refresh();
    if (!this.values.length) return undefined;
    if (this.cursor === undefined) {
      this.draft = current;
      this.cursor = this.values.length - 1;
    } else this.cursor = Math.max(0, this.cursor - 1);
    return this.values[this.cursor];
  }
  down(): string | undefined {
    if (this.cursor === undefined) return undefined;
    if (this.cursor < this.values.length - 1) return this.values[++this.cursor];
    this.cursor = undefined;
    return this.draft;
  }
  /** ↑ has brought back an earlier message and ↓ has not returned to the draft yet. */
  get browsing(): boolean {
    return this.cursor !== undefined;
  }
  /** Is there an older message? An empty box scrolls the conversation when there is not. */
  canGoUp(): boolean {
    if (this.cursor === undefined) this.refresh();
    return (
      this.values.length > 0 && (this.cursor === undefined || this.cursor > 0)
    );
  }
  canGoDown(): boolean {
    return this.cursor !== undefined && this.cursor < this.values.length - 1;
  }
  beginSearch(current: string): string | undefined {
    this.refresh();
    this.draft = current;
    this.query = current;
    this.at = -1;
    return this.next();
  }
  update(query: string): string | undefined {
    this.query = query;
    this.at = -1;
    return this.next();
  }
  next(): string | undefined {
    if (!this.query) return undefined;
    const matches = [...this.values]
      .reverse()
      .filter((item) =>
        item.toLocaleLowerCase().includes(this.query!.toLocaleLowerCase()),
      );
    if (!matches.length) return undefined;
    this.at = (this.at + 1) % matches.length;
    return matches[this.at];
  }
  endSearch(restore: boolean): string {
    this.query = undefined;
    this.at = -1;
    return restore ? this.draft : '';
  }
}

import { randomUUID } from 'node:crypto';
import {
  readFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { withPrivateJsonLock } from '../settings.js';

function retryFileAccess<T>(operation: () => T): T {
  const deadline = Date.now() + 1000;
  for (;;) {
    try {
      return operation();
    } catch (error) {
      if (
        !['EACCES', 'EBUSY', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        ) ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

export class InputHistory {
  private values: string[] = [];
  private pending: string[] = [];
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
  private read(required = false): string[] | undefined {
    try {
      const body = required
        ? retryFileAccess(() => readFileSync(this.path, 'utf8'))
        : readFileSync(this.path, 'utf8');
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
        /* Circle 1.7.3 and older wrote one line per entry. */
      }
      return body
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(-this.maximum);
    } catch (error) {
      // A writer must not replace another terminal's entries with a stale local view
      // merely because a sharing violation made the current file unavailable.
      if (required && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
      /* An unavailable history file must not prevent typing. */
      return undefined;
    }
  }
  private merge(latest: string[]): string[] {
    for (const entry of this.pending)
      if (latest.at(-1) !== entry) latest = [...latest, entry];
    return latest.slice(-this.maximum);
  }
  private refresh(): void {
    const latest = this.read();
    if (latest) this.values = this.merge(latest);
  }
  static forHome(home: string): InputHistory {
    return new InputHistory(
      process.env.CIRCLE_HISTORY_PATH || join(home, 'history'),
    );
  }
  get items(): string[] {
    return [...this.values];
  }
  add(text: string): void {
    text = text.trimEnd();
    if (!text.trim()) return;
    if (this.pending.at(-1) !== text)
      this.pending = [...this.pending, text].slice(-this.maximum);
    if (this.values.at(-1) !== text)
      this.values = [...this.values, text].slice(-this.maximum);
    this.reset();
    try {
      retryFileAccess(() => mkdirSync(dirname(this.path), { recursive: true }));
      withPrivateJsonLock(this.path, () => {
        // Other views and terminals have their own navigation state. Merge against the
        // latest file while holding its lock, without changing their browsing snapshots.
        this.values = this.merge(this.read(true) ?? []);
        retryFileAccess(() => {
          const temporary = `${this.path}.${randomUUID()}.tmp`;
          try {
            // Keep the compact prefix older readers recognise; publish the entire history
            // atomically so another terminal never reads part of a multiline JSON entry.
            writeFileSync(
              temporary,
              JSON.stringify({
                format: 'circle-history',
                version: 1,
                items: this.values,
              }) + '\n',
              { mode: 0o600, flag: 'wx' },
            );
            renameSync(temporary, this.path);
            // The rename committed the entries even if later cleanup/release fails.
            this.pending = [];
          } finally {
            retryFileAccess(() => rmSync(temporary, { force: true }));
          }
        });
      });
    } catch {
      /* Keep the in-memory history usable. */
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

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
export class InputHistory {
  private values: string[] = [];
  // Keep unsaved input separate from a browsing snapshot: a later successful
  // append must merge it with other terminals, rather than silently discard it.
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
  private read(strict = false): string[] | undefined {
    try {
      const body = readFileSync(this.path, 'utf8');
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
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw error;
      /* An unavailable history file must not prevent typing. */
      return undefined;
    }
  }
  private merged(latest: string[], pending: string[]): string[] {
    const values = [...latest];
    for (const text of pending) if (values.at(-1) !== text) values.push(text);
    return values.slice(-this.maximum);
  }
  private refresh(): void {
    const latest = this.read();
    if (latest) this.values = this.merged(latest, this.pending);
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
    if (this.values.at(-1) !== text)
      this.values = [...this.values, text].slice(-this.maximum);
    this.pending = this.merged(this.pending, [text]);
    this.reset();
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        mkdirSync(dirname(this.path), { recursive: true });
        withPrivateJsonLock(this.path, () => {
          // Only ENOENT means a new history. An unreadable existing file must
          // never be replaced with this view's possibly stale snapshot.
          const latest = this.read(true) ?? [];
          const values = this.merged(latest, this.pending);
          const temporary = `${this.path}.${randomUUID()}.tmp`;
          try {
            // Publish whole entries while locked; readers never see half a JSON
            // message, and transient Windows file sharing errors can retry safely.
            writeFileSync(
              temporary,
              JSON.stringify({
                format: 'circle-history',
                version: 1,
                items: values,
              }) + '\n',
              { mode: 0o600, flag: 'wx' },
            );
            renameSync(temporary, this.path);
            this.values = values;
            this.pending = [];
          } finally {
            try {
              rmSync(temporary, { force: true });
            } catch {
              // Cleanup cannot turn an already published entry into another
              // append, nor hide the original read/write failure being retried.
            }
          }
        });
        return;
      } catch (error) {
        // Keep typing synchronous and bounded. Pending input remains available
        // in this view and is retried on its next add if the file stays blocked.
        if (
          !this.pending.length ||
          !['EPERM', 'EBUSY', 'EACCES'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          ) ||
          attempt === 4
        )
          return;
        Atomics.wait(
          new Int32Array(new SharedArrayBuffer(4)),
          0,
          0,
          10 * (attempt + 1),
        );
      }
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

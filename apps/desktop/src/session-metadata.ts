import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  withPrivateJsonLock,
  writePrivateJson,
} from '../../../src/settings.js';

/** Desktop organization is separate from shared checkpoint history and user files. */
export class SessionMetadata {
  private archived = new Map<string, string>();
  private readonly path: string;
  constructor(home: string) {
    this.path = join(home, 'desktop-session-metadata.json');
    this.refresh();
  }
  private read(): Map<string, string> {
    if (!existsSync(this.path)) return new Map();
    const value = JSON.parse(readFileSync(this.path, 'utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      value.version !== 1 ||
      !value.archived ||
      typeof value.archived !== 'object' ||
      Array.isArray(value.archived)
    )
      throw Error('invalid desktop session metadata');
    return new Map(
      Object.entries(value.archived as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          entry[0].length <= 200 &&
          typeof entry[1] === 'string' &&
          Number.isFinite(Date.parse(entry[1])),
      ),
    );
  }
  refresh(): void {
    this.archived = this.read();
  }
  archivedAt(id: string): string | undefined {
    return this.archived.get(id);
  }
  set(ids: string[], archive: boolean): void {
    withPrivateJsonLock(this.path, () => this.update(ids, archive));
  }
  private update(ids: string[], archive: boolean): void {
    const next = this.read();
    const at = new Date().toISOString();
    for (const id of ids) {
      if (archive && !next.has(id)) next.set(id, at);
      else if (!archive) next.delete(id);
    }
    writePrivateJson(this.path, {
      version: 1,
      archived: Object.fromEntries(next),
    });
    this.archived = next;
  }
}

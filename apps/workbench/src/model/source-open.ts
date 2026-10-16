import type { SourceLocation } from './source-navigation.ts';
export type SourceOpenResult =
  | { status: 'opened'; source: SourceLocation }
  | { status: 'superseded' }
  | { status: 'failed'; error: unknown };
/** A late filesystem resolution cannot select a file in another conversation or
 * override a newer click. The same guard also suppresses obsolete error toasts. */
export class SourceOpenCoordinator {
  private revision = 0;
  private selectedSession: () => string;
  constructor(selectedSession: () => string) {
    this.selectedSession = selectedSession;
  }
  cancel() {
    this.revision++;
  }
  async open(
    sessionId: string,
    resolve: () => Promise<SourceLocation>,
  ): Promise<SourceOpenResult> {
    const revision = ++this.revision;
    if (this.selectedSession() !== sessionId) return { status: 'superseded' };
    try {
      const source = await resolve();
      if (revision !== this.revision || this.selectedSession() !== sessionId)
        return { status: 'superseded' };
      return { status: 'opened', source };
    } catch (error) {
      if (revision !== this.revision || this.selectedSession() !== sessionId)
        return { status: 'superseded' };
      return { status: 'failed', error };
    }
  }
}

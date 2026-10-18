import { isAbsolute } from 'node:path';
import type { ExternalFileAccess, NativeExternalFileGrant } from './contracts';

export interface ExternalPickerContext {
  connected: boolean;
  activeSessionId: string;
  sessions: {
    id: string;
    workspaceId: string;
    occupied?: boolean;
    lifecycle?: string;
    archivedAt?: string;
    readOnly?: boolean;
  }[];
}
export interface ExactFileSelection {
  canceled: boolean;
  filePaths: readonly string[];
}
/** Main-process-only gate. Renderer requests contain identities/access, never paths.
 * The OS dialog's result is the sole source of a mintable path. */
export class NativeExternalFilePicker {
  private context?: ExternalPickerContext;
  private fingerprint = '';
  private epoch = 0;
  private pending = false;

  observe(context: ExternalPickerContext) {
    const selected = context.sessions.find(
      (row) => row.id === context.activeSessionId,
    );
    const fingerprint = JSON.stringify([
      context.connected,
      context.activeSessionId,
      selected?.workspaceId,
      selected?.occupied,
      selected?.lifecycle,
      selected?.archivedAt,
      selected?.readOnly,
    ]);
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.epoch++;
    }
    this.context = context;
  }
  invalidate() {
    this.epoch++;
  }
  private check(sessionId: unknown, access: unknown) {
    if (
      typeof sessionId !== 'string' ||
      !sessionId ||
      sessionId.length > 200 ||
      (access !== 'read' && access !== 'readwrite')
    )
      throw Error('invalid external file permission request');
    const state = this.context;
    const session = state?.sessions.find((row) => row.id === sessionId);
    if (
      !state?.connected ||
      state.activeSessionId !== sessionId ||
      !session ||
      session.occupied ||
      session.lifecycle === 'deleting' ||
      session.archivedAt ||
      (access === 'readwrite' && session.readOnly)
    )
      throw Error(
        'external file permission requires the current available session',
      );
  }
  async request(
    sessionId: unknown,
    access: unknown,
    ports: {
      choose: (access: ExternalFileAccess) => Promise<ExactFileSelection>;
      mint: (
        sessionId: string,
        path: string,
        access: ExternalFileAccess,
      ) => Promise<NativeExternalFileGrant>;
      revoke: (sessionId: string, id: string) => Promise<void>;
      /** Refresh native state after asynchronous dialog/worker boundaries. */
      refresh?: () => ExternalPickerContext;
    },
  ): Promise<NativeExternalFileGrant | null> {
    if (ports.refresh) this.observe(ports.refresh());
    this.check(sessionId, access);
    if (this.pending) throw Error('an external file chooser is already open');
    this.pending = true;
    const epoch = this.epoch;
    const current = () => {
      if (ports.refresh) this.observe(ports.refresh());
      this.check(sessionId, access);
      if (epoch !== this.epoch)
        throw Error('external file permission selection is stale');
    };
    try {
      const selection = await ports.choose(access as ExternalFileAccess);
      if (selection.canceled) return null;
      current();
      if (
        selection.filePaths.length !== 1 ||
        typeof selection.filePaths[0] !== 'string' ||
        !isAbsolute(selection.filePaths[0]) ||
        selection.filePaths[0].includes('\0')
      )
        throw Error('choose exactly one external file');
      const grant = await ports.mint(
        sessionId as string,
        selection.filePaths[0],
        access as ExternalFileAccess,
      );
      try {
        current();
      } catch (error) {
        await ports.revoke(sessionId as string, grant.id);
        throw error;
      }
      return grant;
    } finally {
      this.pending = false;
    }
  }
}

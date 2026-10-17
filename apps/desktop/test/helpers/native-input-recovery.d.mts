import type { Session } from '../../../workbench/src/model/types.ts';

export function readNativeRecoverySession(
  state: () => Promise<{ sessions: Session[] }>,
  page: {
    evaluate: (
      callback: (sessionId: string) => unknown,
      sessionId: string,
    ) => Promise<unknown>;
  },
  sessionId: string,
): Promise<Session>;

import { createRoot } from 'react-dom/client';
import { PendingOperations } from '../src/features/PendingOperations';
let reviewed = false;
let rejectReview = true;
const calls: unknown[] = [];
Object.assign(window, {
  calls,
  circleDesktop: {
    runtimeCommand: async (command: any) => {
      calls.push(command);
      const { method, params } = command.payload;
      if (method === 'review') {
        if (rejectReview) {
          rejectReview = false;
          return { ok: false, error: 'review temporarily unavailable' };
        }
        reviewed = true;
        return { ok: true, data: {} };
      }
      if (method !== 'list') throw Error('unexpected side effect');
      return {
        ok: true,
        data: reviewed
          ? []
          : [
              {
                cursor: 1,
                id: 'op1',
                sessionId: 's1',
                service: 'git',
                method: 'push',
                state: 'needs_review',
                createdAt: 1000,
                updatedAt: 2000,
                paramsHash: 'HIDDEN_FINGERPRINT',
                params: 'HIDDEN_SECRET',
              },
            ],
      };
    },
  },
});
createRoot(document.getElementById('root')!).render(
  <PendingOperations sessionId="s1" />,
);

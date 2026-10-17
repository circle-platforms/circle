import type { UpdateState } from '../../../desktop/src/contracts.ts';

/** Which steps the about page offers for this update. */
export function updateActions(state: UpdateState): {
  page: boolean;
  download: boolean;
  retry: boolean;
  install: boolean;
  check: boolean;
} {
  return {
    page:
      (state.phase === 'available' || state.phase === 'failed') &&
      Boolean(state.page),
    download: state.phase === 'available' && !state.page,
    retry: state.phase === 'failed' && Boolean(state.version) && !state.page,
    install: state.phase === 'ready',
    check: ['idle', 'current', 'failed', 'available'].includes(state.phase),
  };
}

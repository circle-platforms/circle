import type {
  BrowserDialog,
  BrowserState,
} from '../../../desktop/src/contracts';

/** Browser events name the browser; the renderer routes them to its conversation. */
export const isSessionBrowser = (state: BrowserState, sessionId: string) =>
  state.sessionId === 'browser:' + sessionId;

export const browserOpened = (state?: BrowserState | null): boolean =>
  !!state &&
  (!!state.warning ||
    !!state.failure ||
    !!state.dialogs?.some((dialog) => dialog.tab === state.tab) ||
    (!!state.url && state.url !== 'about:blank'));

/** The dialog the shown tab waits on, if any. */
export const shownDialog = (
  state?: BrowserState | null,
): BrowserDialog | undefined =>
  state?.dialogs?.find((dialog) => dialog.tab === state.tab);

/** Loading events must not replace an address the human is composing. */
export function browserEventAddress(
  state: BrowserState,
  editing: boolean,
  wasOpened: boolean,
): string | undefined {
  if (editing || (!browserOpened(state) && !wasOpened)) return undefined;
  const url = state.failure?.url ?? state.url;
  return url === 'about:blank' ? '' : url;
}

/** The host a dialog came from, as browsers name it: "example.com says". */
export function dialogSource(dialog: BrowserDialog): string {
  try {
    return new URL(dialog.origin).host || dialog.origin;
  } catch {
    return dialog.origin;
  }
}

export const hasToolInput = (value: unknown): boolean =>
  value !== null &&
  value !== undefined &&
  (typeof value !== 'object' || Object.keys(value).length > 0);

/** Compact approval rows retain every value, including empty text and false flags. */
export function browserApprovalInput(input?: Record<string, unknown>) {
  if (!input) return [];
  return Object.entries(input).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }));
}
/** A download's size or progress, as a browser's download bar shows it. */
export function downloadProgress(download: {
  state: 'progress' | 'done' | 'failed';
  received: number;
  total: number;
}): string {
  const size = (bytes: number) =>
    bytes < 1024
      ? `${bytes} B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KB`
        : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (download.state === 'progress' && download.total > 0)
    return `${Math.floor((download.received * 100) / download.total)}%`;
  return size(download.received);
}

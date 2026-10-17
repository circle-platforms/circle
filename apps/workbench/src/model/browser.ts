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

/** Attaching the first tab can happen after the human starts typing. */
export const browserTabChanged = (
  previous: string | undefined,
  current: string | undefined,
): boolean => previous !== undefined && previous !== current;

/** Loading events must not replace an address the human is composing. */
export function browserEventAddress(
  state: BrowserState,
  editing: boolean,
  wasOpened: boolean,
  tabChanged = false,
): string | undefined {
  if (!tabChanged && (editing || (!browserOpened(state) && !wasOpened)))
    return undefined;
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
  state: 'progress' | 'waiting' | 'done' | 'failed';
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
/**
 * An address as Chrome's address bar shows it while you are not typing: without
 * http:// or https://, with the host to emphasise. Anything else is shown whole.
 */
export function addressParts(url: string): {
  host: string;
  rest: string;
} {
  const match = /^https?:\/\/([^/?#]*)(.*)$/i.exec(url);
  if (!match) return { host: '', rest: url };
  // A host's own credentials never show; the browser refuses them anyway
  const host = match[1]!.replace(/^[^@]*@/, '');
  const rest = match[2] === '/' ? '' : match[2]!;
  return { host, rest };
}
/** How the address bar names the page's connection. */
export function connectionKind(
  state?: {
    url?: string;
    warning?: unknown;
    insecure?: boolean;
    failure?: { url: string };
  } | null,
): 'warning' | 'insecure' | 'http' | 'https' | 'none' {
  if (!state) return 'none';
  if (state.warning) return 'warning';
  if (state.insecure) return 'insecure';
  const url = state.failure?.url ?? state.url ?? '';
  if (/^https:/i.test(url)) return 'https';
  if (/^http:/i.test(url)) return 'http';
  return 'none';
}

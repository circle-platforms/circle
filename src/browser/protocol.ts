// What the runtime asks of a conversation's browser and what it gets back. In the desktop
// application the browser lives in the main process: the runtime posts
// `{type:'browser', request}` and may post `{type:'browser-cancel', id}`, and the main process
// answers `{type:'browser-reply', reply}`. In the terminal it is the Chrome or Edge that
// chrome.ts starts, in the same process.
export const browserActions = [
  'navigate',
  'snapshot',
  'click',
  'type',
  'select',
  'press',
  'screenshot',
  'dialog',
  'tabs',
  'upload',
] as const;
export type BrowserAction = (typeof browserActions)[number];
export interface BrowserRequest {
  id: string;
  sessionId: string;
  action: BrowserAction;
  args: Record<string, unknown>;
}
export interface BrowserResult {
  text: string;
  /** A PNG, base64, for `screenshot`. */
  image?: string;
  /**
   * The action needs the person's approval first: the model pressed "proceed" on a
   * certificate warning, or would give a page files. The runtime asks, then repeats the
   * request with `args.approval`.
   */
  approval?: BrowserApproval;
}
export type BrowserApproval = CertificateApproval | UploadApproval;
/** Files the model would give a page's file input, which only the person allows. */
export interface UploadApproval {
  kind: 'upload';
  token: string;
  /** Where the files would go: the site of the page that asks for them. */
  origin: string;
  /** The file input, as the model and the page name it. */
  element: string;
  files: { path: string; name: string; size: number }[];
}
export interface CertificateApproval {
  kind: 'certificate';
  token: string;
  url: string;
  host: string;
  subject: string;
  issuer: string;
  fingerprint: string;
  validExpiry: number;
  /** Only a host on this network can be trusted for good. */
  privateHost: boolean;
}
export interface BrowserReply {
  id: string;
  ok: boolean;
  error?: string;
  data?: BrowserResult;
}
// The keys `press` knows, as CDP names them: [code, key code, text typed]
export const BROWSER_KEYS: Record<string, [string, number, string?]> = {
  Enter: ['Enter', 13, '\r'],
  Tab: ['Tab', 9],
  Escape: ['Escape', 27],
  Backspace: ['Backspace', 8],
  Delete: ['Delete', 46],
  Space: ['Space', 32, ' '],
  ArrowUp: ['ArrowUp', 38],
  ArrowDown: ['ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 37],
  ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36],
  End: ['End', 35],
  PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34],
};
const MAX_ARGS = 200_000;
export function validateBrowserRequest(value: unknown): BrowserRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw Error('invalid browser request');
  const request = value as BrowserRequest;
  if (
    typeof request.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request.id) ||
    typeof request.sessionId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request.sessionId) ||
    !browserActions.includes(request.action) ||
    !request.args ||
    typeof request.args !== 'object' ||
    Array.isArray(request.args) ||
    JSON.stringify(request.args).length > MAX_ARGS
  )
    throw Error('invalid browser request');
  return request;
}

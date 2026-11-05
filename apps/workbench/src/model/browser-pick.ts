import type { BrowserPick } from '../../../desktop/src/contracts';
import { t } from '../i18n';
import type { Attachment } from './types';

/**
 * The picture of the page the panel points at, and the page it was taken from. Its width
 * and height are the page's own CSS pixels, so a point in the picture is a point in the
 * page whatever the panel's size.
 */
export interface BrowserPickPicture {
  dataUrl: string;
  screenshotId: string;
  width: number;
  height: number;
  url: string;
  title: string;
  observedAt: string;
}

/** The box the panel draws for what is under the cursor, in the picture's CSS pixels. */
export interface PickBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where in the page the cursor is, from where in the panel it is. The picture fills the
 * box it is drawn in, so the two scale alike; anything outside the picture is nothing to
 * point at.
 */
export function pickPoint(
  box: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (
    box.width < 1 ||
    box.height < 1 ||
    viewport.width < 1 ||
    viewport.height < 1
  )
    return null;
  const x = ((clientX - box.left) / box.width) * viewport.width;
  const y = ((clientY - box.top) / box.height) * viewport.height;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
    return null;
  return { x, y };
}

/** What `browserPage('pick')` answers, out of the few shapes the bridge may carry. */
export function isBrowserPick(value: unknown): value is BrowserPick {
  return (
    typeof value === 'object' &&
    value !== null &&
    'preview' in value &&
    'role' in value &&
    'known' in value
  );
}

/** The element in the panel's own words: what it is and what it says. */
export function pickLabel(element: BrowserPick): string {
  const role = element.role || element.tag;
  return element.name ? `${role} “${element.name}”` : role;
}

/**
 * The box to draw, or none. A point inside a frame is answered in that frame's own
 * coordinates, which are not the picture's, so the panel keeps the crosshair there.
 */
export function pickBox(element?: BrowserPick | null): PickBox | null {
  return !element || element.framed ? null : element.box;
}

/**
 * Whether the panel may point at the page. It is the person's turn only: Circle's own
 * actions and a page waiting on an answer would change under the picture, and Chromium's
 * developer tools hold the page's debugger while they are open.
 */
export function canPick(state: {
  ring: string;
  opened: boolean;
  failure?: unknown;
  warning?: unknown;
  dialog?: unknown;
  chooser?: unknown;
  devTools?: boolean;
}): boolean {
  if (state.ring !== 'idle' && state.ring !== 'user') return false;
  if (state.devTools) return false;
  if (!state.opened || state.failure || state.warning) return false;
  if (state.dialog || state.chooser) return false;
  return true;
}

/** Why a point gave nothing, in the panel's words. The page's own reason stays English. */
export function pickFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/cross-origin frame/i.test(message))
    return t('this is inside a frame from another site');
  if (
    /picture is no longer the page|screenshot is stale|page changed/i.test(
      message,
    )
  )
    return t('the page changed; point again');
  if (/no visible element|outside the page|outside the viewport/i.test(message))
    return t('nothing to point at there');
  return t('the element could not be read');
}

/** What the model gets for the element the person pointed at. */
export function elementAttachment(input: {
  sessionId: string;
  picture: BrowserPickPicture;
  element: BrowserPick;
}): Attachment {
  const { picture, element } = input;
  let site = '';
  try {
    site = new URL(picture.url).hostname;
  } catch {
    site = '';
  }
  const shown = element.name
    ? `${element.role} "${element.name}"`
    : element.role;
  const lines = [
    'The user pointed at this element in the conversation’s browser.',
    '',
    `site: ${picture.url}`,
    ...(picture.title ? [`title: ${picture.title}`] : []),
    `element: ${element.ref ? `[${element.ref}] ` : ''}${shown}`,
    `tag: <${element.tag}>${element.known ? '' : ' (not a control the browser acts on by itself)'}`,
    ...(element.text ? [`text: ${element.text}`] : []),
    ...(element.disabled ? ['state: it is disabled or inert'] : []),
    `point: ${Math.round(element.x)}, ${Math.round(element.y)} of ${Math.round(picture.width)} × ${Math.round(picture.height)} CSS pixels`,
    ...(element.box
      ? [
          `box: ${element.box.left}, ${element.box.top}, ${element.box.width} × ${element.box.height}`,
        ]
      : []),
    ...(element.framed
      ? [
          'note: the point is inside a frame of this site; its box is the frame’s own',
        ]
      : []),
    '',
    'The ref above is the page’s own, from the same map browser_snapshot prints, so',
    'browser_click, browser_type and browser_select can act on it. Nothing here asks',
    'for that: it says which element the user means, and they are the one who pointed.',
    '',
    '--- browser element source ---',
    JSON.stringify(
      {
        kind: 'circle.browser-element',
        version: 1,
        sessionId: input.sessionId,
        page: {
          url: picture.url,
          title: picture.title,
          origin: element.origin,
        },
        ref: element.ref,
        role: element.role,
        name: element.name,
        tag: element.tag,
        known: element.known,
        disabled: element.disabled,
        framed: element.framed,
        box: element.box,
        point: { x: Math.round(element.x), y: Math.round(element.y) },
        viewport: {
          width: Math.round(picture.width),
          height: Math.round(picture.height),
        },
        screenshotId: picture.screenshotId,
        pictureTakenAt: picture.observedAt,
        identitySource:
          'the page’s own composed hit-test at the pointed position, checked against the picture the user pointed at',
      },
      null,
      2,
    ),
  ];
  const content = lines.join('\n');
  return {
    id: `browser-element:${crypto.randomUUID()}`,
    kind: 'file',
    name: `${site || t('browser page')} · ${t('element')}`,
    mime: 'text/plain',
    size: new TextEncoder().encode(content).byteLength,
    content,
  };
}

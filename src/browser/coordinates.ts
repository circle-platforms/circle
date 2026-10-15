import { randomUUID } from 'node:crypto';
import { destructive, shownName, type PageElement } from './format.js';
import type { BrowserResult } from './protocol.js';

/** The viewport one screenshot is a picture of. What stands inside it is checked at the
 * point that gets clicked, so a page that redraws another part of itself stays clickable. */
export interface PageCaptureState {
  document: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}
export interface CoordinateTarget extends PageElement {
  ref: string;
  x: number;
  y: number;
  width: number;
  height: number;
  known: boolean;
  origin: string;
}
export interface ScreenshotCapture {
  id: string;
  state: PageCaptureState;
  approval?: { token: string; key: string };
}
export const screenshotCapture = (
  state: PageCaptureState,
): ScreenshotCapture => ({
  id: randomUUID(),
  state,
});
export const screenshotMetadata = (capture: ScreenshotCapture) => ({
  id: capture.id,
  width: capture.state.width,
  height: capture.state.height,
});
export const screenshotDescription = (capture: ScreenshotCapture) =>
  `screenshotId: ${capture.id}\nviewport: ${capture.state.width} × ${capture.state.height} CSS pixels; click coordinates use these dimensions, even when the image is scaled`;

export function checkScreenshot(
  capture: ScreenshotCapture | undefined,
  args: Record<string, unknown>,
): ScreenshotCapture {
  if (
    !capture ||
    typeof args.screenshotId !== 'string' ||
    args.screenshotId !== capture.id
  )
    throw Error('the screenshot is stale; take a new browser_screenshot');
  if (
    typeof args.x !== 'number' ||
    !Number.isFinite(args.x) ||
    typeof args.y !== 'number' ||
    !Number.isFinite(args.y) ||
    args.x < 0 ||
    args.y < 0 ||
    args.x >= capture.state.width ||
    args.y >= capture.state.height
  )
    throw Error(
      'click coordinates must be inside the screenshot viewport in CSS pixels',
    );
  return capture;
}

/**
 * Hover can change the action or geometry without replacing the element. What is compared is
 * what the click will do, not the page's handle for it: a row a framework builds again is the
 * same control under a new element id, and the click still lands on what the picture showed.
 */
export function checkCoordinateTarget(
  before: CoordinateTarget,
  after: CoordinateTarget,
): void {
  const fields: (keyof CoordinateTarget)[] = [
    'origin',
    'role',
    'name',
    'known',
    'x',
    'y',
    'width',
    'height',
  ];
  if (fields.some((key) => before[key] !== after[key]))
    throw Error('the screenshot target changed; take a new browser_screenshot');
}

/** Unknown or destructive targets never inherit a site's remembered click permission. */
export function coordinateApproval(
  capture: ScreenshotCapture,
  args: Record<string, unknown>,
  target: CoordinateTarget,
  mode: string | undefined,
): BrowserResult | undefined {
  if (mode === 'auto' || (target.known && !destructive(target.name))) return;
  // What the person decided about, not the page's internal handle for it: a re-rendered
  // row is the same control at the same place under a different element id.
  const key = JSON.stringify([
    capture.id,
    args.x,
    args.y,
    target.role,
    target.name,
    target.origin,
  ]);
  const approved = args.approval as
    { token?: unknown; scope?: unknown } | undefined;
  if (
    capture.approval?.key === key &&
    approved?.token === capture.approval.token &&
    approved.scope === 'once'
  ) {
    capture.approval = undefined;
    return;
  }
  const token = randomUUID();
  capture.approval = { token, key };
  return {
    text: 'Clicking this coordinate target needs the user’s approval once.',
    approval: {
      kind: 'coordinate',
      token,
      origin: target.origin,
      x: target.x,
      y: target.y,
      element: shownName(target, undefined),
      destructive: destructive(target.name),
    },
  };
}

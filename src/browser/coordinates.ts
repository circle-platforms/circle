import { randomUUID } from 'node:crypto';
import { destructive, shownName, type PageElement } from './format.js';
import type { BrowserResult } from './protocol.js';

export interface PageCaptureState {
  document: string;
  revision: number;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  /** Nested document/frame/shadow scroll offsets, read synchronously at each hit test. */
  nestedScroll?: [number, number, number][];
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

/** Hover can change the action or geometry without replacing the element. */
export function checkCoordinateTarget(
  before: CoordinateTarget,
  after: CoordinateTarget,
): void {
  const fields: (keyof CoordinateTarget)[] = [
    'ref',
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
  const key = JSON.stringify([
    capture.id,
    args.x,
    args.y,
    target.ref,
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

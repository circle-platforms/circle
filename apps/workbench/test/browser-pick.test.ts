import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canPick,
  elementAttachment,
  isBrowserPick,
  pickBox,
  pickFailure,
  pickLabel,
  pickPoint,
  type BrowserPickPicture,
} from '../src/model/browser-pick.ts';
import type { BrowserPick } from '../../desktop/src/contracts';

const element = (over: Partial<BrowserPick> = {}): BrowserPick => ({
  ref: 'e12',
  role: 'button',
  name: 'Save changes',
  known: true,
  tag: 'button',
  text: 'Save changes',
  disabled: false,
  box: { left: 100, top: 60, width: 220, height: 40 },
  framed: false,
  origin: 'https://app.example.test',
  x: 120,
  y: 80,
  preview: true,
  ...over,
});

const picture: BrowserPickPicture = {
  dataUrl: 'data:image/png;base64,AA',
  screenshotId: 'shot-1',
  width: 1280,
  height: 720,
  url: 'https://app.example.test/settings',
  title: 'Host settings',
  observedAt: '2026-11-02T10:12:31.000Z',
};

test('a point in the picture is the same point in the page', () => {
  // The panel is half the page's size: the middle of the picture is its middle.
  assert.deepEqual(
    pickPoint(
      { left: 20, top: 40, width: 640, height: 360 },
      { width: 1280, height: 720 },
      20 + 320,
      40 + 180,
    ),
    { x: 640, y: 360 },
  );
  assert.deepEqual(
    pickPoint(
      { left: 0, top: 0, width: 640, height: 360 },
      { width: 1280, height: 720 },
      0,
      0,
    ),
    { x: 0, y: 0 },
  );
  // Off the right and bottom edge of the picture: not the page's at all.
  assert.equal(
    pickPoint(
      { left: 0, top: 0, width: 640, height: 360 },
      { width: 1280, height: 720 },
      640,
      10,
    ),
    null,
  );
  assert.equal(
    pickPoint(
      { left: 0, top: 0, width: 640, height: 360 },
      { width: 1280, height: 720 },
      -3,
      10,
    ),
    null,
  );
  assert.equal(
    pickPoint(
      { left: 0, top: 0, width: 0, height: 360 },
      { width: 1280, height: 720 },
      10,
      10,
    ),
    null,
  );
});

test('what the cursor is over is named as the page names it', () => {
  assert.equal(pickLabel(element()), 'button “Save changes”');
  assert.equal(
    pickLabel(element({ name: '', role: 'section', tag: 'div' })),
    'section',
  );
});

test('a point inside a frame gets no box in the picture', () => {
  assert.deepEqual(pickBox(element()), {
    left: 100,
    top: 60,
    width: 220,
    height: 40,
  });
  assert.equal(pickBox(element({ framed: true })), null);
  assert.equal(pickBox(element({ box: null })), null);
  assert.equal(pickBox(undefined), null);
});

test('the bridge’s answer is told from the page’s state', () => {
  assert.equal(isBrowserPick(element()), true);
  assert.equal(isBrowserPick({ sessionId: 'browser:s1', url: '' }), false);
  assert.equal(isBrowserPick('data:image/jpeg;base64,AA'), false);
  assert.equal(isBrowserPick(null), false);
});

test('pointing is only for the person’s own turn with the page', () => {
  const shown = {
    ring: 'idle',
    opened: true,
    failure: undefined,
    warning: undefined,
    dialog: undefined,
    chooser: undefined,
    devTools: false,
  };
  assert.equal(canPick(shown), true);
  assert.equal(canPick({ ...shown, ring: 'user' }), true);
  assert.equal(canPick({ ...shown, ring: 'driving' }), false);
  assert.equal(canPick({ ...shown, ring: 'pending' }), false);
  assert.equal(canPick({ ...shown, ring: 'awaiting' }), false);
  assert.equal(canPick({ ...shown, devTools: true }), false);
  assert.equal(canPick({ ...shown, opened: false }), false);
  assert.equal(canPick({ ...shown, failure: { url: 'x', error: 'y' } }), false);
  assert.equal(
    canPick({ ...shown, warning: { host: 'h', error: 'e' } }),
    false,
  );
  assert.equal(canPick({ ...shown, dialog: { id: 'd' } }), false);
  assert.equal(
    canPick({ ...shown, chooser: { id: 'c', multiple: false } }),
    false,
  );
});

test('why a point gave nothing is said in the panel’s own words', () => {
  const page = (message: string) => Error(message);
  assert.match(
    pickFailure(
      page('a cross-origin frame at these coordinates cannot be read'),
    ),
    /frame from another site|其他网站/,
  );
  assert.match(
    pickFailure(page('the screenshot is stale; take a new browser_screenshot')),
    /page changed|页面/,
  );
  assert.match(
    pickFailure(page('there is no visible element at these coordinates')),
    /nothing to point at|没有/,
  );
  assert.match(
    pickFailure(page('the page is waiting on a dialog')),
    /could not be read|读不到/,
  );
});

test('the element the user pointed at reaches the model as words it can act on', () => {
  const attachment = elementAttachment({
    sessionId: 's1',
    picture,
    element: element({ preview: false, screenshotId: 'shot-1' } as BrowserPick),
  });
  const content = attachment.content;
  assert.equal(attachment.kind, 'file');
  assert.equal(attachment.mime, 'text/plain');
  assert.equal(attachment.name, 'app.example.test · element');
  assert.equal(attachment.size, new TextEncoder().encode(content).byteLength);
  assert.match(content, /The user pointed at this element/);
  assert.match(content, /site: https:\/\/app\.example\.test\/settings/);
  assert.match(content, /title: Host settings/);
  assert.match(content, /\[e12\] button "Save changes"/);
  assert.match(content, /tag: <button>/);
  assert.match(content, /point: 120, 80 of 1280 × 720 CSS pixels/);
  assert.match(content, /screenshotId": "shot-1/);
  assert.match(content, /"sessionId": "s1"/);
  // Nothing of the picture's own bytes travels with it.
  assert.doesNotMatch(content, /data:image/);
});

test('a point that is not a control, and one inside a frame, say so', () => {
  const plain = elementAttachment({
    sessionId: 's1',
    picture,
    element: element({
      ref: null,
      role: 'heading',
      name: '',
      known: false,
      tag: 'h2',
      text: 'Network',
    }),
  }).content;
  assert.match(plain, /element: heading\n/);
  assert.match(plain, /not a control the browser acts on by itself/);
  assert.match(plain, /text: Network/);
  const framed = elementAttachment({
    sessionId: 's1',
    picture,
    element: element({ framed: true, box: null, disabled: true }),
  }).content;
  assert.match(framed, /state: it is disabled or inert/);
  assert.match(framed, /inside a frame of this site/);
  assert.doesNotMatch(framed, /^box: /m);
});

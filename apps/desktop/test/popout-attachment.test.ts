import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_FILE_BYTES } from '../src/policy.ts';
import { validPopoutAttachment } from '../src/popout-attachment.ts';

// A 1×1 PNG, as the browser's capture gives a picture of the page.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhJkAAAAASUVORK5CYII=';
const PNG_BYTES = Buffer.from(PNG.split(',')[1]!, 'base64').length;
const screenshot = {
  id: '6b1e1d2c-3f4a-4b5c-8d6e-7f8091a2b3c4',
  name: 'app.example.test 12:04.png',
  kind: 'image',
  mime: 'image/png',
  size: PNG_BYTES,
  content: PNG,
};
const text = 'CIRCLE_SELECTED 中文\n\n--- terminal capture source ---\n{}';
const elementText =
  'The user pointed at this element in the conversation’s browser.\n\n--- browser element source ---\n{}';
const element = {
  id: 'browser-element:0f9e8d7c-6b5a-4c3d-2e1f-0a9b8c7d6e5f',
  name: '127.0.0.1 · element',
  kind: 'file',
  mime: 'text/plain',
  size: Buffer.byteLength(elementText),
  content: elementText,
};
const selection = {
  id: 'terminal-selection:0f9e8d7c-6b5a-4c3d-2e1f-0a9b8c7d6e5f',
  name: 'zsh · selection',
  kind: 'file',
  mime: 'text/plain',
  size: Buffer.byteLength(text),
  content: text,
};

test('a browser window passes on a page screenshot, and a terminal window a selection', () => {
  assert.deepEqual(validPopoutAttachment('browser', screenshot), screenshot);
  assert.deepEqual(validPopoutAttachment('terminal', selection), selection);
  // Nothing else of what the window sent is passed on.
  assert.deepEqual(
    validPopoutAttachment('browser', { ...screenshot, truncated: true, x: 1 }),
    screenshot,
  );
});

test('a browser window passes on the element the person pointed at', () => {
  assert.deepEqual(validPopoutAttachment('browser', element), element);
  // Nothing else of what the window sent is passed on.
  assert.deepEqual(
    validPopoutAttachment('browser', { ...element, truncated: true, x: 1 }),
    element,
  );
});

test('each window passes on only its own kind of attachment', () => {
  assert.throws(
    () => validPopoutAttachment('browser', selection),
    /invalid attachment/,
  );
  // A text file that is not one of the browser's own ids is not its element either.
  assert.throws(
    () =>
      validPopoutAttachment('browser', {
        ...element,
        id: '0f9e8d7c-6b5a-4c3d-2e1f-0a9b8c7d6e5f',
      }),
    /invalid attachment/,
  );
  assert.throws(
    () => validPopoutAttachment('terminal', screenshot),
    /invalid attachment/,
  );
});

test('kind, name, type, size and content are checked', () => {
  const bad: [string, Record<string, unknown>, 'browser' | 'terminal'][] = [
    ['not an object', null as never, 'browser'],
    ['a list', [] as never, 'browser'],
    ['no id', { ...screenshot, id: '' }, 'browser'],
    ['an id with a path', { ...screenshot, id: '../x' }, 'browser'],
    ['a long id', { ...screenshot, id: 'x'.repeat(201) }, 'browser'],
    ['no name', { ...screenshot, name: '  ' }, 'browser'],
    ['a name with a line break', { ...screenshot, name: 'a\nb' }, 'browser'],
    ['a long name', { ...screenshot, name: 'x'.repeat(301) }, 'browser'],
    ['a document', { ...screenshot, kind: 'document' }, 'browser'],
    ['a JPEG', { ...screenshot, mime: 'image/jpeg' }, 'browser'],
    [
      'a JPEG in a PNG',
      { ...screenshot, content: PNG.replace('image/png', 'image/jpeg') },
      'browser',
    ],
    [
      'an SVG',
      { ...screenshot, content: 'data:image/svg+xml,<svg/>' },
      'browser',
    ],
    ['a wrong size', { ...screenshot, size: PNG_BYTES + 1 }, 'browser'],
    ['no size', { ...screenshot, size: undefined }, 'browser'],
    [
      'a picture over 20 MB',
      {
        ...screenshot,
        content: 'data:image/png;base64,' + 'A'.repeat(30 * 1024 * 1024),
      },
      'browser',
    ],
    ['a selection of no id of its kind', { ...selection, id: 'x' }, 'terminal'],
    ['a picture type', { ...selection, mime: 'image/png' }, 'terminal'],
    ['an empty selection', { ...selection, content: '', size: 0 }, 'terminal'],
    ['a wrong count', { ...selection, size: text.length }, 'terminal'],
    [
      'a selection over 4 MB',
      {
        ...selection,
        content: 'x'.repeat(MAX_FILE_BYTES + 1),
        size: MAX_FILE_BYTES + 1,
      },
      'terminal',
    ],
    ['content that is not text', { ...selection, content: 5 }, 'terminal'],
    ['a picture as an element', { ...element, kind: 'image' }, 'browser'],
    ['a PNG as an element', { ...element, mime: 'image/png' }, 'browser'],
    ['an element of no id of its kind', { ...element, id: 'x' }, 'browser'],
    ['an empty element', { ...element, content: '', size: 0 }, 'browser'],
    [
      'a wrong element count',
      { ...element, size: elementText.length },
      'browser',
    ],
    [
      'an element over 4 MB',
      {
        ...element,
        content: 'x'.repeat(MAX_FILE_BYTES + 1),
        size: MAX_FILE_BYTES + 1,
      },
      'browser',
    ],
  ];
  for (const [what, value, from] of bad)
    assert.throws(
      () => validPopoutAttachment(from, value),
      /invalid/,
      `${what} is refused`,
    );
});

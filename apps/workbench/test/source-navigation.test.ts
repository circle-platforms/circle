import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceLocation,
  attachmentImage,
} from '../src/model/source-navigation.ts';

test('source links resolve the actual local file and requested line without opening an external page', () => {
  assert.deepEqual(sourceLocation('./src/app.ts#L18'), {
    path: 'src/app.ts',
    line: 18,
    column: undefined,
  });
  assert.deepEqual(sourceLocation('README.md'), {
    path: 'README.md',
    line: undefined,
    column: undefined,
  });
  assert.deepEqual(sourceLocation('README.md:12'), {
    path: 'README.md',
    line: 12,
    column: undefined,
  });
  assert.deepEqual(sourceLocation('src/a.ts:12:3'), {
    path: 'src/a.ts',
    line: 12,
    column: 3,
  });
  assert.deepEqual(sourceLocation('file:///tmp/my%20project/a.ts#L4C2'), {
    path: '/tmp/my project/a.ts',
    line: 4,
    column: 2,
  });
  assert.deepEqual(sourceLocation('file:///work/a%23b.ts#L2'), {
    path: '/work/a#b.ts',
    line: 2,
    column: undefined,
  });
  assert.deepEqual(sourceLocation('src/a%3Fb.ts'), {
    path: 'src/a?b.ts',
    line: undefined,
    column: undefined,
  });
  assert.deepEqual(sourceLocation('AGENTS.md#L1'), {
    path: 'AGENTS.md',
    line: 1,
    column: undefined,
  });
});

test('external links and unsupported navigation stay out of the local file route', () => {
  for (const value of [
    'https://example.com/a.ts#L4',
    'mailto:a@b.com',
    'javascript:alert(1)',
    'data:text/html,a',
    '#section',
    'README.md#setup',
    'README.md#L0',
    'file://remote/tmp/a.ts',
    'bad%XX.ts',
  ])
    assert.equal(sourceLocation(value), null, value);
});

test('historical binary attachment payload becomes the exact original image with a safe MIME type', () => {
  const png = 'iVBORw0KGgo=';
  assert.equal(
    attachmentImage(png, 'image/png'),
    `data:image/png;base64,${png}`,
  );
  const existing = `data:image/png;base64,${png}`;
  assert.equal(attachmentImage(existing, 'image/png'), existing);
  assert.equal(
    attachmentImage('<svg onload="alert(1)"/>', 'image/svg+xml'),
    null,
  );
  assert.equal(
    attachmentImage('https://example.com/private.png', 'image/png'),
    null,
  );
  assert.equal(attachmentImage('', 'image/png'), null);
});

test('absolute sources share the same workspace-relative document key on POSIX and Windows', async () => {
  const { workspaceRelativePath } =
    await import('../src/model/source-navigation.ts');
  assert.equal(
    workspaceRelativePath('/work/app/src/../README.md', '/work/app'),
    'README.md',
  );
  assert.equal(workspaceRelativePath('./README.md', '/work/app'), 'README.md');
  assert.equal(
    workspaceRelativePath(
      'file:///work/my%20app/src/a%2520b.ts#L2',
      '/work/my app',
    ),
    'src/a%20b.ts',
  );
  assert.equal(
    workspaceRelativePath('C:\\Work\\App\\src\\a.ts', 'c:\\work\\app'),
    'src/a.ts',
  );
  assert.equal(
    workspaceRelativePath(
      'file:///C:/Work/My%20App/src/a.ts#L12',
      'C:\\Work\\My App',
    ),
    'src/a.ts',
  );
  assert.equal(workspaceRelativePath('src\\a.ts', 'C:\\Work\\App'), 'src/a.ts');
  assert.equal(workspaceRelativePath('/README.md', '/'), 'README.md');
  assert.deepEqual(sourceLocation('C:\\Work\\App\\a.ts:12:3'), {
    path: 'C:\\Work\\App\\a.ts',
    line: 12,
    column: 3,
  });
});
test('outside-root, sibling prefix, traversal and different-drive source paths are refused', async () => {
  const { workspaceRelativePath } =
    await import('../src/model/source-navigation.ts');
  for (const [source, root] of [
    ['/work/app2/a.ts', '/work/app'],
    ['/work/app/../../private/a.ts', '/work/app'],
    ['../private/a.ts', '/work/app'],
    ['D:\\work\\a.ts', 'C:\\work'],
    ['file:///work/app/%2e%2e/private/a.ts', '/work/app'],
    ['https://example.com/a.ts', '/work/app'],
    ['C:\\Work\\Other\\a.ts', 'C:\\Work\\App'],
  ])
    assert.throws(() => workspaceRelativePath(source, root), source);
});

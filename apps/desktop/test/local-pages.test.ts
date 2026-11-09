import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LOCAL_PAGE_POLICY,
  LocalPages,
  localNavigation,
  localPageKind,
} from '../src/local-pages.ts';

const windows = process.platform === 'win32';

// A workspace with a design page, its picture, a PDF and a note, and a secret beside it
async function fixture(t: TestContext) {
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), 'circle-local-pages-')),
  );
  const root = join(scratch, 'workspace');
  await mkdir(join(root, 'designs', 'a b'), { recursive: true });
  await writeFile(
    join(root, 'designs', 'a b', 'page.html'),
    '<img src="pic.png">SYNTHETIC-PAGE',
  );
  await writeFile(join(root, 'designs', 'a b', 'pic.png'), 'PNG-BYTES');
  await writeFile(join(root, 'designs', 'spec.pdf'), '%PDF-1.4 SYNTHETIC');
  await writeFile(join(root, 'notes.txt'), 'SYNTHETIC-NOTE');
  await writeFile(join(scratch, 'secret.txt'), 'SYNTHETIC-SECRET');
  if (!windows)
    await symlink(
      join(scratch, 'secret.txt'),
      join(root, 'designs', 'out.css'),
    );
  t.after(() => rm(scratch, { recursive: true, force: true }));
  return { scratch, root };
}

test('a workspace page is served under its own token with no network, and nothing else is', async (t) => {
  const { root } = await fixture(t);
  const pages = new LocalPages();
  const page = await pages.address(root, 'designs/a b/page.html');
  const match =
    /^circle-local:\/\/([0-9a-f]{32})\/designs\/a%20b\/page\.html$/.exec(page);
  assert.ok(match, page);
  // One token for the workspace, whichever of its pages opens
  assert.equal(
    (await pages.address(root, 'designs/a b/page.html')).split('/')[2],
    match[1],
  );
  const served = await pages.respond(page);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), '<img src="pic.png">SYNTHETIC-PAGE');
  assert.equal(served.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(
    served.headers.get('content-security-policy'),
    LOCAL_PAGE_POLICY,
  );
  assert.match(LOCAL_PAGE_POLICY, /connect-src 'self' data: blob:/);
  assert.doesNotMatch(LOCAL_PAGE_POLICY, /https?:|\*/);
  // A file the page loads by its relative address
  const picture = await pages.respond(new URL('pic.png', page).href);
  assert.equal(await picture.text(), 'PNG-BYTES');
  assert.equal(picture.headers.get('content-type'), 'image/png');
  // Nothing outside the workspace, and no other token
  for (const address of [
    `circle-local://${match[1]}/../secret.txt`,
    `circle-local://${match[1]}/designs/%2e%2e/%2e%2e/secret.txt`,
    `circle-local://${match[1]}/designs/missing.html`,
    `circle-local://${match[1]}/designs`,
    `circle-local://${'0'.repeat(32)}/notes.txt`,
    ...(windows ? [] : [`circle-local://${match[1]}/designs/out.css`]),
  ]) {
    const refused = await pages.respond(address);
    assert.ok(refused.status >= 400, address);
    assert.doesNotMatch(
      await refused.text(),
      /SYNTHETIC-SECRET|SYNTHETIC-NOTE/,
    );
  }
  assert.equal(
    (await pages.respond(page, 4)).status,
    413,
    'a file over the limit is not sent',
  );
});

test('only pages and PDFs of the workspace get an address, and a PDF opens as its own file', async (t) => {
  const { scratch, root } = await fixture(t);
  const pages = new LocalPages();
  assert.equal(localPageKind('a/B.HTM'), 'page');
  assert.equal(localPageKind('a/b.pdf'), 'pdf');
  assert.equal(localPageKind('a/b.png'), undefined);
  await assert.rejects(pages.address(root, 'notes.txt'), /only pages and PDFs/);
  await assert.rejects(
    pages.address(root, '../workspace/designs/spec.pdf'),
    /not a file of this workspace/,
  );
  await assert.rejects(
    pages.address(root, join(scratch, 'secret.txt')),
    /only pages and PDFs/,
  );
  await assert.rejects(
    pages.address(root, 'designs/missing.html'),
    /does not exist/,
  );
  const pdf = await pages.address(root, 'designs/spec.pdf');
  assert.equal(pdf, pathToFileURL(join(root, 'designs', 'spec.pdf')).href);
  assert.equal(pages.allows(pdf), true);
  assert.equal(
    pages.allows(pathToFileURL(join(root, 'notes.txt')).href),
    false,
    'no other file of the disk is let through',
  );
  // Another conversation's pages know none of these
  assert.equal(new LocalPages().allows(pdf), false);
});

test('a local page stays local, and no site sends a tab to one', async (t) => {
  const { root } = await fixture(t);
  const pages = new LocalPages();
  const page = await pages.address(root, 'designs/a b/page.html');
  const pdf = await pages.address(root, 'designs/spec.pdf');
  const other = new URL('pic.png', page).href;
  assert.equal(localNavigation(page, other, pages), 'allow');
  assert.equal(localNavigation(page, pdf, pages), 'allow');
  assert.equal(localNavigation(page, 'https://example.com/', pages), 'deny');
  assert.equal(localNavigation(pdf, 'https://example.com/', pages), 'deny');
  assert.equal(
    localNavigation(page, 'circle-local://' + '0'.repeat(32) + '/x', pages),
    'deny',
  );
  assert.equal(localNavigation('https://example.com/', page, pages), 'deny');
  assert.equal(localNavigation('https://example.com/', pdf, pages), 'deny');
  assert.equal(
    localNavigation('https://example.com/', 'https://example.org/', pages),
    'browser',
  );
});

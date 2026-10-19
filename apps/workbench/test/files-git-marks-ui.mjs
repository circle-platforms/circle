import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';

// The files mode asks Git what differs from the last commit while it is on screen, and
// marks it whoever made the change: a file this conversation never touched has its name
// coloured and its letter, and its folder a dot. A deleted file is not in the tree.
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
  logLevel: 'error',
});
await server.listen();
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const theme of ['dark', 'light']) {
    const page = await browser.newPage({
      viewport: { width: 800, height: 700 },
    });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    await page.goto(
      `${server.resolvedUrls.local[0]}test/files-git-marks-ui.html?theme=${theme}`,
    );
    const tree = page.getByRole('tree', { name: 'files', exact: true });
    await tree.waitFor({ state: 'attached' });
    const asked = () =>
      page.evaluate(() =>
        window.filesGitFixture.calls.filter(
          (call) => call.service === 'git' && call.method === 'changes',
        ),
      );
    const row = (path) =>
      page.locator(`.virtual-file-tree-row[data-path="${path}"]`);
    // Mounted while the drawer is closed: Git is not asked, and nothing is marked. Two
    // frames let every effect of the mount run first.
    await page.evaluate(
      () =>
        new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        ),
    );
    assert.deepEqual(await asked(), [], 'a hidden mode does not ask Git');
    assert.equal(await page.locator('.file-dot').count(), 0);

    // Shown: Git is asked for this conversation, and what it says is marked.
    await page.evaluate(() => window.filesGitFixture.show(true));
    await row('src').locator('.file-dot').waitFor();
    const sessionId = await page.evaluate(
      () => window.filesGitFixture.sessionId,
    );
    assert.ok((await asked()).length >= 1);
    assert.ok(
      (await asked()).every((call) => call.sessionId === sessionId),
      "Git is asked in the conversation's own folder",
    );
    assert.equal(
      await row('docs').locator('.file-dot').count(),
      0,
      'a folder with nothing changed has no dot',
    );
    await tree.getByRole('treeitem', { name: 'src', exact: true }).click();
    await row('src/outside.ts').waitFor();
    const marks = await page.evaluate(() => {
      const probe = document.createElement('i');
      document.body.append(probe);
      const token = (name) => {
        probe.style.color = `var(${name})`;
        return getComputedStyle(probe).color;
      };
      const tokens = {
        attention: token('--attention'),
        accent: token('--accent'),
      };
      probe.remove();
      const look = (path) => {
        const node = document.querySelector(
          `.virtual-file-tree-row[data-path="${path}"]`,
        );
        return {
          changed: [...node.classList].find((name) =>
            name.startsWith('changed-'),
          ),
          letter: node.querySelector('.file-letter')?.textContent ?? '',
          colour: getComputedStyle(
            node.querySelector('.virtual-file-tree-label'),
          ).color,
        };
      };
      return {
        tokens,
        outside: look('src/outside.ts'),
        fresh: look('src/fresh.ts'),
        plain: look('src/plain.ts'),
        gone: !!document.querySelector(
          '.virtual-file-tree-row[data-path="gone.ts"]',
        ),
      };
    });
    assert.deepEqual(
      {
        ...marks.outside,
        colour: marks.outside.colour === marks.tokens.attention,
      },
      { changed: 'changed-M', letter: 'M', colour: true },
      `a file changed outside the conversation is orange with M (${theme})`,
    );
    assert.deepEqual(
      { ...marks.fresh, colour: marks.fresh.colour === marks.tokens.accent },
      { changed: 'changed-A', letter: 'A', colour: true },
      `a file added outside the conversation is blue with A (${theme})`,
    );
    assert.equal(marks.plain.changed, undefined);
    assert.equal(marks.plain.letter, '');
    assert.notEqual(marks.plain.colour, marks.tokens.attention);
    assert.equal(marks.gone, false, 'a deleted file is not in the tree');
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'files mode: Git asked only while shown; changes made outside the conversation marked in both themes',
  );
} finally {
  await browser?.close();
  await server.close();
}

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeProvider } from '../src/app/context.tsx';
import { PreviewRuntime } from '../src/model/state.ts';
import { Overview } from '../src/features/Overview.tsx';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { warmModules } from './helpers/workbench-server.ts';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { testBrowserOptions } from './helpers/test-browser.ts';

const browserOptions = testBrowserOptions(chromium.executablePath());
test(
  'drawer modes retain the actual document, local index and conversation draft',
  {
    skip: browserOptions ? false : 'no supported test browser is installed',
  },
  async () => {
    const server = await createServer({
      root: fileURLToPath(new URL('..', import.meta.url)),
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
      logLevel: 'error',
    });
    await server.listen();
    // The 10 s limits below are for the interface, not Vite's first compile.
    await warmModules(server);
    const browser = await chromium.launch({
      ...browserOptions,
      headless: true,
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1520, height: 980 },
        locale: 'en-US',
      });
      page.setDefaultTimeout(10000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(String(error)));
      await page.goto(server.resolvedUrls!.local[0]!);
      const composer = page.locator('.composer textarea');
      await composer.waitFor();
      await composer.fill('draft retained while reading a source document');
      await page
        .getByRole('button', { name: 'files panel', exact: true })
        .click();
      const index = page.locator('.drawer-context-index');
      const filter = index.getByRole('textbox');
      // With no file open the tree is the whole drawer, and there is no title above it.
      assert.equal(await page.locator('.drawer-document.list-only').count(), 1);
      assert.equal(await page.locator('.inspector-title').count(), 0);
      await filter.fill('connection');
      await index.getByRole('treeitem', { name: /connection.ts/ }).click();
      const editor = page.locator(
        '.drawer-document-content .native-code-editor',
      );
      // The document loads Monaco locally; no model or host user data is used.
      await editor.waitFor();
      const editorNode = await editor.elementHandle();
      assert.equal(
        await composer.inputValue(),
        'draft retained while reading a source document',
      );
      // The file opens beside the tree, which keeps its filter.
      assert.equal(await page.locator('.drawer-document.has-file').count(), 1);
      // The drawer widens for the file, and there is room for both.
      await index.waitFor({ state: 'visible' });
      assert.equal(await filter.inputValue(), 'connection');
      assert.equal(
        await page.locator('.drawer-document-header').count(),
        0,
        'the file title is not repeated above the document',
      );
      assert.equal(
        await index.locator('.panel-header-name').isVisible(),
        false,
        'legacy index heading never overlays the document',
      );
      assert.equal(
        await index.locator('.panel-header-actions').isVisible(),
        false,
        'the filter replaces the legacy floating search trigger',
      );

      // Another mode and back: the same editor, the same filter, the same draft.
      await page
        .getByRole('button', { name: 'changes panel', exact: true })
        .click();
      assert.equal(await page.locator('.changes-mode').isVisible(), true);
      await page
        .getByRole('button', { name: 'files panel', exact: true })
        .click();
      assert.equal(
        await editor.evaluate(
          (node, previous) => node === previous,
          editorNode,
        ),
        true,
      );
      assert.equal(await filter.inputValue(), 'connection');
      assert.equal(
        await composer.inputValue(),
        'draft retained while reading a source document',
      );
      await filter.fill('');
      const selectedFile = index.getByRole('treeitem', {
        name: /connection.ts/,
      });
      await selectedFile.waitFor({ state: 'visible' });
      assert.equal(
        await selectedFile.getAttribute('aria-selected'),
        'true',
        'clearing the filter reveals the actual open file',
      );
      for (const theme of ['dark', 'light'] as const) {
        await page.evaluate(async (theme) => {
          const themeModule = '/src/theme.ts';
          const { applyTheme } = await import(themeModule);
          applyTheme(theme);
        }, theme);
        await page.setViewportSize({ width: 1000, height: 720 });
        const box = await composer.boundingBox();
        assert.ok(
          box && box.y >= 0 && box.y + box.height <= 720,
          `${theme} composer remains in bounds`,
        );
        assert.equal(
          await editor.evaluate(
            (node, previous) => node === previous,
            editorNode,
          ),
          true,
        );
        assert.equal(
          await composer.inputValue(),
          'draft retained while reading a source document',
        );
      }
      await page.setViewportSize({ width: 500, height: 720 });
      await page.waitForFunction(
        () =>
          document.getElementById('workbench-columns')?.dataset
            .inspectorMode === 'closed',
      );
      if (!(await page.locator('.work-drawer').isVisible()))
        await page
          .getByRole('button', { name: 'files panel', exact: true })
          .click();
      await page
        .getByRole('button', { name: 'close file', exact: true })
        .click();
      assert.equal(await page.locator('.work-drawer').isVisible(), false);
      assert.equal(await composer.isVisible(), true);
      assert.equal(
        await composer.inputValue(),
        'draft retained while reading a source document',
      );
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await server.close();
    }
  },
);

test('overview is scoped to this session, shows nothing it was not given, and only reads', () => {
  const runtime = new PreviewRuntime();
  runtime.change((state) => {
    const session = state.sessions.find(
      (row) => row.id === state.activeSessionId,
    )!;
    session.messages = [
      {
        id: 'input',
        parentId: null,
        role: 'user',
        at: '',
        text: '',
        attachments: [
          {
            id: 'input-file',
            name: 'private-input.md',
            kind: 'file',
            content: 'attached input',
          },
        ],
      },
    ];
    // A session with no plan, no files changed and nobody working.
    session.todos = [];
    session.changes = [];
    state.agents = [];
    state.jobs = [
      {
        id: 'other',
        sessionId: 'other-session',
        kind: 'command',
        title: 'other session job',
        state: 'running',
        elapsed: '',
        output: '',
        outputPath: '',
        stopRequested: false,
      },
    ];
    session.meters = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cost: 'N/A',
      contextInput: null,
      contextWindow: null,
    };
  });
  const before = JSON.stringify(runtime.getSnapshot());
  const html = renderToStaticMarkup(
    createElement(RuntimeProvider, {
      runtime,
      children: createElement(Overview, {
        onPanel() {},
        onSession() {},
        onStartPullRequest() {},
      }),
    }),
  );
  assert.doesNotMatch(html, /private-input.md|other session job|NaN|0%/);
  // A card with nothing in it is not drawn: only the environment, the context and the
  // changes (the preview has a branch) remain.
  assert.doesNotMatch(html, />in progress</);
  assert.doesNotMatch(html, />outputs</);
  assert.match(html, />environment</);
  assert.match(html, />context</);
  assert.equal(JSON.stringify(runtime.getSnapshot()), before);
});

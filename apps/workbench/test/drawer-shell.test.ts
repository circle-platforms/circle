import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RuntimeProvider } from '../src/app/context.tsx';
import { PreviewRuntime } from '../src/model/state.ts';
import { DrawerOverview } from '../src/features/Panels.tsx';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
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
    // Compile the window's whole module graph, lazy panels included, before the
    // browser starts: the 10 s limits below are for the interface, not for a slow
    // runner's first on-demand compile (Intel macOS took longer than that).
    const warmed = new Set<string>();
    const warm = async (url: string): Promise<void> => {
      if (warmed.has(url)) return;
      warmed.add(url);
      await server.transformRequest(url);
      const node = await server.moduleGraph.getModuleByUrl(url);
      await Promise.all(
        [...(node?.importedModules ?? [])].map((child) => warm(child.url)),
      );
    };
    await warm('/src/main.tsx');
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
      await page
        .getByRole('button', { name: 'file index', exact: true })
        .click();
      assert.equal(await index.isVisible(), false);
      await page
        .getByRole('button', { name: 'file index', exact: true })
        .click();
      assert.equal(await filter.inputValue(), 'connection');
      assert.equal(
        await page.locator('.drawer-document-header').count(),
        0,
        'the file title is not repeated above the document',
      );
      assert.equal(
        await page
          .locator('.inspector-title')
          .getByRole('button', { name: 'file index', exact: true })
          .count(),
        1,
        'the resource header owns its index toggle',
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

      await page
        .getByRole('button', { name: 'overview panel', exact: true })
        .click();
      assert.equal(await page.locator('.drawer-summary-card').count(), 5);
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
      await page
        .getByRole('button', { name: 'full view', exact: true })
        .click();
      await page.locator('.inspector-full .work-drawer').waitFor();
      assert.equal(
        await composer.inputValue(),
        'draft retained while reading a source document',
      );
      assert.equal(
        await editor.evaluate(
          (node, previous) => node === previous,
          editorNode,
        ),
        true,
      );
      await page
        .getByRole('button', { name: 'exit full view', exact: true })
        .click();
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

test('overview is scoped to this session and does not relabel attached input as output', () => {
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
      {
        id: 'output',
        parentId: 'input',
        role: 'assistant',
        at: '',
        text: '',
        attachments: [
          {
            id: 'output-file',
            name: 'result.md',
            kind: 'file',
            content: 'generated output',
          },
        ],
      },
    ];
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
      children: createElement(DrawerOverview, {
        onPanel() {},
        onFile() {},
        onDialog() {},
      }),
    }),
  );
  assert.match(html, /result.md/);
  assert.doesNotMatch(html, /private-input.md|other session job|NaN|0%/);
  assert.equal((html.match(/class="drawer-summary-card"/g) ?? []).length, 5);
  assert.equal(JSON.stringify(runtime.getSnapshot()), before);
});

// Serialized native journey extension. The caller owns the app and all appearance/navigation actions.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function assertPanelControlGeometry(result, label) {
  assert.ok(
    result.width > 0 && result.height > 0,
    `${label}: control has visible geometry`,
  );
  assert.ok(
    result.viewportWidth > 0 && result.viewportHeight > 0,
    `${label}: viewport is real`,
  );
  assert.ok(
    result.left >= -1 &&
      result.top >= -1 &&
      result.right <= result.viewportWidth + 1 &&
      result.bottom <= result.viewportHeight + 1,
    `${label}: control is not clipped by viewport`,
  );
  assert.ok(
    result.clipContains,
    `${label}: control is not clipped by an ancestor`,
  );
  assert.ok(result.hit, `${label}: center is not covered by another panel`);
  assert.ok(result.focused, `${label}: actual control receives keyboard focus`);
  assert.ok(
    result.tabMoved && result.tabVisible,
    `${label}: Tab reaches another visible interactive element`,
  );
}

/** Call before final appearance screenshots, with the existing controlled page still open.
 * configureAppearance({locale,theme}) must click original Settings and return to the same session.
 * openPanel(kind) must use original Inspector/Browser toggles, and expose service form or storage tab.
 * resize(size) must resize the native BrowserWindow (not merely the renderer viewport).
 * No model, command, storage or debugger mutations are issued here.
 */
export async function runNativePanelAcceptance({
  page,
  output,
  configureAppearance,
  openPanel,
  resize,
  restore,
}) {
  assert.ok(
    output && configureAppearance && openPanel && resize && restore,
    'native panel acceptance requires original-shell adapters and explicit restoration',
  );
  await mkdir(output, { recursive: true });
  const receipt = {
    status: 'running',
    scope: 'actual native controls; navigation and appearance only',
    cases: [],
  };
  const specs = [
    { kind: 'debug', root: '.debug-panel', en: 'program path', zh: '程序路径' },
    {
      kind: 'service',
      root: '.native-service-form',
      en: 'service name',
      zh: '服务名称',
    },
    {
      kind: 'browser',
      root: '.browser-diagnostics',
      en: 'storage key',
      zh: '存储键',
    },
  ];
  try {
    for (const locale of ['en', 'zh-CN'])
      for (const theme of ['dark', 'light']) {
        await configureAppearance({ locale, theme });
        for (const size of [
          { width: 1400, height: 900 },
          { width: 760, height: 720 },
        ]) {
          await resize(size);
          for (const spec of specs) {
            await openPanel(spec.kind, { locale });
            const panel = page.locator(spec.root);
            await panel.waitFor({ state: 'visible' });
            const control = panel.getByRole('textbox', {
              name: locale === 'en' ? spec.en : spec.zh,
              exact: true,
            });
            await control.scrollIntoViewIfNeeded();
            await control.focus();
            const before = await control.inputValue();
            const geometry = await control.evaluate((node) => {
              const r = node.getBoundingClientRect();
              let clipContains = true;
              for (
                let parent = node.parentElement;
                parent;
                parent = parent.parentElement
              ) {
                const style = getComputedStyle(parent),
                  clip = parent.getBoundingClientRect();
                if (/(auto|scroll|hidden|clip)/.test(style.overflowX))
                  clipContains &&=
                    r.left >= clip.left - 1 && r.right <= clip.right + 1;
                if (/(auto|scroll|hidden|clip)/.test(style.overflowY))
                  clipContains &&=
                    r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1;
              }
              const hit = document.elementFromPoint(
                r.left + r.width / 2,
                r.top + r.height / 2,
              );
              return {
                width: r.width,
                height: r.height,
                left: r.left,
                right: r.right,
                top: r.top,
                bottom: r.bottom,
                viewportWidth: innerWidth,
                viewportHeight: innerHeight,
                clipContains,
                hit: hit === node || node.contains(hit),
                focused: document.activeElement === node,
              };
            });
            await control.press('Tab');
            Object.assign(
              geometry,
              await control.evaluate((node) => {
                const next = document.activeElement,
                  r = next?.getBoundingClientRect();
                return {
                  tabMoved: next !== node && next !== document.body,
                  tabVisible:
                    !!r &&
                    r.width > 0 &&
                    r.height > 0 &&
                    r.left >= -1 &&
                    r.top >= -1 &&
                    r.right <= innerWidth + 1 &&
                    r.bottom <= innerHeight + 1,
                };
              }),
            );
            assertPanelControlGeometry(
              geometry,
              `${locale}/${theme}/${size.width}/${spec.kind}`,
            );
            assert.equal(
              await control.inputValue(),
              before,
              'inspection and keyboard traversal preserve the existing unsent control value',
            );
            const name = `native-panel-${locale}-${theme}-${size.width}-${spec.kind}`;
            await page.screenshot({ path: join(output, name + '.png') });
            receipt.cases.push({
              locale,
              theme,
              size,
              panel: spec.kind,
              geometry,
              screenshot: name + '.png',
            });
          }
        }
      }
    receipt.status = 'passed';
    assert.equal(receipt.cases.length, 24);
    return receipt;
  } catch (error) {
    receipt.status = 'failed';
    receipt.error = String(error);
    await page
      .screenshot({ path: join(output, 'native-panel-acceptance-failure.png') })
      .catch(() => {});
    throw error;
  } finally {
    try {
      await restore();
    } catch (error) {
      receipt.restorationError = String(error);
      if (receipt.status === 'passed') {
        receipt.status = 'failed';
        throw error;
      }
    } finally {
      await writeFile(
        join(output, 'native-panel-acceptance.json'),
        JSON.stringify(receipt, null, 2) + '\n',
      );
    }
  }
}

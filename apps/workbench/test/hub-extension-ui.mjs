// The Hub extension in the window: its card on the extensions page carries the Hub's mark and its connection (state and
// tools), GitHub's carries GitHub's mark, the MCP servers page leaves the Hub out, and the Hub's page asks for its IP
// address, says where to sign in, and says a Hub not found in the window's language. English and Chinese, light and
// dark, narrow and wide; a synthetic runtime, no network.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const server = await createServer({
  root: fileURLToPath(new URL('..', import.meta.url)),
  server: { host: '127.0.0.1', port: 0 },
  logLevel: 'error',
});
await server.listen();
const output =
  process.env.CIRCLE_COMPONENT_UI_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), 'circle-hub-extension-ui-')));
await mkdir(output, { recursive: true });
let browser;
const receipts = [];
try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CIRCLE_TEST_BROWSER_CHANNEL
      ? { channel: process.env.CIRCLE_TEST_BROWSER_CHANNEL }
      : {}),
  });
  for (const language of ['en', 'zh-CN'])
    for (const theme of ['light', 'dark'])
      for (const width of [375, 1280]) {
        const page = await browser.newPage({
          viewport: { width, height: 1000 },
        });
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        page.setDefaultTimeout(5000);
        const label = (en, zh) => (language === 'en' ? en : zh);
        const name = `${language}-${theme}-${width}`;
        const open = (route) =>
          page.goto(
            `${server.resolvedUrls.local[0]}test/hub-extension-ui.html?language=${language}&theme=${theme}&route=${encodeURIComponent(route)}`,
          );
        const card = (heading) =>
          page.locator('.extension-card').filter({
            has: page.getByRole('heading', { name: heading, exact: true }),
          });

        // Extensions → runtime extensions: each shipped extension carries its service's mark
        await open('/page/extensions');
        await card('hub').waitFor();
        assert.equal(
          await card('github')
            .locator('.extension-icon svg.github-mark')
            .count(),
          1,
        );
        assert.equal(
          await card('hub').locator('.extension-icon svg.hub-mark').count(),
          1,
        );
        // The Hub's connection is its card's: the state, and the Hub's three tools beside the extension's own none
        await card('hub')
          .getByRole('status')
          .getByText(label('connected', '已连接'), { exact: true })
          .waitFor();
        await card('hub')
          .getByText(label('3 tools', '3 个工具'), { exact: true })
          .waitFor();
        await card('github')
          .getByText(label('1 tool', '1 个工具'), { exact: true })
          .waitFor();
        // The satellites are the palette's brand colours in this theme, not black
        const colours = await card('hub')
          .locator('svg.hub-mark')
          .evaluate((mark) => {
            const probe = (value) => {
              const span = document.createElement('span');
              span.style.color = value;
              document.body.append(span);
              const colour = getComputedStyle(span).color;
              span.remove();
              return colour;
            };
            return {
              satellites: [...mark.querySelectorAll('circle')]
                .slice(2)
                .map((circle) => getComputedStyle(circle).fill),
              brand: ['blue', 'violet', 'red', 'orange'].map((hue) =>
                probe(`var(--brand-${hue})`),
              ),
              black: probe('black'),
            };
          });
        assert.deepEqual(colours.satellites, colours.brand);
        assert.equal(colours.brand.includes(colours.black), false);
        assert.equal(new Set(colours.brand).size, 4);
        await page.screenshot({ path: join(output, `${name}-extensions.png`) });

        // Extensions → interface components: the same marks
        await page
          .getByRole('button', {
            name: label('interface components', '界面组件'),
            exact: true,
          })
          .click();
        assert.equal(
          await card('GitHub').locator('svg.github-mark').count(),
          1,
        );
        assert.equal(await card('Hub').locator('svg.hub-mark').count(), 1);

        // MCP servers: the Hub is the extension's, not listed here
        await open('/page/mcp');
        await page
          .getByRole('checkbox', {
            name: label('enable files-server', '启用 files-server'),
            exact: true,
          })
          .waitFor();
        assert.equal(
          await page
            .getByRole('checkbox', {
              name: label('enable Hub', '启用 Hub'),
              exact: true,
            })
            .count(),
          0,
        );
        assert.equal(
          await page.locator('.record-row').filter({ hasText: 'Hub' }).count(),
          0,
        );

        // The Hub's page: connected, it says where
        await open('/page/extensions?plugin=hub');
        const hub = page.locator('#hub-connection');
        await hub
          .getByText(
            label(
              'Hub at http://192.0.2.10:7420 · 3 tools available',
              'Hub：http://192.0.2.10:7420 · 3 个工具可用',
            ),
            { exact: true },
          )
          .waitFor();
        // No Hub yet: its IP address alone is asked for, and where the sign-in happens is said
        await page.evaluate(() => window.hubExtensionFixture.removeHub());
        const address = hub.getByRole('textbox', {
          name: label('hub IP address', 'Hub 的 IP 地址'),
          exact: true,
        });
        await address.waitFor();
        assert.equal(await address.getAttribute('placeholder'), '192.0.2.10');
        await hub
          .getByText(
            label(
              'Type your Hub’s IP address. Circle then opens the Hub’s page, where you sign in with your Hub user name and password.',
              '填写 Hub 的 IP 地址。Circle 随后打开 Hub 的网页，在网页上用 Hub 的用户名和密码登录。',
            ),
            { exact: true },
          )
          .waitFor();
        // A Hub not found is said in the window's language, with the addresses tried
        await address.fill('192.0.2.10');
        await hub
          .getByRole('button', { name: label('connect', '连接'), exact: true })
          .click();
        await hub
          .getByRole('alert')
          .getByText(
            label(
              'no Circle Hub answers at https://192.0.2.10, http://192.0.2.10, https://192.0.2.10:7420, or http://192.0.2.10:7420',
              '在 https://192.0.2.10、http://192.0.2.10、https://192.0.2.10:7420或http://192.0.2.10:7420 都没有找到 Circle Hub',
            ),
            { exact: true },
          )
          .waitFor();
        // The card says it; no notice repeats it in the conversation, which a reported failure would hold (and holds
        // before the card's own catch has run)
        assert.deepEqual(
          await page.evaluate(() =>
            window.hubExtensionFixture
              .snapshot()
              .sessions.filter(
                (session) => session.actionError || session.actionFailure,
              )
              .map((session) => session.id),
          ),
          [],
        );
        const connect = await page.evaluate(() =>
          window.hubExtensionFixture.commands.filter(
            (command) => command.name === 'hub-connect',
          ),
        );
        assert.deepEqual(
          connect.map((command) => command.payload),
          [{ address: '192.0.2.10' }],
        );
        await page.screenshot({
          path: join(output, `${name}-hub-address.png`),
        });
        // Signing in on the Hub's page: with the Hub's user name and password, and the code when there is one
        const signIn = label(
          'sign in on the Hub’s page with your Hub user name and password',
          '在 Hub 的网页上用 Hub 的用户名和密码登录',
        );
        await page.evaluate(() => window.hubExtensionFixture.signingIn());
        await hub.getByText(signIn, { exact: true }).waitFor();
        // The address error went with the address form
        assert.equal(await hub.getByRole('alert').count(), 0);
        assert.equal(await hub.locator('.device-code').count(), 0);
        await page.evaluate(() =>
          window.hubExtensionFixture.signingIn('BCDF-GHJK'),
        );
        await hub.getByText('BCDF-GHJK', { exact: true }).waitFor();
        await hub.getByText(signIn, { exact: true }).waitFor();
        await hub
          .getByText(
            label('then enter this code there', '然后在网页上输入此代码'),
            { exact: true },
          )
          .waitFor();
        await page.screenshot({
          path: join(output, `${name}-hub-sign-in.png`),
        });
        assert.deepEqual(errors, []);
        receipts.push(name);
        await page.close();
      }
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ cases: receipts }, null, 2),
  );
  console.log(JSON.stringify({ cases: receipts.length, output }));
} finally {
  await browser?.close();
  await server.close();
}

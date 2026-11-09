// Native check of an MCP server that needs a sign-in (OAuth 2.1 with PKCE) when the
// application starts: its sign-in page must open, and finishing it must connect the server.
// Isolated data folder, scripted model and a loopback authorization server that approves at
// once; no real data, model or network.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { defaultSettings, saveSettings } from '../../../src/settings.ts';
import { AuthorizedServer } from '../../../tests/fixtures/knowledge-sync/authorized-server.ts';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/mcp-sign-in');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-native-mcp-sign-in-'));
const data = join(temp, 'data');
const home = join(data, 'runtime-home');
await mkdir(home, { recursive: true });
const fixturePath = join(temp, 'model.json');
// The scripted model needs a reply to start with; nothing here asks it.
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath: join(temp, 'model-requests.jsonl'),
    replies: [{ message: { id: 'idle', role: 'assistant', content: 'idle' } }],
  }),
);
const peer = new AuthorizedServer(join(temp, 'peer'));
await peer.start();
const name = 'Synthetic sign-in';
// No credential header: the server answers 401 and Circle signs in to it.
const settings = defaultSettings();
settings.mcp_servers = [
  { name, url: peer.origin + '/mcp', transport: 'streamable_http' },
];
saveSettings(settings, home);
const env = {
  ...process.env,
  CIRCLE_WORKBENCH_DATA_DIR: data,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
  // A scripted model is accepted only in an explicit test profile.
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
};
delete env.ELECTRON_RUN_AS_NODE;
const checks = [];
const errors = [];
let app;
let page;
const state = () =>
  page
    .evaluate(() => window.circleDesktop.runtimeState())
    .then((update) => update.snapshot);
const server = async () => (await state()).mcp.find((row) => row.name === name);
async function waitFor(check, what) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
try {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [resolve(process.env.CIRCLE_DESKTOP_APP_PATH ?? root)],
    cwd: root,
    env,
    timeout: 45_000,
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  // The authorization server approves as soon as its page is opened, so a code comes back
  // to Circle only if something opened the sign-in page.
  await waitFor(
    async () => (await server())?.status === 'connected',
    'the server signed in and connected',
  );
  assert.equal(peer.tokenRequests.length, 1);
  assert.equal(peer.tokenRequests[0].get('grant_type'), 'authorization_code');
  assert.ok((await server()).tools.length > 0);
  checks.push(
    'a server that needs a sign-in at start opens its sign-in page and connects once it is done',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify({ checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks: checks.length, output }, null, 2));
} catch (error) {
  if (page) {
    await page
      .screenshot({ path: join(output, 'failure.png') })
      .catch(() => {});
    const row = await server().catch(() => undefined);
    const snapshot = await state().catch(() => undefined);
    await writeFile(
      join(output, 'failure.json'),
      JSON.stringify(
        {
          server: row,
          openUrl: snapshot?.openUrl,
          activeSessionId: snapshot?.activeSessionId,
          tokenRequests: peer.tokenRequests.length,
          requests: peer.requests.map((request) => request.path),
          errors,
        },
        null,
        2,
      ),
    ).catch(() => {});
  }
  throw error;
} finally {
  if (app) await app.close();
  await peer.close();
  await rm(temp, { recursive: true, force: true });
}

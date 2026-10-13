import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';
import { captureFailure } from './helpers/diagnostics.mjs';

// The conversation's browser, driven by a scripted model and by the person, against local
// HTTPS sites with a self-signed certificate: everything a page asks for reaches both.
const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/browser-live');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-browser-live-'));
const keyPath = join(temp, 'key.pem');
const certificatePath = join(temp, 'certificate.pem');
const fixturePath = join(temp, 'model.json');
const dataPath = join(temp, 'data');
const posts = [];
const uploads = [];
const notesPath = join(temp, 'notes.txt');
const logPath = join(temp, 'run.log');
const checks = [];
const errors = [];
let app;
let page;
let requestsPath = join(temp, 'requests.jsonl');

// Every request is local. The certificate exists only inside this test's scratch folder.
await promisify(execFile)('openssl', [
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-keyout',
  keyPath,
  '-out',
  certificatePath,
  '-days',
  '1',
  '-subj',
  '/CN=Circle Fixture Device/O=Circle browser fixture',
]);

const document = `<!doctype html>
<html><head><title>Circle HTTPS browser fixture</title>
<style>
  body { font: 16px sans-serif; margin: 20px; }
  label, input, select, button, a { display: block; margin-bottom: 8px; }
  [hidden] { display: none; }
  iframe { height: 80px; width: 260px; }
  #covered { position: relative; width: 200px; height: 48px; }
  #blocked { width: 200px; height: 48px; }
  #blocker { position: absolute; inset: 0; background: Canvas; }
</style></head><body>
<h1>Local browser form</h1>
<form id="login">
  <label for="username">Username</label><input id="username" name="username" value="old username">
  <label for="password">Password</label><input id="password" name="password" type="password" value="fixture-secret-never-in-snapshot">
  <label for="role">Role</label><select id="role" name="role"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select>
  <button type="submit">Log in</button>
</form>
<output id="result"></output>
<iframe title="same-origin controls" src="/frame"></iframe>
<section id="shadow"></section>
<button id="dialog">Open prompt</button>
<output id="dialog-result"></output>
<div id="covered"><button id="blocked" onclick="window.blockedClicks = (window.blockedClicks || 0) + 1">Covered button</button><div id="blocker">Fixture blocker</div></div>
<table><caption>Fixture table</caption><tr><th>Name</th><th>Status</th></tr><tr><td>Device</td><td>Ready</td></tr></table>
<button hidden>Hidden action</button><p hidden>Hidden page text</p>
<a id="status" href="/status" target="_blank">Status in new tab</a>
<button id="delete" onclick="document.querySelector('#delete-result').textContent = confirm('Delete the configuration?') ? 'deleted' : 'kept'">Delete configuration</button>
<output id="delete-result"></output>
<script>
  const shadowButton = document.createElement('button');
  shadowButton.textContent = 'Shadow action';
  shadowButton.addEventListener('click', () => { shadowButton.textContent = 'Shadow clicked'; });
  document.querySelector('#shadow').attachShadow({mode:'open'}).append(shadowButton);
  document.querySelector('#dialog').addEventListener('click', () => {
    const value = prompt('Fixture prompt', 'default');
    if (confirm('Fixture confirm')) {
      alert('Fixture alert');
      document.querySelector('#dialog-result').textContent = value ?? 'cancelled';
    }
  });
  document.querySelector('#login').addEventListener('submit', async (event) => {
    event.preventDefault();
    const response = await fetch('/submit', {method:'POST', body:new URLSearchParams(new FormData(event.target))});
    document.querySelector('#result').textContent = await response.text();
  });
</script></body></html>`;

const handler = async (request, response) => {
  if (request.url === '/files' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    uploads.push(body);
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Sent</title><p>files received</p>');
    return;
  }
  if (request.url === '/slow') {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Slow page</title><p>slow</p>');
    return;
  }
  if (request.url === '/download') {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="report.bin"',
    });
    response.end('report bytes');
    return;
  }
  if (request.url === '/files') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      '<!doctype html><title>Files</title><form method="post" action="/files" enctype="multipart/form-data"><label>Attachment <input type="file" name="attachment"></label><input id="logs" type="file" name="logs" style="display:none"><button type="button" onclick="document.getElementById(\'logs\').click()">Add logs</button><button>Send</button></form>',
    );
    return;
  }
  if (request.url === '/submit' && request.method === 'POST') {
    let body = '';
    for await (const chunk of request) body += chunk;
    posts.push(Object.fromEntries(new URLSearchParams(body)));
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('Submitted admin as maintainer');
    return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' });
  response.end(
    request.url === '/frame'
      ? '<!doctype html><button onclick="this.textContent = \'Frame clicked\'">Frame action</button>'
      : request.url === '/status'
        ? '<!doctype html><title>Device status</title><h1>Status: ready</h1>'
        : document,
  );
};
const tls = {
  key: await readFile(keyPath),
  cert: await readFile(certificatePath),
};
// Two sites with the same certificate: an exception is for one host and port only.
const site = createHttpsServer(tls, handler);
const other = createHttpsServer(tls, handler);
await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
const url = `https://127.0.0.1:${site.address().port}/`;
const host = `127.0.0.1:${site.address().port}`;
const otherUrl = `https://127.0.0.1:${other.address().port}/`;
// Reserve then close a local port, so connection failure does not depend on a remote host.
const unavailable = createHttpServer();
await new Promise((resolve) => unavailable.listen(0, '127.0.0.1', resolve));
const unavailableUrl = `http://127.0.0.1:${unavailable.address().port}/`;
await new Promise((resolve) => unavailable.close(resolve));

const calls = (id, toolCalls, delayMs) => ({
  message: { id, role: 'assistant', content: '', tool_calls: toolCalls },
  ...(delayMs ? { delayMs } : {}),
});
const call = (id, name, args) => ({ id, name, args });
const answer = (id, content) => ({
  message: { id, role: 'assistant', content },
});
const script = (replies) =>
  writeFile(fixturePath, JSON.stringify({ requestsPath, replies }));
await script([
  calls('navigate', [call('navigate', 'browser_navigate', { url })]),
  calls('advanced', [
    call('advanced', 'browser_click', { ref: 'e1', element: 'Advanced' }),
  ]),
  calls('proceed', [
    call('proceed', 'browser_click', { ref: 'e3', element: 'Proceed link' }),
  ]),
  answer('navigation-done', 'browser navigation completed'),
  calls('form', [
    // A secret typed where the page shows it back stays a name in the result
    call('echo', 'browser_type', {
      ref: 'e1',
      element: 'Username',
      text: '%FIXTURE_PASSWORD%',
    }),
    call('username', 'browser_type', {
      ref: 'e1',
      element: 'Username',
      text: 'admin',
    }),
    call('password-secret', 'browser_type', {
      ref: 'e2',
      element: 'Password',
      text: '%FIXTURE_PASSWORD%',
    }),
    call('role', 'browser_select', {
      ref: 'e3',
      element: 'Role',
      values: ['maintainer'],
    }),
    call('tab', 'browser_press', { key: 'Tab' }),
    call('submit', 'browser_click', { ref: 'e4', element: 'Log in' }),
  ]),
  answer('form-done', 'browser form submitted'),
  calls('edge-cases', [
    call('password', 'browser_type', {
      ref: 'e2',
      element: 'Password',
      text: 'must-not-be-typed',
    }),
    call('frame', 'browser_click', { ref: 'e5', element: 'Frame action' }),
    call('shadow', 'browser_click', { ref: 'e6', element: 'Shadow action' }),
    call('blocked', 'browser_click', { ref: 'e8', element: 'Covered button' }),
    call('open-dialog', 'browser_click', { ref: 'e7', element: 'Open prompt' }),
    call('answer-prompt', 'browser_dialog', {
      accept: true,
      text: 'fixture-answer',
    }),
    call('answer-confirm', 'browser_dialog', { accept: true }),
    call('answer-alert', 'browser_dialog', { accept: true }),
  ]),
  answer('edge-done', 'browser edge cases checked'),
  calls('delete', [
    call('delete', 'browser_click', { ref: 'e10', element: 'Delete' }),
  ]),
  // The model takes its time; meanwhile the person answers in the conversation
  calls('after-person', [call('after-person', 'browser_snapshot', {})], 6000),
  answer('delete-done', 'the person answered the dialog'),
  calls('new-tab', [
    call('new-tab', 'browser_click', { ref: 'e9', element: 'Status link' }),
  ]),
  calls('first-tab', [
    call('first-tab', 'browser_tabs', { action: 'select', tab: 't1' }),
  ]),
  answer('tabs-done', 'browser tabs checked'),
  calls('observe', [
    call('snapshot', 'browser_snapshot', {}),
    call('screenshot', 'browser_screenshot', {}),
  ]),
  answer('observe-done', 'browser screenshot received'),
  calls('failure', [
    call('unavailable', 'browser_navigate', { url: unavailableUrl }),
  ]),
  answer('failure-done', 'browser loading failure received'),
  calls('return', [call('return', 'browser_navigate', { url })]),
  answer('return-done', 'browser exception reused'),
  calls('download', [
    call('download', 'browser_navigate', { url: url + 'download' }),
  ]),
  answer('download-done', 'browser download kept'),
  calls('files', [call('files', 'browser_navigate', { url: url + 'files' })]),
  calls('upload-ref', [
    call('upload-ref', 'browser_upload', {
      ref: 'e1',
      element: 'Attachment',
      paths: [notesPath],
    }),
  ]),
  calls('add-logs', [
    call('add-logs', 'browser_click', { ref: 'e2', element: 'Add logs' }),
  ]),
  answer('chooser-waiting', 'file chooser waiting'),
  calls('send-files', [
    call('send-files', 'browser_click', { ref: 'e3', element: 'Send' }),
  ]),
  answer('files-sent', 'files sent'),
  calls('handoff', [
    call('handoff', 'browser_handoff', {
      reason: 'sign in with your security key',
    }),
  ]),
  answer('handed', 'browser handed back'),
  calls('slow-nav', [
    call('slow-nav', 'browser_navigate', { url: url + 'slow' }),
  ]),
  calls('after-takeover', [call('after-takeover', 'browser_snapshot', {})]),
  answer('takeover-done', 'takeover checked'),
]);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'circle-home'),
  CIRCLE_WORKBENCH_DATA_DIR: dataPath,
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: '{}',
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';

const requests = async () =>
  (await readFile(requestsPath, 'utf8')).trim().split('\n').map(JSON.parse);
const state = async () =>
  (await page.evaluate(() => window.circleDesktop.runtimeState())).snapshot;
const browserState = (sessionId) =>
  page.evaluate((id) => window.circleDesktop.browserState(id), sessionId);
async function waitFor(check, name) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function send(text) {
  await page.getByRole('textbox', { name: 'message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'send message', exact: true }).click();
}
// The page of the shown tab, as the person's own input reaches it
async function native(script) {
  return app.evaluate(async ({ BrowserWindow }, value) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children;
    const view = views.find((view) => view.getVisible()) ?? views[0];
    if (!view) throw Error('native browser view is missing');
    return view.webContents.executeJavaScript(value);
  }, script);
}
const nativeUrls = () =>
  app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].contentView.children.map((view) =>
      view.webContents.getURL(),
    ),
  );
// The tool result a call got, from the model request that followed it
const resultOf = async (id) => {
  for (const request of await requests()) {
    const message = request.messages.find(
      (row) => row.role === 'tool' && row.tool_call_id === id,
    );
    if (message) return message;
  }
  throw Error(`tool result ${id} did not reach the model`);
};
const textOf = async (id) => (await resultOf(id)).content;
async function launch() {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath:
      process.env.CIRCLE_DESKTOP_EXECUTABLE ?? require('electron'),
    args: [process.env.CIRCLE_DESKTOP_APP_PATH ?? root],
    cwd: root,
    env,
    timeout: 45_000,
  });
  // Playwright answers a page's dialogs itself unless something listens: let Circle do it
  app.context().on('page', (nativePage) => nativePage.on('dialog', () => {}));
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  // Electron shows alert and confirm as native boxes over the window; Circle must not.
  await app.evaluate(({ dialog }) => {
    globalThis.nativeDialogs = 0;
    const show = dialog.showMessageBox;
    dialog.showMessageBox = (...args) => {
      globalThis.nativeDialogs++;
      return show.apply(dialog, args);
    };
  });
}
const nativeDialogs = () => app.evaluate(() => globalThis.nativeDialogs);
const approval = (text) =>
  page.locator('.inline-request').filter({ hasText: text }).last();

try {
  await launch();
  const sessionId = (await state()).activeSessionId;
  const info = await page.evaluate(() => window.circleDesktop.info());
  assert.equal(info.runtimeConnected, true);
  assert.equal(info.dataPath, env.CIRCLE_WORKBENCH_DATA_DIR);

  // ---- the certificate warning is a page in the tab, which the model reads and clicks
  await send('open the local HTTPS form');
  const control = approval(url);
  await control.waitFor();
  assert.match(await control.innerText(), /browser_navigate/);
  await control
    .getByRole('button', { name: 'allow for this session', exact: true })
    .click();
  const certificate = approval('trusts an untrusted certificate');
  await certificate.waitFor();
  const warningUrl = (await nativeUrls()).find((value) =>
    value.startsWith('circle-warning://'),
  );
  assert(warningUrl, 'the warning page is loaded in the tab');
  const token = new URL(warningUrl).host;
  await page.getByTestId('browser-warning').waitFor();
  const navigated = await textOf('navigate');
  assert.match(navigated, /certificate is not trusted/);
  assert.match(navigated, /\[e1\] button "Advanced"/);
  assert.match(navigated, /\[e2\] button "Back to safety"/);
  assert.match(navigated, /It is the browser's page, not the site's/);
  assert(!navigated.includes('Proceed to'), 'proceed waits behind Advanced');
  const advanced = await textOf('advanced');
  assert.match(advanced, /\[e1\] button "Hide advanced"/);
  assert.match(advanced, /\[e2\] button "Back to safety"/);
  assert.match(
    advanced,
    new RegExp(`\\[e3\\] link "Proceed to ${host} \\(unsafe\\)" \\[new\\]`),
  );
  assert.match(advanced, /Circle Fixture Device/);
  const card = await certificate.innerText();
  assert(card.includes(host));
  assert(card.includes('Circle Fixture Device'));
  assert.equal(
    await certificate
      .getByRole('button', {
        name: 'always trust this certificate on this host',
        exact: true,
      })
      .count(),
    1,
  );
  // Nothing has passed the warning before the person answers
  assert(
    (await nativeUrls()).some((value) => value.startsWith('circle-warning://')),
  );
  await certificate
    .getByRole('button', { name: 'allow once', exact: true })
    .click();
  await page
    .getByText('browser navigation completed', { exact: true })
    .waitFor();
  await page.getByTestId('browser-insecure').waitFor();
  assert.equal((await browserState(sessionId)).insecure, true);
  const firstSnapshot = await textOf('proceed');
  assert.match(firstSnapshot, /Circle proceeded, approved by the user/);
  for (const text of [
    'Local browser form',
    'Username',
    'Frame action',
    'Shadow action',
    'Status in new tab',
  ])
    assert(firstSnapshot.includes(text), `snapshot includes ${text}`);
  assert.match(firstSnapshot, /\[e2\] password "Password" filled/);
  assert.match(firstSnapshot, /\[e10\] button "Delete configuration"/);
  assert.match(firstSnapshot, /\| Device \| Ready \|/);
  assert(!firstSnapshot.includes('fixture-secret-never-in-snapshot'));
  assert(!firstSnapshot.includes('Hidden action'));
  assert(!(await readFile(requestsPath, 'utf8')).includes(token));
  checks.push(
    'an untrusted certificate shows the browser warning in the tab; the model reads it, opens Advanced and clicks proceed, which waits for the person in the conversation; the token never reaches the model',
  );

  // ---- forms, input and the visible pointer; a saved secret typed by name
  assert.equal(
    (
      await page.evaluate(
        (payload) =>
          window.circleDesktop.runtimeCommand({
            id: crypto.randomUUID(),
            name: 'save-secret',
            payload,
          }),
        { name: 'FIXTURE_PASSWORD', value: 'secret-from-circle' },
      )
    ).ok,
    true,
  );
  await send('fill username, choose a role and submit');
  await page.getByText('browser form submitted', { exact: true }).waitFor();
  await waitFor(() => posts.length === 1, 'real HTTPS POST');
  assert.equal(posts[0].username, 'admin');
  assert.equal(posts[0].role, 'maintainer');
  assert.equal(posts[0].password, 'secret-from-circle');
  assert.match(
    await textOf('echo'),
    /\[e1\] textbox "Username" value="%FIXTURE_PASSWORD%"/,
  );
  assert.match(
    await textOf('password-secret'),
    /Typed secret FIXTURE_PASSWORD into e2/,
  );
  assert.match(await textOf('password-secret'), /password "Password" filled/);
  assert.equal(
    (await readFile(requestsPath, 'utf8')).includes('secret-from-circle'),
    false,
  );
  assert.match(await textOf('submit'), /Submitted admin as maintainer/);
  const overlay = await native(`(() => {
    const host = document.querySelector('[data-circle-browser-overlay]');
    return {exists: Boolean(host), closed: Boolean(host) && host.shadowRoot === null, pointerEvents: host && getComputedStyle(host).pointerEvents};
  })()`);
  assert.deepEqual(overlay, {
    exists: true,
    closed: true,
    pointerEvents: 'none',
  });
  checks.push(
    'one session approval covers typing, selection, keys and real clicks; a saved secret written as %NAME% goes into the password field, reaches the HTTPS server and never the model, and shows as %NAME% where the page echoes it; the pointer overlay is closed and lets input through',
  );

  // ---- page dialogs, answered by the model, never as native boxes
  await send('check password refusal, frames, shadow roots, cover and prompt');
  await page.getByText('browser edge cases checked', { exact: true }).waitFor();
  assert.match(
    await textOf('password'),
    /a password field takes only a saved secret/,
  );
  assert.match(await textOf('blocked'), /covered by .*Fixture blocker/);
  const opened = await textOf('open-dialog');
  assert.match(opened, /It opened dialog d1/);
  assert.match(
    opened,
    /\[d1\] prompt · tab t1 .*"Fixture prompt" \(default answer "default"\)/,
  );
  assert.match(opened, /The page waits for dialog d1; this is the dialog/);
  assert.match(
    await textOf('answer-prompt'),
    /\[d2\] confirm .*"Fixture confirm"/,
  );
  assert.match(
    await textOf('answer-confirm'),
    /\[d3\] alert .*"Fixture alert"/,
  );
  assert.match(
    await textOf('answer-alert'),
    /dialog d3 \(alert\) accepted by Circle/,
  );
  assert.equal(
    await native(`document.querySelector('#password').value`),
    'secret-from-circle',
  );
  assert.equal(await native('window.blockedClicks || 0'), 0);
  assert.equal(
    await native(
      `document.querySelector('iframe').contentDocument.querySelector('button').textContent`,
    ),
    'Frame clicked',
  );
  assert.equal(
    await native(
      `document.querySelector('#shadow').shadowRoot.querySelector('button').textContent`,
    ),
    'Shadow clicked',
  );
  assert.equal(
    await native(`document.querySelector('#dialog-result').textContent`),
    'fixture-answer',
  );
  assert.equal(await nativeDialogs(), 0);
  checks.push(
    'prompt, confirm and alert wait in the tab for browser_dialog, each named with its message and origin; no native box appears; passwords, covered controls, frames and shadow roots behave as before',
  );

  // ---- a dialog the person answers in the conversation while the model works
  await send('delete the configuration, then look again');
  const asked = page.getByTestId('browser-dialog-request');
  await asked.waitFor();
  assert.match(await asked.innerText(), /Delete the configuration\?/);
  await page.getByTestId('browser-page-dialog').waitFor();
  await asked.getByRole('button', { name: 'cancel', exact: true }).click();
  await page
    .getByText('the person answered the dialog', { exact: true })
    .waitFor();
  assert.match(await textOf('delete'), /It opened dialog d4/);
  assert.match(
    await textOf('after-person'),
    /dialog d4 \(confirm\) dismissed by the user/,
  );
  assert.equal(
    await native(`document.querySelector('#delete-result').textContent`),
    'kept',
  );
  assert.equal(await nativeDialogs(), 0);
  checks.push(
    'a confirm opened by the model shows in the panel and in the conversation; the person answers it there and the model learns who answered',
  );

  // ---- new tabs
  await send('open the status page and come back');
  await page.getByText('browser tabs checked', { exact: true }).waitFor();
  const tabbed = await textOf('new-tab');
  assert.match(tabbed, /It opened tab t2, now shown/);
  assert.match(tabbed, /tab t2 opened by t1 and shown/);
  assert.match(tabbed, /- t2 \(shown\) "Device status"/);
  assert.match(tabbed, /Status: ready/);
  assert.match(await textOf('first-tab'), /- t1 \(shown\)/);
  assert.equal((await browserState(sessionId)).tabs.length, 2);
  assert.equal((await browserState(sessionId)).tab, 't1');
  await page.getByRole('tab').nth(1).waitFor();
  checks.push(
    'a link that opens a new window becomes a tab shown to both, named in the result, and the model can switch back',
  );

  await send('read the browser and take its screenshot');
  await page
    .getByText('browser screenshot received', { exact: true })
    .waitFor();
  const screenshot = await resultOf('screenshot');
  assert(
    screenshot.attachments?.some(
      (row) => row.mime_type === 'image/png' && row.filename === 'browser.png',
    ),
  );
  assert.match(await textOf('snapshot'), /fixture-answer/);
  checks.push(
    'snapshot and screenshot run without another approval, and the browser PNG reaches the next model request',
  );

  await send('open the unavailable local port');
  await page
    .getByText('browser loading failure received', { exact: true })
    .waitFor();
  await page.getByTestId('browser-load-failure').waitFor();
  const failure = await browserState(sessionId);
  assert.equal(failure.failure.url, unavailableUrl);
  assert.match(failure.failure.error, /ERR_CONNECTION_REFUSED/);
  assert.match(await textOf('unavailable'), /ERR_CONNECTION_REFUSED/);
  checks.push(
    'an unavailable local port shows a load failure in the panel and tells the model',
  );

  await send('return to the HTTPS form');
  await page.getByText('browser exception reused', { exact: true }).waitFor();
  assert.doesNotMatch(await textOf('return'), /certificate is not trusted/);
  assert.equal((await browserState(sessionId)).insecure, true);
  assert.equal(
    (await state()).interactions.filter(
      (row) => row.reason === 'trusts an untrusted certificate',
    ).length,
    1,
  );
  checks.push(
    'a certificate allowed once is not asked about again until Circle closes',
  );

  // ---- downloads are kept where the result says; files reach a page only as allowed
  await send('download the report');
  await page.getByText('browser download kept', { exact: true }).waitFor();
  const kept = join(dataPath, 'downloads', 'report.bin');
  assert.match(
    await textOf('download'),
    /The address started download dl1 instead of opening a page\./,
  );
  assert(
    (await textOf('download')).includes(
      `download dl1 finished: ${kept} (12 B)`,
    ),
  );
  assert.equal(await readFile(kept, 'utf8'), 'report bytes');
  await page
    .getByTestId('browser-downloads')
    .getByText('report.bin', { exact: true })
    .waitFor();
  await writeFile(notesPath, 'notes from circle');
  await writeFile(logPath, 'log line');
  // The person's file dialog is stubbed: it would choose run.log
  await app.evaluate(({ dialog }, chosen) => {
    globalThis.fileDialogs = 0;
    dialog.showOpenDialog = async () => {
      globalThis.fileDialogs++;
      return { canceled: false, filePaths: [chosen] };
    };
  }, logPath);
  await send('give the form the notes and the logs');
  const files = approval('gives the page files');
  await files.waitFor();
  assert.match(await files.innerText(), /notes\.txt/);
  await files.getByRole('button', { name: 'allow once', exact: true }).click();
  await page.getByText('file chooser waiting', { exact: true }).waitFor();
  assert.match(
    await textOf('upload-ref'),
    /Gave "notes\.txt" \(17 B\) to e1 "Attachment"\./,
  );
  assert.match(
    await textOf('add-logs'),
    /It opened file chooser f1: answer it with browser_upload\./,
  );
  // No system dialog opened for Circle's click; the person answers in the panel
  assert.equal(await app.evaluate(() => globalThis.fileDialogs), 0);
  const chooser = page.getByTestId('browser-chooser');
  await chooser.getByRole('button', { name: 'choose…', exact: true }).click();
  await chooser.waitFor({ state: 'hidden' });
  assert.equal(await app.evaluate(() => globalThis.fileDialogs), 1);
  await send('send the files');
  await page.getByText('files sent', { exact: true }).waitFor();
  assert.match(
    await textOf('send-files'),
    /file chooser f1 was answered by the user with "run\.log"/,
  );
  await waitFor(() => uploads.length === 1, 'multipart upload');
  assert.match(
    uploads[0],
    /name="attachment"; filename="notes\.txt"[\s\S]*notes from circle/,
  );
  assert.match(uploads[0], /name="logs"; filename="run\.log"[\s\S]*log line/);
  checks.push(
    "a download goes to the downloads folder and the panel lists it; a file for a file input asks the person in the conversation; a chooser opened by Circle's click waits in the result and in the panel, where the person chooses; the site receives both files",
  );

  // ---- taking turns: Circle hands the person the browser, and the person takes it
  await send('hand me the browser');
  const handoffCard = page.getByTestId('browser-handoff-request');
  await handoffCard.waitFor();
  const band = page.getByTestId('browser-control');
  await band.waitFor();
  assert.match(await band.innerText(), /sign in with your security key/);
  assert.equal((await browserState(sessionId)).control, 'user');
  const bar = page.getByRole('textbox', {
    name: 'browser address',
    exact: true,
  });
  await bar.fill(url + 'status');
  await bar.press('Enter');
  await waitFor(
    async () => (await browserState(sessionId)).url === url + 'status',
    'the person goes elsewhere',
  );
  await handoffCard
    .getByRole('button', { name: 'hand back', exact: true })
    .click();
  await page.getByText('browser handed back', { exact: true }).waitFor();
  assert.match(
    await textOf('handoff'),
    /### Result\nThe user handed the browser back\./,
  );
  assert(
    (await textOf('handoff')).includes(
      `tab t1 went to ${url}status while Circle was not acting`,
    ),
  );
  assert.equal((await browserState(sessionId)).control, 'shared');
  await send('open the slow page');
  await page.getByTestId('browser-operating').waitFor();
  // A click on the clear layer over the page while Circle acts
  const masked = await app.evaluate(async ({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows()[0].contentView.children;
    const mask = views.at(-1);
    if (!mask?.webContents.getURL().includes('circle-mask')) return 'no layer';
    // The layer is clear: the page shows through it
    const image = await mask.webContents.capturePage();
    const alpha = image.toBitmap()[3];
    for (const type of ['mouseDown', 'mouseUp'])
      mask.webContents.sendInputEvent({
        type,
        x: 20,
        y: 20,
        button: 'left',
        clickCount: 1,
      });
    return alpha;
  });
  assert.equal(masked, 0);
  await page.getByTestId('browser-pending').waitFor();
  await band.waitFor();
  // The model's next look waits for the browser back, then shows the page as it is
  await handoffCard.waitFor();
  await band.getByRole('button', { name: 'hand back', exact: true }).click();
  await page.getByText('takeover checked', { exact: true }).waitFor();
  assert.match(await textOf('slow-nav'), /the user took over the browser/);
  assert.match(
    await textOf('after-takeover'),
    /Nothing was done: the user had the browser and has handed it back\./,
  );
  assert.equal((await browserState(sessionId)).control, 'shared');
  checks.push(
    "the model hands the person the browser and learns only where the tabs went; the person's click on the layer over the page takes it once Circle's action ends, and Circle's next look waits for it back",
  );

  // ---- the person's own click on proceed needs no approval, on another port
  const address = page.getByRole('textbox', {
    name: 'browser address',
    exact: true,
  });
  await address.fill(otherUrl);
  await address.press('Enter');
  await page.getByTestId('browser-warning').waitFor();
  await native(`document.getElementById('advanced').click()`);
  await native(`document.getElementById('proceed').click()`);
  await page.getByTestId('browser-insecure').waitFor();
  assert.equal((await browserState(sessionId)).url, otherUrl);
  assert((await state()).interactions.every((row) => row.status !== 'pending'));
  checks.push(
    'the same certificate on another port warns again, and the person passes it in the tab without an approval',
  );
  assert.deepEqual(errors, []);
  await page.screenshot({ path: join(output, 'browser-live.png') });
  await app.close();
  app = undefined;

  // ---- after a restart: allowed once is forgotten; the person's way back reaches the model
  requestsPath = join(temp, 'restart-requests.jsonl');
  await script([
    calls('restart-navigate', [
      call('restart-navigate', 'browser_navigate', { url }),
    ]),
    answer('restart-warning', 'warning seen after restart'),
    calls('again', [call('again', 'browser_navigate', { url })]),
    calls('again-advanced', [
      call('again-advanced', 'browser_click', {
        ref: 'e1',
        element: 'Advanced',
      }),
    ]),
    calls('again-proceed', [
      call('again-proceed', 'browser_click', { ref: 'e3', element: 'Proceed' }),
    ]),
    answer('trusted', 'certificate trusted for good'),
  ]);
  await launch();
  assert.equal((await state()).activeSessionId, sessionId);
  // The session's "allow for this session" answer is kept with it across restarts
  await send('open the form after the restart');
  await page.getByText('warning seen after restart', { exact: true }).waitFor();
  assert.match(await textOf('restart-navigate'), /certificate is not trusted/);
  await native(`document.getElementById('back').click()`);
  await page.getByTestId('browser-warning').waitFor({ state: 'hidden' });
  await send('try again and trust it for good');
  await approval('trusts an untrusted certificate')
    .getByRole('button', {
      name: 'always trust this certificate on this host',
      exact: true,
    })
    .click();
  await page
    .getByText('certificate trusted for good', { exact: true })
    .waitFor();
  assert.match(await textOf('again'), /the user went back to safety/);
  assert.match(
    await textOf('again-proceed'),
    /trusted on this host from now on/,
  );
  const trusted = JSON.parse(
    await readFile(join(dataPath, 'browser-certificates.json'), 'utf8'),
  );
  assert.deepEqual(
    trusted.certificates.map((entry) => entry.host),
    [host],
  );
  checks.push(
    'an exception allowed once ends with Circle; the person going back reaches the model as an event; trusting for good is saved for this host and certificate',
  );
  await app.close();
  app = undefined;

  requestsPath = join(temp, 'trusted-requests.jsonl');
  await script([
    calls('trusted-navigate', [
      call('trusted-navigate', 'browser_navigate', { url }),
    ]),
    answer('trusted-done', 'trusted site opened'),
  ]);
  await launch();
  await send('open the trusted site');
  await page.getByText('trusted site opened', { exact: true }).waitFor();
  const trustedResult = await textOf('trusted-navigate');
  assert.doesNotMatch(trustedResult, /certificate is not trusted/);
  assert.match(trustedResult, /Local browser form/);
  assert.equal((await browserState(sessionId)).insecure, true);
  checks.push(
    'a certificate trusted for good opens without a warning after another restart',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    join(
      output,
      info.packaged ? 'packaged-receipt.json' : 'development-receipt.json',
    ),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode: 'live',
        packaged: info.packaged,
        dataIsolation: true,
        scriptedModel: true,
        localHttps: true,
        checks,
        errors,
        source: await sourceEvidence(),
        renderer: await rendererEvidence(root),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      { checks: checks.length, packaged: info.packaged, output },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(output, 'failure-model.jsonl'),
    await readFile(requestsPath, 'utf8').catch(() => ''),
  );
  await captureFailure(page, error, errors, output);
  throw error;
} finally {
  if (app) await app.close();
  for (const server of [site, other]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}

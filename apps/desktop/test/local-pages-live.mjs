import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// A page and a PDF of the workspace open in the conversation's browser, in the running
// application: the page loads its own pictures and nothing from the network, cannot
// leave for a site or read outside the workspace, and the PDF shows in Chromium's viewer.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/local-pages-live');
await mkdir(output, { recursive: true });
const temp = await realpath(
  await mkdtemp(join(tmpdir(), 'circle-local-pages-live-')),
);
await writeFile(join(temp, 'secret.txt'), 'SYNTHETIC-SECRET\n');
// Every request a page makes to the network would reach this server; none may
const reached = [];
const server = createServer((request, response) => {
  reached.push(request.url);
  response.end('SYNTHETIC-NETWORK');
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const site = `http://127.0.0.1:${server.address().port}`;
const picture = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8AAQv8BD/kD/YURmXYAAAAASUVORK5CYII=',
  'base64',
);
// The page reports in its title what it could load: the network, a file outside the
// workspace, its own picture
const design = `<!doctype html><title>loading</title><img id="pic" src="pic.png">
<script>
const picture = new Promise((done) => {
  const image = document.getElementById('pic');
  if (image.complete) done(image.naturalWidth);
  image.onload = () => done(image.naturalWidth);
  image.onerror = () => done(-1);
});
Promise.allSettled([
  fetch('${site}/fetch'),
  fetch('/../../secret.txt').then((r) => (r.ok ? r.text() : 'refused')),
  picture,
]).then(([network, outside, width]) => {
  document.title = [
    network.status === 'rejected' ? 'network-blocked' : 'network-reached',
    outside.value === 'refused' ? 'outside-refused' : 'outside-read',
    'picture-' + width.value,
  ].join(' ');
});
</script>`;
// The smallest PDF that says something
const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
  '<< /Length 44 >>\nstream\nBT /F1 24 Tf 40 100 Td (SYNTHETIC PDF) Tj ET\nendstream',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
];
let pdf = '%PDF-1.4\n';
const offsets = [];
objects.forEach((object, index) => {
  offsets.push(pdf.length);
  pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
});
const xref = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets)
  pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
/** The conversation's workspace, with a design page, its picture, a PDF and a note. */
async function writeWorkspace(workspace) {
  await mkdir(join(workspace, '.tmp', 'designs'), { recursive: true });
  await mkdir(join(workspace, 'docs'), { recursive: true });
  await writeFile(join(workspace, '.tmp', 'designs', 'pic.png'), picture);
  await writeFile(join(workspace, '.tmp', 'designs', 'page.html'), design);
  await writeFile(join(workspace, 'docs', 'spec.pdf'), pdf, 'latin1');
  await writeFile(join(workspace, 'notes.txt'), 'SYNTHETIC-NOTE\n');
}
const fixturePath = join(temp, 'model.json');
await writeFile(
  fixturePath,
  JSON.stringify({ requestsPath: join(temp, 'requests.jsonl'), replies: [] }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en-US',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({}),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
};
delete env.ELECTRON_RUN_AS_NODE;
if (process.env.CIRCLE_DESKTOP_EXECUTABLE)
  env.PATH =
    process.platform === 'win32'
      ? process.env.SystemRoot + '\\System32'
      : '/usr/bin:/bin:/usr/sbin:/sbin';
const checks = [];
let app;
async function waitFor(check, name, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  let last;
  while (!(last = await check())) {
    if (Date.now() > deadline) throw Error(`timed out: ${name}`);
    await new Promise((done) => setTimeout(done, 50));
  }
  return last;
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
  const page = await app.firstWindow();
  await page.getByRole('textbox', { name: 'message', exact: true }).waitFor();
  // The active conversation and the workspace it works in, inside this test's scratch
  const { sessionId, workspace } = await page.evaluate(async () => {
    const { snapshot } = await window.circleDesktop.runtimeState();
    const session = snapshot.sessions.find(
      (row) => row.id === snapshot.activeSessionId,
    );
    return {
      sessionId: session.id,
      workspace: snapshot.workspaces.find(
        (row) => row.id === session.workspaceId,
      ).path,
    };
  });
  assert.ok(
    (await realpath(workspace)).startsWith(temp),
    'the workspace is the test scratch',
  );
  await writeWorkspace(workspace);
  const host = (method, ...args) =>
    page.evaluate(({ method, args }) => window.circleDesktop[method](...args), {
      method,
      args,
    });
  const state = () => host('browserState', sessionId);
  // Only a page or PDF of the conversation's own workspace gets an address
  await assert.rejects(
    host('browserLocalPage', sessionId, '../secret.txt'),
    /only pages and PDFs|not a file of this workspace/,
  );
  await assert.rejects(
    host('browserLocalPage', sessionId, 'notes.txt'),
    /only pages and PDFs/,
  );
  const pageUrl = await host(
    'browserLocalPage',
    sessionId,
    '.tmp/designs/page.html',
  );
  assert.match(
    pageUrl,
    /^circle-local:\/\/[0-9a-f]{32}\/\.tmp\/designs\/page\.html$/,
  );
  checks.push('a workspace page gets an address of its own; other files none');
  // The page loads its picture, reaches nothing on the network and nothing outside
  await host('browserNavigate', sessionId, pageUrl);
  const title = await waitFor(async () => {
    const value = (await state()).title;
    return /^network-/.test(value ?? '') ? value : '';
  }, 'the page reports what it could load');
  assert.equal(title, 'network-blocked outside-refused picture-2');
  assert.deepEqual(reached, []);
  checks.push(
    'the page loads its own picture, and neither the network nor a file outside the workspace',
  );
  // A script cannot take the page to a site, in its tab or a new one
  const tabs = (await state()).tabs?.length ?? 1;
  await app.evaluate(
    async ({ webContents }, { url, site }) => {
      const tab = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === url);
      await tab.executeJavaScript(
        `window.open(${JSON.stringify(site + '/popup')}); location.href = ${JSON.stringify(site + '/leave')};`,
      );
    },
    { url: pageUrl, site },
  );
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal((await state()).url, pageUrl);
  assert.equal((await state()).tabs?.length ?? 1, tabs);
  assert.deepEqual(reached, []);
  checks.push('a script on the page cannot leave for a site or open one');
  // The address bar still refuses any file it was not handed
  await assert.rejects(
    host(
      'browserNavigate',
      sessionId,
      pathToFileURL(join(temp, 'secret.txt')).href,
    ),
    /invalid browser address/,
  );
  checks.push('a typed file address stays refused');
  // The PDF opens as its own file in Chromium's viewer
  const pdfUrl = await host('browserLocalPage', sessionId, 'docs/spec.pdf');
  assert.equal(
    pdfUrl,
    pathToFileURL(join(await realpath(workspace), 'docs', 'spec.pdf')).href,
  );
  await host('browserNavigate', sessionId, pdfUrl);
  await waitFor(async () => {
    const current = await state();
    return current.url === pdfUrl && !current.loading && !current.failure;
  }, 'the PDF shows');
  const shot = await app.evaluate(async ({ webContents }, url) => {
    const tab = webContents
      .getAllWebContents()
      .find((contents) => contents.getURL() === url);
    return (await tab.capturePage()).toPNG().toString('base64');
  }, pdfUrl);
  await writeFile(join(output, 'pdf.png'), Buffer.from(shot, 'base64'));
  assert.deepEqual(reached, []);
  checks.push('a workspace PDF shows in the viewer');
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await app?.close().catch(() => {});
  server.close();
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}

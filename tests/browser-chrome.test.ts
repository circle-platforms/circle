import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { ChromeBrowser, findBrowser } from '../src/browser/chrome.js';
import { browserTools } from '../src/browser/tools.js';
import { saveSecret } from '../src/secrets.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import type {
  BrowserAction,
  CertificateApproval,
} from '../src/browser/protocol.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, scratch as made } from './helpers.js';

// The terminal's browser, driven for real: a Chrome or Edge without a window, local HTTP and
// HTTPS sites with a certificate made for this test, nothing from the network.
const executable = findBrowser();
const openssl = spawnSync('openssl', ['version']).status === 0;
const skip = !executable
  ? 'no Chrome, Edge or Chromium is installed'
  : !openssl
    ? 'openssl is not on PATH to make a test certificate'
    : false;

test('findBrowser looks where Chrome and Edge are installed, and CIRCLE_BROWSER wins', () => {
  const present = (paths: string[]) => (path: string) => paths.includes(path);
  assert.equal(
    findBrowser(
      {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      },
      'win32',
      present(['C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']),
    ),
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  );
  // Chrome before Edge, wherever each is
  assert.equal(
    findBrowser(
      {
        ProgramFiles: 'C:\\Program Files',
        LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local',
      },
      'win32',
      present([
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
      ]),
    ),
    'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  );
  assert.equal(
    findBrowser(
      { HOME: '/Users/a' },
      'darwin',
      present([
        '/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]),
    ),
    '/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  );
  assert.equal(
    findBrowser(
      { PATH: '/usr/local/bin:/usr/bin' },
      'linux',
      present(['/usr/bin/chromium', '/usr/bin/google-chrome']),
    ),
    '/usr/bin/google-chrome',
  );
  assert.equal(
    findBrowser(
      { CIRCLE_BROWSER: '/opt/x/chrome', PATH: '/usr/bin' },
      'linux',
      present(['/opt/x/chrome', '/usr/bin/google-chrome']),
    ),
    '/opt/x/chrome',
  );
  assert.equal(
    findBrowser({ CIRCLE_BROWSER: '/missing' }, 'linux', present([])),
    undefined,
  );
  assert.equal(
    findBrowser({ PATH: '/usr/bin' }, 'linux', present([])),
    undefined,
  );
});

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve((server.address() as { port: number }).port),
    ),
  );

test(
  'the terminal browser reads and acts on pages, answers dialogs, follows tabs and passes certificate warnings only with approval',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-test-');
    const key = join(temp, 'key.pem');
    const cert = join(temp, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=Circle Fixture Device/O=Circle browser fixture',
      ],
      { stdio: 'ignore' },
    );
    const fingerprint = new X509Certificate(readFileSync(cert)).fingerprint256;
    const posts: Record<string, string>[] = [];
    const uploads: string[] = [];
    const site = createHttp((req, res) => {
      const url = new URL(req.url ?? '/', 'http://local');
      const page = (body: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>${body}`);
      };
      if (req.method === 'POST' && url.pathname === '/submit') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          const fields = Object.fromEntries(new URLSearchParams(body));
          posts.push(fields);
          page(`<title>Signed in</title><p>Welcome ${fields.username}</p>`);
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/files') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          uploads.push(body);
          page(`<title>Sent</title><p>received ${body.length} bytes</p>`);
        });
        return;
      }
      if (url.pathname === '/files')
        return page(
          `<title>Files</title><form method="post" action="/files" enctype="multipart/form-data"><label>Attachment <input type="file" name="attachment" accept=".txt"></label><input id="logs" type="file" name="logs" multiple style="display:none"><button type="button" onclick="document.getElementById('logs').click()">Add logs</button><button>Send</button></form>`,
        );
      if (url.pathname === '/form')
        return page(
          `<title>Form</title><form method="post" action="/submit"><label>User <input name="username"></label><label>Password <input name="password" type="password"></label><label>Role <select name="role"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select></label><button>Sign in</button></form>`,
        );
      if (url.pathname === '/dialogs')
        return page(
          `<title>Dialogs</title><button onclick="if (confirm('Delete it?')) alert('Deleted')">Delete</button><button onclick="document.getElementById('out').textContent = 'name: ' + prompt('Name?', 'circle')">Name</button><p id="out"></p>`,
        );
      if (url.pathname === '/popup')
        return page(
          `<title>Opener</title><button onclick="window.open('/form')">Open form</button>`,
        );
      if (url.pathname === '/link')
        return page(
          `<title>Links</title><a href="${url.searchParams.get('to')}">Device</a>`,
        );
      if (url.pathname === '/auth') {
        // HTTP sign-in, as a device's admin pages ask for it
        const sent = req.headers.authorization ?? '';
        if (
          sent === `Basic ${Buffer.from('admin:lab-pass').toString('base64')}`
        )
          return page('<title>Lab device</title><p>signed in by HTTP</p>');
        res.writeHead(401, {
          'www-authenticate': 'Basic realm="Lab device"',
          'content-type': 'text/html',
        });
        return res.end('<!doctype html><title>401</title><p>sign in first</p>');
      }
      if (url.pathname === '/download') {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment; filename="report.bin"',
        });
        return res.end('data');
      }
      res.writeHead(404);
      res.end();
    });
    const device = () =>
      createHttps(
        { key: readFileSync(key), cert: readFileSync(cert) },
        (_req, res) => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(
            '<!doctype html><title>Fixture device login</title><p>device</p>',
          );
        },
      );
    const devices = [device(), device()];
    const http = `http://127.0.0.1:${await listen(site)}`;
    const ports = await Promise.all(devices.map(listen));
    t.after(() => {
      site.close();
      for (const server of devices) server.close();
    });
    const trustFile = join(temp, 'browser-certificates.json');
    const downloads = join(temp, 'downloads');
    const start = () =>
      new ChromeBrowser({
        executable: executable!,
        trustFile,
        headless: true,
        downloads,
      });
    let chrome = start();
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    // A failure names the step it happened at
    const act = (action: BrowserAction, args: Record<string, unknown> = {}) =>
      chrome
        .request('conversation-1', action, args, signal)
        .catch((error: Error) => {
          error.message = `${action} ${JSON.stringify(args)}: ${error.message}`;
          throw error;
        });
    const ref = (text: string, pattern: RegExp) => {
      const match = text.match(pattern);
      assert(match, `no ${pattern} in:\n${text}`);
      return match[1]!;
    };

    // ---- a page, a form, a password from a secret
    const form = await act('navigate', { url: `${http}/form` });
    assert.match(form.text, /### Result\nLoaded\./);
    assert.match(
      form.text,
      /tab t1 · "Form" · http:\/\/127\.0\.0\.1:\d+\/form/,
    );
    const user = ref(form.text, /\[(e\d+)\] textbox "User"/);
    const password = ref(form.text, /\[(e\d+)\] password "Password" empty/);
    const role = ref(form.text, /\[(e\d+)\] combobox "Role/);
    await act('type', { ref: user, element: 'user', text: 'admin' });
    // Plain text never goes into a password field; a secret marked by the runtime does
    await assert.rejects(
      act('type', { ref: password, element: 'password', text: 'hunter2' }),
      /a password field takes only a saved secret/,
    );
    const typed = await act('type', {
      ref: password,
      element: 'password',
      text: 'value-from-a-secret',
      secret: true,
      secretName: 'LAB_PASSWORD',
    });
    assert.match(typed.text, /Typed secret LAB_PASSWORD into/);
    assert.match(typed.text, /password "Password" filled/);
    assert.doesNotMatch(typed.text, /value-from-a-secret/);
    await act('select', { ref: role, element: 'role', values: ['Maintainer'] });
    const submit = ref(typed.text, /\[(e\d+)\] button "Sign in"/);
    const signedIn = await act('click', { ref: submit, element: 'sign in' });
    assert.match(signedIn.text, /"Signed in"/);
    assert.match(signedIn.text, /Welcome admin/);
    assert.deepEqual(posts, [
      {
        username: 'admin',
        password: 'value-from-a-secret',
        role: 'maintainer',
      },
    ]);

    // ---- dialogs: the model reads them and answers them, one after another
    const dialogs = await act('navigate', { url: `${http}/dialogs` });
    const remove = await act('click', {
      ref: ref(dialogs.text, /\[(e\d+)\] button "Delete"/),
      element: 'delete',
    });
    assert.match(remove.text, /It opened dialog d1\./);
    assert.match(
      remove.text,
      /### Dialogs waiting\n- \[d1\] confirm · tab t1 · from http:\/\/127\.0\.0\.1:\d+: "Delete it\?"/,
    );
    assert.match(remove.text, /The page waits for dialog d1/);
    // Acting on the page waits for the dialog to be answered
    const blocked = await act('press', { key: 'Tab' });
    assert.match(
      blocked.text,
      /Nothing was done: the page waits for dialog d1/,
    );
    const confirmed = await act('dialog', { accept: true });
    assert.match(confirmed.text, /Accepted dialog d1\./);
    assert.match(confirmed.text, /\[d2\] alert · tab t1 · .*"Deleted"/);
    const alerted = await act('dialog', { id: 'd2', accept: true });
    assert.doesNotMatch(alerted.text, /Dialogs waiting/);
    const name = await act('click', {
      ref: ref(alerted.text, /\[(e\d+)\] button "Name"/),
      element: 'name',
    });
    assert.match(
      name.text,
      /\[d3\] prompt .*"Name\?" \(default answer "circle"\)/,
    );
    const answered = await act('dialog', {
      accept: true,
      text: 'typed answer',
    });
    assert.match(answered.text, /name: typed answer/);

    // ---- a page's new window is a tab, shown; tabs can be listed, selected and closed
    const opener = await act('navigate', { url: `${http}/popup` });
    const opened = await act('click', {
      ref: ref(opener.text, /\[(e\d+)\] button "Open form"/),
      element: 'open',
    });
    assert.match(opened.text, /It opened tab t2, now shown\./);
    assert.match(
      opened.text,
      /### Tabs\n- t1 "Opener" .*\n- t2 \(shown\) "Form"/,
    );
    assert.match(opened.text, /tab t2 · "Form"/);
    const back = await act('tabs', { action: 'select', tab: 't1' });
    assert.match(back.text, /tab t1 · "Opener"/);
    const closed = await act('tabs', { action: 'close', tab: 't2' });
    assert.match(closed.text, /Closed tab t2\./);
    assert.doesNotMatch(closed.text, /t2 \(shown\)/);

    // ---- a download from a site not allowed yet waits for the person; once kept, it lands
    // in the downloads folder by its own name, and the model is told where
    const download = await act('navigate', { url: `${http}/download` });
    assert.match(
      download.text,
      /The address started download dl1 instead of opening a page\./,
    );
    assert.match(
      download.text,
      /- download dl1 of "report\.bin" from http:\/\/127\.0\.0\.1:\d+\/download waits for approval to keep it/,
    );
    assert.deepEqual(download.approval, {
      kind: 'download',
      token: (download.approval as { token: string }).token,
      site: http,
      files: [{ name: 'report.bin', size: 4 }],
    });
    assert.equal(existsSync(join(downloads, 'report.bin')), false);
    const kept = await act('navigate', {
      url: `${http}/download`,
      approval: {
        token: (download.approval as { token: string }).token,
        scope: 'always',
      },
    });
    assert.equal(kept.approval, undefined);
    assert.equal(
      kept.text,
      `### Download\nThe download was kept.\n- download dl1 finished: ${join(downloads, 'report.bin')} (4 B)`,
    );
    assert.equal(readFileSync(join(downloads, 'report.bin'), 'utf8'), 'data');
    // The site is allowed for the conversation now: no question
    const twice = await act('navigate', { url: `${http}/download` });
    assert.equal(twice.approval, undefined);
    assert(
      twice.text.includes(
        `download dl2 finished: ${join(downloads, 'report (1).bin')}`,
      ),
      twice.text,
    );
    // ---- an HTTP sign-in Circle's action meets waits for the model, as a dialog
    const auth = await act('navigate', { url: `${http}/auth` });
    assert.match(
      auth.text,
      /### Result\nThe site asks for a sign-in: dialog (d\d+)\./,
    );
    const signIn = ref(auth.text, /sign-in: dialog (d\d+)\./);
    assert.match(
      auth.text,
      new RegExp(
        `- \\[${signIn}\\] sign-in · tab t1 · the site http://127\\.0\\.0\\.1:\\d+ \\("Lab device"\\) asks for a user name and password`,
      ),
    );
    assert.match(auth.text, /password "Password" → browser_dialog password/);
    // Nothing else is done on the page meanwhile
    const authBlocked = await act('press', { key: 'Enter' });
    assert.match(authBlocked.text, new RegExp(`waits for dialog ${signIn}`));
    const authWrong = await act('dialog', {
      accept: true,
      text: 'admin',
      password: 'not-it',
    });
    assert.match(
      authWrong.text,
      /it asks again, so the user name or password was not accepted/,
    );
    const authAgain = ref(authWrong.text, /\[(d\d+)\] sign-in/);
    assert.notEqual(authAgain, signIn);
    // A password answers only a sign-in
    const authAnswered = await act('dialog', {
      id: authAgain,
      accept: true,
      text: 'admin',
      password: 'lab-pass',
    });
    assert.match(
      authAnswered.text,
      new RegExp(
        `Answered sign-in ${authAgain} for http://127\\.0\\.0\\.1:\\d+ as "admin"\\.`,
      ),
    );
    assert.match(authAnswered.text, /signed in by HTTP/);
    assert.doesNotMatch(authAnswered.text, /lab-pass/);

    // ---- files for a page, by a file input's ref or for the chooser a click opened,
    // each time with the person's approval
    const notes = join(temp, 'notes.txt');
    writeFileSync(notes, 'notes from circle');
    const log = join(temp, 'run.log');
    writeFileSync(log, 'log line');
    const filesPage = await act('navigate', { url: `${http}/files` });
    const attachment = ref(
      filesPage.text,
      /\[(e\d+)\] file "Attachment" accepts "\.txt" no file chosen/,
    );
    const ask = await act('upload', {
      ref: attachment,
      element: 'attachment',
      paths: [notes],
    });
    assert.equal(ask.text, 'Giving the page files needs the user’s approval.');
    assert.deepEqual(
      { ...ask.approval, token: typeof ask.approval?.token },
      {
        kind: 'upload',
        token: 'string',
        origin: http,
        element: 'attachment',
        files: [{ path: realpathSync(notes), name: 'notes.txt', size: 17 }],
      },
    );
    // An approval is for its files only
    const other = await act('upload', {
      ref: attachment,
      element: 'attachment',
      paths: [log],
      approval: { token: ask.approval!.token },
    });
    assert(other.approval, other.text);
    const given = await act('upload', {
      ref: attachment,
      element: 'attachment',
      paths: [log],
      approval: { token: other.approval!.token },
    });
    assert.match(given.text, /Gave "run\.log" \(8 B\) to e\d+ "attachment"\./);
    assert.match(
      given.text,
      /\[e\d+\] file "Attachment" accepts "\.txt" chosen "run\.log"/,
    );
    // What cannot go is refused before anyone is asked
    await assert.rejects(
      act('upload', { ref: attachment, paths: [temp] }),
      /not a file/,
    );
    await assert.rejects(
      act('upload', { ref: attachment, paths: [notes, log] }),
      /takes one file/,
    );
    linkSync(notes, join(temp, 'second-name.txt'));
    await assert.rejects(
      act('upload', { ref: attachment, paths: [notes] }),
      /other names on disk/,
    );
    await assert.rejects(
      act('upload', { paths: [log] }),
      /no file chooser is waiting/,
    );
    // A hidden input behind a button: Circle's click brings its chooser to the result
    const addLogs = ref(given.text, /\[(e\d+)\] button "Add logs"/);
    // A failure here says which browser it was and whether its chooser reached Circle
    const browser = chrome as unknown as {
      cdp: {
        send: (method: string) => Promise<{ product?: string }>;
        on: (listener: (event: { method: string }) => void) => () => void;
      };
    };
    const choosers: string[] = [];
    const stop = browser.cdp.on((event) => {
      if (event.method === 'Page.fileChooserOpened')
        choosers.push(event.method);
    });
    const product = (await browser.cdp.send('Browser.getVersion')).product;
    const opened2 = await act('click', {
      ref: addLogs,
      element: 'add logs',
    }).catch((error: Error) => {
      error.message += ` (${product}; chooser events: ${choosers.length})`;
      throw error;
    });
    stop();
    assert.match(
      opened2.text,
      /It opened file chooser f1: answer it with browser_upload\./,
    );
    assert.match(
      opened2.text,
      /### File chooser waiting\n- \[f1\] tab t1 · several files → browser_upload/,
    );
    const askLogs = await act('upload', { paths: [log] });
    const chosen = await act('upload', {
      paths: [log],
      approval: { token: askLogs.approval!.token },
    });
    assert.match(chosen.text, /Gave "run\.log" \(8 B\) to "file chooser f1"\./);
    assert.doesNotMatch(chosen.text, /File chooser waiting/);
    // Closing a chooser without a file
    await act('click', { ref: addLogs, element: 'add logs' });
    const closedChooser = await act('upload', { paths: [] });
    assert.match(closedChooser.text, /Closed file chooser f2 without a file\./);
    const sent = await act('click', {
      ref: ref(chosen.text, /\[(e\d+)\] button "Send"/),
      element: 'send',
    });
    assert.match(sent.text, /received \d+ bytes/);
    assert.equal(uploads.length, 1);
    assert.match(
      uploads[0]!,
      /name="attachment"; filename="run\.log"[\s\S]*log line/,
    );
    assert.match(uploads[0]!, /name="logs"; filename="run\.log"/);

    // ---- the browser's own certificate warning, which only the person lets the model pass
    const host = `127.0.0.1:${ports[0]}`;
    const warned = await act('navigate', { url: `https://${host}/` });
    assert.match(
      warned.text,
      /certificate is not trusted: the tab shows the browser's certificate warning instead \(net::ERR_CERT_AUTHORITY_INVALID\)/,
    );
    assert.match(
      warned.text,
      new RegExp(`tab t1 · "certificate warning" · https://${host}/`),
    );
    assert.match(warned.text, /This is the browser's certificate warning/);
    const advanced = await act('click', {
      ref: ref(warned.text, /\[(e\d+)\] button "(?:Advanced|高级)"/),
      element: 'advanced',
    });
    const proceed = ref(
      advanced.text,
      /\[(e\d+)\] link "(?:Proceed to|继续前往)/,
    );
    const asked = await act('click', { ref: proceed, element: 'proceed' });
    assert.equal(
      asked.text,
      'Proceeding past a certificate warning needs the user’s approval.',
    );
    assert.deepEqual(
      { ...asked.approval, token: typeof asked.approval?.token },
      {
        kind: 'certificate',
        token: 'string',
        url: `https://${host}/`,
        host,
        subject: 'Circle Fixture Device',
        issuer: 'Circle Fixture Device',
        fingerprint,
        validExpiry: (asked.approval as CertificateApproval).validExpiry,
        privateHost: true,
      },
    );
    assert(
      (asked.approval as CertificateApproval).validExpiry > Date.now() / 1000,
    );
    // A made-up token is not an approval
    const forged = await act('click', {
      ref: proceed,
      element: 'proceed',
      approval: { token: 'not-the-token', scope: 'once' },
    });
    assert(forged.approval);
    const passed = await act('click', {
      ref: proceed,
      element: 'proceed',
      approval: { token: asked.approval!.token, scope: 'once' },
    });
    assert.match(passed.text, /"Fixture device login"/);
    assert.match(
      passed.text,
      new RegExp(
        `### Events\\n- certificate warning for ${host.replace(/\./g, '\\.')}: Circle proceeded, approved by the user`,
      ),
    );
    assert.match(
      passed.text,
      /not secure: its certificate was accepted for this session/,
    );
    assert.equal(existsSync(trustFile), false, 'once is not kept');

    // ---- a warning reached by a link, trusted for good, and reused after a restart
    // Another host: the browser's own exception covers a host on every port, as Chrome's does
    const second = `localhost:${ports[1]}`;
    const links = await act('navigate', {
      url: `${http}/link?to=${encodeURIComponent(`https://${second}/`)}`,
    });
    const followed = await act('click', {
      ref: ref(links.text, /\[(e\d+)\] link "Device"/),
      element: 'device',
    });
    assert.match(
      followed.text,
      new RegExp(
        `The tab now shows the browser's certificate warning for ${second}`,
      ),
    );
    const open = await act('click', {
      ref: ref(followed.text, /\[(e\d+)\] button "(?:Advanced|高级)"/),
      element: 'advanced',
    });
    const link = ref(open.text, /\[(e\d+)\] link "(?:Proceed to|继续前往)/);
    const again = await act('click', { ref: link, element: 'proceed' });
    const always = await act('click', {
      ref: link,
      element: 'proceed',
      approval: { token: again.approval!.token, scope: 'always' },
    });
    assert.match(always.text, /"Fixture device login"/);
    assert.deepEqual(JSON.parse(readFileSync(trustFile, 'utf8')), {
      certificates: [{ host: second, fingerprint }],
    });
    await chrome.close();
    chrome = start();
    const trusted = await act('navigate', { url: `https://${second}/` });
    assert.match(trusted.text, /### Result\nLoaded\./);
    assert.match(trusted.text, /"Fixture device login"/);
    assert.match(
      trusted.text,
      /proceeded, as the user trusts this certificate on this host/,
    );
    // The first host was allowed once: after the restart it warns again
    const forgotten = await act('navigate', { url: `https://${host}/` });
    assert.match(forgotten.text, /certificate warning/);

    // ---- a browser the person closed opens again with the next action
    await chrome.close();
    chrome = start();
    const fresh = await act('navigate', { url: `${http}/form` });
    assert.match(fresh.text, /tab t1 · "Form"/);
  },
);

test(
  'in a conversation, a password typed as %NAME% reaches the site from a secret, and the person approves the certificate',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-runtime-');
    const key = join(temp, 'key.pem');
    const cert = join(temp, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=Circle Fixture Device',
      ],
      { stdio: 'ignore' },
    );
    const posts: string[] = [];
    const device = createHttps(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            posts.push(body);
            res.writeHead(200, { 'content-type': 'text/html' });
            res.end('<!doctype html><title>Home</title><p>signed in</p>');
          });
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<!doctype html><title>Login</title><form method="post"><input name="u" aria-label="User"><input name="p" type="password" aria-label="Password"><button>Log in</button></form>',
        );
      },
    );
    const url = `https://127.0.0.1:${await listen(device)}/`;
    t.after(() => device.close());
    const chrome = new ChromeBrowser({
      executable: executable!,
      trustFile: join(temp, 'certificates.json'),
      headless: true,
    });
    cleanup(t, () => chrome.close());
    saveSecret(temp, 'LAB_PASSWORD', 'never-shown-to-the-model');
    const asked: string[] = [];
    const settings = trustFolder(defaultSettings(), temp);
    settings.variables = { LAB_USER: 'operator' };
    // The model's refs on this fixed page: the warning's are read from its snapshot below
    let warning = '';
    const model = new ScriptedModel([
      {
        message: {
          id: '1',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'open', name: 'browser_navigate', args: { url } }],
        },
      },
      async (request) => {
        warning = String(
          request.messages.filter((m) => m.role === 'tool').at(-1)!.content,
        );
        const advanced = warning.match(
          /\[(e\d+)\] button "(?:Advanced|高级)"/,
        )?.[1];
        assert(advanced, warning);
        return {
          message: {
            id: '2',
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'advanced',
                name: 'browser_click',
                args: { ref: advanced, element: 'advanced' },
              },
            ],
          },
          usage: emptyUsage(),
        };
      },
      async (request) => {
        const shown = String(
          request.messages.filter((m) => m.role === 'tool').at(-1)!.content,
        );
        const proceed = shown.match(
          /\[(e\d+)\] link "(?:Proceed to|继续前往)/,
        )?.[1];
        assert(proceed, shown);
        return {
          message: {
            id: '3',
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'proceed',
                name: 'browser_click',
                args: { ref: proceed, element: 'proceed' },
              },
            ],
          },
          usage: emptyUsage(),
        };
      },
      {
        message: {
          id: '4',
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'user',
              name: 'browser_type',
              args: { ref: 'e1', element: 'user', text: '%LAB_USER%' },
            },
            {
              id: 'password',
              name: 'browser_type',
              args: {
                ref: 'e2',
                element: 'password',
                text: '%LAB_PASSWORD%',
                submit: true,
              },
            },
          ],
        },
      },
      { message: { id: '5', role: 'assistant', content: 'signed in' } },
    ]);
    const runtime = new AgentRuntime({
      workspace: temp,
      home: temp,
      settings,
      model,
      extraTools: browserTools(chrome, {
        confirm: async (_session, approval) => {
          const certificate = approval as CertificateApproval;
          asked.push(
            `${certificate.host} ${certificate.subject} ${certificate.privateHost}`,
          );
          return 'once';
        },
      }),
    });
    cleanup(t, () => runtime.close());
    runtime.policy.setYolo(runtime.session.id, true);
    await runtime.harness.run('sign in to the device');
    assert.equal(asked.length, 1);
    assert.match(asked[0]!, /^127\.0\.0\.1:\d+ Circle Fixture Device true$/);
    assert.match(warning, /This is the browser's certificate warning/);
    assert.deepEqual(posts, ['u=operator&p=never-shown-to-the-model']);
    const everything = JSON.stringify(model.requests);
    assert.equal(everything.includes('never-shown-to-the-model'), false);
    const results = model.requests
      .at(-1)!
      .messages.filter((m) => m.role === 'tool');
    assert.match(
      String(results.at(-1)!.content),
      /Typed secret LAB_PASSWORD into e2/,
    );
    assert.match(String(results.at(-1)!.content), /"Home"/);
  },
);

test(
  'the terminal browser hands the person the browser and tells the model only where the tabs went',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-handoff-');
    const site = createHttp((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><title>${req.url === '/b' ? 'Signed in' : 'Sign in'}</title><input aria-label="Code">`,
      );
    });
    const base = `http://127.0.0.1:${await listen(site)}`;
    t.after(() => site.close());
    const reasons: string[] = [];
    const chrome: ChromeBrowser = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: temp,
      // The person types a code and goes on, in the window: Circle sees none of it
      handoff: async (reason) => {
        reasons.push(reason);
        const internals = chrome as unknown as {
          conversations: Map<
            string,
            { tabs: Map<string, { session: string }> }
          >;
          send: (
            method: string,
            params: Record<string, unknown>,
            session?: string,
          ) => Promise<unknown>;
        };
        const tab = internals.conversations.get('c')!.tabs.get('t1')!;
        await internals.send(
          'Runtime.evaluate',
          {
            expression: `document.querySelector('input').value = 'typed-by-the-person'; location.href = '/b'`,
          },
          tab.session,
        );
        await new Promise((resolve) => setTimeout(resolve, 800));
      },
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    await chrome.request('c', 'navigate', { url: `${base}/a` }, signal);
    const back = await chrome.request(
      'c',
      'handoff',
      { reason: 'enter the code from your phone' },
      signal,
    );
    assert.deepEqual(reasons, ['enter the code from your phone']);
    assert.match(back.text, /### Result\nThe user handed the browser back\./);
    assert(
      back.text.includes(
        `- tab t1 went to ${base}/b while Circle was not acting\n- the user handed the browser back`,
      ),
      back.text,
    );
    assert.match(back.text, /tab t1 · "Signed in"/);
    assert.equal(back.text.includes('typed-by-the-person'), false);
    // Circle's own navigations are not told as the person's
    const own = await chrome.request(
      'c',
      'navigate',
      { url: `${base}/a` },
      signal,
    );
    assert.doesNotMatch(own.text, /while Circle was not acting/);
    // Every result names the site shown; an action allowed on another site does nothing
    assert.equal(own.origin, base);
    const elsewhere = await chrome.request(
      'c',
      'type',
      { ref: 'e1', element: 'code', text: 'x', site: 'https://elsewhere.test' },
      signal,
    );
    assert.match(
      elsewhere.text,
      new RegExp(
        `Nothing was done: the page is now on ${base.replace(/[.]/g, '\\.')}, not https://elsewhere\\.test`,
      ),
    );
    assert.match(elsewhere.text, /textbox "Code" value=""/);
    // Without anyone to hand it to, the model is told so
    const alone = new ChromeBrowser({
      executable: executable!,
      headless: true,
    });
    cleanup(t, () => alone.close());
    await assert.rejects(
      alone.request('c', 'handoff', { reason: 'x' }, signal),
      /no one to hand the browser to/,
    );
  },
);

test(
  "a download the model's action starts is discarded when the person does not keep it, and the next one from the site is asked about again",
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-download-');
    const site = createHttp((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="report.bin"',
      });
      res.end('data');
    });
    const url = `http://127.0.0.1:${await listen(site)}/download`;
    t.after(() => site.close());
    const downloads = join(temp, 'downloads');
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads,
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const asked = await chrome.request(
      'conversation',
      'navigate',
      { url },
      signal,
    );
    assert.equal(asked.approval?.kind, 'download');
    const discarded = await chrome.request(
      'conversation',
      'navigate',
      {
        url,
        approval: {
          token: (asked.approval as { token: string }).token,
          scope: 'reject',
        },
      },
      signal,
    );
    assert.equal(
      discarded.text,
      '### Download\nThe user did not keep the download; it was discarded.\n- download dl1 was not kept',
    );
    assert.equal(existsSync(join(downloads, 'report.bin')), false);
    // Not kept is not allowed: the next download from the site is asked about again
    const again = await chrome.request(
      'conversation',
      'navigate',
      { url },
      signal,
    );
    assert.equal(again.approval?.kind, 'download');
  },
);

test(
  "the terminal browser's downloads, dialogs and file choosers go by the site and the actor that made them",
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-provenance-');
    const file = (res: import('node:http').ServerResponse, name: string) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${name}"`,
      });
      res.end(name);
    };
    const page = (res: import('node:http').ServerResponse, body: string) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html>${body}`);
    };
    let otherBase = '';
    const site = createHttp((req, res) => {
      if (req.url === '/download') return file(res, 'mine.bin');
      if (req.url === '/late')
        return page(
          res,
          `<title>Late</title><button onclick="setTimeout(() => location = '/download', 1500)">Later</button>`,
        );
      if (req.url === '/blob')
        return page(
          res,
          `<title>Blob</title><button onclick="const a = document.createElement('a'); a.href = window.URL.createObjectURL(new Blob(['made here'])); a.download = 'made.txt'; document.body.append(a); a.click()">Make</button>`,
        );
      if (req.url === '/two')
        return page(
          res,
          `<title>Two</title><button onclick="location = '${otherBase}/download'; setTimeout(() => location = '/download', 400)">Both</button>`,
        );
      if (req.url === '/alert')
        return page(
          res,
          `<title>Files</title><button onclick="alert('saved')">Save</button><input type="file" aria-label="Attachment">`,
        );
      page(res, '<title>Home</title><p>home</p>');
    });
    const other = createHttp((req, res) => {
      if (req.url === '/download') return file(res, 'theirs.bin');
      page(
        res,
        `<title>Asks</title><script>setTimeout(() => confirm('Delete everything?'), 300)</script>`,
      );
    });
    const base = `http://127.0.0.1:${await listen(site)}`;
    otherBase = `http://127.0.0.1:${await listen(other)}`;
    t.after(() => {
      site.close();
      other.close();
    });
    const downloads = join(temp, 'downloads');
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads,
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const act = (action: BrowserAction, args: Record<string, unknown> = {}) =>
      chrome.request('c', action, args, signal).catch((error: Error) => {
        error.message = `${action} ${JSON.stringify(args)}: ${error.message}`;
        throw error;
      });
    const ref = (text: string, pattern: RegExp) => {
      const match = text.match(pattern);
      assert(match, `no ${pattern} in:\n${text}`);
      return match[1]!;
    };
    const token = (result: { approval?: unknown }) =>
      (result.approval as { token: string }).token;

    // ---- a blob is the download of the page that made it
    const blob = await act('navigate', { url: `${base}/blob` });
    const make = await act('click', {
      ref: ref(blob.text, /\[(e\d+)\] button "Make"/),
      element: 'make',
    });
    // The page makes the file after the click: asked with this result or the next
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const made2 = make.approval ? make : await act('snapshot');
    assert.equal(made2.approval?.kind, 'download');
    assert.equal((made2.approval as { site: string }).site, base);
    const kept = await act('click', {
      ref: 'e1',
      approval: { token: token(made2), scope: 'once' },
    });
    assert.match(kept.text, /The download was kept\./);
    assert.equal(
      readFileSync(join(downloads, 'made.txt'), 'utf8'),
      'made here',
    );

    // ---- a download a page starts a moment after the model's click is still the model's
    const late = await act('navigate', { url: `${base}/late` });
    const clicked = await act('click', {
      ref: ref(late.text, /\[(e\d+)\] button "Later"/),
      element: 'later',
    });
    assert.equal(clicked.approval, undefined);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const after = await act('snapshot');
    assert.equal(after.approval?.kind, 'download');
    assert.equal((after.approval as { site: string }).site, base);
    await act('snapshot', {
      approval: { token: token(after), scope: 'reject' },
    });
    assert.equal(existsSync(join(downloads, 'mine.bin')), false);

    // ---- files from two sites are asked about site by site
    const two = await act('navigate', { url: `${base}/two` });
    const both = await act('click', {
      ref: ref(two.text, /\[(e\d+)\] button "Both"/),
      element: 'both',
    });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const first = both.approval
      ? both
      : await act('snapshot').then((result) => result);
    assert.equal(first.approval?.kind, 'download');
    const firstSite = (first.approval as { site: string }).site;
    const second = await act('snapshot', {
      approval: { token: token(first), scope: 'once' },
    });
    assert.equal(second.approval?.kind, 'download');
    const secondSite = (second.approval as { site: string }).site;
    assert.deepEqual(
      new Set([firstSite, secondSite]),
      new Set([base, otherBase]),
    );
    await act('snapshot', {
      approval: { token: token(second), scope: 'reject' },
    });
    const keptName = firstSite === base ? 'mine.bin' : 'theirs.bin';
    const discardedName = firstSite === base ? 'theirs.bin' : 'mine.bin';
    assert.equal(existsSync(join(downloads, keptName)), true);
    assert.equal(existsSync(join(downloads, discardedName)), false);

    // ---- a dialog in another tab is answered only with that site's allowance
    const opened = await act('tabs', { action: 'new', url: otherBase });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const asking = await act('snapshot');
    const dialog = ref(asking.text, /\[(d\d+)\] confirm/);
    void opened;
    await act('tabs', { action: 'select', tab: 't1' });
    const refused = await act('dialog', {
      id: dialog,
      accept: true,
      site: base,
    });
    assert.match(
      refused.text,
      new RegExp(
        `Nothing was done: dialog ${dialog} is for ${otherBase.replace(/[.]/g, '\\.')}, not ${base.replace(/[.]/g, '\\.')}`,
      ),
    );
    assert.match(refused.text, /It is in tab t2/);
    await act('tabs', { action: 'select', tab: 't2' });
    const answered = await act('dialog', {
      id: dialog,
      accept: false,
      site: otherBase,
    });
    assert.match(answered.text, new RegExp(`Dismissed dialog ${dialog}\\.`));
    await act('tabs', { action: 'close', tab: 't2' });

    // ---- a dialog that ends Circle's click ends its hold on the page's file choosers too
    const files = await act('navigate', { url: `${base}/alert` });
    const saved = await act('click', {
      ref: ref(files.text, /\[(e\d+)\] button "Save"/),
      element: 'save',
    });
    assert.match(saved.text, /\[(d\d+)\] alert/);
    const internals = chrome as unknown as {
      conversations: Map<
        string,
        { tabs: Map<string, { session: string; chooser?: unknown }> }
      >;
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ) => Promise<unknown>;
    };
    const tab = internals.conversations.get('c')!.tabs.get('t1')!;
    // The person closes the alert and opens the file picker themselves
    await internals.send(
      'Page.handleJavaScriptDialog',
      { accept: true },
      tab.session,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    await internals.send(
      'Runtime.evaluate',
      {
        expression: `document.querySelector('input[type=file]').click()`,
        userGesture: true,
      },
      tab.session,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(tab.chooser, undefined);
  },
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process';
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
import { browserTools, runtimeBrowserOptions } from '../src/browser/tools.js';
import { formatScript, parseScript } from '../src/browser/script.js';
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

test(
  'a browser that does not answer in time is stopped, and the action says it did not start',
  {
    skip:
      process.platform === 'win32'
        ? 'the program that never answers is a shell script'
        : false,
  },
  async (t) => {
    const root = made(t);
    // Takes the browser's arguments and never answers on the pipe
    const silent = join(root, 'silent-browser');
    writeFileSync(silent, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const chrome = new ChromeBrowser({
      executable: silent,
      headless: true,
      downloads: join(root, 'downloads'),
      startTimeout: 300,
    });
    cleanup(t, () => chrome.close());
    const started = Date.now();
    await assert.rejects(
      chrome.request('c', 'snapshot', {}, new AbortController().signal),
      /^Error: the browser did not start in 0\.3 s$/,
    );
    assert.ok(Date.now() - started < 10_000);
    const child = (chrome as unknown as { child: ChildProcess }).child;
    assert.equal(child.killed, true);
  },
);

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
    // A failure names the step it happened at, and what the browser was in: a failure
    // seen only in a CI log has to say enough
    const internals = chrome as unknown as {
      cdp: {
        send: (
          method: string,
          params?: Record<string, unknown>,
          session?: string,
        ) => Promise<any>;
      };
      conversations: Map<
        string,
        {
          active?: string;
          tabs: Map<
            string,
            { session: string; interceptFailure?: string; dialogs: unknown[] }
          >;
        }
      >;
      stderr: string[];
    };
    const diagnose = async () => {
      const within = (promise: Promise<unknown>) =>
        Promise.race([
          promise.then(
            (value) => JSON.stringify(value) ?? 'ok',
            (error: Error) => `error: ${error.message}`,
          ),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('no answer in 2 s'), 2000),
          ),
        ]);
      const lines: string[] = [];
      const conversation = internals.conversations.get('conversation-1');
      const shown = conversation?.active
        ? conversation.tabs.get(conversation.active)
        : undefined;
      lines.push(
        `tabs ${[...(conversation?.tabs.keys() ?? [])].join(',')}; shown ${conversation?.active}`,
      );
      if (shown) {
        const see = (expression: string) =>
          within(
            internals.cdp
              .send(
                'Runtime.evaluate',
                { expression, returnByValue: true },
                shown.session,
              )
              .then((reply) => reply.result?.value),
          );
        lines.push(
          `interception ${shown.interceptFailure ?? 'taken'}; dialogs ${shown.dialogs.length}`,
        );
        lines.push(
          `visibility ${await see('document.visibilityState + " focus " + document.hasFocus()')}`,
        );
        lines.push(
          `bringToFront ${await within(internals.cdp.send('Page.bringToFront', {}, shown.session))}`,
        );
        lines.push(`visibility then ${await see('document.visibilityState')}`);
        lines.push(
          `mouse ${await within(internals.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 }, shown.session))}`,
        );
      }
      lines.push(
        `targets ${await within(
          internals.cdp
            .send('Target.getTargets')
            .then((reply) =>
              reply.targetInfos?.map(
                (info: { type: string; url: string; attached: boolean }) =>
                  `${info.type} ${info.url} ${info.attached ? 'attached' : ''}`,
              ),
            ),
        )}`,
      );
      lines.push(`browser said ${internals.stderr.slice(-8).join(' | ')}`);
      return lines.join('\n');
    };
    const act = (action: BrowserAction, args: Record<string, unknown> = {}) =>
      chrome
        .request('conversation-1', action, args, signal)
        .catch(async (error: Error) => {
          error.message = `${action} ${JSON.stringify(args)}: ${error.message}\n${await diagnose()}`;
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
    // The field as the page names it, never the value
    assert.match(
      typed.text,
      new RegExp(
        `### Result\nTyped secret LAB_PASSWORD into ${password} password "Password"\\.`,
      ),
    );
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
        // The person is shown the input as the page names it
        element: 'Attachment',
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
    assert.match(
      given.text,
      /Gave "run\.log" \(8 B\) to e\d+ file "Attachment"\./,
    );
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
      const shown = (
        chrome as unknown as {
          conversations: Map<
            string,
            { tabs: Map<string, { interceptFailure?: string }> }
          >;
        }
      ).conversations
        .get('conversation-1')
        ?.tabs.get('t1');
      error.message += ` (${product}; chooser events: ${choosers.length}; interception ${shown?.interceptFailure ?? 'taken'})`;
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
    await assert.rejects(
      act('click_at', { x: 10, y: 10, screenshotId: 'forged-warning-capture' }),
      /coordinate clicks are not allowed on certificate warnings/,
    );
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
    // A download starts a moment after what started it, later on a busy machine: look again
    // until the browser holds one
    const held = async (result: Awaited<ReturnType<typeof act>>) => {
      const end = Date.now() + 10_000;
      while (!result.approval && Date.now() < end) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        result = await act('snapshot');
      }
      return result;
    };

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
    // The second starts 400 ms after the first
    const first = await held(both);
    assert.equal(first.approval?.kind, 'download');
    const firstSite = (first.approval as { site: string }).site;
    const second = await held(
      await act('snapshot', {
        approval: { token: token(first), scope: 'once' },
      }),
    );
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

test(
  'an action names the element its ref acted on, as the snapshot does, and says when the model described another',
  { skip: executable ? false : 'no Chrome, Edge or Chromium is installed' },
  async (t) => {
    const temp = made(t, 'circle-chrome-names-');
    // Which pages the clicks reached: the real effect of each
    const visited: string[] = [];
    const site = createHttp((req, res) => {
      const path = new URL(req.url ?? '/', 'http://local').pathname;
      if (path !== '/favicon.ico') visited.push(path);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (path === '/host')
        return res.end('<!doctype html><title>Host</title><p>host page</p>');
      if (path === '/network')
        return res.end(
          '<!doctype html><title>Network</title><p>network page</p>',
        );
      res.end(
        `<!doctype html><title>Menu</title><nav><a href="/host">主机设置</a> <a href="/network">网络</a></nav><label>Name <input id="name"></label><select id="mode" aria-label="Mode"><option>auto</option><option>manual</option></select><input type="file" aria-label="Firmware"><button id="bare" style="width:40px;height:24px" onclick="this.dataset.clicked = 'yes'"></button>`,
      );
    });
    const menu = `http://127.0.0.1:${await listen(site)}/menu`;
    t.after(() => site.close());
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const act = (action: BrowserAction, args: Record<string, unknown> = {}) =>
      chrome.request('c', action, args, signal);
    const ref = (text: string, pattern: RegExp) => {
      const match = text.match(pattern);
      assert(match, `no ${pattern} in:\n${text}`);
      return match[1]!;
    };
    // The line that says what the action did
    const result = (text: string) => ref(text, /### Result\n(.*)/);
    const internals = chrome as unknown as {
      conversations: Map<string, { tabs: Map<string, unknown> }>;
      evaluate: (tab: unknown, expression: string) => Promise<unknown>;
    };
    // What the pointer's label shows the person, and what the page holds, read in the
    // browser's own world
    const page = (expression: string) =>
      internals.evaluate(
        internals.conversations.get('c')!.tabs.get('t1')!,
        expression,
      );
    const shown = await act('navigate', { url: menu });
    const host = ref(shown.text, /\[(e\d+)\] link "主机设置"/);
    const name = ref(shown.text, /\[(e\d+)\] textbox "Name"/);
    const mode = ref(shown.text, /\[(e\d+)\] combobox "Mode"/);
    const firmware = ref(shown.text, /\[(e\d+)\] file "Firmware"/);
    const bare = ref(shown.text, /\[(e\d+)\] button ""/);

    // A description that fits says nothing more
    const typed = await act('type', {
      ref: name,
      element: 'name field',
      text: 'router',
    });
    assert.equal(result(typed.text), `Typed text into ${name} textbox "Name".`);
    assert.equal(await page(`document.querySelector('#name').value`), 'router');
    // One that names something else is said, and the person's pointer shows the page's name
    const chosen = await act('select', {
      ref: mode,
      element: 'speed',
      values: ['manual'],
    });
    assert.equal(
      result(chosen.text),
      `Chose "manual" in ${mode} combobox "Mode" — you described it as "speed"; check the snapshot.`,
    );
    assert.equal(await page(`document.querySelector('#mode').value`), 'manual');
    assert.equal(
      await page('window.circleBrowser.bubble.textContent'),
      'select Mode',
    );
    // An element without a name: its role, and no claim about the description
    const clicked = await act('click', { ref: bare, element: 'close icon' });
    assert.equal(result(clicked.text), `Clicked ${bare} button.`);
    assert.equal(
      await page(`document.querySelector('#bare').dataset.clicked`),
      'yes',
    );
    assert.equal(
      await page('window.circleBrowser.bubble.textContent'),
      'click close icon',
    );
    // A file input: the person is asked about the input the page names
    const firmwareFile = join(temp, 'fw.bin');
    writeFileSync(firmwareFile, 'firmware');
    const ask = await act('upload', {
      ref: firmware,
      element: 'certificate file',
      paths: [firmwareFile],
    });
    assert.equal(ask.approval?.kind, 'upload');
    assert.equal((ask.approval as { element: string }).element, 'Firmware');
    const given = await act('upload', {
      ref: firmware,
      element: 'certificate file',
      paths: [firmwareFile],
      approval: { token: ask.approval!.token },
    });
    assert.equal(
      result(given.text),
      `Gave "fw.bin" (8 B) to ${firmware} file "Firmware" — you described it as "certificate file"; check the snapshot.`,
    );
    assert.match(given.text, /file "Firmware" chosen "fw\.bin"/);

    // The live run's mistake: the model clicks the ref of 主机设置 believing it is the
    // network menu. The click reaches the host page, and the result says so.
    const wrong = await act('click', { ref: host, element: '网络菜单' });
    assert.equal(
      result(wrong.text),
      `Clicked ${host} link "主机设置" — you described it as "网络菜单"; check the snapshot.`,
    );
    assert.match(wrong.text, /host page/);
    assert.equal(visited.at(-1), '/host');
    const back = await act('navigate', { url: menu });
    const network = ref(back.text, /\[(e\d+)\] link "网络"/);
    const right = await act('click', { ref: network, element: '网络菜单' });
    assert.equal(result(right.text), `Clicked ${network} link "网络".`);
    assert.match(right.text, /network page/);
    assert.equal(visited.at(-1), '/network');
  },
);

test(
  'a saved secret goes into no page on a public address whose certificate was not trusted, but does on this network',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-secret-');
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
        '/CN=Circle secret fixture',
      ],
      { stdio: 'ignore' },
    );
    const posts: string[] = [];
    const server = createHttps(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (req, res) => {
        if (req.method === 'POST') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            posts.push(body);
            res.end('<!doctype html><title>Sent</title>');
          });
          return;
        }
        if (req.url === '/auth') {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="Lab"' });
          return res.end();
        }
        // A site that sends its root on to another page, as a device sends / to /login
        if (req.url === '/start') {
          res.writeHead(302, { location: '/' });
          return res.end();
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><title>Login</title><form method="post"><label>User <input name="user"></label><label>Password <input name="pass" type="password"></label><button>Sign in</button></form>',
        );
      },
    );
    const port = await listen(server as unknown as Server);
    cleanup(
      t,
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
      // A public name for the local site (not one Chrome keeps to HTTPS for good, as .test)
      hostRules: 'MAP device.example.net 127.0.0.1',
    });
    cleanup(t, () => chrome.close());
    const act = (
      conversation: string,
      action: BrowserAction,
      args: Record<string, unknown> = {},
    ) =>
      chrome.request(conversation, action, args, new AbortController().signal);
    const pick = (text: string, pattern: RegExp) => {
      const found = text.match(pattern);
      assert(found, `${pattern} is not in:\n${text}`);
      return found[1]!;
    };
    // Past the warning, as the person allowed
    const open = async (
      conversation: string,
      url: string,
      scope: 'once' | 'auto' = 'once',
    ) => {
      const warned = await act(conversation, 'navigate', { url });
      const advanced = await act(conversation, 'click', {
        ref: pick(warned.text, /\[(e\d+)\] button "(?:Advanced|高级)"/),
        element: 'advanced',
      });
      const proceed = pick(
        advanced.text,
        /\[(e\d+)\] link "(?:Proceed to|继续前往)/,
      );
      const asked = await act(conversation, 'click', {
        ref: proceed,
        element: 'proceed',
      });
      const page = await act(conversation, 'click', {
        ref: proceed,
        element: 'proceed',
        approval: { token: asked.approval!.token, scope },
      });
      assert.match(
        page.text,
        /not secure: its certificate was accepted for this session/,
      );
      return page.text;
    };
    const secret = {
      text: 'lab-pass',
      secret: true,
      secretName: 'LAB_PASSWORD',
    };

    const publicPage = await open(
      'public',
      `https://device.example.net:${port}/`,
    );
    const user = pick(publicPage, /\[(e\d+)\] textbox "User"/);
    const password = pick(publicPage, /\[(e\d+)\] password "Password"/);
    // Plain text still goes in; the secret does not, and nothing reaches the field
    await act('public', 'type', { ref: user, text: 'admin', element: 'User' });
    await assert.rejects(
      act('public', 'type', { ref: password, element: 'Password', ...secret }),
      /a saved secret goes into no page on device\.example\.net:\d+: its certificate is not trusted and it is a public address/,
    );
    const after = await act('public', 'snapshot');
    assert.match(after.text, /password "Password" empty/);
    // Nor an HTTP sign-in there
    const signIn = await act('public', 'navigate', {
      url: `https://device.example.net:${port}/auth`,
    });
    assert.match(signIn.text, /sign-in/);
    await assert.rejects(
      act('public', 'dialog', {
        accept: true,
        text: 'admin',
        password: 'lab-pass',
      }),
      /a saved secret goes into no page on device\.example\.net/,
    );

    // On this network the same certificate is passed, here by auto mode, and the secret typed
    const localPage = await open(
      'local',
      `https://127.0.0.1:${port}/start`,
      'auto',
    );
    assert.match(
      localPage,
      /- certificate warning for 127\.0\.0\.1:\d+: Circle proceeded in auto mode, without asking \(sha256 [0-9A-F:]+\)/,
    );
    const localPassword = pick(localPage, /\[(e\d+)\] password "Password"/);
    const typed = await act('local', 'type', {
      ref: localPassword,
      element: 'Password',
      ...secret,
    });
    assert.match(
      typed.text,
      /Typed secret LAB_PASSWORD into e\d+ password "Password"/,
    );
    assert.match(typed.text, /password "Password" filled/);
    assert.deepEqual(posts, []);
  },
);

test(
  'in auto mode the terminal browser takes itself back once the page moved on, and plan mode hands nothing over',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-auto-handoff-');
    const site = createHttp((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<!doctype html><title>${req.url === '/b' ? 'Signed in' : 'Sign in'}</title><input aria-label="Code">`,
      );
    });
    const base = `http://127.0.0.1:${await listen(site)}`;
    t.after(() => site.close());
    let mode = 'auto';
    let closed = false;
    const chrome: ChromeBrowser = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: temp,
      mode: () => mode,
      // The person goes on in the window and never answers the card: it stays until closed
      handoff: (_reason, signal) =>
        new Promise<void>((_resolve, reject) => {
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
          void internals.send(
            'Runtime.evaluate',
            { expression: `location.href = '/b'` },
            tab.session,
          );
          signal.addEventListener('abort', () => {
            closed = true;
            reject(signal.reason);
          });
        }),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    await chrome.request('c', 'navigate', { url: `${base}/a` }, signal);
    const started = Date.now();
    const back = await chrome.request(
      'c',
      'handoff',
      { reason: 'sign in' },
      signal,
    );
    assert.equal(closed, true);
    assert(Date.now() - started >= 2000, 'it waits for the page to settle');
    assert.match(
      back.text,
      /### Result\nCircle took the browser back in auto mode, as the page moved on\./,
    );
    assert.match(
      back.text,
      /- auto mode: Circle took the browser back, as the page moved on/,
    );
    assert.match(back.text, /tab t1 · "Signed in"/);
    // Plan mode does not hand the browser over
    mode = 'plan';
    await assert.rejects(
      chrome.request('c', 'handoff', { reason: 'sign in' }, signal),
      /plan mode does not hand the browser over/,
    );
  },
);

test(
  "a conversation's browser actions are recorded as a script, and a fresh conversation in a new browser replays it with the same effects on the site",
  { skip },
  async (t) => {
    const temp = made(t, 'circle-chrome-replay-');
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
    // A device's admin page behind a self-signed certificate: a form, then a list in
    // which two rows have the same button
    const posts: Record<string, string>[] = [];
    const deletes: string[] = [];
    const device = createHttps(
      { key: readFileSync(key), cert: readFileSync(cert) },
      (req, res) => {
        const url = new URL(req.url ?? '/', 'https://local');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (req.method === 'POST' && url.pathname === '/submit') {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            const fields = Object.fromEntries(new URLSearchParams(body));
            posts.push(fields);
            res.end(
              `<!doctype html><title>Services</title><p>Welcome ${fields.username}</p><table><tr><td>vs-a</td><td><button onclick="fetch('/delete?id=a').then(() => out.textContent = 'deleted a')">Delete</button></td></tr><tr><td>vs-b</td><td><button onclick="fetch('/delete?id=b').then(() => out.textContent = 'deleted b')">Delete</button></td></tr></table><p id="out"></p>`,
            );
          });
          return;
        }
        if (url.pathname === '/delete') {
          deletes.push(url.searchParams.get('id') ?? '');
          return res.end('ok');
        }
        res.end(
          `<!doctype html><title>Login</title><form method="post" action="/submit"><label>User <input name="username"></label><label>Role <select name="role"><option value="viewer">Viewer</option><option value="maintainer">Maintainer</option></select></label><button>Sign in</button></form>`,
        );
      },
    );
    const url = `https://127.0.0.1:${await listen(device)}/form`;
    t.after(() => device.close());
    const settings = trustFolder(defaultSettings(), temp);
    settings.variables = { LAB_USER: 'operator' };
    const browser = () => {
      // A browser of its own: the certificate allowed once in one is not in the other
      const chrome = new ChromeBrowser({
        executable: executable!,
        trustFile: join(temp, 'certificates.json'),
        headless: true,
        downloads: join(temp, 'downloads'),
      });
      cleanup(t, () => chrome.close());
      return chrome;
    };
    const asked: string[] = [];
    // The calls that asked every time: a click that deletes, and a replay that has one
    const forced: string[] = [];
    const conversation = (model: ScriptedModel) => {
      const chrome = browser();
      const runtime: AgentRuntime = new AgentRuntime({
        workspace: temp,
        home: temp,
        settings,
        model,
        extraTools: browserTools(chrome, {
          ...runtimeBrowserOptions(() => runtime),
          confirm: async (_session, approval) => {
            asked.push(approval.kind);
            return 'once';
          },
        }),
        // The person allows the site for the session, and a delete once: its card offers
        // no "for this session"
        approve: async (call) => {
          if (
            runtime.policy.review(call.name, call.args).verdict !== 'ASK_FORCED'
          )
            return 'always';
          forced.push(call.name);
          return 'approve';
        },
      });
      cleanup(t, () => runtime.close());
      return runtime;
    };
    const last = (request: {
      messages: { role: string; content: unknown }[];
    }) =>
      String(
        request.messages.filter((m) => m.role === 'tool').at(-1)?.content ?? '',
      );
    const ref = (text: string, pattern: RegExp, index = 0) => {
      const found = [...text.matchAll(new RegExp(pattern, 'g'))];
      assert(found[index], `no ${pattern} (${index + 1}) in:\n${text}`);
      return found[index]![1]!;
    };
    // A call the model makes from the page its last result showed
    const step =
      (
        id: string,
        name: string,
        args: (shown: string) => Record<string, unknown>,
      ) =>
      async (request: { messages: { role: string; content: unknown }[] }) => ({
        message: {
          id,
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id, name, args: args(last(request)) }],
        },
        usage: emptyUsage(),
      });
    const recording = new ScriptedModel([
      step('open', 'browser_navigate', () => ({ url })),
      // The warning's controls are marked in any language
      step('advanced', 'browser_click', (shown) => ({
        ref: ref(shown, /\[(e\d+)\] button "[^"]*" \[warning: advanced\]/),
        element: 'advanced',
      })),
      step('proceed', 'browser_click', (shown) => ({
        ref: ref(
          shown,
          /\[(e\d+)\] link "[^"]*"(?: \[new\])? \[warning: proceed\]/,
        ),
        element: 'proceed',
      })),
      step('user', 'browser_type', (shown) => ({
        ref: ref(shown, /\[(e\d+)\] textbox "User"/),
        element: 'user',
        text: '%LAB_USER%',
      })),
      step('role', 'browser_select', (shown) => ({
        ref: ref(shown, /\[(e\d+)\] combobox "Role/),
        element: 'role',
        values: ['Maintainer'],
      })),
      step('look', 'browser_snapshot', () => ({})),
      step('sign-in', 'browser_click', (shown) => ({
        ref: ref(shown, /\[(e\d+)\] button "Sign in"/),
        element: 'sign in',
      })),
      // The second of two buttons named alike
      step('delete', 'browser_click', (shown) => ({
        ref: ref(shown, /\[(e\d+)\] button "Delete"/, 1),
        element: 'delete vs-b',
      })),
      step('record', 'browser_record', () => ({
        path: 'device.circle-browser.json',
      })),
      { message: { id: 'done', role: 'assistant', content: 'recorded' } },
    ]);
    const first = conversation(recording);
    await first.harness.run('sign in, delete vs-b, and record it');
    const record = last(recording.requests.at(-1)!);
    assert.match(record, /^Recorded 6 steps in /, record);
    assert.deepEqual(posts, [{ username: 'operator', role: 'maintainer' }]);
    assert.deepEqual(deletes, ['b']);
    assert.deepEqual(asked, ['certificate']);
    const file = join(temp, 'device.circle-browser.json');
    const script = parseScript(readFileSync(file, 'utf8'));
    const role = script.steps[3] as { select: { role: string; name: string } };
    assert.equal(role.select.role, 'combobox');
    assert.match(role.select.name, /^Role/);
    assert.deepEqual(script.steps, [
      { navigate: url },
      { proceed: 'certificate' },
      { type: { role: 'textbox', name: 'User' }, text: '%LAB_USER%' },
      { select: role.select, values: ['Maintainer'] },
      { click: { role: 'button', name: 'Sign in' } },
      { click: { role: 'button', name: 'Delete', nth: 2 } },
    ]);
    // The model's clean-up: a check that the row went
    writeFileSync(
      file,
      formatScript({
        ...script,
        steps: [...script.steps, { expect: 'deleted b' }],
      }),
    );

    // ---- another conversation, in a browser that has not seen the certificate
    asked.length = 0;
    const replaying = new ScriptedModel([
      step('replay', 'browser_replay', () => ({
        path: 'device.circle-browser.json',
      })),
      { message: { id: 'done', role: 'assistant', content: 'replayed' } },
    ]);
    const second = conversation(replaying);
    await second.harness.run('do it again');
    const replayed = last(replaying.requests.at(-1)!);
    assert.match(
      replayed,
      /^Replayed "device": steps 1–7 of 7 done\./,
      replayed,
    );
    assert.match(replayed, /\n2\. Clicked e\d+ link "[^"]+"\.\n/);
    assert.match(replayed, /\n7\. The page shows "deleted b"\.\n/);
    assert.match(
      replayed,
      /certificate warning for 127\.0\.0\.1:\d+: Circle proceeded, approved by the user/,
    );
    assert.deepEqual(asked, ['certificate']);
    // The site saw the same requests again
    assert.deepEqual(posts, [
      { username: 'operator', role: 'maintainer' },
      { username: 'operator', role: 'maintainer' },
    ]);
    assert.deepEqual(deletes, ['b', 'b']);
    // The delete asked when the model clicked it, and the replay that clicks it again asked too
    assert.deepEqual(forced, ['browser_click', 'browser_replay']);
  },
);

test(
  'a download navigation waits for a delayed download-start event instead of claiming Loaded',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-download-start-');
    const site = createHttp((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="late.bin"',
      });
      res.end('late bytes');
    });
    const url = `http://127.0.0.1:${await listen(site)}/download`;
    t.after(() => site.close());
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const internals = chrome as unknown as {
      event: (pipe: unknown, event: { method: string }) => void;
    };
    const navigationResponses: unknown[] = [];
    const send = (chrome as any).send.bind(chrome);
    (chrome as any).send = async (method: string, ...args: unknown[]) => {
      const reply = await send(method, ...args);
      if (method === 'Page.navigate') navigationResponses.push(reply);
      return reply;
    };
    const event = internals.event.bind(chrome);
    const timers: ReturnType<typeof setTimeout>[] = [];
    t.after(() => timers.forEach(clearTimeout));
    internals.event = (pipe, value) => {
      if (value.method.startsWith('Browser.download'))
        timers.push(setTimeout(() => event(pipe, value), 1600));
      else event(pipe, value);
    };
    const asked = await chrome.request(
      'c',
      'navigate',
      { url },
      new AbortController().signal,
    );
    assert.equal(asked.approval?.kind, 'download');
    assert.match(asked.text, /started download/);
    assert.doesNotMatch(asked.text, /Loaded\./);
    assert.equal(existsSync(join(temp, 'downloads', 'late.bin')), false);
    t.diagnostic(
      JSON.stringify({
        platform: process.platform,
        navigationResponses,
        downloadStartDeliveryDelayMs: 1600,
      }),
    );
  },
);

test(
  'coordinate clicks reach non-semantic controls, confirm their actual target once, and reject stale screenshots',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-coordinate-click-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>coordinates</title><style>body{height:2400px}span{display:inline-block;width:80px;height:30px}</style><table><tr><td>members</td><td><span id="missing">...</span></td></tr></table><button id="delete">Delete configuration</button><button id="open">open popup</button><script>document.querySelector("#missing").addEventListener("click",()=>fetch("/hit-unknown"));document.querySelector("#delete").addEventListener("click",()=>fetch("/hit-delete"));document.querySelector("#open").addEventListener("click",()=>window.open("/popup"));</script>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    t.after(() => site.close());
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
      mode: () => 'manual',
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const act = (action: BrowserAction, args: Record<string, unknown> = {}) =>
      chrome.request('c', action, args, signal);
    const page = async <T>(expression: string): Promise<T> => {
      const internal = chrome as any;
      return internal.evaluate(
        internal.conversations
          .get('c')
          .tabs.get(internal.conversations.get('c').active),
        expression,
        signal,
      );
    };
    const shown = await act('navigate', { url });
    assert.match(shown.text, /\| members \| \.\.\. \|/);
    assert.doesNotMatch(shown.text, /\[e\d+\].*"\.\.\."/);
    const point = await page<{ x: number; y: number }>(
      '(()=>{const r=document.querySelector("#missing").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    );
    const shot = await act('screenshot');
    assert.ok(shot.screenshot?.id);
    assert.match(shot.text, /CSS pixels/);
    await assert.rejects(
      act('click_at', { x: -1, y: point.y, screenshotId: shot.screenshot!.id }),
      /inside the screenshot viewport/,
    );
    const args = { ...point, screenshotId: shot.screenshot!.id };
    const asked = await act('click_at', args);
    assert.equal(asked.approval?.kind, 'coordinate');
    assert.deepEqual(hits, []);
    assert.equal((asked.approval as any).element, '...');
    const clicked = await act('click_at', {
      ...args,
      approval: { token: asked.approval!.token, scope: 'once' },
    });
    assert.match(clicked.text, /Clicked at.*span "\.\.\."/);
    assert.deepEqual(hits, ['/hit-unknown']);
    await assert.rejects(act('click_at', args), /screenshot is stale/);
    const deletion = await page<{ x: number; y: number }>(
      '(()=>{const r=document.querySelector("#delete").getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}})()',
    );
    const deleteShot = await act('screenshot');
    const deleteAsk = await act('click_at', {
      ...deletion,
      screenshotId: deleteShot.screenshot!.id,
    });
    assert.equal(deleteAsk.approval?.kind, 'coordinate');
    assert.equal((deleteAsk.approval as any).destructive, true);
    assert.deepEqual(hits, ['/hit-unknown']);
    const scrolled = await act('screenshot');
    await page('window.scrollTo(0,100)');
    await assert.rejects(
      act('click_at', { ...point, screenshotId: scrolled.screenshot!.id }),
      /screenshot is stale/,
    );
    await page('window.scrollTo(0,0)');
    const changed = await act('screenshot');
    await page('document.querySelector("#missing").textContent="changed"');
    await assert.rejects(
      act('click_at', { ...point, screenshotId: changed.screenshot!.id }),
      /screenshot is stale/,
    );
    const switched = await act('screenshot');
    await act('tabs', { action: 'new' });
    await act('tabs', { action: 'select', tab: 't1' });
    await assert.rejects(
      act('click_at', { ...point, screenshotId: switched.screenshot!.id }),
      /screenshot is stale/,
    );
    const resized = await act('screenshot');
    const internal = chrome as any;
    const activeTab = internal.conversations.get('c').tabs.get('t1');
    await internal.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 800, height: 600, deviceScaleFactor: 1, mobile: false },
      activeTab.session,
    );
    await assert.rejects(
      act('click_at', { ...point, screenshotId: resized.screenshot!.id }),
      /screenshot is stale/,
    );
    const resizedShot = await act('screenshot');
    assert.equal(resizedShot.screenshot!.width, 800);
    assert.equal(resizedShot.screenshot!.height, 600);
    await internal.send(
      'Emulation.clearDeviceMetricsOverride',
      {},
      activeTab.session,
    );
    const navigated = await act('screenshot');
    await act('navigate', { url: url + 'new' });
    await assert.rejects(
      act('click_at', { ...point, screenshotId: navigated.screenshot!.id }),
      /screenshot is stale/,
    );
  },
);

test(
  'coordinate clicks recheck a hover-changed destructive target before mouse press',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-coordinate-hover-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>hover fixture</title><button style="margin:100px;width:220px;height:60px">Show details</button><script>const b=document.querySelector("button");b.addEventListener("mouseenter",()=>{b.textContent="Delete configuration";b.dataset.delete="yes"});b.addEventListener("click",()=>fetch("/hit-"+b.dataset.delete));</script>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    t.after(() => site.close());
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
      mode: () => 'manual',
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    const act = (action: BrowserAction, args: Record<string, unknown> = {}) =>
      chrome.request('c', action, args, signal);
    await act('navigate', { url });
    const shot = await act('screenshot');
    const point = { x: 218, y: 138 };
    await assert.rejects(
      act('click_at', { ...point, screenshotId: shot.screenshot!.id }),
      /screenshot.*(?:stale|changed)/,
    );
    assert.deepEqual(
      hits,
      [],
      'hover must not be followed by a mouse press on the changed target',
    );
    const next = await act('screenshot');
    const args = { ...point, screenshotId: next.screenshot!.id };
    const asked = await act('click_at', args);
    assert.equal(asked.approval?.kind, 'coordinate');
    assert.equal((asked.approval as any).destructive, true);
    assert.equal((asked.approval as any).element, 'Delete configuration');
    assert.deepEqual(hits, []);
    await act('click_at', {
      ...args,
      approval: { token: asked.approval!.token, scope: 'once' },
    });
    assert.deepEqual(hits, ['/hit-yes']);
  },
);

test(
  'scrolling a nested document container invalidates coordinate captures',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-coordinate-nested-scroll-');
    const hits: string[] = [];
    const site = createHttp((req, res) => {
      if (req.url?.startsWith('/hit')) {
        hits.push(req.url);
        res.end('yes');
        return;
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        '<!doctype html><title>nested scroll</title><style>#s{width:300px;height:100px;overflow:auto;margin:180px}button{display:block;height:100px;width:280px}</style><div id=s><button id=a>Open first</button><button id=b>Open second</button><button id=c>Other</button></div><script>for(const b of document.querySelectorAll("button"))b.onclick=()=>fetch("/hit-"+b.id);</script>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    t.after(() => site.close());
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
      mode: () => 'manual',
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    await chrome.request('c', 'navigate', { url }, signal);
    const shot = await chrome.request('c', 'screenshot', {}, signal);
    const internal = chrome as any;
    const tab = internal.conversations.get('c').tabs.get('t1');
    await internal.evaluate(
      tab,
      'document.querySelector("#s").scrollTop=100',
      signal,
    );
    await assert.rejects(
      chrome.request(
        'c',
        'click_at',
        { x: 328, y: 230, screenshotId: shot.screenshot!.id },
        signal,
      ),
      /screenshot is stale/,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assert.rejects(
      chrome.request(
        'c',
        'click_at',
        { x: 328, y: 230, screenshotId: shot.screenshot!.id },
        signal,
      ),
      /screenshot is stale/,
    );
    assert.deepEqual(hits, []);
    const next = await chrome.request('c', 'screenshot', {}, signal);
    await chrome.request(
      'c',
      'click_at',
      { x: 328, y: 230, screenshotId: next.screenshot!.id },
      signal,
    );
    assert.deepEqual(hits, ['/hit-b']);
  },
);

test(
  'a page can close its own popup and the terminal browser reports the closed tab and continues',
  { skip },
  async (t) => {
    const temp = made(t, 'circle-popup-close-');
    const cookies: string[] = [];
    const site = createHttp((req, res) => {
      cookies.push(req.headers.cookie ?? '');
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Set-Cookie', 'fixture=kept; SameSite=Lax');
      res.end(
        req.url === '/popup'
          ? '<title>popup</title><button onclick="window.close()">close this page</button>'
          : '<title>opener</title><button onclick="window.open(\'/popup\')">open popup</button>',
      );
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    t.after(() => site.close());
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(temp, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    await chrome.request('c', 'navigate', { url }, signal);
    const opened = await chrome.request(
      'c',
      'click',
      { ref: 'e1', element: 'open popup' },
      signal,
    );
    assert.match(opened.text, /t2 \(shown\)/);
    const closed = await chrome.request(
      'c',
      'click',
      { ref: 'e1', element: 'close this page' },
      signal,
    );
    assert.match(closed.text, /tab t2 was closed/);
    const listed = await chrome.request(
      'c',
      'tabs',
      { action: 'list' },
      signal,
    );
    assert.match(listed.text, /t1 \(shown\)/);
    assert.doesNotMatch(listed.text, /t2/);
    const after = await chrome.request(
      'c',
      'navigate',
      { url: url + 'after' },
      signal,
    );
    assert.match(after.text, /opener/);
    assert.ok(cookies.at(-1)?.includes('fixture=kept'));
    await assert.rejects(
      chrome.request('c', 'tabs', { action: 'select', tab: 't2' }, signal),
      /no tab t2/,
    );
  },
);

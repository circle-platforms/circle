import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  existsSync,
  linkSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import type { CdpPipe } from '../src/browser/cdp.js';
import type {
  BrowserAction,
  CertificateApproval,
} from '../src/browser/protocol.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import {
  executable,
  skip,
  listen,
  browserProtocolTrace,
} from './browser-chrome-helpers.js';

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
    const downloadBody = 'data'.repeat(2048);
    const downloadFinishes: (() => void)[] = [];
    cleanup(t, () => {
      for (const finish of downloadFinishes) finish();
    });
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
          'content-length': String(downloadBody.length),
        });
        // Keep the real transfer pending until the navigation has returned.
        // Its bounded completion wait must not decide this test's outcome.
        res.write(downloadBody.slice(0, 4096));
        downloadFinishes.push(() => res.end(downloadBody.slice(4096)));
        return;
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
    cleanupServer(t, site);
    for (const server of devices) cleanupServer(t, server);
    const trustFile = join(temp, 'browser-certificates.json');
    const downloads = join(temp, 'downloads');
    const traces = new WeakMap<
      ChromeBrowser,
      ReturnType<typeof browserProtocolTrace>
    >();
    const start = () => {
      const browser = new ChromeBrowser({
        executable: executable!,
        trustFile,
        headless: true,
        downloads,
      });
      traces.set(browser, browserProtocolTrace(browser));
      return browser;
    };
    let chrome = start();
    cleanup(t, () => chrome.close());
    const signal = new AbortController().signal;
    // A failure names the step it happened at
    // A failure names the step it happened at, and what the browser was in: a failure
    // seen only in a CI log has to say enough
    type DebugBrowser = {
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
            {
              session: string;
              world?: number;
              loading: boolean;
              network: Set<string>;
              lastNetwork: number;
              interceptFailure?: string;
              dialogs: unknown[];
            }
          >;
        }
      >;
      stderr: string[];
    };
    const diagnose = async () => {
      const internals = chrome as unknown as DebugBrowser;
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
      lines.push(`protocol metadata ${JSON.stringify(traces.get(chrome)?.())}`);
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
          `context ${shown.world}; loading ${shown.loading}; network ${shown.network.size}; quiet ${Date.now() - shown.lastNetwork} ms; interception ${shown.interceptFailure ?? 'taken'}; dialogs ${shown.dialogs.length}`,
        );
        lines.push(
          `visibility ${await see('document.visibilityState + " focus " + document.hasFocus() + " ready " + document.readyState')}`,
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
                  `${info.type} ${info.attached ? 'attached' : 'unattached'}`,
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
          error.message = `${action} (argument keys: ${Object.keys(args).join(', ')}): ${error.message}\n${await diagnose()}`;
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
    const downloading = chrome as unknown as {
      cdp: CdpPipe;
      staging: string;
    };
    const completedDownload = () => {
      let guid: string | undefined;
      let stop = () => {};
      const completed = new Promise<{ guid: string; size: number }>(
        (resolve, reject) => {
          stop = downloading.cdp.on((event) => {
            if (event.method === 'Circle.closed') {
              stop();
              reject(Error('browser closed before the download completed'));
            }
            if (
              event.method === 'Browser.downloadWillBegin' &&
              event.params.url === `${http}/download`
            )
              guid = event.params.guid;
            if (
              event.method !== 'Browser.downloadProgress' ||
              !guid ||
              event.params.guid !== guid ||
              event.params.state === 'inProgress'
            )
              return;
            stop();
            if (event.params.state === 'completed')
              resolve({ guid, size: event.params.receivedBytes });
            else reject(Error(`download ${guid} ${event.params.state}`));
          });
        },
      );
      // Observe failures even if the navigation assertion fails first.
      void completed.catch(() => {});
      cleanup(t, stop);
      return completed;
    };
    const firstCompleted = completedDownload();
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
      files: [{ name: 'report.bin', size: 0 }],
    });
    assert.equal(existsSync(join(downloads, 'report.bin')), false);
    assert.equal(downloadFinishes.length, 1);
    downloadFinishes.shift()!();
    const staged = await firstCompleted;
    assert.equal(staged.size, downloadBody.length);
    assert.equal(
      readFileSync(join(downloading.staging, staged.guid), 'utf8'),
      downloadBody,
    );
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
      `### Download\nThe download was kept.\n- download dl1 finished: ${join(downloads, 'report.bin')} (8.0 KB)`,
    );
    assert.equal(
      readFileSync(join(downloads, 'report.bin'), 'utf8'),
      downloadBody,
    );
    // The site is allowed for the conversation now: no question
    const secondCompleted = completedDownload();
    const twice = await act('navigate', { url: `${http}/download` });
    assert.equal(twice.approval, undefined);
    assert.match(twice.text, /download dl2 of "report\.bin" .* started/);
    assert.equal(existsSync(join(downloads, 'report (1).bin')), false);
    assert.equal(downloadFinishes.length, 1);
    downloadFinishes.shift()!();
    assert.equal((await secondCompleted).size, downloadBody.length);
    assert.equal(
      readFileSync(join(downloads, 'report (1).bin'), 'utf8'),
      downloadBody,
    );
    const finished = await act('snapshot');
    assert(
      finished.text.includes(
        `download dl2 finished: ${join(downloads, 'report (1).bin')}`,
      ),
      finished.text,
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import type { BrowserAction } from '../src/browser/protocol.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import { executable, skip, listen } from './browser-chrome-helpers.js';

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
    cleanupServer(t, site);
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
    cleanupServer(t, server);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import { browserTools, runtimeBrowserOptions } from '../src/browser/tools.js';
import { formatScript, parseScript } from '../src/browser/script.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import { executable, skip, listen } from './browser-chrome-helpers.js';

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
    cleanupServer(t, site);
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
    cleanupServer(t, device);
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
        // Its state (collapsed, as the browser's page says) comes before the mark
        ref: ref(
          shown,
          /\[(e\d+)\] button "[^"]*"(?: [a-z]+)* \[warning: advanced\]/,
        ),
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

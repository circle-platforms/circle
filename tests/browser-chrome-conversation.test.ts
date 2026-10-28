import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { join } from 'node:path';
import { ChromeBrowser } from '../src/browser/chrome.js';
import type { CdpPipe } from '../src/browser/cdp.js';
import { browserTools, runtimeBrowserOptions } from '../src/browser/tools.js';
import { saveSecret } from '../src/secrets.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import type { CertificateApproval } from '../src/browser/protocol.js';
import { emptyUsage } from '../src/types.js';
import { cleanup, cleanupServer, scratch as made } from './helpers.js';
import {
  executable,
  skip,
  listen,
  humanNavigation,
} from './browser-chrome-helpers.js';

test(
  'the TUI agent clears real text and number inputs with empty browser_type calls and trusted input events',
  { skip: executable ? false : 'no Chrome, Edge or Chromium is installed' },
  async (t) => {
    const root = made(t, 'circle-chrome-empty-type-');
    const site = createHttp((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(`<!doctype html><title>empty type fixture</title>
        <label>Text field <input id="text" type="text"></label>
        <label>Number field <input id="number" type="number"></label>
        <script>
          window.inputEvents = [];
          for (const input of document.querySelectorAll('input'))
            input.addEventListener('input', event => window.inputEvents.push({
              id: input.id, value: input.value, trusted: event.isTrusted,
              inputType: event.inputType
            }));
        </script>`);
    });
    const url = `http://127.0.0.1:${await listen(site)}/`;
    cleanupServer(t, site);
    const chrome = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: join(root, 'downloads'),
    });
    cleanup(t, () => chrome.close());
    const internal = chrome as unknown as {
      conversations: Map<string, { tabs: Map<string, { session: string }> }>;
      send: (
        method: string,
        params: Record<string, unknown>,
        session?: string,
      ) => Promise<any>;
    };
    let runtime: AgentRuntime;
    const read = async () => {
      const tab = [
        ...internal.conversations.get(runtime.session.id)!.tabs.values(),
      ][0]!;
      // Read only: typing and clearing use the actual agent tool, never a DOM write.
      const result = await internal.send(
        'Runtime.evaluate',
        {
          expression:
            'JSON.stringify({text:document.getElementById("text").value,number:document.getElementById("number").value,events:window.inputEvents})',
          returnByValue: true,
        },
        tab.session,
      );
      return JSON.parse(result.result.value) as {
        text: string;
        number: string;
        events: {
          id: string;
          value: string;
          trusted: boolean;
          inputType: string;
        }[];
      };
    };
    const operations = [
      {
        id: 'fill-text',
        field: 'text',
        label: 'Text field',
        text: 'actual text bytes',
      },
      {
        id: 'fill-number',
        field: 'number',
        label: 'Number field',
        text: '12345',
      },
      { id: 'clear-text', field: 'text', label: 'Text field', text: '' },
      { id: 'clear-number', field: 'number', label: 'Number field', text: '' },
    ] as const;
    const observed: { id: string; value: string; inputType: string }[] = [];
    const check = async (operation: (typeof operations)[number]) => {
      const state = await read();
      assert.equal(
        state[operation.field],
        operation.text,
        `${operation.id} must change the actual DOM value`,
      );
      const event = state.events.at(-1)!;
      assert.equal(event.id, operation.field);
      assert.equal(event.value, operation.text);
      assert.equal(
        event.trusted,
        true,
        'the page received a real browser input event',
      );
      if (operation.text === '') {
        assert.equal(Buffer.byteLength(state[operation.field]), 0);
        assert.equal(event.inputType, 'deleteContentBackward');
      }
      observed.push({
        id: operation.id,
        value: event.value,
        inputType: event.inputType,
      });
    };
    const model = new ScriptedModel([
      {
        message: {
          id: 'open-empty-type',
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'open', name: 'browser_navigate', args: { url } }],
        },
      },
      ...operations.map(
        (operation, index) =>
          async (request: import('../src/types.js').ModelRequest) => {
            if (index) await check(operations[index - 1]!);
            const shown = request.messages
              .filter((message) => message.role === 'tool')
              .at(-1)!.content;
            const ref = new RegExp(
              `\\[(e\\d+)\\][^\\n]*"${operation.label}"`,
            ).exec(shown)?.[1];
            assert(ref, `the real snapshot names ${operation.label}`);
            return {
              message: {
                id: operation.id,
                role: 'assistant' as const,
                content: '',
                tool_calls: [
                  {
                    id: operation.id,
                    name: 'browser_type',
                    args: {
                      ref,
                      element: operation.label,
                      text: operation.text,
                    },
                  },
                ],
              },
              usage: emptyUsage(),
            };
          },
      ),
      async () => {
        await check(operations.at(-1)!);
        return {
          message: {
            id: 'empty-type-finished',
            role: 'assistant',
            content: 'real input values checked',
          },
          usage: emptyUsage(),
        };
      },
    ]);
    runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings: defaultSettings(),
      model,
      headless: true,
      extraTools: browserTools(
        chrome,
        runtimeBrowserOptions(() => runtime),
      ),
    });
    cleanup(t, () => runtime.close());
    runtime.policy.setYolo(runtime.session.id, true);
    await runtime.harness.run('fill and then clear both inputs');
    assert.equal(
      model.requests.length,
      6,
      'each real tool result reached the next model request',
    );
    const stored = runtime.store.messages(runtime.session.id);
    assert.equal(stored.filter((message) => message.role === 'tool').length, 5);
    assert.deepEqual(
      stored
        .flatMap((message) => message.tool_calls ?? [])
        .filter((call) => call.id.startsWith('clear-'))
        .map((call) => call.args.text),
      ['', ''],
    );
    assert.deepEqual(
      (await read()).events.map((event) => event.id),
      ['text', 'number', 'text', 'number'],
    );
    const version = await internal.send('Browser.getVersion', {});
    t.diagnostic(
      JSON.stringify({
        adapter: 'TUI ChromeBrowser',
        browser: version.product,
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        observed,
      }),
    );
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
    cleanupServer(t, device);
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
    const responses = new Set<ReturnType<typeof setTimeout>>();
    const site = createHttp((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      const finish = () =>
        res.end(
          `<!doctype html><title>${req.url === '/b' ? 'Signed in' : 'Sign in'}</title><input aria-label="Code">`,
        );
      if (req.url === '/b') {
        const timer = setTimeout(() => {
          responses.delete(timer);
          finish();
        }, 1500);
        responses.add(timer);
      } else finish();
    });
    const base = `http://127.0.0.1:${await listen(site)}`;
    cleanupServer(t, site);
    cleanup(t, () => {
      for (const timer of responses) clearTimeout(timer);
      responses.clear();
    });
    const reasons: string[] = [];
    const chrome: ChromeBrowser = new ChromeBrowser({
      executable: executable!,
      headless: true,
      downloads: temp,
      // The person types a code and goes on, in the window: Circle sees none of it
      handoff: async (reason, signal) => {
        reasons.push(reason);
        const internals = chrome as unknown as {
          cdp: CdpPipe;
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
        // Subscribe before initiating navigation so an immediately cached page cannot
        // commit between the action and our listener. A slow response exceeds the old
        // fixed 800 ms wait, but ownership remains with the person until actual load.
        await humanNavigation(
          internals.cdp,
          tab.session,
          `${base}/b`,
          signal,
          () =>
            internals.send(
              'Runtime.evaluate',
              {
                expression: `document.querySelector('input').value = 'typed-by-the-person'; location.href = '/b'`,
              },
              tab.session,
            ),
        );
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
    cleanupServer(t, site);
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

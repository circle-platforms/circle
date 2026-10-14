import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionApp } from '../src/tui/session_app.js';
import { GatewayModel } from '../src/model.js';
import { ScriptedModel } from '../src/testing.js';
import { PROVIDER_PRESETS } from '../src/providers.js';
import {
  defaultSettings,
  loadCredentials,
  loadSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

type Context = Parameters<typeof scratch>[0];
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !check(); i++) await delay(5);
  assert.ok(check(), 'the real connection form reaches the expected step');
}
function streamed(protocol: string, model: string, text: string): string {
  if (protocol === 'openai')
    return (
      'data: ' +
      JSON.stringify({
        choices: [
          { index: 0, delta: { content: text }, finish_reason: 'stop' },
        ],
      }) +
      '\n\ndata: [DONE]\n\n'
    );
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg-local',
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: 'message_stop' },
  ];
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('');
}
async function gateway(t: Context) {
  const seen: {
    method: string;
    url: string;
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
  }[] = [];
  const server = createServer(async (req, res) => {
    let bytes = '';
    for await (const chunk of req) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : {};
    seen.push({
      method: req.method!,
      url: req.url!,
      headers: req.headers,
      body,
    });
    if (
      req.method === 'GET' &&
      /^\/(failed|cycle)\/anthropic\/v1\/models/.test(req.url ?? '')
    ) {
      res.setHeader('Content-Type', 'application/json');
      if (new URL(req.url!, 'http://fixture').searchParams.has('after_id')) {
        if (req.url!.startsWith('/failed/')) {
          res.writeHead(503);
          res.end('{"error":"second page unavailable"}');
        } else
          res.end(
            JSON.stringify({
              data: [{ id: 'partial-21' }],
              has_more: true,
              last_id: 'partial-20',
            }),
          );
      } else {
        res.end(
          JSON.stringify({
            data: Array.from({ length: 20 }, (_, i) => ({
              id: `partial-${i + 1}`,
            })),
            has_more: true,
            last_id: 'partial-20',
          }),
        );
      }
      return;
    }
    if (req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        streamed(
          req.url!.endsWith('/messages') ? 'anthropic' : 'openai',
          String(body.model),
          'local connection answer',
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup(t, async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}
async function fixture(t: Context, base: string, attached: boolean) {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = trustFolder(defaultSettings(), workspace);
  settings.initialized = true;
  settings.auth.base_url = base + '/old/v1';
  settings.auth.model = 'old-model';
  saveSettings(settings, home);
  saveCredentials({ api_key: 'old-key' }, home);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  if (attached)
    await app.attach({
      workspace,
      home,
      settings,
      model: new ScriptedModel(),
      headless: true,
    });
  cleanup(t, async () => {
    ui.off?.();
    ui.offSignals?.();
    ui.interactions.close();
    for (const timer of ['flashTimer', 'renderTimer', 'animation'])
      if (ui[timer]) clearTimeout(ui[timer]);
    ui.input.close();
    await app.runtime?.close();
  });
  const key = async (key: string, char = '') => {
    ui.handle({ type: 'key', key, char });
    // Picker answers settle on a promise, as in a real input event loop.
    await delay(1);
  };
  const paste = (text: string) => ui.handle({ type: 'paste', text });
  const chooseProvider = async (id: string) => {
    const index = PROVIDER_PRESETS.findIndex((item) => item.id === id);
    assert(index >= 0);
    for (let i = 0; i < index; i++) await key('down');
    await key('enter');
  };
  return { app, ui, home, workspace, key, paste, chooseProvider };
}

for (const entry of ['setup', 'login'] as const)
  test(`full-screen ${entry} saves an explicit preset's edited fields and sends the exact id through both actual SDKs (#60)`, async (t) => {
    for (const protocol of ['openai', 'anthropic'] as const) {
      const { base, seen } = await gateway(t);
      const s = await fixture(t, base, entry === 'login');
      const before = readFileSync(join(s.home, 'settings.json'), 'utf8');
      const done =
        entry === 'setup' ? s.app.initialize(true) : s.app.submit('/login');
      if (entry === 'login') await done;
      await s.chooseProvider(
        protocol === 'openai' ? 'bailian' : 'bailian-anthropic',
      );
      await s.key('ctrl+u');
      const endpoint =
        base + (protocol === 'openai' ? '/edited/v1' : '/edited/anthropic');
      s.paste(endpoint + (protocol === 'anthropic' ? '/v1' : ''));
      await s.key('enter');
      s.paste('local-key');
      await s.key('enter');
      await until(() =>
        entry === 'setup'
          ? s.app.state.dialog?.title === 'Which model?'
          : Boolean(
              s.app.state.picker?.items.some(
                (item) => item.key === 'qwen3.8-max',
              ),
            ),
      );
      assert.equal(seen.length, 0, 'presets do not trigger online discovery');
      assert.equal(
        readFileSync(join(s.home, 'settings.json'), 'utf8'),
        before,
        'the form has not saved before model selection',
      );
      const model = `account-edited-${protocol}`;
      s.paste(model);
      await s.key('enter');
      if (entry === 'setup') {
        assert.equal(await done, true);
        const settings = loadSettings(s.home);
        await s.app.attach({
          workspace: s.workspace,
          home: s.home,
          settings,
          model: new GatewayModel(settings, s.home),
          headless: true,
        });
      } else {
        await done;
        await until(() => s.app.state.picker === undefined);
      }
      assert.equal(loadSettings(s.home).auth.base_url, endpoint);
      assert.equal(loadSettings(s.home).auth.protocol, protocol);
      assert.equal(loadSettings(s.home).auth.model, model);
      assert.equal(loadCredentials(s.home).api_key, 'local-key');
      await s.app.submit('preset roundtrip');
      assert.equal(seen.length, 1);
      assert.equal(
        seen[0]!.url,
        protocol === 'openai'
          ? '/edited/v1/chat/completions'
          : '/edited/anthropic/v1/messages',
      );
      assert.equal(seen[0]!.body.model, model);
      assert.equal(
        protocol === 'openai'
          ? seen[0]!.headers.authorization
          : seen[0]!.headers['x-api-key'],
        protocol === 'openai' ? 'Bearer local-key' : 'local-key',
      );
      if (protocol === 'anthropic')
        assert.equal(seen[0]!.headers['anthropic-version'], '2023-06-01');
      assert(
        s.app
          .runtime!.store.messages(s.app.runtime!.session.id)
          .some(
            (message) =>
              message.role === 'assistant' &&
              message.content === 'local connection answer',
          ),
      );
    }
  });

for (const entry of ['setup', 'login'] as const)
  test(`full-screen ${entry} discards failed and cyclic Anthropic pages, preserves saved configuration and still sends with the old model (#60)`, async (t) => {
    for (const failure of ['failed', 'cycle']) {
      const { base, seen } = await gateway(t);
      const s = await fixture(t, base, entry === 'login');
      const before = readFileSync(join(s.home, 'settings.json'), 'utf8');
      const credentials = readFileSync(
        join(s.home, 'credentials.json'),
        'utf8',
      );
      const done =
        entry === 'setup' ? s.app.initialize(true) : s.app.submit('/login');
      if (entry === 'login') await done;
      await s.chooseProvider('anthropic');
      await s.key('ctrl+u');
      s.paste(base + `/${failure}/anthropic/v1`);
      await s.key('enter');
      s.paste('candidate-key');
      await s.key('enter');
      const detail =
        failure === 'failed' ? 'http 503' : 'invalid model pagination';
      await until(() =>
        entry === 'setup'
          ? s.app.state.dialog?.title === 'Which model?'
          : Boolean(s.app.state.picker?.options.hint?.includes(detail)),
      );
      if (entry === 'setup') {
        assert.deepEqual(
          s.app.state.dialog!.options,
          [],
          'the partial online list is discarded',
        );
        assert(
          s.app.state.dialog!.lines?.some((line) => line.text.includes(detail)),
        );
      } else {
        assert.deepEqual(
          s.app.state.picker!.items,
          [],
          'the partial online list is discarded',
        );
        assert.match(
          s.app.state.picker!.options.hint!,
          /model discovery failed/,
        );
      }
      await s.key('enter');
      assert.equal(readFileSync(join(s.home, 'settings.json'), 'utf8'), before);
      assert.equal(
        readFileSync(join(s.home, 'credentials.json'), 'utf8'),
        credentials,
      );
      await s.key('escape');
      if (entry === 'setup') assert.equal(await done, false);
      else assert.equal(s.app.state.picker, undefined);
      assert.deepEqual(
        seen.map((request) => request.url),
        [
          `/${failure}/anthropic/v1/models`,
          `/${failure}/anthropic/v1/models?after_id=partial-20`,
        ],
      );
      const settings = loadSettings(s.home);
      const model = new GatewayModel(settings, s.home);
      if (entry === 'setup')
        await s.app.attach({
          workspace: s.workspace,
          home: s.home,
          settings,
          model,
          headless: true,
        });
      else s.app.runtime!.harness.model = model;
      await s.app.submit('old connection still works');
      assert.equal(seen.at(-1)!.url, '/old/v1/chat/completions');
      assert.equal(seen.at(-1)!.headers.authorization, 'Bearer old-key');
      assert.equal(seen.at(-1)!.body.model, 'old-model');
    }
  });

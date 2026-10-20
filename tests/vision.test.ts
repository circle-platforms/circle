import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import {
  VisionService,
  visionConnection,
  type VisionConnection,
} from '../src/vision.js';
import { saveMediaAttachment, makeAttachment } from '../src/media.js';
import { GatewayModel } from '../src/model.js';
import { ModelCatalog, slimCatalog } from '../src/model_catalog.js';
import { AgentRuntime } from '../src/runtime.js';
import {
  browserTools,
  runtimeBrowserOptions,
  type BrowserPort,
} from '../src/browser/tools.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { CircleEvent } from '../src/events.js';
import type { ModelResponse, Tool, ToolCall } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

function png(width = 4, height = 3): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(120);
  return PNG.sync.write(image);
}

const reply = (
  id: string,
  calls: ToolCall[] = [],
  content = '',
): Partial<ModelResponse> => ({
  message: { id, role: 'assistant', content, tool_calls: calls },
});

/** A local OpenAI-compatible chat/completions endpoint for the side vision model. */
async function visionServer(
  t: { after(fn: () => void | Promise<void>): void },
  answer: (
    request: IncomingMessage,
    body: Record<string, unknown>,
    response: ServerResponse,
    hits: { count: number },
  ) => void,
): Promise<{ base: string; hits: { count: number }; bodies: unknown[] }> {
  const hits = { count: 0 };
  const bodies: unknown[] = [];
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    bodies.push(text ? JSON.parse(text) : {});
    hits.count++;
    answer(request, text ? JSON.parse(text) : {}, response, hits);
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    instance.closeAllConnections();
    return new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}/v1`, hits, bodies };
}

function connection(base: string): VisionConnection {
  return { baseUrl: base, model: 'vlm-1', apiKey: 'vision-secret' };
}

function completion(response: ServerResponse, message: unknown, usage = {}) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      choices: [{ index: 0, message, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, ...usage },
    }),
  );
}

test('the vision service asks an OpenAI-compatible endpoint, carries the picture as a data URL and the question as the focus, and reports usage', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const picture = join(root, 'a.png');
  writeFileSync(picture, png());
  const server = await visionServer(t, (request, body, response) => {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer vision-secret');
    completion(response, { role: 'assistant', content: 'a blue square' });
  });
  const usage: unknown[] = [];
  const service = new VisionService();
  const described = await service.describe(
    connection(server.base),
    [picture],
    'what shape is it',
    new AbortController().signal,
    (call) => usage.push(call),
  );
  assert.equal(described.model, 'vlm-1');
  assert.equal(described.text, 'a blue square');
  assert.deepEqual(usage, [
    { model: 'vlm-1', usage: { input_tokens: 100, output_tokens: 20 } },
  ]);
  const sent = server.bodies[0] as {
    model: string;
    messages: Array<{
      role: string;
      content: Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
    }>;
  };
  assert.equal(sent.model, 'vlm-1');
  const parts = sent.messages[0]!.content;
  assert.match(parts[0]!.text!, /what shape is it/);
  assert.equal(parts[0]!.type, 'text');
  const image = parts[1]!;
  assert.equal(image.type, 'image_url');
  assert.equal(
    image.image_url!.url,
    `data:image/png;base64,${readFileSync(picture).toString('base64')}`,
  );
});

test('the same picture and question are described once; a new question or picture asks again', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const a = join(root, 'a.png');
  const b = join(root, 'b.png');
  writeFileSync(a, png());
  writeFileSync(b, png(6, 5));
  const server = await visionServer(t, (_request, _body, response) =>
    completion(response, { role: 'assistant', content: 'again' }),
  );
  const service = new VisionService();
  const signal = new AbortController().signal;
  const one = connection(server.base);
  await service.describe(one, [a], 'same question', signal);
  await service.describe(one, [a], 'same question', signal);
  await service.describe(one, [b], 'same question', signal);
  await service.describe(one, [a], 'another question', signal);
  assert.equal(server.hits.count, 3);
});

test('a reply that carries its words in reasoning_content still counts; one with no words at all is an error', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const picture = join(root, 'a.png');
  writeFileSync(picture, png());
  let empty = false;
  const server = await visionServer(t, (_request, _body, response) =>
    empty
      ? completion(response, { role: 'assistant', content: '' })
      : completion(response, {
          role: 'assistant',
          content: '',
          reasoning_content: 'the words live here',
        }),
  );
  const signal = new AbortController().signal;
  assert.equal(
    (
      await new VisionService().describe(
        connection(server.base),
        [picture],
        '',
        signal,
      )
    ).text,
    'the words live here',
  );
  empty = true;
  await assert.rejects(
    new VisionService().describe(
      connection(server.base),
      [picture],
      '',
      signal,
    ),
    /vlm-1 returned no description/,
  );
});

test('failures come back readable: an endpoint error page never reaches the model whole, and the key is never echoed', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const picture = join(root, 'a.png');
  writeFileSync(picture, png());
  let mode: 'json' | 'html' | 'redact' = 'json';
  const server = await visionServer(t, (request, _body, response) => {
    if (mode === 'html') {
      response.writeHead(502, { 'content-type': 'text/html' });
      response.end('<html><body>Bad gateway '.repeat(500) + '</body></html>');
      return;
    }
    if (mode === 'redact') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: `key vision-secret rejected on ${request.url}` },
        }),
      );
      return;
    }
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({ error: { type: 'server', message: 'boom' } }),
    );
  });
  const service = new VisionService();
  const signal = new AbortController().signal;
  const one = connection(server.base);
  await assert.rejects(
    service.describe(one, [picture], '', signal),
    /^Error: vision model http 500: server: boom$/,
  );
  mode = 'html';
  await assert.rejects(
    service.describe(one, [picture], '', signal),
    /^Error: vision model http 502$/,
  );
  mode = 'redact';
  await assert.rejects(
    service.describe(one, [picture], '', signal),
    (error: Error) =>
      /vision model http 401/.test(error.message) &&
      !error.message.includes('vision-secret'),
  );
});

test('a stopped signal stops the description call before anything is sent', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const picture = join(root, 'a.png');
  writeFileSync(picture, png());
  const server = await visionServer(t, (_request, _body, response) =>
    completion(response, { role: 'assistant', content: 'late' }),
  );
  const controller = new AbortController();
  controller.abort(new Error('Interrupted'));
  await assert.rejects(
    new VisionService().describe(
      connection(server.base),
      [picture],
      '',
      controller.signal,
    ),
    /Interrupted/,
  );
  assert.equal(server.hits.count, 0);
});

test('the vision connection comes from settings, credentials and the environment; a missing part leaves none', (t) => {
  const root = scratch(t, 'circle-vision-');
  const settings = defaultSettings();
  settings.vision = {
    base_url: 'https://vlm.example/v1',
    model: 'vlm-1',
    api_key_ref: 'vision_key',
  };
  const credentials = { vision_key: 'saved-key' };
  assert.deepEqual(visionConnection(settings, credentials, {}), {
    baseUrl: 'https://vlm.example/v1',
    model: 'vlm-1',
    apiKey: 'saved-key',
  });
  assert.deepEqual(
    visionConnection(settings, credentials, {
      CIRCLE_VISION_BASE_URL: 'http://other/v1',
      CIRCLE_VISION_MODEL: 'vlm-2',
      CIRCLE_VISION_KEY: 'env-key',
    }),
    { baseUrl: 'http://other/v1', model: 'vlm-2', apiKey: 'env-key' },
  );
  assert.equal(visionConnection(settings, {}, {}), undefined);
  assert.equal(visionConnection(defaultSettings(), credentials, {}), undefined);
  assert.equal(root.length > 0, true);
});

function visionRuntime(
  t: { after(fn: () => void | Promise<void>): void },
  root: string,
  model: ScriptedModel,
  serverBase: string,
  options: { extraTools?: Tool[] } = {},
): AgentRuntime {
  process.env.CIRCLE_VISION_BASE_URL = serverBase;
  process.env.CIRCLE_VISION_KEY = 'vision-secret';
  process.env.CIRCLE_VISION_MODEL = 'vlm-1';
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    ...(options.extraTools ? { extraTools: options.extraTools } : {}),
  });
  cleanup(t, () => {
    delete process.env.CIRCLE_VISION_BASE_URL;
    delete process.env.CIRCLE_VISION_KEY;
    delete process.env.CIRCLE_VISION_MODEL;
    return runtime.close();
  });
  return runtime;
}

test('a model that cannot read images has read_file describe the picture, and the vision tool answers only its question', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  writeFileSync(join(root, 'shot.png'), png());
  const questions: string[] = [];
  const server = await visionServer(t, (_request, body, response) => {
    const text = (
      (body.messages as Array<{ content: Array<{ text?: string }> }>)[0]
        ?.content?.[0]?.text ?? ''
    ).trim();
    questions.push(text);
    completion(response, {
      role: 'assistant',
      content: text.includes('dialog') ? 'an error dialog' : 'a plain window',
    });
  });
  const model = Object.assign(
    new ScriptedModel([
      reply('one', [
        { id: 'read', name: 'read_file', args: { file_path: 'shot.png' } },
      ]),
      reply('two', [
        {
          id: 'ask',
          name: 'vision',
          args: { path: 'shot.png', question: 'what does the dialog say' },
        },
      ]),
      reply('done', [], 'seen'),
    ]),
    { imageInput: false },
  );
  const runtime = visionRuntime(t, root, model, server.base);
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('look');
  const results = model.requests
    .slice(1)
    .map((request) => request.messages.at(-1)!.content);
  assert.match(
    results[0]!,
    /shot\.png as the side vision model vlm-1 describes it:\n\na plain window/,
  );
  assert.match(results[1]!, /an error dialog/);
  // the description tool sent the question as the focus
  assert.match(questions[1]!, /what does the dialog say/);
  // no picture went to the model itself
  assert.equal(
    model.requests.some((request) =>
      request.messages.some((message) => message.attachments?.length),
    ),
    false,
  );
});

test('the vision tool refuses credential files and non-pictures', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  writeFileSync(join(root, '.env'), 'TOKEN=x');
  writeFileSync(join(root, 'notes.txt'), 'words');
  const server = await visionServer(t, (_request, _body, response) =>
    completion(response, { role: 'assistant', content: 'unused' }),
  );
  const model = Object.assign(
    new ScriptedModel([
      reply('one', [
        { id: 'a', name: 'vision', args: { path: '.env' } },
        { id: 'b', name: 'vision', args: { path: 'notes.txt' } },
      ]),
      reply('done', [], 'seen'),
    ]),
    { imageInput: false },
  );
  const runtime = visionRuntime(t, root, model, server.base);
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('look');
  const results = model.requests[1]!.messages.filter(
    (message) => message.role === 'tool',
  ).map((message) => message.content);
  assert.match(results[0]!, /'\.env' is a credential file/);
  assert.match(results[1]!, /not a picture file/);
  assert.equal(server.hits.count, 0);
});

test('with a side vision model, the screenshot tool takes the picture for a model that cannot read it, saves it and describes it', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const calls: string[][] = [];
  const desktop = async (
    command: string,
    args: string[],
    options: { env?: NodeJS.ProcessEnv },
  ) => {
    calls.push([command, ...args]);
    if (command === 'osascript')
      return {
        code: 0,
        stdout: Buffer.from(
          JSON.stringify({ window: null, apps: [], allowed: true }),
        ),
      };
    if (command === 'powershell') {
      writeFileSync(options.env!.CIRCLE_SCREENSHOT!, png());
      return { code: 0, stdout: Buffer.from('png\r\n') };
    }
    writeFileSync(args.at(-1)!, png());
    return { code: 0, stdout: Buffer.alloc(0) };
  };
  const server = await visionServer(t, (_request, body, response) => {
    const text = (
      (body.messages as Array<{ content: Array<{ text?: string }> }>)[0]
        ?.content?.[0]?.text ?? ''
    ).trim();
    assert.match(text, /screenshot of the main screen/);
    completion(response, {
      role: 'assistant',
      content: 'a terminal with tests',
    });
  });
  const model = Object.assign(
    new ScriptedModel([
      reply('shoot', [{ id: 'shot', name: 'screenshot', args: {} }]),
      reply('done', [], 'ok'),
    ]),
    { imageInput: false },
  );
  process.env.CIRCLE_VISION_BASE_URL = server.base;
  process.env.CIRCLE_VISION_KEY = 'vision-secret';
  process.env.CIRCLE_VISION_MODEL = 'vlm-1';
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    screenshot: { platform: 'darwin', env: {}, run: desktop },
  });
  cleanup(t, () => {
    delete process.env.CIRCLE_VISION_BASE_URL;
    delete process.env.CIRCLE_VISION_KEY;
    delete process.env.CIRCLE_VISION_MODEL;
    return runtime.close();
  });
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('look');
  const result = model.requests[1]!.messages.at(-1)!.content;
  assert.match(result, /Screenshot of the main screen saved as .*\.png/);
  assert.match(
    result,
    /Described by the side vision model vlm-1:\na terminal with tests/,
  );
  const saved = result.match(/saved as (\S+\.png)/)![1]!;
  assert.ok(existsSync(saved));
  assert.ok(saved.startsWith(join(root, 'projects')));
  // the window was listed once and the screen captured once
  assert.equal(calls.length, 2);
});

test('without a side vision model the screenshot tool still takes nothing, and its error says why', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const calls: string[][] = [];
  const model = Object.assign(
    new ScriptedModel([
      reply('shoot', [{ id: 'shot', name: 'screenshot', args: {} }]),
      reply('done', [], 'ok'),
    ]),
    { imageInput: false },
  );
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    screenshot: {
      platform: 'darwin',
      env: {},
      run: async (_command, args) => {
        calls.push(args);
        return { code: 0, stdout: Buffer.alloc(0) };
      },
    },
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('look');
  assert.match(
    model.requests[1]!.messages.at(-1)!.content,
    /the model in use does not read images; no side vision model is configured/,
  );
  assert.equal(calls.length, 0);
});

test('a browser screenshot for such a model is saved under the run data and described', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const server = await visionServer(t, (_request, body, response) => {
    const text = (
      (body.messages as Array<{ content: Array<{ text?: string }> }>)[0]
        ?.content?.[0]?.text ?? ''
    ).trim();
    assert.match(text, /screenshot of a web page/);
    completion(response, { role: 'assistant', content: 'a login form' });
  });
  const port: BrowserPort = {
    async request() {
      return {
        text: 'The page as text.',
        image: png().toString('base64'),
      };
    },
  };
  const model = Object.assign(
    new ScriptedModel([
      reply('one', [{ id: 'shot', name: 'browser_screenshot', args: {} }]),
      reply('done', [], 'ok'),
    ]),
    { imageInput: false },
  );
  let runtime!: AgentRuntime;
  runtime = visionRuntime(t, root, model, server.base, {
    extraTools: browserTools(
      port,
      runtimeBrowserOptions(() => runtime),
    ),
  });
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('browser');
  const result = model.requests[1]!.messages.at(-1)!.content;
  assert.match(result, /The page as text\./);
  assert.match(result, /The picture is saved as .*\.png/);
  assert.match(
    result,
    /Described by the side vision model vlm-1:\na login form/,
  );
  const saved = result.match(/saved as (\S+\.png)/)![1]!;
  assert.ok(existsSync(saved));
  assert.ok(saved.startsWith(join(root, 'projects')));
});

test('a picture given with the prompt is saved under the run data and its path stays in the message', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  const picture = png(5, 4);
  const model = Object.assign(
    new ScriptedModel([reply('done', [], 'ok'), reply('again', [], 'ok')]),
    { imageInput: false },
  );
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const notices: unknown[] = [];
  runtime.bus.subscribe((event: CircleEvent) => {
    if (event.kind === 'info' && event.payload.model_notice)
      notices.push(event.payload.model_notice);
  });
  await runtime.harness.run('what is this', 'what is this', [
    makeAttachment(picture, 'image/png', 'pasted.png'),
  ]);
  const sent = model.requests[0]!.messages.find(
    (message) => message.role === 'user',
  )!;
  assert.equal(sent.attachments, undefined);
  const saved = sent.content.match(
    /\[Images this model does not read, saved as files: (\S+\.png)\]/,
  )![1]!;
  assert.ok(saved.startsWith(join(root, 'projects')));
  assert.deepEqual(readFileSync(saved), picture);
  // the same picture saved again lands on the same file
  await runtime.harness.run('again', 'again', [
    makeAttachment(picture, 'image/png', 'pasted.png'),
  ]);
  const second = model.requests
    .at(-1)!
    .messages.filter((message) => message.role === 'user')
    .at(-1)!;
  assert.equal(
    second.content.match(
      /\[Images this model does not read, saved as files: (\S+\.png)\]/,
    )![1]!,
    saved,
  );
  assert.deepEqual(
    notices.find(
      (notice) =>
        (notice as { event: string }).event === 'images_left_out' &&
        (notice as { saved?: boolean }).saved,
    ),
    { event: 'images_left_out', model: 'scripted', count: 1, saved: true },
  );
});

test('an unknown model whose endpoint refuses pictures is marked text-only, and the next request carries the paths only', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  writeFileSync(join(root, 'shot.png'), png());
  const withImage: unknown[] = [];
  const bodies: Record<string, unknown>[] = [];
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    bodies.push(body);
    const hasImage = (body.messages as unknown[]).some(
      (message) =>
        Array.isArray((message as { content?: unknown }).content) &&
        ((message as { content: unknown[] }).content as unknown[]).some(
          (part) => (part as { type?: string }).type === 'image_url',
        ),
    );
    withImage.push(hasImage);
    if (hasImage) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: { message: 'image content parts are not supported' },
        }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'no picture' },
              finish_reason: null,
            },
          ],
        }) +
        '\n\n',
    );
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }) +
        '\n\n',
    );
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => instance.close(() => resolve())) as never,
  );
  const address = instance.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  const settings = defaultSettings();
  settings.auth.base_url = `${base}/v1`;
  settings.auth.protocol = 'openai';
  const catalog = new ModelCatalog(root, {
    data: slimCatalog({
      lab: {
        api: settings.auth.base_url,
        models: { other: { limit: { context: 100000 } } },
      },
    }),
    env: {},
  });
  saveCredentials({ api_key: 'main-key' }, root);
  const model = new GatewayModel(settings, root, 'mystery-model', {}, catalog);
  assert.equal(model.imageInput, undefined);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  await assert.rejects(
    runtime.harness.run('what is in @shot.png'),
    /mystery-model does not read images/,
  );
  assert.equal(model.imageInput, false);
  await runtime.harness.run('what is in @shot.png');
  // only the first request carried a picture; the title request and the retry did not
  assert.equal(withImage[0], true);
  assert.equal(withImage.includes(true, 1), false);
  // the request that worked named the file's path in plain text
  const last = (bodies.at(-1)!.messages as { role: string; content: unknown }[])
    .filter((message) => message.role === 'user')
    .at(-1)!.content;
  const asText = Array.isArray(last)
    ? last.map((part) => (part as { text?: string }).text ?? '').join(' ')
    : String(last);
  assert.match(asText, /shot\.png/);
});

test('a 400 about something else keeps its own error and does not mark the model', async (t) => {
  const root = realpathSync(scratch(t, 'circle-vision-'));
  writeFileSync(join(root, 'shot.png'), png());
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid tool schema' } }));
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(
    () =>
      new Promise<void>((resolve) => instance.close(() => resolve())) as never,
  );
  const address = instance.address();
  const base = `http://127.0.0.1:${(address as { port: number }).port}`;
  const settings = defaultSettings();
  settings.auth.base_url = `${base}/v1`;
  settings.auth.protocol = 'openai';
  const catalog = new ModelCatalog(root, {
    data: slimCatalog({}),
    env: {},
  });
  saveCredentials({ api_key: 'main-key' }, root);
  const model = new GatewayModel(settings, root, 'mystery-model', {}, catalog);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  await assert.rejects(
    runtime.harness.run('what is in @shot.png'),
    (error: Error) => !/does not read images/.test(error.message),
  );
  assert.equal(model.imageInput, undefined);
});

test('saveMediaAttachment writes each picture once under the folder it is given', (t) => {
  const root = scratch(t, 'circle-vision-');
  const folder = join(root, 'media');
  const picture = makeAttachment(png(3, 2), 'image/png', 'a.png');
  const first = saveMediaAttachment(folder, picture);
  assert.ok(first.startsWith(join(folder, 'images')));
  assert.ok(first.endsWith('.png'));
  assert.deepEqual(readFileSync(first), Buffer.from(picture.data, 'base64'));
  assert.equal(saveMediaAttachment(folder, picture), first);
  assert.equal(root.length > 0, true);
});

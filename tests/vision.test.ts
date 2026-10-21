import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { PNG } from 'pngjs';
import {
  VisionService,
  timeoutFromEnv,
  visionConnection,
  type VisionConnection,
} from '../src/vision.js';
import { saveMediaAttachment, makeAttachment } from '../src/media.js';
import { GatewayModel } from '../src/model.js';
import { ModelCatalog, slimCatalog } from '../src/model_catalog.js';
import { endpointRefusesImages } from '../src/model_media.js';
import { AgentRuntime, type RuntimeOptions } from '../src/runtime.js';
import {
  browserTools,
  runtimeBrowserOptions,
  type BrowserPort,
} from '../src/browser/tools.js';
import type { FileMutations } from '../src/file_mutations.js';
import { projectDataDir } from '../src/paths.js';
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  options: {
    extraTools?: Tool[];
    /** The data folder, when it is not the workspace itself. */
    home?: string;
    fileMutations?: FileMutations;
    screenshot?: RuntimeOptions['screenshot'];
  } = {},
): AgentRuntime {
  process.env.CIRCLE_VISION_BASE_URL = serverBase;
  process.env.CIRCLE_VISION_KEY = 'vision-secret';
  process.env.CIRCLE_VISION_MODEL = 'vlm-1';
  const runtime = new AgentRuntime({
    workspace: root,
    home: options.home ?? root,
    settings: defaultSettings(),
    model,
    headless: true,
    ...(options.extraTools ? { extraTools: options.extraTools } : {}),
    ...(options.fileMutations ? { fileMutations: options.fileMutations } : {}),
    ...(options.screenshot ? { screenshot: options.screenshot } : {}),
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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

/** The tool results of one request, by the id of their call. */
function toolResults(messages: { role: string; content: string }[]) {
  return Object.fromEntries(
    messages
      .filter((message) => message.role === 'tool')
      .map((message) => [
        (message as { tool_call_id?: string }).tool_call_id,
        message.content,
      ]),
  ) as Record<string, string>;
}

/** The pictures one side vision call carried, as data URLs. */
function sentPictures(body: unknown): string[] {
  return (
    body as { messages: { content: { image_url?: { url: string } }[] }[] }
  ).messages[0]!.content.flatMap((part) =>
    part.image_url ? [part.image_url.url] : [],
  );
}

test('in the desktop the vision tool reads only what read_file may: a picture outside the workspace needs a grant, and a grant covers text only', async (t) => {
  // Grants are keyed by the native real path, as the tools resolve it
  const workspace = realpathSync.native(scratch(t, 'circle-vision-'));
  const home = realpathSync.native(scratch(t, 'circle-vision-home-'));
  const elsewhere = realpathSync.native(scratch(t, 'circle-vision-else-'));
  const passport = join(elsewhere, 'passport.png');
  const granted = join(elsewhere, 'granted.png');
  writeFileSync(passport, png(7, 5));
  writeFileSync(granted, png(6, 6));
  writeFileSync(join(workspace, 'inside.png'), png(4, 3));
  // A picture Circle saved for a prompt, in the run's data folder outside the workspace
  const saved = join(projectDataDir(workspace, home), 'images', 'saved.png');
  mkdirSync(dirname(saved), { recursive: true });
  writeFileSync(saved, png(5, 5));
  const inside = (path: string) => {
    const rel = relative(workspace, path);
    return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep);
  };
  const asked: string[] = [];
  const fileMutations: FileMutations = {
    authorize(path, _sessionId, access) {
      asked.push(`${access} ${path}`);
      if (!inside(path) && path !== granted)
        throw Error(`external file requires an explicit current grant`);
    },
    async read(path) {
      return { path, content: null, revision: null };
    },
    async apply() {
      throw Error('this test writes nothing');
    },
  };
  const server = await visionServer(t, (_request, _body, response) =>
    completion(response, { role: 'assistant', content: 'a described picture' }),
  );
  const model = Object.assign(
    new ScriptedModel([
      reply('one', [
        { id: 'read', name: 'read_file', args: { file_path: passport } },
        {
          id: 'ask',
          name: 'vision',
          args: { path: passport, question: 'what name is on it' },
        },
        { id: 'granted', name: 'vision', args: { path: granted } },
        { id: 'inside', name: 'vision', args: { path: 'inside.png' } },
        { id: 'saved', name: 'vision', args: { path: saved } },
      ]),
      reply('done', [], 'ok'),
    ]),
    { imageInput: false },
  );
  const runtime = visionRuntime(t, workspace, model, server.base, {
    home,
    fileMutations,
  });
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('look');
  const results = toolResults(model.requests[1]!.messages);
  assert.match(results.read!, /explicit current grant/);
  assert.match(results.ask!, /explicit current grant/);
  assert.match(
    results.granted!,
    /native external file grants support existing text files only/,
  );
  assert.match(results.inside!, /a described picture/);
  assert.match(results.saved!, /a described picture/);
  // the vision tool asked the desktop for the picture it was refused
  assert.ok(asked.includes(`read ${passport}`));
  // only the two pictures it may read went to the side vision model
  assert.equal(server.hits.count, 2);
  const pictures = server.bodies.flatMap(sentPictures);
  for (const outside of [passport, granted])
    assert.equal(
      pictures.includes(
        `data:image/png;base64,${readFileSync(outside).toString('base64')}`,
      ),
      false,
    );
});

test('read_file gives a model that cannot read images a PDF as it is, never to the side vision model', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
  writeFileSync(join(root, 'spec.pdf'), '%PDF-1.4\n% a small spec\n%%EOF\n');
  const server = await visionServer(t, (_request, _body, response) =>
    completion(response, { role: 'assistant', content: 'unused' }),
  );
  const model = Object.assign(
    new ScriptedModel([
      reply('one', [
        { id: 'read', name: 'read_file', args: { file_path: 'spec.pdf' } },
      ]),
      reply('done', [], 'read'),
    ]),
    { imageInput: false },
  );
  const runtime = visionRuntime(t, root, model, server.base);
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('read the spec');
  const result = model.requests[1]!.messages.at(-1)!;
  assert.match(
    result.content,
    /Read spec\.pdf \(application\/pdf\) as an attachment/,
  );
  assert.deepEqual(
    result.attachments?.map((item) => [item.kind, item.filename]),
    [['document', 'spec.pdf']],
  );
  assert.equal(server.hits.count, 0);
});

test('a model that cannot read images is offered screenshot, browser_screenshot and vision when a side vision model is set', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
  const server = await visionServer(t, (_request, _body, response) =>
    completion(response, { role: 'assistant', content: 'unused' }),
  );
  const port: BrowserPort = {
    async request() {
      return { text: 'unused' };
    },
  };
  const model = Object.assign(new ScriptedModel([reply('done', [], 'ok')]), {
    imageInput: false,
  });
  let runtime!: AgentRuntime;
  runtime = visionRuntime(t, root, model, server.base, {
    extraTools: browserTools(
      port,
      runtimeBrowserOptions(() => runtime),
    ),
    screenshot: {
      platform: 'darwin',
      env: {},
      run: async () => ({ code: 0, stdout: Buffer.alloc(0) }),
    },
  });
  await runtime.harness.run('look at the screen and the page');
  const offered = model.requests[0]!.tools.map((tool) => tool.name);
  for (const name of ['screenshot', 'browser_screenshot', 'vision'])
    assert.ok(offered.includes(name), `${name} is offered`);
});

test('with a side vision model, the screenshot tool takes the picture for a model that cannot read it, saves it and describes it', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
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

/**
 * A main-model endpoint for a model no catalog lists: a request that carries a picture is
 * refused with `message`, one without a picture gets an answer.
 */
async function pictureRefusingEndpoint(
  t: { after(fn: () => void | Promise<void>): void },
  message: string,
): Promise<{ base: string; withImage: boolean[] }> {
  const withImage: boolean[] = [];
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const body = text ? JSON.parse(text) : {};
    const hasImage = (body.messages as { content?: unknown }[]).some(
      (item) =>
        Array.isArray(item.content) &&
        item.content.some(
          (part) => (part as { type?: string }).type === 'image_url',
        ),
    );
    withImage.push(hasImage);
    if (hasImage) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ error: { message, type: 'invalid_request_error' } }),
      );
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }) +
        '\n\n',
    );
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    instance.closeAllConnections();
    return new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const address = instance.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}/v1`, withImage };
}

// Errors about pictures that say nothing of the model reading them: a vision model that
// meets one keeps reading images, and the person sees the endpoint's own words
for (const [kind, message] of [
  [
    "vLLM's multimodal context length",
    'The decoder prompt (length 9000) is longer than the maximum model length of 8192. Make sure that `max_model_len` is no smaller than the number of text tokens plus multimodal tokens. For image inputs, the number of image tokens depends on the number of images, and possibly their aspect ratios as well.',
  ],
  ['a limit on pictures', 'At most 1 image(s) may be provided in one prompt.'],
  [
    'a picture too large',
    'messages.0.content.1.image.source.base64: image exceeds 5 MB maximum: 5452595 bytes > 5242880 bytes',
  ],
  [
    'a tool schema',
    "Invalid schema for function 'generate_image': In context=(), 'additionalProperties' is required to be supplied and to be false.",
  ],
] as [string, string][])
  test(`a 400 about ${kind} keeps its own error and leaves image input on`, async (t) => {
    const root = realpathSync.native(scratch(t, 'circle-vision-'));
    writeFileSync(join(root, 'shot.png'), png());
    const endpoint = await pictureRefusingEndpoint(t, message);
    const settings = defaultSettings();
    settings.auth.base_url = endpoint.base;
    settings.auth.protocol = 'openai';
    const catalog = new ModelCatalog(root, { data: slimCatalog({}), env: {} });
    saveCredentials({ api_key: 'main-key' }, root);
    const model = new GatewayModel(settings, root, 'served-vlm', {}, catalog);
    const runtime = new AgentRuntime({
      workspace: root,
      home: root,
      settings,
      model,
      headless: true,
    });
    cleanup(t, () => runtime.close());
    for (const prompt of ['what is in @shot.png', 'and now @shot.png'])
      await assert.rejects(
        runtime.harness.run(prompt),
        (error: Error) =>
          error.message.includes(message) &&
          !/does not read images/.test(error.message),
      );
    assert.equal(model.imageInput, undefined);
    // both turns sent the picture: nothing marked the model text-only
    assert.equal(endpoint.withImage.filter(Boolean).length, 2);
  });

test('only an endpoint that says the model takes no pictures marks it text-only', () => {
  for (const said of [
    'image content parts are not supported',
    'Invalid content type. image_url is only supported by certain models.',
    'This model does not support multi-modal inputs',
    'At most 0 image(s) may be provided in one request.',
    'Failed to deserialize the JSON body into the target type: messages[0]: unknown variant `image_url`, expected `text` at line 1 column 312',
    'image input is not supported - hint: if this is unexpected, you may need to provide the mmproj',
    'this model is missing data required for image input',
    'Model does not support images. Please use a model that does.',
    'vision is not supported for this model',
    'served-vlm is not a multimodal model',
    'This model does not support the image_url content type',
    'Unsupported content part type: image_url',
    "messages.0.content.1.type: Input tag 'image' found using 'type' does not match any of the expected tags: 'text', 'tool_use', 'tool_result'",
  ])
    assert.equal(endpointRefusesImages(said), true, said);
  for (const said of [
    'invalid tool schema',
    'At most 1 image(s) may be provided in one prompt.',
    'image exceeds 5 MB maximum: 5452595 bytes > 5242880 bytes',
    "Invalid schema for function 'generate_image': In context=(), 'additionalProperties' is required to be supplied and to be false.",
    'The decoder prompt (length 9000) is longer than the maximum model length of 8192. Make sure that `max_model_len` is no smaller than the number of text tokens plus multimodal tokens. For image inputs, the number of image tokens depends on the number of images, and possibly their aspect ratios as well.',
    'Unable to process image: invalid base64 data',
    'The image could not be decoded',
    'Image URLs are only allowed for messages with role user',
    'image/bmp is not supported',
    'Image format webp is not supported',
    'This model does not support images larger than 8000 pixels',
    'Image URLs are not allowed in system messages',
    'Invalid type: image/tiff',
  ])
    assert.equal(endpointRefusesImages(said), false, said);
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

test('a saved picture is whole: a cut-off file under its name is replaced, a copy another save wrote meanwhile is kept, and no temporary file stays', (t) => {
  const root = scratch(t, 'circle-vision-');
  const picture = makeAttachment(png(9, 7), 'image/png', 'a.png');
  const bytes = Buffer.from(picture.data, 'base64');
  const target = join(root, 'images', picture.sha256.slice(0, 16) + '.png');
  mkdirSync(dirname(target), { recursive: true });
  // what a crash in the middle of a write left behind
  writeFileSync(target, bytes.subarray(0, 10));
  assert.equal(saveMediaAttachment(root, picture), target);
  assert.deepEqual(readFileSync(target), bytes);
  // another Circle saves the same picture while this save is under way
  const other = makeAttachment(png(8, 8), 'image/png', 'b.png');
  const otherTarget = join(root, 'images', other.sha256.slice(0, 16) + '.png');
  let raced = false;
  const racing = {
    ...other,
    get data() {
      if (!raced) {
        raced = true;
        writeFileSync(otherTarget, Buffer.from(other.data, 'base64'));
      }
      return other.data;
    },
  };
  assert.equal(saveMediaAttachment(root, racing), otherTarget);
  assert.deepEqual(
    readFileSync(otherTarget),
    Buffer.from(other.data, 'base64'),
  );
  assert.deepEqual(
    readdirSync(join(root, 'images')).sort(),
    [
      other.sha256.slice(0, 16) + '.png',
      picture.sha256.slice(0, 16) + '.png',
    ].sort(),
  );
});

test('a picture from the history that was never saved is left out for a model that cannot read it without a path it does not have', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
  const bodies: Record<string, unknown>[] = [];
  const instance = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    bodies.push(JSON.parse(text));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      'data: ' +
        JSON.stringify({
          id: 'chatcmpl-1',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: 'ok' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }) +
        '\n\n',
    );
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    instance.closeAllConnections();
    return new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const settings = defaultSettings();
  settings.auth.base_url = `http://127.0.0.1:${(instance.address() as { port: number }).port}/v1`;
  settings.auth.protocol = 'openai';
  settings.models = { 'text-model': { images: false } };
  saveCredentials({ api_key: 'main-key' }, root);
  const model = new GatewayModel(
    settings,
    root,
    'text-model',
    {},
    new ModelCatalog(root, { data: slimCatalog({}), env: {} }),
  );
  assert.equal(model.imageInput, false);
  // pasted in the desktop while a model that reads images was in use: a name, no file
  await model.complete({
    system: 'system',
    messages: [
      {
        id: 'u1',
        role: 'user',
        content: 'what is this',
        attachments: [makeAttachment(png(), 'image/png', 'pasted.png')],
      },
    ],
    tools: [],
    signal: new AbortController().signal,
    token: () => {},
  });
  const user = (
    bodies[0]!.messages as { role: string; content: unknown }[]
  ).find((message) => message.role === 'user')!;
  assert.equal(typeof user.content, 'string');
  assert.match(
    String(user.content),
    /\[pasted\.png left out: the model in use does not read images\.\]/,
  );
  assert.doesNotMatch(String(user.content), /path/);
});

/**
 * A side vision endpoint that takes a request and never answers it; with `headers` it
 * sends the status line and the start of a body first. `closed` settles when the
 * client gives the request up.
 */
async function hangingVisionServer(
  t: { after(fn: () => void | Promise<void>): void },
  mode: 'silent' | 'headers',
): Promise<{ base: string; received: Promise<void>; closed: Promise<void> }> {
  let arrived!: () => void;
  const received = new Promise<void>((resolve) => (arrived = resolve));
  let ended!: () => void;
  const closed = new Promise<void>((resolve) => (ended = resolve));
  const instance = createServer((request, response) => {
    request.resume();
    response.on('close', () => ended());
    if (mode === 'headers') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"choices":');
    }
    arrived();
  });
  await new Promise<void>((resolve) =>
    instance.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => {
    instance.closeAllConnections();
    return new Promise<void>((resolve) => instance.close(() => resolve()));
  });
  const address = instance.address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}/v1`, received, closed };
}

/** fetch that hands the answer over only once the call's own signal has stopped it. */
const answerAfterStop: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const signal = init!.signal!;
  if (!signal.aborted)
    await new Promise((resolve) =>
      signal.addEventListener('abort', resolve, { once: true }),
    );
  return response;
};

test('a stop while the side vision model works ends its call at once, before its answer starts and while it arrives', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
  const picture = join(root, 'a.png');
  writeFileSync(picture, png());
  for (const mode of ['silent', 'headers'] as const) {
    const server = await hangingVisionServer(t, mode);
    const controller = new AbortController();
    const describing = new VisionService({
      timeoutMs: 600_000,
      ...(mode === 'headers' ? { request: answerAfterStop } : {}),
    }).describe(connection(server.base), [picture], '', controller.signal);
    await server.received;
    controller.abort(new Error('Interrupted'));
    await assert.rejects(describing, /^Error: Interrupted$/);
    // the endpoint sees the request given up
    await server.closed;
  }
});

test('a side vision model that does not answer in time fails with how long it waited, before its answer starts and while it arrives', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
  const picture = join(root, 'a.png');
  writeFileSync(picture, png());
  for (const mode of ['silent', 'headers'] as const) {
    const server = await hangingVisionServer(t, mode);
    await assert.rejects(
      new VisionService({
        timeoutMs: 500,
        ...(mode === 'headers' ? { request: answerAfterStop } : {}),
      }).describe(
        connection(server.base),
        [picture],
        '',
        new AbortController().signal,
      ),
      new RegExp(
        `^Error: vision model vlm-1 on 127\\.0\\.0\\.1:\\d+ did not answer within 0\\.5 s \\(CIRCLE_VISION_TIMEOUT_MS\\)$`,
      ),
    );
    await server.closed;
  }
});

test('CIRCLE_VISION_TIMEOUT_MS sets the side vision deadline in whole milliseconds, at least one second', () => {
  assert.equal(timeoutFromEnv({}), 60000);
  assert.equal(timeoutFromEnv({ CIRCLE_VISION_TIMEOUT_MS: '1500' }), 1500);
  assert.equal(timeoutFromEnv({ CIRCLE_VISION_TIMEOUT_MS: '2500.4' }), 2500);
  assert.equal(timeoutFromEnv({ CIRCLE_VISION_TIMEOUT_MS: '999' }), 60000);
  assert.equal(timeoutFromEnv({ CIRCLE_VISION_TIMEOUT_MS: 'soon' }), 60000);
});

test('esc while read_file waits on the side vision model stops the turn: the call is given up and the model is not asked again', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
  writeFileSync(join(root, 'shot.png'), png());
  const server = await hangingVisionServer(t, 'silent');
  const model = Object.assign(
    new ScriptedModel([
      reply('one', [
        { id: 'read', name: 'read_file', args: { file_path: 'shot.png' } },
      ]),
      reply('done', [], 'never asked'),
    ]),
    { imageInput: false },
  );
  const runtime = visionRuntime(t, root, model, server.base);
  runtime.policy.setYolo(runtime.session.id, true);
  const running = runtime.harness.run('look');
  const interrupted = assert.rejects(running, /Interrupted/);
  await server.received;
  await runtime.cancel();
  await interrupted;
  await server.closed;
  assert.equal(model.requests.length, 1);
});

test('the screenshot card says who sees the picture: the side vision model for a model that cannot read images, the model otherwise', async (t) => {
  const root = realpathSync.native(scratch(t, 'circle-vision-'));
  const server = await visionServer(t, (_request, _body, response) =>
    completion(response, { role: 'assistant', content: 'unused' }),
  );
  for (const [imageInput, args, reason] of [
    [false, {}, 'shows the side vision model the whole screen'],
    [
      false,
      { app: 'Safari' },
      'shows the side vision model the window of Safari',
    ],
    [undefined, {}, 'shows the model the whole screen'],
  ] as const) {
    const calls: string[][] = [];
    const model = Object.assign(
      new ScriptedModel([
        reply('shoot', [{ id: 'shot', name: 'screenshot', args }]),
        reply('done', [], 'ok'),
      ]),
      { imageInput },
    );
    const runtime = visionRuntime(t, root, model, server.base, {
      screenshot: {
        platform: 'darwin',
        env: {},
        run: async (command, rest) => {
          calls.push([command, ...rest]);
          return { code: 0, stdout: Buffer.alloc(0) };
        },
      },
    });
    const waiting: Record<string, unknown>[] = [];
    runtime.bus.subscribe((event: CircleEvent) => {
      if (event.kind === 'tool_waiting') waiting.push(event.payload);
    });
    // headless, with no one to answer the card: it is shown, and nothing is taken
    await runtime.harness.run('look');
    assert.equal(waiting.length, 1);
    assert.equal(waiting[0]!.reason, reason);
    // the terminal and the desktop word their cards from the call as it waits
    assert.equal(
      runtime.policy.review(
        'screenshot',
        waiting[0]!.args as Record<string, unknown>,
      ).reason,
      reason,
    );
    assert.equal(calls.length, 0);
  }
});

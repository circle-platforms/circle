import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import {
  fileBlocks,
  helpText,
  parseCli,
  pipedText,
  UsageError,
} from '../src/cli.js';
import {
  defaultSettings,
  loadCredentials,
  loadSettings,
  saveCredentials,
  isFolderTrusted,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { CheckpointStore } from '../src/checkpoint_store.js';
import { TITLE_MAX_TOKENS } from '../src/session_title.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { SessionApp } from '../src/tui/session_app.js';
import {
  runLineInit,
  runLineTrust,
  terminalPrompter,
} from '../src/line_setup.js';
import { cleanup, scratch } from './helpers.js';

type Reply =
  | { content: string }
  | { call: { name: string; args: Record<string, unknown> } }
  | { status: number; headers?: Record<string, string>; body: unknown };
interface Gateway {
  base: string;
  bodies: Record<string, unknown>[];
  keys: string[];
  trace: {
    request: number;
    at: number;
    phase: 'request' | 'body' | 'finish' | 'close';
    method?: string;
    path?: string;
    status?: number;
    complete?: boolean;
  }[];
}
// A local OpenAI-style endpoint: /v1/models lists `models`, each chat request takes the next
// reply (the last one repeats).
async function gateway(
  t: { after(fn: () => void | Promise<void>): void },
  replies: Reply[],
  models: string[] = ['gateway'],
): Promise<Gateway> {
  const bodies: Record<string, unknown>[] = [];
  const keys: string[] = [];
  const trace: Gateway['trace'] = [];
  let requests = 0;
  let count = 0;
  const instance = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const id = ++requests;
      trace.push({
        request: id,
        at: Date.now(),
        phase: 'request',
        method: request.method,
        path: request.url,
      });
      for (const phase of ['finish', 'close'] as const)
        response.once(phase, () =>
          trace.push({
            request: id,
            at: Date.now(),
            phase,
            status: response.statusCode,
            complete: response.writableFinished,
          }),
        );
      let text = '';
      for await (const chunk of request) text += chunk;
      trace.push({ request: id, at: Date.now(), phase: 'body' });
      keys.push(String(request.headers.authorization ?? ''));
      if (request.method === 'GET' && request.url === '/v1/models') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      bodies.push(JSON.parse(text));
      const reply = replies[Math.min(count++, replies.length - 1)]!;
      if ('status' in reply) {
        response.writeHead(reply.status, {
          'Content-Type': 'application/json',
          ...reply.headers,
        });
        response.end(JSON.stringify(reply.body));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const delta =
        'content' in reply
          ? { content: reply.content }
          : {
              tool_calls: [
                {
                  index: 0,
                  id: `call-${count}`,
                  type: 'function',
                  function: {
                    name: reply.call.name,
                    arguments: JSON.stringify(reply.call.args),
                  },
                },
              ],
            };
      response.write(
        'data: ' +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta,
                finish_reason: 'content' in reply ? 'stop' : 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 1200, completion_tokens: 34 },
          }) +
          '\n\ndata: [DONE]\n\n',
      );
      response.end();
    },
  );
  await new Promise<void>((ready) =>
    instance.listen(0, '127.0.0.1', () => ready()),
  );
  cleanup(t, async () => {
    instance.closeAllConnections();
    await new Promise<void>((done) => instance.close(() => done()));
  });
  const address = instance.address();
  assert.ok(address && typeof address === 'object');
  return { base: `http://127.0.0.1:${address.port}`, bodies, keys, trace };
}
// Only phase metadata is diagnostic; request bodies and authorization stay out of it.
const observeGateway = (endpoint: Gateway): Record<string, unknown> => ({
  gatewayRequests: endpoint.bodies.length,
  gatewayTrace: endpoint.trace.slice(-16).map((event) => ({ ...event })),
});
function setUp(
  home: string,
  base: string,
  trusted: string[],
  model = 'gateway',
): void {
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth.base_url = base + '/v1';
  settings.auth.model = model;
  for (const folder of trusted) settings = trustFolder(settings, folder);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'test-key' }, home);
}
interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  lifecycle: {
    pid?: number;
    spawnedAt: number;
    spawnAcknowledgedAt?: number;
    stdoutFirstAt?: number;
    stderrFirstAt?: number;
    stdoutBytes: number;
    stderrBytes: number;
    beforeMainAt?: number;
    stdinOpenBeforeMain?: boolean;
    stdinEndedByFixture: boolean;
    warningAt?: number;
    timedOutAt?: number;
    exited: boolean;
    code?: number | null;
    signal?: NodeJS.Signals | null;
    closedAt?: number;
  };
}
class CliFixtureDeadline extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly lifecycle: Run['lifecycle'],
    readonly output: { stdoutTail: string; stderrTail: string },
    readonly observation: Record<string, unknown>,
  ) {
    super(`CLI fixture exceeded ${timeoutMs}ms`);
  }
}
// tsx by path, so the CLI can run from another current folder.
const TSX = pathToFileURL(
  join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
).href;
const CLI = join(process.cwd(), 'src', 'cli.ts');
// A proxy or extra certificates in the developer's own shell make Circle write a network
// line to standard error; a test that needs them passes them in options.env.
const NETWORK_VARIABLES = new Set([
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CIRCLE_TRUST_CERTS',
]);
const inheritedEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !NETWORK_VARIABLES.has(name),
    ),
  );
// The real CLI in a child process. `stdin` is written and closed; null leaves it open.
function circle(
  home: string,
  args: string[],
  options: {
    cwd?: string;
    stdin?: string | null;
    env?: Record<string, string>;
    startupDelayMs?: number;
    timeoutMs?: number;
    observe?: () => Record<string, unknown>;
  } = {},
): Promise<Run> {
  return new Promise((done, reject) => {
    const spawnedAt = Date.now();
    const launch =
      options.startupDelayMs === undefined
        ? ['--import', TSX, CLI, ...args]
        : [
            '--import',
            TSX,
            '--input-type=module',
            '-e',
            `await new Promise(resolve=>setTimeout(resolve,${options.startupDelayMs}));
             const {main}=await import(${JSON.stringify(pathToFileURL(CLI).href)});
             process.stderr.write('circle fixture before main '+Date.now()+'\\n');
             process.exitCode=await main(process.argv.slice(1));`,
            '--',
            ...args,
          ];
    const child = spawn(process.execPath, launch, {
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...inheritedEnv(),
        CIRCLE_HOME: home,
        CIRCLE_NO_MODELS_REFRESH: '1',
        CIRCLE_JOB_WAIT: '0',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const lifecycle: Run['lifecycle'] = {
      pid: child.pid,
      spawnedAt,
      stdoutBytes: 0,
      stderrBytes: 0,
      stdinEndedByFixture: false,
      exited: false,
    };
    const outputTails = () => ({
      stdoutTail: stdout.slice(-4096),
      stderrTail: stderr.slice(-4096),
    });
    child.once('spawn', () => (lifecycle.spawnAcknowledgedAt = Date.now()));
    child.stdout.on('data', (data: Buffer) => {
      lifecycle.stdoutFirstAt ??= Date.now();
      lifecycle.stdoutBytes += data.length;
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      lifecycle.stderrFirstAt ??= Date.now();
      lifecycle.stderrBytes += data.length;
      stderr += data;
      const ready = stderr.match(/circle fixture before main (\d+)\n/);
      if (ready && lifecycle.beforeMainAt === undefined) {
        lifecycle.beforeMainAt = Number(ready[1]);
        lifecycle.stdinOpenBeforeMain =
          !child.stdin.writableEnded && !child.stdin.destroyed;
      }
      if (
        lifecycle.warningAt === undefined &&
        stderr.includes('nothing arrived on stdin within 3s')
      )
        lifecycle.warningAt = Date.now();
    });
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    child.once('error', (error) => (failure ??= error));
    child.once('exit', (code, signal) => {
      lifecycle.exited = true;
      lifecycle.code = code;
      lifecycle.signal = signal;
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      clearTimeout(force);
      lifecycle.closedAt = Date.now();
      if (failure instanceof CliFixtureDeadline)
        Object.assign(failure.output, outputTails());
      if (failure) reject(failure);
      else done({ code, stdout, stderr, lifecycle });
    });
    // A hung owned process fails; EOF must never make a null-stdin trial succeed.
    const timeoutMs = options.timeoutMs ?? 30_000;
    const deadline = setTimeout(() => {
      lifecycle.timedOutAt = Date.now();
      let observation: Record<string, unknown>;
      try {
        observation = options.observe?.() ?? {};
      } catch (error) {
        // Diagnostics must not prevent termination of the owned hung child.
        observation = { observationError: String(error).slice(-4096) };
      }
      failure ??= new CliFixtureDeadline(
        timeoutMs,
        lifecycle,
        outputTails(),
        observation,
      );
      child.kill();
      force = setTimeout(() => {
        if (!lifecycle.exited) child.kill('SIGKILL');
        // Release only this failed child's output handles if a descendant held them.
        child.stdout.destroy();
        child.stderr.destroy();
      }, 1000);
    }, timeoutMs);
    if (options.stdin !== null) {
      lifecycle.stdinEndedByFixture = true;
      child.stdin.end(options.stdin ?? '');
    }
  });
}
const userText = (body: Record<string, unknown>): string => {
  const messages = body.messages as { role: string; content: unknown }[];
  const last = messages.filter((message) => message.role === 'user').at(-1)!;
  return typeof last.content === 'string'
    ? last.content
    : (last.content as { type: string; text?: string }[])
        .map((part) => part.text ?? '')
        .join('');
};
const systemText = (body: Record<string, unknown>): string =>
  (body.messages as { role: string; content: unknown }[])
    .filter((message) => message.role === 'system')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content),
    )
    .join('\n');

test('@file is read from the current folder, then the workspace, and inlined after the message', async (t) => {
  const home = scratch(t);
  const here = scratch(t);
  const workspace = realpathSync(scratch(t));
  writeFileSync(join(here, 'notes.txt'), 'from the current folder\r\n');
  writeFileSync(join(workspace, 'inner.txt'), 'from the workspace\n\n');
  writeFileSync(join(here, 'blob.bin'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  const endpoint = await gateway(t, [{ content: 'ok' }]);
  const observe = () => observeGateway(endpoint);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(
    home,
    ['-p', 'review these', '@notes.txt', '@inner.txt', workspace],
    { cwd: here, observe },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'ok\n');
  assert.ok(run.lifecycle.spawnAcknowledgedAt! >= run.lifecycle.spawnedAt);
  assert.ok(run.lifecycle.stdoutFirstAt! >= run.lifecycle.spawnAcknowledgedAt!);
  assert.equal(run.lifecycle.stdoutBytes, Buffer.byteLength(run.stdout));
  assert.equal(run.lifecycle.stderrBytes, Buffer.byteLength(run.stderr));
  assert.deepEqual(
    endpoint.trace
      .filter((event) => event.request === 1)
      .map((event) => event.phase),
    ['request', 'body', 'finish', 'close'],
  );
  assert.equal(
    userText(endpoint.bodies[0]!),
    'review these\n\n<file path="notes.txt">\nfrom the current folder\n</file>\n\n<file path="inner.txt">\nfrom the workspace\n</file>',
  );
  const missing = await circle(home, ['-p', 'x', '@gone.txt', workspace], {
    cwd: here,
    observe,
  });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no such file: gone\.txt/);
  const binary = await circle(home, ['-p', 'x', '@blob.bin', workspace], {
    cwd: here,
    observe,
  });
  assert.equal(binary.code, 2);
  assert.match(binary.stderr, /blob\.bin is not a text file/);
  // The long prompt asks for a title after the turn. That call is not a user turn.
  const turns = () =>
    endpoint.bodies.filter((body) => body.max_tokens !== TITLE_MAX_TOKENS);
  assert.equal(turns().length, 1);
  assert.equal(
    endpoint.bodies.filter((body) => body.max_tokens === TITLE_MAX_TOKENS)
      .length,
    1,
  );
  // An image in the workspace goes as an attachment, which text cannot carry.
  const png = Buffer.from('89504e470d0a1a0a30303030', 'hex');
  writeFileSync(join(workspace, 'shot.png'), png);
  writeFileSync(join(here, 'far.png'), png);
  const image = await circle(home, ['-p', 'look', '@shot.png', workspace], {
    cwd: here,
    observe,
  });
  assert.equal(image.code, 0, image.stderr);
  const content = (
    turns()[1]!.messages as { role: string; content: unknown }[]
  ).at(-1)!.content as { type: string; image_url?: { url: string } }[];
  assert.equal(
    content.find((part) => part.type === 'image_url')?.image_url?.url,
    'data:image/png;base64,' + png.toString('base64'),
  );
  // One outside the workspace goes too, mentioned by its full path
  const far = await circle(home, ['-p', 'look', '@far.png', workspace], {
    cwd: here,
    observe,
  });
  assert.equal(far.code, 0, far.stderr);
  const farContent = (
    turns().at(-1)!.messages as { role: string; content: unknown }[]
  ).at(-1)!.content as {
    type: string;
    text?: string;
    image_url?: { url: string };
  }[];
  assert.equal(
    farContent.find((part) => part.type === 'image_url')?.image_url?.url,
    'data:image/png;base64,' + png.toString('base64'),
  );
  assert.ok(
    farContent
      .find((part) => part.type === 'text')
      ?.text?.includes('@' + join(realpathSync(here), 'far.png')),
  );
});

test('the full-screen interface shows @path while the model gets the file text', async (t) => {
  const home = scratch(t);
  const here = scratch(t);
  const workspace = realpathSync(scratch(t));
  writeFileSync(join(here, 'notes.txt'), 'remember this\n');
  let saved = defaultSettings();
  saved.initialized = true;
  saved.auth.base_url = 'http://127.0.0.1:9/v1';
  saved.auth.model = 'saved-model';
  saved = trustFolder(saved, workspace);
  saveSettings(saved, home);
  const app = new SessionApp(workspace, home, loadSettings(home));
  const ui = app as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  const model = new ScriptedModel([
    { message: { id: 'answer', role: 'assistant', content: 'seen' } },
  ]);
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings: app.settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  app.runtime = runtime;
  const full = 'review\n\n' + fileBlocks(['notes.txt'], workspace, here);
  await app.submit(full, full, false, 'review @notes.txt');
  const user = runtime.store
    .messages(runtime.session.id)
    .find((message) => message.role === 'user')!;
  assert.equal(user.display, 'review @notes.txt');
  assert.equal(
    user.content,
    'review\n\n<file path="notes.txt">\nremember this\n</file>',
  );
  assert.equal(model.requests[0]!.messages.at(-1)!.content, user.content);
  assert.equal(runtime.store.get(runtime.session.id)!.title, 'review');
});

test('the folder is the first word without spaces or the last word, and -p takes a folder as a flag', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'answer' }]);
  setUp(home, endpoint.base, [workspace]);
  // A message with spaces, then the folder.
  const last = await circle(home, ['what is here', workspace]);
  assert.equal(last.code, 0, last.stderr);
  const turns = () =>
    endpoint.bodies.filter((body) => body.max_tokens !== TITLE_MAX_TOKENS);
  assert.equal(userText(turns()[0]!), 'what is here');
  assert.ok(systemText(turns()[0]!).includes(realpathSync.native(workspace)));
  // -p before a folder is a flag; the prompt is piped in.
  const piped = await circle(home, ['-p', workspace], {
    stdin: 'piped prompt\n',
  });
  assert.equal(piped.code, 0, piped.stderr);
  assert.equal(userText(turns()[1]!), 'piped prompt');
  assert.ok(systemText(turns()[1]!).includes(realpathSync.native(workspace)));
  // One word without spaces is a folder, so a typo is an error, not a message.
  const typo = await circle(home, ['-p', 'question', 'no-such-folder'], {
    cwd: workspace,
  });
  assert.equal(typo.code, 2);
  assert.match(typo.stderr, /No such folder: .*no-such-folder/);
  assert.equal(turns().length, 2);
  // "what is here" is three words, so it asks for a title. "piped prompt" does not.
  assert.equal(
    endpoint.bodies.filter((body) => body.max_tokens === TITLE_MAX_TOKENS)
      .length,
    1,
  );
});

test('print mode sends each message as a turn and writes only the last answer', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [
    { content: 'first answer' },
    { content: 'second answer' },
  ]);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(home, [
    '-p',
    'first question',
    workspace,
    'second question',
  ]);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'second answer\n');
  assert.equal(userText(endpoint.bodies[0]!), 'first question');
  assert.equal(userText(endpoint.bodies[1]!), 'second question');
});

test('--list-models keeps the models that contain every word and marks the current one', async (t) => {
  const home = scratch(t);
  const endpoint = await gateway(
    t,
    [{ content: 'unused' }],
    ['alpha-mini', 'alpha-max', 'beta-max'],
  );
  setUp(home, endpoint.base, [], 'alpha-max');
  const all = await circle(home, ['--list-models']);
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.stdout, 'alpha-mini\nalpha-max  (current)\nbeta-max\n');
  const both = await circle(home, ['--list-models', 'MAX alpha']);
  assert.equal(both.code, 0, both.stderr);
  assert.equal(both.stdout, 'alpha-max  (current)\n');
  const none = await circle(home, ['--list-models', 'gamma']);
  assert.equal(none.code, 1);
  assert.equal(none.stdout, '');
  assert.match(none.stderr, /no model matches 'gamma'/);
  const fresh = scratch(t);
  const unset = await circle(fresh, ['--list-models']);
  assert.equal(unset.code, 2);
  assert.match(unset.stderr, /not set up yet/);
});

test('options that cannot go together stop with exit code 2 before any request', async (t) => {
  for (const [args, message] of [
    [['--line', '--mode', 'json'], /--mode json and --line cannot go together/],
    [['--line', '--mode', 'rpc'], /--mode rpc and --line cannot go together/],
    [['-r', '--mode', 'rpc'], /-r opens a list/],
    [['-r', '--mode', 'json', 'hello there'], /-r opens a list/],
    [['--mode', 'rpc', 'hello there'], /--mode rpc takes its prompts/],
    [['--mode', 'rpc', '@notes.txt'], /--mode rpc takes its prompts/],
    [['--line', 'hello there'], /--line reads its messages/],
    [['--fork', 'a', '-c'], /--fork starts a new conversation/],
    [['--session-id', '-bad-'], /--session-id takes letters/],
  ] as const) {
    assert.throws(
      () => parseCli([...args]),
      (error) => error instanceof UsageError && message.test(error.message),
      args.join(' '),
    );
  }
  const home = scratch(t);
  const run = await circle(home, ['--line', '--mode', 'json']);
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--mode json and --line cannot go together/);
});

test('parsing: -n collapses spaces and cuts to 80, @files are kept apart, a folder may come last', (t) => {
  const workspace = realpathSync(scratch(t));
  const options = parseCli([
    '-n',
    '  a   long\ttitle ' + 'x'.repeat(100),
    'review this',
    '@src/app.ts',
    workspace,
  ]);
  assert.equal(
    options.run.session_name,
    ('a long title ' + 'x'.repeat(100)).slice(0, 80),
  );
  assert.equal(options.workspace, realpathSync.native(workspace));
  assert.deepEqual(options.prompts, ['review this']);
  assert.deepEqual(options.files, ['src/app.ts']);
  // -p as a flag: the first word after the options is the prompt, the second the folder.
  const flag = parseCli(['-p', '-c', 'what changed?', workspace]);
  assert.deepEqual(flag.prompts, ['what changed?']);
  assert.equal(flag.workspace, realpathSync.native(workspace));
  // A single word is the folder even when it does not exist.
  const typo = parseCli(['--line', 'hello'], workspace);
  assert.equal(typo.workspace, join(workspace, 'hello'));
  assert.equal(existsSync(typo.workspace), false);
  assert.deepEqual(typo.prompts, []);
});

test('CLI preserves a missing workspace lexical path while existing alias input resolves to its actual native directory', (t) => {
  const base = scratch(t),
    workspace = join(base, 'workspace'),
    alias = join(base, 'workspace-alias');
  mkdirSync(workspace);
  symlinkSync(
    workspace,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const missing = parseCli(['--line', 'hello'], alias);
  assert.equal(missing.workspace, join(alias, 'hello'));
  assert.equal(existsSync(missing.workspace), false);
  assert.deepEqual(missing.prompts, []);
  assert.equal(
    parseCli(['--line', alias]).workspace,
    realpathSync.native(workspace),
  );
});

test("--task works in a folder of Circle's own and leaves a plain start alone", async (t) => {
  const home = scratch(t);
  // The CLI names the workspace by its native canonical spelling, which expands a
  // Windows runner's 8.3 short TEMP path.
  const workspace = realpathSync.native(scratch(t));
  // Without the flag, the folder the process sits in is still the workspace.
  assert.equal(parseCli([], workspace).task, undefined);
  assert.equal(parseCli([], workspace).workspace, workspace);
  const named = parseCli(['--task', 'slb-check', 'what is up?'], workspace);
  assert.equal(named.task, 'slb-check');
  assert.deepEqual(named.prompts, ['what is up?']);
  assert.equal(parseCli(['--task'], workspace).task, '');
  const endpoint = await gateway(t, [{ content: 'done' }]);
  setUp(home, endpoint.base, []);
  // Nothing is trusted here, so only a workspace of Circle's own can answer.
  const run = await circle(home, ['--task', 'slb-check', '-p', 'hello'], {
    cwd: workspace,
  });
  assert.equal(run.code, 0, run.stderr);
  assert.ok(
    existsSync(join(realpathSync(home), 'tasks', 'slb-check')),
    'the task folder was made under the task root',
  );
  const trusted = loadSettings(home).trusted_folders;
  assert.ok(
    trusted.some((folder) => folder.endsWith(join('tasks', 'slb-check'))),
    'Circle trusts its own task folder: ' + JSON.stringify(trusted),
  );
  const plain = await circle(home, ['-p', 'hello'], { cwd: workspace });
  assert.notEqual(plain.code, 0);
  assert.match(plain.stderr, /not trusted/);
  // A name is a name, not a path: nothing escapes the task root.
  const escaped = await circle(
    home,
    ['--task', '../../outside', '-p', 'hello'],
    { cwd: workspace },
  );
  assert.equal(escaped.code, 0, escaped.stderr);
  const made = readdirSync(join(realpathSync(home), 'tasks'));
  assert.equal(made.length, 2, JSON.stringify(made));
  assert.ok(made.includes('slb-check'));
  assert.ok(
    made.every((name) => !name.includes('..')),
    'a task name never climbs out of the task root',
  );
  assert.ok(
    !existsSync(join(realpathSync(home), 'outside')),
    'the task stayed under the task root',
  );
});
test('-n names the saved conversation with its spaces collapsed', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'ok' }]);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(home, [
    '--mode',
    'json',
    '-n',
    '  my   release\n notes  ',
    'write them',
    workspace,
  ]);
  assert.equal(run.code, 0, run.stderr);
  const session = JSON.parse(run.stdout.split('\n')[0]!) as { id: string };
  const store = new CheckpointStore(home);
  try {
    assert.equal(store.get(session.id)!.title, 'my release notes');
  } finally {
    store.close();
  }
});

test('--verbose shows tool calls, calls not run, retries and tokens in print and line mode', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  writeFileSync(join(workspace, 'notes.txt'), 'hello\n');
  const replies: Reply[] = [
    {
      status: 503,
      headers: { 'retry-after-ms': '100' },
      body: { error: { message: 'busy' } },
    },
    { call: { name: 'read_file', args: { file_path: 'notes.txt' } } },
    { call: { name: 'execute', args: { command: 'touch made.txt' } } },
    { content: 'done' },
  ];
  const endpoint = await gateway(t, replies);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(home, ['-p', 'look around', workspace, '--verbose']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'done\n');
  const lines = run.stderr.split('\n');
  assert.ok(lines.includes('  … server error, retry 1/6 in 0.1s'), run.stderr);
  assert.ok(lines.includes('● Read(notes.txt)'), run.stderr);
  assert.ok(lines.includes('● Bash(touch made.txt)'), run.stderr);
  assert.ok(
    lines.includes('  ⎿ Bash(touch made.txt) not run · needs --yolo'),
    run.stderr,
  );
  assert.ok(
    lines.includes(
      '↑ 3.6k · ↓ 102 · 1 call not run (use --yolo to allow commands and edits)',
    ),
    run.stderr,
  );
  // Without --verbose only the count of calls not run is written.
  const endpoint2 = await gateway(t, replies.slice(2));
  setUp(home, endpoint2.base, [workspace]);
  const quiet = await circle(home, ['-p', 'look around', workspace]);
  assert.equal(quiet.code, 0, quiet.stderr);
  assert.equal(
    quiet.stderr,
    '↑ 2.4k · ↓ 68 · 1 call not run (use --yolo to allow commands and edits)\n',
  );
  // Line mode takes --verbose too.
  const endpoint3 = await gateway(t, replies.slice(1));
  setUp(home, endpoint3.base, [workspace]);
  const line = await circle(home, ['--line', '--verbose', workspace], {
    stdin: 'look around\n',
  });
  assert.equal(line.code, 0, line.stderr);
  assert.equal(line.stdout, 'done\n');
  assert.match(line.stderr, /^● Read\(notes\.txt\)$/m);
  assert.match(line.stderr, /^ {2}⎿ Bash\(touch made\.txt\) not run/m);
  assert.match(line.stderr, /^↑ 3\.6k · ↓ 102 · 1 call not run/m);
});

test('print mode runs the commands the settings allow, without --yolo', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  // `mkdir` asks like `touch` did and means the same in cmd.exe and sh.
  const replies: Reply[] = [
    { call: { name: 'execute', args: { command: 'mkdir made' } } },
    { call: { name: 'execute', args: { command: 'rm -rf dist' } } },
    { content: 'done' },
  ];
  const endpoint = await gateway(t, replies);
  setUp(home, endpoint.base, [workspace]);
  const settings = loadSettings(home);
  settings.allowed_commands = ['mkdir *'];
  saveSettings(settings, home);
  const run = await circle(home, ['-p', 'work', workspace, '--verbose']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(run.stdout, 'done\n');
  // the covered command really ran
  assert.equal(statSync(join(workspace, 'made')).isDirectory(), true);
  // one no pattern covers still does not run, and says so
  assert.match(
    run.stderr,
    /^ {2}⎿ Bash\(rm -rf dist\) not run · always asks$/m,
    run.stderr,
  );
});

test('stdin: without a prompt the read waits for the end; with one it waits three seconds', async (t) => {
  const { mock } = await import('node:test');
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const input = new PassThrough();
  const warnings: string[] = [];
  let read: string | undefined;
  void pipedText(undefined, input, (text) => warnings.push(text)).then(
    (text) => (read = text),
  );
  mock.timers.tick(10 * 60 * 1000);
  await new Promise((done) => setImmediate(done));
  assert.equal(read, undefined);
  input.end('late input');
  await new Promise((done) => setImmediate(done));
  assert.equal(read, 'late input');
  const open = new PassThrough();
  let waited: string | undefined;
  void pipedText(3000, open, (text) => warnings.push(text)).then(
    (text) => (waited = text),
  );
  mock.timers.tick(3000);
  await new Promise((done) => setImmediate(done));
  assert.equal(waited, '');
  assert.deepEqual(warnings, [
    'circle: nothing arrived on stdin within 3s; going on without it (use </dev/null to skip the wait)\n',
  ]);
});

test('a prompt goes on without stdin that stays open, and the folder must be trusted without a terminal', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const untrusted = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'ok' }]);
  setUp(home, endpoint.base, [workspace]);
  const open = await circle(home, ['-p', 'hello', workspace], { stdin: null });
  assert.equal(open.code, 0, open.stderr);
  assert.match(open.stderr, /nothing arrived on stdin within 3s/);
  assert.equal(userText(endpoint.bodies[0]!), 'hello');
  const refused = await circle(home, ['-p', 'hello', untrusted]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /This folder is not trusted yet/);
  const fresh = scratch(t);
  const unset = await circle(fresh, ['-p', 'hello', workspace]);
  assert.equal(unset.code, 2);
  assert.match(unset.stderr, /Circle is not set up yet/);
  assert.equal(endpoint.bodies.length, 1);
});

test('a trusted parent covers a subfolder, and --trust remembers a folder for a later print run', async (t) => {
  const home = scratch(t);
  const parent = realpathSync(scratch(t));
  const child = join(parent, 'nested');
  mkdirSync(child);
  const beside = parent + '-other';
  mkdirSync(beside);
  assert.equal(
    isFolderTrusted(trustFolder(defaultSettings(), parent), child),
    true,
  );
  assert.equal(
    isFolderTrusted(trustFolder(defaultSettings(), parent), beside),
    false,
  );
  assert.equal(
    isFolderTrusted(trustFolder(defaultSettings(), child), parent),
    false,
  );
  assert.equal(parseCli(['--trust']).trust, true);
  const endpoint = await gateway(t, [
    { content: 'covered' },
    { content: 'remembered' },
    { content: 'later' },
  ]);
  setUp(home, endpoint.base, [parent]);
  const covered = await circle(home, ['-p', 'hello', child]);
  assert.equal(covered.code, 0, covered.stderr);
  const outside = await circle(home, ['-p', 'hello', beside]);
  assert.equal(outside.code, 2);
  assert.match(outside.stderr, /This folder is not trusted yet/);
  assert.match(outside.stderr, /--trust/);
  // Workspaces are saved in the native spelling, which on Windows is the long path.
  const fresh = realpathSync.native(scratch(t));
  const remembered = await circle(home, ['-p', '--trust', 'hello', fresh]);
  assert.equal(remembered.code, 0, remembered.stderr);
  assert.ok(loadSettings(home).trusted_folders.includes(fresh));
  const later = await circle(home, ['-p', 'hello', fresh]);
  assert.equal(later.code, 0, later.stderr);
});

test('print mode leaves a project hooks file nobody approved off, says so once, and --approve-hooks runs that version', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync.native(scratch(t));
  mkdirSync(join(workspace, '.circle'));
  const script = join(workspace, 'hello.mjs');
  writeFileSync(script, "process.stdout.write('hook says hi');\n");
  const file = join(workspace, '.circle', 'hooks.json');
  writeFileSync(
    file,
    JSON.stringify({
      hooks: {
        session_start: [
          {
            name: 'greet',
            command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
          },
        ],
      },
    }),
  );
  const endpoint = await gateway(t, [{ content: 'ok' }]);
  setUp(home, endpoint.base, [workspace]);
  const off = await circle(home, ['-p', 'hello', workspace]);
  assert.equal(off.code, 0, off.stderr);
  const said = off.stderr.split('\n').filter((line) => line.includes('hooks'));
  assert.equal(said.length, 1, off.stderr);
  assert.match(said[0]!, /were not run/);
  assert.ok(said[0]!.includes(file), said[0]);
  assert.match(said[0]!, /--approve-hooks/);
  assert.doesNotMatch(systemText(endpoint.bodies[0]!), /hook says hi/);
  assert.equal(existsSync(join(home, 'hook-trust.json')), false);
  const approved = await circle(home, [
    '-p',
    '--approve-hooks',
    'hello',
    workspace,
  ]);
  assert.equal(approved.code, 0, approved.stderr);
  assert.match(approved.stderr, /approved the hooks in /);
  assert.match(approved.stderr, /greet · session_start · /);
  assert.match(systemText(endpoint.bodies[1]!), /hook says hi/);
  // The same bytes run later without the flag, and nothing is said.
  const later = await circle(home, ['-p', 'hello', workspace]);
  assert.equal(later.code, 0, later.stderr);
  assert.doesNotMatch(later.stderr, /hooks/);
  assert.match(systemText(endpoint.bodies[2]!), /hook says hi/);
});

test('an open stdin survives a slow real CLI startup, waits three seconds and reaches the local gateway', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'slow startup answered' }]);
  setUp(home, endpoint.base, [workspace]);
  const run = await circle(home, ['-p', 'slow startup prompt', workspace], {
    stdin: null,
    startupDelayMs: 10_001,
    env: { CIRCLE_NO_UPDATE_CHECK: '1' },
    observe: () => observeGateway(endpoint),
  });
  t.diagnostic(
    JSON.stringify({
      cliFixture: run.lifecycle,
      gatewayRequests: endpoint.bodies.length,
    }),
  );
  assert.equal(run.code, 0, run.stderr);
  assert.ok(run.lifecycle.beforeMainAt! - run.lifecycle.spawnedAt > 10_000);
  assert.equal(run.lifecycle.stdinOpenBeforeMain, true);
  assert.equal(run.lifecycle.stdinEndedByFixture, false);
  assert.match(run.stderr, /nothing arrived on stdin within 3s/);
  assert.ok(run.lifecycle.warningAt! - run.lifecycle.beforeMainAt! >= 3000);
  const turns = endpoint.bodies.filter(
    (body) => body.max_tokens !== TITLE_MAX_TOKENS,
  );
  assert.equal(turns.length, 1);
  assert.equal(userText(turns[0]!), 'slow startup prompt');
  assert.equal(run.stdout.trim(), 'slow startup answered');
  assert.equal(run.lifecycle.exited, true);
});

test('the CLI fixture deadline rejects after its owned real child exits and sends no substitute EOF or gateway request', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const endpoint = await gateway(t, [{ content: 'must not be requested' }]);
  setUp(home, endpoint.base, [workspace]);
  await assert.rejects(
    circle(home, ['-p', 'must not reach the model', workspace], {
      stdin: null,
      startupDelayMs: 10_001,
      timeoutMs: 100,
      env: { CIRCLE_NO_UPDATE_CHECK: '1' },
      observe: () => observeGateway(endpoint),
    }),
    (error) => {
      assert.ok(error instanceof CliFixtureDeadline);
      assert.equal(error.timeoutMs, 100);
      assert.ok(error.lifecycle.pid! > 0);
      assert.ok(
        error.lifecycle.spawnAcknowledgedAt! >= error.lifecycle.spawnedAt,
      );
      assert.ok(error.lifecycle.timedOutAt! - error.lifecycle.spawnedAt >= 100);
      assert.equal(error.lifecycle.stdinEndedByFixture, false);
      assert.equal(error.lifecycle.exited, true);
      assert.equal(error.lifecycle.code, null);
      assert.ok(error.lifecycle.signal);
      assert.ok(error.lifecycle.closedAt! >= error.lifecycle.timedOutAt!);
      assert.deepEqual(error.observation, {
        gatewayRequests: 0,
        gatewayTrace: [],
      });
      assert.ok(error.output.stdoutTail.length <= 4096);
      assert.ok(error.output.stderrTail.length <= 4096);
      return true;
    },
  );
  assert.equal(endpoint.bodies.length, 0);
});

test('a failed CLI deadline observer still terminates and waits for its owned child', async (t) => {
  await assert.rejects(
    circle(scratch(t), ['--version'], {
      stdin: null,
      startupDelayMs: 10_001,
      timeoutMs: 100,
      observe: () => {
        throw new Error('fixture observation failed');
      },
    }),
    (error) => {
      assert.ok(error instanceof CliFixtureDeadline);
      assert.equal(error.lifecycle.stdinEndedByFixture, false);
      assert.equal(error.lifecycle.exited, true);
      assert.ok(error.lifecycle.signal);
      assert.ok(error.lifecycle.closedAt! >= error.lifecycle.timedOutAt!);
      assert.deepEqual(error.observation, {
        observationError: 'Error: fixture observation failed',
      });
      return true;
    },
  );
});

test('the trust question asked line by line saves the folder, and no keeps it untrusted', async (t) => {
  const home = scratch(t);
  const workspace = realpathSync(scratch(t));
  const settings = defaultSettings();
  saveSettings(settings, home);
  const answer = async (text: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (data) => (shown += data));
    input.end(text);
    const result = await runLineTrust(
      settings,
      workspace,
      home,
      terminalPrompter(input, output),
    );
    return { result, shown };
  };
  const no = await answer('n\n');
  assert.equal(no.result, undefined);
  assert.match(no.shown, /Trust this folder\?/);
  assert.match(no.shown, /Not trusted\./);
  assert.deepEqual(loadSettings(home).trusted_folders, []);
  const yes = await answer('yes\n');
  assert.deepEqual(yes.result?.trusted_folders, [
    realpathSync.native(workspace),
  ]);
  assert.deepEqual(loadSettings(home).trusted_folders, [
    realpathSync.native(workspace),
  ]);
});

test('line setup keeps the saved key only on the saved host; another host needs its own key', async (t) => {
  const endpoint = await gateway(t, [{ content: 'unused' }], ['line-model']);
  const answer = async (home: string, text: string) => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = '';
    output.on('data', (data) => (shown += data));
    input.end('1\n' + text); // custom endpoint
    const result = await runLineInit(home, terminalPrompter(input, output));
    return { result, shown };
  };
  // Set up before for another provider: its key is not sent to this endpoint
  const elsewhere = scratch(t);
  const other = defaultSettings();
  other.initialized = true;
  other.auth.base_url = 'https://old-provider.example/v1';
  other.auth.model = 'old-model';
  saveSettings(other, elsewhere);
  saveCredentials({ api_key: 'old-provider-key' }, elsewhere);
  const refused = await answer(elsewhere, `${endpoint.base}/v1\n\n`);
  assert.equal(refused.result, undefined);
  assert.match(refused.shown, /API KEY: /);
  assert.ok(!refused.shown.includes('enter keeps the saved one'));
  assert.match(
    refused.shown,
    /Enter the key for this endpoint: the saved one is for another\./,
  );
  assert.deepEqual(endpoint.keys, []);
  assert.equal(
    loadSettings(elsewhere).auth.base_url,
    'https://old-provider.example/v1',
  );
  // The same host: empty enters keep the URL and the key
  const same = scratch(t);
  const saved = defaultSettings();
  saved.initialized = true;
  saved.auth.base_url = `${endpoint.base}/v1`;
  saved.auth.model = 'old-model';
  saveSettings(saved, same);
  saveCredentials({ api_key: 'saved-key' }, same);
  const kept = await answer(same, '\n\n1\n');
  assert.match(kept.shown, /API KEY \(enter keeps the saved one\): /);
  assert.equal(kept.result?.auth.model, 'line-model');
  assert.deepEqual(endpoint.keys, ['Bearer saved-key']);
  assert.equal(loadSettings(same).auth.model, 'line-model');
  assert.equal(loadCredentials(same).api_key, 'saved-key');
});

// A terminal on standard input without the full-screen interface (`-p` in a terminal): the
// setup and trust questions are asked line by line. `script` gives the child a terminal.
test(
  'with a terminal but no full-screen interface, setup and trust are asked line by line',
  { skip: process.platform !== 'darwin' && 'uses the BSD script command' },
  async (t) => {
    // macOS script wants a pipe, not the socket node gives a child, on its standard input.
    const viaScript = ['-c', 'cat | exec script -q /dev/null "$@"', 'sh'];
    if (
      spawnSync('/bin/sh', [...viaScript, 'sh', '-c', 'exit 3'], { input: '' })
        .status !== 3
    )
      return t.skip('script is not available');
    const home = scratch(t);
    const workspace = realpathSync(scratch(t));
    const endpoint = await gateway(
      t,
      [{ content: 'set up and answered' }],
      ['first-model', 'second-model'],
    );
    const child = spawn(
      '/bin/sh',
      [
        ...viaScript,
        process.execPath,
        '--import',
        TSX,
        CLI,
        '-p',
        'hello',
        workspace,
      ],
      {
        env: {
          ...inheritedEnv(),
          CIRCLE_HOME: home,
          CIRCLE_NO_MODELS_REFRESH: '1',
          CIRCLE_JOB_WAIT: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const answers: [RegExp, string][] = [
      [/number: \s*$/, '1\r'], // custom endpoint
      [/API URL: \s*$/, endpoint.base + '/v1\r'],
      [/API KEY: \s*$/, 'secret-key\r'],
      [/model: \s*$/, '2\r'],
      [/trust it\? \[y\/N\]: \s*$/, 'y\r'],
    ];
    child.stdout.on('data', (data) => {
      output += data;
      const next = answers[0];
      if (next && next[0].test(output.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''))) {
        answers.shift();
        child.stdin.write(next[1]);
        if (!answers.length) child.stdin.end();
      }
    });
    const code = await new Promise<number | null>((done) => {
      const timer = setTimeout(() => child.kill(), 30000);
      child.once('close', (status) => {
        clearTimeout(timer);
        done(status);
      });
    });
    assert.equal(answers.length, 0, output);
    assert.equal(code, 0, output);
    assert.match(output, /discovered 2 models \(openai\)/);
    assert.match(output, /set up and answered/);
    assert.ok(!output.includes('secret-key'), 'the key is not echoed');
    const saved = loadSettings(home);
    assert.equal(saved.auth.base_url, endpoint.base + '/v1');
    assert.equal(saved.auth.model, 'second-model');
    assert.deepEqual(saved.trusted_folders, [workspace]);
    assert.equal(loadCredentials(home).api_key, 'secret-key');
    assert.equal(endpoint.bodies[0]!.model, 'second-model');
    assert.equal(endpoint.keys.at(-1), 'Bearer secret-key');
  },
);

test('circle uninstall is its own subcommand, not a folder', async (t) => {
  const home = scratch(t);
  const run = await circle(home, ['uninstall'], {
    env: { CIRCLE_INSTALL_PREFIX: '' },
  });
  assert.equal(run.code, 1);
  assert.match(
    run.stderr,
    /circle uninstall requires an installer-managed installation/,
  );
});

test('circle uninstall answers an unknown option with the usage exit code', async (t) => {
  const home = scratch(t);
  const run = await circle(home, ['uninstall', '--bogus'], {
    env: { CIRCLE_INSTALL_PREFIX: '' },
  });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /usage: circle uninstall \[--purge\] \[--yes\]/);
});

test('circle --help in English keeps its descriptions in one column near the options', () => {
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  process.env.LANG = 'en_US.UTF-8';
  delete process.env.LC_ALL;
  delete process.env.LANGUAGE;
  try {
    const lines = helpText(80).split('\n');
    const row = (flag: string) =>
      lines.findIndex((line) => line.startsWith(`  ${flag}`));
    // A short option and its description share a line, the description at column 24
    const print = lines[row('-p, --print [PROMPT]')]!;
    assert.equal(print.indexOf('Print the answer and exit'), 24);
    assert.equal(lines[row('--yolo')]!.indexOf('Auto mode'), 24);
    // A long option has a line of its own, and its description is under the same column
    const long = row('--append-system-prompt TEXT|FILE');
    assert.equal(lines[long], '  --append-system-prompt TEXT|FILE');
    assert.equal(lines[long + 1]!.indexOf('Append to the system prompt'), 24);
    assert.equal(lines[long + 1]!.slice(0, 24).trim(), '');
    // Every option says what it does, and nothing runs past the width
    assert.match(
      lines[row('--system-prompt TEXT|FILE') + 1]!,
      /Replace the system prompt/,
    );
    for (const line of lines) assert.ok(line.length <= 80, line);
  } finally {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

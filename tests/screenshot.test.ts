import assert from 'node:assert/strict';
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { runOutput, type OutputRunner } from '../src/ink/clipboard.js';
import { fitPng, MAX_EDGE, MAX_PIXELS, pngSize } from '../src/image_fit.js';
import { readMedia } from '../src/media.js';
import { nextMediaState } from '../src/context_middleware.js';
import { nextPruneState } from '../src/middleware/tool_result_prune.js';
import { emptyContextState } from '../src/checkpoint_store.js';
import { makeAttachment } from '../src/media.js';
import { projectDataDir } from '../src/paths.js';
import { AgentRuntime } from '../src/runtime.js';
import { canScreenshot, takeScreenshot } from '../src/screenshot.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import type { Message, ModelResponse, ToolCall } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

function png(
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number, number] = () => [
    90, 120, 200, 255,
  ],
): Buffer {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      image.data.set(paint(x, y), (y * width + x) * 4);
  return PNG.sync.write(image);
}
const reply = (
  id: string,
  calls: ToolCall[] = [],
  content = '',
): Partial<ModelResponse> => ({
  message: { id, role: 'assistant', content, tool_calls: calls },
});
const imagesIn = (messages: Message[]) =>
  messages.reduce(
    (sum, message) => sum + (message.attachments?.length ?? 0),
    0,
  );

test('a large PNG is scaled down by averaging what each pixel covers; a small or unreadable one is sent as it is', () => {
  // black and white columns average to grey; a transparent pixel adds no colour
  const stripes = png(MAX_EDGE * 2, 2, (x, y) =>
    y === 0
      ? x % 2
        ? [255, 255, 255, 255]
        : [0, 0, 0, 255]
      : x % 2
        ? [255, 0, 0, 255]
        : [0, 255, 0, 0],
  );
  const fitted = fitPng(stripes);
  assert.deepEqual(
    [fitted.width, fitted.height, fitted.from],
    [MAX_EDGE, 1, { width: MAX_EDGE * 2, height: 2 }],
  );
  const decoded = PNG.sync.read(fitted.bytes);
  // black, white and red averaged; the transparent green pixel adds no colour, only less alpha
  assert.deepEqual([...decoded.data.subarray(0, 4)], [170, 85, 85, 191]);
  const screen = png(2880, 1800);
  const scaled = fitPng(screen);
  assert.ok(
    scaled.width <= MAX_EDGE && scaled.width * scaled.height <= MAX_PIXELS,
  );
  assert.deepEqual(pngSize(scaled.bytes), {
    width: scaled.width,
    height: scaled.height,
  });
  assert.equal(Math.round((scaled.width / scaled.height) * 100), 160);
  // Rounding never takes it over the limits
  const wide = fitPng(png(3000, 2000));
  assert.deepEqual([wide.width, wide.height], [1313, 875]);
  assert.ok(wide.width * wide.height <= MAX_PIXELS);
  const small = png(800, 600);
  assert.equal(fitPng(small).bytes, small);
  const broken = Buffer.from('89504e470d0a1a0a30303030', 'hex');
  assert.equal(fitPng(broken).bytes, broken);
});

test('read_file sends a screenshot-sized PNG scaled down and says both sizes', async (t) => {
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'shot.png'), png(2880, 1800));
  const { attachment, size } = await readMedia(
    join(root, 'shot.png'),
    new AbortController().signal,
  );
  assert.match(size, /^2880×1800, sent as \d+×\d+$/);
  const sent = pngSize(Buffer.from(attachment.data, 'base64'))!;
  assert.equal(size, `2880×1800, sent as ${sent.width}×${sent.height}`);
  const model = new ScriptedModel([
    reply('look', [
      { id: 'read', name: 'read_file', args: { file_path: 'shot.png' } },
    ]),
    reply('done', [], 'seen'),
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    screenshot: false,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('look at shot.png');
  const result = model.requests[1]!.messages.at(-1)!;
  assert.equal(
    result.content,
    `Read shot.png (image/png, ${size}) as an attachment.`,
  );
  assert.equal(result.attachments![0]!.data, attachment.data);
});

test('once a request would carry more than 8 images, the older ones are left out down to the newest 3, and the stored history keeps them all', async (t) => {
  const root = realpathSync(scratch(t));
  for (let at = 0; at < 10; at++)
    writeFileSync(
      join(root, `shot${at}.png`),
      png(20, 10, () => [at, 0, 0, 255]),
    );
  const model = new ScriptedModel([
    ...Array.from({ length: 10 }, (_, at) =>
      reply(`look${at}`, [
        {
          id: `read${at}`,
          name: 'read_file',
          args: { file_path: `shot${at}.png` },
        },
      ]),
    ),
    reply('done', [], 'seen them all'),
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    screenshot: false,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('look at each shot');
  // requests 1 to 8 carry 1 to 8 images; the ninth image makes it 3, then it grows again
  assert.deepEqual(
    model.requests.map((request) => imagesIn(request.messages)),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 3, 4],
  );
  const ninth = model.requests[9]!.messages.filter(
    (message) => message.role === 'tool',
  );
  assert.match(
    ninth[0]!.content,
    /shot0\.png left out of this request to make room for newer images\. Read the file or call the tool again/,
  );
  assert.deepEqual(
    ninth.slice(-3).map((message) => message.attachments?.[0]?.filename),
    ['shot6.png', 'shot7.png', 'shot8.png'],
  );
  assert.equal(imagesIn(runtime.harness.messages), 10);
});

/** A fake desktop: what osascript lists, what each capture tool does, and every call. */
function desktop(
  answers: {
    windows?: { window: number | null; apps: string[]; allowed: boolean };
    fails?: string[];
    picture?: Buffer;
    powershell?: string;
  },
  calls: string[][],
): OutputRunner {
  return async (command, args, options) => {
    calls.push([command, ...args]);
    if (answers.fails?.includes(command))
      return { code: null, stdout: Buffer.alloc(0) };
    if (command === 'osascript')
      return { code: 0, stdout: Buffer.from(JSON.stringify(answers.windows)) };
    if (command === 'powershell') {
      if (answers.powershell)
        return { code: 0, stdout: Buffer.from(answers.powershell) };
      writeFileSync(options.env!.CIRCLE_SCREENSHOT!, answers.picture!);
      return { code: 0, stdout: Buffer.from('png\r\n') };
    }
    writeFileSync(args.at(-1)!, answers.picture!);
    return { code: 0, stdout: Buffer.alloc(0) };
  };
}

test('the screenshot tool asks first, takes the front window of the app it names, and the model sees it scaled with where it was saved', async (t) => {
  const root = realpathSync(scratch(t));
  const calls: string[][] = [];
  const model = new ScriptedModel([
    reply('shoot', [
      { id: 'shot', name: 'screenshot', args: { app: 'Safari' } },
    ]),
    reply('seen', [], 'the button is cut off'),
    reply('again', [
      { id: 'shot2', name: 'screenshot', args: { app: 'Safari' } },
    ]),
    reply('seen2', [], 'still cut off'),
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    screenshot: {
      platform: 'darwin',
      env: { TERM_PROGRAM: 'otty' },
      run: desktop(
        {
          windows: { window: 42, apps: ['Safari', 'Otty'], allowed: true },
          picture: png(3000, 2000),
        },
        calls,
      ),
    },
  });
  cleanup(t, () => runtime.close());
  assert.equal(
    runtime.policy.review('screenshot', { app: 'Safari' }).reason,
    'shows the model the window of Safari',
  );
  // not allowed without approval: nothing is taken
  await runtime.harness.run('how does it look');
  assert.match(
    model.requests[1]!.messages.at(-1)!.content,
    /not run: needs --yolo or approval/,
  );
  assert.equal(calls.length, 0);
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('and now');
  assert.deepEqual(calls[0]!.slice(0, 3), ['osascript', '-l', 'JavaScript']);
  assert.deepEqual(calls[0]!.slice(-2), ['Safari', 'otty']);
  assert.deepEqual(calls[1]!.slice(0, 7), [
    'screencapture',
    '-x',
    '-t',
    'png',
    '-o',
    '-l',
    '42',
  ]);
  const result = model.requests[3]!.messages.at(-1)!;
  const folder = join(projectDataDir(root, root), 'screenshots');
  const saved = readdirSync(folder);
  assert.equal(saved.length, 1);
  assert.equal(calls[1]!.at(-1), join(folder, saved[0]!));
  assert.match(
    result.content,
    new RegExp(
      `^Screenshot of the front window of Safari \\(3000×2000, sent as \\d+×\\d+\\), saved as ${join(folder, saved[0]!).replace(/[.\\\\]/g, '\\$&')}\\.$`,
    ),
  );
  const sent = pngSize(Buffer.from(result.attachments![0]!.data, 'base64'))!;
  assert.ok(sent.width <= MAX_EDGE);
});

test('screenshot says what to do: an app with no window, a terminal that may not record the screen, Linux without a tool, Windows', async (t) => {
  const root = realpathSync(scratch(t));
  const target = join(root, 'shot.png');
  const picture = png(10, 10);
  const calls: string[][] = [];
  await assert.rejects(
    takeScreenshot({
      app: 'Figma',
      target,
      platform: 'darwin',
      env: {},
      run: desktop(
        { windows: { window: null, apps: ['Safari', 'Otty'], allowed: true } },
        calls,
      ),
    }),
    /no window of "Figma" is on screen\. Apps with windows: Safari, Otty/,
  );
  assert.equal(calls.length, 1);
  const hint = await takeScreenshot({
    target,
    platform: 'darwin',
    env: {},
    run: desktop(
      { windows: { window: null, apps: ['Safari'], allowed: false }, picture },
      [],
    ),
  });
  assert.match(hint, /Privacy & Security → Screen Recording/);
  calls.length = 0;
  assert.equal(
    await takeScreenshot({
      target,
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run: desktop({ fails: ['grim'], picture }, calls),
    }),
    '',
  );
  assert.deepEqual(
    calls.map(([command]) => command),
    ['grim', 'gnome-screenshot'],
  );
  await assert.rejects(
    takeScreenshot({
      target: join(root, 'none.png'),
      platform: 'linux',
      env: { DISPLAY: ':0' },
      run: desktop(
        { fails: ['import', 'scrot', 'gnome-screenshot', 'spectacle'] },
        [],
      ),
    }),
    /no screenshot tool worked; install one of import, scrot, gnome-screenshot, spectacle/,
  );
  await assert.rejects(
    takeScreenshot({
      app: 'Code',
      target,
      platform: 'linux',
      env: { DISPLAY: ':0' },
    }),
    /only the whole screen/,
  );
  calls.length = 0;
  await takeScreenshot({
    app: 'chrome',
    target,
    platform: 'win32',
    env: {},
    run: desktop({ picture }, calls),
  });
  assert.deepEqual(calls[0]!.slice(0, 4), [
    'powershell',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
  ]);
  await assert.rejects(
    takeScreenshot({
      app: 'figma',
      target,
      platform: 'win32',
      env: {},
      run: desktop({ powershell: 'apps:chrome, explorer\r\n' }, []),
    }),
    /no window of "figma" is open\. Apps with windows: chrome, explorer/,
  );
  assert.equal(canScreenshot('darwin', {}), true);
  assert.equal(canScreenshot('darwin', { SSH_CONNECTION: '1 2 3 4' }), false);
  assert.equal(canScreenshot('linux', {}), false);
  assert.equal(canScreenshot('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
});

test('read-only mode does not take screenshots', async (t) => {
  const root = realpathSync(scratch(t));
  const calls: string[][] = [];
  const model = new ScriptedModel([
    reply('shoot', [{ id: 'shot', name: 'screenshot', args: {} }]),
    reply('done', [], 'ok'),
  ]);
  const runtime = new AgentRuntime({
    workspace: root,
    home: root,
    settings: defaultSettings(),
    model,
    headless: true,
    screenshot: { platform: 'darwin', env: {}, run: desktop({}, calls) },
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  runtime.harness.planMode = true;
  await runtime.harness.run('look');
  assert.match(model.requests[1]!.messages.at(-1)!.content, /read-only mode/);
  assert.equal(calls.length, 0);
});

test(
  'on Windows the real PowerShell command runs as far as listing the windows',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const target = join(realpathSync(scratch(t)), 'shot.png');
    await assert.rejects(
      takeScreenshot({ app: 'circle-no-such-app-7f3a', target }),
      /no window of "circle-no-such-app-7f3a" is open\. Apps with windows: /,
    );
    assert.equal(existsSync(target), false);
  },
);

test('esc stops a screenshot under way and leaves no file; a minimized Windows window is named as such', async (t) => {
  const root = realpathSync(scratch(t));
  const target = join(root, 'shot.png');
  const controller = new AbortController();
  const capturing = takeScreenshot({
    target,
    platform: 'linux',
    env: { DISPLAY: ':0' },
    signal: controller.signal,
    run: (_command, args, options) =>
      new Promise((resolve) => {
        // a tool that writes part of a picture and then hangs
        writeFileSync(args.at(-1)!, 'partial');
        options.signal?.addEventListener('abort', () =>
          resolve({ code: -1, stdout: Buffer.alloc(0) }),
        );
      }),
  });
  setTimeout(() => controller.abort(new Error('Interrupted')), 50);
  await assert.rejects(capturing, /Interrupted/);
  assert.equal(existsSync(target), false);
  await assert.rejects(
    takeScreenshot({
      app: 'code',
      target,
      platform: 'win32',
      env: {},
      run: async () => ({ code: 0, stdout: Buffer.from('minimized\r\n') }),
    }),
    /the window of "code" is minimized; ask the user to restore it/,
  );
});

test('Windows gives PowerShell a minute for a screenshot and says when it ran out of time', async (t) => {
  const root = realpathSync(scratch(t));
  const target = join(root, 'shot.png');
  const timeouts: number[] = [];
  await assert.rejects(
    takeScreenshot({
      target,
      platform: 'win32',
      env: {},
      run: async (_command, _args, options) => {
        timeouts.push(options.timeout);
        // part of a picture, then the time is up
        writeFileSync(options.env!.CIRCLE_SCREENSHOT!, 'partial');
        return { code: -1, stdout: Buffer.alloc(0), timedOut: true };
      },
    }),
    /^Error: PowerShell did not finish the screenshot in 60 seconds$/,
  );
  assert.deepEqual(timeouts, [60_000]);
  assert.equal(existsSync(target), false);
  // A real program that outlives its time is stopped and reported as timed out; one that
  // is stopped by its signal is not
  const sleeper = ['-e', 'setTimeout(() => {}, 20000)'];
  const started = Date.now();
  assert.deepEqual(
    await runOutput(process.execPath, sleeper, { timeout: 200 }),
    { code: -1, stdout: Buffer.alloc(0), timedOut: true },
  );
  assert.ok(Date.now() - started < 10_000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  assert.deepEqual(
    await runOutput(process.execPath, sleeper, {
      timeout: 20_000,
      signal: controller.signal,
    }),
    { code: -1, stdout: Buffer.alloc(0) },
  );
});

test('a model that does not read images is not given a screenshot: nothing is taken', async (t) => {
  const root = realpathSync(scratch(t));
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
    screenshot: { platform: 'darwin', env: {}, run: desktop({}, calls) },
  });
  cleanup(t, () => runtime.close());
  runtime.policy.setYolo(runtime.session.id, true);
  await runtime.harness.run('look');
  assert.match(
    model.requests[1]!.messages.at(-1)!.content,
    /the model in use does not read images/,
  );
  assert.equal(calls.length, 0);
});

test('a PNG too large to scale down is refused rather than sent whole', async (t) => {
  const root = realpathSync(scratch(t));
  // a header that says 9000×9000 over data that cannot be decoded
  const header = png(2, 2);
  header.writeUInt32BE(9000, 16);
  header.writeUInt32BE(9000, 20);
  writeFileSync(join(root, 'huge.png'), header);
  await assert.rejects(
    readMedia(join(root, 'huge.png'), new AbortController().signal),
    /the picture is 9000×9000 and cannot be scaled down/,
  );
});

test('leaving out older images changes the stored state only when something more is left out, and pruning keeps their note', () => {
  const picture = makeAttachment(png(4, 4), 'image/png', 'a.png');
  const many = {
    id: 'many',
    role: 'user' as const,
    content: 'nine pictures',
    attachments: Array.from({ length: 9 }, () => picture),
  };
  const state = emptyContextState();
  // the newest message alone is over the limit: nothing to leave out
  assert.equal(nextMediaState([many], state), state);
  const dropped = { ...emptyContextState(), droppedMedia: ['old'] };
  const old = {
    id: 'old',
    role: 'tool' as const,
    tool_call_id: 'call',
    name: 'read_file',
    content: 'x'.repeat(200000),
  };
  const pruned = nextPruneState([old], dropped, {
    enabled: true,
    protectTokens: 0,
    minimumTokens: 0,
  });
  assert.deepEqual(pruned.prunedIds, []);
});

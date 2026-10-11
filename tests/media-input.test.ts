import assert from 'node:assert/strict';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';
import { Clipboard, type OutputRunner } from '../src/ink/clipboard.js';
import {
  attachPrompt,
  mention,
  mentions,
  pastedFiles,
} from '../src/mentions.js';
import { GatewayModel } from '../src/model.js';
import {
  ModelCatalog,
  slimCatalog,
  validCatalog,
} from '../src/model_catalog.js';
import { projectDataDir } from '../src/paths.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, saveCredentials } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { SessionApp } from '../src/tui/session_app.js';
import type { CircleEvent } from '../src/events.js';
import type { ModelResponse } from '../src/types.js';
import { cleanup, scratch } from './helpers.js';

type Context = Parameters<typeof scratch>[0];

function png(width = 4, height = 3): Buffer {
  const image = new PNG({ width, height });
  image.data.fill(200);
  return PNG.sync.write(image);
}
const answer = (content: string): Partial<ModelResponse> => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
});
// A path as Terminal.app and iTerm2 paste a file dropped on them
const escaped = (path: string) => path.replace(/([ '"\\])/g, '\\$1');
async function until(predicate: () => boolean, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out');
    await delay(5);
  }
}

/** The input box and the real runtime, without a terminal. */
function session(t: Context, model: ScriptedModel) {
  const workspace = realpathSync(scratch(t));
  const home = realpathSync(scratch(t));
  const settings = defaultSettings();
  const runtime = new AgentRuntime({
    workspace,
    home,
    settings,
    model,
    headless: true,
  });
  cleanup(t, () => runtime.close());
  const app = new SessionApp(workspace, home, settings);
  app.runtime = runtime;
  const ui = app as any;
  ui.screen.render = () => {};
  cleanup(t, () => {
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  const key = (
    name: string,
    char = Array.from(name).length === 1 ? name : '',
  ) => ui.handle({ type: 'key', key: name, char });
  const type = (text: string): void => {
    for (const char of text) key(char, char);
  };
  const lastUser = () =>
    model.requests
      .at(-1)!
      .messages.filter((message) => message.role === 'user')
      .at(-1)!;
  return { app, ui, runtime, workspace, home, key, type, lastUser };
}

test('a mention may be quoted, have its spaces escaped, or hold the no-break space of a macOS screenshot name', () => {
  assert.deepEqual(
    mentions('see @a.png, then @"/tmp/my shots/b.png" and @/tmp/c\\ d.png.'),
    ['a.png', '/tmp/my shots/b.png', '/tmp/c d.png'],
  );
  assert.deepEqual(
    mentions('@~/Desktop/Screenshot\\ 2026-10-11\\ at\\ 10.15.32\u202fAM.png'),
    ['~/Desktop/Screenshot 2026-10-11 at 10.15.32\u202fAM.png'],
  );
  assert.deepEqual(mentions('mail me@example.com'), []);
  assert.equal(mention('/tmp/a b.png'), '@"/tmp/a b.png"');
  assert.equal(mention('src/a.png'), '@src/a.png');
  for (const path of [
    '/tmp/a b.png',
    'x/y.png',
    '/tmp/a\u202fb.png',
    '/tmp/say "hi" now.png',
  ])
    assert.deepEqual(mentions(`look ${mention(path)} now`), [path]);
});

test('a prompt attaches an image mentioned anywhere but a text file only from the workspace, and leaves images out for a model that does not read them', async (t) => {
  const workspace = realpathSync(scratch(t));
  const elsewhere = join(realpathSync(scratch(t)), 'my shots');
  mkdirSync(elsewhere);
  const image = png();
  writeFileSync(join(elsewhere, 'shot 1.png'), image);
  writeFileSync(join(elsewhere, 'notes.txt'), 'private notes');
  const text = `look at ${mention(join(elsewhere, 'shot 1.png'))} and @${join(elsewhere, 'notes.txt')}`;
  const signal = new AbortController().signal;
  const seen = await attachPrompt(text, workspace, signal, () => true);
  assert.equal(seen.leftOut, 0);
  assert.equal(seen.message.attachments?.length, 1);
  assert.ok(
    Buffer.from(seen.message.attachments![0]!.data, 'base64').equals(image),
  );
  assert.equal(seen.message.content, text);
  const blind = await attachPrompt(text, workspace, signal, () => true, false);
  assert.equal(blind.leftOut, 1);
  assert.equal(blind.message.attachments, undefined);
});

test('a paste of dropped image files is read as those files, whatever quoting the terminal used', (t) => {
  const root = realpathSync(scratch(t));
  const shot = join(root, 'Screenshot 2026-10-11 at 10.15.32\u202fAM.png');
  writeFileSync(shot, png());
  const quoted = join(root, "it's.jpg");
  writeFileSync(quoted, 'x');
  const notes = join(root, 'notes.txt');
  writeFileSync(notes, 'x');
  assert.deepEqual(pastedFiles(escaped(shot)), [shot]);
  assert.deepEqual(pastedFiles(`'${shot}' ${escaped(quoted)}`), [shot, quoted]);
  assert.deepEqual(pastedFiles(`"${shot}"\n`), [shot]);
  assert.deepEqual(pastedFiles(pathToFileURL(shot).href), [shot]);
  assert.equal(pastedFiles(notes), undefined);
  assert.equal(pastedFiles(`${escaped(shot)} and more`), undefined);
  assert.equal(pastedFiles('shot.png'), undefined);
  assert.equal(pastedFiles(''), undefined);
  // On Windows a backslash is part of the path
  const slashed = join(root, 'a\\b.png');
  writeFileSync(slashed, 'x');
  assert.deepEqual(pastedFiles(`"${slashed}"`, 'win32'), [slashed]);
  assert.equal(pastedFiles(slashed, 'darwin'), undefined);
});

test('a dropped image goes in the box as [Image #N]; the model gets the file with its path, the conversation shows the box, the history keeps the path', async (t) => {
  const model = new ScriptedModel([answer('a button is cut off')]);
  const s = session(t, model);
  const folder = join(realpathSync(scratch(t)), 'my shots');
  mkdirSync(folder);
  const shot = join(folder, 'Screenshot 1.png');
  const image = png();
  writeFileSync(shot, image);
  s.type('see');
  s.ui.handle({ type: 'paste', text: escaped(shot) });
  assert.equal(s.app.state.draft, 'see [Image #1] ');
  s.type('what is wrong');
  s.key('enter');
  await until(() => model.requests.length === 1 && !s.runtime.busy);
  const user = s.lastUser();
  assert.equal(user.content, `see ${mention(shot)} what is wrong`);
  assert.equal(user.attachments?.length, 1);
  assert.ok(Buffer.from(user.attachments![0]!.data, 'base64').equals(image));
  assert.equal(
    s.runtime.harness.messages[0]!.display,
    'see [Image #1] what is wrong',
  );
  assert.equal(s.ui.history.items.at(-1), `see ${mention(shot)} what is wrong`);
});

test('ctrl+v puts the clipboard picture in the box, kept with the project data, and alt+v does the same; an empty clipboard says so', async (t) => {
  const model = new ScriptedModel([answer('seen')]);
  const s = session(t, model);
  const image = png(8, 8);
  let reply = 'png\n';
  const calls: string[][] = [];
  s.ui.clipboard = new Clipboard({
    platform: 'darwin',
    output: async (command, args) => {
      calls.push([command, ...args]);
      if (reply === 'png\n') writeFileSync(args.at(-1)!, image);
      return { code: 0, stdout: Buffer.from(reply) };
    },
  });
  s.key('ctrl+v');
  await until(() => s.app.state.draft !== '');
  assert.equal(s.app.state.draft, '[Image #1] ');
  assert.equal(calls[0]![0], 'osascript');
  const folder = join(projectDataDir(s.workspace, s.home), 'pasted_images');
  const saved = readdirSync(folder);
  assert.equal(saved.length, 1);
  assert.equal(calls[0]!.at(-1), join(folder, saved[0]!));
  reply = 'none\n';
  s.key('alt+v');
  await until(() => calls.length === 2 && s.app.state.flash !== '');
  assert.equal(s.app.state.flash, 'No image on the clipboard');
  assert.equal(s.app.state.draft, '[Image #1] ');
  s.key('enter');
  await until(() => model.requests.length === 1 && !s.runtime.busy);
  const user = s.lastUser();
  assert.ok(Buffer.from(user.attachments![0]!.data, 'base64').equals(image));
  assert.equal(user.content, mention(join(folder, saved[0]!)));
});

test('the clipboard is read with osascript on macOS, PowerShell on Windows, and wl-paste or xclip on Linux, copied files before a picture', async (t) => {
  const root = realpathSync(scratch(t));
  const target = join(root, 'clip.png');
  const image = png();
  const fake =
    (
      answers: Record<string, string | Buffer>,
      calls: string[][],
    ): OutputRunner =>
    async (command, args, options) => {
      calls.push([command, ...args, options.env?.CIRCLE_CLIPBOARD_IMAGE ?? '']);
      const said = answers[args.join(' ')] ?? answers[command] ?? '';
      return { code: 0, stdout: Buffer.from(said) };
    };
  let calls: string[][] = [];
  const mac = new Clipboard({
    platform: 'darwin',
    output: fake({ osascript: 'file:/Users/me/Desktop/a.png\n' }, calls),
  });
  assert.deepEqual(await mac.readImage(target), {
    files: ['/Users/me/Desktop/a.png'],
  });
  assert.ok(calls[0]!.includes('set png to the clipboard as «class PNGf»'));
  calls = [];
  const windows = new Clipboard({
    platform: 'win32',
    env: {},
    output: fake({ powershell: 'png\r\n' }, calls),
  });
  assert.deepEqual(await windows.readImage(target), { png: target });
  assert.equal(calls[0]![0], 'powershell');
  assert.ok(calls[0]!.includes('-STA'));
  assert.equal(calls[0]!.at(-1), target);
  calls = [];
  const wayland = new Clipboard({
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    output: fake(
      {
        '--list-types': 'text/plain\nimage/png\n',
        '--type image/png': image,
      },
      calls,
    ),
  });
  assert.deepEqual(await wayland.readImage(target), { png: target });
  assert.ok(readFileSync(target).equals(image));
  calls = [];
  const x11 = new Clipboard({
    platform: 'linux',
    env: {},
    output: fake(
      {
        '-selection clipboard -t TARGETS -o':
          'TARGETS\ntext/uri-list\nimage/png\n',
        '-selection clipboard -t text/uri-list -o':
          pathToFileURL(join(root, 'a b.png')).href + '\n',
      },
      calls,
    ),
  });
  assert.deepEqual(await x11.readImage(target), {
    files: [join(root, 'a b.png')],
  });
  const nothing = new Clipboard({
    platform: 'linux',
    env: {},
    output: fake({ xclip: 'UTF8_STRING\n' }, []),
  });
  assert.equal(await nothing.readImage(target), undefined);
});

test('a model known not to read images gets the paths only, with a notice, and a tool that returns an image tells it so', async (t) => {
  const root = realpathSync(scratch(t));
  writeFileSync(join(root, 'shot.png'), png());
  const model = Object.assign(
    new ScriptedModel([
      {
        message: {
          id: 'look',
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'read', name: 'read_file', args: { file_path: 'shot.png' } },
          ],
        },
      },
      answer('cannot see it'),
    ]),
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
  await runtime.harness.run('what is in @shot.png');
  assert.equal(model.requests[0]!.messages.at(-1)!.attachments, undefined);
  assert.deepEqual(notices, [
    { event: 'images_left_out', model: 'scripted', count: 1 },
  ]);
  const result = model.requests[1]!.messages.at(-1)!;
  assert.equal(result.role, 'tool');
  assert.equal(result.status, 'error');
  assert.equal(result.attachments, undefined);
  assert.match(result.content, /scripted does not read images/);
});

test('models.dev says which models read images; the provider profile answers for a model it does not list', (t) => {
  const data = slimCatalog({
    lab: {
      api: 'https://lab.example/v1',
      models: {
        seeing: {
          limit: { context: 1000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        blind: {
          limit: { context: 1000 },
          modalities: { input: ['text'], output: ['text'] },
        },
        unknown: { limit: { context: 1000 } },
      },
    },
  });
  assert.equal(data.providers.lab!.models.seeing!.image, true);
  assert.equal(data.providers.lab!.models.blind!.image, false);
  assert.equal('image' in data.providers.lab!.models.unknown!, false);
  assert.equal(
    validCatalog({
      ...data,
      providers: { lab: { api: '', models: { m: { image: 'yes' } } } },
    }),
    false,
  );
  const home = scratch(t);
  saveCredentials({ api_key: 'fake-key' }, home);
  const catalog = new ModelCatalog(home, { data, env: {} });
  const settings = defaultSettings();
  settings.auth.base_url = 'https://lab.example/v1';
  settings.auth.protocol = 'openai';
  const reads = (name: string) =>
    new GatewayModel(settings, home, name, {}, catalog).imageInput;
  assert.equal(reads('seeing'), true);
  assert.equal(reads('blind'), false);
  assert.equal(reads('unknown'), undefined);
  // not in models.dev for this endpoint: the bundled OpenAI profile knows it
  assert.equal(reads('gpt-3.5-turbo'), false);
  // the settings say better where models.dev is wrong
  settings.models = { blind: { images: true }, seeing: { images: false } };
  assert.equal(reads('blind'), true);
  assert.equal(reads('seeing'), false);
});

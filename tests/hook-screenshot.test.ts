// An after_tool hook with `"screenshot": true` gets a PNG of the page the conversation's browser shows, as a file the
// model never sees (#502): taken once per call when a hook that runs asks, named in that hook's `files`, removed when
// the call's hooks have finished. The option is after_tool's only, and turning it on waits for approval again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { HookRunner, loadHooks, type HookFile } from '../src/hooks.js';
import { convertOldHooks } from '../src/hook_migration.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { scratch, cleanup } from './helpers.js';

/** Synthetic PNG bytes: the signature and the start of a header. */
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001', 'hex');
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');

function layout(t: { after(fn: () => void | Promise<void>): void }) {
  const root = realpathSync(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  const userHome = join(root, 'user');
  for (const path of [home, workspace, userHome]) mkdirSync(path);
  return { root, home, workspace, userHome };
}
function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}
/** Hooks written as these tests first were, in the settings the current format reads. */
function writeHooks(home: string, value: unknown): void {
  writeJson(join(home, 'settings.json'), {
    hooks: convertOldHooks(value).hooks,
  });
}
/** A hook that writes what it got, and whether its file was there and what it held while it ran. */
function keeper(dir: string, name: string): string {
  const script = join(dir, `${name}.mjs`);
  writeFileSync(
    script,
    `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const input = JSON.parse(readFileSync(0, 'utf8'));
const file = input.files?.[0];
writeFileSync(${JSON.stringify(join(dir, `${name}.json`))}, JSON.stringify({
  files: input.files,
  existed: file ? existsSync(file.path) : false,
  read: file ? createHash('sha256').update(readFileSync(file.path)).digest('hex') : null,
}));
`,
  );
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}
const seen = (dir: string, name: string) =>
  JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as {
    files?: HookFile[];
    existed: boolean;
    read: string | null;
  };

test('a hook that asks gets the page as a file, taken once for the call and removed when the hooks finish', async (t) => {
  const { home, workspace, userHome } = layout(t);
  writeHooks(home, {
    hooks: {
      after_tool: [
        { name: 'keep', command: keeper(home, 'keep'), screenshot: true },
        { name: 'also', command: keeper(home, 'also'), screenshot: true },
        { name: 'plain', command: keeper(home, 'plain') },
      ],
    },
  });
  const runner = new HookRunner(
    loadHooks({ workspace, home, trusted: true, userHome }),
    { workspace, home },
  );
  let captures = 0;
  await runner.run({
    event: 'PostToolUse',
    sessionId: 's',
    cwd: workspace,
    toolName: 'browser_navigate',
    toolInput: { url: 'https://example.test/' },
    fields: { tool_response: 'page' },
    screenshot: async () => {
      captures++;
      return PNG;
    },
  });
  assert.equal(captures, 1);
  const keep = seen(home, 'keep');
  assert.deepEqual(
    keep.files?.map(({ path: _, ...rest }) => rest),
    [
      {
        kind: 'screenshot',
        mime_type: 'image/png',
        sha256: sha256(PNG),
        size: PNG.length,
      },
    ],
  );
  assert.equal(keep.existed, true);
  assert.equal(keep.read, sha256(PNG));
  // The same picture for every hook that asked; none for the one that did not
  assert.equal(seen(home, 'also').files?.[0]?.path, keep.files![0]!.path);
  assert.equal(seen(home, 'plain').files, undefined);
  assert.equal(existsSync(keep.files![0]!.path), false);
});

test('nothing is captured when no hook asks, and no page means no file', async (t) => {
  const { home, workspace, userHome } = layout(t);
  writeHooks(home, {
    hooks: {
      after_tool: [
        { name: 'plain', command: keeper(home, 'plain'), tools: 'read_file' },
        {
          name: 'keep',
          command: keeper(home, 'keep'),
          tools: 'browser_snapshot',
          screenshot: true,
        },
      ],
    },
  });
  const runner = new HookRunner(
    loadHooks({ workspace, home, trusted: true, userHome }),
    { workspace, home },
  );
  let captures = 0;
  const request = (toolName: string, page: Buffer | undefined) =>
    runner.run({
      event: 'PostToolUse',
      sessionId: 's',
      cwd: workspace,
      toolName,
      toolInput: {},
      fields: { tool_response: 'text' },
      screenshot: async () => {
        captures++;
        return page;
      },
    });
  await request('read_file', PNG);
  assert.equal(captures, 0);
  assert.equal(seen(home, 'plain').files, undefined);
  await request('browser_snapshot', undefined);
  assert.equal(captures, 1);
  assert.equal(seen(home, 'keep').files, undefined);
});

test('a picture that cannot be kept is no file, and every hook of the call still runs', async (t) => {
  const { root, home, workspace, userHome } = layout(t);
  writeHooks(home, {
    hooks: {
      after_tool: [
        { name: 'keep', command: keeper(home, 'keep'), screenshot: true },
        { name: 'plain', command: keeper(home, 'plain') },
      ],
    },
  });
  const runner = new HookRunner(
    loadHooks({ workspace, home, trusted: true, userHome }),
    { workspace, home },
  );
  // The temporary folder is a file: no folder can be made in it
  const blocked = join(root, 'not-a-folder');
  writeFileSync(blocked, 'synthetic');
  const names = ['TMPDIR', 'TMP', 'TEMP'] as const;
  const before = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = blocked;
  try {
    await runner.run({
      event: 'PostToolUse',
      sessionId: 's',
      cwd: workspace,
      toolName: 'browser_navigate',
      toolInput: {},
      fields: { tool_response: 'page' },
      screenshot: async () => PNG,
    });
  } finally {
    names.forEach((name, index) => {
      if (before[index] === undefined) delete process.env[name];
      else process.env[name] = before[index];
    });
  }
  assert.equal(seen(home, 'keep').files, undefined);
  assert.equal(seen(home, 'plain').files, undefined);
});

test('only PostToolUse takes screenshot', (t) => {
  const { home, workspace, userHome } = layout(t);
  const command = { type: 'command', command: 'true' };
  writeJson(join(home, 'settings.json'), {
    hooks: {
      PreToolUse: [{ hooks: [{ ...command, screenshot: true }] }],
      PostToolUse: [
        { hooks: [{ ...command, screenshot: 'yes' }] },
        { hooks: [{ ...command, name: 'keep', screenshot: true }] },
      ],
    },
  });
  const own = loadHooks({ workspace, home, trusted: true, userHome });
  assert.deepEqual(
    own.hooks.map((hook) => [hook.event, hook.name, hook.screenshot]),
    [['PostToolUse', 'keep', true]],
  );
  const errors = own.errors.map((e) => e.message).join('\n');
  assert.match(
    errors,
    /PreToolUse\[0\]\.hooks\[0\]: screenshot must be true or false, and only PostToolUse takes it/,
  );
  assert.match(
    errors,
    /PostToolUse\[0\]\.hooks\[0\]: screenshot must be true or false/,
  );
});

test("through a session: the hook gets the browser's page for the tool call, and the model never sees it", async (t) => {
  const { home, workspace, userHome } = layout(t);
  writeFileSync(join(workspace, 'notes.txt'), 'synthetic notes');
  writeHooks(home, {
    hooks: {
      after_tool: [
        { name: 'keep', command: keeper(home, 'keep'), screenshot: true },
      ],
    },
  });
  const sessions: string[] = [];
  const model = new ScriptedModel([
    {
      message: {
        id: 'call',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'read', name: 'read_file', args: { file_path: 'notes.txt' } },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'done' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings: defaultSettings(),
    model,
    hookScreenshot: async (sessionId) => {
      sessions.push(sessionId);
      return PNG;
    },
  });
  cleanup(t, () => runtime.close());
  await runtime.initialize();
  await runtime.harness.run('read the notes');
  assert.deepEqual(sessions, [runtime.session.id]);
  const keep = seen(home, 'keep');
  assert.equal(keep.read, sha256(PNG));
  // The model's next request has the tool's text, and nothing of the picture
  const next = JSON.stringify(model.requests[1]!.messages);
  assert.match(next, /synthetic notes/);
  assert.doesNotMatch(next, /screenshot|image\/png|iVBORw0KGgo/);
  assert.ok(
    model.requests[1]!.messages.every(
      (message) =>
        !(message as { attachments?: unknown[] }).attachments?.length,
    ),
  );
});

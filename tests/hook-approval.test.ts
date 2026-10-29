import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { reportProjectHooks } from '../src/cli.js';
import { canonicalPath } from '../src/paths.js';
import { AgentRuntime } from '../src/runtime.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { SessionApp } from '../src/tui/session_app.js';
import { stripAnsi } from '../src/ink/string_width.js';
import { dialogRows } from '../src/ink/components/dialog_card.js';
import { HookApprovalCard } from '../src/ink/components/hook_card.js';
import type { ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

const answer = (content: string): Partial<ModelResponse> => ({
  message: { id: crypto.randomUUID(), role: 'assistant', content },
});
/** A trusted folder whose `.circle/hooks.json` nobody approved: a session_start hook that speaks. */
function folder(t: Parameters<typeof scratch>[0]) {
  // The runtime works in the folder's real path (macOS: /private/var/…).
  const root = realpathSync.native(scratch(t));
  const home = join(root, 'home');
  const workspace = join(root, 'project');
  mkdirSync(home);
  mkdirSync(join(workspace, '.circle'), { recursive: true });
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
  const settings = trustFolder(defaultSettings(), workspace);
  return { root, home, workspace, file, settings };
}
const approvals = (home: string): Record<string, { digest: string }> => {
  const path = join(home, 'hook-trust.json');
  return existsSync(path)
    ? (
        JSON.parse(readFileSync(path, 'utf8')) as {
          files: Record<string, { digest: string }>;
        }
      ).files
    : {};
};
/** The full-screen interface over that folder, with its own cards and keys. */
function session(t: Parameters<typeof scratch>[0], replies: number) {
  const dirs = folder(t);
  const app = new SessionApp(dirs.workspace, dirs.home, dirs.settings);
  const ui = app as any;
  ui.screen.render = () => {};
  const model = new ScriptedModel(
    Array.from({ length: replies }, (_, index) => answer(`reply ${index}`)),
  );
  const runtime = new AgentRuntime({
    workspace: dirs.workspace,
    home: dirs.home,
    userHome: dirs.root,
    settings: dirs.settings,
    model,
    ...ui.cardHooks(),
  });
  app.runtime = runtime;
  cleanup(t, () => runtime.close());
  cleanup(t, () => {
    ui.interactions.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    ui.input.close();
  });
  const key = (name: string): void =>
    ui.handle({
      type: 'key',
      key: name,
      char: Array.from(name).length === 1 ? name : '',
    });
  const card = (): string =>
    dialogRows(app.state.dialog!, 100, 40).map(stripAnsi).join('\n');
  const asking = () =>
    app.state.dialog?.title === 'project hooks need approval';
  return { ...dirs, app, ui, runtime, model, key, card, asking };
}

test('the hooks card at a turn start shows each hook, and approving runs exactly that version in the same turn', async (t) => {
  const s = session(t, 1);
  const run = s.runtime.harness.run('hello');
  await until(s.asking);
  const card = s.card();
  // The file, whole, then each hook with its command.
  assert.equal(s.app.state.dialog!.lines![0]!.text, s.file);
  assert.match(
    s.app.state.dialog!.lines![1]!.text,
    /^new hook · greet · session_start · .*hello\.mjs"$/,
  );
  assert.match(card, /1 skip/);
  assert.match(card, /2 approve these hooks/);
  // Focus starts on skip, the answer that leaves the hooks off.
  assert.equal(s.app.state.dialog!.focus, 0);
  assert.equal(s.model.requests.length, 0);
  s.key('2');
  await run;
  // The hook ran before the first request: its output is in that request.
  assert.match(s.model.requests[0]!.system, /hook says hi/);
  assert.equal(
    typeof approvals(s.home)[canonicalPath(s.file)]?.digest,
    'string',
  );
  assert.ok(
    s.app.state.notices.includes('project hooks approved · .circle/hooks.json'),
    s.app.state.notices.join('\n'),
  );
  assert.equal(
    s.runtime.harness.messages.some(
      (message) => message.hook?.kind === 'changed',
    ),
    false,
  );
});

test('enter, 1, esc and letters on the hooks card never approve; the turn runs without the hooks and says so', async (t) => {
  for (const keys of [['enter'], ['1'], ['escape'], ['y', 'a', 'n', 'enter']]) {
    const s = session(t, 1);
    const run = s.runtime.harness.run('hello');
    await until(s.asking);
    for (const name of keys.slice(0, -1)) {
      s.key(name);
      // Letters are swallowed: the card stays and nothing was typed into the box.
      assert.ok(s.asking(), name);
    }
    s.key(keys.at(-1)!);
    await run;
    assert.doesNotMatch(
      s.model.requests[0]!.system,
      /hook says hi/,
      keys.join(),
    );
    assert.deepEqual(approvals(s.home), {}, keys.join());
    const notice = s.runtime.harness.messages.find(
      (message) => message.hook?.kind === 'changed',
    );
    assert.equal(
      notice?.display,
      'project hooks need approval · .circle/hooks.json',
    );
    assert.equal(s.app.state.draft, '');
  }
});

test('a skipped hooks file is not asked about again until a reload, and a card already open makes it wait', async (t) => {
  const s = session(t, 3);
  const first = s.runtime.harness.run('one');
  await until(s.asking);
  s.key('enter');
  await first;
  // The next turn does not ask again in this session.
  await s.runtime.harness.run('two');
  assert.equal(s.model.requests.length, 2);
  assert.doesNotMatch(s.model.requests[1]!.system, /hook says hi/);
  // After a reload it asks again, after another card that is already open.
  s.runtime.reloadHooks();
  const other = s.ui.askChoice('other', 'something else', ['yes', 'no']);
  const third = s.runtime.harness.run('three');
  await delay(100);
  assert.equal(s.app.state.dialog?.title, 'other');
  s.key('1');
  assert.equal(await other, 'yes');
  await until(s.asking);
  s.key('down');
  s.key('enter');
  await third;
  assert.equal(
    typeof approvals(s.home)[canonicalPath(s.file)]?.digest,
    'string',
  );
});

test('the hooks card waits while you type, and the draft comes back after it', async (t) => {
  const s = session(t, 1);
  s.ui.setDraft('half a thought');
  s.ui.interactions.typed();
  const run = s.runtime.harness.run('hello');
  await delay(300);
  assert.equal(s.app.state.dialog, undefined);
  await until(s.asking, { timeout: 3000 });
  s.key('2');
  await run;
  assert.equal(s.app.state.draft, 'half a thought');
  assert.match(s.model.requests[0]!.system, /hook says hi/);
});

test('without a card, print mode leaves an unapproved hooks file off, says so once, and --approve-hooks runs that version', async (t) => {
  const dirs = folder(t);
  const open = (replies: number) => {
    const model = new ScriptedModel(
      Array.from({ length: replies }, () => answer('ok')),
    );
    const runtime = new AgentRuntime({
      workspace: dirs.workspace,
      home: dirs.home,
      userHome: dirs.root,
      settings: dirs.settings,
      model,
      headless: true,
    });
    cleanup(t, () => runtime.close());
    return { model, runtime };
  };
  const lines: string[] = [];
  const plain = open(2);
  reportProjectHooks(plain.runtime, false, (text) => lines.push(text));
  assert.equal(lines.length, 1);
  assert.match(
    lines[0]!,
    new RegExp(
      `the hooks in ${dirs.file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} were not run`,
    ),
  );
  assert.match(lines[0]!, /--approve-hooks/);
  await plain.runtime.harness.run('one');
  await plain.runtime.harness.run('two');
  assert.doesNotMatch(plain.model.requests[0]!.system, /hook says hi/);
  assert.deepEqual(approvals(dirs.home), {});
  // The transcript says it once, for the person and the model.
  assert.equal(
    plain.runtime.harness.messages.filter(
      (message) => message.hook?.kind === 'changed',
    ).length,
    1,
  );
  const approved: string[] = [];
  const flagged = open(1);
  reportProjectHooks(flagged.runtime, true, (text) => approved.push(text));
  assert.match(approved[0]!, /approved the hooks in /);
  assert.match(approved[1]!, /greet · session_start · /);
  assert.equal(approved.length, 2);
  await flagged.runtime.harness.run('three');
  assert.match(flagged.model.requests[0]!.system, /hook says hi/);
  // A later run of the same bytes needs nothing.
  const later = open(1);
  const quiet: string[] = [];
  reportProjectHooks(later.runtime, false, (text) => quiet.push(text));
  assert.deepEqual(quiet, []);
  await later.runtime.harness.run('four');
  assert.match(later.model.requests[0]!.system, /hook says hi/);
});

test('a session that is open already picks up an approval made in another one', async (t) => {
  const dirs = folder(t);
  const open = () => {
    const model = new ScriptedModel([answer('ok')]);
    const runtime = new AgentRuntime({
      workspace: dirs.workspace,
      home: dirs.home,
      userHome: dirs.root,
      settings: dirs.settings,
      model,
      headless: true,
    });
    cleanup(t, () => runtime.close());
    return { model, runtime };
  };
  const waiting = open();
  const other = open();
  assert.equal(waiting.runtime.pendingHooks().length, 1);
  const [change] = other.runtime.pendingHooks();
  assert.equal(other.runtime.approveHooks(change!), true);
  await waiting.runtime.harness.run('go');
  assert.match(waiting.model.requests[0]!.system, /hook says hi/);
  // A version the session did not read is not approved through it.
  assert.equal(
    other.runtime.approveHooks({ ...change!, digest: 'f'.repeat(64) }),
    false,
  );
});

test('the hooks card leaves the hooks off on every key but 2 or a move and enter', () => {
  const card = new HookApprovalCard({
    file: '/w/.circle/hooks.json',
    digest: 'd',
    definitions: [],
    hooks: [
      {
        name: 'lint',
        event: 'after_tool',
        command: 'npm run lint',
        mark: 'changed',
      },
      { name: 'old', event: 'before_tool', command: 'true', mark: 'removed' },
      {
        name: 'fmt',
        event: 'after_tool',
        command: 'prettier',
        mark: 'unchanged',
      },
    ],
  });
  const state = card.state();
  assert.deepEqual(state.options, ['skip', 'approve these hooks']);
  assert.equal(state.focus, 0);
  const text = state.lines!.map((line) => line.text).join('\n');
  assert.match(text, /changed hook · lint · after_tool · npm run lint/);
  assert.match(text, /removed hook · old · before_tool · true/);
  assert.match(text, /unchanged hook · fmt/);
  assert.doesNotMatch(text, /prettier/);
  assert.deepEqual(card.handle('enter', ''), { answer: 'skip' });
  assert.deepEqual(card.handle('1', '1'), { answer: 'skip' });
  assert.deepEqual(card.handle('escape', ''), { answer: 'skip' });
  for (const letter of ['y', 'a', 'n', 'Y'])
    assert.equal(card.handle(letter, letter), undefined);
  assert.equal(card.handle('ctrl+c', ''), 'pass');
  assert.deepEqual(card.handle('2', '2'), { answer: 'approve' });
  card.handle('down', '');
  assert.deepEqual(card.handle('enter', ''), { answer: 'approve' });
});

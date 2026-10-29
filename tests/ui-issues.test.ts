import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SessionApp } from '../src/tui/session_app.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { ScriptedModel } from '../src/testing.js';
import { stripAnsi } from '../src/ink/string_width.js';
import {
  buildPalette,
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  setPalette,
} from '../src/ink/theme.js';
import {
  emptyUsage,
  type ModelRequest,
  type ModelResponse,
} from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';
import { PlanCompletionTracker, planVisible } from '../src/plan_state.js';
import { nextAgentActivity } from '../src/session_activity.js';
import { loadRemap } from '../src/keybindings.js';
import { PLAN_CHOICES } from '../src/plan_file.js';

const reply = (
  id: string,
  content: string,
  calls?: ModelResponse['message']['tool_calls'],
): ModelResponse => ({
  message: {
    id,
    role: 'assistant',
    content,
    ...(calls ? { tool_calls: calls } : {}),
  },
  usage: emptyUsage(),
});
async function app(
  t: Parameters<typeof scratch>[0],
  model = new ScriptedModel(),
) {
  const root = scratch(t);
  const settings = trustFolder(defaultSettings(), root);
  const app = new SessionApp(root, root, settings);
  const ui = app as any;
  let rows: string[] = [];
  ui.screen.render = (value: string[]) => {
    rows = value.map(stripAnsi);
  };
  await app.attach({ workspace: root, home: root, settings, model });
  cleanup(t, async () => {
    ui.off?.();
    ui.input.close();
    if (ui.flashTimer) clearTimeout(ui.flashTimer);
    if (ui.renderTimer) clearTimeout(ui.renderTimer);
    await app.runtime!.close();
  });
  return {
    root,
    app,
    ui,
    runtime: app.runtime!,
    rows: () => rows,
    key: (key: string, char = '') => ui.handle({ type: 'key', key, char }),
  };
}

test('completing the real plan hides it and anchors one notice, while plan exit can still show it', async (t) => {
  for (const colors of [DEFAULT_DARK, DEFAULT_LIGHT]) {
    setPalette(buildPalette(...colors));
    const model = new ScriptedModel([
      reply('pending-plan', '', [
        {
          id: 'todos-pending',
          name: 'write_todos',
          args: { todos: [{ content: 'inspect', status: 'pending' }] },
        },
      ]),
      reply('completed-plan', '', [
        {
          id: 'todos-done',
          name: 'write_todos',
          args: { todos: [{ content: 'inspect', status: 'completed' }] },
        },
      ]),
      reply('answer', 'finished'),
    ]);
    const s = await app(t, model);
    await s.runtime.harness.run('make a plan');
    s.ui.repaint();
    assert.ok(
      !s.rows().some((row) => row.includes('Plan 1/1')),
      'the completed panel is hidden',
    );
    assert.deepEqual(
      s.app.state.notices.filter((note) => note.startsWith('plan completed')),
      ['plan completed · 1 steps'],
    );
    const at = s.app.state.notices.indexOf('plan completed · 1 steps');
    assert.equal(s.app.state.noticeAnchors![at], 'completed-plan');
    assert.equal(
      s.runtime.todos[0]!.status,
      'completed',
      'the model plan is retained',
    );
    for (let i = 0; i < 3; i++)
      s.runtime.bus.emit('todo_list', { payload: { todos: s.runtime.todos } });
    assert.equal(
      s.app.state.notices.filter((note) => note.startsWith('plan completed'))
        .length,
      1,
    );
    const question = s.ui.askChoice(
      'plan',
      'How should Circle go on?',
      Object.values(PLAN_CHOICES),
    );
    assert.ok(s.rows().some((row) => row.includes('Plan 1/1')));
    s.key('escape');
    assert.equal(await question, PLAN_CHOICES.keep);
    assert.ok(!s.rows().some((row) => row.includes('Plan 1/1')));
  }
});

test('plan focus owns arrows and escape without taking draft, picker or card input', async (t) => {
  const s = await app(t);
  s.runtime.todos = Array.from({ length: 12 }, (_, i) => ({
    content: `step ${i + 1}`,
    status: 'pending',
  }));
  s.ui.setDraft('line one\nline two');
  s.ui.repaint();
  s.key('alt+p');
  assert.equal(s.app.state.planFocused, true);
  s.key('down');
  assert.equal(s.app.state.planStart, 1);
  assert.equal(s.app.state.draft, 'line one\nline two');
  s.key('escape');
  assert.equal(s.app.state.planFocused, false);
  assert.equal(s.app.state.draft, 'line one\nline two');
  s.key('alt+p');
  s.key('x', 'x');
  assert.equal(s.app.state.planFocused, false);
  assert.match(s.app.state.draft, /x$/);
  const top = s.rows().findIndex((row) => /^┌.*Plan/.test(row));
  s.ui.handle({ type: 'mouse', action: 'press', button: 0, x: 4, y: top + 1 });
  assert.equal(s.app.state.planFocused, true);
  const card = s.ui.askChoice('approval', 'answer me', ['allow', 'reject']);
  s.key('down');
  assert.equal(s.app.state.dialog?.focus, 1, 'the card owns its arrows');
  s.key('escape');
  await card;
  assert.equal(s.app.state.planFocused, false);
  s.app.state.picker = { handle: () => true, rows: () => [] } as any;
  s.key('alt+p');
  assert.equal(s.app.state.planFocused, false, 'a picker wins over plan focus');
});

test('tool-only subagents show their real step and waiting state in the strip', async (t) => {
  const route = async (request: ModelRequest): Promise<ModelResponse> => {
    const first = request.messages.find(
      (message) => message.role === 'user',
    )!.content;
    const last = request.messages.at(-1)!;
    if (first === 'start agents')
      return last.role === 'tool'
        ? reply('parent-end', 'done')
        : reply(
            'tasks',
            '',
            [0, 1].map((i) => ({
              id: `task-${i}`,
              name: 'task',
              args: {
                description: `inspect ${i}`,
                subagent_type: 'general-purpose',
              },
            })),
          );
    if (last.role === 'user')
      return reply(crypto.randomUUID(), '', [
        {
          id: crypto.randomUUID(),
          name: 'read_file',
          args: { file_path: 'source.txt' },
        },
      ]);
    if (last.name === 'read_file')
      return reply(crypto.randomUUID(), '', [
        {
          id: crypto.randomUUID(),
          name: 'write_file',
          args: { file_path: `out-${first}.txt`, content: 'done' },
        },
      ]);
    return reply(crypto.randomUUID(), 'child done');
  };
  const s = await app(
    t,
    new ScriptedModel(Array.from({ length: 100 }, () => route)),
  );
  writeFileSync(join(s.root, 'source.txt'), 'hello');
  let readActivity = '';
  const off = s.runtime.bus.subscribe((event) => {
    if (
      event.tags.subagent &&
      event.kind === 'tool_start' &&
      event.payload.name === 'read_file'
    ) {
      s.ui.repaint();
      readActivity =
        s.app.state.subagents!.find((agent) => agent.id === event.tags.subagent)
          ?.activity ?? '';
    }
  });
  cleanup(t, off);
  const running = s.runtime.harness.run('start agents').catch(() => {});
  await until(() => Boolean(s.app.state.dialog));
  assert.ok(s.app.state.dialog, JSON.stringify(s.runtime.harness.messages));
  assert.equal(readActivity, 'Read(source.txt)');
  assert.ok(
    s.app.state.subagents!.some(
      (agent) =>
        agent.state === 'waiting' && agent.activity === 'waiting for you',
    ),
  );
  for (const colors of [DEFAULT_DARK, DEFAULT_LIGHT]) {
    setPalette(buildPalette(...colors));
    s.ui.repaint();
    assert.ok(s.rows().some((row) => row.includes('waiting for you')));
  }
  await s.runtime.cancel();
  await running;
});

test('restored completed plans do not notify again; reopening steps allows a later completion', () => {
  const tracker = new PlanCompletionTracker();
  const done = [{ status: 'completed' }];
  tracker.reset(done);
  assert.equal(tracker.update(done), undefined);
  assert.equal(planVisible(done), false);
  assert.equal(planVisible(done, true), true);
  assert.equal(tracker.update([{ status: 'pending' }]), undefined);
  assert.equal(tracker.update(done), 1);
  assert.equal(tracker.update(done), undefined);
});

test('the real plan_exit question keeps completed steps in view until the decision', async (t) => {
  const s = await app(
    t,
    new ScriptedModel([
      reply('all-complete', '', [
        {
          id: 'plan-write',
          name: 'write_todos',
          args: { todos: [{ content: 'research done', status: 'completed' }] },
        },
      ]),
      reply('real-plan-exit', '', [
        { id: 'plan-exit-call', name: 'plan_exit', args: {} },
      ]),
      reply('kept-plan', 'still planning'),
    ]),
  );
  s.runtime.setPlanMode(true);
  const turn = s.runtime.harness.run('review the plan');
  await until(() =>
    Boolean(s.app.state.dialog?.options.includes(PLAN_CHOICES.manual)),
  );
  assert.ok(s.rows().some((row) => row.includes('Plan 1/1')));
  // The fourth choice saves the plan and leaves plan mode on
  s.key('4', '4');
  await turn;
  assert.equal(s.runtime.harness.planMode, true);
  assert.ok(!s.rows().some((row) => row.includes('Plan 1/1')));
});

test('on a Chinese system the plan question stays English, and a choice answers with its own label', async (t) => {
  const saved = {
    LANG: process.env.LANG,
    LC_ALL: process.env.LC_ALL,
    LANGUAGE: process.env.LANGUAGE,
  };
  process.env.LANG = 'zh_CN.UTF-8';
  process.env.LC_ALL = 'zh_CN.UTF-8';
  delete process.env.LANGUAGE;
  t.after(() => {
    for (const [name, value] of Object.entries(saved))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  });
  const model = new ScriptedModel([
    reply('plan-exit', '', [{ id: 'exit', name: 'plan_exit', args: {} }]),
    reply('implementing', 'implementing'),
  ]);
  const s = await app(t, model);
  s.runtime.setPlanMode(true);
  const turn = s.runtime.harness.run('review the plan');
  await until(() =>
    Boolean(s.app.state.dialog?.options.includes(PLAN_CHOICES.manual)),
  );
  const screen = s.rows().join('\n');
  for (const words of Object.values(PLAN_CHOICES))
    assert.ok(screen.includes(words), `the card shows ${words}`);
  assert.equal(/\p{Script=Han}/u.test(screen), false, screen);
  // The card answers with the choice's own label, which plan_exit reads
  s.key('2', '2');
  await turn;
  assert.equal(s.runtime.harness.planMode, false);
  assert.match(
    String(
      model.requests[1]!.messages.find(
        (message) => message.tool_call_id === 'exit',
      )!.content,
    ),
    /^Plan mode is off: each change asks the user first\./,
  );
});

test('plan focus is remappable and actual steps do not expose raw argument objects', (t) => {
  const root = scratch(t);
  writeFileSync(
    join(root, 'keybindings.json'),
    JSON.stringify({ 'plan.focus': 'ctrl+e' }),
  );
  assert.equal(loadRemap(root).remap['ctrl+e'], 'alt+p');
  assert.equal(
    nextAgentActivity(undefined, {
      kind: 'tool_start',
      payload: {
        name: 'write_file',
        args: { file_path: 'note.txt', content: 'private file contents' },
      },
    }),
    'Write(note.txt)',
  );
  assert.equal(
    nextAgentActivity('Write(note.txt)', { kind: 'tool_waiting', payload: {} }),
    'waiting for you',
  );
  assert.equal(
    nextAgentActivity('waiting for you', { kind: 'llm_start', payload: {} }),
    'working',
  );
});

test('coordinate browser clicks use a single decision, and escape refuses without a lasting rule', async (t) => {
  const s = await app(t);
  const request = {
    kind: 'coordinate',
    token: 'fixture',
    origin: 'http://127.0.0.1',
    x: 10,
    y: 20,
    element: 'delete button',
    destructive: true,
  };
  const first = s.ui.confirmBrowser(request, new AbortController().signal);
  assert.deepEqual(s.app.state.dialog!.options, ['allow once', 'reject']);
  assert.match(s.app.state.dialog!.body!, /delete content/);
  s.key('escape');
  assert.equal(await first, 'reject');
  const second = s.ui.confirmBrowser(request, new AbortController().signal);
  s.key('enter');
  assert.equal(await second, 'once');
});

test('network trust is visible in the welcome and the existing session report', async (t) => {
  const s = await app(t);
  assert.ok(
    s.app.state.welcome.some((row) =>
      stripAnsi(row).includes('network: proxy'),
    ),
  );
  await s.app.command('session', '');
  assert.ok(
    s.app.state.notices.some(
      (note) => note.includes('network: proxy') && note.includes('trust'),
    ),
  );
});

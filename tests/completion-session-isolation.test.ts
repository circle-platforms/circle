import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionApp } from '../src/tui/session_app.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings } from '../src/settings.js';
import { emptyUsage, type ModelResponse } from '../src/types.js';
import { cleanup, scratch, until } from './helpers.js';

const incompleteText = '✖ model output limit reached; response incomplete';
const legacyText = '✖ model ended without an answer';

function incomplete(id: string, content: string): ModelResponse {
  return {
    message: {
      id,
      role: 'assistant',
      content,
      completion: {
        reason: 'length',
        provider_reason: 'max_tokens',
        output_limit: 32000,
      },
      truncated: true,
    },
    usage: { ...emptyUsage(), input_tokens: 7, output_tokens: 11 },
  };
}

function complete(id: string, content: string): ModelResponse {
  return {
    message: { id, role: 'assistant', content, completion: { reason: 'stop' } },
    usage: { ...emptyUsage(), input_tokens: 3, output_tokens: 5 },
  };
}

async function appFor(
  t: Parameters<typeof scratch>[0],
  replies: ConstructorParameters<typeof ScriptedModel>[0],
) {
  const home = scratch(t);
  const workspace = scratch(t);
  const settings = defaultSettings();
  const model = new ScriptedModel(replies);
  const app = new SessionApp(workspace, home, settings);
  const ui = app as any;
  ui.screen.render = () => {};
  app.terminal = {
    platform: process.platform,
    write: () => {},
    input: () => {},
    kill: () => {},
  };
  await app.attach({ workspace, home, settings, model, headless: true });
  cleanup(t, () => app.close());
  return { app, ui, model };
}

function failureNotices(app: SessionApp): string[] {
  return app.state.notices.filter((notice) => notice.startsWith('✖'));
}

function failureAnchors(app: SessionApp): (string | undefined)[] {
  return app.state.notices.flatMap((notice, index) =>
    notice.startsWith('✖') ? [app.state.noticeAnchors?.[index]] : [],
  );
}

for (const outcome of ['complete', 'incomplete'] as const) {
  test(`completion notices remain owned by A after a ${outcome} B response and repeated view selection`, async (t) => {
    const { app, ui, model } = await appFor(t, [
      incomplete('incomplete-A', 'partial answer A'),
      outcome === 'complete'
        ? complete('complete-B', 'answer B')
        : incomplete('incomplete-B', 'partial answer B'),
    ]);
    const a = app.runtime!;
    await app.submit('prompt A');
    assert.deepEqual(failureNotices(app), [incompleteText]);
    assert.deepEqual(failureAnchors(app), ['incomplete-A']);

    await app.command('new', '');
    const b = app.runtime!;
    assert.notEqual(a, b);
    assert.deepEqual(failureNotices(app), []);
    await app.submit('prompt B');
    const expectedB = outcome === 'complete' ? [] : [incompleteText];
    const expectedAnchorsB = outcome === 'complete' ? [] : ['incomplete-B'];
    assert.deepEqual(failureNotices(app), expectedB);
    assert.deepEqual(failureAnchors(app), expectedAnchorsB);

    for (let repeat = 0; repeat < 3; repeat++) {
      await app.command('resume', a.session.id);
      assert.equal(app.runtime, a);
      ui.repaint();
      ui.repaint();
      assert.deepEqual(failureNotices(app), [incompleteText]);
      assert.deepEqual(failureAnchors(app), ['incomplete-A']);
      assert.equal(
        app.state.messages.some((message) => message.id.endsWith('-B')),
        false,
      );

      await app.command('resume', b.session.id);
      assert.equal(app.runtime, b);
      ui.repaint();
      assert.deepEqual(failureNotices(app), expectedB);
      assert.deepEqual(failureAnchors(app), expectedAnchorsB);
      assert.equal(
        app.state.messages.some((message) => message.id === 'incomplete-A'),
        false,
      );
    }
    assert.equal(
      model.requests.length,
      2,
      'selecting views never resends a failed request',
    );
    assert.deepEqual(
      model.requests.map((request) =>
        request.messages.map((message) => message.content),
      ),
      [['prompt A'], ['prompt B']],
    );
    assert.deepEqual(
      a.store.messages(a.session.id).map((message) => message.content),
      ['prompt A', 'partial answer A'],
    );
    assert.deepEqual(
      b.store.messages(b.session.id).map((message) => message.content),
      ['prompt B', outcome === 'complete' ? 'answer B' : 'partial answer B'],
    );
  });
}

for (const kind of ['typed', 'legacy'] as const) {
  test(`a ${kind} completion failure in background A cannot change selected B or duplicate when A is restored`, async (t) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { app, ui, model } = await appFor(t, [
      async (request) => {
        request.token('A work in progress');
        await Promise.race([
          held,
          new Promise<never>((_, reject) =>
            request.signal.addEventListener(
              'abort',
              () => reject(request.signal.reason),
              { once: true },
            ),
          ),
        ]);
        request.signal.throwIfAborted();
        if (kind === 'legacy') throw new Error('model ended without an answer');
        return incomplete(
          'background-incomplete-A',
          'A incomplete after switching away',
        );
      },
      complete('background-complete-B', 'B completed independently'),
    ]);
    cleanup(t, () => release());
    const a = app.runtime!;
    const turnA = app.submit('A fails in background');
    await until(() => model.requests.length === 1, {
      label: 'the model request',
    });
    await app.command('new', '');
    const b = app.runtime!;
    await app.submit('B completes in foreground');
    assert(a.busy);
    assert.deepEqual(failureNotices(app), []);

    release();
    await turnA;
    ui.repaint();
    assert.equal(
      app.runtime,
      b,
      'a late source error never changes the selected view',
    );
    assert.deepEqual(failureNotices(app), []);
    assert.equal(app.state.streaming, '');
    assert.equal(app.state.busy, false);
    assert.deepEqual(app.state.usage, {
      ...emptyUsage(),
      input_tokens: 3,
      output_tokens: 5,
    });
    assert.equal(
      app.state.messages.some((message) =>
        message.content.includes('A incomplete'),
      ),
      false,
    );

    const expected = kind === 'typed' ? incompleteText : legacyText;
    for (let repeat = 0; repeat < 3; repeat++) {
      await app.command('resume', a.session.id);
      ui.repaint();
      ui.repaint();
      assert.deepEqual(failureNotices(app), [expected]);
      if (kind === 'typed')
        assert.deepEqual(failureAnchors(app), ['background-incomplete-A']);
      assert.equal(
        app.state.messages.some(
          (message) => message.id === 'background-complete-B',
        ),
        false,
      );
      await app.command('resume', b.session.id);
      assert.deepEqual(failureNotices(app), []);
    }
    assert.equal(model.requests.length, 2);
    assert.deepEqual(
      model.requests.map((request) =>
        request.messages.map((message) => message.content),
      ),
      [['A fails in background'], ['B completes in foreground']],
    );
    assert.equal(
      b.store
        .messages(b.session.id)
        .some((message) => message.content.includes('A fails')),
      false,
    );
  });
}

test('a failure line has its place in the transcript as soon as it is shown, and a second one of the same words shows too', async (t) => {
  const { app, ui } = await appFor(t, [complete('answer-1', 'first answer')]);
  await app.submit('hello');
  // It sits after the answer that was on screen when it came, not wherever the end is later
  ui.notice('✖ the endpoint refused the request');
  assert.deepEqual(failureAnchors(app), ['answer-1']);
  // The same words again are another failure: it shows, with its own place
  ui.notice('✖ the endpoint refused the request');
  assert.deepEqual(failureNotices(app), [
    '✖ the endpoint refused the request',
    '✖ the endpoint refused the request',
  ]);
  assert.deepEqual(failureAnchors(app), ['answer-1', 'answer-1']);
});

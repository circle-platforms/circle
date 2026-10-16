import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { openNativeDebugInspector } from './helpers/native-debug-journey.mjs';
for (const [kind, tab] of [
  ['activity', 'debug'],
  ['terminal', 'terminal'],
]) {
  for (const alreadyOpen of [false, true]) {
    test(`${kind} Inspector entry returns from file and preserves open toggle (${alreadyOpen})`, async () => {
      const effects = [];
      const page = {
        getByRole: (role, options) => {
          assert.equal(role, 'button');
          assert.equal(options.exact, true);
          return {
            isVisible: async () => options.name === 'close file',
            getAttribute: async (name) => {
              assert.equal(name, 'aria-pressed');
              return String(alreadyOpen);
            },
            click: async () => effects.push(`click ${options.name}`),
          };
        },
        locator: (selector) => ({
          click: async () => effects.push(`click ${selector}`),
          waitFor: async (options) =>
            effects.push(`wait ${selector} ${options.state}`),
        }),
      };
      await openNativeDebugInspector(page, kind, tab);
      assert.deepEqual(effects, [
        'click close file',
        ...(!alreadyOpen ? [`click ${kind} panel`] : []),
        `click #inspector-${kind}-tab-${tab}`,
        `wait #inspector-${kind}-${tab} visible`,
      ]);
    });
  }
}
test('extended native debugger keeps the original shell and actual-effect assertions', async () => {
  const source = await readFile(
    new URL('./helpers/native-debug-journey.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /dock-tab-|developer layout|developer-workbench/);
  for (const effect of [
    'NATIVE_DEBUG_ANSWER:15',
    'NATIVE_DEBUG_STDIN:debug-human-input',
    'actual owned PID exit',
    'inspector TCP port released',
    'new fixture breakpoint',
  ])
    assert.ok(source.includes(effect), effect);
});

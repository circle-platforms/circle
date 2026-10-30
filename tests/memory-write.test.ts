import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CONTEXT_FILE_CAP,
  formatMemorySources,
} from '../src/memory_sources.js';
import {
  MEMORY_LINE_MAX,
  addMemory,
  allMemoryEntries,
  memoryEntries,
  memoryState,
  memoryTargetFor,
  removeMemory,
} from '../src/memory_write.js';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { defaultSettings, trustFolder } from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

const DAY = '2026-10-30';

function folders(t: TestContext): { workspace: string; home: string } {
  const root = scratch(t);
  const workspace = join(root, 'project');
  const home = join(root, 'data');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { workspace, home };
}

const project = (workspace: string) =>
  memoryTargetFor('project', workspace, '');
const account = (workspace: string, home: string) =>
  memoryTargetFor('account', workspace, home);

test('a remembered line is written to the project MEMORY.md, once, as one line', (t) => {
  const { workspace, home } = folders(t);
  const added = addMemory(
    project(workspace),
    'the   release\n branch is 9.3',
    DAY,
  );
  assert.equal(added.ok, true, added.why);
  const file = readFileSync(join(workspace, 'MEMORY.md'), 'utf8');
  assert.equal(
    file,
    '# Memory\n\n- 2026-10-30 \u00b7 the release branch is 9.3\n',
  );
  const again = addMemory(project(workspace), 'the release branch is 9.3');
  assert.equal(again.ok, false);
  assert.match(again.why, /already in/);
  void home;
});

test('a note the person wrote stays in the file and is not offered for removal', (t) => {
  const { workspace } = folders(t);
  writeFileSync(
    join(workspace, 'MEMORY.md'),
    '# Notes\n\nPrefer pnpm over npm here.\n',
  );
  const added = addMemory(project(workspace), 'CI is on ubuntu-24.04');
  assert.equal(added.ok, true, added.why);
  assert.equal(
    readFileSync(join(workspace, 'MEMORY.md'), 'utf8'),
    '# Notes\n\nPrefer pnpm over npm here.\n- 2026-10-30 \u00b7 CI is on ubuntu-24.04\n',
  );
  const entries = memoryEntries(project(workspace));
  assert.equal(entries.length, 1, 'only the line Circle wrote is listed');
  assert.equal(entries[0]!.note, 'CI is on ubuntu-24.04');
});

test('the line is short or it is not written, and the number says how short', (t) => {
  const { workspace } = folders(t);
  const long = 'x'.repeat(MEMORY_LINE_MAX);
  const refused = addMemory(project(workspace), long, DAY);
  assert.equal(refused.ok, false);
  // The prefix of a line is "- " + the date + " · ".
  assert.match(
    refused.why,
    new RegExp(`would be ${long.length + 15} characters`),
  );
  assert.match(refused.why, new RegExp(`at most ${MEMORY_LINE_MAX}`));
  assert.equal(
    existsSync(join(workspace, 'MEMORY.md')),
    false,
    'nothing was made',
  );
  const fits = addMemory(
    project(workspace),
    long.slice(0, MEMORY_LINE_MAX - 15),
    DAY,
  );
  assert.equal(fits.ok, true, fits.why);
});

test('a file the prompt cannot read whole is not grown past the cap', (t) => {
  const { workspace } = folders(t);
  const near = 'a'.repeat(CONTEXT_FILE_CAP - 4);
  writeFileSync(join(workspace, 'MEMORY.md'), near);
  const refused = addMemory(project(workspace), 'one more thing', DAY);
  assert.equal(refused.ok, false);
  assert.match(
    refused.why,
    new RegExp(`past the ${CONTEXT_FILE_CAP} the prompt reads`),
  );
  assert.equal(
    readFileSync(join(workspace, 'MEMORY.md'), 'utf8'),
    near,
    'unchanged',
  );
  const state = memoryState(join(workspace, 'MEMORY.md'));
  assert.equal(state.bytes, near.length);
  assert.equal(state.overCap, false, 'under the cap is not flagged');
  // A file already past it says so, because the prompt reads only the head.
  writeFileSync(join(workspace, 'MEMORY.md'), 'a'.repeat(CONTEXT_FILE_CAP + 8));
  assert.equal(memoryState(join(workspace, 'MEMORY.md')).overCap, true);
});

test('remove takes the numbered line out, and a file Circle made goes with its last line', (t) => {
  const { workspace, home } = folders(t);
  addMemory(project(workspace), 'pnpm here', DAY);
  addMemory(account(workspace, home), 'the laptop is the build box', DAY);
  // The project's lines are numbered first, so 2 is the account's.
  const entries = allMemoryEntries(workspace, home);
  assert.deepEqual(
    entries.map((entry) => entry.scope),
    ['project', 'account'],
  );
  const removed = removeMemory(workspace, home, 1);
  assert.equal(removed.ok, true, removed.why);
  assert.equal(
    existsSync(join(workspace, 'MEMORY.md')),
    false,
    'the file it made is gone',
  );
  assert.equal(
    readFileSync(join(home, 'MEMORY.md'), 'utf8'),
    '# Memory\n\n- 2026-10-30 \u00b7 the laptop is the build box\n',
  );
  assert.equal(removeMemory(workspace, home, 3).ok, false);
  assert.match(removeMemory(workspace, home, 3).why, /only 1 memory line now/);
});

test('the numbers count the lines as they are now, so a removal moves the rest up', (t) => {
  const { workspace, home } = folders(t);
  addMemory(project(workspace), 'the trap is the shared sqlite handle', DAY);
  addMemory(project(workspace), 'the release branch is 9.3', DAY);
  const first = removeMemory(workspace, home, 1);
  assert.equal(first.ok, true, first.why);
  assert.equal(first.entry!.note, 'the trap is the shared sqlite handle');
  const second = removeMemory(workspace, home, 1);
  assert.equal(second.ok, true, second.why);
  assert.equal(second.entry!.note, 'the release branch is 9.3');
  assert.equal(existsSync(join(workspace, 'MEMORY.md')), false);
});

test('the account target is the data folder, and its file is made when it is used', (t) => {
  const { workspace, home } = folders(t);
  const added = addMemory(
    account(workspace, home),
    'always use --stat first',
    DAY,
  );
  assert.equal(added.ok, true, added.why);
  assert.equal(
    readFileSync(join(home, 'MEMORY.md'), 'utf8'),
    '# Memory\n\n- 2026-10-30 \u00b7 always use --stat first\n',
  );
});

test('a remembered line reaches the system prompt of the next session', async (t) => {
  const { workspace, home } = folders(t);
  addMemory(project(workspace), 'the release branch is 9.3', DAY);
  const settings = trustFolder(defaultSettings(), workspace);
  const model = new ScriptedModel([
    { message: { id: 'first', role: 'assistant', content: 'noted' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(workspace, '..', 'user'),
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('what do you already know about this repo?');
  const system = model.requests[0]!.system;
  assert.match(system, /<memory>/);
  assert.ok(
    system.includes('- 2026-10-30 \u00b7 the release branch is 9.3'),
    system.slice(0, 4000),
  );
  assert.ok(
    system.includes(realpathSync(join(workspace, 'MEMORY.md'))),
    'the file the line came from is named',
  );
});

test('the memory Circle wrote survives --no-context-files, which leaves instructions out', (t) => {
  const { workspace } = folders(t);
  writeFileSync(join(workspace, 'AGENTS.md'), 'be terse\n');
  addMemory(project(workspace), 'the release branch is 9.3', DAY);
  const withInstructions = formatMemorySources(workspace, undefined, [], false);
  assert.match(withInstructions, /be terse/);
  const without = formatMemorySources(workspace, undefined, [], true);
  assert.doesNotMatch(without, /be terse/);
  assert.match(without, /the release branch is 9\.3/);
  assert.ok(without.includes(join(workspace, 'MEMORY.md')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runComponentSuites,
  componentShard,
  COMPONENT_SUITES,
} from './component-suites.mjs';

test('component gate runs real child processes serially and retains the first failure without running later suites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-component-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const effects = join(root, 'effects.log');
  const files = ['first', 'failed', 'never'].map((name) =>
    join(root, name + '.mjs'),
  );
  const append = `import {appendFileSync} from 'node:fs'; const write=(line)=>appendFileSync(${JSON.stringify(effects)},line+'\\n');`;
  await writeFile(
    files[0]!,
    append + "write('start');setTimeout(()=>write('end'),30);",
  );
  await writeFile(
    files[1]!,
    append +
      "write('failed');console.error('synthetic diagnostic');process.exitCode=3;",
  );
  await writeFile(files[2]!, append + "write('must not execute');");
  const outputRoot = join(root, 'evidence');
  await assert.rejects(
    runComponentSuites({ suites: files, outputRoot, nodeArguments: [] }),
    /component UI failed/,
  );
  assert.equal(await readFile(effects, 'utf8'), 'start\nend\nfailed\n');
  const [attempt] = await readdir(outputRoot);
  const receipt = JSON.parse(
    await readFile(join(outputRoot, attempt!, 'receipt.json'), 'utf8'),
  );
  assert.deepEqual(
    receipt.suites.map((suite: { state: string }) => suite.state),
    ['passed', 'failed'],
  );
  assert.equal(receipt.suites[1].code, 3);
  assert.match(
    await readFile(join(receipt.suites[1].directory, 'output.log'), 'utf8'),
    /synthetic diagnostic/,
  );
});

test('the component gate preserves prior journeys and includes each native regression once', () => {
  const original = [
    'editor-ui.mjs',
    'resource-boundary-ui.mjs',
    'pending-operations-ui.mjs',
    'recovered-input-ui.mjs',
    'keyboard-navigation-ui.mjs',
  ];
  assert.deepEqual(
    COMPONENT_SUITES.filter(
      (name) =>
        ![
          'external-file-access-ui.mjs',
          'external-file-entry-ui.mjs',
          'context-index-resize-ui.mjs',
          'virtual-file-tree-ui.mjs',
          'project-index-journey-ui.mjs',
          'conversation-requests-ui.mjs',
          'safe-file-undo-ui.mjs',
          'large-file-tree-ui.mjs',
          'settings-navigation-ui.mjs',
          'settings-dialog-ui.mjs',
          'child-terminal-rendered-match-ui.mjs',
          'paste-default-ui.mjs',
          'native-editable-shortcuts-ui.mjs',
          'windowed-mount-ui.mjs',
          'native-terminal-search-ui.mjs',
          'workspace-shell-ui.mjs',
          'original-browser-shell-ui.mjs',
          'native-terminal-fit-ui.mjs',
          'runtime-failure-ui.mjs',
          'session-navigation-ui.mjs',
          'response-readability-ui.mjs',
          'workspace-layout-ui.mjs',
          'agent-source-return-ui.mjs',
          'agent-source-owner-ui.mjs',
          'native-terminal-context-ui.mjs',
          'terminal-window-keys-ui.mjs',
          'terminal-selection-preview-ui.mjs',
          'file-source-heading-ui.mjs',
          'sidebar-workspace-label-ui.mjs',
          'github-connection-ui.mjs',
          'native-terminal-tabs-ui.mjs',
          'extension-feedback-ui.mjs',
          'github-sidebar-status-ui.mjs',
          'conversation-reading-anchor-ui.mjs',
          'github-plugin-ui.mjs',
          'command-terminal-handoff-ui.mjs',
          'github-permissions-ui.mjs',
          'github-feedback-ui.mjs',
          'reading-live-pressure-ui.mjs',
          'fullview-resource-ui.mjs',
          'fullview-browser-shell-ui.mjs',
          'browser-chrome-ui.mjs',
          'github-authorization-phase-ui.mjs',
          'terminal-accessibility-ui.mjs',
          'tool-text-output-ui.mjs',
          'terminal-mode-ui.mjs',
          'screenshot-thumb-ui.mjs',
          'task-review-ui.mjs',
          'gutter-marks-ui.mjs',
          'task-limits-recovery-ui.mjs',
          'overview-actions-ui.mjs',
          'files-git-marks-ui.mjs',
          'drawer-auto-open-ui.mjs',
          'overview-cards-ui.mjs',
          'notice-timers-ui.mjs',
          'tool-summary-line-ui.mjs',
          'git-changes-refresh-ui.mjs',
          'plan-review-ui.mjs',
          'terminal-tab-menu-ui.mjs',
          'runtime-wait-ui.mjs',
        ].includes(name),
    ),
    original,
  );
  assert.equal(
    COMPONENT_SUITES.filter((name) => name === 'windowed-mount-ui.mjs').length,
    1,
  );
  assert.equal(
    COMPONENT_SUITES.filter((name) => name === 'native-terminal-search-ui.mjs')
      .length,
    1,
  );
  for (const name of [
    'child-terminal-rendered-match-ui.mjs',
    'paste-default-ui.mjs',
    'native-editable-shortcuts-ui.mjs',
    'settings-dialog-ui.mjs',
    'workspace-shell-ui.mjs',
    'original-browser-shell-ui.mjs',
    'native-terminal-fit-ui.mjs',
    'runtime-failure-ui.mjs',
    'runtime-wait-ui.mjs',
    'session-navigation-ui.mjs',
    'response-readability-ui.mjs',
    'workspace-layout-ui.mjs',
    'agent-source-return-ui.mjs',
    'agent-source-owner-ui.mjs',
    'native-terminal-context-ui.mjs',
    'terminal-window-keys-ui.mjs',
    'terminal-selection-preview-ui.mjs',
    'file-source-heading-ui.mjs',
    'sidebar-workspace-label-ui.mjs',
    'github-connection-ui.mjs',
    'native-terminal-tabs-ui.mjs',
    'extension-feedback-ui.mjs',
    'github-sidebar-status-ui.mjs',
    'conversation-reading-anchor-ui.mjs',
    'github-plugin-ui.mjs',
    'command-terminal-handoff-ui.mjs',
    'github-permissions-ui.mjs',
    'github-feedback-ui.mjs',
    'reading-live-pressure-ui.mjs',
    'fullview-resource-ui.mjs',
    'fullview-browser-shell-ui.mjs',
    'browser-chrome-ui.mjs',
    'github-authorization-phase-ui.mjs',
    'terminal-accessibility-ui.mjs',
    'tool-text-output-ui.mjs',
    'terminal-mode-ui.mjs',
    'screenshot-thumb-ui.mjs',
    'task-review-ui.mjs',
    'gutter-marks-ui.mjs',
    'task-limits-recovery-ui.mjs',
    'overview-actions-ui.mjs',
    'files-git-marks-ui.mjs',
    'drawer-auto-open-ui.mjs',
    'overview-cards-ui.mjs',
    'notice-timers-ui.mjs',
    'tool-summary-line-ui.mjs',
    'git-changes-refresh-ui.mjs',
    'plan-review-ui.mjs',
    'terminal-tab-menu-ui.mjs',
  ])
    assert.equal(COMPONENT_SUITES.filter((item) => item === name).length, 1);
  assert.equal(new Set(COMPONENT_SUITES).size, 65);
});

test('safe file undo remains a required component journey', () => {
  assert.equal(
    COMPONENT_SUITES.filter((name) => name === 'safe-file-undo-ui.mjs').length,
    1,
  );
});

test('large workspace selection remains a required component journey', () => {
  assert.equal(
    COMPONENT_SUITES.filter((name) => name === 'large-file-tree-ui.mjs').length,
    1,
  );
});

test('remaining-goal journeys stay required once', () => {
  for (const name of [
    'virtual-file-tree-ui.mjs',
    'context-index-resize-ui.mjs',
    'external-file-access-ui.mjs',
  ])
    assert.equal(COMPONENT_SUITES.filter((value) => value === name).length, 1);
});

test('component shards partition the ordered suites without overlap or loss', () => {
  const shards = [0, 1, 2].map((index) =>
    componentShard(COMPONENT_SUITES, index, 3),
  );
  // Together they cover the list exactly once.
  assert.equal(
    shards.reduce((sum, shard) => sum + shard.length, 0),
    COMPONENT_SUITES.length,
  );
  assert.equal(new Set(shards.flat()).size, COMPONENT_SUITES.length);
  // Each shard keeps the list's order and its stride: shard i starts at
  // position i and steps by the shard count.
  for (const [index, shard] of shards.entries()) {
    assert.equal(shard[0], COMPONENT_SUITES[index]);
    assert.equal(shard[1], COMPONENT_SUITES[index + 3]);
    for (let at = 1; at < shard.length; at++)
      assert.ok(
        COMPONENT_SUITES.indexOf(shard[at]!) >
          COMPONENT_SUITES.indexOf(shard[at - 1]!),
      );
  }
  assert.throws(() => componentShard(COMPONENT_SUITES, 3, 3), /invalid/);
  assert.throws(() => componentShard(COMPONENT_SUITES, 0, 0), /invalid/);
});

test('a sharded run executes only its share, under the full list numbers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'circle-component-shard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const effects = join(root, 'effects.log');
  const files = ['one', 'two', 'three', 'four'].map((name) =>
    join(root, name + '.mjs'),
  );
  for (const [index, file] of files.entries())
    await writeFile(
      file,
      `import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(effects)}, '${index + 1}\\n');`,
    );
  const outputRoot = join(root, 'evidence');
  const receipt = await runComponentSuites({
    suites: files,
    shard: { index: 1, count: 2 },
    outputRoot,
    nodeArguments: [],
  });
  assert.equal(await readFile(effects, 'utf8'), '2\n4\n');
  assert.deepEqual(
    receipt.suites.map((suite) => suite.directory.split(/[\\/]/).at(-1)),
    ['2-two', '4-four'],
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runComponentSuites, COMPONENT_SUITES } from './component-suites.mjs';

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
    'git-continuity-ui.mjs',
    'debug-panel-ui.mjs',
    'browser-diagnostics-ui.mjs',
    'keyboard-navigation-ui.mjs',
  ];
  assert.deepEqual(
    COMPONENT_SUITES.filter(
      (name) =>
        ![
          'git-conflict-selector-ui.mjs',
          'tasks-panel-ui.mjs',
          'task-config-recovery-ui.mjs',
          'paste-default-ui.mjs',
          'native-editable-shortcuts-ui.mjs',
          'tasks-refresh-race-ui.mjs',
          'windowed-mount-ui.mjs',
          'native-terminal-search-ui.mjs',
          'original-shell-ui.mjs',
          'debug-panel-embedded.mjs',
          'original-browser-shell-ui.mjs',
          'native-terminal-fit-ui.mjs',
          'runtime-failure-ui.mjs',
          'session-navigation-ui.mjs',
          'response-readability-ui.mjs',
          'inspector-width-ui.mjs',
          'agent-source-return-ui.mjs',
          'agent-source-owner-ui.mjs',
          'native-terminal-context-ui.mjs',
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
          'github-authorization-phase-ui.mjs',
          'terminal-accessibility-ui.mjs',
          'git-owner-ui.mjs',
          'tool-text-output-ui.mjs',
        ].includes(name),
    ),
    original,
  );
  assert.equal(
    COMPONENT_SUITES.filter((name) => name === 'tasks-panel-ui.mjs').length,
    1,
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
    'git-conflict-selector-ui.mjs',
    'tasks-refresh-race-ui.mjs',
    'paste-default-ui.mjs',
    'native-editable-shortcuts-ui.mjs',
    'original-shell-ui.mjs',
    'debug-panel-embedded.mjs',
    'original-browser-shell-ui.mjs',
    'native-terminal-fit-ui.mjs',
    'runtime-failure-ui.mjs',
    'session-navigation-ui.mjs',
    'response-readability-ui.mjs',
    'inspector-width-ui.mjs',
    'agent-source-return-ui.mjs',
    'agent-source-owner-ui.mjs',
    'native-terminal-context-ui.mjs',
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
    'github-authorization-phase-ui.mjs',
    'terminal-accessibility-ui.mjs',
    'git-owner-ui.mjs',
    'tool-text-output-ui.mjs',
  ])
    assert.equal(COMPONENT_SUITES.filter((item) => item === name).length, 1);
  assert.equal(new Set(COMPONENT_SUITES).size, 46);
});

test('task configuration recovery remains a required component journey', () => {
  assert.equal(
    COMPONENT_SUITES.filter((name) => name === 'task-config-recovery-ui.mjs')
      .length,
    1,
  );
});

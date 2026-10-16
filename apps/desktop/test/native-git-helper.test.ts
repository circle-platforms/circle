import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { GitWorkspaceService } from '../src/workspace/git.ts';

test('native Git fixture preserves the primary failure when dirty cleanup cannot switch branches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'circle-native-git-error-'));
  const workspace = join(root, 'workspace');
  const output = join(root, 'evidence');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspace);
  const git = new GitWorkspaceService(workspace);
  const helperUrl = new URL('./helpers/native-git-journey.mjs', import.meta.url)
    .href;
  const { createNativeGitFixture, runNativeGitJourney } = await import(
    helperUrl
  );
  try {
    await git.git(['init', '-b', 'main']);
    await git.git(['config', 'user.name', 'Fixture']);
    await git.git(['config', 'user.email', 'fixture@example.invalid']);
    await git.git(['config', 'core.autocrlf', 'false']);
    await writeFile(join(workspace, 'baseline'), 'baseline');
    await git.git(['add', 'baseline']);
    await git.git(['commit', '-m', 'Create baseline']);
    await createNativeGitFixture(workspace);
    let displayed = await git.snapshot();
    const panel = {
      waitFor: async () => {},
      innerText: async () => 'fixture panel',
      getAttribute: async (name: string) =>
        name === 'aria-busy'
          ? 'false'
          : name === 'data-branch'
            ? displayed.branch
            : displayed.revision,
      getByRole: (_role: string, options: { name?: string } = {}) => {
        const locator = {
          first: () => locator,
          all: async () => [],
          check: async () => {},
          click: async () => {
            if (options.name === 'stage selected')
              throw Error('PRIMARY_STAGE_FAILURE');
            displayed = await git.snapshot();
          },
        };
        return locator;
      },
    };
    // The journey opens the original changes panel from its top-bar toggle
    // before it selects the Git tab inside it.
    let changesOpen = false;
    const toggled: string[] = [];
    const page = {
      locator: () => ({ ...panel, click: async () => {} }),
      getByRole: (role: string, options: { name?: string } = {}) => ({
        getAttribute: async (name: string) =>
          name === 'aria-pressed' ? String(changesOpen) : null,
        click: async () => {
          toggled.push(`${role}:${options.name}`);
          changesOpen = !changesOpen;
        },
      }),
      evaluate: async () => git.snapshot(),
      waitForTimeout: async () => {},
    };
    await assert.rejects(
      runNativeGitJourney({ page, workspace, output, sessionId: 'fixture' }),
      /PRIMARY_STAGE_FAILURE/,
    );
    assert.deepEqual(toggled, ['button:changes panel']);
    const failure = JSON.parse(
      await readFile(join(output, 'native-git-failure.json'), 'utf8'),
    );
    assert.match(failure.error, /PRIMARY_STAGE_FAILURE/);
    assert.match(failure.firstDiff, /MANUAL_FIRST/);
    const cleanup = JSON.parse(
      await readFile(join(output, 'native-git-cleanup-failure.json'), 'utf8'),
    );
    assert.match(cleanup.primaryFailure, /PRIMARY_STAGE_FAILURE/);
    assert.match(
      JSON.stringify(cleanup.cleanupErrors),
      /overwritten by checkout/,
    );
    assert.match(
      await readFile(join(workspace, 'git-journey-manual-first.txt'), 'utf8'),
      /MANUAL_FIRST/,
    );
    assert.match(
      await git.git(['branch', '--show-current']),
      /codex\/native-git-/,
    );
    await assert.rejects(git.git(['remote', 'get-url', 'origin']));
    assert.equal((await git.git(['config', 'user.name'])).trim(), 'Fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

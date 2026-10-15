import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { AgentRuntime } from '../../../src/runtime.ts';
import { defaultSettings, trustFolder } from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import type { Message } from '../../../src/types.ts';
import {
  cancellationFixture,
  cleanup,
  scratch,
} from '../../../tests/helpers.ts';
import {
  CollaborationScheduler,
  type TaskRecord,
} from '../src/workspace/collaboration.ts';
import {
  captureTaskChanges,
  createAgentTaskExecutor,
  type TaskVerificationContext,
} from '../src/workspace/task-executor.ts';
import { createTaskVerifier } from '../src/workspace/task-verification.ts';

const exec = promisify(execFile);
const criterion = 'value is fixed';
const oracle =
  "const fs=require('node:fs'),assert=require('node:assert/strict'); assert.equal(fs.readFileSync('value.txt','utf8'),'fixed\\n'); console.log('TRUSTED_ORACLE_PASS',process.version);";
async function git(path: string, ...args: string[]) {
  return (
    await exec('git', ['-C', path, ...args], { encoding: 'utf8' })
  ).stdout.trim();
}
async function commit(path: string) {
  await git(
    path,
    'add',
    'package.json',
    'value.txt',
    'verify.cjs',
    '.circle/verification.json',
  );
  await git(
    path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create trusted fixture',
  );
  return git(path, 'rev-parse', 'HEAD');
}
async function fixture(
  t: TestContext,
  options: { explicitOracle?: boolean; script?: string; source?: string } = {},
) {
  const root = realpathSync(scratch(t, 'circle-verifier-'));
  const workspace = join(root, 'project with spaces ; literal');
  const dataDir = join(root, 'data');
  const artifactDirectory = join(root, 'artifacts');
  await mkdir(workspace);
  await mkdir(dataDir);
  await mkdir(artifactDirectory);
  await mkdir(join(workspace, '.circle'));
  await git(workspace, 'init', '--initial-branch=main');
  await writeFile(join(workspace, 'value.txt'), 'base\n');
  await writeFile(join(workspace, 'verify.cjs'), options.source ?? oracle);
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify({
      name: 'trusted-fixture',
      private: true,
      scripts: {
        test: options.script ?? 'node verify.cjs',
        oracle: 'node verify.cjs',
      },
    }),
  );
  await writeFile(
    join(workspace, '.circle/verification.json'),
    JSON.stringify({
      version: 1,
      checks:
        options.explicitOracle === false ? [] : [{ criterion, script: 'test' }],
    }),
  );
  const baseline = await commit(workspace);
  const task: TaskRecord = {
    spec: {
      id: 'task',
      workspace,
      baseline,
      dependencies: [],
      access: 'write',
      prompt: 'fix value',
      acceptanceCriteria: [criterion],
    },
    state: 'running',
    attempt: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const signal = new AbortController();
  const context = async (): Promise<TaskVerificationContext> => ({
    worktree: workspace,
    signal: signal.signal,
    answer: 'I claim all checks passed',
    changes: await captureTaskChanges(task, workspace, artifactDirectory),
    events: [],
    artifactDirectory,
    withResource: (_name, run) => run(),
  });
  return {
    root,
    workspace,
    dataDir,
    artifactDirectory,
    baseline,
    task,
    signal,
    context,
  };
}

test('trusted baseline oracle verifies the candidate with real logs and invokes the shared build resource', async (t) => {
  const f = await fixture(t);
  let entered = 0;
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
    runtimeExecutable: process.execPath,
    withBuildResource: async (run, signal, context) => {
      entered++;
      assert.equal(signal, f.signal.signal);
      assert.equal(context.worktree, f.workspace);
      return run();
    },
  });
  await writeFile(join(f.workspace, 'value.txt'), 'fixed\n');
  const checks = await verify(f.task, await f.context());
  assert.equal(entered, 1);
  assert.equal(checks[0]?.status, 'passed');
  assert.equal(checks[0]?.source, 'command');
  assert.equal(checks[0]?.exitCode, 0);
  assert.match(checks[0]?.command ?? '', /npm-cli.js/);
  const log = checks[0]!.artifactPaths!.find((path) => path.endsWith('.log'))!;
  assert.match(await readFile(log, 'utf8'), /TRUSTED_ORACLE_PASS v24\./);
  const state = JSON.parse(
    await readFile(
      checks[0]!.artifactPaths!.find((path) => path.endsWith('.json'))!,
      'utf8',
    ),
  );
  assert.equal(state.baseline, f.baseline);
  assert.equal(state.candidateHead, f.baseline);
  assert.equal(
    (await git(f.workspace, 'worktree', 'list', '--porcelain'))
      .split('\n')
      .filter((line) => line.startsWith('worktree ')).length,
    1,
  );
  assert.equal(
    await readFile(join(f.workspace, 'value.txt'), 'utf8'),
    'fixed\n',
  );
});

test('a legacy synchronous workspace spelling cannot reject the native canonical candidate before its real oracle', async (t) => {
  const f = await fixture(t);
  const canonical = realpathSync.native(f.workspace);
  const alias = join(f.root, 'legacy-workspace-spelling');
  await symlink(
    canonical,
    alias,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(f.workspace, 'value.txt'), 'fixed\n');
  const context = await f.context();
  const original = fs.realpathSync;
  // Reproduce the Windows 8.3 resolver disagreement on every host. The alias
  // is a real folder, while the OS-native resolver still returns its target.
  fs.realpathSync = Object.assign(
    ((...args: Parameters<typeof realpathSync>) =>
      typeof args[0] === 'string' && resolve(args[0]) === resolve(f.workspace)
        ? alias
        : Reflect.apply(original, fs, args)) as typeof realpathSync,
    { native: original.native },
  );
  syncBuiltinESMExports();
  try {
    const verify = createTaskVerifier({
      workspace: f.workspace,
      dataDir: f.dataDir,
      runtimeExecutable: process.execPath,
    });
    const checks = await verify(f.task, context);
    assert.equal(checks[0]?.status, 'passed');
    assert.equal(checks[0]?.source, 'command');
    assert.equal(checks[0]?.exitCode, 0);
    const log = checks[0]!.artifactPaths!.find((path) =>
      path.endsWith('.log'),
    )!;
    assert.match(await readFile(log, 'utf8'), /TRUSTED_ORACLE_PASS v24\./);
    assert.equal(
      await readFile(join(f.workspace, 'value.txt'), 'utf8'),
      'fixed\n',
    );
  } finally {
    fs.realpathSync = original;
    syncBuiltinESMExports();
  }
});

test('a bad candidate fails independently of the worker completion claim', async (t) => {
  const f = await fixture(t);
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  const checks = await verify(f.task, await f.context());
  assert.equal(checks[0]?.status, 'failed');
  assert.notEqual(checks[0]?.exitCode, 0);
  assert.equal(
    checks.some(
      (check) => check.criterion === criterion && check.status === 'passed',
    ),
    false,
  );
});

for (const review of [false, true]) {
  test(`workspace and data-directory aliases preserve real verification boundaries: ${review ? 'independent review' : 'trusted command'}`, async (t) => {
    const f = await fixture(t, { explicitOracle: !review });
    const alias = join(f.root, 'directory-alias');
    try {
      await symlink(
        f.root,
        alias,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if (
        process.platform === 'win32' &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      )
        return t.skip('directory symlink privilege unavailable');
      throw error;
    }
    const workspace = join(alias, basename(f.workspace));
    const model = new ScriptedModel([
      {
        message: response('', [
          { id: 'source', name: 'read_file', args: { file_path: 'value.txt' } },
        ]),
      },
      {
        message: response(
          JSON.stringify({
            checks: [
              {
                criterion,
                status: 'passed',
                evidence:
                  'Read the actual fixed source through the workspace alias',
                sources: [{ path: 'value.txt', line: 1 }],
              },
            ],
          }),
        ),
      },
    ]);
    const verify = createTaskVerifier({
      workspace,
      dataDir: join(alias, 'data'),
      ...(review
        ? {
            createReviewer: () =>
              new AgentRuntime({
                workspace,
                home: join(f.root, 'reviewer-home'),
                userHome: join(f.root, 'reviewer-home'),
                settings: defaultSettings(),
                model,
              }),
          }
        : {}),
    });
    await writeFile(join(f.workspace, 'value.txt'), 'fixed\n');
    const context = await f.context();
    context.worktree = workspace;
    const task = { ...f.task, spec: { ...f.task.spec, workspace } };
    const checks = await verify(task, context);
    assert.equal(
      checks.find((check) => check.criterion === criterion)?.status,
      'passed',
      JSON.stringify(checks),
    );
    assert.deepEqual(await readdir(f.dataDir), []);
  });
}

test('changed package scripts cannot replace the trusted oracle with a fake green command', async (t) => {
  const f = await fixture(t);
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  const modified = {
    name: 'trusted-fixture',
    private: true,
    scripts: { test: 'node -e "console.log(\'FAKE_GREEN\')"' },
  };
  await writeFile(join(f.workspace, 'package.json'), JSON.stringify(modified));
  const checks = await verify(f.task, await f.context());
  assert.equal(checks[0]?.status, 'failed');
  assert.match(checks[0]?.evidence ?? '', /replaced by trusted baseline/);
  assert.doesNotMatch(
    await readFile(
      checks[0]!.artifactPaths!.find((path) => path.endsWith('.log'))!,
      'utf8',
    ),
    /FAKE_GREEN/,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(f.workspace, 'package.json'), 'utf8')),
    modified,
    'verification must not rewrite the candidate manifest',
  );
});

test('transitive npm scripts also use the immutable baseline manifest', async (t) => {
  const f = await fixture(t, { script: 'npm run oracle' });
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  await writeFile(
    join(f.workspace, 'package.json'),
    JSON.stringify({
      name: 'trusted-fixture',
      scripts: { test: 'npm run oracle', oracle: 'node -e "process.exit(0)"' },
    }),
  );
  const checks = await verify(f.task, await f.context());
  assert.equal(checks[0]?.status, 'failed');
  assert.match(
    await readFile(
      checks[0]!.artifactPaths!.find((path) => path.endsWith('.log'))!,
      'utf8',
    ),
    /node verify.cjs/,
  );
});

test('replacing the oracle implementation cannot turn a broken candidate green', async (t) => {
  const f = await fixture(t);
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  await writeFile(
    join(f.workspace, 'verify.cjs'),
    'console.log("FAKE_ORACLE_GREEN");',
  );
  const checks = await verify(f.task, await f.context());
  assert.equal(checks[0]?.status, 'failed');
  assert.doesNotMatch(
    await readFile(
      checks[0]!.artifactPaths!.find((path) => path.endsWith('.log'))!,
      'utf8',
    ),
    /FAKE_ORACLE_GREEN/,
  );
  assert.equal(
    await readFile(join(f.workspace, 'verify.cjs'), 'utf8'),
    'console.log("FAKE_ORACLE_GREEN");',
  );
});

test('the verifier pins policy before an agent commits changed scripts to HEAD', async (t) => {
  const f = await fixture(t);
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  await writeFile(
    join(f.workspace, 'package.json'),
    JSON.stringify({
      name: 'trusted-fixture',
      scripts: { test: 'node -e "process.exit(0)"' },
    }),
  );
  await commit(f.workspace);
  const checks = await verify(f.task, await f.context());
  assert.equal(checks[0]?.status, 'failed');
  assert.match(checks[0]?.evidence ?? '', new RegExp(f.baseline));
});

test('natural language criteria without an oracle remain needs_review', async (t) => {
  const f = await fixture(t, { explicitOracle: false });
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  await writeFile(join(f.workspace, 'value.txt'), 'fixed\n');
  const checks = await verify(f.task, await f.context());
  assert.deepEqual(
    checks.map((check) => [check.criterion, check.status]),
    [[criterion, 'needs_review']],
  );
});

test('a passing default project script does not verify an unrelated natural language criterion', async (t) => {
  const f = await fixture(t);
  await unlink(join(f.workspace, '.circle/verification.json'));
  await git(f.workspace, 'add', '.circle/verification.json');
  await git(
    f.workspace,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Use inferred checks',
  );
  const baseline = await git(f.workspace, 'rev-parse', 'HEAD');
  f.task.spec.baseline = baseline;
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  await writeFile(join(f.workspace, 'value.txt'), 'fixed\n');
  const checks = await verify(f.task, await f.context());
  assert.equal(
    checks.find((check) => check.criterion === 'project script: test')?.status,
    'passed',
  );
  assert.equal(
    checks.find((check) => check.criterion === criterion)?.status,
    'needs_review',
  );
});

test('candidate manifest symlinks never change an outside file', async (t) => {
  const f = await fixture(t);
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  const outside = join(f.root, 'outside.json');
  const content = '{"scripts":{"test":"node -e \\\"process.exit(0)\\\""}}';
  await writeFile(outside, content);
  await unlink(join(f.workspace, 'package.json'));
  try {
    await symlink(outside, join(f.workspace, 'package.json'));
  } catch (error) {
    if (
      process.platform === 'win32' &&
      (error as NodeJS.ErrnoException).code === 'EPERM'
    )
      return t.skip('symlink privilege unavailable');
    throw error;
  }
  const checks = await verify(f.task, await f.context());
  assert.equal(
    checks.some((check) => check.status === 'passed'),
    false,
  );
  assert.equal(await readFile(outside, 'utf8'), content);
  assert.match(checks[0]!.evidence, /symbolic|symlink/i);
});

test('a modified candidate artifact is rejected before creating a verification tree', async (t) => {
  const f = await fixture(t);
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  const context = await f.context();
  await writeFile(context.changes.patchPath, 'replaced patch');
  const checks = await verify(f.task, context);
  assert.equal(checks[0]?.status, 'needs_review');
  assert.match(checks[0]?.evidence ?? '', /patch changed/);
  assert.deepEqual(await readdir(f.dataDir), []);
});

for (const fixed of [true, false]) {
  test(`a real ScriptedModel writer and isolated task execute the trusted oracle: ${fixed ? 'passed' : 'failed despite self claim'}`, async (t) => {
    const f = await fixture(t);
    const verify = createTaskVerifier({
      workspace: f.workspace,
      dataDir: f.dataDir,
      withBuildResource: (run, _signal, context) =>
        context.withResource('build', run),
    });
    const model = new ScriptedModel([
      {
        message: response('', [
          {
            id: 'write',
            name: 'write_file',
            args: {
              file_path: 'value.txt',
              content: fixed ? 'fixed\n' : 'still broken\n',
            },
          },
        ]),
      },
      { message: response('Everything is correct and all tests pass') },
    ]);
    const home = join(f.root, 'writer-home');
    const scheduler = new CollaborationScheduler({
      dataDir: join(f.root, 'scheduler'),
      executor: createAgentTaskExecutor({
        createRuntime: (_task, context) =>
          new AgentRuntime({
            workspace: context.worktree,
            home,
            userHome: home,
            model,
            settings: trustFolder(defaultSettings(), context.worktree),
            headless: true,
            bundledExtensions: false,
            screenshot: false,
            approve: async () => 'approve',
          }),
        verify,
      }),
    });
    cleanup(t, () => scheduler.close());
    await scheduler.enqueue([{ ...f.task.spec, id: 'writer' }], {
      operationId: 'writer',
    });
    scheduler.start();
    await scheduler.waitForIdle();
    assert.equal(
      scheduler.get('writer')!.state,
      fixed ? 'succeeded' : 'failed',
    );
    assert.equal(
      await readFile(join(f.workspace, 'value.txt'), 'utf8'),
      'base\n',
    );
    const worktree = scheduler.get('writer')!.worktree!;
    assert.equal(
      await readFile(join(worktree, 'value.txt'), 'utf8'),
      fixed ? 'fixed\n' : 'still broken\n',
    );
    assert.equal(model.requests.length, 2);
  });
}

function response(content: string, calls?: Message['tool_calls']): Message {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content,
    tool_calls: calls,
  };
}
for (const mode of ['unread', 'read', 'empty'] as const) {
  test(`independent reviewer source evidence: ${mode}`, async (t) => {
    const f = await fixture(t, { explicitOracle: false });
    await writeFile(join(f.workspace, 'value.txt'), 'fixed\n');
    const verdict = JSON.stringify({
      checks: [
        {
          criterion,
          status: 'passed',
          evidence: 'the actual file contains fixed',
          sources: [{ path: 'value.txt', line: 1 }],
        },
      ],
    });
    const replies =
      mode !== 'unread'
        ? [
            {
              message: response('', [
                {
                  id: 'source',
                  name: 'read_file',
                  args: {
                    file_path: 'value.txt',
                    ...(mode === 'empty' ? { limit: 0 } : {}),
                  },
                },
              ]),
            },
            { message: response(verdict) },
          ]
        : [{ message: response(verdict) }];
    const model = new ScriptedModel(replies);
    const verify = createTaskVerifier({
      workspace: f.workspace,
      dataDir: f.dataDir,
      createReviewer: (_task, context) =>
        new AgentRuntime({
          workspace: context.worktree,
          home: join(f.root, 'reviewer-home'),
          settings: defaultSettings(),
          model,
        }),
    });
    const checks = await verify(f.task, await f.context());
    assert.equal(
      checks[0]?.status,
      mode === 'read' ? 'passed' : 'needs_review',
    );
    assert.equal(checks[0]?.source, 'independent-review');
    assert.ok(
      model.requests[0]!.tools.every(
        (tool) =>
          tool.effect === 'read' &&
          !['execute', 'task', 'write_file'].includes(tool.name),
      ),
    );
    assert.equal(
      await readFile(join(f.workspace, 'value.txt'), 'utf8'),
      'fixed\n',
    );
  });
}

test(
  'normal command exit also cleans descendants that retain its output pipes',
  { skip: process.platform === 'win32' },
  async (t) => {
    const owned = realpathSync(scratch(t, 'circle-verifier-detached-'));
    const fixtureGate = await cancellationFixture(t, owned);
    const source = `const fs=require('node:fs'); const child=require('node:child_process').spawn(process.execPath,[${JSON.stringify(join(owned, 'parent.cjs'))}],{cwd:${JSON.stringify(owned)},stdio:'inherit'}); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(join(owned, 'started'))})){clearInterval(timer); child.unref();}},5);`;
    const f = await fixture(t, { source });
    const verify = createTaskVerifier({
      workspace: f.workspace,
      dataDir: f.dataDir,
    });
    const running = verify(f.task, await f.context());
    cleanup(t, async () => {
      f.signal.abort();
      await running.catch(() => {});
    });
    await fixtureGate.ready();
    const checks = await fixtureGate.exited(running);
    assert.equal(checks[0]?.status, 'passed');
    assert.equal(await fixtureGate.release(), 'closed');
    assert.equal(existsSync(join(owned, 'late')), false);
  },
);

test('cancellation stops the real owned command descendant before releasing its late write', async (t) => {
  const owned = realpathSync(scratch(t, 'circle-verifier-cancel-'));
  const fixtureGate = await cancellationFixture(t, owned);
  if (process.platform !== 'win32')
    writeFileSync(
      join(owned, 'grandchild.cjs'),
      (await readFile(join(owned, 'grandchild.cjs'), 'utf8')) +
        '\nprocess.on("SIGTERM",()=>{});\n',
    );
  const source = `require('node:child_process').spawn(process.execPath,[${JSON.stringify(join(owned, 'parent.cjs'))}],{cwd:${JSON.stringify(owned)},stdio:'inherit'}); setInterval(()=>{},1000);`;
  const f = await fixture(t, { source });
  const verify = createTaskVerifier({
    workspace: f.workspace,
    dataDir: f.dataDir,
  });
  const running = verify(f.task, await f.context());
  cleanup(t, async () => {
    f.signal.abort();
    await running.catch(() => {});
  });
  const stopped = assert.rejects(running, { name: 'AbortError' });
  await fixtureGate.ready();
  f.signal.abort();
  await stopped;
  assert.equal(await fixtureGate.release(), 'closed');
  assert.equal(existsSync(join(owned, 'late')), false);
});

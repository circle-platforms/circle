import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { RuntimeController } from '../src/runtime-controller.ts';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function createPack(
  skillsRoot: string,
  id: string,
  withTypedTool: boolean,
): Promise<void> {
  const files: Record<string, string> = {
    'SKILL.md': `---\nname: ${id}\ndescription: Synthetic pack ${id}.\n---\n\n# ${id}\n`,
    'tools/hello.mjs': `console.log('hello-pack:' + process.env.CIRCLE_SKILL_DIR);\n`,
  };
  if (withTypedTool) {
    files['tools/typed-check.mjs'] =
      `console.log('typed-ok:' + process.argv.slice(2).join(','));\n`;
    files['tools.json'] = JSON.stringify({
      version: 1,
      tools: [
        {
          name: 'typed_check',
          description: 'Verify pack wiring.',
          script: 'tools/typed-check.mjs',
          input_schema: {
            type: 'object',
            properties: { note: { type: 'string' } },
            required: ['note'],
          },
          args: ['--note', '{note}'],
        },
      ],
    });
  }
  const packDir = join(skillsRoot, id);
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(packDir, ...rel.split('/'));
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
  await writeFile(
    join(packDir, 'pack.json'),
    JSON.stringify({
      schema: 'pack@1',
      id,
      version: '1.0.0',
      files: Object.entries(files)
        .map(([path, content]) => ({
          path,
          sha256: sha(content),
          size: Buffer.byteLength(content),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    }),
    'utf8',
  );
}

async function runIsolatedChildCheck(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'circle-skills-wiring-'));
  let controller: RuntimeController | undefined;
  try {
    const dataFolder = join(root, 'Application Support', 'Circle');
    const home = join(dataFolder, 'runtime-home');
    const workspace = join(root, 'workspace');
    const stagedBin = join(root, 'tools', 'node', 'bin');
    const stagedNode = join(
      stagedBin,
      process.platform === 'win32' ? 'node.exe' : 'node',
    );
    const localSkillsRoot = join(home, '.agents', 'skills');
    const leakedRoot = join(homedir(), '.agents', 'skills');

    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(join(workspace, '.git'), { recursive: true }),
      mkdir(stagedBin, { recursive: true }),
      mkdir(localSkillsRoot, { recursive: true }),
      mkdir(leakedRoot, { recursive: true }),
    ]);
    await copyFile(process.execPath, stagedNode);
    if (process.platform !== 'win32') await chmod(stagedNode, 0o755);

    await createPack(localSkillsRoot, 'pack-desktop', true);
    await createPack(leakedRoot, 'pack-host-home', false);
    saveSettings(trustFolder(defaultSettings(), workspace), home);

    const call = (id: string, name: string, args: Record<string, unknown>) => ({
      message: {
        id: randomUUID(),
        role: 'assistant' as const,
        content: '',
        tool_calls: [{ id, name, args }],
      },
    });
    const model = new ScriptedModel([
      call('c-list', 'skill_list', {}),
      call('c-run', 'skill_run', {
        pack: 'pack-desktop',
        script: 'tools/hello.mjs',
      }),
      call('c-skill', 'skill', { name: 'pack-desktop' }),
      call('c-typed', 'pack-desktop_typed_check', { note: 'wired' }),
      {
        message: {
          id: randomUUID(),
          role: 'assistant' as const,
          content: 'done',
          tool_calls: [],
        },
      },
    ]);

    // Mirror runtime-worker's userHome wiring even when localSkillsRoot is omitted.
    controller = new RuntimeController({
      home,
      dataFolder,
      userHome: home,
      workspace,
      workspaceTools: {
        runtimeExecutable: stagedNode,
        commandSupervisorPath: fileURLToPath(
          new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
        ),
        ghPath: 'unused',
      },
      model,
      emit: () => {},
    });

    const sessionId = controller.snapshot().activeSessionId;
    assert.ok(
      controller.snapshot().skills.some((s) => s.name === 'pack-desktop'),
      'desktop UI snapshot lists pack-desktop',
    );
    assert.equal(
      controller.snapshot().skills.some((s) => s.name === 'pack-host-home'),
      false,
      'desktop UI snapshot stays isolated from OS homedir skills',
    );

    const modeReply = await controller.dispatch({
      id: randomUUID(),
      name: 'set-mode',
      sessionId,
      payload: { mode: 'auto' },
    });
    assert.equal(modeReply.ok, true, modeReply.error);
    const promptReply = await controller.dispatch({
      id: randomUUID(),
      name: 'prompt',
      sessionId,
      payload: { text: 'run pack tools' },
    });
    assert.equal(promptReply.ok, true, promptReply.error);

    const deadline = Date.now() + 20_000;
    while (model.requests.length < 5 && Date.now() < deadline) {
      await delay(15);
    }
    assert.equal(model.requests.length, 5, 'model received all tool results');

    const toolOutput = (reqIndex: number, callId: string): string =>
      String(
        model.requests[reqIndex]?.messages.find(
          (m) => m.tool_call_id === callId,
        )?.content ?? '',
      );

    const listResult = toolOutput(1, 'c-list');
    assert.match(listResult, /pack-desktop/);
    assert.doesNotMatch(listResult, /pack-host-home/);

    const runResult = toolOutput(2, 'c-run');
    assert.match(runResult, /hello-pack:/);

    const skillResult = toolOutput(3, 'c-skill');
    assert.match(skillResult, /pack-desktop_typed_check/);
    const requestTools = (model.requests[3]?.tools ?? []).map((t) => t.name);
    assert.ok(
      requestTools.includes('pack-desktop_typed_check'),
      `pack-desktop_typed_check offered on next turn: ${requestTools.join(', ')}`,
    );

    const typedResult = toolOutput(4, 'c-typed');
    assert.match(typedResult, /typed-ok:--note,wired/);

    const leakedEntries = await readdir(leakedRoot);
    assert.deepEqual(leakedEntries, ['pack-host-home']);
  } finally {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runWorkerWiringChildCheck(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'circle-worker-skills-'));
  try {
    const dataFolder = join(root, 'Application Support', 'Circle');
    const home = join(dataFolder, 'runtime-home');
    const workspace = join(root, 'workspace');
    const localSkillsRoot = join(home, '.agents', 'skills');
    const legacyRoot = join(homedir(), '.agents', 'skills');
    const fixturePath = join(root, 'fixture.json');

    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(workspace, { recursive: true }),
      mkdir(join(workspace, '.git'), { recursive: true }),
      mkdir(localSkillsRoot, { recursive: true }),
      mkdir(legacyRoot, { recursive: true }),
    ]);
    await createPack(localSkillsRoot, 'pack-desktop', true);
    await createPack(legacyRoot, 'pack-host-home', false);
    saveSettings(trustFolder(defaultSettings(), workspace), home);
    await writeFile(fixturePath, JSON.stringify({ replies: [] }), 'utf8');

    process.env.CIRCLE_DESKTOP_RUNTIME_HOME = home;
    process.env.CIRCLE_WORKBENCH_TEST_PROFILE = JSON.stringify({ workspace });
    process.env.CIRCLE_DESKTOP_RUNTIME_FIXTURE = fixturePath;

    const listeners = new Map<
      string,
      Array<(event: { data: unknown }) => void>
    >();
    let seenLegacyNotice = false;
    let resolvedSnapshot:
      | {
          skills?: Array<{ name: string }>;
          legacySkillPacks?: string[];
        }
      | undefined;

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for runtime-worker snapshot'));
      }, 15_000);
      Object.defineProperty(process, 'parentPort', {
        configurable: true,
        value: {
          postMessage(msg: {
            type?: string;
            update?: {
              snapshot?: {
                skills?: Array<{ name: string }>;
                legacySkillPacks?: string[];
              };
            };
          }) {
            if (msg?.type === 'update' && msg.update?.snapshot) {
              const snap = msg.update.snapshot;
              if (snap.skills && snap.skills.length > 0) {
                resolvedSnapshot = snap;
                seenLegacyNotice = Boolean(
                  snap.legacySkillPacks?.includes('pack-host-home'),
                );
                clearTimeout(timer);
                resolve();
              }
            }
          },
          on(event: string, listener: (event: { data: unknown }) => void) {
            const list = listeners.get(event) ?? [];
            list.push(listener);
            listeners.set(event, list);
          },
        },
      });
    });

    await import('../src/runtime-worker.ts');
    await done;

    assert.ok(resolvedSnapshot, 'runtime-worker emitted initial snapshot');
    assert.ok(
      resolvedSnapshot.skills?.some((s) => s.name === 'pack-desktop'),
      'runtime-worker loaded pack-desktop from runtime-home',
    );
    assert.equal(
      resolvedSnapshot.skills?.some((s) => s.name === 'pack-host-home'),
      false,
      'runtime-worker ignored legacy host homedir skills',
    );
    assert.equal(
      seenLegacyNotice,
      true,
      'runtime-worker reported legacy ~/.agents/skills packs in legacySkillPacks',
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

if (process.env.CIRCLE_TEST_SKILLS_CHILD === '1') {
  await runIsolatedChildCheck();
} else if (process.env.CIRCLE_TEST_SKILLS_CHILD === 'worker') {
  await runWorkerWiringChildCheck();
  process.exit(0);
} else {
  test('runtime-worker and RuntimeController share localSkillsRoot under desktop runtime-home', async () => {
    for (const mode of ['1', 'worker'] as const) {
      const fakeHome = await mkdtemp(join(tmpdir(), 'circle-fake-home-'));
      try {
        const child = spawnSync(
          process.execPath,
          ['--import', 'tsx', fileURLToPath(import.meta.url)],
          {
            env: {
              ...process.env,
              HOME: fakeHome,
              USERPROFILE: fakeHome,
              CIRCLE_TEST_SKILLS_CHILD: mode,
            },
            encoding: 'utf8',
            timeout: 30_000,
          },
        );
        assert.equal(
          child.status,
          0,
          `child (${mode}) exited with ${child.status}\nstdout: ${child.stdout}\nstderr: ${child.stderr}`,
        );
      } finally {
        await rm(fakeHome, { recursive: true, force: true });
      }
    }
  });
}

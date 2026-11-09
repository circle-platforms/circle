import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectDataDir } from '../../../src/paths.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { readPlanFolderFile } from '../src/plan-folder.ts';
import { RuntimeController } from '../src/runtime-controller.ts';

// A Circle home and workspace with a plan folder holding a note, a picture, a link out of
// the folder and a sub-folder, and a secret beside the folder
async function world() {
  const temp = await realpath(
    await mkdtemp(join(tmpdir(), 'circle-plan-folder-')),
  );
  const home = join(temp, 'home');
  const workspace = join(temp, 'workspace');
  await mkdir(workspace, { recursive: true });
  const data = projectDataDir(workspace, home);
  const folder = join(data, 'session_plans');
  await mkdir(join(folder, 'drafts'), { recursive: true });
  await writeFile(
    join(folder, 'proposal-review.md'),
    '# Review\n\nSYNTHETIC\n',
  );
  await writeFile(
    join(folder, 'picture.png'),
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe]),
  );
  await writeFile(join(data, 'secret.txt'), 'SYNTHETIC-SECRET\n');
  // Windows makes a file link only with rights a runner may not have
  if (process.platform !== 'win32')
    await symlink(join(data, 'secret.txt'), join(folder, 'outside.md'));
  return { temp, home, workspace };
}

test('a plan folder file is read as text, and nothing outside the folder is', async () => {
  const { temp, home, workspace } = await world();
  try {
    assert.deepEqual(
      {
        ...(await readPlanFolderFile(
          workspace,
          home,
          '/session_plans/proposal-review.md',
        )),
        updatedAt: 'set',
      },
      {
        file: '/session_plans/proposal-review.md',
        text: '# Review\n\nSYNTHETIC\n',
        updatedAt: 'set',
      },
    );
    // Written without its leading slash, as a model may link it
    assert.equal(
      (
        await readPlanFolderFile(
          workspace,
          home,
          'session_plans/proposal-review.md',
        )
      ).file,
      '/session_plans/proposal-review.md',
    );
    const refused = async (path: string, message: RegExp) =>
      assert.rejects(readPlanFolderFile(workspace, home, path), message);
    await refused('/session_plans/../secret.txt', /not a file of the plan/);
    await refused('/session_plans/drafts/x.md', /not a file of the plan/);
    await refused('/session_plans/drafts', /not a file of the plan/);
    if (process.platform !== 'win32')
      await refused('/session_plans/outside.md', /not a file of the plan/);
    await refused('/elsewhere/proposal-review.md', /not a file of the plan/);
    await refused('/session_plans/missing.md', /missing\.md does not exist/);
    await refused('/session_plans/picture.png', /picture\.png is not a text/);
    await assert.rejects(
      readPlanFolderFile(
        workspace,
        home,
        '/session_plans/proposal-review.md',
        4,
      ),
      /too large to show/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('the window reads a plan folder file through the controller, for the session that owns it', async () => {
  const { temp, home, workspace } = await world();
  saveSettings(trustFolder(defaultSettings(), workspace), home);
  let controller: RuntimeController | undefined;
  try {
    controller = new RuntimeController({
      home,
      workspace,
      userHome: home,
      model: new ScriptedModel([]),
      emit: () => {},
    });
    const ask = (path: string) =>
      controller!.dispatch({
        id: randomUUID(),
        name: 'workspace-service',
        sessionId: controller!.snapshot().activeSessionId,
        payload: {
          service: 'documents',
          method: 'readPlanFolder',
          params: { path },
        },
      });
    const reply = await ask('/session_plans/proposal-review.md');
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(
      (reply.data as { text: string }).text,
      '# Review\n\nSYNTHETIC\n',
    );
    const outside = await ask('/session_plans/../secret.txt');
    assert.equal(outside.ok, false);
    assert.doesNotMatch(JSON.stringify(outside), /SYNTHETIC-SECRET/);
  } finally {
    await controller?.close();
    await rm(temp, { recursive: true, force: true });
  }
});

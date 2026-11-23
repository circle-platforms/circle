import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { saveSecret } from '../../../src/secrets.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { ScriptedModel } from '../../../src/testing.ts';
import { RuntimeController } from '../src/runtime-controller.ts';
import { patience } from './helpers/patience.mjs';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const supervisorPath = fileURLToPath(
  new URL('../src/workspace/command-supervisor.mjs', import.meta.url),
);

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + patience(12_000);
  while (!check()) {
    if (Date.now() > deadline) throw Error(`timed out: ${label}`);
    await delay(15);
  }
}

test('RuntimeController runs pack tools/*.ts scripts with relative imports via workspaceTools.runtimeExecutable', async (t) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'circle-desktop-skill-run-')),
  );
  let controller: RuntimeController | undefined;
  t.after(async () => {
    await controller?.close();
    await rm(root, { recursive: true, force: true });
  });

  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const data = join(root, 'data');
  const skillsRoot = join(home, '.agents', 'skills');
  const stagedBin = join(root, 'Program Files Circle', 'tools', 'node', 'bin');
  const stagedNode = join(
    stagedBin,
    process.platform === 'win32' ? 'node.exe' : 'node',
  );
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    mkdir(data, { recursive: true }),
    mkdir(skillsRoot, { recursive: true }),
    mkdir(stagedBin, { recursive: true }),
  ]);
  await copyFile(process.execPath, stagedNode);
  if (process.platform !== 'win32') await chmod(stagedNode, 0o755);

  const packFiles: Record<string, string> = {
    'SKILL.md':
      '---\nname: recompose\ndescription: Synthetic recompose pack.\n---\n\n# recompose\n',
    'functions/usage.ts':
      "export function usageText(): string {\n  return 'Usage: check-record.ts --file <path>';\n}\n",
    'tools/check-record.ts': `import { writeFileSync } from 'node:fs';
import { usageText } from '../functions/usage.ts';
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(usageText());
  process.exit(2);
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const stdin = Buffer.concat(chunks).toString('utf8');
writeFileSync('check-record-receipt.json', JSON.stringify({
  execPath: process.execPath,
  args,
  stdin,
  cwd: process.cwd(),
}));
console.log('checked:' + stdin.trim());
`,
    'tools/submit.ts': `import { writeFileSync } from 'node:fs';
writeFileSync('submit-receipt.json', JSON.stringify({
  execPath: process.execPath,
  args: process.argv.slice(2),
  token: process.env.SUBMIT_TOKEN,
}));
console.log('submitted:' + (process.env.SUBMIT_TOKEN ?? ''));
`,
    'tools.json': JSON.stringify({
      version: 1,
      tools: [
        {
          name: 'submit',
          description: 'Submit a record.',
          script: 'tools/submit.ts',
          input_schema: {
            type: 'object',
            properties: { record: { type: 'string' } },
            required: ['record'],
          },
          args: ['--record', '{record}'],
          env: { SUBMIT_TOKEN: '%HUB_TOKEN%' },
        },
      ],
    }),
  };
  const packDir = join(skillsRoot, 'recompose');
  for (const [rel, content] of Object.entries(packFiles)) {
    const dest = join(packDir, ...rel.split('/'));
    await mkdir(join(dest, '..'), { recursive: true });
    await writeFile(dest, content, 'utf8');
  }
  await writeFile(
    join(packDir, 'pack.json'),
    JSON.stringify({
      schema: 'pack@1',
      id: 'recompose',
      version: '1.2.7',
      files: Object.entries(packFiles)
        .map(([path, content]) => ({
          path,
          sha256: sha(content),
          size: Buffer.byteLength(content),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : 1)),
    }),
    'utf8',
  );

  saveSettings(trustFolder(defaultSettings(), workspace), home);
  const secret = 'desktop-secret-value-575';
  saveSecret(home, 'HUB_TOKEN', secret);

  const model = new ScriptedModel([
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-usage',
            name: 'skill_run',
            args: { pack: 'recompose', script: 'tools/check-record.ts' },
          },
        ],
      },
    },
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-args',
            name: 'skill_run',
            args: {
              pack: 'recompose',
              script: 'tools/check-record.ts',
              args: ['--file', 'record.json'],
              stdin: '%HUB_TOKEN%\n',
            },
          },
        ],
      },
    },
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-skill',
            name: 'skill',
            args: { name: 'recompose' },
          },
        ],
      },
    },
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-submit',
            name: 'recompose_submit',
            args: { record: 'rec-1' },
          },
        ],
      },
    },
    {
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: 'done',
      },
    },
  ]);

  controller = new RuntimeController({
    home,
    userHome: home,
    workspace,
    dataFolder: data,
    localSkillsRoot: skillsRoot,
    model,
    workspaceTools: {
      runtimeExecutable: stagedNode,
      commandSupervisorPath: supervisorPath,
      ghPath: 'unused',
    },
    emit: () => {},
  });

  const sessionId = controller.snapshot().activeSessionId;
  assert.equal(
    (
      await controller.dispatch({
        id: randomUUID(),
        name: 'set-mode',
        sessionId,
        payload: { mode: 'auto' },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await controller.dispatch({
        id: randomUUID(),
        name: 'prompt',
        sessionId,
        payload: { text: 'run recompose check-record' },
      })
    ).ok,
    true,
  );

  await until(() => model.requests.length === 5, 'all model turns');

  const usageResult = model.requests[1]?.messages.find(
    (message) => message.tool_call_id === 'call-usage',
  );
  const usageText = String(usageResult?.content ?? '');
  assert.match(usageText, /Usage: check-record\.ts --file <path>/);
  assert.match(usageText, /Exit code: 2/);

  const argsResult = model.requests[2]?.messages.find(
    (message) => message.tool_call_id === 'call-args',
  );
  const argsText = String(argsResult?.content ?? '');
  assert.match(argsText, /checked:%HUB_TOKEN%/);
  assert.match(argsText, /Exit code: 0/);
  assert.equal(argsText.includes(secret), false);

  const receipt = JSON.parse(
    await readFile(join(workspace, 'check-record-receipt.json'), 'utf8'),
  ) as { execPath: string; args: string[]; stdin: string; cwd: string };
  assert.equal(await realpath(receipt.execPath), await realpath(stagedNode));
  assert.notEqual(
    await realpath(receipt.execPath),
    await realpath(process.execPath),
  );
  assert.deepEqual(receipt.args, ['--file', 'record.json']);
  assert.equal(receipt.stdin, `${secret}\n`);
  assert.equal(await realpath(receipt.cwd), workspace);

  const submitResult = model.requests[4]?.messages.find(
    (message) => message.tool_call_id === 'call-submit',
  );
  const submitText = String(submitResult?.content ?? '');
  assert.match(submitText, /submitted:%HUB_TOKEN%/);
  assert.match(submitText, /Exit code: 0/);
  assert.equal(submitText.includes(secret), false);

  const submitReceipt = JSON.parse(
    await readFile(join(workspace, 'submit-receipt.json'), 'utf8'),
  ) as { execPath: string; args: string[]; token: string };
  assert.equal(
    await realpath(submitReceipt.execPath),
    await realpath(stagedNode),
  );
  assert.notEqual(
    await realpath(submitReceipt.execPath),
    await realpath(process.execPath),
  );
  assert.deepEqual(submitReceipt.args, ['--record', 'rec-1']);
  assert.equal(submitReceipt.token, secret);
});

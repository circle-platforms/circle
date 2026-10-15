import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';
import { ScriptedModel } from '../../../../src/testing.js';
const exec = promisify(execFile);

/** A shared real repository and isolated homes for runtime, native and delivery journeys. */
export async function developerProject(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'circle-developer-journey-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const home = join(root, 'home');
  const data = join(root, 'data');
  await Promise.all([workspace, home, data].map((path) => mkdir(path)));
  const git = async (...args: string[]) =>
    (await exec('git', ['-C', workspace, ...args])).stdout.trim();
  await writeFile(join(workspace, 'README.md'), '# Developer journey\n');
  await writeFile(
    join(workspace, 'main.ts'),
    'export const total = 41;\nconsole.log(total + 1);\n',
  );
  await writeFile(
    join(workspace, 'index.html'),
    '<!doctype html><title>journey</title><button id="increment">increment</button><output id="value">0</output><script>increment.onclick=()=>value.value=Number(value.value)+1</script>',
  );
  await git('init', '--initial-branch=main');
  await git('add', 'README.md', 'main.ts', 'index.html');
  await git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Create developer fixture',
  );
  const baseline = await git('rev-parse', 'HEAD');
  const gh = join(root, 'fixture-gh');
  const ghLog = join(root, 'gh-calls.jsonl');
  const ghState = join(root, 'gh-state.json');
  await writeFile(ghState, JSON.stringify({ draft: true, ci: 'failure' }));
  await writeFile(
    gh,
    `#!/usr/bin/env node
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(ghLog)},JSON.stringify(args)+'\\n');
const state=JSON.parse(fs.readFileSync(${JSON.stringify(ghState)},'utf8'));
if(args[0]==='auth') { console.log('fixture authenticated'); process.exit(0); }
if(args[0]==='pr'&&args[1]==='create') { state.draft=true; console.log('https://github.com/fixture/project/pull/1'); }
else if(args[0]==='pr'&&args[1]==='ready') { if(state.ci!=='success')process.exit(1); state.draft=false; }
else if(args[0]==='pr'&&args[1]==='view') console.log(JSON.stringify({number:1,url:'https://github.com/fixture/project/pull/1',isDraft:state.draft,state:'OPEN',statusCheckRollup:[{name:'fixture',status:'COMPLETED',conclusion:state.ci.toUpperCase()}]}));
else if(args[0]==='pr'&&args[1]==='checks') { console.log(JSON.stringify([{name:'fixture',state:state.ci==='success'?'SUCCESS':'FAILURE',bucket:state.ci==='success'?'pass':'fail',link:'https://github.com/fixture/project/actions/runs/1'}])); if(state.ci!=='success')process.exitCode=1; }
else if(args[0]==='run'&&args[1]==='view') console.log('fixture failing assertion: expected 42');
else { console.error('unexpected fake gh command',args);process.exit(2); }
fs.writeFileSync(${JSON.stringify(ghState)},JSON.stringify(state));
`,
  );
  await chmod(gh, 0o755);
  return {
    root,
    workspace,
    home,
    data,
    baseline,
    gh,
    git,
    model: (replies: ConstructorParameters<typeof ScriptedModel>[0]) =>
      new ScriptedModel(replies),
    setCI: async (ci: 'failure' | 'success') => {
      const state = JSON.parse(await readFile(ghState, 'utf8'));
      await writeFile(ghState, JSON.stringify({ ...state, ci }));
    },
    ghCalls: async () =>
      (await readFile(ghLog, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

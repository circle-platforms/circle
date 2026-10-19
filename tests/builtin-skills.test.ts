import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import { TITLE_MAX_TOKENS } from '../src/session_title.js';
import {
  BUILTIN_SKILL_SOURCE,
  builtinSkillsRoot,
  discoverSkills,
  loadSkillBody,
  parseFrontmatter,
} from '../src/skills.js';
import {
  defaultSettings,
  saveCredentials,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { cleanup, scratch } from './helpers.js';

const repo = fileURLToPath(new URL('..', import.meta.url));
const source = join(repo, 'src', 'builtin_skills', 'create-pr', 'SKILL.md');
const text = readFileSync(source, 'utf8');
const { meta, body } = parseFrontmatter(text);
// How the system prompt lists it (system_prompt.ts skillLine).
const line = `- create-pr: ${meta.description}`;
// A data folder, a workspace and a user home with no skill folder in any of them.
function folders(root: string) {
  return {
    home: join(root, 'home'),
    workspace: join(root, 'project'),
    userHome: join(root, 'user'),
  };
}

test('create-pr ships with Circle and is found when there is no skill folder at all', (t) => {
  const { home, workspace, userHome } = folders(scratch(t));
  const skills = discoverSkills(workspace, home, userHome);
  const skill = skills.find((found) => found.name === 'create-pr');
  assert.ok(skill, 'create-pr was not found');
  assert.equal(skill.source_label, BUILTIN_SKILL_SOURCE);
  assert.equal(skill.description, meta.description);
  assert.equal(skill.path, realpathSync(source));
  assert.equal(
    realpathSync(builtinSkillsRoot()),
    realpathSync(join(repo, 'src', 'builtin_skills')),
  );
  // With no folder of anyone's, every skill there is is one that ships with Circle.
  assert.ok(
    skills.every((found) => found.source_label === BUILTIN_SKILL_SOURCE),
  );
  assert.match(
    loadSkillBody('create-pr', skills),
    /^<skill_content name="create-pr">\n---\nname: create-pr\n/,
  );
  assert.deepEqual(discoverSkills(workspace, home, userHome, false), []);
});

test('a create-pr skill in any user or project skill folder replaces the one that ships with Circle', (t) => {
  // Every folder of docs/skills.md's table, under the user home, the data folder
  // (home) and the workspace (project).
  const places: [string[], string][] = [
    [['user', '.agents', 'skills'], 'Agents'],
    [['user', '.claude', 'skills'], 'Claude'],
    [['user', '.config', 'opencode', 'skills'], 'OpenCode'],
    [['user', '.pi', 'agent', 'skills'], 'Pi'],
    [['home', 'skills'], 'Circle'],
    [['project', '.agents', 'skills'], 'Project Agents'],
    [['project', '.opencode', 'skills'], 'Project OpenCode'],
    [['project', '.pi', 'skills'], 'Project Pi'],
    [['project', '.claude', 'skills'], 'Project Claude'],
    [['project', '.circle', 'skills'], 'Project Circle'],
    [['project', '.agent', 'skills'], 'Project'],
  ];
  for (const [place, label] of places) {
    const root = scratch(t);
    const { home, workspace, userHome } = folders(root);
    assert.equal(
      discoverSkills(workspace, home, userHome).find(
        (skill) => skill.name === 'create-pr',
      )?.source_label,
      BUILTIN_SKILL_SOURCE,
    );
    const folder = join(root, ...place, 'create-pr');
    mkdirSync(folder, { recursive: true });
    writeFileSync(
      join(folder, 'SKILL.md'),
      `---\nname: create-pr\ndescription: our own pull requests (${label})\n---\nUse our release train.\n`,
    );
    const found = discoverSkills(workspace, home, userHome).filter(
      (skill) => skill.name === 'create-pr',
    );
    assert.equal(found.length, 1, label);
    assert.equal(found[0]!.source_label, label);
    assert.equal(found[0]!.description, `our own pull requests (${label})`);
    assert.equal(found[0]!.path, realpathSync(join(folder, 'SKILL.md')));
    assert.match(
      loadSkillBody('create-pr', found),
      /Use our release train\./,
      label,
    );
  }
});

test('the next model request lists create-pr when there is no other skill, and the skill tool loads it', async (t) => {
  const { home, workspace, userHome } = folders(scratch(t));
  for (const folder of [home, workspace, userHome]) mkdirSync(folder);
  const settings = trustFolder(defaultSettings(), workspace);
  saveSettings(settings, home);
  const model = new ScriptedModel([
    {
      message: {
        id: 'load',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'load-skill', name: 'skill', args: { name: 'create-pr' } },
        ],
      },
    },
    { message: { id: 'done', role: 'assistant', content: 'loaded' } },
  ]);
  const runtime = new AgentRuntime({
    home,
    workspace,
    userHome,
    settings,
    model,
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('open a pull request for this');
  const system = model.requests[0]!.system;
  assert.equal(
    system.split('Available skills:\n')[1]?.split('\n\n')[0],
    line,
    'the skill list is the create-pr line alone',
  );
  assert.ok(
    model.requests[0]!.tools.some((tool) => tool.name === 'skill'),
    'the model has the skill tool',
  );
  const result = model.requests[1]!.messages.find(
    (message) =>
      message.role === 'tool' && message.tool_call_id === 'load-skill',
  );
  assert.ok(result, 'the skill tool answered');
  const content = String(result.content);
  assert.match(content, /^<skill_content name="create-pr">/);
  assert.ok(content.includes(body.trim()), 'the whole body reached the model');
  assert.ok(
    content.includes(
      `Base directory for this skill: ${join(realpathSync(builtinSkillsRoot()), 'create-pr')}`,
    ),
  );
});

test('create-pr is short, says what it does and when, and suggests only commands every shell runs', () => {
  assert.equal(meta.name, 'create-pr');
  // The system prompt cuts a description after 160 characters.
  assert.ok(meta.description!.length <= 160, meta.description);
  assert.match(meta.description!, /pull request/);
  assert.match(meta.description!, /Use when /);
  assert.ok(text.split('\n').length < 80, 'readable in one go');
  for (const step of [
    'git status',
    'git branch --show-current',
    'defaultBranchRef',
    'gh auth status',
    'gh auth login',
    'git switch -c',
    'AGENTS.md',
    'CONTRIBUTING.md',
    'git log --oneline -10',
    'git push -u origin <branch>',
    'gh pr view --json number,state,url,isDraft',
    'gh pr create --draft',
    'pull_request_template.md',
    'gh pr checks',
  ])
    assert.ok(body.includes(step), step);
  for (const never of ['git add -A', '--force', '--no-verify'])
    assert.match(
      body,
      new RegExp(`Never[^\\n]*${never}|${never}[^\\n]*unless`),
    );
  // PowerShell, cmd and POSIX shells all run these: no chaining, no command substitution,
  // no pipes or redirection, and only double quotes (cmd has no single quotes). A
  // placeholder such as <branch> is not a redirection.
  const commands = [...body.matchAll(/`((?:git|gh) [^`]+)`/g)].map(
    (match) => match[1]!,
  );
  assert.ok(commands.length >= 15, commands.join('\n'));
  for (const command of commands)
    assert.doesNotMatch(
      command.replace(/<[a-z-]+>/g, 'x'),
      /&&|\||\$\(|[<>]|'|;|\\$/,
      command,
    );
});

test('a dist build carries create-pr, and the compiled program finds it beside itself and lists it to the model', async (t) => {
  const root = scratch(t);
  const dist = join(root, 'dist');
  // An installed program finds its packages in the folder above dist, as app/ in a release.
  symlinkSync(
    join(repo, 'node_modules'),
    join(root, 'node_modules'),
    'junction',
  );
  // The two steps of `npm run build`, into a folder of this test's own.
  const tsc = spawnSync(
    process.execPath,
    [
      join(repo, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p',
      'tsconfig.build.json',
      '--outDir',
      dist,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(tsc.status, 0, tsc.stdout + tsc.stderr);
  const assets = spawnSync(
    process.execPath,
    [
      join(repo, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join('scripts', 'copy-assets.ts'),
      dist,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(assets.status, 0, assets.stdout + assets.stderr);
  const shipped = join(dist, 'builtin_skills', 'create-pr', 'SKILL.md');
  assert.equal(readFileSync(shipped, 'utf8'), text);
  // The compiled module looks beside itself, not in the checkout's src/.
  const compiled = (await import(
    pathToFileURL(join(dist, 'skills.js')).href
  )) as typeof import('../src/skills.js');
  const { home, workspace, userHome } = folders(root);
  for (const folder of [home, workspace, userHome]) mkdirSync(folder);
  assert.equal(
    compiled
      .discoverSkills(workspace, home, userHome)
      .find((skill) => skill.name === 'create-pr')?.path,
    realpathSync(shipped),
  );

  // The compiled program in print mode, against a local endpoint.
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  const server = createServer(async (request, response) => {
    let payload = '';
    for await (const chunk of request) payload += chunk;
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const parsed = JSON.parse(payload);
    if (parsed.max_tokens !== TITLE_MAX_TOKENS) bodies.push(parsed);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'dist answered' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup(
    t,
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  let settings = defaultSettings();
  settings.initialized = true;
  settings.auth = {
    ...settings.auth,
    protocol: 'openai',
    model: 'builtin-skill-dist',
    base_url: `http://127.0.0.1:${address.port}/v1`,
  };
  settings = trustFolder(settings, workspace);
  saveSettings(settings, home);
  saveCredentials({ api_key: 'synthetic-test-key' }, home);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/^(?:https?_proxy|no_proxy|NODE_USE_ENV_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CIRCLE_TRUST_CERTS)$/i.test(
          name,
        ),
    ),
  );
  const run = await new Promise<{ code: number | null; stderr: string }>(
    (done, reject) => {
      const child = spawn(
        process.execPath,
        [join(dist, 'cli.js'), '-p', 'open a pull request', workspace],
        {
          env: {
            ...env,
            CIRCLE_HOME: home,
            // Its user folders are this test's, not the machine's.
            HOME: userHome,
            USERPROFILE: userHome,
            CIRCLE_NO_MODELS_REFRESH: '1',
            CIRCLE_NO_UPDATE_CHECK: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let stderr = '';
      child.stderr.on('data', (data) => (stderr += data));
      child.stdout.resume();
      child.once('error', reject);
      const timer = setTimeout(() => child.kill(), 60_000);
      child.once('close', (code) => {
        clearTimeout(timer);
        done({ code, stderr });
      });
      child.stdin.end();
    },
  );
  assert.equal(run.code, 0, run.stderr);
  assert.equal(bodies.length, 1);
  const system = bodies[0]!.messages[0]!;
  assert.equal(system.role, 'system');
  assert.equal(
    String(system.content).split('Available skills:\n')[1]?.split('\n\n')[0],
    line,
  );
});

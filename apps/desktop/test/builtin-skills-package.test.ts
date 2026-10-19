import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'esbuild';
// The archive library @electron/packager packs app.asar with (scripts/package.mjs).
import { createPackageWithOptions } from '@electron/asar';
import { copyRuntimeAssets } from '../scripts/runtime-assets.mjs';
import {
  buildBundledExtensions,
  shareExtensionError,
} from '../scripts/extensions.mjs';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { parseFrontmatter } from '../../../src/skills.ts';

const require = createRequire(import.meta.url);
const electron = require('electron') as string;
const source = fileURLToPath(
  new URL('../../../src/builtin_skills/create-pr/SKILL.md', import.meta.url),
);
// As in scripts/build.mjs: ssh2's optional .node accelerators stay to runtime.
const nativeBinaries: Plugin = {
  name: 'native-binaries',
  setup(api) {
    api.onResolve({ filter: /\.node$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};
// The worker as a utility process runs it: process.parentPort carries the commands. One
// prompt, then close once the scripted answer is in the snapshot.
const wrapper = `
let listener, prompted = false;
setTimeout(() => { console.log('WORKER_TIMEOUT'); process.exit(3); }, 60000).unref();
Object.defineProperty(process, 'parentPort', { value: {
  on(_name, callback) { listener = callback; },
  postMessage(message) {
    if (message.type === 'update' && !prompted) {
      prompted = true;
      console.log('SKILLS=' + JSON.stringify(message.update.snapshot.skills.map(({ name, scope, path }) => ({ name, scope, path }))));
      queueMicrotask(() => listener({ data: { id: 'prompt', name: 'prompt', sessionId: message.update.snapshot.activeSessionId, payload: { text: 'open a pull request' } } }));
    }
    if (message.type === 'update' && message.update.snapshot.sessions.some((session) => session.messages.some((item) => item.text === 'packaged skill answered')))
      queueMicrotask(() => listener({ data: { id: 'finish', name: 'close', payload: {} } }));
    if (message.type === 'reply' && message.reply.id === 'finish') { console.log('WORKER_DONE'); process.exit(0); }
  },
} });
const { pathToFileURL } = await import('node:url');
await import(pathToFileURL(process.argv.at(-1)).href);
`;

test(
  'the packaged runtime finds create-pr inside app.asar and lists it to the model',
  { timeout: 180_000 },
  async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'circle-builtin-skills-')),
    );
    try {
      // dist/ as scripts/build.mjs lays it out: the worker bundle and what it reads beside it.
      const app = join(root, 'app');
      const dist = join(app, 'dist');
      await build({
        entryPoints: [
          fileURLToPath(new URL('../src/runtime-worker.ts', import.meta.url)),
        ],
        outfile: join(dist, 'runtime-worker.mjs'),
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'esm',
        banner: {
          js: "import { createRequire as circleCreateRequire } from 'node:module'; const require = circleCreateRequire(import.meta.url);",
        },
        plugins: [shareExtensionError(), nativeBinaries],
        external: [
          'koffi',
          'node-pty',
          'typescript-language-server',
          'typescript',
          'cpu-features',
        ],
        logLevel: 'error',
      });
      await copyRuntimeAssets(dist);
      await buildBundledExtensions(dist);
      const text = await readFile(source, 'utf8');
      assert.equal(
        await readFile(
          join(dist, 'builtin_skills', 'create-pr', 'SKILL.md'),
          'utf8',
        ),
        text,
      );
      // Packed as scripts/package.mjs packs it, with the same folders left unpacked.
      const archive = join(root, 'package', 'app.asar');
      await mkdir(join(root, 'package'));
      await createPackageWithOptions(app, archive, {
        unpack: '**/{node_modules,tools}/**',
      });
      assert.equal(
        existsSync(join(`${archive}.unpacked`, 'dist', 'builtin_skills')),
        false,
        'the skills stay inside the archive',
      );

      const home = join(root, 'home');
      const workspace = join(root, 'workspace');
      await mkdir(home);
      await mkdir(workspace);
      const settings = trustFolder(defaultSettings(), workspace);
      settings.initialized = true;
      settings.update_check = false;
      saveSettings(settings, home);
      await writeFile(
        join(home, 'desktop-session.json'),
        JSON.stringify({ workspace, sessionId: 'missing-fixture-session' }),
      );
      const requests = join(root, 'requests.jsonl');
      const fixture = join(root, 'fixture.json');
      await writeFile(
        fixture,
        JSON.stringify({
          requestsPath: requests,
          replies: [
            {
              message: {
                id: 'answer',
                role: 'assistant',
                content: 'packaged skill answered',
              },
            },
          ],
        }),
      );
      const script = join(root, 'wrapper.mjs');
      await writeFile(script, wrapper);
      // Electron's own Node, which reads into app.asar as the utility process does.
      const child = spawn(
        electron,
        [script, join(archive, 'dist', 'runtime-worker.mjs')],
        {
          cwd: workspace,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            // The user's skill folders are this test's, not the machine's.
            HOME: home,
            USERPROFILE: home,
            CIRCLE_HOME: home,
            CIRCLE_DESKTOP_RUNTIME_HOME: home,
            CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixture,
            CIRCLE_WORKBENCH_TEST_PROFILE: '1',
            CIRCLE_NO_MODELS_REFRESH: '1',
            CIRCLE_NO_UPDATE_CHECK: '1',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (data) => (stdout += data));
      child.stderr.on('data', (data) => (stderr += data));
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      assert.equal(code, 0, stdout + stderr);
      assert.match(stdout, /WORKER_DONE/);
      const listed = JSON.parse(
        stdout.match(/^SKILLS=(.*)$/m)?.[1] ?? '[]',
      ) as { name: string; scope: string; path: string }[];
      assert.deepEqual(
        listed.find((skill) => skill.name === 'create-pr'),
        {
          name: 'create-pr',
          scope: 'bundled',
          path: join(
            archive,
            'dist',
            'builtin_skills',
            'create-pr',
            'SKILL.md',
          ),
        },
      );
      const sent = (await readFile(requests, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { system: string });
      assert.equal(sent.length, 1);
      assert.ok(
        sent[0]!.system.includes(
          `\n- create-pr: ${parseFrontmatter(text).meta.description}`,
        ),
        'the model is told about create-pr',
      );
    } finally {
      // Windows keeps the folder busy for a moment after the worker exits.
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 250,
      });
    }
  },
);

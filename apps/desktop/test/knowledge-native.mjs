// Development Electron acceptance with synthetic content and a loopback protocol peer.
// The native picker fixture selects only the scratch files created below.
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { KnowledgeService } from '../../../src/knowledge/service.ts';
import { sha256, syncObjectId } from '../../../src/knowledge/canonical.ts';
import { installedPersonalPacks } from '../../../src/knowledge/packs.ts';
import {
  defaultSettings,
  saveSettings,
  trustFolder,
} from '../../../src/settings.ts';
import { backgroundMcpConnection } from '../../../src/mcp_loader.ts';
import { AuthorizedServer } from '../../../tests/fixtures/knowledge-sync/authorized-server.ts';
import { setViewport } from './helpers/viewport.mjs';
import { waitAnimationFrames } from './helpers/frame-readiness.mjs';
import { closeNativeSettings } from './helpers/native-settings.mjs';
import { observePage } from './helpers/diagnostics.mjs';
import { sourceEvidence, rendererEvidence } from './helpers/evidence.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const output = join(root, 'artifacts/knowledge/development');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), 'circle-knowledge-native-'));
const home = join(temp, 'data/runtime-home');
const workspace = join(temp, 'project');
const packDirectory = join(temp, 'selected-pack');
await Promise.all(
  [home, workspace, packDirectory].map((p) => mkdir(p, { recursive: true })),
);
const peer = new AuthorizedServer(join(temp, 'peer'));
await peer.start();
peer.peer.mode = 'local';
peer.documents = [
  {
    id: sha256('team-memory'),
    version: sha256('team-memory-v1'),
    title: '团队约定 · Team preferences',
    path: '/',
    markdown:
      '先检查来源，再整理结论。\nCheck sources before drawing conclusions.',
  },
];
peer.sharedDocuments = [
  {
    id: sha256('shared-memory'),
    version: sha256('shared-memory-v1'),
    title: '共享偏好 · Shared preferences',
    path: '/',
    markdown: 'SHARED_VIEW_ONLY_NEVER_AUTO_LOAD',
    space: 'synthetic-colleague',
  },
];
const settings = trustFolder(defaultSettings(), workspace);
settings.theme = 'dark';
settings.mcp_servers = [
  {
    name: 'Synthetic workspace',
    url: peer.origin + '/mcp',
    transport: 'streamable_http',
    headers: { authorization: 'Bearer ' + peer.token },
  },
];
settings.knowledge_sync = {
  server: settings.mcp_servers[0].name,
  binding: backgroundMcpConnection(home, settings.mcp_servers[0], () => ({}))
    .binding,
};
saveSettings(settings, home);
const service = new KnowledgeService(home);
const signal = new AbortController().signal;
const objects = [];
const add = (kind, body) => {
  const object = { schema: 'personal-sync-object@1', kind, body };
  objects.push(object);
  return syncObjectId(object);
};
const directory = randomUUID();
add('directory_revision', {
  item_id: directory,
  parents: [],
  parent_directory: null,
  name: '',
});
const raw = Buffer.from(
  '合成检查记录 · Synthetic check record\n本机副本保留，团队副本独立。\nLocal copies remain. Team copies are independent.\n' +
    '只使用合成输入。Use synthetic inputs only.\n'.repeat(8),
);
const bytes = add('bytes', { bytes_base64: raw.toString('base64') });
const sourceObject = add('source_revision', {
  item_id: randomUUID(),
  parents: [],
  directory_id: directory,
  name: '合成检查记录.txt',
  media_type: 'text/plain',
  size: raw.length,
  raw_sha256: sha256(raw),
  chunks: [bytes],
});
const quotation = add('bytes', {
  bytes_base64: raw
    .subarray(raw.indexOf('\n') + 1, raw.length - 1)
    .toString('base64'),
});
const entryItem = randomUUID();
add('entry_revision', {
  item_id: entryItem,
  parents: [],
  directory_id: directory,
  content: {
    kind: 'observation',
    statement:
      '本机副本与团队副本彼此独立 · Local and team copies are independent',
    data: {},
    applicability: null,
  },
  grounds: [
    { source: sourceObject, quotation, parser: 'text@1', selector: 'l/2-11' },
  ],
});
add('entry_revision', {
  item_id: randomUUID(),
  parents: [],
  directory_id: directory,
  content: {
    kind: 'observation',
    statement: '待验证的合成结论 · Synthetic conclusion awaiting verification',
    data: {},
    applicability: null,
  },
  grounds: [],
});
add('entry_revision', {
  item_id: randomUUID(),
  parents: [],
  directory_id: directory,
  content: {
    kind: 'observation',
    statement: '长标题与路径边界 · Long synthetic title '.repeat(16),
    data: {},
    applicability: null,
  },
  grounds: [],
});
service.prepare({ expected_head: null, objects }).commit(signal);
const head = () => service.withStore((s) => s.head);
const memory = (title, markdown, state = 'enabled') =>
  service
    .prepareMemory({ expected_head: head(), title, markdown, state })
    .commit(signal);
memory(
  '我的偏好 · My preferences',
  '先写检查计划，再保留结果。\nWrite a check plan and keep the results.',
);
memory('已停用的偏好 · Disabled preferences', 'DISABLED_MEMORY', 'disabled');
memory('冲突偏好 · Conflicting preferences', 'BASE_PREFERENCE');
service.withStore((s) => {
  const row = s
    .items()
    .find(
      (i) =>
        i.kind === 'memory_revision' &&
        s.read(i.heads[0]).body.title.startsWith('冲突偏好'),
    );
  const old = s.read(row.heads[0]);
  const heads = [
    '优先保留来源 · Keep sources first',
    '优先保留摘要 · Keep summaries first',
  ]
    .map((markdown) =>
      s.put({ ...old, body: { ...old.body, parents: row.heads, markdown } }),
    )
    .sort();
  const items = s.items().map((i) => ({
    kind: i.kind,
    item_id: i.item_id,
    heads: i.item_id === row.item_id ? heads : i.heads,
  }));
  const page = s.put({
    schema: 'personal-sync-object@1',
    kind: 'inventory_page',
    body: { items },
  });
  const expected = s.head;
  s.apply(expected, () =>
    s.put({
      schema: 'personal-sync-object@1',
      kind: 'snapshot',
      body: { parents: [expected], pages: [page] },
    }),
  );
});
assert.equal(
  service.withStore(
    (s) =>
      s.observations().find((v) => s.read(v.object).body.item_id === entryItem)
        ?.status,
  ),
  'verified',
);
const packFiles = {
  'SKILL.md':
    '---\nname: synthetic-native-workflow\ndescription: Synthetic local validation\n---\nUse synthetic input only.\n',
  'workflow.json': '{}',
  'requirements.json': '{}',
  'checks.json': '{}',
  'slots.schema.json': '{}',
};
const manifest = {
  schema: 'pack@1',
  id: 'synthetic-native-workflow',
  version: '1.0.0',
  kind: 'workflow',
  title: '合成核验流程 · Synthetic verification',
  description:
    '检查合成输入，并保留验收结果。Check synthetic inputs and retain acceptance results.',
  files: Object.entries(packFiles)
    .map(([path, text]) => ({
      path,
      size: Buffer.byteLength(text),
      sha256: sha256(text),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1)),
};
await Promise.all(
  Object.entries(packFiles).map(([name, text]) =>
    writeFile(join(packDirectory, name), text),
  ),
);
await writeFile(join(packDirectory, 'pack.json'), JSON.stringify(manifest));
await writeFile(join(packDirectory, 'hooks.json'), 'DO_NOT_COPY');
const importPath = join(workspace, 'original source.txt');
const importBytes = Buffer.from(
  '\ufeff原始合成文件\r\nSynthetic source with whitespace  \r\n',
);
await writeFile(importPath, importBytes);
const fixturePath = join(temp, 'model.json');
await writeFile(
  fixturePath,
  JSON.stringify({
    requestsPath: join(temp, 'requests.jsonl'),
    replies: [
      {
        message: {
          id: 'knowledge-ready',
          role: 'assistant',
          content: 'synthetic knowledge fixture ready',
        },
      },
    ],
  }),
);
const env = {
  ...process.env,
  CIRCLE_HOME: join(temp, 'cli-home'),
  CIRCLE_WORKBENCH_DATA_DIR: join(temp, 'data'),
  CIRCLE_WORKBENCH_MODE: 'live',
  CIRCLE_WORKBENCH_LANGUAGE: 'en',
  CIRCLE_WORKBENCH_TEST_PROFILE: JSON.stringify({
    workspace,
    knowledgePackDirectory: packDirectory,
    knowledgeSourceFile: importPath,
  }),
  CIRCLE_DESKTOP_RUNTIME_FIXTURE: fixturePath,
  CIRCLE_NO_UPDATE_CHECK: '1',
  CIRCLE_NO_MODELS_REFRESH: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const checks = [],
  shots = [],
  errors = [];
let app,
  page,
  failed = false;
async function launch() {
  app = await electron.launch({
    chromiumSandbox: true,
    executablePath: require('electron'),
    args: [resolve(root)],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  observePage(page, errors);
  await page.locator('.composer textarea').waitFor();
}
const route = async (name, query = '') => {
  await closeNativeSettings(page);
  await page.evaluate(
    (hash) => {
      location.hash = hash;
    },
    '/page/' + name + query,
  );
  await page
    .locator(
      name === 'sync'
        ? '.knowledge-sync-settings'
        : name === 'settings'
          ? '.settings-dialog'
          : '[data-knowledge-section="' + name + '"]',
    )
    .waitFor();
};
const rows = () => page.locator('.knowledge-row');
const choose = async (text) => {
  await rows().filter({ hasText: text }).click();
  await page
    .locator('.knowledge-inspector h2')
    .filter({ hasText: text })
    .waitFor();
};
const button = (name) => page.getByRole('button', { name, exact: true });
const dialog = () => page.locator('.knowledge-dialog[role="dialog"]');
async function saveDialog() {
  await dialog()
    .getByRole('button', { name: 'check changes', exact: true })
    .click();
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
}
async function shot(name) {
  await waitAnimationFrames(page, {
    label: 'knowledge capture ready',
    timeoutMs: 10000,
  });
  const readLayout = () =>
    page.evaluate(() => {
      const box = (selector) => {
        const el = document.querySelector(selector);
        if (!el || !el.checkVisibility()) return null;
        const r = el.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          right: r.right,
          bottom: r.bottom,
        };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        theme: document.documentElement.dataset.theme,
        sidebar: box('.desktop-sidebar'),
        main: box('.knowledge-list-pane'),
        inspector: box('.knowledge-inspector'),
        dialog: box('.knowledge-dialog[role="dialog"]'),
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
  const assertLayout = (layout) => {
    assert.equal(layout.overflow, false, name + ': no window overflow');
    for (const key of ['main', 'inspector', 'dialog'])
      if (layout[key]) {
        assert.ok(
          layout[key].x >= 0 && layout[key].y >= 0,
          name + ': ' + key + ' starts inside the window',
        );
        assert.ok(
          layout[key].right <= layout.viewport.width + 1,
          name + ': ' + key + ' fits horizontally',
        );
        assert.ok(
          layout[key].bottom <= layout.viewport.height + 1,
          name + ': ' + key + ' fits vertically',
        );
      }
    if (layout.viewport.width >= 1180 && layout.inspector && layout.main) {
      assert.equal(
        Math.round(layout.inspector.width),
        380,
        name + ': inspector width',
      );
      assert.equal(
        Math.round(layout.sidebar.width),
        232,
        name + ': navigation width',
      );
    }
  };
  const firstFrame = await readLayout();
  assertLayout(firstFrame);
  // Capture the settled component without hiding a transient positioning failure.
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== 'running' ||
          a.effect?.getTiming().iterations === Infinity,
      ),
  );
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const layout = await readLayout();
  assertLayout(layout);
  const file = name + '.png';
  await page.screenshot({ path: join(output, file) });
  shots.push({
    file,
    sha256: sha256(await readFile(join(output, file))),
    firstFrame,
    ...layout,
  });
  console.log('captured ' + file);
}
try {
  await launch();
  await setViewport(app, page, { width: 1440, height: 900 }, { show: true });
  await page
    .locator('.composer textarea')
    .fill('start synthetic knowledge validation');
  await button('send message').click();
  await page
    .getByText('synthetic knowledge fixture ready', { exact: true })
    .waitFor();
  await page.locator('.sidebar-primary a[href="#/page/knowledge"]').click();
  await page.getByLabel('search knowledge', { exact: true }).fill('本机');
  await page.waitForFunction(
    () => document.querySelectorAll('.knowledge-row').length === 1,
  );
  assert.match(await rows().first().innerText(), /本机副本与团队副本彼此独立/);
  await page.getByLabel('search knowledge', { exact: true }).fill('');
  await rows().filter({ hasText: '合成检查记录.txt' }).waitFor();
  checks.push(
    'Chinese two-character search reaches the local index through renderer and IPC',
  );
  await choose('本机副本与团队副本彼此独立');
  await button('open original').click();
  assert.equal(
    await page.locator('.knowledge-original').textContent(),
    raw.toString('utf8'),
  );
  await page.keyboard.press('Escape');
  await button('expand quotation').click();
  await shot('en-dark-1440-source-expanded');
  await button('collapse quotation').click();
  assert.equal(await button('share to team…').isDisabled(), true);
  await page.locator('.knowledge-inspector-actions span[tabindex="0"]').focus();
  await page.getByRole('tooltip').waitFor();
  await shot('en-dark-1440-local-share-tooltip');
  await button('change sync mode').click();
  await button('Sync to Hub…').click();
  assert.equal(peer.peer.mode, 'local');
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  assert.equal(peer.peer.mode, 'hub');
  await button('sync now').click();
  const childSource = `
    import { RuntimeController } from './apps/desktop/src/runtime-controller.ts';
    import { ScriptedModel } from './src/testing.ts';
    const controller = new RuntimeController({ home: process.env.KNOWLEDGE_NATIVE_HOME, workspace: process.env.KNOWLEDGE_NATIVE_WORKSPACE, userHome: process.env.KNOWLEDGE_NATIVE_HOME, model: new ScriptedModel([]), emit() {} });
    try {
      await controller.initialize();
      const reply = await controller.dispatch({ id: 'second-process-status', name: 'knowledge', payload: { op: 'settings' }, sessionId: controller.snapshot().activeSessionId });
      if (!reply.ok) throw Error(reply.error);
      console.log(JSON.stringify(reply.data.sync));
    } finally { await controller.close(); }
  `;
  const child = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '-e', childSource],
    {
      cwd: resolve(root, '../..'),
      env: {
        ...env,
        KNOWLEDGE_NATIVE_HOME: home,
        KNOWLEDGE_NATIVE_WORKSPACE: workspace,
      },
      timeout: 15000,
    },
  );
  const observed = JSON.parse(child.stdout.trim().split('\n').at(-1));
  assert.equal(observed.mode, 'hub');
  assert.equal(observed.server, 'Synthetic workspace');
  checks.push(
    'a second runtime process reads the same journal and selected sync state while Electron remains open',
  );
  await route('knowledge');
  await choose('本机副本与团队副本彼此独立');
  await button('share to team…').waitFor({ state: 'visible' });
  await button('share to team…').click();
  await dialog()
    .getByRole('button', { name: 'check changes', exact: true })
    .click();
  assert.equal(peer.shareCalls.length, 0);
  await shot('en-dark-1440-share-preview');
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  assert.equal(peer.shareCalls.length, 1);
  checks.push(
    'team share requires current native mapping, preview and explicit confirmation',
  );
  await route('sync');
  await button('only on this device…').click();
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  await route('knowledge');
  await button('import file…').click();
  assert.equal(
    service.withStore(
      (s) => s.items().filter((i) => i.kind === 'source_revision').length,
    ),
    1,
  );
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  assert.ok(
    service.withStore((s) =>
      s
        .items()
        .filter((i) => i.kind === 'source_revision')
        .some((i) => s.sourceBytes(i.heads[0]).equals(importBytes)),
    ),
  );
  checks.push(
    'native-selected original bytes preserve BOM, CRLF and trailing spaces',
  );
  await button('new folder…').click();
  await dialog().getByLabel('title', { exact: true }).fill('Native folder');
  await saveDialog();
  await rows().filter({ hasText: 'Native folder' }).click();
  await page
    .locator('.knowledge-crumb')
    .filter({ hasText: 'Native folder' })
    .waitFor();
  await button('new…').click();
  await dialog()
    .getByLabel('content', { exact: true })
    .fill('NATIVE_FOLDER_ENTRY');
  await saveDialog();
  await choose('NATIVE_FOLDER_ENTRY');
  await button('edit…').click();
  await dialog()
    .getByLabel('content', { exact: true })
    .fill('NATIVE_MOVED_ENTRY');
  await saveDialog();
  await button('move…').click();
  await dialog()
    .getByLabel('destination folder', { exact: true })
    .selectOption({ label: '/' });
  await saveDialog();
  await route('knowledge');
  await choose('NATIVE_MOVED_ENTRY');
  await button('delete…').click();
  await saveDialog();
  await rows()
    .filter({ hasText: 'NATIVE_MOVED_ENTRY' })
    .waitFor({ state: 'hidden' });
  checks.push(
    'folder creation, scoped entry editing, move and deletion preserve revision history through confirmed actions',
  );
  await route('memory');
  await button('new…').click();
  await dialog()
    .getByLabel('title', { exact: true })
    .fill('Native approved preference');
  await dialog()
    .getByLabel('content', { exact: true })
    .fill('NATIVE_CONFIRMED_MEMORY');
  const before = head();
  await dialog()
    .getByRole('button', { name: 'check changes', exact: true })
    .click();
  assert.equal(head(), before);
  await dialog().getByRole('button', { name: 'cancel', exact: true }).click();
  assert.equal(head(), before);
  await button('new…').click();
  await dialog()
    .getByLabel('title', { exact: true })
    .fill('Native approved preference');
  await dialog()
    .getByLabel('content', { exact: true })
    .fill('NATIVE_CONFIRMED_MEMORY');
  await saveDialog();
  await choose('Native approved preference');
  await button('edit…').click();
  await dialog()
    .getByLabel('content', { exact: true })
    .fill('NATIVE_EDITED_MEMORY  \n');
  await saveDialog();
  await button('version history').last().click();
  await page.locator('.knowledge-history-row').first().waitFor();
  await shot('en-dark-1440-memory-history');
  await page.keyboard.press('Escape');
  await route('memory');
  await choose('冲突偏好');
  const conflictHeads = service.withStore(
    (s) =>
      s
        .items()
        .find(
          (i) =>
            i.kind === 'memory_revision' &&
            s.read(i.heads[0]).body.title.startsWith('冲突偏好'),
        ).heads,
  );
  await button('resolve conflict…').click();
  await dialog()
    .getByLabel('content', { exact: true })
    .fill('NATIVE_EXPLICIT_RESOLUTION');
  await shot('en-dark-1440-conflict-editor');
  await saveDialog();
  service.withStore((s) => {
    const row = s
      .items()
      .find(
        (i) =>
          i.kind === 'memory_revision' &&
          s.read(i.heads[0]).body.title.startsWith('冲突偏好'),
      );
    assert.equal(row.heads.length, 1);
    assert.deepEqual(s.read(row.heads[0]).body.parents, conflictHeads);
  });
  checks.push(
    'create/cancel/edit/history and conflict resolution persist actual approved revisions',
  );
  await button('team memory').click();
  await choose('团队约定');
  assert.equal(await button('edit…').count(), 0);
  assert.equal(await button('share to team…').count(), 0);
  await route('sync');
  await button('disconnect').click();
  await closeNativeSettings(page);
  await rows().filter({ hasText: '团队约定' }).waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .locator('.knowledge-inspector h2')
      .filter({ hasText: '团队约定' })
      .count(),
    0,
  );
  await route('sync');
  await page
    .getByLabel('MCP connection', { exact: true })
    .selectOption({ label: 'Synthetic workspace' });
  await button('use this connection…').click();
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  checks.push(
    'team memory is read-only and disconnect invalidates its visible list and details',
  );
  await route('workflows');
  await button('import workflow or skill…').click();
  assert.equal(
    service.withStore(
      (s) => s.items().filter((i) => i.kind === 'pack_manifest').length,
    ),
    0,
  );
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  assert.equal(installedPersonalPacks(home).length, 0);
  await page
    .locator('.knowledge-table tr[tabindex]')
    .filter({ hasText: manifest.title })
    .click();
  await button('install files…').click();
  assert.equal(installedPersonalPacks(home).length, 0);
  await shot('en-dark-1440-workflow-install');
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  assert.equal(installedPersonalPacks(home).length, 1);
  await page.locator('.knowledge-inspector .knowledge-state.enabled').waitFor();
  checks.push(
    'workflow manifest and matching files install separately; original hook stays outside installed files',
  );
  await route('sync');
  await button('Sync to Hub…').click();
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  await button('sync now').click();
  await button('only on this device…').click();
  assert.equal(peer.peer.mode, 'hub');
  const impact = await dialog().innerText();
  assert.match(impact, /123 bytes/);
  assert.match(impact, /unknown/);
  await shot('en-dark-1440-local-mode-impact');
  await dialog().getByRole('button', { name: 'cancel', exact: true }).click();
  assert.equal(peer.peer.mode, 'hub');
  await button('only on this device…').click();
  await dialog()
    .getByRole('button', { name: 'confirm change', exact: true })
    .click();
  await dialog().waitFor({ state: 'hidden' });
  assert.equal(peer.peer.mode, 'local');
  assert.equal(peer.shareCalls.length, 1);
  checks.push(
    'local-only switch displays exact loopback pre-check counts, cancel has no effect, confirm changes mode and preserves team copy',
  );
  for (const language of ['en', 'zh-CN']) {
    for (const theme of ['dark', 'light']) {
      await route('settings');
      const settingsDialog = page.locator('.settings-dialog');
      await settingsDialog.waitFor();
      await settingsDialog
        .getByRole('button', {
          name: language === 'en' ? 'English' : '简体中文',
          exact: true,
        })
        .click();
      await settingsDialog
        .getByRole('button', {
          name: theme === 'dark' ? /^(dark|深色)$/ : /^(light|浅色)$/,
          exact: true,
        })
        .click();
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        theme,
      );
      await closeNativeSettings(page);
      for (const width of [1440, 1024]) {
        await setViewport(app, page, { width, height: 900 }, { show: true });
        await route('knowledge');
        await choose('本机副本与团队副本彼此独立');
        await shot(`${language}-${theme}-${width}-knowledge`);
        if (width === 1024) {
          await button(language === 'en' ? 'back to list' : '返回列表').click();
          await rows().first().waitFor();
          await shot(`${language}-${theme}-${width}-knowledge-list`);
        }
        await route('memory');
        await choose('我的偏好');
        await shot(`${language}-${theme}-${width}-memory`);
        if (width === 1024) {
          await button(language === 'en' ? 'back to list' : '返回列表').click();
          await rows().first().waitFor();
          await shot(`${language}-${theme}-${width}-memory-list`);
        }
        await route('workflows');
        await page.locator('.knowledge-table tr[tabindex]').first().click();
        await page
          .locator('.knowledge-inspector h2')
          .filter({ hasText: manifest.title })
          .waitFor();
        await shot(`${language}-${theme}-${width}-workflows`);
        if (width === 1024) {
          await button(language === 'en' ? 'back to list' : '返回列表').click();
          await page.locator('.knowledge-table').first().waitFor();
          await shot(`${language}-${theme}-${width}-workflows-list`);
        }
        await route('sync');
        await shot(`${language}-${theme}-${width}-sync`);
      }
    }
  }
  await route('knowledge', '?q=does-not-exist');
  await page.getByText('没有符合条件的知识', { exact: true }).waitFor();
  await shot('zh-CN-light-1024-empty');
  await setViewport(app, page, { width: 700, height: 900 }, { show: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await route('knowledge');
  await rows().first().focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const keyboardTitle = await page
    .locator('.knowledge-row:focus .knowledge-row-title')
    .innerText();
  await page.keyboard.press('Enter');
  await page.locator('.knowledge-shell.has-selection').waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains('knowledge-back'),
  );
  await page
    .locator('.knowledge-inspector h2')
    .filter({ hasText: keyboardTitle })
    .waitFor();
  await shot('zh-CN-light-700-keyboard-reduced-motion');
  await button('返回列表').click();
  await page.waitForFunction(
    () =>
      document.activeElement?.classList.contains('knowledge-row') &&
      document.activeElement.getAttribute('aria-selected') === 'true',
  );
  checks.push(
    '1024 details return to the list; 700 navigation, keyboard selection and reduced motion remain usable',
  );
  let finalHead = head();
  await app.close();
  app = undefined;
  await launch();
  await route('memory');
  await choose('Native approved preference');
  assert.equal(
    await page.locator('.knowledge-detail-text').innerText(),
    'NATIVE_EDITED_MEMORY',
  );
  assert.equal(head(), finalHead);
  assert.equal(installedPersonalPacks(home).length, 1);
  checks.push(
    'closing and reopening Electron retains approved revisions and actual installed files',
  );
  const rootDirectory = service.withStore(
    (s) =>
      s.items().find((i) => i.kind === 'directory_revision' && i.path === '/')
        .item_id,
  );
  const paginationObjects = Array.from({ length: 101 }, (_, n) => ({
    schema: 'personal-sync-object@1',
    kind: 'entry_revision',
    body: {
      item_id: randomUUID(),
      parents: [],
      directory_id: rootDirectory,
      content: {
        kind: 'observation',
        statement: 'Pagination sample ' + String(n).padStart(3, '0'),
        data: {},
        applicability: null,
      },
      grounds: [],
    },
  }));
  for (let n = 0; n < paginationObjects.length; n += 64)
    service
      .prepare({
        expected_head: head(),
        objects: paginationObjects.slice(n, n + 64),
      })
      .commit(signal);
  await route('knowledge');
  await page
    .locator('.knowledge-heading')
    .getByRole('button', { name: /^(refresh|刷新)$/, exact: true })
    .click();
  await page.waitForFunction(
    () => document.querySelectorAll('.knowledge-row').length === 100,
  );
  await button(/^(load more|加载更多)$/).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.knowledge-row').length === 107,
  );
  await waitAnimationFrames(page, {
    label: 'expanded list committed',
    timeoutMs: 10000,
  });
  // A later timer on the same event loop observes the existing five-second poll,
  // then the worker reply is a barrier for any earlier dispatched list request.
  await page.evaluate(
    () => new Promise((resolve) => setTimeout(resolve, 6000)),
  );
  await page.evaluate(async () => {
    const state = await window.circleDesktop.runtimeState();
    await window.circleDesktop.runtimeCommand({
      id: 'pagination-barrier',
      name: 'knowledge',
      sessionId: state.snapshot.activeSessionId,
      payload: { op: 'settings' },
    });
  });
  await waitAnimationFrames(page, {
    label: 'pagination reply applied',
    timeoutMs: 10000,
  });
  assert.equal(await rows().count(), 107);
  finalHead = head();
  checks.push(
    'loading more preserves every appended row across the live five-second refresh interval',
  );
  assert.deepEqual(errors, []);
  const receipt = {
    schema: 'circle-knowledge-native-evidence@1',
    packaged: false,
    platform: process.platform,
    architecture: process.arch,
    versions: await app.evaluate(() => process.versions),
    synthetic: true,
    peer: 'loopback fake using pinned protocol contracts; not a real Hub',
    nativeSelection:
      'test-profile selection of scratch originals; public renderer path requests remain forbidden',
    checks,
    errors,
    shots,
    finalHead,
    shareCount: peer.shareCalls.length,
    source: await sourceEvidence(),
    renderer: await rendererEvidence(root),
  };
  await writeFile(
    join(output, 'receipt.json'),
    JSON.stringify(receipt, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      checks: checks.length,
      screenshots: shots.length,
      errors,
    }),
  );
} catch (error) {
  failed = true;
  await page?.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  await writeFile(
    join(output, 'failure.txt'),
    String(error?.stack ?? error) + '\n',
  );
  console.error(`kept isolated fixture at ${temp}`);
  throw error;
} finally {
  await app?.close();
  await peer.close();
  if (!failed) await rm(temp, { recursive: true, force: true, maxRetries: 10 });
}

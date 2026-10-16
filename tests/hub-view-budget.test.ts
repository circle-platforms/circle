import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ExtensionHost, bundledExtensionsRoot } from '../src/extensions.js';
import { ExtensionSecrets } from '../src/extension_secrets.js';
import { scratch, cleanup } from './helpers.js';

for (const mode of ['history', 'utf8-metadata'] as const)
  test(`hub refresh keeps all four object pages under the byte limit with ${mode}`, async (t) => {
    const root = scratch(t),
      home = join(root, 'home'),
      workspace = join(root, 'project');
    const directory = join(home, 'extension_data/hub');
    mkdirSync(directory, { recursive: true });
    mkdirSync(workspace);
    const title =
      mode === 'utf8-metadata' ? '合成标题🧪'.repeat(9000) : 'synthetic task';
    const tasks = Array.from({ length: 20 }, (_, n) => ({
      taskId: `task_${n}`,
      title,
      phase: 'delivered',
      inputRevisionId: `inp_${n}`,
      capabilityPackId: 'synthetic',
      input: {},
      pendingInputs: [],
    }));
    const packs = Array.from({ length: 4 }, (_, n) => ({
      capabilityPackId: `method_${n}`,
      version: '1.0.0',
      title: `synthetic method ${n}`,
      inputFormats: ['synthetic/1'],
      requiredOperations: ['synthetic.read'],
    }));
    const artifacts = Array.from({ length: 2400 }, (_, n) => ({
      artifactId: `art_${n}`,
      fileName: `synthetic-${n}.json`,
      sha256: 'a'.repeat(64),
      size: 100,
    }));
    const evidence = Array.from({ length: 600 }, (_, n) => ({
      evidenceId: `evd_${n}`,
      kind: 'synthetic',
      sha256: 'b'.repeat(64),
      size: 100,
    }));
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://synthetic');
      let data: unknown = [];
      if (url.pathname === '/v1/tasks')
        data = url.searchParams.get('kind') === 'work' ? tasks : [];
      else if (url.pathname === '/v1/packs') data = packs;
      else if (/\/operations$/.test(url.pathname))
        data = [
          { operationId: 'op_1', name: 'synthetic.read', status: 'succeeded' },
        ];
      else if (/\/result$/.test(url.pathname))
        data = { status: 'succeeded', artifacts, evidence, unmapped: [] };
      else if (url.pathname === '/v1/assets') data = { items: [] };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    cleanup(
      t,
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    writeFileSync(
      join(directory, 'config.json'),
      JSON.stringify({ url, username: 'synthetic', scopeId: 'scp_lab' }),
    );
    if (mode === 'utf8-metadata')
      writeFileSync(
        join(directory, 'tasks.json'),
        JSON.stringify({ task_0: { title, seq: 0 } }),
      );
    await new ExtensionSecrets(home, 'hub').set(
      'token',
      'synthetic-view-token',
    );
    const host = await new ExtensionHost({
      home,
      workspace,
      trusted: true,
      bundledRoot: bundledExtensionsRoot(),
      settings: { hub: { enabled: true } },
    }).load();
    cleanup(t, () => host.close());
    const command = host.commands().get('hub')!;
    await command.handler('refresh', {
      workspace,
      toast: () => {},
      append: () => {},
      sendUserMessage: () => {},
    });
    const view = host.view('hub') as Record<string, any>;
    assert.ok(
      view.objects,
      'large history must not silently erase the entire object projection',
    );
    assert.ok(Buffer.byteLength(JSON.stringify(view)) <= 65536);
    assert.equal(
      view.projection.viewBytes,
      Buffer.byteLength(JSON.stringify(view)),
    );
    for (const group of ['work', 'execution', 'knowledge', 'methods'])
      assert.ok(view.objects[group].length > 0, `${group} remains usable`);
    assert.equal(
      view.objects.methods.length,
      4,
      'large artifact history must not starve the method catalog',
    );
    assert.equal(view.projection.byteLimit, 65536);
    assert.ok(view.projection.omittedItems > 0);
    assert.equal(
      view.projection.collections['objects.knowledge[].artifacts'].total,
      48000,
    );
    assert.equal(
      view.projection.collections['objects.knowledge[].artifacts'].omitted,
      48000 -
        view.objects.knowledge.reduce(
          (sum: number, row: any) => sum + row.artifacts.length,
          0,
        ),
    );
    if (mode === 'utf8-metadata') {
      assert.ok(view.projection.shortenedFields > 0);
      assert.ok(!JSON.stringify(view).includes('\ufffd'));
    }
  });

test('small hub views retain every original value without projection metadata', async () => {
  const { projectHubView } = await import('../src/extensions/hub/extension.js');
  const view = {
    signedIn: true,
    objects: {
      work: [],
      execution: [],
      knowledge: [],
      methods: [{ capabilityPackId: 'small', title: '合成' }],
    },
  };
  assert.equal(projectHubView(view), view);
});

test('hub projection never abbreviates identity pins or an approval action', async () => {
  const { projectHubView } = await import('../src/extensions/hub/extension.js');
  const action = {
    target: 'target',
    args: { text: 'approval content '.repeat(10000) },
  };
  const view = {
    signedIn: true,
    tasks: [],
    objects: {
      work: [
        {
          taskId: 'task_1',
          title: '合成'.repeat(20000),
          pendingInputs: [],
          approvals: [
            { approvalId: 'apr_1', targetIdentity: 'c'.repeat(64), action },
          ],
        },
      ],
      execution: [],
      knowledge: [],
      methods: [
        { capabilityPackId: 'oversized-version', version: 'pin'.repeat(30000) },
        {
          capabilityPackId: 'oversized-contract',
          contractVersion: 'pin'.repeat(30000),
        },
        { capabilityPackId: 'method', version: '1.0.0' },
      ],
    },
  };
  const projected = projectHubView(view) as Record<string, any>;
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 65536);
  assert.equal(projected.objects.work[0].taskId, 'task_1');
  assert.deepEqual(
    projected.objects.work[0].approvals,
    [],
    'an action that cannot fit is omitted whole, not rewritten',
  );
  assert.equal(
    projected.projection.collections['objects.work[].approvals'].omitted,
    1,
  );
  assert.deepEqual(projected.objects.methods, [
    { capabilityPackId: 'method', version: '1.0.0' },
  ]);
  assert.equal(
    projected.projection.collections['objects.methods'].omitted,
    2,
    'version pins are omitted whole rather than shortened',
  );
  assert.equal(
    view.objects.work[0]!.approvals[0]!.action,
    action,
    'projection never edits the source objects',
  );
});

test('reported hub view bytes reach the exact UTF-8 fixed point at decimal digit boundaries', async () => {
  const { projectHubView } = await import('../src/extensions/hub/extension.js');
  const view = (length: number) => ({
    note: 'x'.repeat(length),
    objects: {
      work: [],
      execution: [],
      knowledge: [],
      methods: [
        { capabilityPackId: 'oversized', version: 'pin'.repeat(30000) },
      ],
    },
  });
  const base = Buffer.byteLength(JSON.stringify(projectHubView(view(0))));
  const nearBoundary = 1000 - base;
  assert.ok(nearBoundary >= 0 && nearBoundary < 1024);
  const measured: number[] = [];
  for (let n = nearBoundary - 3; n <= nearBoundary + 3; n++) {
    const projected = projectHubView(view(n)) as Record<string, any>,
      actual = Buffer.byteLength(JSON.stringify(projected));
    assert.equal(projected.projection.viewBytes, actual);
    measured.push(actual);
  }
  assert.ok(
    measured.some((n) => n < 1000) && measured.some((n) => n >= 1000),
    'both sides of a JSON byte-count digit boundary are exercised',
  );
});

test('hub projection preserves connection inputs and explicitly refuses oversized connection metadata', async () => {
  const { projectHubView } = await import('../src/extensions/hub/extension.js');
  // The paired login form initializes its action arguments from these fields.
  const url = 'https://synthetic.invalid/' + 'route/'.repeat(300);
  const username = 'synthetic-user-'.repeat(150);
  const view = {
    url,
    username,
    signedIn: true,
    objects: {
      work: [],
      execution: [],
      knowledge: [
        {
          taskId: 'task_1',
          artifacts: Array.from({ length: 1000 }, (_, n) => ({
            artifactId: `art_${n}`,
            fileName: 'synthetic-file-'.repeat(20),
            sha256: 'a'.repeat(64),
          })),
        },
      ],
      methods: [{ capabilityPackId: 'synthetic' }],
    },
  };
  const projected = projectHubView(view);
  assert.equal(projected.url, url);
  assert.equal(projected.username, username);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 65536);
  for (const field of ['url', 'username'])
    assert.throws(
      () =>
        projectHubView({
          ...view,
          [field]: 'synthetic-connection-'.repeat(4000),
        }),
      /hub view metadata exceeds its byte budget/,
      `${field} is refused explicitly rather than rewritten into a different login argument`,
    );
});

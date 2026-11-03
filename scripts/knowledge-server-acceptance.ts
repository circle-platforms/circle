// Optional cross-repository acceptance against circle-hub, the reference server that implements
// knowledge-sync v1. The supplied repository is read-only; all of its code runs from a fixed git archive.
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentRuntime } from '../src/runtime.js';
import { ScriptedModel } from '../src/testing.js';
import {
  defaultSettings,
  loadSettings,
  saveSettings,
  trustFolder,
} from '../src/settings.js';
import { keptFor } from '../src/mcp_auth.js';
import { KnowledgeService } from '../src/knowledge/service.js';
import { sha256, syncObjectId } from '../src/knowledge/canonical.js';
import {
  prepareKnowledgeShare,
  syncMapping,
} from '../src/knowledge/sharing.js';
import { verifyKnowledgeSync } from './verify-knowledge-sync.js';
const execFile = promisify(execFileCallback);
const COMMIT = '410c9c44fcedef41bd1755bdbd0bef6600cd904e';
const [repositoryArg, receiptArg] = process.argv.slice(2);
if (!repositoryArg || !receiptArg)
  throw Error(
    'usage: knowledge-server-acceptance.ts <read-only circle-hub repository> <receipt.json>',
  );
const repository = resolve(repositoryArg),
  output = resolve(receiptArg);
const temp = await mkdtemp(join(tmpdir(), 'circle-hub-roundtrip-'));
const archive = join(temp, 'hub'),
  signal = new AbortController().signal;
const sourceRoot = resolve(import.meta.dirname, '..');
let postgres: any;
let hub: any, runtime: AgentRuntime | undefined, peer: any;
const checks: string[] = [],
  requests: { route: string; status: number }[] = [],
  rejections: string[] = [];
let authorizationPages = 0;
const originalFetch = globalThis.fetch;
async function until(test: () => boolean | Promise<boolean>, label: string) {
  const limit = Date.now() + 30000;
  while (!(await test())) {
    if (Date.now() >= limit)
      throw Error('acceptance state did not arrive: ' + label);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const addCheck = (message: string) => {
  checks.push(message);
  console.log('passed: ' + message);
};
try {
  await mkdir(archive);
  await execFile('git', ['archive', COMMIT, '-o', join(temp, 'hub.tar')], {
    cwd: repository,
  });
  await execFile('tar', ['-xf', join(temp, 'hub.tar'), '-C', archive]);
  await symlink(
    join(repository, 'node_modules'),
    join(archive, 'node_modules'),
    'dir',
  );
  const upstream = verifyKnowledgeSync(sourceRoot, archive);
  const load = (path: string) =>
    import(pathToFileURL(join(archive, path)).href);
  // Desktop sources have their own bundler-resolution tsconfig; tsx loads that boundary directly.
  const { DesktopKnowledge } = await import(
    pathToFileURL(join(sourceRoot, 'apps/desktop/src/knowledge-service.ts'))
      .href
  );
  const { createTestHub } = await load('hub/server/testing-real.ts');
  const { testConsoleCredentials } = await load('hub/server/testing.ts');
  // This helper owns a private PostgreSQL, FileKeyProvider, vault and data directory; it listens on 127.0.0.1:0.
  const { startPostgres } = await load('hub/testing/postgres.ts');
  postgres = await startPostgres({ private: true });
  hub = await createTestHub({
    postgres,
    repositoryPacks: false,
    stubs: false,
    mindmapSkill: false,
    workbookSkill: false,
    xmlSkill: false,
    htmlSkill: false,
    requireOsIsolation: false,
    limits: { syncRequestsPerMinute: 10000 },
  });
  assert.equal(new URL(hub.url).hostname, '127.0.0.1');
  assert.ok(![7420, 7443].includes(hub.port));
  const owner = await hub.createUser('合成 Circle 往返作者');
  const other = await hub.createUser('合成 Circle 隔离成员');
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(url.hostname),
      'acceptance network stays on loopback',
    );
    assert.ok(
      ![7420, 7443].includes(Number(url.port)),
      'live reference-server ports are forbidden',
    );
    const reply = await originalFetch(input, init);
    if (
      url.origin === new URL(hub.url).origin &&
      url.pathname.startsWith('/api/sync/v1')
    )
      requests.push({
        route: url.pathname.replace(/[a-f0-9-]{20,}/g, ':id'),
        status: reply.status,
      });
    return reply;
  };
  const send = async (path: string, options: RequestInit = {}) => {
    const reply = await fetch(new URL(path, hub.url), {
      ...options,
      redirect: 'manual',
    });
    return {
      status: reply.status,
      headers: reply.headers,
      body: await reply.text(),
    };
  };
  const csrf = (body: string) => {
    const value = /name="csrf" value="([^"]+)"/.exec(body)?.[1];
    assert.ok(value);
    return value;
  };
  const cookie = (headers: Headers, name: string) => {
    const value = headers.getSetCookie().find((v) => v.startsWith(name + '='));
    assert.ok(value);
    return value.split(';')[0]!;
  };
  const post = (
    path: string,
    fields: Record<string, string>,
    cookies: string,
  ) =>
    send(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: hub.url,
        cookie: cookies,
      },
      body: new URLSearchParams(fields),
    });
  const openUrl = async (url: string) => {
    authorizationPages++;
    // An isolated scripted browser performs the real password sign-in, consent and Circle loopback callback.
    const login = await send('/console/login');
    const signed = await post(
      '/console/login',
      { ...testConsoleCredentials(owner.token), csrf: csrf(login.body) },
      cookie(login.headers, 'circle_hub_login'),
    );
    assert.equal(signed.status, 303, 'synthetic password login accepted');
    const session = cookie(signed.headers, 'circle_hub_session');
    const start = await send(url, { headers: { cookie: session } });
    assert.equal(start.status, 303, 'real OAuth authorization page created');
    const path = new URL(start.headers.get('location')!, hub.url).pathname;
    const cookies =
      session + '; ' + cookie(start.headers, 'circle_hub_authorize');
    const page = await send(path, { headers: { cookie: cookies } });
    const account = /name="account" value="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(account);
    const consent = await post(
      path,
      { csrf: csrf(page.body), step: 'decide', decision: 'approve', account },
      cookies,
    );
    assert.equal(consent.status, 303, 'real OAuth consent accepted');
    const callback = new URL(consent.headers.get('location')!);
    assert.equal(callback.hostname, '127.0.0.1');
    assert.ok(callback.port !== String(hub.port));
    const completed = await fetch(callback);
    assert.equal(completed.status, 200);
  };
  const home = join(temp, 'circle-home'),
    workspace = join(temp, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  const settings = trustFolder(defaultSettings(), workspace);
  settings.mcp_servers = [
    {
      name: 'Synthetic isolated sync server',
      url: hub.mcpUrl,
      transport: 'streamable_http',
    },
  ];
  saveSettings(settings, home);
  runtime = new AgentRuntime({
    home,
    workspace,
    userHome: join(temp, 'user-home'),
    settings,
    model: new ScriptedModel([]),
    headless: true,
    integrations: true,
    bundledExtensions: false,
    openUrl,
    approve: async () => 'approve',
  });
  await runtime.initialize();
  await until(
    () =>
      !!keptFor(home, hub.mcpUrl).tokens?.access_token &&
      runtime!.mcp.status.some(
        (s) => s.name === settings.mcp_servers[0]!.name && !s.error,
      ),
    'real OAuth connection',
  );
  assert.equal(authorizationPages, 1);
  const desktop = new DesktopKnowledge(() => [home]);
  const connection = await desktop.execute(runtime, {
    op: 'prepare',
    action: 'connect',
    server: settings.mcp_servers[0]!.name,
  });
  await desktop.execute(runtime, {
    op: 'confirm',
    ticket: (connection as any).ticket,
    confirmed: true,
  });
  const service = new KnowledgeService(home);
  const currentBinding = () => loadSettings(home).knowledge_sync.binding;
  const callForPerson = runtime.knowledge.callForPerson.bind(runtime.knowledge);
  runtime.knowledge.callForPerson = async (...args) => {
    const reply = await callForPerson(...args);
    if ((reply as any)?.isError)
      rejections.push(
        ...((reply as any).structuredContent?.errors ?? []).map(
          (e: any) => e.code,
        ),
      );
    return reply;
  };
  const initial = service.prepareMemory({
    expected_head: service.withStore((s) => s.head),
    title: '合成往返偏好',
    markdown: 'SYNTHETIC_INITIAL_MEMORY',
  });
  initial.commit(signal);
  await runtime.knowledge.synchronize();
  const memory = () =>
    service.withStore((s) =>
      s.items().find((i) => i.kind === 'memory_revision')!,
    );
  const mapping = () => {
    const item = memory();
    return syncMapping(service, currentBinding(), item.item_id, item.heads[0]!);
  };
  assert.ok(mapping()?.document);
  peer = await hub.client(owner.token);
  const parsed = (reply: any) => {
    assert.equal(reply.isError, false, 'real MCP operation accepted');
    const out = reply.structuredContent;
    assert.equal(out.call_result, 'ok');
    return out;
  };
  const firstRemote = parsed(
    await peer.call('get_nodes', { memory: { scope: 'personal' } }),
  );
  assert.equal(firstRemote.memory_page.items.length, 1);
  const readPersonal = async () =>
    parsed(
      await peer.call('get_nodes', {
        memory: { document: mapping().document, version: mapping().version },
      }),
    ).memory_document.markdown;
  assert.equal(await readPersonal(), 'SYNTHETIC_INITIAL_MEMORY');
  const outsider = await hub.client(other.token);
  try {
    const denied = await outsider.call('get_nodes', {
      memory: { document: mapping().document, version: mapping().version },
    });
    assert.equal(
      denied.isError,
      true,
      'another account cannot read personal memory before sharing',
    );
  } finally {
    await outsider.close();
  }
  addCheck(
    'first sync crosses real OAuth, HTTP, PostgreSQL and MCP and returns the exact personal memory',
  );
  const directory = service.withStore(
    (s) => s.items().find((i) => i.kind === 'directory_revision')!.item_id,
  );
  const objects: any[] = [];
  const add = (kind: string, body: unknown) => {
    const object = { schema: 'personal-sync-object@1', kind, body };
    objects.push(object);
    return syncObjectId(object);
  };
  const raw = Buffer.from('SYNTHETIC_VERIFIABLE_KNOWLEDGE\n');
  const bytes = add('bytes', { bytes_base64: raw.toString('base64') });
  const source = add('source_revision', {
    item_id: randomUUID(),
    parents: [],
    directory_id: directory,
    name: 'synthetic-evidence.txt',
    media_type: 'text/plain',
    size: raw.length,
    raw_sha256: sha256(raw),
    chunks: [bytes],
  });
  const quote = add('bytes', {
    bytes_base64: Buffer.from('SYNTHETIC_VERIFIABLE_KNOWLEDGE').toString(
      'base64',
    ),
  });
  const entry = add('entry_revision', {
    item_id: randomUUID(),
    parents: [],
    directory_id: directory,
    content: {
      kind: 'observation',
      statement: 'SYNTHETIC_VERIFIABLE_KNOWLEDGE',
      data: {},
      applicability: null,
    },
    grounds: [{ source, quotation: quote, parser: 'text@1', selector: 'l/1' }],
  });
  service
    .prepare({ expected_head: service.withStore((s) => s.head), objects })
    .commit(signal);
  await runtime.knowledge.synchronize();
  assert.ok(
    service.withStore((s) =>
      s
        .observations(s.head!)
        .some((v) => v.object === entry && v.status === 'verified'),
    ),
  );
  await runtime.knowledge.close();
  const baseMapping = mapping(),
    identity = memory().item_id;
  service
    .prepareMemory({
      expected_head: service.withStore((s) => s.head),
      item_id: identity,
      markdown: 'SYNTHETIC_LOCAL_BRANCH',
    })
    .commit(signal);
  parsed(
    await peer.call('upload_file', {
      memory: {
        space: 'personal',
        document: baseMapping.document,
        expected_version: baseMapping.version,
        markdown: 'SYNTHETIC_HUB_BRANCH',
        client_key: randomUUID(),
      },
    }),
  );
  await runtime.knowledge.configure();
  await runtime.knowledge.synchronize();
  assert.equal(memory().heads.length, 2);
  const branches = service.withStore((s) =>
    memory().heads.map((h) => (s.read(h) as any).body.markdown),
  );
  assert.deepEqual(branches.sort(), [
    'SYNTHETIC_HUB_BRANCH',
    'SYNTHETIC_LOCAL_BRANCH',
  ]);
  assert.equal(runtime.knowledge.status().condition, 'conflicted');
  addCheck(
    'independent Circle and server edits preserve both conflict revisions without auto-resolution',
  );
  service
    .prepareMemory({
      expected_head: service.withStore((s) => s.head),
      item_id: identity,
      title: '合成往返偏好',
      state: 'enabled',
      markdown: 'SYNTHETIC_EXPLICIT_RESOLUTION',
    })
    .commit(signal);
  await runtime.knowledge.synchronize();
  assert.equal(memory().heads.length, 1);
  const current = memory(),
    share = await prepareKnowledgeShare({
      service,
      connection: runtime!.knowledge,
      binding: currentBinding,
      snapshot: service.withStore((s) => s.head!),
      object: current.heads[0]!,
      signal,
    });
  const teamBefore = await hub.hub.knowledge.memory.items(
    other.principal,
    'team',
  );
  assert.equal(teamBefore.length, 0);
  await share.run();
  const team = await hub.hub.knowledge.memory.items(other.principal, 'team');
  assert.equal(team.length, 1);
  assert.equal(
    (await hub.hub.knowledge.memory.read(other.principal, team[0].document))
      .markdown,
    'SYNTHETIC_EXPLICIT_RESOLUTION',
  );
  addCheck(
    'an exact accepted mapping enables checked and explicitly confirmed sharing to an independently readable team copy',
  );
  const prepareEntryShare = () =>
    prepareKnowledgeShare({
      service,
      connection: runtime!.knowledge,
      binding: currentBinding,
      snapshot: service.withStore((s) => s.head!),
      object: entry,
      teamPath: '/',
      signal,
    });
  const unsigned = await prepareEntryShare();
  await assert.rejects(unsigned.run(), /knowledge-remote-unavailable/);
  assert.equal(rejections.at(-1), 'SHARE_UPLOAD_UNSIGNED');
  addCheck(
    'the reference server rejects unsigned local-upload grounds with SHARE_UPLOAD_UNSIGNED and keeps its refusal receipt',
  );
  // The reference server's own acceptance fixture pattern: an independently observed synthetic team capture.
  // This creates a separate capture, never changes the prior upload's provenance, and is not a real connector receipt.
  await hub.records.artifacts.ingest({
    bytes: raw,
    mediaType: 'text/plain',
    origin: { read: { object: 'synthetic:document:circle-roundtrip' } },
    author: { user: null },
    provenanceType: 'observed',
    visibility: {
      readers: [owner.principal.id],
      admins: true,
      packs: [],
      shareable: false,
    },
  });
  const sharedEntry = await (await prepareEntryShare()).run();
  const address = /^tree:([a-f0-9]{64})(\/.*)@([a-f0-9]{64})$/.exec(
    sharedEntry.reference!,
  );
  assert.ok(address);
  const reader = await hub.client(other.token);
  try {
    const read = parsed(
      await reader.call('get_nodes', {
        root: address[1],
        paths: [address[2]],
        depth: 0,
      }),
    );
    const entryRead = read.nodes
      .flatMap((n: any) => n.entries)
      .find((e: any) => e.entry === address[3]);
    assert.equal(entryRead.status, 'verified');
    assert.equal(entryRead.statement, 'SYNTHETIC_VERIFIABLE_KNOWLEDGE');
  } finally {
    await reader.close();
  }
  addCheck(
    'locally and remotely verified source-backed knowledge shares only through its exact mapping and is readable by another account',
  );
  const localHead = service.withStore((s) => s.head),
    beforePurge = await runtime.knowledge.currentState(signal);
  const impact = await runtime.knowledge.checkMode('local', signal);
  assert.ok(impact.personal_bytes > 0);
  assert.equal(
    await runtime.knowledge.changeMode('local', impact, signal),
    true,
  );
  await until(
    async () =>
      (await runtime!.knowledge.currentState(signal)).status !== 'purging',
    'real purge completion',
  );
  const purged = await runtime.knowledge.currentState(signal);
  assert.equal(purged.mode, 'local');
  assert.equal(purged.used_bytes, 0);
  assert.equal(purged.snapshot, null);
  assert.equal(
    parsed(await peer.call('get_nodes', { memory: { scope: 'personal' } }))
      .memory_page.items.length,
    0,
  );
  assert.equal(purged.epoch, beforePurge.epoch);
  assert.equal(
    service.withStore((s) => s.head),
    localHead,
  );
  assert.equal(
    (await hub.hub.knowledge.memory.read(other.principal, team[0].document))
      .markdown,
    'SYNTHETIC_EXPLICIT_RESOLUTION',
  );
  const resumeImpact = await runtime.knowledge.checkMode('hub', signal);
  assert.equal(
    await runtime.knowledge.changeMode('hub', resumeImpact, signal),
    true,
  );
  await runtime.knowledge.synchronize();
  assert.notEqual(
    (await runtime.knowledge.currentState(signal)).epoch,
    beforePurge.epoch,
  );
  assert.equal(await readPersonal(), 'SYNTHETIC_EXPLICIT_RESOLUTION');
  addCheck(
    'local-only mode really purges personal server payloads, retains local and team copies, and resumes into a new epoch',
  );
  const token = keptFor(home, hub.mcpUrl).tokens!.access_token;
  await hub.records.principals.revokeTokenValue(token);
  await runtime.knowledge.synchronize().catch(() => {});
  assert.equal(runtime.knowledge.status().condition, 'login-required');
  assert.ok(requests.some((r) => r.status === 401));
  assert.equal(authorizationPages, 1, '401 cannot start background login');
  await desktop.execute(runtime, { op: 'login' });
  await until(
    () =>
      authorizationPages === 2 &&
      !!keptFor(home, hub.mcpUrl).tokens?.access_token &&
      runtime!.mcp.status.some((s) => !s.error),
    'explicit real re-login',
  );
  const reselect = await desktop.execute(runtime, {
    op: 'prepare',
    action: 'connect',
    server: settings.mcp_servers[0]!.name,
  });
  await desktop.execute(runtime, {
    op: 'confirm',
    ticket: (reselect as any).ticket,
    confirmed: true,
  });
  await runtime.knowledge.synchronize();
  assert.notEqual(keptFor(home, hub.mcpUrl).tokens!.access_token, token);
  assert.equal(runtime.knowledge.status().condition, 'synced');
  assert.equal(await readPersonal(), 'SYNTHETIC_EXPLICIT_RESOLUTION');
  addCheck(
    'a revoked OAuth token produces a real 401, pauses without background login, and explicit password/consent re-login resumes sync',
  );
  const receipt = {
    schema: 'circle-isolated-hub-acceptance@1',
    hubCommit: COMMIT,
    archiveSha256: createHash('sha256')
      .update(await readFile(join(temp, 'hub.tar')))
      .digest('hex'),
    upstream,
    synthetic: true,
    loopback: true,
    livePortsExcluded: [7420, 7443],
    temporaryPostgres: true,
    vault: 'temporary FileKeyProvider from circle-hub testing tools',
    authorization:
      'real password login and OAuth code exchange through Circle loopback callbacks',
    authorizationPages,
    fixtureProvenance:
      'Synthetic observed team capture seeded through circle-hub artifacts.ingest after asserting unsigned-upload refusal; no real connector executed',
    rejections,
    testedAt: new Date().toISOString(),
    versions: {
      node: process.versions.node,
      platform: process.platform,
      architecture: process.arch,
    },
    checks,
    requests,
    packaged: false,
    runnerSha256: createHash('sha256')
      .update(await readFile(process.argv[1]!))
      .digest('hex'),
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(
    JSON.stringify({
      checks: checks.length,
      failures: 0,
      requests: requests.length,
    }),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  throw error;
} finally {
  await runtime?.close();
  await peer?.close();
  await hub?.close();
  await postgres?.stop();
  globalThis.fetch = originalFetch;
  await rm(temp, { recursive: true, force: true });
}

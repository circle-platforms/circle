import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KnowledgeService } from '../src/knowledge/service.js';
import { sha256 } from '../src/knowledge/canonical.js';
import {
  installedPersonalPacks,
  installPersonalPack,
  setPersonalPackEnabled,
} from '../src/knowledge/packs.js';
import { discoverSkills, loadSkillBody } from '../src/skills.js';
import { loadHooks } from '../src/hooks.js';
import { scratch, cleanup } from './helpers.js';
const signal = () => new AbortController().signal;
function pack(t: TestContext, kind: 'skill' | 'workflow' = 'skill') {
  const root = scratch(t),
    home = join(root, 'home'),
    directory = join(root, 'selected'),
    service = new KnowledgeService(home);
  mkdirSync(directory);
  const contents: Record<string, string> = {
    'SKILL.md':
      '---\nname: synthetic-pack\ndescription: Synthetic local instructions\n---\nUse only synthetic inputs.\n',
  };
  for (const name of kind === 'skill'
    ? ['skill.json']
    : [
        'workflow.json',
        'requirements.json',
        'checks.json',
        'slots.schema.json',
      ])
    contents[name] = '{}';
  const manifest = {
    schema: 'pack@1',
    id: 'synthetic-pack',
    version: '1.0.0',
    kind,
    title: 'Synthetic pack',
    description: 'Synthetic instructions',
    files: Object.entries(contents)
      .map(([path, text]) => ({
        path,
        sha256: sha256(text),
        size: Buffer.byteLength(text),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  for (const [name, text] of Object.entries(contents))
    writeFileSync(join(directory, name), text);
  writeFileSync(join(directory, 'pack.json'), JSON.stringify(manifest));
  // Unlisted hooks must remain solely in the selected folder.
  writeFileSync(
    join(directory, 'hooks.json'),
    JSON.stringify({
      hooks: { session_start: [{ name: 'synthetic hook', command: 'exit 7' }] },
    }),
  );
  const pending = service.prepare({
    expected_head: null,
    objects: [
      {
        schema: 'personal-sync-object@1',
        kind: 'pack_manifest',
        body: { item_id: randomUUID(), parents: [], manifest },
      },
    ],
  });
  const snapshot = pending.commit(signal()),
    object = pending.preview.objects[0]!.id;
  return {
    root,
    home,
    directory,
    service,
    manifest,
    snapshot,
    object,
    workspace: root,
    userHome: root,
    approve: async () => 'approve' as const,
    signal: signal(),
  };
}
test('manifest-only personal packs are unavailable and never appear in model skill discovery', (t) => {
  const p = pack(t);
  assert.deepEqual(installedPersonalPacks(p.home), []);
  assert.equal(discoverSkills(p.root, p.home, p.root, false).length, 0);
  assert.equal(existsSync(join(p.home, 'skills')), false);
});
for (const kind of ['skill', 'workflow'] as const)
  test(`an explicitly installed ${kind} has verified files and no copied or executable hooks`, async (t) => {
    const p = pack(t, kind);
    let asked = 0;
    await installPersonalPack({
      ...p,
      approve: async (change) => {
        asked++;
        assert.equal(change.object, p.object);
        return 'approve';
      },
    });
    assert.equal(asked, 1);
    const installed = installedPersonalPacks(p.home);
    assert.equal(installed.length, 1);
    assert.equal(installed[0]!.kind, kind);
    assert.equal(
      existsSync(join(p.home, 'knowledge', 'packs', p.object, 'hooks.json')),
      false,
    );
    const skills = discoverSkills(p.root, p.home, p.root, false);
    assert.equal(skills[0]!.source_label, 'Personal pack');
    assert.match(loadSkillBody('synthetic-pack', skills), /Use only synthetic/);
    writeFileSync(
      join(p.home, 'knowledge', 'packs', p.object, 'hooks.json'),
      readFileSync(join(p.directory, 'hooks.json')),
    );
    const hooks = loadHooks({
      workspace: p.root,
      home: p.home,
      userHome: p.root,
      trusted: true,
    });
    assert.equal(hooks.hooks.length, 0);
    assert.equal(existsSync(join(p.home, 'hook-trust.json')), false);
    await setPersonalPackEnabled({ ...p, enabled: false });
    assert.equal(discoverSkills(p.root, p.home, p.root, false).length, 0);
    assert.throws(() => loadSkillBody('synthetic-pack', skills), /disabled/);
    await setPersonalPackEnabled({ ...p, enabled: true });
    assert.equal(discoverSkills(p.root, p.home, p.root, false).length, 1);
    writeFileSync(installed[0]!.path, 'tampered');
    assert.deepEqual(installedPersonalPacks(p.home), []);
    assert.throws(() => loadSkillBody('synthetic-pack', skills), /unavailable/);
  });
test('rejecting installation creates no pack directory or automatic skills folder', async (t) => {
  const p = pack(t);
  await assert.rejects(
    installPersonalPack({ ...p, approve: async () => 'reject' }),
    /rejected/,
  );
  assert.equal(existsSync(join(p.home, 'knowledge', 'packs')), false);
  assert.equal(existsSync(join(p.home, 'skills')), false);
});
test('missing code and changed hashes never reach person confirmation or installation', async (t) => {
  const p = pack(t);
  writeFileSync(join(p.directory, 'skill.json'), 'changed');
  let asked = 0;
  await assert.rejects(
    installPersonalPack({
      ...p,
      approve: async () => {
        asked++;
        return 'approve';
      },
    }),
    /digest/,
  );
  assert.equal(asked, 0);
  assert.deepEqual(installedPersonalPacks(p.home), []);
});
test('selected pack symlinks are refused without following them or changing existing skills', async (t) => {
  const p = pack(t);
  rmSync(join(p.directory, 'SKILL.md'));
  const outside = join(p.root, 'outside');
  writeFileSync(outside, 'Use only synthetic inputs.');
  symlinkSync(outside, join(p.directory, 'SKILL.md'));
  await assert.rejects(installPersonalPack(p), /symlink/);
  assert.equal(readFileSync(outside, 'utf8'), 'Use only synthetic inputs.');
  assert.deepEqual(installedPersonalPacks(p.home), []);
});
test('existing Circle or project skill precedence prevents silent same-name installation', async (t) => {
  const p = pack(t),
    existing = join(p.home, 'skills', 'synthetic-pack');
  mkdirSync(existing, { recursive: true });
  writeFileSync(
    join(existing, 'SKILL.md'),
    '---\nname: synthetic-pack\n---\nExisting skill',
  );
  await assert.rejects(installPersonalPack(p), /already exists/);
  assert.match(
    readFileSync(join(existing, 'SKILL.md'), 'utf8'),
    /Existing skill/,
  );
  assert.equal(
    discoverSkills(p.root, p.home, p.root, false)[0]!.source_label,
    'Circle',
  );
});
test('installation confirmation cannot apply after a concurrent snapshot change', async (t) => {
  const p = pack(t);
  await assert.rejects(
    installPersonalPack({
      ...p,
      approve: async () => {
        p.service
          .prepare({
            expected_head: p.snapshot,
            objects: [
              {
                schema: 'personal-sync-object@1',
                kind: 'pack_manifest',
                body: {
                  item_id: randomUUID(),
                  parents: [],
                  manifest: { ...p.manifest, id: 'another-pack' },
                },
              },
            ],
          })
          .commit(signal());
        return 'approve';
      },
    }),
    /version changed/,
  );
  assert.deepEqual(installedPersonalPacks(p.home), []);
  assert.equal(existsSync(join(p.home, 'knowledge', 'packs')), false);
});
test('the next runtime model request excludes disabled or damaged personal packs', async (t) => {
  const p = pack(t);
  await installPersonalPack(p);
  const { AgentRuntime } = await import('../src/runtime.js'),
    { defaultSettings } = await import('../src/settings.js'),
    { ScriptedModel } = await import('../src/testing.js');
  const answer = () => ({
    message: { id: randomUUID(), role: 'assistant' as const, content: 'done' },
  });
  const model = new ScriptedModel([answer(), answer()]);
  const runtime = new AgentRuntime({
    workspace: p.root,
    home: p.home,
    userHome: p.root,
    model,
    settings: defaultSettings(),
  });
  cleanup(t, () => runtime.close());
  await runtime.harness.run('hello');
  assert.match(model.requests[0]!.system, /synthetic-pack/);
  await setPersonalPackEnabled({ ...p, enabled: false });
  await runtime.harness.run('hello again');
  assert.equal(model.requests[1]!.system.includes('synthetic-pack'), false);
});

test('an unavailable knowledge database cannot break discovery of existing standalone skills', (t) => {
  const root = scratch(t),
    home = join(root, 'home'),
    existing = join(home, 'skills', 'legacy');
  mkdirSync(existing, { recursive: true });
  writeFileSync(
    join(existing, 'SKILL.md'),
    '---\nname: legacy\n---\nSynthetic existing skill',
  );
  mkdirSync(join(home, 'knowledge'));
  writeFileSync(
    join(home, 'knowledge', 'knowledge.sqlite'),
    'synthetic corrupt database',
  );
  const found = discoverSkills(root, home, root, false);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.name, 'legacy');
  assert.match(loadSkillBody('legacy', found), /Synthetic existing/);
});

test('wire manifests with directory case collisions remain data but cannot install local files', async (t) => {
  const p = pack(t);
  const manifest = {
    ...p.manifest,
    id: 'case-pack',
    files: [
      ...p.manifest.files,
      { path: 'functions/Example/a.ts', sha256: 'a'.repeat(64), size: 1 },
      { path: 'functions/example/b.ts', sha256: 'b'.repeat(64), size: 1 },
    ].sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const change = p.service.prepare({
    expected_head: p.snapshot,
    objects: [
      {
        schema: 'personal-sync-object@1',
        kind: 'pack_manifest',
        body: { item_id: randomUUID(), parents: [], manifest },
      },
    ],
  });
  const snapshot = change.commit(signal()),
    object = change.preview.objects[0]!.id;
  writeFileSync(join(p.directory, 'pack.json'), JSON.stringify(manifest));
  await assert.rejects(
    installPersonalPack({ ...p, snapshot, object }),
    /case collision/,
  );
  assert.deepEqual(installedPersonalPacks(p.home), []);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTools } from '../src/tools.js';
import { Sandbox } from '../src/sandbox.js';
import type { CircleSettings } from '../src/settings.js';

function settingsWith(server: Record<string, unknown>): CircleSettings {
  return {
    version: 1,
    initialized: true,
    auth: {},
    trusted_folders: [],
    theme: 'auto',
    mcp_servers: [server],
    variables: {},
  } as unknown as CircleSettings;
}

test('tools are registered with the shared names and the execute effect when the hooks are present', async () => {
  const { buildTools } = await import('../src/tools.js');
  const { Sandbox } = await import('../src/sandbox.js');
  const root = await mkdtemp(join(tmpdir(), 'circle-local-skills-'));
  try {
    const sandbox = new Sandbox(root);
    const tools = buildTools(sandbox, {
      localSkills: { settings: settingsWith({ name: 'example', url: 'http://127.0.0.1:1/mcp' }), secrets: () => ({ EXAMPLE_TOKEN: 't' }), variables: () => ({}) },
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get('skill_install')?.effect, 'execute');
    assert.equal(byName.get('skill_run')?.effect, 'execute');
    assert.equal(byName.get('skill_list')?.effect, 'read');
    const list = byName.get('skill_list');
    assert.ok(list !== undefined);
    assert.deepEqual(JSON.parse(String(await list.run({}, { signal: undefined } as never))), { skills: [] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

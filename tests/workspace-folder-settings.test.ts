import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  defaultSettings,
  loadSettings,
  loadSettingsFromDict,
  saveSettings,
  saveSettingsChange,
  settingsForRun,
  trustFolder,
} from '../src/settings.js';
import { scratch } from './helpers.js';

test('workspace_folder defaults to empty and is normalized defensively', () => {
  assert.equal(defaultSettings().workspace_folder, '');
  assert.equal(loadSettingsFromDict({}).workspace_folder, '');
  // A stored value keeps its path but loses padding; anything else is dropped
  // rather than sent to the filesystem.
  assert.equal(
    loadSettingsFromDict({ workspace_folder: '  /data/workspace  ' })
      .workspace_folder,
    '/data/workspace',
  );
  assert.equal(
    loadSettingsFromDict({ workspace_folder: 42 }).workspace_folder,
    '',
  );
  assert.equal(
    loadSettingsFromDict({ workspace_folder: null }).workspace_folder,
    '',
  );
  assert.equal(
    loadSettingsFromDict({ workspace_folder: 'x'.repeat(4097) })
      .workspace_folder,
    '',
  );
});

test('workspace_folder round-trips through settings.json beside other keys', (t) => {
  const home = join(scratch(t), 'home');
  mkdirSync(home, { recursive: true });
  saveSettings(defaultSettings(), home);
  saveSettingsChange(home, (settings) => {
    settings.workspace_folder = '/data/workspace';
    settings.theme = 'dark';
  });
  assert.equal(loadSettings(home).workspace_folder, '/data/workspace');
  assert.equal(loadSettings(home).theme, 'dark');
  // Resetting it leaves the rest of the file as it is on disk.
  saveSettingsChange(home, (settings) => {
    settings.workspace_folder = '';
  });
  assert.equal(loadSettings(home).workspace_folder, '');
  assert.equal(loadSettings(home).theme, 'dark');
});

test('a project cannot set workspace_folder', (t) => {
  const workspace = scratch(t);
  const home = join(workspace, 'elsewhere');
  let saved = defaultSettings();
  saved.initialized = true;
  saved.workspace_folder = '/data/workspace';
  saved = trustFolder(saved, workspace);
  saveSettings(saved, home);
  mkdirSync(join(workspace, '.circle'), { recursive: true });
  writeFileSync(
    join(workspace, '.circle', 'settings.json'),
    JSON.stringify({
      workspace_folder: join(workspace, 'hijack'),
      theme: 'light',
    }),
  );
  const { settings, problems } = settingsForRun(home, workspace);
  assert.deepEqual(problems, [
    `${join(workspace, '.circle', 'settings.json')}: 'workspace_folder' is not a project setting`,
  ]);
  assert.equal(settings.workspace_folder, '/data/workspace');
  assert.equal(settings.theme, 'light');
});

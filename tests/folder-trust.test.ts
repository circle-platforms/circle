import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import {
  defaultSettings,
  isFolderTrusted,
  loadSettings,
  saveSettings,
  trustFolder,
  untrustFolder,
} from '../src/settings.js';
import { normalizeWorkspace } from '../src/paths.js';
import { scratch } from './helpers.js';

test('trusting a folder and taking that away are opposites, on either spelling of a path', (t) => {
  const one = scratch(t, 'circle-trust-one-');
  const two = scratch(t, 'circle-trust-two-');
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  const root = defaultSettings();
  assert.equal(isFolderTrusted(root, one), false);
  const settings = trustFolder(trustFolder(root, one), two + sep);
  assert.equal(isFolderTrusted(settings, one), true);
  // A trailing separator is the same folder, so it is trusted and named once.
  assert.equal(isFolderTrusted(settings, two), true);
  assert.equal(settings.trusted_folders.length, 2);
  assert.equal(trustFolder(settings, one).trusted_folders.length, 2);
  // The settings handed in are not changed on the way.
  assert.deepEqual(root.trusted_folders, []);
  const revoked = untrustFolder(settings, two + sep);
  assert.deepEqual(revoked.trusted_folders, [normalizeWorkspace(one)]);
  assert.equal(isFolderTrusted(revoked, one), true);
  assert.equal(isFolderTrusted(revoked, two), false);
  // A folder that was never trusted changes nothing.
  assert.deepEqual(
    untrustFolder(revoked, join(one, 'elsewhere')).trusted_folders,
    revoked.trusted_folders,
  );
});

test('taking a folder away is kept in settings.json beside the keys the terminal reads', (t) => {
  const home = scratch(t, 'circle-untrust-home-');
  const one = scratch(t, 'circle-untrust-one-');
  const two = scratch(t, 'circle-untrust-two-');
  mkdirSync(one, { recursive: true });
  mkdirSync(two, { recursive: true });
  let settings = defaultSettings();
  settings = trustFolder(settings, one);
  settings = trustFolder(settings, two);
  settings.allowed_commands = ['git status'];
  saveSettings(settings, home);
  saveSettings(untrustFolder(loadSettings(home), one), home);
  const saved = loadSettings(home);
  assert.deepEqual(saved.trusted_folders, [normalizeWorkspace(two)]);
  assert.deepEqual(saved.allowed_commands, ['git status']);
});

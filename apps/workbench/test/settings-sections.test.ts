import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n/index.ts';
import {
  DEFAULT_SETTINGS_SECTION,
  SETTINGS_SECTION_IDS,
  settingsGroups,
  settingsHref,
  settingsSectionOf,
} from '../src/model/settings-sections.ts';
import { PluginRegistry } from '../src/plugins/registry.ts';
import type { WorkbenchPlugin } from '../src/plugins/types.ts';

setLanguage('en', {
  getItem: () => null,
  setItem: () => undefined,
} as unknown as Storage);
const live = { live: true, network: true };
const ids = (context = live) =>
  settingsGroups(context).flatMap((group) =>
    group.sections.map((section) => section.id),
  );
const section = (id: string, context = live) =>
  settingsGroups(context)
    .flatMap((group) => group.sections)
    .find((item) => item.id === id)!;

test('every group of the settings dialog is listed once, under one heading', () => {
  const listed = ids();
  assert.equal(new Set(listed).size, listed.length);
  assert.deepEqual(
    [...listed].sort(),
    SETTINGS_SECTION_IDS.filter((id) => id !== 'launch').sort(),
  );
  assert.deepEqual(
    settingsGroups(live).map((group) => group.id),
    ['general', 'models', 'capabilities', 'workspace', 'safety'],
  );
  for (const group of settingsGroups(live)) {
    assert.ok(group.label);
    assert.ok(group.sections.length > 0, `${group.id} is not empty`);
    for (const item of group.sections) assert.ok(item.label);
  }
});

test('the preview and the network report decide two groups', () => {
  assert.equal(ids().includes('launch'), false);
  assert.equal(ids({ live: false, network: false }).includes('launch'), true);
  assert.equal(ids({ live: true, network: false }).includes('network'), false);
  assert.equal(ids().includes('network'), true);
});

test('a window address opens a group of the dialog, or none', () => {
  assert.equal(settingsSectionOf('/page/settings'), DEFAULT_SETTINGS_SECTION);
  assert.equal(settingsSectionOf('/page/extensions'), 'extensions');
  assert.equal(settingsSectionOf('/page/models'), 'models');
  assert.equal(settingsSectionOf('/page/hooks/'), 'hooks');
  // A page of the window itself, a session and a page nobody knows are not groups.
  assert.equal(settingsSectionOf('/page/sessions'), null);
  assert.equal(settingsSectionOf('/page/nothing-here'), null);
  assert.equal(settingsSectionOf('/session/session1'), null);
  assert.equal(settingsSectionOf('/home'), null);
  assert.equal(settingsSectionOf('/page/extensions/github'), null);
  for (const id of SETTINGS_SECTION_IDS)
    assert.equal(settingsSectionOf(settingsHref(id)), id);
});

test('a kind of thing decides where it goes, not what it is for', () => {
  // GitHub is an extension, so it is no group of its own and the extensions find it.
  assert.equal(
    settingsGroups(live)
      .flatMap((group) => group.sections)
      .some((item) => /github/i.test(item.label)),
    false,
  );
  assert.match(section('extensions').keywords, /GitHub/);
  // A session's defaults are not model settings: the model and its thinking depth go
  // with the models, and a double Esc stays with the sessions.
  assert.doesNotMatch(section('behavior').keywords, /model/i);
  assert.match(section('models').keywords, /thinking depth/);
  // Crediting Circle in commits is Git's, not the version's.
  assert.match(section('git').keywords, /commits/);
  assert.doesNotMatch(section('about').keywords, /commit/i);
  // What the keyboard does is the shortcuts, found by its old name too.
  assert.match(section('shortcuts').keywords, /keyboard/);
});

test('the labels follow the language', () => {
  setLanguage('zh-CN', {
    getItem: () => null,
    setItem: () => undefined,
  } as unknown as Storage);
  try {
    assert.equal(section('shortcuts').label, '快捷键');
    assert.equal(section('files').label, '文件访问');
    assert.equal(
      settingsGroups(live).find((group) => group.id === 'safety')!.label,
      '权限与安全',
    );
  } finally {
    setLanguage('en', {
      getItem: () => null,
      setItem: () => undefined,
    } as unknown as Storage);
  }
});

test('a plugin page cannot take the address of a group', () => {
  const icon = (() => null) as unknown as WorkbenchPlugin['icon'];
  const plugin = (page: string): WorkbenchPlugin => ({
    id: 'sample',
    apiVersion: 1,
    version: '0.1.0',
    title: 'sample',
    description: '',
    icon,
    pages: [{ id: page, title: page, icon, component: () => null }],
  });
  for (const id of SETTINGS_SECTION_IDS)
    assert.throws(() => new PluginRegistry([plugin(id)]), /reserved/);
  assert.doesNotThrow(() => new PluginRegistry([plugin('records')]));
});

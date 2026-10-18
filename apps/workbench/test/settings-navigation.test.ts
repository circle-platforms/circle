import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSettingsSection } from '../src/model/settings-navigation.ts';

test('settings locator matches every word inside the same local section', () => {
  assert.equal(
    matchesSettingsSection('theme size', 'appearance', 'theme text size'),
    true,
  );
  assert.equal(
    matchesSettingsSection('theme network', 'appearance', 'theme text size'),
    false,
  );
  assert.equal(matchesSettingsSection('  ', 'appearance'), true);
  assert.equal(
    matchesSettingsSection('ＴＨＥＭＥ', 'appearance', 'theme'),
    true,
  );
  assert.equal(
    matchesSettingsSection('语言', '外观', '主题 语言 文字大小'),
    true,
  );
});

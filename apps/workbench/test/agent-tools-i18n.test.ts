import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setLanguage, t } from '../src/i18n/index.ts';
import { agentTools } from '../src/i18n/zh-CN/agent-tools.ts';

test('agent tool words resolve through the public translation entry in both languages', () => {
  try {
    for (const [english, chinese] of Object.entries(agentTools)) {
      setLanguage('en');
      assert.equal(t(english), english);
      setLanguage('zh-CN');
      assert.equal(t(english), chinese);
      assert.notEqual(t(english), english);
    }
  } finally {
    setLanguage('en');
  }
});

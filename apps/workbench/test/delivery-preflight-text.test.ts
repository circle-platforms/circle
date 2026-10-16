import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n';
import { deliveryPreflightText } from '../src/model/delivery-preflight-text';
test('known local delivery preflight text localizes while unknown diagnostics remain exact', () => {
  const known =
    'commit remaining workspace changes or move them to another branch, then refresh before publishing; nothing was pushed';
  try {
    setLanguage('en');
    assert.equal(deliveryPreflightText(known), known);
    setLanguage('zh-CN');
    assert.match(deliveryPreflightText('Error: ' + known), /尚未推送任何内容/);
    for (const raw of [
      'remote provider said: ' + known,
      'fatal: transport failed',
      'Error: unknown private diagnostic',
    ])
      assert.equal(deliveryPreflightText(raw), raw);
    assert.match(
      deliveryPreflightText(
        'repository changed; refresh and review the current changes before publishing; nothing was pushed',
      ),
      /仓库已更改/,
    );
    assert.match(
      deliveryPreflightText(
        'switch to a feature branch before publishing; nothing was pushed',
      ),
      /功能分支/,
    );
  } finally {
    setLanguage('en');
  }
});

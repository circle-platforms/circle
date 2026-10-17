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

test('pending publication stays distinct from no-effects rejection and connection guidance points to the original plugin', () => {
  const pending =
    'publication was sent, but GitHub has not confirmed the reviewed commit; refresh PR checks before retrying and do not repeat the push';
  const stale =
    'GitHub candidate changed or the revision is not the inspected opaque revision; read github_candidate and review its current head, revision and paths before publishing; nothing was pushed';
  try {
    setLanguage('en');
    assert.equal(
      deliveryPreflightText('DeliveryConfirmationPendingError: ' + pending),
      pending,
    );
    setLanguage('zh-CN');
    const sent = deliveryPreflightText(
      'DeliveryConfirmationPendingError: ' + pending,
    );
    assert.match(sent, /请求已发送/);
    assert.match(sent, /不要重复推送/);
    assert.doesNotMatch(sent, /尚未推送/);
    assert.match(
      deliveryPreflightText('DeliveryPreflightError: ' + stale),
      /尚未推送任何内容/,
    );
    assert.match(
      deliveryPreflightText(
        'Error: GitHub connection is disconnected or expired',
      ),
      /GitHub 插件详情/,
    );
    for (const raw of [
      'foreign: ' + pending,
      'RemoteProviderError: ' + pending,
      'Error: ' + pending + ' synthetic diagnostic',
    ])
      assert.equal(deliveryPreflightText(raw), raw);
  } finally {
    setLanguage('en');
  }
});

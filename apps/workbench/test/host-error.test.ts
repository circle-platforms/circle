import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage, t } from '../src/i18n/index.ts';
import {
  presentHostError,
  quietWhenTerminalExited,
} from '../src/model/host-error.ts';

test('the operation-failure text is said in the interface language', () => {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
  } as Storage;
  const english = 'operation failed; inspect effects before retrying';
  setLanguage('en', storage);
  assert.equal(presentHostError(english), english);
  assert.equal(quietWhenTerminalExited(english), true);
  assert.equal(quietWhenTerminalExited('terminal is not running'), true);
  assert.equal(quietWhenTerminalExited('disk full'), false);
  setLanguage('zh-CN', storage);
  assert.equal(presentHostError(english), t(english));
  assert.equal(presentHostError(english), '操作失败，请先查看影响再重试');
  assert.equal(quietWhenTerminalExited(t(english)), true);
  assert.equal(
    presentHostError(
      'operation outcome needs review; inspect effects before retrying',
    ),
    '操作结果需要核对，请先查看影响再重试',
  );
  assert.equal(
    presentHostError(
      'stored operation result is unavailable; inspect effects before retrying',
    ),
    '已保存的操作结果不可用，请先查看影响再重试',
  );
  setLanguage('en', storage);
});

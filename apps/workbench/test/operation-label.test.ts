import test from 'node:test';
import assert from 'node:assert/strict';
import { operationLabel } from '../src/model/operation-label';
import { setLanguage } from '../src/i18n';
test('operation summaries describe user actions and contain unknown protocol names only in diagnostics', () => {
  setLanguage('en');
  assert.equal(operationLabel('documents', 'save'), 'files · save file');
  assert.equal(
    operationLabel('terminal', 'write'),
    'terminal · send terminal input',
  );
  assert.equal(operationLabel('git', 'push'), 'git · push commits');
  assert.equal(
    operationLabel('internal_secret_service', 'opaque_method'),
    'action · check the result',
  );
  setLanguage('zh-CN');
  assert.equal(operationLabel('documents', 'save'), '文件 · 保存文件');
  assert.equal(operationLabel('terminal', 'write'), '终端 · 发送终端输入');
  assert.equal(
    operationLabel('internal_secret_service', 'opaque_method'),
    '操作 · 核对结果',
  );
  setLanguage('en');
});

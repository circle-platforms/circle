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
    'workspace operation · review effects',
  );
  setLanguage('zh-CN');
  assert.equal(operationLabel('documents', 'save'), '文件 · 保存文件');
  assert.equal(operationLabel('terminal', 'write'), '终端 · 发送终端输入');
  assert.equal(
    operationLabel('internal_secret_service', 'opaque_method'),
    '工作区操作 · 核对实际结果',
  );
  setLanguage('en');
});

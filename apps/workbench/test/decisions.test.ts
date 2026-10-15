import test from 'node:test';
import assert from 'node:assert/strict';
import { setLanguage } from '../src/i18n/index.ts';
import { recordedDecision, recordedTitle } from '../src/model/decisions.ts';

test('a recorded approval shows the reason and the decision in interface words', (t) => {
  setLanguage('en');
  t.after(() => setLanguage('en'));
  assert.equal(
    recordedTitle({
      title: 'execute · only reads',
      tool: 'execute',
      reason: 'only reads',
    }),
    'execute · only reads',
  );
  assert.equal(recordedDecision('approve'), 'allow once');
  assert.equal(recordedDecision('always'), 'allow for this session');
  assert.equal(recordedDecision('prefix'), 'allow command prefix');
  assert.equal(
    recordedDecision('reject: try a smaller command'),
    'reject: try a smaller command',
  );
  setLanguage('zh-CN');
  assert.equal(
    recordedTitle({ title: 'execute · only reads', reason: 'only reads' }),
    'execute · 只读取',
  );
  assert.equal(recordedDecision('approve'), '允许本次');
  assert.equal(recordedDecision('cancelled'), '已取消');
  assert.equal(recordedDecision('reject'), '拒绝');
});

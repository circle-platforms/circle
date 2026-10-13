import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actedOn,
  describedOther,
  describes,
  shownName,
} from '../src/browser/format.js';

test('an action names its element as the snapshot does, and an element without a name by its role', () => {
  assert.equal(
    actedOn('e28', { role: 'link', name: '主机设置' }),
    'e28 link "主机设置"',
  );
  assert.equal(actedOn('e7', { role: 'button', name: '' }), 'e7 button');
});

test("the model's description fits when one holds the other, spaces and the kind of control aside", () => {
  const fits = (description: string, role: string, name: string) =>
    describes(description, { role, name });
  // One holds the other, after trimming and lower case
  assert.equal(fits('网络菜单', 'link', '网络'), true);
  assert.equal(fits('高级按钮', 'button', '高级'), true);
  assert.equal(fits('  Delete ', 'button', 'Delete configuration'), true);
  assert.equal(fits('the Log in button', 'button', 'Log in'), true);
  assert.equal(fits('Login', 'button', 'Log in'), true);
  // Every word but the kind of control is in the name
  assert.equal(
    fits('Proceed link', 'link', 'Proceed to 192.168.1.1 (unsafe)'),
    true,
  );
  assert.equal(fits('Status link', 'link', 'Status in new tab'), true);
  assert.equal(fits('“网络”链接', 'link', '网络设置'), true);
  // A description of nothing in particular, or an element without a name, is no mismatch
  assert.equal(fits('link', 'link', '主机设置'), true);
  assert.equal(fits('close icon', 'button', ''), true);
  assert.equal(fits('', 'button', 'OK'), true);
  // Another element
  assert.equal(fits('网络菜单', 'link', '主机设置'), false);
  assert.equal(fits('删除', 'button', '添加'), false);
  assert.equal(fits('删除按钮', 'button', '添加'), false);
  assert.equal(
    fits('Add configuration', 'button', 'Delete configuration'),
    false,
  );
});

test('a description of another element ends the sentence with a note to look again; the pointer shows the page name first', () => {
  const host = { role: 'link', name: '主机设置' };
  assert.equal(
    `Clicked ${actedOn('e28', host)}${describedOther('网络菜单', host)}.`,
    'Clicked e28 link "主机设置" — you described it as "网络菜单"; check the snapshot.',
  );
  assert.equal(describedOther('主机设置链接', host), '');
  // Upload without a description, or one that is not text
  assert.equal(describedOther(undefined, host), '');
  assert.equal(shownName(host, '网络菜单'), '主机设置');
  assert.equal(
    shownName({ role: 'button', name: '' }, ' close icon '),
    'close icon',
  );
  assert.equal(shownName({ role: 'button', name: '' }, ''), 'button');
});

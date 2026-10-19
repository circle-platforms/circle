import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnerDraft, saveOwnerDraft } from '../src/model/owner-draft';
test('versioned user drafts preserve exact text and bind both owner and field', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const text = '  中文\n' + 'line\n'.repeat(600);
  saveOwnerDraft(storage, 'owner:a', 'git.commit-message', text);
  assert.equal(readOwnerDraft(storage, 'owner:a', 'git.commit-message'), text);
  assert.equal(readOwnerDraft(storage, 'owner:b', 'git.commit-message'), '');
  const record = JSON.parse([...values.values()][0]);
  assert.deepEqual(Object.keys(record).sort(), [
    'field',
    'owner',
    'text',
    'version',
  ]);
  for (const tampered of [
    { ...record, owner: 'wrong' },
    { ...record, field: 'another field' },
  ]) {
    values.set([...values.keys()][0], JSON.stringify(tampered));
    assert.throws(
      () => readOwnerDraft(storage, 'owner:a', 'git.commit-message'),
      /invalid owner draft/,
    );
  }
});
test('storage read and write failures remain explicit rather than reporting persistence', () => {
  const denied = {
    getItem() {
      throw Error('denied');
    },
    setItem() {
      throw Error('quota');
    },
  };
  assert.throws(
    () => readOwnerDraft(denied, 'a', 'git.commit-message'),
    /denied/,
  );
  assert.throws(
    () => saveOwnerDraft(denied, 'a', 'git.commit-message', 'still in editor'),
    /quota/,
  );
});

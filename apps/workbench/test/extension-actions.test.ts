import test from 'node:test';
import assert from 'node:assert/strict';
import {
  phaseAfterExtensionSave,
  reconcileExtensionAction,
  type ExtensionAction,
} from '../src/features/extension-actions.ts';

const action = (patch: Partial<ExtensionAction> = {}): ExtensionAction => ({
  target: false,
  revision: 1,
  phase: 'waiting',
  ...patch,
});

test('github and developer apply without a reload; other extensions still ask for one', () => {
  assert.equal(phaseAfterExtensionSave('live', 'developer', true), 'waiting');
  assert.equal(phaseAfterExtensionSave('live', 'developer', false), 'waiting');
  assert.equal(phaseAfterExtensionSave('live', 'github', true), 'waiting');
  assert.equal(phaseAfterExtensionSave('live', 'observer', true), 'reload');
  assert.equal(phaseAfterExtensionSave('live', 'observer', false), 'waiting');
  assert.equal(
    phaseAfterExtensionSave('preview', 'developer', true),
    'preview',
  );
});

test('developer becomes enabled only once its view is published', () => {
  const enabling = action({ target: true });
  assert.equal(
    reconcileExtensionAction('developer', enabling, {
      enabled: true,
      view: undefined,
    }),
    'keep',
  );
  const done = reconcileExtensionAction('developer', enabling, {
    enabled: true,
    view: { provider: 'developer' },
  });
  assert.notEqual(done, 'keep');
  if (done === 'keep') return;
  assert.equal(done.phase, 'complete');
});

test('a stale snapshot after disable keeps the switch off', () => {
  const disabled = action({ target: false, phase: 'complete' });
  const stale = reconcileExtensionAction('developer', disabled, {
    enabled: true,
    view: { provider: 'developer' },
  });
  assert.notEqual(stale, 'keep');
  if (stale === 'keep') return;
  assert.equal(stale.phase, 'waiting');
  assert.equal(stale.target, false);
  const settled = reconcileExtensionAction('developer', stale, {
    enabled: false,
  });
  assert.notEqual(settled, 'keep');
  if (settled === 'keep') return;
  assert.equal(settled.phase, 'complete');
});

test('a generic extension still completes only after reload', () => {
  assert.equal(
    reconcileExtensionAction(
      'observer',
      action({ target: true, phase: 'reload' }),
      {
        enabled: true,
      },
    ),
    'keep',
  );
  const waiting = action({ target: true, reloaded: true });
  const done = reconcileExtensionAction('observer', waiting, { enabled: true });
  assert.notEqual(done, 'keep');
  if (done === 'keep') return;
  assert.equal(done.phase, 'complete');
});

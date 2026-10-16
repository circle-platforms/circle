import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateActions } from '../src/features/Update.tsx';
import type { UpdateState } from '../../desktop/src/contracts.ts';

test('check now stays available while an update is listed', () => {
  const listed: UpdateState = {
    phase: 'available',
    version: '1.7.4',
    page: 'https://example/releases',
  };
  assert.deepEqual(updateActions(listed), {
    page: true,
    download: false,
    retry: false,
    install: false,
    check: true,
  });
  const ready: UpdateState = {
    phase: 'ready',
    version: '1.7.4',
    linux: { folder: '/opt/Circle', sandbox: true },
  };
  assert.equal(updateActions(ready).install, true);
  assert.equal(updateActions(ready).check, false);
  assert.equal(updateActions({ phase: 'checking' }).check, false);
  assert.equal(
    updateActions({
      phase: 'downloading',
      version: '1.7.4',
      received: 1,
      total: 2,
    }).check,
    false,
  );
  assert.equal(updateActions({ phase: 'current' }).check, true);
});

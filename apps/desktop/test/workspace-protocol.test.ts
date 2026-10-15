import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWorkspaceRequest } from '../src/workspace-protocol.ts';

test('workspace service dispatch admits explicit capabilities only', () => {
  const request = {
    service: 'documents',
    method: 'save',
    params: { path: 'a.ts', expectedRevision: 'before' },
  };
  assert.equal(validateWorkspaceRequest(request), request);
  for (const value of [
    null,
    [],
    {},
    { service: '__proto__', method: 'toString' },
    { service: 'terminal', method: 'exec' },
    { service: 'debug', method: 'sendMessage' },
    { service: 'documents', method: 'read', params: [] },
  ]) {
    assert.throws(() => validateWorkspaceRequest(value));
  }
});

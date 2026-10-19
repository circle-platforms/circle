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
    { service: 'documents', method: 'read', params: [] },
    // Automatic delivery, the debugger and the language service were removed;
    // their old requests name no service.
    { service: 'cycles', method: 'list' },
    { service: 'cycles', method: 'create' },
    { service: 'debug', method: 'launch' },
    { service: 'debug', method: 'setBreakpoints' },
    { service: 'language', method: 'request' },
  ]) {
    assert.throws(() => validateWorkspaceRequest(value));
  }
});

test('native workflow capabilities and recovery use explicit service routes', () => {
  for (const [service, operations] of Object.entries({
    inputs: ['list', 'resolve'],
    events: ['replay'],
    git: ['snapshot', 'applyPatch', 'conflictContinue', 'conflictAbort'],
    tasks: ['createIntegration', 'mergeCandidates', 'settings'],
    delivery: ['login', 'ready'],
  })) {
    for (const method of operations)
      assert.equal(
        validateWorkspaceRequest({ service, method }).method,
        method,
      );
  }
  for (const service of ['inputs', 'events', 'git', 'tasks', 'delivery'])
    assert.throws(() =>
      validateWorkspaceRequest({ service, method: 'executeRaw' }),
    );
});

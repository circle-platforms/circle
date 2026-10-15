import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  enumerateWindowsProcesses,
  WindowsProcessApiError,
  type NativeProcessEntry,
  type WindowsProcessApi,
} from '../src/windows_process_native.js';

function fixture(entries: NativeProcessEntry[]) {
  const closed: bigint[] = [];
  const opened: number[] = [];
  let index = 0;
  const api: WindowsProcessApi = {
    snapshot: () => 1n,
    first: () => entries[(index = 0)],
    next: () => entries[++index],
    open: (pid) => {
      opened.push(pid);
      return BigInt(pid);
    },
    image: (handle) => `C:\\用户 folder\\${handle}\\circle.exe`,
    close: (handle) => {
      closed.push(handle);
    },
  };
  return { api, closed, opened };
}

test('native enumeration visits every matching PID and retains complete Unicode paths', () => {
  const f = fixture([
    { pid: 41, name: 'circle.exe' },
    { pid: 57, name: 'CIRCLE.EXE' },
    { pid: 99, name: 'other.exe' },
  ]);
  const result = enumerateWindowsProcesses(f.api, ['circle'], false);
  assert.deepEqual(result.entries, [
    { pid: 41, path: 'C:\\用户 folder\\41\\circle.exe' },
    { pid: 57, path: 'C:\\用户 folder\\57\\circle.exe' },
  ]);
  assert.equal(result.complete, true);
  assert.deepEqual(f.opened, [41, 57]);
  assert.deepEqual(f.closed, [41n, 57n, 1n]);
});

test('all-image mode visits other names while an empty names filter opens none', () => {
  const all = fixture([{ pid: 41, name: 'other.exe' }]);
  assert.equal(enumerateWindowsProcesses(all.api, [], true).entries.length, 1);
  assert.deepEqual(all.closed, [41n, 1n]);
  const none = fixture([{ pid: 41, name: 'circle.exe' }]);
  assert.deepEqual(enumerateWindowsProcesses(none.api, [], false).entries, []);
  assert.deepEqual(none.opened, []);
  assert.deepEqual(none.closed, [1n]);
});

test('an inaccessible matching process makes absence unknown and still closes the snapshot', () => {
  const f = fixture([{ pid: 41, name: 'circle.exe' }]);
  f.api.open = () => {
    throw new WindowsProcessApiError('open', 5);
  };
  const result = enumerateWindowsProcesses(f.api, ['circle'], false);
  assert.equal(result.complete, false);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.issues, [{ stage: 'open', code: 5 }]);
  assert.deepEqual(f.closed, [1n]);
});

test('a path query failure preserves earlier PIDs and closes every acquired handle', () => {
  const f = fixture([
    { pid: 41, name: 'circle.exe' },
    { pid: 57, name: 'circle.exe' },
  ]);
  const image = f.api.image;
  f.api.image = (handle) => {
    if (handle === 57n) throw new WindowsProcessApiError('image', 122);
    return image(handle);
  };
  const result = enumerateWindowsProcesses(f.api, ['circle'], false);
  assert.deepEqual(result.entries, [
    { pid: 41, path: 'C:\\用户 folder\\41\\circle.exe' },
  ]);
  assert.equal(result.complete, false);
  assert.deepEqual(f.closed, [41n, 57n, 1n]);
});

test('enumeration errors preserve verified entries and cleanup failures remain secondary', () => {
  const f = fixture([{ pid: 41, name: 'circle.exe' }]);
  f.api.next = () => {
    throw new WindowsProcessApiError('enumerate', 87);
  };
  f.api.close = (handle) => {
    f.closed.push(handle);
    if (handle === 1n) throw new WindowsProcessApiError('close', 6);
  };
  const result = enumerateWindowsProcesses(f.api, ['circle'], false);
  assert.equal(result.entries[0]!.pid, 41);
  assert.equal(result.complete, false);
  assert.deepEqual(result.issues, [
    { stage: 'enumerate', code: 87 },
    { stage: 'close', code: 6 },
  ]);
  assert.deepEqual(f.closed, [41n, 1n]);
});

test('invalid snapshots and handles are never closed as acquired resources', () => {
  for (const invalid of [0n, -1n]) {
    const snapshot = fixture([]);
    snapshot.api.snapshot = () => invalid;
    assert.equal(
      enumerateWindowsProcesses(snapshot.api, [], true).complete,
      false,
    );
    assert.deepEqual(snapshot.closed, []);
    const opened = fixture([{ pid: 41, name: 'circle.exe' }]);
    opened.api.open = () => invalid;
    assert.equal(
      enumerateWindowsProcesses(opened.api, ['circle'], false).complete,
      false,
    );
    assert.deepEqual(opened.closed, [1n]);
  }
});

test('first-entry failure closes its snapshot and observation errors cannot prevent cleanup', () => {
  const f = fixture([]);
  f.api.first = () => {
    throw new WindowsProcessApiError('enumerate', 5);
  };
  assert.equal(
    enumerateWindowsProcesses(f.api, [], true, () => {
      throw new Error('observation');
    }).complete,
    false,
  );
  assert.deepEqual(f.closed, [1n]);
});

test('a successful empty snapshot is distinct from a failed enumeration', () => {
  const f = fixture([]);
  const result = enumerateWindowsProcesses(f.api, ['circle'], false);
  assert.equal(result.complete, true);
  assert.equal(result.issueCount, 0);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(f.closed, [1n]);
});

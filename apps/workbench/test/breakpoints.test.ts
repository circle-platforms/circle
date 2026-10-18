import test from 'node:test';
import assert from 'node:assert/strict';
import { debugStatusValue } from '../src/components/debug-status.ts';
import { shownDebugError } from '../src/components/debug-error.ts';
import {
  breakpointLines,
  breakpointsForPath,
  toggleBreakpointLine,
} from '../src/features/breakpoints.ts';
import { setLanguage } from '../src/i18n/index.ts';

test('a gutter click adds a breakpoint line and a second click removes it', () => {
  assert.deepEqual(toggleBreakpointLine([], 4), [4]);
  assert.deepEqual(toggleBreakpointLine([2, 4], 4), [2]);
  assert.deepEqual(toggleBreakpointLine([2], 9), [2, 9]);
  assert.deepEqual(
    breakpointLines([{ line: 3, requestedLine: 2 }, { line: 8 }]),
    [2, 8],
  );
  assert.deepEqual(
    breakpointsForPath(
      { '/workspace/src/main.ts': [{ requestedLine: 6 }] },
      'src/main.ts',
    ),
    [6],
  );
});

test('an idle or stopped debugger reads as not debugging', () => {
  const label = (status: string) => `word:${status}`;
  assert.equal(debugStatusValue('idle', label), 'not debugging');
  assert.equal(debugStatusValue('stopped', label), 'not debugging');
  assert.equal(debugStatusValue('running', label), 'running');
  assert.equal(debugStatusValue('paused', label), 'word:paused');
});

test('a missing debug target is named in Chinese', () => {
  setLanguage('zh-CN');
  assert.equal(
    shownDebugError(Error('debug target is missing: src/missing.js')),
    '找不到调试目标：src/missing.js',
  );
  assert.equal(
    shownDebugError(Error('developer tools are off')),
    '开发者工具未开启',
  );
  setLanguage('en');
  assert.equal(
    shownDebugError(Error('debug target is missing: src/missing.js')),
    'debug target is missing: src/missing.js',
  );
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as terminal from '../src/tui/status_rows.js';
import * as desktop from '../apps/workbench/src/model/format.js';

// The desktop renderer cannot import the terminal's module (it uses node:os), so it keeps
// a copy of the number formats; this holds the two equal.
test('the desktop footer writes tokens and times as the terminal does', () => {
  for (const value of [0, 7, 840, 999, 1000, 12_345, 999_999, 7_824_000])
    assert.equal(desktop.formatTokens(value), terminal.formatTokens(value));
  for (const seconds of [0, 0.4, 12.44, 59.9, 60, 185, 3600, 3725])
    assert.equal(
      desktop.formatBusyElapsed(seconds),
      terminal.formatBusyElapsed(seconds),
    );
});

// A full run starts no more real browsers at once than browser-slots.ts allows only if every test that starts one takes
// a slot, and no slot is ever held twice (#503).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { releaseSlot, takeSlot } from './browser-slots.js';
import { scratch } from './helpers.js';

const holder = (slot: string) => readFileSync(join(slot, 'pid'), 'utf8');
/** A process that has exited: the pid of a child that ran and was waited for. */
const gonePid = () => spawnSync(process.execPath, ['-e', '']).pid!;

test('every test file that starts the installed browser takes a browser slot', () => {
  const folder = new URL('.', import.meta.url);
  const untaken = readdirSync(folder)
    .filter(
      (name) =>
        /\.(m?ts|mjs)$/.test(name) &&
        !['browser-slots.ts', 'browser-chrome-helpers.ts'].includes(name),
    )
    .filter((name) => {
      const text = readFileSync(new URL(name, folder), 'utf8');
      return (
        /\bfindBrowser\(/.test(text) &&
        !/from '\.\/browser-(slots|chrome-helpers)\.js'|import '\.\/browser-slots\.js'/.test(
          text,
        )
      );
    });
  assert.deepEqual(untaken, []);
});

test('a slot whose record is still being written is held, not free', (t) => {
  const root = scratch(t, 'circle-slots-');
  // Taken a moment ago; its holder has not written its record yet, or has written only part of it
  mkdirSync(join(root, 'slot-0'));
  assert.equal(takeSlot(root, 1), undefined);
  writeFileSync(join(root, 'slot-0', 'pid'), '');
  assert.equal(takeSlot(root, 1), undefined);
  assert.equal(holder(join(root, 'slot-0')), '');
  // Left that way long enough, its holder died between taking it and writing it
  const slot = takeSlot(root, 1, -1);
  assert.equal(slot, join(root, 'slot-0'));
  assert.equal(holder(slot), String(process.pid));
});

test('a slot whose holder has exited is taken over; a running holder keeps its slot', (t) => {
  const root = scratch(t, 'circle-slots-');
  mkdirSync(join(root, 'slot-0'));
  writeFileSync(join(root, 'slot-0', 'pid'), String(process.ppid));
  mkdirSync(join(root, 'slot-1'));
  writeFileSync(join(root, 'slot-1', 'pid'), String(gonePid()));
  const slot = takeSlot(root, 2);
  assert.equal(slot, join(root, 'slot-1'));
  assert.equal(holder(slot), String(process.pid));
  assert.equal(holder(join(root, 'slot-0')), String(process.ppid));
  // Nothing set aside is left behind
  assert.deepEqual(readdirSync(root).sort(), ['slot-0', 'slot-1']);
  assert.equal(takeSlot(root, 2), undefined);
});

test('a holder gives back only a slot whose record is still its own', (t) => {
  const root = scratch(t, 'circle-slots-');
  const slot = takeSlot(root, 1)!;
  // Taken over by another holder while this one was thought gone: that holder's slot now
  writeFileSync(join(slot, 'pid'), String(process.ppid));
  releaseSlot(slot);
  assert.equal(holder(slot), String(process.ppid));
  writeFileSync(join(slot, 'pid'), String(process.pid));
  releaseSlot(slot);
  assert.equal(existsSync(slot), false);
  assert.equal(takeSlot(root, 1), slot);
});

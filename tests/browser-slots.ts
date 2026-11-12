// The browser slots: no more real browsers at once, across every test process of a run, than this machine starts
// within their startup time. Importing this module makes each ChromeBrowser that runs the installed browser take a slot
// before it starts and give it back when it closes; a browser started with another executable (a stand-in) takes none.
// Every test that starts the real browser imports it, directly or through browser-chrome-helpers.ts, and
// browser-slots.test.ts checks that none forgets (#503).
//
// A slot is a folder `slot-<n>` with a file `pid` naming the process that holds it. The file appears whole or not at
// all (written aside, then renamed), so a process looking at the slots never reads a holder's record half written and
// takes a held slot for a free one. A slot without a record is left alone until it is old; one whose holder has exited
// is taken over; a holder removes its slot only while the record there is still its own.
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChromeBrowser, findBrowser } from '../src/browser/chrome.js';

const executable = findBrowser();
const slotRoot = join(tmpdir(), 'circle-test-chrome-slots');
const maxChromeSlots = process.platform === 'win32' ? 3 : 4;
/** How old a slot without a record is before its holder counts as gone: it died between taking it and writing it. */
const unrecordedMs = 10_000;
const heldSlots = new WeakMap<ChromeBrowser, Promise<string | undefined>>();
const processSlots = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The process a slot names, or undefined while it has no whole record. */
function holderOf(slot: string): number | undefined {
  try {
    const text = readFileSync(join(slot, 'pid'), 'utf8').trim();
    return /^[1-9]\d*$/.test(text) ? Number(text) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether this process took a free slot: the folder is the claim, and its record appears whole. */
function claimed(slot: string): boolean {
  try {
    mkdirSync(slot);
  } catch {
    return false;
  }
  const record = join(slot, `pid.${randomUUID()}`);
  writeFileSync(record, String(process.pid));
  renameSync(record, join(slot, 'pid'));
  return true;
}

/** Whether a held slot's holder is gone: it has exited, or never wrote its record and the slot is old. */
function gone(slot: string, holder: number | undefined, unrecorded: number) {
  if (holder !== undefined) return !pidAlive(holder);
  try {
    return Date.now() - statSync(slot).mtimeMs > unrecorded;
  } catch {
    return false;
  }
}

/**
 * Frees a slot whose holder is gone. It is moved aside first, so of two processes that find it gone at once only one
 * frees it, and it is put back when the record moved is not the one found gone: the slot was taken again since.
 */
function takeOver(slot: string, holder: number | undefined): boolean {
  const aside = `${slot}.gone-${process.pid}-${randomUUID()}`;
  try {
    renameSync(slot, aside);
  } catch {
    return false;
  }
  if (holderOf(aside) === holder) {
    rmSync(aside, { recursive: true, force: true });
    return true;
  }
  try {
    renameSync(aside, slot);
  } catch {
    rmSync(aside, { recursive: true, force: true });
  }
  return false;
}

/** One look at the slots: the one this process took, or undefined while every slot is held. */
export function takeSlot(
  root = slotRoot,
  slots = maxChromeSlots,
  unrecorded = unrecordedMs,
): string | undefined {
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < slots; i++) {
    const slot = join(root, `slot-${i}`);
    if (claimed(slot)) return slot;
    const holder = holderOf(slot);
    if (
      gone(slot, holder, unrecorded) &&
      takeOver(slot, holder) &&
      claimed(slot)
    )
      return slot;
  }
  return undefined;
}

/** Gives a slot back, unless it was taken over: then the record is another holder's, and the slot theirs. */
export function releaseSlot(slot: string): void {
  if (holderOf(slot) !== process.pid) return;
  try {
    rmSync(slot, { recursive: true, force: true });
  } catch {}
}

async function claimSlot(): Promise<string> {
  for (;;) {
    const slot = takeSlot();
    if (slot) {
      processSlots.add(slot);
      return slot;
    }
    await delay(100);
  }
}

export async function acquireChromeSlot(chrome: ChromeBrowser): Promise<void> {
  const options = (chrome as unknown as { options?: { executable?: string } })
    .options;
  if (!executable || options?.executable !== executable) return;
  let pending = heldSlots.get(chrome);
  if (!pending) {
    pending = claimSlot();
    heldSlots.set(chrome, pending);
  }
  await pending;
}

async function releaseChromeSlot(chrome: ChromeBrowser): Promise<void> {
  const pending = heldSlots.get(chrome);
  if (!pending) return;
  heldSlots.delete(chrome);
  const slot = await pending.catch(() => undefined);
  if (slot) {
    processSlots.delete(slot);
    releaseSlot(slot);
  }
}

process.on('exit', () => {
  for (const slot of processSlots) releaseSlot(slot);
});

const proto = ChromeBrowser.prototype as unknown as {
  start: () => Promise<unknown>;
  close: () => Promise<void>;
};
const originalStart = proto.start;
proto.start = async function (this: ChromeBrowser) {
  await acquireChromeSlot(this);
  try {
    return await originalStart.call(this);
  } catch (error) {
    await releaseChromeSlot(this);
    throw error;
  }
};
const originalClose = proto.close;
proto.close = async function (this: ChromeBrowser) {
  try {
    return await originalClose.call(this);
  } finally {
    await releaseChromeSlot(this);
  }
};

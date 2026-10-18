// The page records events it receives. Circle no longer draws a console for them.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function runNativeBrowserStream({
  page,
  emit,
  output,
  readGuest,
}) {
  assert.equal(typeof readGuest, 'function');
  assert.equal(await page.locator('.browser-diagnostics').count(), 0);
  const markers = [];
  for (let i = 0; i < 30; i++) markers.push('JOURNEY_PUSH_' + i);
  for (const marker of markers) emit(marker);
  const deadline = Date.now() + 8000;
  let seen = [];
  for (;;) {
    seen = await readGuest(
      'Array.isArray(window.__journeyEvents) ? window.__journeyEvents.slice() : []',
    );
    if (markers.every((marker) => seen.includes(marker))) break;
    if (Date.now() > deadline)
      throw Error('the page did not receive the event stream');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const receipt = {
    kind: 'page EventSource received the fixture stream',
    markers: markers.length,
    seen: seen.length,
  };
  await writeFile(
    join(output, 'browser-stream-receipt.json'),
    JSON.stringify(receipt, null, 2),
  );
  assert.equal(receipt.seen >= markers.length, true);
}

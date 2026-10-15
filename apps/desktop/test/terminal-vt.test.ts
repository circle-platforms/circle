import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { renderTerminalOutput } from './helpers/terminal-vt.mjs';
const expected = 'x'.repeat(65536);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function repainted(payload: string) {
  const content = 'CONPTY_TAIL_' + payload + '_END';
  let raw = '';
  for (let offset = 0; offset < content.length; offset += 80) {
    const part = content.slice(offset, offset + 80);
    raw += part;
    // A real VT cursor move and rewrite of the existing last cell. Stripping
    // escapes would count that cell twice; an emulator must apply the repaint.
    if (part.length === 80 && offset + 80 < content.length)
      raw += '\x1b[' + Math.min(offset / 80 + 1, 24) + ';80H' + part.at(-1);
  }
  return raw + '\r\n';
}
async function payloadOf(raw: string) {
  const rendered = await renderTerminalOutput(raw),
    text = rendered.lines.map((line) => line.text).join('');
  const begin = text.indexOf('CONPTY_TAIL_'),
    end = text.indexOf('_END', begin + 12);
  assert.ok(begin >= 0 && end > begin);
  return text.slice(begin + 12, end);
}
test('the product VT parser resolves cursor-cell repainting before exact 64KB length and hash verification', async () => {
  const raw = repainted(expected);
  assert.ok(
    (raw.match(/x/g) ?? []).length > 65536,
    'raw printable characters include repaint duplicates',
  );
  const actual = await payloadOf(raw);
  assert.equal(actual.length, 65536);
  assert.equal(Buffer.byteLength(actual), 65536);
  assert.equal(sha(actual), sha(expected));
  assert.equal(actual, expected);
});
test('VT normalization still detects missing, duplicated and changed payload bytes even when both frame markers survive', async () => {
  for (const corrupt of [
    expected.slice(1),
    expected + 'x',
    expected.slice(0, 32000) + 'y' + expected.slice(32001),
  ]) {
    const actual = await payloadOf(repainted(corrupt));
    assert.notEqual(sha(actual), sha(expected));
    assert.notEqual(actual, expected);
  }
});

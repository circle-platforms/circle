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

// The two actual Windows CI logs had 920 initial double-width characters,
// followed by 577 forty-character rows plus one repaint of the prior last cell.
// That stream contains 24,578 printable characters for 24,000 terminal cells.
function repaintedDoubleWidth(payload: string) {
  let raw = '\x1b[2J\x1b[HREADY\r\n' + payload.slice(0, 920);
  for (let offset = 920; offset < payload.length; offset += 40)
    raw +=
      '\r\n\x1b[23;79H' +
      payload[offset - 1] +
      payload.slice(offset, offset + 40);
  // A partial final row has no last-column cell to repaint.
  return (
    raw +
    (payload.length % 40 === 0 ? '\r\n\x1b[23;79H' + payload.at(-1) : '\r\n') +
    'same original inpu\r\n'
  );
}
async function doubleWidthPayloadOf(raw: string) {
  const rendered = await renderTerminalOutput(raw, { cols: 80, rows: 24 });
  const text = rendered.lines.map((line) => line.text).join('');
  return text.slice(text.indexOf('尾'), text.lastIndexOf('尾') + 1);
}
test('actual ConPTY double-width cell repaint preserves the exact 24,000-character Unicode payload', async () => {
  const expected = '尾'.repeat(24000);
  const raw = repaintedDoubleWidth(expected);
  assert.equal((raw.match(/尾/g) ?? []).length, 24578);
  assert.equal(raw.includes(expected), false, 'the original raw oracle fails');
  const actual = await doubleWidthPayloadOf(raw);
  assert.equal(actual.length, 24000);
  assert.equal(Buffer.byteLength(actual), 72000);
  assert.equal(sha(actual), sha(expected));
  assert.equal(actual, expected);
});
test('double-width VT parsing retains missing, duplicated and changed Unicode tail evidence', async () => {
  const expected = '尾'.repeat(24000);
  for (const corrupt of [
    expected.slice(1),
    expected + '尾',
    expected.slice(0, 12000) + '末' + expected.slice(12001),
  ]) {
    const actual = await doubleWidthPayloadOf(repaintedDoubleWidth(corrupt));
    assert.equal(actual, corrupt, 'normalization must preserve the corruption');
    assert.notEqual(actual, expected);
    assert.notEqual(sha(actual), sha(expected));
  }
});

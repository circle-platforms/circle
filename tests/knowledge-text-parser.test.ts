// Adapted unchanged test cases from pinned Circle Hub (Apache-2.0).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ParseEncodingError,
  ParseLimitError,
  ParseSyntaxError,
} from '../src/knowledge/portable/parser.js';
import {
  MAX_SELECTOR_LENGTH,
  selectorSegment,
} from '../src/knowledge/portable/reference.js';
import { textParser } from '../src/knowledge/portable/parsers/text.js';
import { latin1, utf8 } from './knowledge-parser-support.js';

describe('text@1', () => {
  const text = '第一行\r\nsecond\rthird\n\nfifth\u0000!\n';
  const document = textParser.parse(utf8(text));

  it('splits on CRLF, CR and LF without an extra final line', () => {
    assert.deepEqual(document.model.lines, [
      '第一行',
      'second',
      'third',
      '',
      'fifth!',
    ]);
    assert.equal(document.model.nulRemoved, 1);
    assert.deepEqual(document.listSelectors(), [
      'l/1',
      'l/2',
      'l/3',
      'l/4',
      'l/5',
    ]);
    assert.deepEqual(textParser.parse(utf8('')).model.lines, []);
    assert.deepEqual(textParser.parse(utf8('x')).model.lines, ['x']);
  });

  it('locates lines and line ranges with byte ranges on the original bytes', async () => {
    const one = (await document.locate('l/1'))!;
    assert.equal(one.text, '第一行');
    assert.deepEqual(one.byteRange, [0, 9]);
    const range = (await document.locate('l/2-3'))!;
    assert.equal(range.text, 'second\nthird');
    const [from, to] = range.byteRange!;
    assert.equal(
      Buffer.from(utf8(text)).subarray(from, to).toString('utf8'),
      'second\rthird',
    );
    assert.equal((await document.locate('l/5'))!.text, 'fifth!');
  });

  it('refuses selectors outside the text or written loosely', async () => {
    for (const selector of [
      'l/0',
      'l/6',
      'l/3-3',
      'l/4-2',
      'l/01',
      'l/1-9',
      'l',
      'x/1',
      'l/1/2',
    ])
      assert.equal(await document.locate(selector), null, selector);
  });

  it('decodes the declared charset', () => {
    assert.equal(
      textParser.parse(latin1('café'), {
        mediaType: 'text/plain; charset=iso-8859-1',
      }).model.lines[0]!,
      'café',
    );
    assert.throws(() => textParser.parse(latin1('café')), ParseEncodingError);
  });

  it('enforces its limits', () => {
    assert.throws(
      () => textParser.parse(utf8('a\n'.repeat(20)), { maxNodes: 10 }),
      (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxNodes',
    );
    assert.throws(
      () => textParser.parse(utf8('abc'), { maxBytes: 2 }),
      (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxBytes',
    );
  });
});

describe('text@1 original UTF-8 for deterministic consumers', () => {
  it('retains exact UTF-8 bytes including BOM, CRLF and NUL without changing lines or selectors', async () => {
    const source = '\ufeff= Synthetic\r\n\r\nbody\u0000!\r\n';
    const parsed = textParser.parse(utf8(source));
    assert.equal(parsed.model.raw_utf8, source);
    assert.deepEqual(Buffer.from(parsed.model.raw_utf8!), Buffer.from(source));
    assert.deepEqual(parsed.model.lines, ['= Synthetic', '', 'body!']);
    assert.equal((await parsed.locate('l/3'))?.text, 'body!');
  });
  it('does not advertise non-UTF-8 source as an exact UTF-8 original', () => {
    const parsed = textParser.parse(latin1('café'), {
      mediaType: 'text/plain; charset=iso-8859-1',
    });
    assert.equal(parsed.model.raw_utf8, undefined);
  });
});

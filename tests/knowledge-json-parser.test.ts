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
import { jsonParser } from '../src/knowledge/portable/parsers/json.js';
import { timed, utf8 } from './knowledge-parser-support.js';

describe('json@1', () => {
  const document = jsonParser.parse(
    utf8(
      '{"items":[{"id":1,"name":"甲"},{"id":2,"tags":["a b",null]}],"a/b":{"c:d":true},"":"empty key","__proto__":{"x":1}}',
    ),
  );

  it('locates values by member names and array indices', async () => {
    assert.equal((await document.locate('p/items/0/name'))!.text, '甲');
    assert.equal((await document.locate('p/items/1/tags/0'))!.text, 'a b');
    assert.equal((await document.locate('p/items/1/tags/1'))!.text, 'null');
    assert.equal((await document.locate('p/items/0/id'))!.text, '1');
    assert.equal((await document.locate('p/a%2Fb/c%3Ad'))!.text, 'true');
    assert.equal(
      (await document.locate('p/items/0'))!.text,
      '{"id":1,"name":"甲"}',
    );
    assert.deepEqual((await document.locate('p/items'))!.data, {
      type: 'array',
      size: 2,
    });
    assert.equal((await document.locate('p/__proto__/x'))!.text, '1');
    assert.equal((await document.locate('p'))!.selector, 'p');
  });

  it('refuses selectors that do not exist', async () => {
    for (const selector of [
      'p/items/2',
      'p/items/01',
      'p/items/-1',
      'p/missing',
      'p/items/0/name/x',
      'q',
      'p/constructor',
      'p/toString',
    ]) {
      assert.equal(await document.locate(selector), null, selector);
    }
  });

  it('lists every addressable value in document order', async () => {
    const selectors = document.listSelectors();
    assert.deepEqual(selectors.slice(0, 5), [
      'p',
      'p/items',
      'p/items/0',
      'p/items/0/id',
      'p/items/0/name',
    ]);
    assert.ok(
      !selectors.some((s) => s.endsWith('/')),
      'the empty member name is not addressable',
    );
    for (const selector of selectors)
      assert.ok(await document.locate(selector), selector);
    assert.equal(document.listSelectors('p/items/1', { limit: 2 }).length, 2);
  });

  it('removes NUL from strings and refuses it in member names', () => {
    const cleaned = jsonParser.parse(utf8('["a\\u0000b", {"k": "\\u0000"}]'));
    assert.deepEqual(cleaned.model, ['ab', { k: '' }]);
    assert.equal(cleaned.summary().nulRemoved, 2);
    assert.throws(
      () => jsonParser.parse(utf8('{"a\\u0000": 1}')),
      ParseSyntaxError,
    );
    assert.equal(jsonParser.parse(utf8('"x\\u0000"')).model, 'x');
  });

  it('reports syntax errors with a byte offset', () => {
    assert.throws(
      () => jsonParser.parse(utf8('{"名": 1,}')),
      (e: unknown) =>
        e instanceof ParseSyntaxError && e.offset !== null && e.offset > 0,
    );
    assert.throws(() => jsonParser.parse(utf8('')), ParseSyntaxError);
    assert.throws(
      () => jsonParser.parse(new Uint8Array([0x22, 0xe4, 0xb8, 0x22])),
      ParseEncodingError,
    );
  });

  it('enforces depth and value limits', () => {
    assert.throws(
      () => jsonParser.parse(utf8('['.repeat(200) + ']'.repeat(200))),
      (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxDepth',
    );
    assert.throws(
      () =>
        jsonParser.parse(
          utf8(JSON.stringify(Array.from({ length: 100 }, (_, i) => i))),
          { maxNodes: 50 },
        ),
      (e: unknown) => e instanceof ParseLimitError && e.limit === 'maxNodes',
    );
    assert.equal(
      jsonParser.parse(utf8('['.repeat(100) + ']'.repeat(100))).summary().depth,
      100,
    );
  });
});

describe('json@1 text that can be stored, and selectors that can be cited', () => {
  it('replaces unpaired surrogates in values and counts them, and refuses them in member names', () => {
    const document = jsonParser.parse(
      utf8('{"a":"case \\ud83d","b":["\\udc00x","ok \\ud83d\\ude00"]}'),
    );
    assert.deepEqual(document.model, { a: 'case �', b: ['�x', 'ok 😀'] });
    assert.equal(document.summary().surrogatesReplaced, 2);
    assert.ok(
      JSON.stringify(document.model) ===
        (
          JSON.stringify(document.model) as string & { toWellFormed(): string }
        ).toWellFormed(),
    );
    assert.throws(
      () => jsonParser.parse(utf8('{"k\\udc00":"v"}')),
      ParseEncodingError,
    );
  });

  it('hides values whose selector would be too long, and stays linear for long names over many values', async () => {
    let value: unknown = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, i) => [`k${i}`, i]),
    );
    for (let d = 0; d < 30; d++) value = { [`m${d}${'q'.repeat(400)}`]: value };
    const bytes = utf8(JSON.stringify(value));
    const outcome = timed(() => {
      const document = jsonParser.parse(bytes);
      return document.listSelectors();
    });
    assert.ok(outcome.ms < 1_500, `took ${outcome.ms.toFixed(0)} ms`);
    const selectors = outcome.value!;
    assert.equal(selectors.length, 11, 'p and the ten levels that fit');
    assert.ok(
      selectors.every((selector) => selector.length <= MAX_SELECTOR_LENGTH),
    );
    const document = jsonParser.parse(bytes);
    assert.equal(
      (await document.locate(selectors[10]!))!.selector,
      selectors[10]!,
    );
    const deeper = `${selectors[10]!}/m19${'q'.repeat(400)}`;
    assert.ok(deeper.length > MAX_SELECTOR_LENGTH && deeper.length < 8192);
    assert.equal(
      await document.locate(deeper),
      null,
      'one level further the selector would be too long to cite',
    );
  });

  it('refuses names just under the budget repeated over many values', () => {
    let value: unknown = Array.from({ length: 30_000 }, () => 0);
    for (let d = 0; d < 9; d++) value = { [`m${d}${'q'.repeat(440)}`]: value };
    const outcome = timed(() => jsonParser.parse(utf8(JSON.stringify(value))));
    assert.ok(outcome.ms < 1_500, `took ${outcome.ms.toFixed(0)} ms`);
    assert.ok(
      outcome.error instanceof ParseLimitError &&
        outcome.error.limit === 'maxSelectorChars',
      String(outcome.error),
    );
  });

  it('lists under a prefix without walking the rest of the document', () => {
    const document = jsonParser.parse(
      utf8(
        JSON.stringify({
          a: Array.from({ length: 300_000 }, (_, i) => i),
          b: { c: [1, 2] },
        }),
      ),
    );
    const outcome = timed(() => document.listSelectors('p/b'));
    assert.deepEqual(outcome.value, ['p/b', 'p/b/c', 'p/b/c/0', 'p/b/c/1']);
    assert.ok(outcome.ms < 200, `took ${outcome.ms.toFixed(0)} ms`);
  });
});

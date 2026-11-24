import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { slashText } from '../src/model/slash-text.ts';
import { BrowserApproval } from '../src/features/InlineRequest.tsx';
import { setLanguage } from '../src/i18n/index.ts';

test('S10/C15: slashText ignores Object.prototype keys and returns fallback text', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('zh-CN');
  for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
    assert.equal(slashText(key, `fallback:${key}`), `fallback:${key}`);
  }
  assert.notEqual(slashText('help', 'fallback'), 'fallback');
});

test('S10/C15: BrowserApproval ignores Object.prototype keys in BROWSER_FIELDS', (t) => {
  t.after(() => setLanguage('en'));
  setLanguage('en');
  const html = renderToStaticMarkup(
    createElement(BrowserApproval, {
      input: {
        url: 'https://example.test',
        constructor: 'proto-ctor',
        toString: 'proto-str',
        hasOwnProperty: 'proto-own',
      },
    }),
  );
  assert.match(html, /<dt>URL<\/dt>/);
  assert.match(html, /<dt>constructor<\/dt>/);
  assert.match(html, /<dt>toString<\/dt>/);
  assert.match(html, /<dt>hasOwnProperty<\/dt>/);
  assert.match(html, /<code>proto-ctor<\/code>/);
});

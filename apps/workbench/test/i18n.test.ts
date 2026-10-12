import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ZH_CN } from '../src/i18n/zh-CN/index.ts';
import {
  loadLanguage,
  setLanguage,
  systemLocale,
  t,
  tn,
} from '../src/i18n/index.ts';

const root = fileURLToPath(new URL('../src/', import.meta.url));
function sources(folder: string): string[] {
  return readdirSync(folder).flatMap((name) => {
    const path = join(folder, name);
    if (statSync(path).isDirectory())
      return name === 'i18n' ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
// The first string literal argument of t(...) and the two of tn(n, ...).
const literal = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;
const T_CALL = new RegExp(String.raw`\bt\(\s*(?:${literal})`, 'g');
const TN_CALL = new RegExp(
  String.raw`\btn\(\s*[^,]+,\s*(?:${literal})\s*,\s*(?:${literal})`,
  'g',
);
const unescape = (value: string) => value.replace(/\\(.)/g, '$1');

test('every interface text passed to t() or tn() has a Simplified Chinese translation', () => {
  const missing = new Set<string>();
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(T_CALL)) {
      const key = unescape(match[1] ?? match[2] ?? '');
      if (!Object.hasOwn(ZH_CN, key)) missing.add(key);
    }
    for (const match of text.matchAll(TN_CALL))
      for (const key of [match[1] ?? match[2], match[3] ?? match[4]])
        if (!Object.hasOwn(ZH_CN, unescape(key ?? ''))) missing.add(key!);
  }
  assert.deepEqual([...missing].sort(), []);
});

test('the same English has the same Chinese in every area', async () => {
  const folder = fileURLToPath(new URL('../src/i18n/zh-CN/', import.meta.url));
  const seen = new Map<string, [string, string]>();
  const conflicts: string[] = [];
  for (const name of readdirSync(folder).filter(
    (file) => file !== 'index.ts',
  )) {
    // A URL, not a path: Windows paths are not import specifiers.
    const module = (await import(
      pathToFileURL(join(folder, name)).href
    )) as Record<string, Record<string, string>>;
    for (const dictionary of Object.values(module))
      for (const [english, chinese] of Object.entries(dictionary)) {
        const before = seen.get(english);
        if (before && before[1] !== chinese)
          conflicts.push(
            `${english}: ${before[0]} ${before[1]} / ${name} ${chinese}`,
          );
        else seen.set(english, [name, chinese]);
      }
  }
  assert.deepEqual(conflicts, []);
});

test('translations keep their placeholders', () => {
  for (const [english, chinese] of Object.entries(ZH_CN)) {
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(names(chinese), names(english), english);
    assert.ok(chinese.trim(), `empty translation for ${english}`);
  }
});

test('the language follows the system until one is chosen, and the choice is kept', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  } as Storage;
  assert.equal(systemLocale(['zh-CN', 'en-US']), 'zh-CN');
  assert.equal(systemLocale(['zh-TW']), 'zh-CN');
  assert.equal(systemLocale(['en-US', 'de']), 'en');
  setLanguage('zh-CN', storage);
  assert.equal(t('allow once'), ZH_CN['allow once']);
  assert.equal(
    tn(2, '{n} request waiting for you', '{n} requests waiting for you'),
    ZH_CN['{n} requests waiting for you']!.replace('{n}', '2'),
  );
  setLanguage('en', storage);
  assert.equal(t('allow once'), 'allow once');
  assert.equal(
    tn(1, '{n} request waiting for you', '{n} requests waiting for you'),
    '1 request waiting for you',
  );
  setLanguage('zh-CN', storage);
  loadLanguage(storage);
  assert.equal(t('allow once'), ZH_CN['allow once']);
  // A run with a set language (the checks) ignores the saved choice and keeps it.
  loadLanguage(storage, 'en');
  assert.equal(t('allow once'), 'allow once');
  assert.equal(store.get('circle.workbench.language'), 'zh-CN');
  setLanguage('en', storage);
});

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

test('Chinese sentences use a full-width question mark', () => {
  const half = Object.entries(ZH_CN).filter(([, value]) =>
    /[\u4e00-\u9fff][^。！？]*\?/.test(value),
  );
  assert.deepEqual(
    half.map(([english]) => english),
    [],
  );
});

test('translations keep their placeholders', () => {
  for (const [english, chinese] of Object.entries(ZH_CN)) {
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(names(chinese), names(english), english);
    assert.ok(chinese.trim(), `empty translation for ${english}`);
  }
});

test('Chinese interface wording follows the shared vocabulary without addressing a person', () => {
  const outdated = Object.entries(ZH_CN).filter(([, value]) =>
    /你|(?<!其)他|目录|核验|出处|依据|共享给我的|提交共享|添加条目|种类|继承自上级|历史|修订引文/.test(
      value,
    ),
  );
  assert.deepEqual(outdated, []);
  // These are authentication and file permissions, not content sharing.
  assert.equal(ZH_CN['waiting for GitHub authorization'], '等待 GitHub 授权中');
  assert.equal(ZH_CN['file access granted'], '文件访问已授权');
});

test('knowledge and memory follow the shared vocabulary and never name Hub', async () => {
  const { knowledge } = await import('../src/i18n/zh-CN/knowledge.ts');
  // Circle shows the sync server, never Hub (knowledge interface phase 2, section 1).
  const named = Object.entries(knowledge).filter(([english, chinese]) =>
    /\bHub\b|Hub/.test(
      english.replace(/GitHub/g, '') + chinese.replace(/GitHub/g, ''),
    ),
  );
  assert.deepEqual(named, []);
  const words: Record<string, string> = {
    'sync server not connected': '未连接同步服务器',
    'connected · {name}': '已连接 · {name}',
    'sync to server…': '同步到服务器…',
    'only on this device…': '仅保存在本机…',
    'only on this device': '仅保存在本机',
    mine: '我的',
    team: '团队',
    'shared with me': '与我共享',
    verified: '已验证',
    'pending verification': '待验证',
    conflicts: '有冲突',
    disabled: '已停用',
    'loaded in this session': '本会话已加载',
    'partially loaded in this session': '本会话已部分加载',
    'not loaded in this session': '本会话未加载',
    'the server refused this share and gave no reason':
      '服务器拒绝了这次分享，没有给出原因',
    'confirm share to team': '确认分享到团队',
    'confirm delete': '确认删除',
    'confirm replace': '确认替换',
    'confirm write': '确认写入',
    'shared to team': '已分享到团队',
    'written to my memory': '已写入我的记忆',
    'write memory': '写入记忆',
    'memory in this session': '本会话的记忆',
  };
  for (const [english, chinese] of Object.entries(words))
    assert.equal(ZH_CN[english], chinese, english);
  // The old generic confirmation is gone: every confirmation names its action.
  assert.equal(ZH_CN['confirm change'], undefined);
  for (const value of Object.values(knowledge))
    assert.doesNotMatch(value, /已核验|失效的?条目|共享给我的|个人(?!副本)/);
});

test('connection hints, requests and handoffs use Chinese wording while English keeps its keys', (context) => {
  context.after(() => setLanguage('en'));
  setLanguage('zh-CN');
  assert.equal(t('waiting for runtime connection'), '等待连接运行时中');
  assert.equal(t('connection settings'), '连接设置…');
  assert.equal(
    tn(1, '{n} request waiting for you', '{n} requests waiting for you'),
    '1 个请求等待处理',
  );
  assert.equal(
    tn(3, '{n} request waiting for you', '{n} requests waiting for you'),
    '3 个请求等待处理',
  );
  assert.equal(t('Circle handed it to you'), '等待回应中');
  assert.equal(t('waiting for your response'), '等待回应中');
  setLanguage('en');
  assert.equal(
    t('waiting for runtime connection'),
    'waiting for runtime connection',
  );
  assert.equal(t('connection settings'), 'connection settings');
  assert.equal(t('Circle handed it to you'), 'Circle handed it to you');
});

test('Chinese keeps spaces next to Latin text, numbers and placeholders', () => {
  for (const [key, value] of Object.entries(ZH_CN)) {
    assert.doesNotMatch(
      value,
      /[\p{Script=Han}][A-Za-z0-9{]|[A-Za-z0-9}][\p{Script=Han}]/u,
      key,
    );
    assert.doesNotMatch(
      value,
      /[\p{Script=Han}] {2,}[A-Za-z0-9{]|[A-Za-z0-9}] {2,}[\p{Script=Han}]/u,
      key,
    );
  }
  assert.equal(
    ZH_CN['Circle is using terminal {n}'],
    'Circle 正在使用终端 {n}',
  );
  assert.equal(ZH_CN['Circle is using “{name}”'], 'Circle 正在使用“{name}”');
});

test('active operations say doing while queues, approvals, responses, restarts and retries say waiting', (context) => {
  context.after(() => setLanguage('en'));
  setLanguage('zh-CN');
  for (const [key, value] of Object.entries(ZH_CN)) {
    if (/^(running|reading|searching|listing|looking up|editing) /.test(key))
      assert.match(value, /^正在/, key);
    if (/^waiting to (run|read|search|list|look up|edit) /.test(key))
      assert.match(value, /^等待/, key);
  }
  for (const key of [
    'merging {done}/{total}',
    'compacting',
    'compacting {done}/{total}',
    'recovering {done}/{total}',
    'loading file',
    'saving file',
    'preparing GitHub authorization code',
    'verifying GitHub account',
  ])
    assert.match(t(key), /^正在/, key);
  for (const key of [
    'waiting for GitHub authorization',
    'waiting for approval',
    'waiting for your response',
    'restarting…',
    'runtime restarting…',
    'retrying {cause} {attempt}',
  ])
    assert.match(t(key), /^等待/, key);
  assert.equal(t('waiting to run a command'), '等待运行中 · 1 条命令');
  assert.equal(t('running a command'), '正在运行 1 条命令');
  const file = 'src/synthetic/waiting for runtime connection.ts';
  assert.equal(t('waiting to read {file}', { file }), `等待读取中 · ${file}`);
  assert.equal(t('reading {file}', { file }), `正在读取 ${file}`);
  assert.equal(t('attach files'), '附加文件…');
  assert.equal(t('open folder'), '打开文件夹…');
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

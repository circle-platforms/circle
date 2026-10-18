// A few terminal words follow the process locale. The rest of the terminal stays
// English. Chinese is the same test the upgrade notice uses: LANG, LC_ALL or LANGUAGE.

export type InterfaceLocale = 'en' | 'zh-CN';

export const DATABASE_BUSY_MESSAGE =
  'the database is busy · another Circle is using this data folder. Wait a moment and start again';
export const DATABASE_WAIT_STATUS = 'waiting for the database…';

const ZH: Record<string, string> = {
  'view only': '只读',
  current: '当前',
  'type to search': '输入以搜索',
  'Sessions · this folder': '会话 · 此文件夹',
  'Sessions · every folder': '会话 · 所有文件夹',
  'enter opens · tab this folder · ctrl+r renames · ctrl+k deletes':
    '回车打开 · tab 此文件夹 · ctrl+r 重命名 · ctrl+k 删除',
  'enter opens · tab every folder · ctrl+r renames · ctrl+k deletes':
    '回车打开 · tab 所有文件夹 · ctrl+r 重命名 · ctrl+k 删除',
  'No sessions saved': '没有已保存的会话',
  'No sessions in this folder': '此文件夹没有会话',
  'No matches': '没有匹配',
  'this session is writable again': '此会话可以继续写入',
  'search quota exceeded': '搜索额度不足',
  'Native search unavailable: search quota exceeded':
    '原生搜索不可用：搜索额度不足',
  'Provider: DuckDuckGo': '提供方：DuckDuckGo',
  [DATABASE_BUSY_MESSAGE]:
    '数据库正忙 · 另一个 Circle 正在使用此数据文件夹。请稍候再启动',
  [DATABASE_WAIT_STATUS]: '正在等待数据库…',
  hook: '钩子',
  hooks: '钩子',
};

/** Chinese when LANG, LC_ALL or LANGUAGE says so; otherwise English. */
export function interfaceLocale(
  env: Record<string, string | undefined> = process.env,
): InterfaceLocale {
  const raw = env.LANGUAGE || env.LC_ALL || env.LANG || '';
  return /^zh\b/i.test(raw) || /(^|:)zh(_|-|\b)/i.test(raw) ? 'zh-CN' : 'en';
}

/** Translate one interface line. Unknown text, and every English locale, stay as written. */
export function uiText(
  text: string,
  locale: InterfaceLocale = interfaceLocale(),
): string {
  if (locale !== 'zh-CN' || !text) return text;
  const exact = ZH[text];
  if (exact) return exact;
  const resumed = /^(Resumed|Continued|Forked) ([\s\S]+)$/.exec(text);
  if (resumed) {
    const verb =
      resumed[1] === 'Resumed'
        ? '已恢复'
        : resumed[1] === 'Continued'
          ? '已继续'
          : '已分叉';
    return `${verb} ${resumed[2]}`;
  }
  const above = /^↑ (\d+) more above$/.exec(text);
  if (above) return `↑ 上方还有 ${above[1]} 个`;
  if (text.startsWith('search: '))
    return `搜索：${text.slice('search: '.length)}`;
  const occupied =
    /^Open in another terminal · view only · circle --fork (\S+) copies it here$/.exec(
      text,
    );
  if (occupied)
    return `已在另一终端打开 · 只读 · circle --fork ${occupied[1]} 可复制到此处`;
  return translateHooks(text)
    .replaceAll('Provider: DuckDuckGo', ZH['Provider: DuckDuckGo']!)
    .replaceAll(
      'Native search unavailable: search quota exceeded',
      ZH['Native search unavailable: search quota exceeded']!,
    )
    .replaceAll('search quota exceeded', ZH['search quota exceeded']!);
}

/** Hook lines. The hook's own reason stays as it wrote it. */
function translateHooks(text: string): string {
  return text
    .replaceAll('Hook denied this call:', '钩子拒绝了此次调用：')
    .replaceAll('Hook asked before this call:', '钩子在调用前要求确认：')
    .replaceAll('Hook allowed this call.', '钩子允许了此次调用。')
    .replaceAll('Hook session_start output:', '钩子会话开始输出：')
    .replaceAll(
      'A hook blocked the end of this turn:',
      '钩子阻止了本回合结束：',
    )
    .replace(/Hook output \(([^)]+)\):/g, '钩子输出（$1）：')
    .replace(/^hook denied (\S+)/, '钩子拒绝了 $1')
    .replace(/^hook asked (\S+)/, '钩子要求确认 $1')
    .replace(/^hook allowed (\S+)/, '钩子允许了 $1')
    .replace(/^hook blocked stop/, '钩子阻止了结束')
    .replace(/^hook stop limit/, '钩子已达到阻止上限')
    .replace(/^hook failed/, '钩子失败')
    .replace(/^hooks active/, '钩子已启用')
    .replace(/^project hooks need trust$/, '项目钩子需要先信任文件夹')
    .replace(/^hook /, '钩子 ');
}

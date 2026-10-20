// Terminal words follow the process locale. English is the key; Simplified Chinese
// is in tui_zh.ts and matches the desktop, so one English word is one Chinese word.
// Stored history stays English. The screen, help and the command line translate
// when the line is drawn or printed.

import { setSlashTranslator } from './tui/slash_commands.js';
import { TUI_ZH } from './tui_zh.js';

export type InterfaceLocale = 'en' | 'zh-CN';

export const DATABASE_BUSY_MESSAGE =
  'the database is busy · another Circle is using this data folder. Wait a moment and start again';
export const DATABASE_WAIT_STATUS = 'waiting for the database…';

export { TUI_ZH };

/** Chinese when LANG, LC_ALL or LANGUAGE says so; otherwise English. */
export function interfaceLocale(
  env: Record<string, string | undefined> = process.env,
): InterfaceLocale {
  const raw = env.LANGUAGE || env.LC_ALL || env.LANG || '';
  return /^zh\b/i.test(raw) || /(^|:)zh(_|-|\b)/i.test(raw) ? 'zh-CN' : 'en';
}

/** Fill `{name}` after choosing the locale's sentence. English stays the template. */
export function t(
  text: string,
  vars: Record<string, string | number> = {},
  locale: InterfaceLocale = interfaceLocale(),
): string {
  const template = locale === 'zh-CN' ? (TUI_ZH[text] ?? text) : text;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    vars[name] === undefined ? whole : String(vars[name]),
  );
}

/** Translate one interface line. Unknown text, and every English locale, stay as written. */
export function uiText(
  text: string,
  locale: InterfaceLocale = interfaceLocale(),
): string {
  if (locale !== 'zh-CN' || !text) return text;
  const exact = TUI_ZH[text];
  if (exact) return exact;
  const patterned = translatePatterns(text, locale);
  if (patterned !== undefined) return patterned;
  return translateHooks(text)
    .replaceAll('Provider: DuckDuckGo', TUI_ZH['Provider: DuckDuckGo']!)
    .replaceAll(
      'Native search unavailable: search quota exceeded',
      TUI_ZH['Native search unavailable: search quota exceeded']!,
    )
    .replaceAll('search quota exceeded', TUI_ZH['search quota exceeded']!);
}

/** How long ago, for the welcome list: `now`, `3m`, `5h`, `2d`. */
export function uiAge(
  text: string,
  locale: InterfaceLocale = interfaceLocale(),
): string {
  if (locale !== 'zh-CN') return text;
  if (text === 'now') return uiText(text, locale);
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) return text;
  const unit = match[2] === 'm' ? '分钟' : match[2] === 'h' ? '小时' : '天';
  return `${match[1]} ${unit}前`;
}

/** `3 in .circle/skills` on the welcome list. */
export function uiFolderCount(
  text: string,
  locale: InterfaceLocale = interfaceLocale(),
): string {
  if (locale !== 'zh-CN') return text;
  const match = /^(\d+) in (.+)$/.exec(text);
  if (!match) return uiText(text, locale);
  return `${match[1]} 个在 ${match[2]}`;
}

function translatePatterns(
  text: string,
  locale: InterfaceLocale,
): string | undefined {
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
    return `已在另一终端打开 · 仅查看 · 用 circle --fork ${occupied[1]} 复制一份到这里继续`;
  const permission = /^(?:(.*?) · )?(\S.*) needs your permission$/.exec(text);
  if (permission && !permission[2]!.includes(' needs your permission'))
    return `${permission[1] ? permission[1] + ' · ' : ''}${permission[2]} 需要你的批准`;
  const allow = /^Allow (.+) for this session$/.exec(text);
  if (allow)
    return `本会话内允许${uiText(allow[1]!, locale).replace(
      /"([^"]*)"/g,
      '“$1”',
    )}`;
  const exit = /^Exit code: (-?\d+)$/.exec(text);
  if (exit) return `退出码 ${exit[1]}`;
  const rejected =
    /^The user rejected this tool call\.(?: A hook asked: (.*?))?(?: The user said: (.*))?$/.exec(
      text,
    );
  if (rejected) {
    const hook = rejected[1] ? ` · ${rejected[1]}` : '';
    const said = rejected[2] !== undefined ? ` · 你说：${rejected[2]}` : '';
    return `已拒绝${hook}${said}`;
  }
  const read = /^Read (\d+) lines?( · ctrl\+o)?$/.exec(text);
  if (read) return `读取了 ${read[1]} 行${read[2] ?? ''}`;
  const edited = /^Edited (.+)$/.exec(text);
  if (edited) return `已编辑 ${edited[1]}`;
  if (text.startsWith('∴ Thought'))
    return '∴ 思考了' + text.slice('∴ Thought'.length);
  if (text.startsWith('∴ Thinking'))
    return '∴ 思考中' + text.slice('∴ Thinking'.length);
  const unknown = /^Unknown command (\/\S+) · (.+)$/.exec(text);
  if (unknown) {
    const tail = unknown[2]!;
    const meant = /^did you mean (\/\S+)\?$/.exec(tail);
    if (meant) return `未知命令 ${unknown[1]} · 你是说 ${meant[1]}？`;
    if (tail === '/help lists them')
      return `未知命令 ${unknown[1]} · /help 会列出它们`;
    if (tail === 'try /help') return `未知命令 ${unknown[1]} · 试试 /help`;
    const enable = /^turn it on with (\/extensions enable \S+)$/.exec(tail);
    if (enable) return `未知命令 ${unknown[1]} · 用 ${enable[1]} 打开它`;
  }
  const created = /^New session (\S+)$/.exec(text);
  if (created) return `新会话 ${created[1]}`;
  const more = /^… \+(\d+) more · \/resume$/.exec(text);
  if (more) return `… 还有 ${more[1]} 个 · /resume`;
  const mode = /^Mode is already (.+)$/.exec(text);
  if (mode) return `已经是${uiText(mode[1]!, locale)}`;
  const retry =
    /^(timeout|network error|server error|rate limited|endpoint error|error) (\d+\/\d+)$/.exec(
      text,
    );
  if (retry) return `${uiText(retry[1]!, locale)} ${retry[2]}`;
  return undefined;
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
    .replaceAll('hook timed out', '钩子超时')
    .replaceAll('hook output is not JSON', '钩子输出不是合法 JSON')
    .replace(/hook exited (\d+)/g, '钩子退出码 $1')
    .replace(/^hook failed/, '钩子失败')
    .replace(/^hooks active/, '钩子已启用')
    .replace(/^project hooks need trust$/, '项目钩子需要先信任文件夹')
    .replace(/^project hooks changed$/, '项目钩子已更改，尚未加载')
    .replace(/ \(([^),]+), project\)/g, '（$1，项目）')
    .replace(/ \(([^),]+), user\)/g, '（$1，用户）')
    .replace(/ \(([^),]+), skill:([^)]+)\)/g, '（$1，技能:$2）')
    .replace(/^hook /, '钩子 ');
}

const EFFORT_WORDS: Record<string, string> = {
  minimal: '推理：最低',
  low: '推理：低',
  medium: '推理：中',
  high: '推理：高',
  xhigh: '推理：很高',
  max: '推理：最大',
};

/** Parentheses around a label. Chinese uses the full-width pair. */
export function uiParen(
  text: string,
  locale: InterfaceLocale = interfaceLocale(),
): string {
  return locale === 'zh-CN' ? `（${text}）` : `(${text})`;
}

/** Header and welcome depth. English stays the level name; Chinese says 推理 plus the depth. */
export function effortLabel(
  depth: string,
  locale: InterfaceLocale = interfaceLocale(),
): string {
  if (locale !== 'zh-CN') return depth;
  return EFFORT_WORDS[depth] ?? depth;
}

setSlashTranslator(t);

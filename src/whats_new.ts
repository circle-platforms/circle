// What changed for someone already using Circle, in both interface languages.
// The desktop home page and the terminal welcome read this same list. Nothing
// here touches the filesystem: the window's bundle can import it.
import { compareVersions, validVersion } from './version.js';

export type NoticeLocale = 'en' | 'zh-CN';
export interface Localized {
  en: string;
  'zh-CN': string;
}
export interface WhatsNewItem {
  /** First release this item belongs to. Shown once, while the last-seen version is older. */
  since: string;
  text: Localized;
}
/** The 1.7.4 section of the changelog. Later notes can name their own section. */
export const RELEASE_NOTES_URL =
  'https://github.com/circle-platforms/circle/blob/main/CHANGELOG.md#174---2026-10-16';

export const WHATS_NEW_ITEMS: WhatsNewItem[] = [
  {
    since: '1.7.0',
    text: {
      en: 'The hub extension is now named hub, with /hub and hub_* tools. circle-server and /server no longer work. Enable hub and sign in again.',
      'zh-CN':
        'hub 扩展现在叫 hub，命令是 /hub，工具是 hub_*。circle-server 和 /server 已不能用。请重新启用 hub 并再次登录。',
    },
  },
  {
    since: '1.7.4',
    text: {
      en: 'alt+l chooses a model; ctrl+l only redraws. alt+c copies the last answer (was ctrl+x). alt+k enters a secret a task waits for (was ctrl+s). alt+d saves a list choice as the default (was ctrl+s). ctrl+k deletes a session in /resume and stops or removes a job (was ctrl+d).',
      'zh-CN':
        'alt+l 选择模型；ctrl+l 只重绘屏幕。alt+c 复制上一条回答（原为 ctrl+x）。alt+k 输入任务等待的密钥（原为 ctrl+s）。alt+d 把列表中的选择存为默认（原为 ctrl+s）。ctrl+k 在 /resume 中删除会话，并停止或移除任务（原为 ctrl+d）。',
    },
  },
  {
    since: '1.7.4',
    text: {
      en: 'Anthropic models now think at medium by default, where it was xhigh. If you had not saved a depth, that xhigh default is no longer used. /effort sets one, and alt+d keeps it.',
      'zh-CN':
        'Anthropic 模型的默认思考深度现在是 medium，以前是 xhigh。如果没有保存过深度，那个 xhigh 默认值不再使用。/effort 可以设定，alt+d 可以记住。',
    },
  },
];

export interface WhatsNewNotice {
  version: string;
  title: Localized;
  items: Localized[];
  linkLabel: Localized;
  link: string;
  dismiss: Localized;
}

/** Chinese when LANG, LC_ALL or LANGUAGE says so; otherwise English. */
export function noticeLocale(
  env: Record<string, string | undefined> = process.env,
): NoticeLocale {
  const raw = env.LANGUAGE || env.LC_ALL || env.LANG || '';
  return /^zh\b/i.test(raw) || /(^|:)zh(_|-|\b)/i.test(raw) ? 'zh-CN' : 'en';
}

/** Items introduced after `seen` and already in `current`. An empty list is not worth a notice. */
export function notesSince(
  seen: string | undefined,
  current: string,
): WhatsNewItem[] {
  const from = seen && validVersion(seen) ? seen : '0.0.0';
  if (!validVersion(current)) return [];
  return WHATS_NEW_ITEMS.filter(
    (item) =>
      compareVersions(item.since, from) > 0 &&
      compareVersions(item.since, current) <= 0,
  );
}

export function noticeFor(
  version: string,
  items: WhatsNewItem[],
): WhatsNewNotice | undefined {
  if (!items.length) return undefined;
  return {
    version,
    title: {
      en: `what's new in ${version}`,
      'zh-CN': `${version} 的变化`,
    },
    items: items.map((item) => item.text),
    linkLabel: { en: 'full release notes', 'zh-CN': '完整的发布说明' },
    link: RELEASE_NOTES_URL,
    dismiss: { en: 'dismiss', 'zh-CN': '知道了' },
  };
}

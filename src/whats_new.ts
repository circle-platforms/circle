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
  id: string;
  /** First release this item belongs to. Shown once, while the last-seen version is older. */
  since: string;
  /** Shown only when the saved settings still name the old extension. */
  when?: 'circle-server';
  text: Localized;
}

/** Release notes for `version`, pinned to that tag. Not the moving main branch. */
export function releaseNotesUrl(version: string): string {
  return `https://github.com/circle-platforms/circle/releases/tag/v${version}`;
}

// Short enough to scan. The release notes carry the full key list.
// alt+l (L) is the model binding (`model.select`). The capital is named so
// a lowercase L is not read as i. alt+k and alt+d both used to be ctrl+s,
// for a secret and for saving a list default; the release notes say which.
export const WHATS_NEW_ITEMS: WhatsNewItem[] = [
  {
    id: 'hub',
    since: '1.7.0',
    when: 'circle-server',
    text: {
      en: 'The circle-server extension is now named hub. Enable hub and sign in again.',
      'zh-CN':
        '原先的 circle-server 扩展现在叫 hub。请重新启用 hub 并再次登录。',
    },
  },
  {
    id: 'keys',
    since: '1.7.4',
    text: {
      en: 'Some keys moved. The model list is alt+l (L). Every change is in the release notes.',
      'zh-CN':
        '部分快捷键已更换。模型列表是 alt+l (L)。每一项都写在发布说明里。',
    },
  },
  {
    id: 'thinking',
    since: '1.7.4',
    text: {
      en: 'Anthropic models think at medium by default. A depth you never saved no longer stays at xhigh.',
      'zh-CN':
        'Anthropic 模型默认以 medium 思考。没有保存过自己的深度时，不再默认使用 xhigh。',
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

const INTERRUPTED_MARK = {
  en: '✖ Interrupted',
  'zh-CN': '✖ 已中断',
} as const;

/**
 * The stop mark. The terminal keeps the English line in its notice list and
 * translates it when drawing, the same words the desktop uses.
 */
export function interruptedMark(locale: NoticeLocale = noticeLocale()): string {
  return INTERRUPTED_MARK[locale];
}

/** Chinese when LANG, LC_ALL or LANGUAGE says so; otherwise English. */
export function noticeLocale(
  env: Record<string, string | undefined> = process.env,
): NoticeLocale {
  const raw = env.LANGUAGE || env.LC_ALL || env.LANG || '';
  return /^zh\b/i.test(raw) || /(^|:)zh(_|-|\b)/i.test(raw) ? 'zh-CN' : 'en';
}

/**
 * Items introduced after `seen` and already in `current`. Hub is included
 * only when `hub` is set: someone who never had circle-server has nothing
 * to rename. An empty list is not worth a notice.
 */
export function notesSince(
  seen: string | undefined,
  current: string,
  options?: { hub?: boolean },
): WhatsNewItem[] {
  const from = seen && validVersion(seen) ? seen : '0.0.0';
  if (!validVersion(current)) return [];
  return WHATS_NEW_ITEMS.filter(
    (item) =>
      (item.when !== 'circle-server' || options?.hub === true) &&
      compareVersions(item.since, from) > 0 &&
      compareVersions(item.since, current) <= 0,
  );
}

export function noticeFor(
  version: string,
  items: WhatsNewItem[],
): WhatsNewNotice | undefined {
  if (!items.length) return undefined;
  const versions = [...new Set(items.map((item) => item.since))].sort(
    compareVersions,
  );
  const span =
    versions.length === 1 ? versions[0]! : `${versions[0]}–${versions.at(-1)}`;
  return {
    version,
    title: {
      en: `what's new in ${span}`,
      'zh-CN': `${span} 的变化`,
    },
    items: items.map((item) => item.text),
    linkLabel: { en: 'full release notes', 'zh-CN': '完整的发布说明' },
    link: releaseNotesUrl(version),
    dismiss: { en: 'dismiss', 'zh-CN': '知道了' },
  };
}

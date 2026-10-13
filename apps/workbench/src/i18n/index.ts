import { useSyncExternalStore } from 'react';
import { ZH_CN } from './zh-CN/index.ts';

/**
 * The interface language. English text is the key: `t('allow once')` is English as
 * written and looks up its Simplified Chinese in ./zh-CN. Only interface words are
 * translated; what the model, a tool or a file says is shown as it is.
 *
 * `{name}` in a text is filled from `vars`. Keep each text a literal at its call so
 * test/i18n.test.ts can check that every one has a translation.
 */
export type Locale = 'en' | 'zh-CN';
export type LanguageChoice = 'system' | Locale;
export const LANGUAGES: LanguageChoice[] = ['system', 'en', 'zh-CN'];
const STORAGE_KEY = 'circle.workbench.language';

let current: Locale = 'en';
let choice: LanguageChoice = 'system';
const listeners = new Set<() => void>();

/** Any Chinese system language reads the Simplified interface; everything else English. */
export function systemLocale(
  languages: readonly string[] = typeof navigator === 'undefined'
    ? []
    : navigator.languages,
): Locale {
  return languages.some((language) => /^zh\b/i.test(language)) ? 'zh-CN' : 'en';
}
export function locale(): Locale {
  return current;
}
export function languageChoice(): LanguageChoice {
  return choice;
}
function fill(template: string, vars?: Record<string, string | number>) {
  return vars
    ? template.replace(/\{(\w+)\}/g, (match, key: string) =>
        Object.hasOwn(vars, key) ? String(vars[key]) : match,
      )
    : template;
}
export function t(text: string, vars?: Record<string, string | number>) {
  return fill(current === 'zh-CN' ? (ZH_CN[text] ?? text) : text, vars);
}
/** `one` when count is 1, else `other`; both get `{n}`. Chinese has one form for both. */
export function tn(
  count: number,
  one: string,
  other: string,
  vars?: Record<string, string | number>,
) {
  return t(count === 1 ? one : other, { n: count, ...vars });
}
/** The locale for dates and numbers. */
export function dateLocale(): string {
  return current === 'zh-CN' ? 'zh-CN' : 'en-GB';
}
function apply(next: Locale) {
  current = next;
  if (typeof document !== 'undefined')
    document.documentElement.lang = next === 'zh-CN' ? 'zh-CN' : 'en';
  for (const listener of listeners) listener();
}
export function setLanguage(next: LanguageChoice, storage?: Storage) {
  choice = next;
  try {
    storage?.setItem(STORAGE_KEY, next);
  } catch {
    /* A private window keeps the choice for this run only. */
  }
  apply(next === 'system' ? systemLocale() : next);
}
/** The saved choice, or the system language the first time; `forced` for one run. */
export function loadLanguage(storage?: Storage, forced?: Locale) {
  if (forced) {
    choice = forced;
    apply(forced);
    return;
  }
  let saved: string | null = null;
  try {
    saved = storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    saved = null;
  }
  choice = LANGUAGES.includes(saved as LanguageChoice)
    ? (saved as LanguageChoice)
    : 'system';
  apply(choice === 'system' ? systemLocale() : choice);
}
export function subscribeLanguage(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
/** Re-renders the caller when the language changes; returns the locale. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLanguage, locale, locale);
}

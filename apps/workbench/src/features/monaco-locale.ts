// Monaco 0.57 fixes command labels at registration. This version-pinned adapter
// refreshes its registries before rebuilding the view, preserving text models.
// Catalog: Microsoft Monaco Editor 0.57, MIT; see ThirdPartyNotices in its package.
import 'monaco-editor/nls/lang/zh-cn';
// These two pinned internal registries have no declarations in the npm package.
import {
  MenuId,
  MenuRegistry,
} from 'monaco-editor/platform/actions/common/actions';
import { EditorExtensionsRegistry } from 'monaco-editor/editor/browser/editorExtensions';
import { locale, subscribeLanguage } from '../i18n';
import labels from './monaco-labels.json';
const globals = globalThis as typeof globalThis & {
  _VSCODE_NLS_MESSAGES?: string[];
  _VSCODE_NLS_LANGUAGE?: string;
};
const chinese = globals._VSCODE_NLS_MESSAGES;
const catalog: Record<string, string> = labels;
const english = new Map(
  Object.entries(catalog).map(([key, value]) => [value, key]),
);
const originals = new WeakMap<object, Record<string, string>>();
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return english.get(value) ?? value;
  if (
    value &&
    typeof value === 'object' &&
    'original' in value &&
    typeof value.original === 'string'
  )
    return value.original;
  return undefined;
}
function update(item: Record<string, unknown>, key: string, original?: string) {
  const saved = originals.get(item) ?? {};
  const source = saved[key] ?? original ?? text(item[key]);
  if (source === undefined) return;
  saved[key] = source;
  originals.set(item, saved);
  const translated =
    locale() === 'zh-CN' ? (catalog[source] ?? source) : source;
  if (item[key] && typeof item[key] === 'object')
    (item[key] as { value: string }).value = translated;
  else item[key] = translated;
}
export function applyMonacoLocale() {
  globals._VSCODE_NLS_MESSAGES = locale() === 'zh-CN' ? chinese : undefined;
  globals._VSCODE_NLS_LANGUAGE = locale() === 'zh-CN' ? 'zh-cn' : 'en';
  const aliases = new Map<string, string>();
  for (const action of EditorExtensionsRegistry.getEditorActions() as {
    id: string;
    label: string;
    alias: string;
  }[]) {
    const original = english.get(action.alias) ?? action.alias;
    aliases.set(action.id, original);
    update(action, 'label', original);
  }
  const commands = MenuRegistry.getCommands() as Map<
    string,
    Record<string, unknown>
  >;
  for (const command of commands.values()) {
    update(command, 'title');
    update(command, 'shortTitle');
    update(command, 'tooltip');
  }
  for (const menu of Object.values(MenuId) as { id?: string }[]) {
    if (typeof menu?.id !== 'string') continue;
    for (const item of MenuRegistry.getMenuItems(menu) as Record<
      string,
      unknown
    >[]) {
      update(item, 'title');
      const command = item.command as Record<string, unknown> | undefined;
      if (command) {
        update(command, 'title', aliases.get(String(command.id)));
        update(command, 'shortTitle');
        update(command, 'tooltip');
      }
    }
  }
}
applyMonacoLocale();
subscribeLanguage(applyMonacoLocale);

// Monaco's catalog must be installed before its editor contributions register.
import 'monaco-editor/nls/lang/zh-cn';
import { locale, subscribeLanguage } from '../i18n';
const globals = globalThis as typeof globalThis & {
  _VSCODE_NLS_MESSAGES?: string[];
  _VSCODE_NLS_LANGUAGE?: string;
};
const chinese = globals._VSCODE_NLS_MESSAGES;
function apply() {
  globals._VSCODE_NLS_MESSAGES = locale() === 'zh-CN' ? chinese : undefined;
  globals._VSCODE_NLS_LANGUAGE = locale() === 'zh-CN' ? 'zh-cn' : 'en';
}
apply();
subscribeLanguage(apply);

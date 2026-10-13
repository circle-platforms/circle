// The words the main process shows itself: menus, system dialogs and notifications. The
// window's own words are in the workbench's i18n; English is the key in both.
export type NativeLocale = 'en' | 'zh-CN';

const ZH_CN: Record<string, string> = {
  settings: '设置',
  file: '文件',
  'new session': '新建会话',
  'open folder': '打开文件夹',
  'import session': '导入会话',
  'export session': '导出会话',
  edit: '编辑',
  view: '视图',
  'session tree': '会话树',
  'reload window': '重新加载窗口',
  window: '窗口',
  help: '帮助',
  'Circle help': 'Circle 帮助',
  'About Circle': '关于 Circle',
  'Hide Circle': '隐藏 Circle',
  'Hide Others': '隐藏其他',
  'Show All': '全部显示',
  'Quit Circle': '退出 Circle',
  'Close Window': '关闭窗口',
  Undo: '撤销',
  Redo: '重做',
  Cut: '剪切',
  Copy: '拷贝',
  Paste: '粘贴',
  'Select All': '全选',
  'Toggle Developer Tools': '开发者工具',
  'Actual Size': '实际大小',
  'Zoom In': '放大',
  'Zoom Out': '缩小',
  'Toggle Full Screen': '切换全屏',
  Minimize: '最小化',
  Zoom: '缩放',
  'Bring All to Front': '前置全部窗口',
  'import a session': '导入会话',
  'choose files': '选择文件',
  'session or text': '会话或文本',
  'supported files': '支持的文件',
  'open a workspace': '打开工作区',
  'Circle could not stop its runtime': 'Circle 无法停止运行时',
  'Circle needs your approval': 'Circle 需要你的批准',
  'Circle needs a secret': 'Circle 需要一个密钥',
  'Circle has a question': 'Circle 有一个问题',
  'Circle finished': 'Circle 已完成',
  'Circle stopped with an error': 'Circle 因错误停止',
};
export const isNativeLocale = (value: unknown): value is NativeLocale =>
  value === 'en' || value === 'zh-CN';
/** Any Chinese system language reads the Simplified interface, as the window does. */
export const systemNativeLocale = (languages: string[]): NativeLocale =>
  languages.some((language) => /^zh\b/i.test(language)) ? 'zh-CN' : 'en';
export function nativeText(locale: NativeLocale) {
  return (text: string) => (locale === 'zh-CN' ? (ZH_CN[text] ?? text) : text);
}

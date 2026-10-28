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
  'save image': '保存图片',
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
  'Open Circle': '打开 Circle',
  'Circle is still running': 'Circle 仍在运行',
  'right-click the tray icon to quit': '右键点击托盘图标可退出',
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
  'allow one external file': '授权一个外部文件',
  'allow read': '允许读取',
  'allow read and write': '允许读写',
  'choose one file for this session to read': '选择允许此会话读取的一个文件',
  'choose one file for this session to read and write':
    '选择允许此会话读写的一个文件',
  'session or text': '会话或文本',
  'supported files': '支持的文件',
  'Circle could not stop its runtime': 'Circle 无法停止运行时',
  'Circle needs your approval': 'Circle 需要你的批准',
  'Circle needs a secret': 'Circle 需要一个密钥',
  'Circle has a question': 'Circle 有一个问题',
  'Circle finished': 'Circle 已完成',
  'Circle stopped with an error': 'Circle 因错误停止',
  click: '点击',
  type: '输入',
  select: '选择',
  // The page's context menu in the browser panel, in Chrome's words
  Back: '返回',
  Forward: '前进',
  Reload: '重新加载',
  'Open link in new tab': '在新标签页中打开链接',
  'Copy link address': '复制链接地址',
  'Open image in new tab': '在新标签页中打开图片',
  'Copy image': '复制图片',
  'Copy image address': '复制图片地址',
  'Select all': '全选',
  Inspect: '检查',
  // The certificate warning Circle shows inside a browser tab, in Chrome's words
  'Privacy error': '隐私设置错误',
  'Your connection is not private': '您的连接不是私密连接',
  'Attackers might be trying to steal your information from {host} (for example, passwords, messages or credit cards).':
    '攻击者可能会试图从 {host} 窃取您的信息（例如：密码、消息或信用卡信息）。',
  Advanced: '高级',
  'Hide advanced': '隐藏详情',
  'Back to safety': '返回安全连接',
  'This server could not prove that it is {host}; its security certificate is not trusted by your device. This may be caused by a misconfiguration or an attacker intercepting your connection.':
    '此服务器无法证明它是 {host}；您的设备不信任该服务器的安全证书。出现此问题的原因可能是配置有误或您的连接被拦截了。',
  'Proceed to {host} (unsafe)': '继续前往 {host}（不安全）',
  'Issued to': '颁发给',
  'Issued by': '颁发者',
  'Valid from': '有效期开始',
  'Valid until': '有效期至',
  'SHA-256 fingerprint': 'SHA-256 指纹',
};
export const isNativeLocale = (value: unknown): value is NativeLocale =>
  value === 'en' || value === 'zh-CN';
/** Any Chinese system language reads the Simplified interface, as the window does. */
export const systemNativeLocale = (languages: string[]): NativeLocale =>
  languages.some((language) => /^zh\b/i.test(language)) ? 'zh-CN' : 'en';
export function nativeText(locale: NativeLocale) {
  return (text: string) => (locale === 'zh-CN' ? (ZH_CN[text] ?? text) : text);
}

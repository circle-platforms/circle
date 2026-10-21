// The terminal is English. The desktop runs this core as its runtime, starts it with
// CIRCLE_DESKTOP_RUNTIME_HOME and, when its interface is Chinese, with LANG and LANGUAGE
// in Chinese; the few messages it shows as the core wrote them follow that.

export const DATABASE_BUSY_MESSAGE =
  'the database is busy · another Circle is using this data folder. Wait a moment and start again';
export const DATABASE_WAIT_STATUS = 'waiting for the database…';

const DESKTOP_ZH: Record<string, string> = {
  [DATABASE_BUSY_MESSAGE]:
    '数据库正忙 · 另一个 Circle 正在使用此数据文件夹。请稍候再启动',
  'missing API key': '缺少 API 密钥',
  'missing API key; re-run circle --init':
    '缺少 API 密钥；请重新运行 circle --init',
};

/** The desktop's runtime with a Chinese interface. The terminal never is. */
export function desktopChinese(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!env.CIRCLE_DESKTOP_RUNTIME_HOME) return false;
  const raw = env.LANGUAGE || env.LC_ALL || env.LANG || '';
  return /^zh\b/i.test(raw) || /(^|:)zh(_|-|\b)/i.test(raw);
}

/** A message the desktop shows as written here, in the desktop's language. */
export function desktopText(
  text: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return (desktopChinese(env) && DESKTOP_ZH[text]) || text;
}

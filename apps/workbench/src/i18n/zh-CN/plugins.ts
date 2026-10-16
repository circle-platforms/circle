// Simplified Chinese for the interface words in the plugins files. English is the key.
export const plugins: Record<string, string> = {
  'limited view: {shown} shown, {omitted} omitted · {bytes} byte budget':
    '视图限额：显示 {shown} 项，省略 {omitted} 项 · {bytes} 字节预算',
  '{count} text fields shortened': '已缩短 {count} 个文字字段',
  'full task details and results remain on hub':
    '完整任务详情和结果仍保存在 hub',
  'counts apply to the records returned by this refresh':
    '计数仅涵盖本次刷新返回的记录',
  // the bundled interface components
  'file and diff inspector': '文件与差异检查器',
  'Workspace files, local preview buffers and change comparison.':
    '工作区文件、本地预览缓冲区和改动对比。',
  files: '文件',
  changes: '改动',
  'activity inspector': '活动检查器',
  'Circle background jobs, subagents and pending interactions.':
    'Circle 的后台任务、子代理和待处理的请求。',
  activity: '活动',
  'browser pane': '浏览器面板',
  'The same browser session shared with the future desktop host.':
    '与未来的桌面宿主共享同一个浏览器会话。',
  browser: '浏览器',
  // a component that failed to draw
  '{name} could not be displayed': '无法显示 {name}',
  'The conversation and other components remain available.':
    '对话和其他组件仍然可用。',
  retry: '重试',
  // the device terminal pane and its plugin
  'device terminals': '设备终端',
  'device terminal pane': '设备终端面板',
  'SSH and Telnet consoles shared with Circle.':
    '与 Circle 共享的 SSH 和 Telnet 控制台。',
};

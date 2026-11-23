export const hubConnection: Record<string, string> = {
  send: '发送',
  'answer the bot': '回答机器人',
  'private chat acknowledged': '企微已确认接收',
  'private chat delivery unknown': '企微送达未知',
  'private chat delivery refused': '企微未送达',
  'private chat not bound': '尚未绑定企微身份',
  'waiting for private chat delivery': '等待企微送达',
  'my bot': '我的机器人',
  'remote bot disconnected': '机器人连接中断',
  'new bot conversation': '新建机器人对话',
  'message your bot': '给机器人发消息',
  'Hub plugin': 'Hub 插件',
  'Connect a Circle Hub by its IP address and sign in with your Hub account.':
    '填写 IP 地址连接 Circle Hub，用 Hub 账号登录。',
  'Hub connection': 'Hub 连接',
  'Type your Hub’s IP address. Circle then opens the Hub’s page, where you sign in with your Hub user name and password.':
    '填写 Hub 的 IP 地址。Circle 随后打开 Hub 的网页，在网页上用 Hub 的用户名和密码登录。',
  'hub IP address': 'Hub 的 IP 地址',
  'Hub at {address}': 'Hub：{address}',
  '{n} tool available': '{n} 个工具可用',
  '{n} tools available': '{n} 个工具可用',
  'waiting for sign-in': '等待登录中',
  'sign in on the Hub’s page with your Hub user name and password':
    '在 Hub 的网页上用 Hub 的用户名和密码登录',
  'then enter this code there': '然后在网页上输入此代码',
  'open the Hub’s page': '打开 Hub 页面',
  'The Hub could not be connected.': '无法连接 Hub。',
  'no Circle Hub answers at {addresses}':
    '在 {addresses} 都没有找到 Circle Hub',
  'type the IP address of your Hub': '填写 Hub 的 IP 地址',
  'that is not an IP address or a web address': '这不是 IP 地址，也不是网址',
  'a Hub address starts with https:// or http://':
    'Hub 地址以 https:// 或 http:// 开头',
  'type your user name and password on the Hub’s page, not in its address':
    '用户名和密码在 Hub 的网页上填写，不写进地址',
  'a Hub address has no query or fragment': 'Hub 地址不带查询参数或片段',
  'type the Hub address without a path': 'Hub 地址不带路径',
  'Circle update required': '需要更新 Circle',
  'Hub rejected this Circle version for my bot.':
    'Hub 拒绝了当前 Circle 版本的机器人连接。',
  'Update Circle desktop, then reconnect.': '请更新 Circle 桌面版后重新连接。',
  'invalid client version': '客户端版本无效',
  'Hub could not recognize the Circle client version header.':
    'Hub 无法识别当前 Circle 客户端版本头。',
  'Reinstall or update Circle desktop, then try again.':
    '请重新安装或更新 Circle 桌面版后再重试。',
  'my bot is disabled': '我的机器人已停用',
  'Your Hub administrator has disabled my bot access.':
    'Hub 管理员已停用机器人功能。',
  'Ask your Hub administrator to enable it, then retry.':
    '请联系 Hub 管理员启用后再重试。',
  'direct member token required': '需要使用直接成员令牌',
  'Hub refused the OAuth sign-in token for my bot API.':
    'Hub 拒绝了 OAuth 登录令牌对机器人接口的访问。',
  'Configure a direct member Bearer token in the Hub MCP settings, then retry.':
    '请在 Hub 的 MCP 设置中配置直接成员 Bearer 令牌后再重试。',
  'bot sign-in expired': '机器人登录已过期',
  'Hub rejected the credential because it expired or was revoked.':
    'Hub 拒绝了当前凭据，可能已过期或被撤销。',
  'Sign in to Hub again in Settings -> Extensions, then retry.':
    '请在 设置 -> 扩展 中重新登录 Hub 后再重试。',
  'Cannot reach the Hub bot endpoint right now.':
    '暂时无法连接到 Hub 机器人接口。',
  'Circle will retry automatically with backoff, or retry now.':
    'Circle 将按退避间隔自动重试，也可以立即手动重试。',
  'remote bot request failed': '机器人请求失败',
  'Hub returned an unexpected error for my bot.':
    'Hub 返回了未预期的机器人错误。',
  'Check the Hub connection and retry.': '请检查 Hub 连接状态后再重试。',
  'select up to eight files': '最多只能选择 8 个文件',
  'symbolic links cannot be attached': '无法附加符号链接',
  'only a regular file can be attached': '只能附加普通文件',
  'file exceeds the 100 MiB limit': '文件超过 100 MiB 限制',
  'remote bot requires https or loopback http':
    '远程机器人连接需要使用 HTTPS 或本机回环 HTTP 地址',
  'file upload was not verified': '文件上传未通过验证',
  'file unavailable': '文件不可用',
  'file digest mismatch': '文件校验不一致',
};

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
  'Add a direct member Bearer Authorization header for Hub in settings.json, then retry.':
    '请先在 settings.json 的 Hub 配置 headers.Authorization 中填入成员直接访问令牌后再重试。',
  'bot sign-in expired': '机器人登录已过期',
  'Hub rejected the credential because it expired or was revoked.':
    'Hub 拒绝了当前凭据，可能已过期或被撤销。',
  'Sign in to Hub again in Settings -> Extensions, then retry.':
    '请在 设置 -> 扩展 中重新登录 Hub 后再重试。',
  'Cannot reach the Hub bot endpoint right now.':
    '暂时无法连接到 Hub 机器人接口。',
  'Circle will retry automatically with backoff, or retry now.':
    'Circle 将按退避间隔自动重试，也可以立即手动重试。',
  'Hub is not connected right now.': '当前未连接到 Hub。',
  'Check your Hub connection in Settings -> Extensions, or retry reconnecting.':
    '请在 设置 -> 扩展 中检查 Hub 连接状态，或点击重试重新连接。',
  'remote bot busy': '机器人请求繁忙',
  'The bot queue is full or rate-limited right now.':
    '机器人队列已满或触发限流，请稍候。',
  'Circle will retry shortly with backoff, or retry now.':
    'Circle 将在短时间退避后自动重试，也可以立即手动重试。',
  'bot attachment quota exceeded': '机器人附件配额已满',
  'Your member bot attachment storage has reached its limit.':
    '当前成员的机器人附件存储已达到上限。',
  'Wait for older attachments to expire, or send without attachments.':
    '请等待旧附件过期清理后再上传，或先发送不带附件的消息。',
  'remote bot resource not found': '未找到机器人目标资源',
  'Hub could not find the requested bot conversation or file.':
    'Hub 未找到请求的机器人对话或文件。',
  'Start a new bot conversation or retry.': '请新建机器人对话后重试。',
  'remote bot state conflict': '机器人请求状态冲突',
  'The request conflicts with an earlier bot conversation or request record.':
    '该请求与已有机器人对话或请求记录状态冲突。',
  'Reload the bot conversation and retry with a new request.':
    '请刷新机器人对话后重新发送请求。',
  'invalid remote bot request': '机器人请求无效',
  'Hub rejected the bot request because its parameters or size are invalid.':
    '请求参数或内容长度不符合要求，已被 Hub 拒绝。',
  'Check the message or attachment limits and retry.':
    '请检查消息内容或附件限制后再重试。',
  'attachment integrity check failed': '附件完整性校验失败',
  'Hub rejected the message because the attachment check failed.':
    '附件校验未通过，Hub 拒绝了该消息。',
  'Remove and attach the file again, then retry.':
    '请移除并重新附加该文件后再试。',
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
  'file size mismatch': '文件大小不一致',
  'remote bot unavailable': '远程机器人暂不可用',
  'remote bot connection changed': '机器人连接配置已变更，请重试',
  'invalid remote bot server': '无效的远程机器人服务器地址',
  'file identity changed': '文件在读取过程中发生变化',
  'invalid file receipt': '文件凭证无效',
  'invalid remote file': '远程文件参数无效',
  'file transfer failed': '文件传输失败',
  'fetch failed': '网络请求失败',
  'The operation was aborted due to timeout': '操作因超时已中止',
  'invalid remote bot connection': '无效的机器人连接参数',
  'invalid remote file operation': '无效的文件传输操作',
  'unknown remote bot operation': '未知的机器人操作',
  'runtime not enabled': '运行时未启用',
  'oauth client token rejected':
    'Hub 拒绝了 OAuth 登录令牌，请先在 settings.json 的 Hub 配置 headers.Authorization 中填入成员直接访问令牌后再重试',
  'remote bot request timed out': '机器人请求接收超时',
  'Uploaded {uploaded} of {total} files; failed on {name}: {reason}':
    '已上传 {uploaded}/{total} 个文件；{name} 上传失败：{reason}',
  'send text or files to chat with your personal bot. send /new for a new conversation, or /stop to cancel the active reply.':
    '可发送文字或文件与机器人对话。发送 /new 开始新对话，或发送 /stop 取消当前回复。',
  'started a new conversation': '已开始新对话',
  'requested stop for active reply': '已请求停止当前回复',
  'no active reply to stop': '当前没有正在进行的回复可停止',
  'bot model is disabled; queued message was not executed':
    '机器人模型已停用，排队消息未执行',
  'bot model was disabled; active reply stopped':
    '机器人模型已停用，已中止当前回复',
  'message cannot contain bot credentials': '消息中不能包含机器人凭据',
  'reply stopped': '已停止回复',
  'host restarted while queued; message not executed':
    '宿主服务在排队期间重启，消息未执行',
  'host restarted; previous request outcome unknown':
    '宿主服务已重启，上一请求结果未知',
  'bot model is not enabled': '机器人模型未启用',
  'model did not provide a valid question': '模型未提供有效的提问内容',
  'model reply contained credentials': '模型回复包含凭据，已拦截',
  'model returned an empty reply': '模型返回了空回复',
  'model endpoint rejected credentials': '模型端点拒绝了凭据',
  'model id is unavailable': '模型 ID 不可用',
  'endpoint or model not found': '未找到模型或端点',
  'model endpoint unreachable or timed out': '无法连接模型端点或请求超时',
  'model did not return a valid reply': '模型未返回有效回复',
  'invalid attachment digest': '附件摘要无效',
  'attachment could not be read': '无法读取附件',
  'model reply interrupted; outcome unknown': '模型回复已中断，结果未知',
};

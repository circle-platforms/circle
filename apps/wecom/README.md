# 企业微信私人聊天适配器

同一个企业机器人服务所有已绑定的成员。自建应用负责扫码身份，智能机器人使用官方长连接 SDK。成员在 Hub 设置页先用本人账号发起绑定。登录回调路径为 `/console/identity/callback`。

使用 Node 24，在此目录按锁文件运行 `npm ci`。以服务账户启动 `node adapter.ts <Hub 数据目录的 bot-runtime 子目录>`。匹配版本的 Circle 宿主运行 `circle remote-bot <同一子目录>`。目录权限为 0700。两个进程分别持有私有套接字；配置和模型密钥由 Hub 的密钥库管理。部署的服务管理器须保持两个进程常驻。

管理员在设置页分别保存模型、自建应用、私聊机器人。适配器访问 Hub 的地址使用部署的 HTTPS 来源，临时本地测试可用回环 HTTP。保存通道后处于停用状态，管理员启动后才持有该 Bot ID 的长连接。正式替换前须核对原连接持有者、已受理的任务和所有业务验收结果。

每个单聊输入按 Bot ID、成员与平台消息编号去重，并按同一发件人的批次元顺序（FIFO）投递至 Hub。文件和随后的说明在同一批输入中提交。入站媒体下载默认仅允许 `DEFAULT_WECOM_MEDIA_HOSTS`（`qyapi.weixin.qq.com`、`wwcdn.weixin.qq.com`、`wework.qpic.cn`、`wx.qlogo.cn`）且禁止重定向；该默认主机列表来源状态为**未知**（尚未在真实企业微信长连接回调帧中实测核验，可通过 `ChannelSession` 构造参数 `mediaHosts` 覆盖）。已下载的入站附件会在本地 `<bot-runtime>/staging/<sha256>`（`0700` 目录内 `0600` 文件）暂存，直到引用它的全部批次进入终态后再清理；若 Hub 重启丢失暂存返回 `400`，适配器会从本地暂存重传并重试一次。Hub 临时不可达（网络错误或 `401`/`408`/`429`/`5xx`）会保持 `pending` 并按指数退避（上限 60 秒）持续重试而不会隔离；被永久拒收（如 `400`/`403`/`409`/`413`/`422`）时记为 `failed`、记录日志并尽力向成员发送中文说明。

主动私聊发送先在宿主占用一条待送达消息，再向 SDK 请求发送。缺少确认时保留送达未知，重启后不会自动重发。在 Hub 核实绑定并检查账号仍然启用后才返回收件人和内容。对宿主发出的 `notice` 事件，适配器先校验 `verifyDeliveryIntent(item)`，再按提示码转换为简体中文提示。群帧在下载附件或查询成员前即被忽略。

验证范围说明：

- `npm test`（`adapter.test.ts`）使用合成企业身份、合成 WebSocket 帧与模拟 fetch，覆盖协议去重、通知本地化、重试与隔离、FIFO 顺序、凭证刷新与脱敏、媒体限流与解密后大小校验。
- `npm run test:paired`（自包含模拟 Hub 回环）验证官方 `@wecom/aibot-node-sdk` 的 `WSClient`、Circle `RemoteBot` 宿主与模拟 Hub 路由（含单聊消息、`帮助` 中文提示、加密入站附件与出站附件回传、已停用账号拒收）。
- `node test-paired.mjs <Hub 源码目录>` 在上述基础上连接真实 Hub 服务与 PostgreSQL，额外核验 Hub `member-notification-intent@1` / `member-notification-receipt@1` 持久化、成员读写隔离及 `channel-staging` 晋升与清理。以上检查均可重复执行，无需真实租户凭据。

发送适配器核对 Hub 登记的载荷 SHA-256 和长度。确认记录包含平台应答编号摘要和返回码。客户端显示平台确认或送达未知。成员实际阅读需要单独的现场证据。

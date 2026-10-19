export const githubConnection: Record<string, string> = {
  'loading…': '加载中…',
  'inspect the exact commit and files before publishing':
    '检查待发布的提交和文件',
  'local draft storage is unavailable; keep this panel open and copy your text before leaving':
    '本地草稿暂时无法保存；请保持面板打开，离开前复制文字。',
  'GitHub disconnected': 'GitHub 已断开连接',
  'GitHub authorization in progress': '正在进行 GitHub 授权',
  'Resources belong to {name}. Start a conversation in the selected project to make changes.':
    '这些资源属于 {name}。在所选项目中开始会话后即可修改。',
  'verifying GitHub account': '正在核验 GitHub 账户…',
  'GitHub authorization was cancelled before a code was ready. No new connection was established.':
    'GitHub 授权已在授权码生成前取消，尚未建立新连接。',
  'GitHub authorization was cancelled.': 'GitHub 授权已取消。',

  'preparing GitHub authorization code': '正在准备 GitHub 授权码…',
  'GitHub account': 'GitHub 账户',
  'GitHub authorization has expired.': 'GitHub 授权已失效。',
  'GitHub denied access to this repository.': 'GitHub 拒绝访问此仓库。',
  'GitHub could not be reached or the request failed.':
    '无法连接 GitHub 或请求失败。',
  'Reconnect this GitHub account here. Your edits are kept.':
    '请在此重新连接 GitHub 账户，已保留你的编辑内容。',
  'Review the account permissions and allowed repositories before retrying. Your edits are kept.':
    '请检查账户权限与允许仓库后再重试，已保留你的编辑内容。',
  'Check your network and retry the read when ready. Your edits are kept.':
    '请检查网络，准备好后再重试读取，已保留你的编辑内容。',

  'additional requested permissions': '额外申请的权限',
  'not reported': '尚未回报',
  'workflow allows creating or updating GitHub Actions workflow files.':
    'workflow 允许创建或更新 GitHub Actions 工作流文件。',
  'permissions reported by GitHub': 'GitHub 实际回报的权限',
  'GitHub has not reported granted permissions.':
    'GitHub 尚未回报已授予的权限。',
  'GitHub reported no permissions.': 'GitHub 没有回报任何权限。',

  'the draft changed; review it before trying the example again':
    '草稿已变化，请检查后再试用示例',
  'back to plugins': '返回插件',
  'plugin details': '插件详情',
  'manage GitHub plugin': '管理 GitHub 插件',
  'GitHub plugin': 'GitHub 插件',
  'the original conversation changed; return to it before trying the plugin':
    '原会话已变化，请返回该会话后再试用插件',
  'the example could not be saved; retry to keep it in the same draft':
    '无法保存示例，请重试以保留在同一草稿中',
  'example added to your unsent draft; send it when ready':
    '示例已加入未发送草稿，准备好后再发送',
  'Check the GitHub connection and list the repositories Circle may access. Do not change any repository.':
    '检查 GitHub 连接状态，并列出 Circle 允许访问的仓库。不要修改任何仓库。',
  'check the connection and Circle repository access':
    '查看连接状态及 Circle 仓库访问范围',
  'read pull request checks': '读取拉取请求检查结果',
  'read failed CI logs': '读取失败的 CI 日志',
  'retry failed CI jobs after approval': '经审批后重试失败的 CI 任务',
  'publish a reviewed draft PR after approval': '经审批后发布已审阅的草稿 PR',
  'Use GitHub connection status, draft pull requests and CI results in your Circle conversation.':
    '在 Circle 对话中使用 GitHub 连接状态、草稿 PR 和 CI 结果。',
  'Repository tools appear after connecting an account and allowing specific repositories. Writes require approval; merging remains your decision.':
    '连接账户并允许具体仓库后，仓库工具才会出现。写入操作需要审批，是否合并仍由你决定。',
  'Try now prepares a read-only connection example. Nothing is sent automatically.':
    '立即试用会准备一个只读连接检查示例，不会自动发送。',
  'GitHub connection, reviewed pull requests and CI in your conversation.':
    '在对话中管理 GitHub 连接、已审阅的拉取请求和 CI。',

  'GitHub connection error': 'GitHub 连接出错',
  'loading GitHub integration': '正在加载 GitHub 集成…',
  'GitHub integration could not be loaded.': '无法加载 GitHub 集成。',
  'Secure credential storage is unavailable.': '安全凭据存储暂不可用。',
  'GitHub action could not be completed.': '未能完成 GitHub 操作。',
  'To continue without saving your sign-in, choose sign out when Circle closes, then start again.':
    '如果不想保存登录，请选择“Circle 关闭时退出登录”，然后重新开始。',
  'Review the connection and try the action again. Your edits are kept.':
    '请检查连接后重试，已保留你的编辑内容。',

  'No repositories selected; repository actions are unavailable.':
    '尚未选择仓库，暂不能执行仓库操作。',
  'GitHub connection': 'GitHub 连接',
  'GitHub connection is unavailable; enable the bundled GitHub extension in Circle desktop.':
    'GitHub 连接不可用；请在 Circle 桌面版启用内置 GitHub 扩展。',
  'connected as {account}': '已连接：{account}',
  'waiting for GitHub authorization': '等待 GitHub 授权',
  'GitHub connection lasts only for this Circle session.':
    'GitHub 连接仅在本次 Circle 会话中有效。',
  'sign-in': '登录方式',
  'stay signed in on this computer': '在这台电脑上保持登录',
  'sign out when Circle closes': 'Circle 关闭时退出登录',
  'Disconnected from Circle. GitHub authorization revocation is not confirmed.':
    '已从 Circle 断开连接。尚未确认 GitHub 授权已撤销。',
  'manage GitHub connection in settings': '在设置中管理 GitHub 连接',
  'turned off': '已关闭',
  'not available': '不可用',
  'needs attention': '需要处理',
  'connecting…': '正在连接…',
  'Turn on GitHub to connect your account.': '开启 GitHub 后即可连接你的账户。',
  'Circle uses this account only for the repositories you allow.':
    'Circle 只会在你允许的仓库中使用此账户。',
  'Connect your GitHub account to read pull request checks and CI, and to publish reviewed changes after your approval.':
    '连接 GitHub 账户后，可读取拉取请求检查和 CI 结果，并在你批准后发布已审阅的修改。',
  'open GitHub': '打开 GitHub',
  'copy code': '复制代码',
  'try in a conversation': '在对话中试用',
  disconnect: '断开连接',
  'connect GitHub': '连接 GitHub',
  repositories: '仓库',
  'Circle works only with the repositories listed here. This does not change what your GitHub account allows.':
    'Circle 只会使用这里列出的仓库。这不会改变你的 GitHub 账户权限。',
  'add repository': '添加仓库',
  add: '添加',
  'Write it as owner/repository, for example octo-org/app.':
    '请写成 owner/repository 格式，例如 octo-org/app。',
  reset: '重置',
  'Your sign-in is kept in secure storage.': '登录信息保存在安全存储中。',
  'You sign in again the next time.': '下次使用时需要重新登录。',
  permissions: '权限',
  'what Circle can do': 'Circle 可以做的事',
  'permission details': '权限详情',
};

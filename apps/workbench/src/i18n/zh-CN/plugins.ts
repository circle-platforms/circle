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
  'developer extension': '开发者工具',
  'Node debugging and TypeScript and JavaScript language features.':
    'Node 调试，以及 TypeScript 和 JavaScript 的语言功能。',
  hub: '枢纽',
  knowledge: '知识',
  work: '工作',
  execution: '执行',
  methods: '方法',
  server: '服务器',
  user: '用户',
  project: '项目',
  scope: '范围',
  state: '状态',
  following: '正在跟随',
  'nothing followed': '没有',
  'no task is being followed': '暂无跟踪的任务',
  'refresh status': '刷新状态',
  refresh: '刷新',
  'Work handed to a hub from here. The server keeps each task; closing Circle does not stop it.':
    '从这里交给枢纽的工作。服务器保存每个任务；关闭 Circle 不会停止它。',
  'not signed in yet': '尚未登录',
  'username or password is wrong': '用户名或密码不对',
  'change set': '变更集',
  governance: '治理',
  'waiting for review': '待审核',
  'not signed in': '未登录',
  'Sign in on the hub page; the server decides what you may see.':
    '在枢纽页面登录；服务器决定你能看到什么。',
  'enter the server, user and password': '请填写服务器、用户和密码',
  'sign-in needs the Circle runtime': '登录需要 Circle 运行时',
  'sign-in failed': '登录失败',
  'sign out': '退出',
  inbox: '收件箱',
  'open inbox': '打开收件箱',
  'copy id': '复制 ID',
  'reject…': '拒绝…',
  'Someone else still has to approve this.': '这项改动还需要别人批准。',
  show: '查看',
  'rejection reason': '拒绝理由',
  'a rejection needs a reason': '拒绝需要理由',
  'nothing is waiting for you': '没有等你处理的',
  'search knowledge': '搜索知识',
  'enter text to search knowledge': '请填写要搜索的知识',
  'snapshot {id}': '快照 {id}',
  'no knowledge matched': '没有匹配的知识',
  'events seen to {seq}': '事件已看到 {seq}',
  'results saved': '结果已保存',
  'follow {id}': '跟随 {id}',
  follow: '跟随',
  'save results of {id}': '保存 {id} 的结果',
  'save results': '保存结果',
  'nothing read yet': '还没有读取',
  'refresh reads it from {url}.': '刷新会从 {url} 读取。',
  'read from {url} as {user} at {time}':
    '从 {url} 以 {user} 的身份读取于 {time}',
  'tasks as the server holds them: their phase, what they wait on, and approvals bound to an input revision.':
    '服务器保存的任务：阶段、正在等待的内容，以及绑定到输入修订的审批。',
  "operations the server's workers ran for these tasks, with the worker and fencing token that held the lease.":
    '服务器的工作进程为这些任务运行的操作，以及持有租约的工作进程和栅栏令牌。',
  "each task's source, artifacts and evidence, by revision and SHA-256, and the server's own check.":
    '每个任务的来源、产物和证据，按修订和 SHA-256，以及服务器自己的核对。',
  "the server's capability packs, at the versions it runs. Hand one a file of this workspace.":
    '服务器运行的能力包及其版本。把这个工作区的一个文件交给其中一个。',
  'Hand work to a hub and follow it: the interface half of the bundled hub extension.':
    '把工作交给枢纽并跟随它：内置枢纽扩展的界面部分。',
  'answer {id}': '回答 {id}',
  answer: '回答',
  'approval {id}': '审批 {id}',
  'approve {id}': '批准 {id}',
  approve: '批准',
  'reject {id}': '拒绝 {id}',
  reject: '拒绝',
  'no work': '没有工作',
  'Nothing you may read on this server yet.':
    '这台服务器上还没有你可以阅读的内容。',
  'reconcile {id}': '核对 {id}',
  reconcile: '核对',
  'no operations': '没有操作',
  'No worker has run anything for these tasks.':
    '还没有工作进程为这些任务运行过什么。',
  'no knowledge': '没有知识',
  'No task you may read has sources or results yet.':
    '你能阅读的任务还没有来源或结果。',
  'file in the workspace': '工作区中的文件',
  'hand over': '交出',
  'no capability packs': '没有能力包',
  'The server lists none you may use.': '服务器没有列出你可以使用的能力包。',
  'Not listed: {reads} server tool reads and {indexing} knowledge indexing jobs, {open} still indexing.':
    '未列出：{reads} 次服务器工具读取和 {indexing} 个知识索引任务，其中 {open} 个仍在索引。',
  'Not listed: {reads} server tool reads and {indexing} knowledge indexing jobs.':
    '未列出：{reads} 次服务器工具读取和 {indexing} 个知识索引任务。',
  '{count} server tools the model can use: {list}':
    '模型可以使用 {count} 个服务器工具：{list}',
  ' (asks first)': ' （先询问）',
  'This server offers the model no tools.': '这台服务器没有向模型提供工具。',
  'skill pack {name}': '技能包 {name}',
  'server records this as {status}': '服务器记为 {status}',
  'waiting for {command}': '等待 {command}',
  'bot {name}': '机器人 {name}',
  runs: '运行记录',
  start: '启动',
  stop: '停止',
  unmapped: '未映射',
};

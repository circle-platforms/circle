// Simplified Chinese for the interface words in the dialogs files. English is the key.
export const dialogs: Record<string, string> = {
  // the connection form
  provider: '提供商',
  'Use a Bedrock API key and choose your region in the base URL.':
    '请使用 Bedrock API 密钥，并在 API 地址中选择你的地域。',
  'custom endpoint': '自定义端点',
  'Choose from provider presets next, or type a model id. The key and model are not checked.':
    '下一步可选择提供商预设，或填写模型 ID。密钥和模型未经验证。',
  'Next asks this endpoint for its online model list. You can also type a model id.':
    '下一步会获取端点的线上模型列表，也可手填模型 ID。',
  'Enter your resource base URL and deployment name. Public model names are not deployment names.':
    '请填写资源的 API 地址和部署名。公开模型名不等于部署名。',
  'provider presets ({date}); unverified': '提供商预设（{date}）；未经验证',
  'These ids ship with Circle. Availability depends on your provider and account; you can enter another id.':
    '这些 ID 随 Circle 发布。能否使用取决于提供商和账号；也可填写其他 ID。',
  preset: '预设',
  'Enter the deployment name from your provider console.':
    '请填写提供商控制台中的部署名。',
  'API URL, key and model': 'API 地址、密钥和模型',
  'Circle answers with your own model endpoint. Enter its API URL, key and model to start.':
    'Circle 使用你自己的模型端点来回答。填写它的 API 地址、密钥和模型即可开始。',
  'base url': 'API 地址',
  protocol: '协议',
  'api key': 'API 密钥',
  'leave empty to keep the saved key': '留空则保留已保存的密钥',
  required: '必填',
  model: '模型',
  'connection model': '连接使用的模型',
  'the model id your endpoint uses': '端点使用的模型 ID',
  'The key is saved privately by Circle. It is excluded from conversations and frontend storage.':
    '密钥由 Circle 私密保存，不会出现在对话或前端存储中。',
  connect: '连接',
  'connection saved': '连接已保存',
  // the connection form's two steps: the URL and key, then the model
  next: '下一步',
  back: '返回',
  'looking for models…': '正在查找模型…',
  'discovered {n} model ({protocol})': '发现 {n} 个模型（{protocol}）',
  'discovered {n} models ({protocol})': '发现 {n} 个模型（{protocol}）',
  'the endpoint listed no models': '端点没有列出模型',
  'model discovery failed': '模型发现失败',
  'model discovery failed ({detail})': '模型发现失败（{detail}）',
  'not listed': '未列出',
  'no model has that name': '没有这个名字的模型',
  'kind of API': 'API 类型',
  'openai-style': 'OpenAI 风格',
  'anthropic-style': 'Anthropic 风格',
  'The endpoint did not list its models, so the id is not checked: type the one your provider documents.':
    '端点没有列出它的模型，所以不会检查这个 ID：请填写服务商文档中的 ID。',
  'choose a model or type its id': '请选择一个模型，或输入它的 ID',
  'use an http or https endpoint without credentials in the URL':
    '请使用 http 或 https 端点，且 URL 中不要包含凭据',
  'Circle data folder': 'Circle 数据文件夹',
  running: '运行中',
  stopped: '已停止',
  // dialog titles
  'rename session': '重命名会话',
  'delete session': '删除会话',
  'session tree': '会话树',
  'fork session': '分叉会话',
  'export session': '导出会话',
  'draft editor': '草稿编辑器',
  connection: '连接',
  'workspace trust': '工作区信任',
  'keyboard shortcuts': '快捷键',
  'compact context': '压缩上下文',
  'close session': '关闭会话',
  'secret input': '输入密钥',
  'stop background job': '停止后台任务',
  // shared buttons
  cancel: '取消',
  save: '保存',
  // rename and delete
  'session name': '会话名称',
  'Delete “{title}” from this browser preview?':
    '要从这个浏览器预览中删除“{title}”吗？',
  'keep session': '保留会话',
  'delete local session': '删除本地会话',
  'stop work and delete session': '停止任务并删除会话',
  'Stop all work in “{title}”, then delete its saved conversation?':
    '停止“{title}”中的所有任务，然后删除已保存的对话？',
  // the session tree and fork
  'search session tree': '搜索会话树',
  'user messages only': '仅用户消息',
  'Create a new session from before a user message.':
    '从一条用户消息之前创建新会话。',
  'Choose what the next message continues from.': '选择下一条消息从哪里继续。',
  'File changes are not reverted.': '文件改动不会撤销。',
  label: '标签',
  'node label': '节点标签',
  'save label': '保存标签',
  'message label saved': '消息标签已保存',
  'create fork': '创建分叉',
  'continue from here': '从这里继续',
  // session details
  session: '会话',
  title: '标题',
  workspace: '工作区',
  effort: '思考深度',
  messages: '消息',
  'visible branch': '可见分支',
  'tool calls': '工具调用',
  'active node': '当前节点',
  storage: '存储',
  runtime: '运行时',
  none: '无',
  'raw session and pending input': '原始会话和待处理输入',
  'session snapshot': '会话快照',
  // the draft editor
  'expanded message draft': '展开的消息草稿',
  'use draft': '使用草稿',
  // export
  'Export the saved Circle conversation. JSONL includes its native checkpoint graph and receipts.':
    '导出已保存的 Circle 对话。JSONL 包含原生的检查点图和回执。',
  'export {kind}': '导出 {kind}',
  'session exported': '会话已导出',
  'export cancelled': '已取消导出',
  // workspace trust
  "Circle can load this workspace's instructions, skills, commands, settings and extensions after you trust it. Extensions run code in the runtime.":
    '信任这个工作区后，Circle 才能加载它的指令、技能、命令、设置和扩展。扩展会在运行时中执行代码。',
  'This choice is kept locally. The connected Circle runtime must enforce workspace trust before loading project code.':
    '这个选择保存在本地。已连接的 Circle 运行时必须先确认工作区已信任，才能加载项目代码。',
  'trust workspace': '信任工作区',
  'workspace trusted': '工作区已信任',
  // compact
  'A connected Circle runtime summarizes older context. The full record is kept.':
    '已连接的 Circle 运行时会总结较早的上下文。完整记录会保留。',
  focus: '重点',
  'compaction focus': '压缩重点',
  'what should the summary preserve?': '摘要应该保留什么？',
  'request compaction': '请求压缩',
  'compaction requested; raw history is unchanged':
    '已请求压缩；原始历史保持不变',
  // keyboard shortcuts
  "Circle's terminal bindings are listed below. Browser-reserved keys and process suspension need a desktop host; the same features have clickable controls here.":
    '下面列出 Circle 在终端里的按键绑定。浏览器保留的按键和挂起进程需要桌面宿主；同样的功能在这里都有可点击的控件。',
  // close session
  'Closing a real Circle process stops its owned background jobs. This preview can only record the request.':
    '关闭真实的 Circle 进程会停止它的后台任务。这个预览只能记录该请求。',
  'keep working': '继续工作',
  'quit application': '退出应用',
  // stop a background job
  'The runtime must confirm that the process and its children stopped. A request alone does not establish that.':
    '运行时必须确认进程及其子进程已经停止。仅发出请求并不能说明已停止。',
  'keep running': '保持运行',
  'request stop': '请求停止',
  'stop requested; execution state is unverified':
    '已请求停止；执行状态尚未确认',
  // secret input
  request: '请求',
  destination: '目标',
  'no pending secret': '没有待处理的密钥请求',
  secret: '密钥',
  'secret value': '密钥值',
  'The value goes directly to the pending secret request. It is excluded from the conversation.':
    '这个值会直接交给待处理的密钥请求。它不会出现在对话中。',
  'submit secret': '提交密钥',
  'enter a value or cancel': '请输入一个值，或者取消',
  'secret sent privately': '密钥已私密发送',
  // a request opened from the activity panel
  'revision {revision}': '修订 {revision}',
  'Circle request': 'Circle 请求',
  before: '修改前',
  after: '修改后',
  'local response': '本地答复',
  'Cancel this answer? Press escape again or choose cancel.':
    '要取消这个回答吗？再按一次 escape，或选择“取消”。',
  'save response': '保存答复',
  'Leave read-only mode and implement the plan?':
    '要退出只读模式并实施计划吗？',
  'stay read-only': '保持只读',
  'request implementation': '请求实施',
  'response sent to Circle': '答复已发送给 Circle',
  'Delete “{title}” and its saved conversation?':
    '删除“{title}”及其保存的对话？',
  'Quitting stops Circle and the background jobs it started.':
    '退出会停止 Circle 及其启动的后台任务。',
  'send; while Circle works, it reads it after its current step':
    '发送；Circle 工作时，它在当前这一步之后读到',
  'new line': '换行',
  'queue a follow-up for after the turn': '排一条追加消息，在本轮结束后发送',
  'next approval mode': '切换到下一个审批模式',
  'stop the turn, or clear the box': '停止本轮，或清空输入框',
  'session tree, with an empty box': '输入框为空时打开会话树',
  'earlier messages, at the start of the box': '在输入框开头时翻看之前的消息',
  'take back queued messages': '取回排队中的消息',
  'this list, with an empty box': '输入框为空时显示这个列表',
  'next model': '下一个模型',
  'show or hide thinking': '显示或隐藏思考',
  'write the message in a larger editor': '在更大的编辑器里写消息',
  'enter a secret': '输入密钥',
  'copy the last answer, when nothing is selected':
    '没有选中内容时，复制上一条回答',
  tool: '工具',
  notice: '提示',
};

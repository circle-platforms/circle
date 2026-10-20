// Simplified Chinese for the terminal. English is the key, and the words match
// the desktop (apps/workbench/src/i18n): one English word, one Chinese word.
// Commands, ids, paths, model names and tool names stay as written.

export const TUI_ZH: Record<string, string> = {
  // session list and resume
  'view only': '仅查看',
  'view only, the draft stays': '仅查看，草稿会保留',
  'view only, the mode stays': '仅查看，不能切换模式',
  current: '当前',
  'type to search': '输入以搜索',
  'Sessions · this folder': '会话 · 此文件夹',
  'Sessions · every folder': '会话 · 所有文件夹',
  'enter opens · tab this folder · ctrl+r renames · ctrl+k deletes':
    '回车打开 · tab 此文件夹 · ctrl+r 重命名 · ctrl+k 删除',
  'enter opens · tab every folder · ctrl+r renames · ctrl+k deletes':
    '回车打开 · tab 所有文件夹 · ctrl+r 重命名 · ctrl+k 删除',
  'No sessions saved': '没有已保存的会话',
  'No sessions in this folder': '此文件夹没有会话',
  'No matches': '没有匹配',
  'this session is writable again': '另一端已关闭，可以继续对话了',
  'this session is open in another terminal. Close it there to continue, or copy it with circle --fork {id}':
    '此会话已在另一终端打开。请在那边关闭后再继续，或用 circle --fork {id} 复制一份',
  'search quota exceeded': '搜索额度不足',
  'Native search unavailable: search quota exceeded':
    '原生搜索不可用：搜索额度不足',
  'Provider: DuckDuckGo': '提供方：DuckDuckGo',
  'the database is busy · another Circle is using this data folder. Wait a moment and start again':
    '数据库正忙 · 另一个 Circle 正在使用此数据文件夹。请稍候再启动',
  'waiting for the database…': '正在等待数据库…',
  hook: '钩子',
  hooks: '钩子',
  project: '项目',
  user: '用户',
  skill: '技能',

  // approval card
  'Allow once': '允许本次',
  'Reject and explain': '拒绝并说明',
  'this exact command': '这条确切的命令',
  'this call': '这次调用',
  'file changes inside the workspace': '工作区内的文件改动',
  'changes files in the workspace': '修改工作区内的文件',
  'changes files outside the workspace': '修改工作区外的文件',
  'runs a shell command': '运行 shell 命令',
  'deletes files': '删除文件',
  'only reads': '只读取',
  'destructive operation': '破坏性操作',
  'This deletes or overwrites data.': '这会删除或覆盖数据。',
  'empty enter rejects · esc returns': '空回车即拒绝 · esc 返回',
  'shows the model the whole screen': '向模型展示整个屏幕',
  'every screenshot': '每一次截屏',

  // turn status
  Thinking: '思考',
  Considering: '思考',
  Analyzing: '思考',
  Brewing: '思考',
  Pondering: '思考',
  Cogitating: '思考',
  Reflecting: '思考',
  Processing: '思考',
  Evaluating: '思考',
  Examining: '思考',
  Retrying: '重试',
  'waiting for you': '等待你处理',
  running: '运行中',
  '∴ Thought': '∴ 思考了',
  '∴ Thinking': '∴ 思考中',
  timeout: '超时',
  'network error': '网络错误',
  'server error': '服务器错误',
  'rate limited': '被限流',
  'endpoint error': '端点错误',
  error: '错误',
  '(no output)': '（无输出）',

  // modes
  manual: '手动',
  'accept edits': '自动接受编辑',
  'read-only': '只读',
  auto: '自动',
  plan: '计划',
  'Manual · asking before each change and command':
    '手动 · 每次修改和执行命令前都询问',
  'Accept edits · workspace file edits run without asking, commands and deletes still ask':
    '自动接受编辑 · 直接编辑工作区内的文件；命令和删除仍会询问',
  'Read-only on · writes and shell are blocked, /plan.md is allowed':
    '只读：不能改文件，也不能跑命令。可以写 /plan.md。',
  'Read-only off': '已关闭只读',
  'Auto on · nothing asks: commands that delete, certificate warnings and uploads go ahead · use it where that is safe':
    '自动 · 不再询问：删除命令、证书警告和文件上传都会直接执行 · 只在安全的地方使用',
  'Auto off · asking for each call again': '已关闭自动 · 每次调用再询问',

  // welcome
  '? for shortcuts': '? 查看快捷键',
  recent: '最近',
  now: '刚刚',
  'not connected yet': '尚未连接',
  instructions: '说明',
  skills: '技能',
  commands: '命令',
  extensions: '扩展',
  settings: '设置',
  on: '开',
  off: '关',
  'network: proxy {state}; trust {count} authorities ({sources}){bundle}{problems}':
    '网络：代理 {state}；信任 {count} 个证书机构（{sources}）{bundle}{problems}',
  default: '默认',
  '; bundle {path}': '；证书包 {path}',

  // trust
  trust: '项目信任',
  'trust this folder': '信任项目',
  quit: '退出',
  'This folder can supply instructions, skills, commands, extensions and hooks. Extensions and hooks execute code.':
    '此文件夹可以提供说明、技能、命令、扩展和钩子。扩展和钩子会执行代码。',
  'Trust this folder?': '信任这个项目？',
  "Circle reads, edits and runs commands here, asking first for anything that\nchanges files. Trusting also loads the folder's own commands, skills,\nextensions and hooks. Hooks are shell commands.":
    'Circle 会在这里读取、编辑和运行命令，改文件之前都会先问。信任之后还会加载这个项目自己的命令、技能、扩展和钩子。钩子是 shell 命令。',
  'trust it? [y/N]: ': '信任它？ [y/N]：',
  'Not trusted.': '未信任。',
  'This folder is not trusted yet: {folder}\nRun `circle` there once in a terminal and trust it, or pass --trust to trust it and remember it.':
    '此文件夹尚未信任：{folder}\n请在终端里对它运行一次 `circle` 并信任，或加上 --trust 记住这次信任。',

  // errors
  'missing API key': '缺少 API 密钥',
  'missing API key; re-run circle --init':
    '缺少 API 密钥；请重新运行 circle --init',
  'To resume this session: {command}': '继续这个会话：{command}',
  'cache N/A': '缓存不可用',
  'cache {rate}': '缓存 {rate}',
  'ctx {used}/N/A': '上下文 {used}/不可用',
  'ctx {used}/{window} ({percent}%)': '上下文 {used}/{window}（{percent}%）',
  'circle: nothing arrived on stdin within {seconds}s; going on without it (use </dev/null to skip the wait)\n':
    'circle：标准输入在 {seconds} 秒内没有内容，将不使用它继续（用 </dev/null 可跳过等待）\n',

  // /help and /hotkeys headers
  'Available commands:': '可用命令：',
  'Custom commands:': '自定义命令：',
  'Type text without / to chat. Skills also: /skill:name':
    '不加 / 的文字会发给模型。技能也可以：/skill:名称',
  'Keyboard shortcuts:': '快捷键：',

  // slash command descriptions (the desktop's words where the English matches)
  'List slash commands': '列出斜杠命令',
  'Show keyboard shortcuts': '显示快捷键',
  'Sign in or change the endpoint, key and model':
    '登录，或更换端点、密钥和模型',
  'Clear saved credentials': '清除保存的凭据',
  'Analyze repo and write AGENTS.md': '分析仓库并写出 AGENTS.md',
  'Trust this workspace': '信任这个工作区',
  'Show current settings': '显示当前设置',
  'Named values Circle fills in: /variables [NAME=value]':
    'Circle 会填入的具名值：/variables [NAME=value]',
  'Values the model uses as %NAME%: /variables [NAME=value]':
    '模型写成 %NAME% 来使用的值：/variables [NAME=value]',
  'Named values Circle fills in unseen: /secrets [NAME]':
    '具名的值，Circle 在工具运行时填入，你看不到：/secrets [NAME]',
  'Values the model uses as %NAME% unseen: /secrets [NAME]':
    '模型在工具参数里写成 %NAME%，Circle 在运行时填入，你看不到：/secrets [NAME]',
  'Show or set the theme: /themes [auto|dark|light]':
    '显示或设置主题：/themes [auto|dark|light]',
  'List / reload MCP servers and tools': '列出或重新加载 MCP 服务器和工具',
  'List extensions: /extensions [reload | enable <name> | disable <name>]':
    '列出扩展：/extensions [reload | enable <名称> | disable <名称>]',
  'List hooks: name, source, event, command and trust':
    '列出钩子：名称、来源、事件、命令和信任状态',
  'Session approvals: /approvals [add P|remove P|revoke N]':
    '会话审批规则：/approvals [add P|remove P|revoke N]',
  'Background jobs: open one, or stop it': '后台任务：打开或停止',
  'Device terminals: open a console, connect a profile, cut one':
    '设备终端：打开控制台、连接配置、断开一个',
  'Start a new session': '开始新会话',
  'Choose a session to open: /resume [n|id]':
    '选择要打开的会话：/resume [n|id]',
  'Resume the previous session': '回到上一个会话',
  'Set session display name: /name <title>': '设置会话名称：/name <标题>',
  'Show the session: id, title, messages, tokens':
    '显示会话：ID、标题、消息、token',
  'Choose a model: /models [name]': '选择模型：/models [名称]',
  'Summarize context to free the window': '总结上下文，腾出窗口空间',
  'Toggle read-only (plan) mode: /plan [on|off]':
    '切换只读（计划）模式：/plan [on|off]',
  'List or load a skill: /skill [name] [args] or /skill:name [args]':
    '列出或载入技能：/skill [名称] [参数] 或 /skill:名称 [参数]',
  'Go back to an earlier point of the session: /tree [words]':
    '回到会话中更早的位置：/tree [关键词]',
  'New session from before one of your messages: /fork [words]':
    '从你的某条消息之前分出新会话：/fork [关键词]',
  'Clone the active branch into a new session': '把当前分支克隆为新会话',
  'Undo the last turn on screen': '在界面上撤销上一轮',
  'Restore after /undo': '恢复 /undo 撤销的内容',
  'Hide or show thinking; /thinking <level> sets the depth':
    '隐藏或显示思考；/thinking <级别> 设置思考深度',
  'Choose the thinking depth: /effort [minimal|low|medium|high|xhigh|max]':
    '选择思考深度：/effort [minimal|low|medium|high|xhigh|max]',
  'Toggle tool-detail verbosity in footer': '展开或收起工具详情',
  'Copy last assistant message to clipboard': '把上一条回答复制到剪贴板',
  'Write the conversation to a file: /export [html|jsonl|path]':
    '把对话写入文件：/export [html|jsonl|路径]',
  'Start a session from an export: /import <file.jsonl|file.md>':
    '从导出文件开始会话：/import <文件.jsonl|文件.md>',
  'Write a shareable Markdown copy under ~/.circle/shares/':
    '在 ~/.circle/shares/ 下写一份可分享的 Markdown 副本',
  'Delete the active local share file': '删除当前的本地分享文件',
  'Compose next message in $EDITOR / $VISUAL':
    '用 $EDITOR / $VISUAL 编写下一条消息',
  'Reload settings.json and rebuild the model':
    '重新加载 settings.json 并重建模型',
  'Toggle auto mode: approve every tool call without asking':
    '切换自动模式：所有工具调用都不再询问',
  'Next session mode (shift+tab), or /mode manual|accept-edits|plan|auto':
    '下一个会话模式（shift+tab），或 /mode manual|accept-edits|plan|auto',
  'Quit Circle': '退出 Circle',

  // /skill and /extensions
  'Skills:': '技能：',
  'Load with /skill <name>': '用 /skill <名称> 载入',
  'No skills found. Install with `npx skills add … -a amp` (writes .agents/skills), or add SKILL.md under ~/.circle/skills / .agent/skills.':
    '没有找到技能。可用 `npx skills add … -a amp` 安装（写入 .agents/skills），或在 ~/.circle/skills / .agent/skills 下添加 SKILL.md。',
  'Loaded skill `{name}`': '已载入技能 `{name}`',
  " args='{args}'": " 参数='{args}'",
  'Commit the work, push the branch and open or update a draft pull request with the GitHub CLI. Use when asked to create, open or update a pull request.':
    '提交改动、推送分支，并用 GitHub CLI 打开或更新一份草稿拉取请求。当别人让你创建、打开或更新拉取请求时使用。',
  'Built-in': '内置',
  Agents: 'Agents',
  Claude: 'Claude',
  OpenCode: 'OpenCode',
  Pi: 'Pi',
  Circle: 'Circle',
  'Project Agents': '项目 Agents',
  'Project OpenCode': '项目 OpenCode',
  'Project Pi': '项目 Pi',
  'Project Claude': '项目 Claude',
  'Project Circle': '项目 Circle',
  Project: '项目',
  'No extension named {name}': '没有名为 {name} 的扩展',
  'No extensions. Put an extension.ts or extension.js in each extension folder.':
    '没有扩展。请在每个扩展文件夹里放 extension.ts 或 extension.js。',
  'off · /extensions enable {name}': '关 · /extensions enable {name}',
  'failed to load: {error}': '加载失败：{error}',
  '{n} tool': '{n} 个工具',
  '{n} tools': '{n} 个工具',
  '{n} command': '{n} 个命令',
  '{n} commands': '{n} 个命令',
  'Usage: /extensions {verb} <name>': '用法：/extensions {verb} <名称>',
  '{name} enabled': '已启用 {name}',
  '{name} disabled': '已停用 {name}',
  'Extensions reloaded · {n} tools': '扩展已重新加载 · {n} 个工具',
  'Extension reload failed: {error}': '重新加载扩展失败：{error}',

  // /hooks
  'Hooks:': '钩子：',
  'No hooks configured.': '没有配置钩子。',
  'Skill hooks waiting for load:': '等待载入的技能钩子：',
  'waiting for /skill {name}': '等待 /skill {name}',
  trusted: '已信任',
  'not trusted': '未信任',
  active: '运行中',
  'project hooks need trust': '项目钩子需要先信任文件夹',
  'project hooks changed': '项目钩子已更改，尚未加载',
  'needs approval': '需要重新批准',
  'approve these hooks': '批准这些钩子',
  skip: '跳过',
  "This project's hooks file changed.": '这个项目的钩子文件变了。',
  'These hooks run shell commands and stay off until you approve them.':
    '这些钩子会执行 shell 命令，批准之前不会运行。',
  bundled: '内置',

  // circle --help
  'usage: circle [options] [folder] [@file ...] [message ...]':
    '用法：circle [选项] [文件夹] [@文件 ...] [消息 ...]',
  'A terminal coding agent for your own model endpoint.':
    '面向你自己的模型端点的终端编程代理。',
  'Print the answer and exit': '打印回答并退出',
  'Output mode': '输出模式',
  'Continue the last session': '继续上一个会话',
  'Choose a saved session': '选择一个已保存的会话',
  'Resume by ID': '按 ID 恢复',
  'Open or create this ID': '打开或创建这个 ID',
  'Copy a saved session': '复制一个已保存的会话',
  'In-memory conversation': '只在内存里对话',
  'Model for this run': '这一次使用的模型',
  'Thinking depth': '思考深度',
  'List endpoint models': '列出端点上的模型',
  'Export a saved session': '导出一个已保存的会话',
  'Replace the system prompt': '替换系统提示',
  'Append to the system prompt': '追加到系统提示后面',
  'Skip instruction files': '跳过说明文件',
  'Limit tools': '只使用这些工具',
  'Exclude tools': '排除这些工具',
  'No tools except compaction': '不使用工具，压缩除外',
  'Auto mode for print or line': '在打印模式和逐行模式里使用自动模式',
  'Trust this folder and remember it': '信任这个文件夹并记住',
  'Load extensions and MCP servers in print, line or rpc mode':
    '在打印、逐行或 rpc 模式里加载扩展和 MCP 服务器',
  'Plain line mode': '普通逐行模式',
  'Model setup': '设置模型和接口',
  "Work in a folder of Circle's own for this task, under the task folder":
    '在任务文件夹下，用 Circle 自己的文件夹做这件事',
  'Print the data directory': '打印数据目录',
  'Print version': '打印版本',
  'Show help': '显示帮助',

  // circle update and the installer
  'usage: circle update [version] [--check]':
    '用法：circle update [版本] [--check]',
  'Download a Circle release and install it over this installation.':
    '下载一份 Circle 发布并装到当前安装上。',
  '  circle update           the latest release':
    '  circle update           最新发布',
  '  circle update 1.2.3     that version':
    '  circle update 1.2.3     指定版本',
  '  circle update --check   print the installed and available versions':
    '  circle update --check   打印已安装和可用的版本',
  'circle {version} is up to date': 'circle {version} 已是最新',
  'Installed {installed}; available {target}':
    '已安装 {installed}；可用 {target}',
  'updating circle {from} to {to}': '正在把 circle {from} 更新到 {to}',
  "What's new:": '更新内容：',
  'Older versions kept so a session can finish use {size} MB under {dir}.':
    '为了让还在跑的会话能结束，保留的旧版本占用 {size} MB，位于 {dir}。',
  'Remove one when nothing is running from it: {command}':
    '确认没有会话还在用它时再删除：{command}',
  'release lookup failed: HTTP {status}': '查找发布失败：HTTP {status}',
  'release lookup failed: {message}': '查找发布失败：{message}',
  'GitHub may be rate limiting this machine, or the network blocked the request. Wait a moment and run circle update again.':
    '多半是 GitHub 对这台机器限流，或网络挡住了请求。等一会儿再运行 circle update。',
  'checking the release': '正在检查发布',
  'copying circle {version} to {path}': '正在把 circle {version} 复制到 {path}',
  'removed circle {version}': '已移除 circle {version}',
  'installed circle {version} in {prefix}':
    '已把 circle {version} 安装到 {prefix}',
  'start it in a project folder: cd /path/to/project && circle':
    '到项目文件夹里启动：cd /path/to/project && circle',
  'add {dir} to PATH, or run {bin}': '把 {dir} 加入 PATH，或运行 {bin}',
  'added {dir} to PATH in {file}': '已把 {dir} 加入 {file} 的 PATH',
  'open a new terminal (or run: source {file}), then: cd /path/to/project && circle':
    '新开一个终端（或运行 source {file}），然后：cd /path/to/project && circle',
  'removed {file}; it only had a circle PATH line and zsh is not installed':
    '已删除 {file}；里面只有一行 circle 的 PATH，而且没有安装 zsh',
  'removed a circle PATH line from {file}; zsh is not installed':
    '已从 {file} 删除 circle 的 PATH 行；没有安装 zsh',
  'downloading {asset}': '正在下载 {asset}',
  'verifying the download': '正在校验下载',
  unpacking: '正在解压',
  'Missing command: {command}': '缺少命令：{command}',
  'Invalid repository': '仓库名无效',
  'Run install.ps1 from PowerShell': '请在 PowerShell 里运行 install.ps1',
  'Unsupported operating system': '不支持的操作系统',
  'Unsupported architecture': '不支持的处理器架构',
  'No release has been published yet': '还没有发布',
  'Invalid semantic version': '版本号不是合法的语义化版本',
  'Invalid checksum receipt': '校验和文件无效',
  'sha256sum or shasum is required': '需要 sha256sum 或 shasum',
  'Archive checksum mismatch': '压缩包校验和不匹配',
  'Unexpected archive root': '压缩包的根目录不对',
  'Unsafe archive entry': '压缩包里有不安全的路径',
  'Archive links and special files are not allowed':
    '不允许压缩包里有链接或特殊文件',
  'Incomplete release': '发布不完整',
  'Run circle, or {bin}.': '运行 circle，或 {bin}。',

  // hotkey labels and descriptions; the column is padded by display width
  'in a list': '在列表里',
  'down (empty)': '空着按 down',
  'mouse drag': '拖动鼠标',
  'mouse wheel': '鼠标滚轮',
  'send; while busy, the model reads it after its current step':
    '发送；忙时，模型在当前步骤之后再读',
  'enter on an empty prompt: the model reads it now':
    '空提示上按 enter：模型现在就读',
  'on an empty prompt, take back the last message not read yet':
    '空提示上，收回还没被读到的上一条',
  'queue a follow-up: sent when the turn ends (also alt+enter)':
    '把追加消息排队：回合结束时发送（alt+enter 也行）',
  'take back messages the model has not read yet': '收回模型还没读到的消息',
  'paste the picture on the clipboard (also alt+v)':
    '粘贴剪贴板上的图片（alt+v 也行）',
  'stop the turn; with a draft, press again to clear (ctrl+y restores)':
    '停止回合；有草稿时再按一次清空（ctrl+y 恢复）',
  'clear a draft, or the session tree (/tree) when the box is empty':
    '清空草稿；输入框空着时打开会话树（/tree）',
  'abort turn; clear the prompt; on an empty prompt twice to exit':
    '中止回合；清空提示；空提示上按两次退出',
  'exit (with an empty prompt; otherwise delete forward)':
    '退出（空提示时；否则向前删除）',
  'suspend to the shell; fg comes back': '挂起回到 shell；fg 回来',
  'move a running command to the background (/jobs lists them)':
    '把正在跑的命令放到后台（/jobs 列出它们）',
  'line break (also shift+enter, ctrl+j)': '换行（shift+enter、ctrl+j 也行）',
  'expand/collapse thinking': '展开或收起思考',
  'expand/collapse tool output': '展开或收起工具输出',
  'reverse-i-search history': '反向搜索历史',
  'redraw the screen': '重画屏幕',
  'choose a model (/models)': '选择模型（/models）',
  'switch sessions, including while an approval waits':
    '切换会话，审批等待时也可以',
  'next model, for this session': '下一个模型，只对这个会话',
  'earlier / next prompt (also up / down)':
    '上一条 / 下一条提示（up / down 也行）',
  'next session mode (manual, accept edits, read-only, auto)':
    '下一个会话模式（手动、自动接受编辑、只读、自动）',
  'next thinking depth, for this session': '下一个思考深度，只对这个会话',
  'edit the draft in $VISUAL / $EDITOR (/editor)':
    '用 $VISUAL / $EDITOR 编辑草稿（/editor）',
  'copy the last answer (/copy)': '复制上一条回答（/copy）',
  'enter a secret a task left waiting': '输入任务正在等的密钥',
  'find in the conversation; enter next, esc closes':
    '在对话里查找；enter 下一个，esc 关闭',
  'move by word (also ctrl+left/right, alt+b / alt+f)':
    '按词移动（ctrl+left/right、alt+b / alt+f 也行）',
  'delete the word before the cursor (also alt+backspace)':
    '删除光标前的一个词（alt+backspace 也行）',
  'delete the word after the cursor': '删除光标后的一个词',
  'delete to the end / back to the start of the line; ctrl+y restores':
    '删到行尾 / 删回行首；ctrl+y 恢复',
  'alt+d saves a default · ctrl+k deletes or stops · ctrl+r renames':
    'alt+d 保存默认 · ctrl+k 删除或停止 · ctrl+r 重命名',
  'prompt history; with an empty prompt and no more history,':
    '提示历史；空提示且没有更多历史时，',
  'scroll the transcript': '滚动对话',
  'select a running subagent; up/down move, enter opens it':
    '选中正在跑的子代理；up/down 移动，enter 打开',
  'previous/next subagent on its detail page; esc goes back':
    '在详情页上一个/下一个子代理；esc 返回',
  'scroll transcript (or the detail page) when the prompt is empty':
    '提示为空时滚动对话（或详情页）',
  'top / bottom of the transcript when the prompt is empty':
    '提示为空时到对话顶部 / 底部',
  'select and copy; dragging to the top or bottom edge scrolls':
    '选择并复制；拖到上沿或下沿会滚动',
  'complete a /command or an @path': '补全 /命令 或 @路径',
  'this list (with an empty prompt)': '这个列表（空提示时）',
  'slash commands (/help)': '斜杠命令（/help）',
  'answer a permission or question card; enter confirms, esc rejects,':
    '回答审批或提问卡；enter 确认，esc 拒绝，',
  'y / a / n also work on permission cards': '审批卡上 y / a / n 也可以',
  'over the plan box scrolls it; elsewhere it scrolls the transcript':
    '在计划框上滚动计划；别处滚动对话',
  'new hook': '新的',
  'changed hook': '已更改',
  'unchanged hook': '未改',
};

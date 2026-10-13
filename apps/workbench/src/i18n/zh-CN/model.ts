// Simplified Chinese for the interface words in the model files. English is the key.
export const model: Record<string, string> = {
  // what the live runtime says
  'UI preferences could not be saved': '无法保存界面偏好',
  'runtime action failed': '运行时操作失败',
  'Circle runtime disconnected': 'Circle 运行时已断开',
  'use a native session operation': '请使用原生会话操作',
  'queue messages through the composer': '请通过输入框把消息加入队列',
  'history can only be imported through the native runtime':
    '历史只能通过原生运行时导入',
  'choose a workspace through the native folder dialog':
    '请通过系统文件夹对话框选择工作区',
  'open the workspace through the native folder dialog':
    '请通过系统文件夹对话框打开工作区',
  'interaction is no longer available': '这个请求已失效',
  '{kind} is not connected yet': '{kind} 尚未接入',
  '/{name} is not connected yet': '/{name} 尚未接入',
  'unknown command /{name}': '未知命令 /{name}',
  'the message and its files are over 64 MB; remove some pictures or PDFs':
    '消息和附带的文件超过 64 MB，请移除一些图片或 PDF',
  'session not found': '未找到会话',
  'no previous session': '没有上一个会话',
  'choose manual, accept-edits, plan or auto':
    '请选择 manual、accept-edits、plan 或 auto',
  'unknown thinking depth': '未知的思考深度',
  'skill added to the next message': '技能已添加到下一条消息',
  'last turn hidden; saved history and files remain':
    '已隐藏上一轮；已保存的历史和文件仍然保留',
  'transcript restored': '对话记录已恢复',
  'rule not found': '未找到规则',
  'Circle integrations reloaded': 'Circle 集成已重新加载',
  'local share saved · {path}': '本地分享已保存 · {path}',
  'local share removed': '本地分享已移除',
  'live sessions are managed through the sessions page':
    '运行时中的会话请在会话页面管理',
  // the built-in tools; names stay as they are
  'List a folder': '列出文件夹内容',
  'List a folder. Folders end in `/`.': '列出文件夹内容。文件夹以 `/` 结尾。',
  "Read a text file with line numbers (12: text), a folder's entries, or an image or a PDF":
    '读取带行号的文本文件（12: text）、文件夹的条目，或者图片和 PDF',
  "Read a text file with line numbers (`12: text`), a folder's entries, or an image or a PDF. Arguments: `file_path`, `offset` (lines to skip), `limit`.":
    '读取带行号的文本文件（`12: text`）、文件夹的条目，或者图片和 PDF。参数：`file_path`、`offset`（跳过的行数）、`limit`。',
  'Find files by pattern.': '按模式查找文件。',
  'Search file contents for **literal text**, not a regular expression':
    '在文件内容中搜索**字面文本**，而不是正则表达式',
  'Search file contents for **literal text**, not a regular expression. Modes: files with matches (the default), matching lines, counts. A `glob` argument limits the files searched.':
    '在文件内容中搜索**字面文本**，而不是正则表达式。模式：包含匹配的文件（默认）、匹配的行、计数。`glob` 参数限定要搜索的文件。',
  'Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations':
    '询问语言服务器：跳转到定义、查找引用、悬停信息、文件或工作区中的符号、实现',
  'Ask a language server: go to definition, find references, hover, symbols in a file or the workspace, implementations. Positions are 1-based.':
    '询问语言服务器：跳转到定义、查找引用、悬停信息、文件或工作区中的符号、实现。位置从 1 开始计数。',
  'Fetch a URL': '获取一个 URL',
  'Fetch a URL. Formats: `markdown` (the default), `text`, `html`. JSON is pretty-printed.':
    '获取一个 URL。格式：`markdown`（默认）、`text`、`html`。JSON 会格式化输出。',
  'Search the web through DuckDuckGo': '通过 DuckDuckGo 搜索网页',
  'Search the web through DuckDuckGo. No API key.':
    '通过 DuckDuckGo 搜索网页。不需要 API 密钥。',
  'Create or overwrite a file.': '创建或覆盖文件。',
  'Replace exact text in a file': '替换文件中的精确文本',
  'Replace exact text in a file. Arguments: `file_path`, `old_string`, `new_string`, `replace_all`.':
    '替换文件中的精确文本。参数：`file_path`、`old_string`、`new_string`、`replace_all`。',
  'Apply a multi-file patch in the *** Begin Patch format: add, update, move and delete files.':
    '应用 *** Begin Patch 格式的多文件补丁：新增、更新、移动和删除文件。',
  'Apply a multi-file patch in the `*** Begin Patch` format: add, update, move and delete files.':
    '应用 `*** Begin Patch` 格式的多文件补丁：新增、更新、移动和删除文件。',
  'Delete a file or a folder and everything in it.':
    '删除文件，或删除文件夹及其中的全部内容。',
  'Take a screenshot of the main screen, or of the front window of one application':
    '截取主屏幕，或某个应用最前面的窗口',
  'Take a screenshot of the main screen, or of the front window of the application named in `app`, and send it to the model as an image. It asks each time unless allowed for the session, and is refused in read-only mode.':
    '截取主屏幕，或 `app` 指定的应用最前面的窗口，并作为图片发送给模型。除非本会话内已允许，否则每次都会询问；只读模式下会被拒绝。',
  'Run a shell command in the workspace': '在工作区中运行 shell 命令',
  'Run a shell command in the workspace. With `background: true` it runs as a background job and returns at once. Standard output and standard error come back together, in the order they were written.':
    '在工作区中运行 shell 命令。设置 `background: true` 时作为后台任务运行并立即返回。标准输出和标准错误按写入顺序一起返回。',
  'Keep the plan shown in the plan box.': '维护计划框中显示的计划。',
  'Ask you one or more questions with options, or ask for a secret':
    '向你提出一个或多个带选项的问题，或者请你提供密钥',
  'Ask you one or more questions with options, or ask for a secret. Your answers become the tool result. See Answer a question and Secrets.':
    '向你提出一个或多个带选项的问题，或者请你提供密钥。你的回答会成为工具结果。参见文档中的 Answer a question 和 Secrets。',
  'Switch to read-only mode, as /plan does.': '切换到只读模式，与 /plan 相同。',
  'Switch to `read-only` mode, as `/plan` does.':
    '切换到只读（`read-only`）模式，与 `/plan` 相同。',
  'Ask you whether to leave read-only mode and implement the plan':
    '询问你是否离开只读模式并实施计划',
  'Ask you whether to leave `read-only` mode and implement the plan. Only you can say yes, so it fails without the full-screen interface.':
    '询问你是否离开只读（`read-only`）模式并实施计划。只有你能同意，所以没有全屏界面时它会失败。',
  "List this conversation's jobs: id, kind, state, time, what, and the file their output goes to.":
    '列出这个对话的任务：id、类型、状态、时间、内容，以及输出写入的文件。',
  'Stop a running job with everything it started.':
    '停止一个正在运行的任务，以及它启动的一切。',
  'Wait until one of the given jobs ends (up to 600 seconds), and return how it ended':
    '等待指定任务中的任意一个结束（最长 600 秒），并返回它是如何结束的',
  'Wait until one of the given jobs ends (up to 600 seconds), and return how it ended. Only subagents have it: they cannot be woken by a notice.':
    '等待指定任务中的任意一个结束（最长 600 秒），并返回它是如何结束的。只有子代理有这个工具：它们无法被通知唤醒。',
  'Load the full instructions of a skill by name.':
    '按名称加载技能的完整说明。',
  'Run a subagent (general-purpose, explore, or one an extension adds) and return its answer':
    '运行子代理（general-purpose、explore，或扩展添加的子代理）并返回它的回答',
  'Run a subagent (`general-purpose`, `explore`, or one an extension adds) and return its answer. Arguments: `description`, `subagent_type`, `background`. With `background: true` the subagent runs as a background job and its report comes as a notice. See How Circle works.':
    '运行子代理（`general-purpose`、`explore`，或扩展添加的子代理）并返回它的回答。参数：`description`、`subagent_type`、`background`。设置 `background: true` 时子代理作为后台任务运行，报告以通知形式送达。参见文档中的 How Circle works。',
  'Summarize older messages now': '立即总结较早的消息',
  'Summarize older messages now. See Compaction.':
    '立即总结较早的消息。参见文档中的 Compaction。',
  // built-in slash commands
  'List slash commands': '列出斜杠命令',
  'Show keyboard shortcuts': '显示快捷键',
  'Sign in or change the endpoint, key and model':
    '登录，或更换端点、密钥和模型',
  'Clear saved credentials': '清除保存的凭据',
  'Analyze repo and write AGENTS.md': '分析仓库并写出 AGENTS.md',
  'Trust this workspace': '信任这个工作区',
  'Show current settings': '显示当前设置',
  'Show or set the theme: /themes [auto|dark|light]':
    '显示或设置主题：/themes [auto|dark|light]',
  'List / reload MCP servers and tools': '列出或重新加载 MCP 服务器和工具',
  'List extensions: /extensions [reload]': '列出扩展：/extensions [reload]',
  'Session approvals: /approvals [revoke N]':
    '会话审批规则：/approvals [revoke N]',
  'Background jobs: open one, or stop it': '后台任务：打开或停止',
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
  'Next approval mode, or /mode manual|accept-edits|plan|auto':
    '切换到下一个审批模式，或 /mode manual|accept-edits|plan|auto',
  'Quit Circle': '退出 Circle',
};

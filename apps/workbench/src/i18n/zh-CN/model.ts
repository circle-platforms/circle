// Simplified Chinese for the interface words in the model files. English is the key.
export const model: Record<string, string> = {
  'Click a visible control without an element ref':
    '点击没有元素引用的可见控件',
  'Use CSS coordinates from the latest screenshot. It is refused after scrolling, resizing or navigating, or when what is at the point changed; changes elsewhere on the page do not count. Unknown or destructive targets ask once. Coordinate clicks are not recorded.':
    '使用最新截图中的 CSS 坐标。滚动、调整大小或跳转后，或者点击位置的内容变了，会被拒绝；页面其他地方的变化不算。未知或删除目标需单次确认。坐标点击不加入录制脚本。',

  // what the live runtime says
  'UI preferences could not be saved': '无法保存界面偏好',
  'runtime action failed': '运行时操作失败',
  'Editor bridge on localhost: /bridge [start|stop|token]':
    '本机编辑器桥：/bridge [start|stop|token]',
  'the editor bridge is the terminal’s · run /bridge start in circle':
    '编辑器桥属于终端 · 请在 circle 里运行 /bridge start',
  'What your editor reports': '你的编辑器报告的内容',
  'What your editor reported: its file, the selection, how old each is, and how many diff requests wait.':
    '你的编辑器报告的：当前文件、所选内容、各自多久之前，以及有几个差异请求在等待。',
  'The file your editor has open': '编辑器打开的文件',
  'The path of the file the editor has open, or that nobody reported one.':
    '编辑器当前打开文件的路径，或没有人报告过文件。',
  'The text you selected in your editor': '你在编辑器中选中的文本',
  'The selected text with its file and line range. A selection older than ten minutes is refused as context.':
    '所选文本及其文件和行范围。超过十分钟的选区不作为上下文。',
  'Ask your editor to show a diff': '请编辑器展示差异',
  'Ask the editor to show a diff of a file against the proposed text. Nothing is written until you accept there.':
    '请编辑器把文件与提议文本的差异展示出来；只有你在那里接受才会写入。',
  disconnected: '已断开',
  'Circle runtime disconnected': 'Circle 运行时已断开',
  'Circle runtime ran out of memory': 'Circle 运行时内存不足',
  'Circle runtime crashed': 'Circle 运行时崩溃',
  'Circle runtime exited': 'Circle 运行时已退出',
  'restart it from the sidebar': '可在侧边栏重启',
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
  'unknown command /{name} · turn it on with /extensions enable {extension}':
    '未知命令 /{name} · 用 /extensions enable {extension} 打开它',
  'the message and its files are over 64 MB; remove some pictures or PDFs':
    '消息和附带的文件超过 64 MB，请移除一些图片或 PDF',
  'prompt is empty': '请先写一条消息',
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
  'Have the side vision model describe a picture file':
    '让辅助视觉模型描述一个图片文件',
  'Have the side vision model describe a picture file, answering `question`. Offered only when a side vision model is set.':
    '让辅助视觉模型描述一个图片文件，回答 `question`。仅在设置了辅助视觉模型时提供。',
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
  'Take a screenshot of the main screen, or of the front window of the application named in `app`, and send it to the model as an image; for a model that does not read images, the side vision model gets it and the model gets its description. It asks each time unless allowed for the session, and is refused in read-only mode.':
    '截取主屏幕，或 `app` 指定的应用最前面的窗口，并作为图片发送给模型；对不读图片的模型，图片交给辅助视觉模型，模型得到它的描述。除非本会话内已允许，否则每次都会询问；只读模式下会被拒绝。',
  'Run a shell command in the workspace': '在工作区中运行 shell 命令',
  'Open a page in the session browser': '在会话浏览器中打开页面',
  'Read the visible page and its element refs': '读取可见页面及元素编号',
  'Click an element in the browser': '点击浏览器中的元素',
  'Type text into a browser element': '在浏览器元素中输入文本',
  'Replace text in an element, optionally submitting with Enter. Password fields require you to type in the browser panel.':
    '替换元素中的文本，可选择回车提交。密码框需要你在浏览器面板中亲自输入。',
  'Choose options in a browser element': '选择浏览器元素中的选项',
  'Choose options in a select element by their text or value.':
    '按文本或值选择下拉框中的选项。',
  'Press a key in the browser': '在浏览器中按键',
  'Press Enter, Tab, Escape, an arrow key or another supported browser key.':
    '在浏览器中按 Enter、Tab、Escape、方向键或其他支持的按键。',
  'Capture the session browser for the model': '截取会话浏览器画面给模型',
  'Send the browser viewport as an image to the model; for a model that does not read images, the picture is saved and the side vision model describes it. The operation overlay is hidden during capture.':
    '把浏览器视口作为图片交给模型；对不读图片的模型，图片会被保存，并由辅助视觉模型描述。截取时会隐藏操作覆盖层。',
  'Answer a browser JavaScript dialog': '回答浏览器的 JavaScript 对话框',
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
  "Open an HTTP or HTTPS page, or go back, forward or reload. An untrusted certificate shows the browser's warning in the tab; passing it needs your approval.":
    '打开 HTTP 或 HTTPS 页面，或者后退、前进、重新加载。证书不受信任时，标签页里会显示浏览器的警告；越过警告需要你批准。',
  'Read the page, its waiting dialogs, tabs and what happened since the last look. Refs stay with their elements; password values are omitted.':
    '读取页面、等待回答的对话框、标签页，以及上次查看以来发生的事。元素编号跟随元素不变；不输出密码值。',
  'Click an element by its ref with the visible pointer, then read the updated page. Covered elements cannot be clicked.':
    '用可见的指针按编号点击元素，然后读取更新后的页面。被遮挡的元素无法点击。',
  "Accept or dismiss a page's alert, confirm, prompt or leave-page question, as you can in the panel or the conversation.":
    '接受或拒绝网页的提示、确认、输入或离开页面询问，和你在面板或对话里能做的一样。',
  'List, open, show or close browser tabs':
    '列出、打开、切换或关闭浏览器标签页',
  'Pages that open a new window or tab appear as tabs; you and Circle see the same shown tab.':
    '网页打开的新窗口或标签页会成为标签页；你和 Circle 看到的是同一个当前标签页。',
  "Record the conversation's browser actions as a script":
    '把对话中的浏览器操作录制为脚本',
  "Write this conversation's browser actions to a script file in Circle's own format, each element kept by its role and name. Writing the file asks as writing any file does.":
    '把这个对话中的浏览器操作写成 Circle 自己格式的脚本文件，每个元素按角色和名称记录。写入文件时和写其他文件一样需要审批。',
  'Replay a recorded browser script': '回放录制的浏览器脚本',
  "Run a script's steps in the conversation's browser without the model in between, waiting for each element. It acts only on the site it starts on, which you allow as for other browser actions, and stops at the first step that cannot be done.":
    '在会话浏览器中逐步执行脚本，中间不经过模型，每一步都会等待它的元素出现。它只在开始时所在的站点上操作，你像批准其他浏览器操作一样批准这个站点；遇到第一个无法完成的步骤时停止。',
  'Give a page files from this computer': '把这台电脑上的文件交给网页',
  'Hand you the browser and wait for it back': '把浏览器交给你，等你交还',
  'For what only you should do in the page, such as a security key or a CAPTCHA. Circle sees nothing while you have it, and learns only where the tabs went.':
    '用于只该由你在网页上完成的事，比如安全密钥或验证码。浏览器在你手上时 Circle 什么也看不到，只会知道标签页去了哪些地址。',
  'For a file input, or for the file chooser one of its clicks opened. Circle asks you every time, with the files and the site.':
    '用于文件输入框，或它的点击打开的文件选择框。Circle 每次都会问你，并列出文件和站点。',
  'Named values Circle fills in: /variables [NAME=value]':
    'Circle 会填入的命名值：/variables [NAME=value]',
  'Named values Circle fills in unseen: /secrets [NAME]':
    'Circle 会填入、但模型看不到的命名值：/secrets [NAME]',
  // device terminals in the tool catalogue
  'List the terminals and saved device profiles':
    '列出终端会话与已保存的设备档案',
  "List this conversation's device terminals with their state, and the person's saved profiles.":
    '列出本对话的设备终端及其状态，以及使用者保存的设备档案。',
  'Open an SSH or Telnet console': '打开 SSH 或 Telnet 控制台',
  'Open a device console by a saved profile or a bare host. SSH sign-in comes only from a profile, whose password is a saved secret; an unknown device host key stops the login and asks you.':
    '按已保存的档案或主机地址打开设备控制台。SSH 登录只能来自档案，其密码是已保存的秘密；陌生的设备主机密钥会中止登录并询问你。',
  'Save a device profile so SSH can sign in': '保存设备档案，供 SSH 登录',
  'Save a device under a profile name so terminal_connect can sign in to it: the password comes from the NAME of a secret the user saved, never its value; a save replaces the profile of the same name.':
    '把设备保存为档案，terminal_connect 即可按名登录：密码只引用用户保存的秘密名，绝不写入其值；同名档案会被替换。',
  'Type text to a device console': '向设备控制台输入文本',
  'Type text to a device, Enter when asked; a word that can destroy device state in the line asks you every time. %NAME% puts in a secret whose value you never see back.':
    '向设备输入文本，需要时按下回车；行内含有会破坏设备状态的词时每次都要询问你。%NAME% 填入秘密，其值不会再出现在结果里。',
  'Read a device screen and its prompt': '读取设备画面与提示符',
  "Read a device terminal's last lines and the line the cursor sits on, as plain text.":
    '以纯文本读取设备终端的最后几行，以及光标所在的提示符行。',
  'Wait for a device screen to rest': '等待设备画面静止',
  'Wait until a device screen rests or shows a pattern, bounded by a timeout; a timeout is an answer, not a failure.':
    '等待设备画面静止或出现指定模式，受超时限制；超时是回答而不是失败。',
  'Press one key on a device console': '在设备控制台按一个键',
  'Press Enter, Tab, Escape, an arrow, Ctrl-C or another known key on a device terminal.':
    '在设备终端上按回车、Tab、Esc、方向键、Ctrl-C 或其他已知按键。',
  'Close a device console': '关闭设备控制台',
  "Close one of the conversation's device consoles; its last screen stays readable.":
    '关闭本对话的一个设备控制台；它最后的画面仍可读。',
  'Hand a device console to the user': '把设备控制台交给使用者',
  'Give the person a console to type on; the model waits until they give it back and then sees the screen as they left it, never what they typed.':
    '把控制台交给人来输入；模型会等到对方交还，然后看到他们留下的画面，而不会看到他们输入的内容。',
};

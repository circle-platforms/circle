// Interface words for /hub. English is the key; Simplified Chinese is used when the
// process language is Chinese. Read the language when the line is made, not when
// this module loads, so a test can switch it without leaking into another file.
// Commands, ids, paths and words the server chose stay in the placeholders.

export const HUB_ZH: Record<string, string> = {
  'hub · signed out': '枢纽 · 已退出',
  'hub · {who}': '枢纽 · {who}',
  '{where} · {task} stopped following': '{where} · 已停止跟随 {task}',
  '{where} · {n} running': '{where} · {n} 个正在运行',
  '{where} · sign-in expired': '{where} · 登录已过期',
  '{where} · {n} bot result(s)': '{where} · {n} 条机器人结果',
  'not a URL: {raw}': '不是网址：{raw}',
  'the address must start with http:// or https://':
    '地址必须以 http:// 或 https:// 开头',
  'put no user name or password in the address': '地址里不要写用户名或密码',
  'not signed in: /hub login <url> <user>': '未登录：/hub login <url> <user>',
  'cannot reach {url}: {message}': '无法连接 {url}：{message}',
  '{method} {path} → {status}, not JSON':
    '{method} {path} → {status}，不是 JSON',
  'request failed': '请求失败',
  'the server issued no token': '服务器没有签发 token',
  'hub turned down the run token': '枢纽拒绝了这次运行的 token',
  'signed out: the sign-in has expired · /hub login {url} {user}':
    '已退出：登录已过期 · /hub login {url} {user}',
  'the server sent no task': '服务器没有返回任务',
  invalid: '无效',
  'sign-in was refused ({code}). Check the user and password, then /hub login again.':
    '登录被拒绝（{code}）。请核对用户和密码，然后重新 /hub login。',
  'the server refused this ({code}): {detail}. Sign in to a scope that may do it, or ask someone who can.':
    '服务器拒绝了这一操作（{code}）：{detail}。请登录到可以做这件事的范围，或请能做的人来。',
  'not found ({code}). Check the id and try again.':
    '未找到（{code}）。请核对 id 后再试。',
  'the hub refused the payload ({code}). {detail}. skillpack.json needs outputs (at least one file). --outputs only names the trial files and defaults to that list.':
    '枢纽拒绝了这份内容（{code}）。{detail}。skillpack.json 必须有 outputs（至少一个文件）。--outputs 只指定试验文件，缺省时用这份列表。',
  'the hub refused the payload ({code}). {detail}':
    '枢纽拒绝了这份内容（{code}）。{detail}',
  'Check the fields the command sent.': '请检查命令送出的字段。',
  '{message}. Fix skillpack.json so it declares every tool the trial used, then /hub trial start --force and push again.':
    '{message}。请改 skillpack.json，声明试验用过的每个工具，然后 /hub trial start --force 再推送。',
  'the file changed while it was sent ({code}). Send it again.':
    '发送过程中文件变了（{code}）。请重新发送。',
  'that is larger than the server accepts ({code}). Send a smaller file.':
    '超过了服务器接受的大小（{code}）。请发送更小的文件。',
  'the request no longer matches': '这个请求已经对不上',
  'nothing is waiting for that answer ({code}: {named}). {said}. An open approval is decided with /hub approve <task> <approval>, and /hub review lists those. /hub task <id> shows the phase.':
    '没有在等这个回答（{code}：{named}）。{said}。待处理的审批用 /hub approve <task> <approval> 决定，/hub review 会列出它们。/hub task <id> 显示阶段。',
  'that request already has a decision ({code}: {named}). {said}. /hub task <id> shows the phase. Wait for a new question before /hub respond, or /hub review for what is still open.':
    '这个请求已经有决定（{code}：{named}）。{said}。/hub task <id> 显示阶段。等新问题再 /hub respond，或用 /hub review 看还开着的审批。',
  'the server refused this decision ({code}: {named}). {said}. /hub task <id> shows the phase; /hub review lists open approvals.':
    '服务器拒绝了这个决定（{code}：{named}）。{said}。/hub task <id> 显示阶段；/hub review 列出待处理的审批。',
  ' · read back with {reader}, {rows} rows': ' · 用 {reader} 读回，{rows} 行',
  ' · {n} unmapped (listed in the workbook)': ' · {n} 项未映射（写在工作簿里）',
  '    case {id} · {verdict}': '    用例 {id} · {verdict}',
  '    execution {operation} · terminal {terminal} · remote lease released {released}':
    '    执行 {operation} · 终端 {terminal} · 远程租约已释放 {released}',
  '    unmapped {path}: {reason}': '    未映射 {path}：{reason}',
  '    evidence {id} · {kind} · sha256 {hash}':
    '    证据 {id} · {kind} · sha256 {hash}',
  '  {task} delivered no files': '  {task} 没有交付文件',
  "✖ {name}: the bytes ({actual}) do not match the server's SHA-256 ({expected}); not saved":
    '✖ {name}：字节（{actual}）与服务器的 SHA-256（{expected}）不一致，未保存',
  '✓ saved {path} · {bytes} bytes · sha256 {hash} matches the server ({id})':
    '✓ 已保存 {path} · {bytes} 字节 · sha256 {hash} 与服务器一致（{id}）',
  ' · step {step}{kind}': ' · 步骤 {step}{kind}',
  '  {task} was delivered and its results are saved here · /hub get {task} saves them again':
    '  {task} 已交付，结果已保存在这里 · /hub get {task} 可以再次保存',
  '✖ {task}: the outcome is unknown and the server does not guess it · /hub task {task} later':
    '✖ {task}：结果未知，服务器不做猜测 · 稍后再 /hub task {task}',
  '  {task} asks: {question} · /hub respond {task} <answer>':
    '  {task} 询问：{question} · /hub respond {task} <answer>',
  '✖ {task}: {message} · /hub task {task} picks it up again':
    '✖ {task}：{message} · /hub task {task} 可以再接着看',
  '{name} is larger than 16 MB': '{name} 超过 16 MB',
  'the server returned no source id': '服务器没有返回来源 id',
  '{name} arrived with a different SHA-256': '{name} 到达时的 SHA-256 不同',
  'no scope: sign in again with /hub login <url> <user>':
    '没有范围：请重新 /hub login <url> <user>',
  'module-execute takes the flow input, not a file: /hub submit module-execute <input-json>':
    'module-execute 要的是流程输入，不是文件：/hub submit module-execute <input-json>',
  'module-execute input is the flow: {flowId, methodPin, resources, sources?, value?, controlledBytes?}':
    'module-execute 的输入是流程：{flowId, methodPin, resources, sources?, value?, controlledBytes?}',
  'no such file: {path}': '没有这个文件：{path}',
  '  uploaded {name} · sha256 {hash} → {id}':
    '  已上传 {name} · sha256 {hash} → {id}',
  'the server accepted no task': '服务器没有接受任务',
  'not signed in: /hub login {url} <user>': '未登录：/hub login {url} <user>',
  "  could not read the server's tools: {message}":
    '  无法读取服务器的工具：{message}',
  '  this server offers no tools': '  这台服务器没有提供工具',
  '  {n} server tools available to the model from its next turn':
    '  从下一轮起，模型可以使用 {n} 个服务器工具',
  'asks first': '先询问',
  'read-only': '只读',
  '    {name} ← {remote} · {mode}': '    {name} ← {remote} · {mode}',
  '{n} unpushed trial call': '{n} 条未推送的试验调用',
  '{n} unpushed trial calls': '{n} 条未推送的试验调用',
  '  {noun} would be dropped. /hub skill push <folder> sends them with the pack. /hub trial start --force drops them and records from now.':
    '  {noun}会被丢掉。/hub skill push <folder> 会随技能包一起送出。/hub trial start --force 丢掉它们，并从现在开始记录。',
  '  dropped {noun}.\n': '  已丢掉 {noun}。\n',
  '  recording the server tool calls of this trial; /hub skill push <folder> sends them with the pack':
    '  正在记录这次试验的服务器工具调用；/hub skill push <folder> 会随技能包一起送出',
  '{path} is larger than 2 MB': '{path} 超过 2 MB',
  'the skill pack is larger than 10 MB': '技能包超过 10 MB',
  'more than {n} files': '超过 {n} 个文件',
  'skillpack.json needs {problems} before the hub will accept it (client API 1.0.0). outputs is required there (at least one file the pack produces). The trial call record may be empty. --outputs names the trial files and defaults to that list.':
    '枢纽接受之前，skillpack.json 还需要 {problems}（客户端 API 1.0.0）。那里的 outputs 是必需的（技能包产出的至少一个文件）。试验调用记录可以是空的。--outputs 指定试验文件，缺省时用这份列表。',
  'usage: /hub skill push <folder> [--outputs a,b]. skillpack.json outputs are required; the trial call record may be empty.':
    '用法：/hub skill push <folder> [--outputs a,b]。skillpack.json 的 outputs 是必需的；试验调用记录可以是空的。',
  '--outputs needs a comma-separated file list (a,b). Without that list it does not take the next word. skillpack.json outputs are required (at least one file the pack produces). The trial call record may be empty.':
    '--outputs 需要逗号分隔的文件列表（a,b）。没有这份列表时，不会把下一个词当成列表。skillpack.json 的 outputs 是必需的（技能包产出的至少一个文件）。试验调用记录可以是空的。',
  '--outputs needs a comma-separated file list (a,b). skillpack.json outputs are required. The trial call record may be empty.':
    '--outputs 需要逗号分隔的文件列表（a,b）。skillpack.json 的 outputs 是必需的。试验调用记录可以是空的。',
  '{folder} is not a folder': '{folder} 不是文件夹',
  '{folder}/skillpack.json: {message}': '{folder}/skillpack.json：{message}',
  '{folder} has no SKILL.md': '{folder} 没有 SKILL.md',
  '  ! the trial used tools skillpack.json does not declare: {names}':
    '  ! 试验用了 skillpack.json 没有声明的工具：{names}',
  '{files} is not in the workspace. /hub skill push uses the files skillpack.json lists as outputs; pass --outputs a,b for this trial, or put those files in place.':
    '{files} 不在工作区。/hub skill push 使用 skillpack.json 列出的 outputs；这次试验可以传 --outputs a,b，或把这些文件放到位。',
  '{files} are not in the workspace. /hub skill push uses the files skillpack.json lists as outputs; pass --outputs a,b for this trial, or put those files in place.':
    '{files} 不在工作区。/hub skill push 使用 skillpack.json 列出的 outputs；这次试验可以传 --outputs a,b，或把这些文件放到位。',
  '  ! {output} does not exist; left out of the trial record':
    '  ! {output} 不存在，未写入试验记录',
  '✓ submitted {id} {version} · {files} files · {calls} trial calls · {pack} · digest {digest} · {status}':
    '✓ 已提交 {id} {version} · {files} 个文件 · {calls} 次试验调用 · {pack} · 摘要 {digest} · {status}',
  'the server found tools the trial used but the pack does not declare':
    '服务器发现试验用过、但技能包没有声明的工具',
  'the server offers none of': '服务器一个都没有',
  '  ✖ {label}: {names}': '  ✖ {label}：{names}',
  '  submitted, but the server named no approval task. /hub review lists open approvals':
    '  已提交，但服务器没有给出审批任务。/hub review 列出待处理的审批',
  '{name} is not a file in the workspace': '{name} 不是工作区里的文件',
  '{what} are not a JSON object: {message}': '{what} 不是 JSON 对象：{message}',
  'not an interval: {text} (for example 30m, 1h or 1d)':
    '不是时间间隔：{text}（例如 30m、1h 或 1d）',
  'the server sent no asset': '服务器没有返回资产',
  'every {every} from {from}': '从 {from} 起每 {every}',
  'on {event} of {source}': '{source} 的 {event}',
  'no trigger': '没有触发器',
  'the server has not said who you are here; sign in again with /hub login <url> <user>':
    '服务器还没有说明你是谁；请重新 /hub login <url> <user>',
  'usage: /hub bot every <skill pack> <interval> [--from <time>] [--inputs <json>] [--file <path>] [--name <name>]':
    '用法：/hub bot every <skill pack> <interval> [--from <time>] [--inputs <json>] [--file <path>] [--name <name>]',
  'usage: /hub bot on <skill pack> <connector asset> <event> [--inputs <json>] [--file <path>] [--name <name>]':
    '用法：/hub bot on <skill pack> <connector asset> <event> [--inputs <json>] [--file <path>] [--name <name>]',
  'not a time: {from}': '不是时间：{from}',
  '✓ bot {id} · {name} · runs {pack} {trigger} as you · output to Circle · {lifecycle}':
    '✓ 机器人 {id} · {name} · 以你的身份运行 {pack} {trigger} · 输出到 Circle · {lifecycle}',
  '  someone else approves it: /hub bot approve {id} · then you turn it on: /hub bot start {id}':
    '  需要别人批准：/hub bot approve {id} · 然后你来开启：/hub bot start {id}',
  'No bots you can see on this server': '这台服务器上没有你能看到的机器人',
  ', {n} new: /hub bot runs {id}': '，{n} 条新的：/hub bot runs {id}',
  ' · {n} run(s){fresh}': ' · {n} 次运行{fresh}',
  ' · owner {id}': ' · 所有者 {id}',
  ' (trigger {lifecycle})': '（触发器 {lifecycle}）',
  '  {id} · {name} · {lifecycle} · {trigger}{triggerState}{runs}':
    '  {id} · {name} · {lifecycle} · {trigger}{triggerState}{runs}',
  'usage: /hub bot list | every <pack> <interval> | on <pack> <source> <event> | approve <bot> | start <bot> | stop <bot> | runs <bot>':
    '用法：/hub bot list | every <pack> <interval> | on <pack> <source> <event> | approve <bot> | start <bot> | stop <bot> | runs <bot>',
  '{id} is not a bot': '{id} 不是机器人',
  bot: '机器人',
  trigger: '触发器',
  '  {what} {id} is already {lifecycle}': '  {what} {id} 已是 {lifecycle}',
  '{what} {id} is {lifecycle}; someone else approves it first: /hub bot approve {bot}':
    '{what} {id} 现在是 {lifecycle}；需要别人先批准：/hub bot approve {bot}',
  '✓ {what} {id} {lifecycle} · version {version} · digest {digest}':
    '✓ {what} {id} {lifecycle} · 版本 {version} · 摘要 {digest}',
  '  {id} runs {trigger}; its results come to Circle: /hub bot runs {id}':
    '  {id} 的触发是 {trigger}；结果回到 Circle：/hub bot runs {id}',
  '✓ bot {id} {lifecycle}; it starts no more runs':
    '✓ 机器人 {id} {lifecycle}；不再发起运行',
  '  {id} has not run yet': '  {id} 还没有运行过',
  ' · {n} missed occurrence(s) since {time} folded into this run':
    ' · 自 {time} 起 {n} 次错过的触发并入这次运行',
  '  — · {key} · not started: {error}{folded}':
    '  — · {key} · 未开始：{error}{folded}',
  'not published yet': '尚未发布',
  ' · unknown: {list}': ' · 未知：{list}',
  '  {task} · {key} · {status} · {n} file(s){unknown}{folded} · /hub get {task} saves them':
    '  {task} · {key} · {status} · {n} 个文件{unknown}{folded} · /hub get {task} 会保存它们',
  '  ({n} earlier run(s) not shown)': '  （另有 {n} 次更早的运行未显示）',
  '  approval task {task} · no open approval id yet. /hub review lists them; /hub task {task} shows this task':
    '  审批任务 {task} · 还没有待处理的审批 id。/hub review 会列出它们；/hub task {task} 显示这个任务',
  '  waiting for approval {id} in {task} · someone else approves: /hub approve {task} {id}':
    '  等待审批 {id}（任务 {task}）· 需要别人批准：/hub approve {task} {id}',
  '{label} · lifecycle {lifecycle}': '{label} · 生命周期 {lifecycle}',
  '{lifecycle} (server status registered)':
    '{lifecycle}（服务器状态 registered）',
  '{status} · asset {lifecycle}': '{status} · 资产 {lifecycle}',
  'Circle runs with a token from hub here; there is no sign-in':
    'Circle 在这里使用枢纽提供的 token，不能再登录',
  'usage: /hub login [url] <user>': '用法：/hub login [url] <user>',
  'Password for {user} on {url}': '{url} 上 {user} 的密码',
  'Sign-in cancelled': '已取消登录',
  ' · scope {id}': ' · 范围 {id}',
  ' · api {version}': ' · api {version}',
  '● signed in to {url} as {user}{scope}{api}':
    '● 已登录 {url}，用户 {user}{scope}{api}',
  'Circle runs with a token from hub here; there is no sign-out':
    'Circle 在这里使用枢纽提供的 token，不能退出登录',
  'Signed out': '已退出',
  'Not signed in': '未登录',
  'The server lists no capability packs': '服务器没有列出能力包',
  'usage: /hub submit module-execute <input-json> [--again]':
    '用法：/hub submit module-execute <input-json> [--again]',
  'module-execute takes the flow input as a JSON object':
    'module-execute 的流程输入必须是一个 JSON 对象',
  ' · the same request as before, no new task':
    ' · 与上次相同的请求，没有新任务',
  '✓ accepted {task} · {phase} · input {input}{same} · following it; closing Circle does not stop it':
    '✓ 已接受 {task} · {phase} · 输入 {input}{same} · 正在跟随；关闭 Circle 不会停止它',
  'usage: /hub submit <pack> <file> [--again]':
    '用法：/hub submit <pack> <file> [--again]',
  'No tasks handed over from here': '这里还没有交出过任务',
  '  {task} · {phase} · {title} · seen to {seq}':
    '  {task} · {phase} · {title} · 事件已看到 {seq}',
  'usage: /hub task <id>': '用法：/hub task <id>',
  '  {task} · {phase} · {title} · input {input}':
    '  {task} · {phase} · {title} · 输入 {input}',
  'usage: /hub respond <id> <answer>': '用法：/hub respond <id> <answer>',
  '{task} is not waiting for an answer. /hub task {task} shows its phase; an approval is /hub approve, and /hub review lists those.':
    '{task} 不在等回答。/hub task {task} 显示阶段；审批用 /hub approve，/hub review 会列出它们。',
  '{task} is waiting for a decision, not a text answer ({request}). Someone else runs /hub approve {task} {request}. /hub review lists open approvals.':
    '{task} 在等一个决定，不是文字回答（{request}）。需要别人执行 /hub approve {task} {request}。/hub review 列出待处理的审批。',
  '✓ replaced the input of {task} ({request})':
    '✓ 已替换 {task} 的输入（{request}）',
  '✓ answered {task} ({request})': '✓ 已回答 {task}（{request}）',
  'usage: /hub get <id>': '用法：/hub get <id>',
  '  read {tasks} tasks and {packs} capability packs from the server (work tasks for the pages, at most 20, not tool or index tasks). /hub tasks lists only what this window handed over; "seen to N" there is the last event number shown for that task':
    '  从服务器读到 {tasks} 个工作任务和 {packs} 个能力包（页面上的工作任务，最多 20 个，不含工具任务和索引任务）。/hub tasks 只列出这个窗口交出的任务；那里的「事件已看到 N」是该任务已显示的最后一个事件号',
  'usage: /hub trial start [--force]': '用法：/hub trial start [--force]',
  'No skill packs on this server': '这台服务器上没有技能包',
  'usage: /hub skill run <id> [json inputs] [--file <path>]…':
    '用法：/hub skill run <id> [json inputs] [--file <path>]…',
  'the server started no task': '服务器没有启动任务',
  '✓ running {id} on the server as {task} · following it':
    '✓ 正在服务器上运行 {id}，任务 {task} · 正在跟随',
  'usage: /hub skill push <folder> | list | run <id> [json]':
    '用法：/hub skill push <folder> | list | run <id> [json]',
  'usage: /hub reconcile <id> [operationId]':
    '用法：/hub reconcile <id> [operationId]',
  'name the operation: /hub reconcile <id> <operationId>':
    '请写出操作：/hub reconcile <id> <operationId>',
  'reconcile {task}\n  {detail}': '核对 {task}\n  {detail}',
  '✓ reconcile {task} · {status}': '✓ 核对 {task} · {status}',
  'Nothing is waiting for your approval. /hub task <id> shows one task. Knowledge claims are reviewed one id at a time (GET /v1/knowledge/reviews/<id>); this server has no page that lists them.':
    '没有等你审批的事项。/hub task <id> 显示一个任务。知识声明要按 id 逐条审阅（GET /v1/knowledge/reviews/<id>）；这台服务器没有列出它们的页面。',
  'audit needs admin.manage on this server. There is no browser page; GET /v1/admin/audit is the list.':
    '审计需要这台服务器上的 admin.manage。没有浏览器页面；列表是 GET /v1/admin/audit。',
  'No audit rows. GET /v1/admin/audit is the list; this server has no browser page for it.':
    '没有审计记录。列表是 GET /v1/admin/audit；这台服务器没有它的浏览器页面。',
  'No modules listed. circle-hub has no browser page for them. Install is POST /v1/modules/install (server CLI: node apps/server/src/cli.ts modules install). This command reads GET /v1/skillpacks and GET /v1/assets.':
    '没有列出模块。circle-hub 没有它们的浏览器页面。安装是 POST /v1/modules/install（服务器 CLI：node apps/server/src/cli.ts modules install）。这条命令读取 GET /v1/skillpacks 和 GET /v1/assets。',
  'usage: /hub approve <id> <approval>': '用法：/hub approve <id> <approval>',
  'usage: /hub reject <id> <approval>': '用法：/hub reject <id> <approval>',
  '{task} has no approval {approval}': '{task} 没有审批 {approval}',
  '✓ approved {approval} for {task} (input {input})':
    '✓ 已批准 {task} 的 {approval}（输入 {input}）',
  '✓ rejected {approval} for {task} (input {input})':
    '✓ 已拒绝 {task} 的 {approval}（输入 {input}）',
  'where you are signed in': '当前登录位置',
  'every command': '全部命令',
  'sign in; the password is asked on a masked card unless this window already has it':
    '登录；密码在一张遮住的卡片上询问，除非这个窗口已经有了',
  'revoke the token at the server, then forget it':
    '先在服务器上撤销 token，再在本地忘掉它',
  'what the server can do': '服务器能做什么',
  'hand it work with this file, follow it, save the results (module-execute takes the flow input JSON instead of a file)':
    '把这个文件交给它做，跟随，并保存结果（module-execute 要的是流程输入 JSON，不是文件）',
  'tasks this window handed over, each with its phase. "seen to N" is the last event number shown for that task, not how many tasks /hub refresh counted':
    '这个窗口交出的任务，各自的阶段。「事件已看到 N」是该任务已显示的最后一个事件号，不是 /hub refresh 数到的任务数',
  'show a task and follow it until it ends': '显示一个任务并跟随到结束',
  'answer what a task is waiting on (text, key=value or JSON)':
    '回答任务正在等的内容（文字、key=value 或 JSON）',
  'save a delivered task’s results again': '再次保存已交付任务的结果',
  'how many work tasks the pages just read (at most 20; tool and index tasks are not in that number) and how many capability packs. Not the /hub tasks list':
    '页面刚读到多少工作任务（最多 20 个；工具任务和索引任务不算在内）以及多少能力包。不是 /hub tasks 的列表',
  'approve an action a task waits on (reject: /hub reject …)':
    '批准任务正在等的一个动作（拒绝：/hub reject …）',
  'open approvals you may decide, each with its /hub approve line':
    '你可以决定的待处理审批，每条都带 /hub approve',
  'recent audit rows (needs admin.manage; there is no browser page)':
    '最近的审计记录（需要 admin.manage；没有浏览器页面）',
  'skill packs and module assets the server lists (no browser page)':
    '服务器列出的技能包和模块资产（没有浏览器页面）',
  'check an unknown operation; without op the server only explains':
    '核对一个未知操作；不写 op 时服务器只作说明',
  'the server’s tools the model can use, read again':
    '重新读取模型可以使用的服务器工具',
  'record server tool calls from now. A non-empty record that was not pushed stays until /hub trial start --force':
    '从现在起记录服务器工具调用。还没推送的非空记录会留着，直到 /hub trial start --force',
  'submit a skill pack. skillpack.json outputs are required; the trial call record may be empty. --outputs a,b names trial files and defaults to that list':
    '提交技能包。skillpack.json 的 outputs 是必需的；试验调用记录可以是空的。--outputs a,b 指定试验文件，缺省时用这份列表',
  'the skill packs on the server': '服务器上的技能包',
  'run a skill pack on the server and follow it (--file <path> attaches)':
    '在服务器上运行技能包并跟随（--file <path> 附加文件）',
  'the bots you can see; yours with their runs and new results':
    '你能看到的机器人；你自己的会带上运行记录和新结果',
  'a bot that runs a skill pack on a schedule (--from, --inputs, --file, --name)':
    '按时间表运行技能包的机器人（--from、--inputs、--file、--name）',
  'a bot that runs a skill pack when a connector reports the event':
    '连接器报告事件时运行技能包的机器人',
  'approve someone else’s bot and its trigger': '批准别人的机器人和它的触发器',
  'turn your approved bot on or off': '开启或停止你已批准的机器人',
  'its runs and what each delivered to Circle':
    '它的运行记录，以及每次交给 Circle 的内容',
  'approve skill pack {id}': '批准技能包 {id}',
  'skill pack {id}': '技能包 {id}',
  ' ({title})': '（{title}）',
  'hub tool {remote}{title}: {description}{write}{tail}':
    '枢纽工具 {remote}{title}：{description}{write}{tail}',
  ' It changes something, so it asks first.': ' 它会改动东西，所以先询问。',
  ' It runs as a hub task and is waited for in the background.':
    ' 它作为枢纽任务运行，并在后台等待。',
  ' Its response is also saved as it came under .circle/hub-returns/ in the workspace (savedAs), to cite or check against instead of retyping it.':
    ' 它的响应也按原样保存在工作区的 .circle/hub-returns/（savedAs），用来引用或核对，而不必重打。',
  'hub {remote} {task}': '枢纽 {remote} {task}',
  '    {name} · sha256 {hash}': '    {name} · sha256 {hash}',
  ' · not signed in': ' · 未登录',
  '/hub help lists the commands': '/hub help 列出命令',
  'unknown: /hub {verb}\n{usage}': '未知：/hub {verb}\n{usage}',
  '/{name} failed: {message}': '/{name} 失败：{message}',
  'Work with a hub: /hub [help | login | logout | packs | submit | tasks | task | respond | get | refresh | review | audit | modules | tools | skill | bot]':
    '使用枢纽：/hub [help | login | logout | packs | submit | tasks | task | respond | get | refresh | review | audit | modules | tools | skill | bot]',
  'task_id is required': '需要 task_id',
  'pack is required': '需要 pack',
  'input is an object of task input fields': 'input 是任务输入字段组成的对象',
  'module-execute needs the flow input object':
    'module-execute 需要流程输入对象',
  'file is required': '需要 file',
  'hub {task}': '枢纽 {task}',
  'folder is required': '需要 folder',
  'name, version and at least one file are required':
    '需要 name、version，以及至少一个文件',
  'metadata is an object': 'metadata 是一个对象',
  'each file needs a path in the workspace': '每个文件都需要工作区里的路径',
  '{path}: role is required': '{path}：需要 role',
  '{path} is outside the workspace': '{path} 在工作区之外',
  'someone else approves the asset; the reply names approvalTaskId when the server sends one, and /hub review lists open approvals. Then hub_source_artifact_status gives the sourceArtifactId':
    '需要别人批准这个资产；服务器送出时，回复里会有 approvalTaskId，/hub review 列出待处理的审批。然后 hub_source_artifact_status 给出 sourceArtifactId',
  'asset_id is required': '需要 asset_id',
  'id must start with knr_ (knowledge record), evd_ (evidence) or art_ (artifact): {id}':
    'id 必须以 knr_（知识记录）、evd_（证据）或 art_（产物）开头：{id}',
  'no workspace to save the content into': '没有可保存内容的工作区',
  'save_as {path} is outside the workspace': 'save_as {path} 在工作区之外',
  "the bytes (sha256 {actual}) do not match the server's SHA-256 ({expected}); not saved":
    '字节（sha256 {actual}）与服务器的 SHA-256（{expected}）不一致，未保存',
  'sign in. With no user, the saved one is used or you are asked. The password is a masked card':
    '登录。不写用户时用已保存的，或询问你。密码在一张遮住的卡片上',
  'answer a clarification or a repair. An approval is /hub approve, not this':
    '回答澄清或修复。审批用 /hub approve，不是这条',
  'approvals waiting for you, and the command that decides each':
    '等你处理的审批，以及决定每一条的命令',
  'one approval and its content, before you approve it':
    '一条审批和它的正文，批准之前先看',
  'approve one. With no ids, list them. A governance request is /hub approve <id>':
    '批准一条。不写 id 就列出。治理申请是 /hub approve <id>',
  'decline one and say why. A governance request is /hub reject <id> <reason>':
    '拒绝一条并写明原因。治理申请是 /hub reject <id> <reason>',
  'the same list as /hub inbox': '和 /hub inbox 是同一份列表',
  'recent audit rows (needs admin.manage). --format json|csv exports when the server can':
    '最近的审计行（需要 admin.manage）。服务器支持时 --format json|csv 可导出',
  '{code}: {said}': '{code}：{said}',
  ' It changes something on the server.': ' 它会在服务器上改动东西。',
  'writes on the server': '在服务器上写入',
  'usage: /hub login [url] [user]': '用法：/hub login [url] [user]',
  'User on {url}': '{url} 上的用户',
  'this window cannot ask; /hub login [url] <user>':
    '这个窗口不能询问；/hub login [url] <user>',
  '{task} is waiting for a decision, not a text answer ({request}). Someone else runs /hub approve {task} {request}. /hub inbox lists what is waiting for you.':
    '{task} 在等一个决定，不是文字回答（{request}）。别人运行 /hub approve {task} {request}。/hub inbox 列出等你处理的。',
  '{task} is not waiting for a text answer ({kind}). /hub inbox lists approvals; /hub approve records one. Only a clarification or a repair takes /hub respond.':
    '{task} 不是在等文字回答（{kind}）。/hub inbox 列出审批；/hub approve 记下一条。只有澄清或修复才用 /hub respond。',
  '{task} is not waiting for an answer. /hub task {task} shows its phase; an approval is /hub approve, and /hub inbox lists those.':
    '{task} 没有在等回答。/hub task {task} 显示阶段；审批用 /hub approve，/hub inbox 列出那些。',
  'usage: /hub audit [--format json|csv] [--timezone <tz>] [--action <action>] [--principal <id>] [--since <time>] [--until <time>]':
    '用法：/hub audit [--format json|csv] [--timezone <tz>] [--action <action>] [--principal <id>] [--since <time>] [--until <time>]',
  'No audit rows in that export.': '这次导出没有审计行。',
  'audit export {format} · {n} row(s){cut}': '审计导出 {format} · {n} 行{cut}',
  ' · truncated': ' · 已截断',
  'this server has no audit export. /hub audit lists the recent rows.':
    '这台服务器没有审计导出。/hub audit 列出最近的行。',
  'Nothing is waiting for you. /hub inbox lists what you can approve.':
    '没有等你处理的。/hub inbox 列出你可以批准的。',
  '  {n}. governance {id} · {title}\n    /hub show {id}\n    /hub approve {id}\n    /hub reject {id} <reason>':
    '  {n}. 治理 {id} · {title}\n    /hub show {id}\n    /hub approve {id}\n    /hub reject {id} <reason>',
  '  {n}. {kind} {task} · {approval} · {title}\n    /hub show {task}\n    /hub approve {task} {approval}\n    /hub reject {task} {approval} <reason>':
    '  {n}. {kind} {task} · {approval} · {title}\n    /hub show {task}\n    /hub approve {task} {approval}\n    /hub reject {task} {approval} <reason>',
  'usage: /hub show <id>': '用法：/hub show <id>',
  '  governance {id} · {status} · {title}': '  治理 {id} · {status} · {title}',
  '  declined: {reason}': '  已拒绝：{reason}',
  '  /hub approve {id}\n  /hub reject {id} <reason>':
    '  /hub approve {id}\n  /hub reject {id} <reason>',
  '  {approval} · {name} · {target}': '  {approval} · {name} · {target}',
  '  result {status}': '  结果 {status}',
  '{head}… ({n} more characters)': '{head}…（还有 {n} 个字符）',
  '{n} bytes ({type}); no workspace to save them':
    '{n} 字节（{type}）；没有可保存的工作区',
  'saved {n} bytes ({type}) as {path}': '已把 {n} 字节（{type}）存为 {path}',
  'usage: /hub approve <id> [approval]': '用法：/hub approve <id> [approval]',
  'usage: /hub reject <id> <approval> <reason>':
    '用法：/hub reject <id> <approval> <reason>',
  'a rejection needs a reason: /hub reject {task} {approval} <reason>':
    '拒绝需要原因：/hub reject {task} {approval} <reason>',
  ' · {reason}': ' · {reason}',
  'a rejection needs a reason: /hub reject {id} <reason>':
    '拒绝需要原因：/hub reject {id} <reason>',
  'Work with a hub: /hub [help | login | logout | packs | submit | tasks | task | respond | get | refresh | request | inbox | show | approve | reject | review | search | roles | audit | modules | tools | skill | bot]':
    '使用枢纽：/hub [help | login | logout | packs | submit | tasks | task | respond | get | refresh | request | inbox | show | approve | reject | review | search | roles | audit | modules | tools | skill | bot]',
  'sign in through the server single sign-on. Paste the address the browser opened when this window cannot catch it':
    '通过服务器的单点登录。这个窗口接不到浏览器时，粘贴浏览器打开的地址',
  'submit a file or text for role approval (--file or --text, --summary, --role name[:count])':
    '提交文件或文本，按角色审批（--file 或 --text，--summary，--role 角色[:人数]）',
  'find approved knowledge and the snapshot id of each hit':
    '查找已批准的知识，以及每条命中的快照 id',
  'propose an approval role: manager, security, dpo, legal, finance, hr or it':
    '提议一个审批角色：manager、security、dpo、legal、finance、hr 或 it',
  'the manifest has {n} error(s) ({code}):\n{lines}':
    '清单有 {n} 个错误（{code}）：\n{lines}',
  'undeclared tool {name}': '未声明的工具 {name}',
  'missing tool {name}': '缺少的工具 {name}',
  'you cannot approve your own request ({code}). Someone holding the role decides it.':
    '不能批准自己的请求（{code}）。由持有该角色的人来决定。',
  'a dependency is not approved yet ({code}). {detail}':
    '依赖尚未批准（{code}）。{detail}',
  'Approve that dependency first.': '请先批准那个依赖。',
  'This sign-in is missing its code or state.': '这次登录缺少 code 或 state。',
  'Signed in. You can close this page.': '已登录。可以关闭这个页面。',
  'this server has no single sign-on. /hub login [url] [user] asks for a password.':
    '这台服务器没有单点登录。/hub login [url] [user] 会询问密码。',
  'the server did not start single sign-on': '服务器没有开始单点登录',
  'Open this address to sign in:\n{url}': '打开这个地址登录：\n{url}',
  'Paste the address the browser opened': '粘贴浏览器打开的地址',
  'this window cannot ask; open the address from /hub login --sso again':
    '这个窗口不能询问；请打开地址后重新 /hub login --sso',
  'the sign-in address needs code and state': '登录地址需要 code 和 state',
  'the sign-in state does not match. /hub login --sso again.':
    '登录 state 不一致。请重新 /hub login --sso。',
  'usage: /hub login --sso [url]': '用法：/hub login --sso [url]',
  'usage: /hub submit hub-task [input-json] [--again]':
    '用法：/hub submit hub-task [input-json] [--again]',
  'hub-task takes its input as a JSON object':
    'hub-task 的输入必须是一个 JSON 对象',
  'usage: /hub request <title> (--file <path> | --text <text>) [--summary <text>] [--role <role>[:count]]…':
    '用法：/hub request <title> (--file <path> | --text <text>) [--summary <text>] [--role <role>[:count]]…',
  'an approval role is manager, security, dpo, legal, finance, hr or it':
    '审批角色是 manager、security、dpo、legal、finance、hr 或 it',
  'a role count is a whole number from 1 to 20': '角色人数是 1 到 20 的整数',
  'each approval role is named once': '每个审批角色只写一次',
  'the approval text is empty': '审批文本是空的',
  'the file must stay inside the workspace: {path}':
    '文件必须留在工作区里：{path}',
  'the approval file is empty': '审批文件是空的',
  'use a file name without slashes or control characters':
    '文件名不要包含斜杠或控制字符',
  'this server has no general approval. /hub submit <pack> <file> still hands over a task.':
    '这台服务器没有通用审批。/hub submit <pack> <file> 仍然可以提交任务。',
  '✓ submitted {id} · {status} · task {task}\n  /hub show {id}':
    '✓ 已提交 {id} · {status} · 任务 {task}\n  /hub show {id}',
  'usage: /hub search <text>': '用法：/hub search <text>',
  'this server has no knowledge search': '这台服务器没有知识检索',
  'No knowledge matched. A miss does not mean it is absent. Approved text is found by its snapshot id.':
    '没有匹配的知识。没有命中并不表示它不存在。已批准的文本按其快照 id 被找到。',
  'no snapshot': '无快照',
  '  {id} · snapshot {snapshot} · {label}':
    '  {id} · 快照 {snapshot} · {label}',
  'usage: /hub roles <principal> <role> — manager, security, dpo, legal, finance, hr, it':
    '用法：/hub roles <principal> <role> — manager、security、dpo、legal、finance、hr、it',
  'a principal id starts with prn_': '主体 id 以 prn_ 开头',
  'this server has no approval roles': '这台服务器没有审批角色',
  '✓ proposed {role} for {principal} · {id} · {status}':
    '✓ 已提议 {principal} 的 {role} · {id} · {status}',
  '  record {record} · snapshot {snapshot}':
    '  记录 {record} · 快照 {snapshot}',
  '✓ rejected {approval} for {task} (input {input}){because}':
    '✓ 已拒绝 {task} 的 {approval}（输入 {input}）{because}',
  '✓ approved {id} · {status}': '✓ 已批准 {id} · {status}',
  '✓ rejected {id} · {status}{because}': '✓ 已拒绝 {id} · {status}{because}',
};

const C_LOCALE = /^(c|posix)(\.|$)/i;

// LANGUAGE, then LC_ALL, then LC_MESSAGES, then LANG. Skip C and POSIX.
// The first real tag decides: zh* is Simplified Chinese, anything else English.
export function hubLocaleChinese(): boolean {
  const ordered = [
    process.env.LANGUAGE?.split(':')[0],
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG,
  ];
  for (const raw of ordered) {
    if (!raw || C_LOCALE.test(raw.trim())) continue;
    const tag = raw.trim().split('.')[0]!.replaceAll('_', '-').toLowerCase();
    return tag.startsWith('zh');
  }
  return false;
}

export function hubText(
  english: string,
  vars: Record<string, string | number> = {},
): string {
  const template =
    hubLocaleChinese() && Object.prototype.hasOwnProperty.call(HUB_ZH, english)
      ? HUB_ZH[english]!
      : english;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
}

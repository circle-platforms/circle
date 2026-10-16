// Simplified Chinese for the interface words in the conversation files. English is the key.
export const conversation: Record<string, string> = {
  'stopping work before deletion…': '停止任务后删除中…',
  'open in another terminal; view only': '已在其他终端打开，仅可查看',
  'no model connected': '未连接模型',
  // the heading and the session actions
  'find in conversation': '在对话中查找',
  'session tree': '会话树',
  'session actions': '会话操作',
  rename: '重命名',
  fork: '分叉',
  clone: '克隆',
  'undo on screen': '撤销（仅界面）',
  'redo on screen': '重做（仅界面）',
  'compact context': '压缩上下文',
  export: '导出',
  'share locally': '本地分享',
  // finding in the conversation
  'find text': '查找文本',
  'type to search': '输入以搜索',
  'next match': '下一个匹配',
  'close find': '关闭查找',
  // the transcript
  'what are we working on?': '我们要做什么？',
  'work without a project': '不在项目中工作',
  'what should we build in {name}?': '你想让我们在 {name} 中构建什么？',
  'search projects': '搜索项目',
  'no matching projects': '没有匹配的项目',
  'no project': '不选择项目',
  'choose a project': '选择项目',
  'Start with a message, a file, or a question about your project.':
    '从一条消息、一个文件或一个关于项目的问题开始。',
  you: '你',
  thinking: '思考',
  'thinking {time}': '思考 {time}',
  '✖ Interrupted': '✖ 已中断',
  'could not reach the endpoint': '无法连接端点',
  'cache N/A': '缓存不可用',
  'cost N/A': '费用 N/A',
  'local conversation paused · remote state unverified':
    '本地对话已暂停 · 远端状态未确认',
  'model returned an empty response': '模型返回了空响应',
  'model output limit reached; response incomplete':
    '模型达到输出上限，响应未完成',
  'model response ended without a complete finish signal':
    '模型响应缺少完整的结束信号',
  'model response was filtered': '模型响应被过滤',
  'model response paused before completion': '模型响应尚未完成便暂停',
  'model response ended with an unknown finish reason':
    '模型响应的结束原因未知',
  'model response stopped after repeating; response incomplete':
    '模型因重复输出而停止，响应未完成',
  // the plan and the queue
  'toggle plan': '展开或收起计划',
  'plan steps': '计划步骤',
  'plan completed · {n} steps': '计划已完成 · {n} 个步骤',
  '✖ the turn failed': '✖ 这一轮失败了',
  'title failed · {message}': '标题失败 · {message}',
  'archived conversation · read only': '已归档对话 · 只读',
  'restore conversation': '恢复对话',
  steering: '插话',
  'follow-up': '追加消息',
  'remove queued {kind}': '移除排队中的{kind}',
  'return queued messages to draft': '把排队的消息放回草稿',
  // the composer
  'input completions': '输入补全',
  message: '消息',
  'Ask anything, or describe a change…': '问任何问题，或描述一个改动…',
  'attach files': '附加文件',
  'pause conversation': '暂停对话',
  'resume conversation': '继续对话',
  'send message': '发送消息',
  '{name} is over 20 MB': '{name} 超过 20 MB',
  picture: '图片',
  'host request recorded; no process changed':
    '已记录宿主请求；没有改动任何进程',
  'background request recorded; no process was changed':
    '已记录后台运行请求；没有改动任何进程',
};

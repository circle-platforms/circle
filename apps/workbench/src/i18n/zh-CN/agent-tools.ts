export const agentTools: Record<string, string> = {
  'Search personal knowledge': '搜索个人知识',
  'Search local knowledge for clues; locked tasks require explicit addresses. No network or sync.':
    '搜索本机知识以查找线索；锁定任务须使用明确地址，不触发网络或同步。',
  'Read an immutable knowledge object': '读取指定版本的知识',
  'Read an object within an explicit local snapshot, with a bounded window and local verification observation.':
    '读取本机知识的指定版本，分段查看正文和验证记录。',
  'Propose a personal knowledge change': '提出个人知识变更',
  'Propose canonical revisions and byte chunks against expected_head. Inventories are generated locally. Every change needs person confirmation, including auto mode.':
    '对指定版本提出知识变更，每次均须本人确认，自动模式也不例外。',
  'Share knowledge with a team': '分享到团队…',
  'Unavailable until Sync to Hub and an authorized entry mapping are configured. Open sync settings to switch mode; this tool never changes it.':
    '需先在同步设置切换为“同步到 Hub”，并建立获授权的条目关联；此工具不会切换方式。',
  'Propose a personal memory change': '提出个人记忆变更',
  'Create, replace, enable, disable or delete personal memory against expected_head. Always requires person confirmation; credential and size checks run before persistence.':
    '按期望版本新增、编辑、启停或删除个人记忆。每次均须本人确认，保存前会检查凭据和大小。',

  'propose follow-up tasks': '建议后续任务',
  'proposed follow-up tasks': '已提出后续任务建议',
  'schedule agents': '调度子 Agent',
  'schedule read-only agents': '调度只读子 Agent',
  'agent progress': '子 Agent 进度',
  'cancel agent task': '取消子 Agent 任务',
  'retry agent task': '重试子 Agent 任务',
  'agent artifacts': '子 Agent 产物',
  'scheduled agents': '已调度子 Agent',
  'checked agent progress': '已查看子 Agent 进度',
  'updated agent scheduling': '已更新子 Agent 调度',
};

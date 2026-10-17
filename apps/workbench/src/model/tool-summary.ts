import type { Message, ToolCall } from './types';
import { locale, t, tn } from '../i18n/index.ts';

type EditOutcome = 'waiting' | 'running' | 'rejected' | 'failed' | 'done';

function editPhrase(
  outcome: EditOutcome,
  file: string | undefined,
  count: number,
) {
  if (file) {
    if (outcome === 'waiting') return t('waiting to edit {file}', { file });
    if (outcome === 'running') return t('editing {file}', { file });
    if (outcome === 'rejected')
      return t('rejected an edit to {file}', { file });
    if (outcome === 'failed') return t('failed to edit {file}', { file });
    return t('edited {file}', { file });
  }
  if (outcome === 'waiting')
    return tn(count, 'waiting to edit a file', 'waiting to edit {n} files');
  if (outcome === 'running')
    return tn(count, 'editing a file', 'editing {n} files');
  if (outcome === 'rejected')
    return tn(count, 'rejected an edit', 'rejected edits to {n} files');
  if (outcome === 'failed')
    return tn(count, 'failed to edit a file', 'failed to edit {n} files');
  return tn(count, 'edited a file', 'edited {n} files');
}

function editOutcome(tool: ToolCall): EditOutcome {
  if (tool.status === 'waiting') return 'waiting';
  if (tool.status === 'running' || tool.status === 'unknown') return 'running';
  if (
    tool.status === 'error' &&
    /user rejected this tool call/i.test(tool.output)
  )
    return 'rejected';
  if (tool.status === 'error') return 'failed';
  return 'done';
}

function editGroups(edits: ToolCall[]): [EditOutcome, ToolCall[]][] {
  const order: EditOutcome[] = [
    'waiting',
    'running',
    'rejected',
    'failed',
    'done',
  ];
  return order
    .map(
      (outcome) =>
        [outcome, edits.filter((tool) => editOutcome(tool) === outcome)] as [
          EditOutcome,
          ToolCall[],
        ],
    )
    .filter(([, group]) => group.length > 0);
}

function commandPhrase(outcome: EditOutcome, count: number) {
  if (outcome === 'waiting')
    return tn(count, 'waiting to run a command', 'waiting to run {n} commands');
  if (outcome === 'running')
    return tn(count, 'running a command', 'running {n} commands');
  if (outcome === 'rejected')
    return tn(count, 'rejected a command', 'rejected {n} commands');
  if (outcome === 'failed')
    return tn(count, 'failed to run a command', 'failed to run {n} commands');
  return tn(count, 'ran a command', 'ran {n} commands');
}

function listPhrase(outcome: EditOutcome, count: number) {
  if (outcome === 'waiting')
    return tn(
      count,
      'waiting to list a directory',
      'waiting to list {n} directories',
    );
  if (outcome === 'running')
    return tn(count, 'listing a directory', 'listing {n} directories');
  if (outcome === 'rejected')
    return tn(
      count,
      'rejected a directory listing',
      'rejected {n} directory listings',
    );
  if (outcome === 'failed')
    return tn(
      count,
      'failed to list a directory',
      'failed to list {n} directories',
    );
  return tn(count, 'listed a directory', 'listed {n} directories');
}

function readPhrase(
  outcome: EditOutcome,
  file: string | undefined,
  count: number,
) {
  if (file) {
    if (outcome === 'waiting') return t('waiting to read {file}', { file });
    if (outcome === 'running') return t('reading {file}', { file });
    if (outcome === 'rejected') return t('rejected reading {file}', { file });
    if (outcome === 'failed') return t('failed to read {file}', { file });
    return t('read {file}', { file });
  }
  if (outcome === 'waiting')
    return tn(count, 'waiting to read a file', 'waiting to read {n} files');
  if (outcome === 'running')
    return tn(count, 'reading a file', 'reading {n} files');
  if (outcome === 'rejected')
    return tn(count, 'rejected a file read', 'rejected {n} file reads');
  if (outcome === 'failed')
    return tn(count, 'failed to read a file', 'failed to read {n} files');
  return tn(count, 'read a file', 'read {n} files');
}

function globPhrase(outcome: EditOutcome, count: number) {
  if (outcome === 'waiting')
    return tn(
      count,
      'waiting to search files once',
      'waiting to search files {n} times',
    );
  if (outcome === 'running')
    return tn(count, 'searching files once', 'searching files {n} times');
  if (outcome === 'rejected')
    return tn(count, 'rejected a file search', 'rejected {n} file searches');
  if (outcome === 'failed')
    return tn(
      count,
      'failed to search files once',
      'failed to search files {n} times',
    );
  return tn(count, 'searched files once', 'searched files {n} times');
}

function grepPhrase(outcome: EditOutcome, count: number) {
  if (outcome === 'waiting')
    return tn(count, 'waiting to search once', 'waiting to search {n} times');
  if (outcome === 'running')
    return tn(count, 'searching once', 'searching {n} times');
  if (outcome === 'rejected')
    return tn(count, 'rejected a search', 'rejected {n} searches');
  if (outcome === 'failed')
    return tn(count, 'failed to search once', 'failed to search {n} times');
  return tn(count, 'searched once', 'searched {n} times');
}

function symbolPhrase(outcome: EditOutcome, count: number) {
  if (outcome === 'waiting')
    return tn(
      count,
      'waiting to look up a symbol',
      'waiting to look up {n} symbols',
    );
  if (outcome === 'running')
    return tn(count, 'looking up a symbol', 'looking up {n} symbols');
  if (outcome === 'rejected')
    return tn(count, 'rejected a symbol lookup', 'rejected {n} symbol lookups');
  if (outcome === 'failed')
    return tn(
      count,
      'failed to look up a symbol',
      'failed to look up {n} symbols',
    );
  return tn(count, 'looked up a symbol', 'looked up {n} symbols');
}

const READS = ['read_file'];
const EDITS = ['write_file', 'edit_file', 'apply_patch', 'delete'];
const WEB = ['webfetch', 'websearch'];
const AGENT_SCHEDULE = [
  'native_tasks_enqueue',
  'native_tasks_analyze',
  'native_tasks_adopt_proposal',
];
const AGENT_PROPOSE = ['native_tasks_propose'];
const AGENT_QUERY = [
  'native_tasks_list',
  'native_tasks_wait',
  'native_tasks_events',
  'native_tasks_artifacts',
];
const AGENT_CONTROL = ['native_tasks_cancel', 'native_tasks_retry'];
const name = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/**
 * What a run of tool calls did, in one line: `ran 2 commands, edited calc.py +1 −1`.
 * Lowercase, as the interface words are. A directory listing is not a search.
 */
export function toolSummary(rows: Message[]): {
  text: string;
  added: number;
  removed: number;
} {
  const allTools = rows.flatMap((row) => (row.tool ? [row.tool] : []));
  const tools = allTools.filter((tool) =>
    ['success', 'error', 'waiting', 'running'].includes(tool.status),
  );
  const completed = tools.filter((tool) => tool.status === 'success');
  const count = (names: string[]) =>
    tools.filter((tool) => names.includes(tool.name));
  const parts: string[] = [];
  for (const [outcome, group] of editGroups(count(['execute'])))
    parts.push(commandPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(READS))) {
    const files = [
      ...new Set(group.map((tool) => tool.filePath).filter(Boolean)),
    ] as string[];
    if (files.length === 1)
      parts.push(readPhrase(outcome, name(files[0]!), group.length));
    else if (group.length)
      parts.push(readPhrase(outcome, undefined, group.length));
  }
  for (const [outcome, group] of editGroups(count(['ls'])))
    parts.push(listPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(['glob'])))
    parts.push(globPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(['grep'])))
    parts.push(grepPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(['lsp'])))
    parts.push(symbolPhrase(outcome, group.length));
  const edits = count(EDITS);
  for (const [outcome, group] of editGroups(edits)) {
    const files = [
      ...new Set(group.map((tool) => tool.filePath).filter(Boolean)),
    ] as string[];
    if (files.length === 1)
      parts.push(editPhrase(outcome, name(files[0]!), group.length));
    else if (group.length)
      parts.push(editPhrase(outcome, undefined, files.length || group.length));
  }
  const agents = completed.filter((tool) => tool.name === 'task').length;
  if (agents) parts.push(tn(agents, 'ran a subagent', 'ran {n} subagents'));
  if (completed.some((tool) => AGENT_SCHEDULE.includes(tool.name)))
    parts.push(t('scheduled agents'));
  if (completed.some((tool) => AGENT_PROPOSE.includes(tool.name)))
    parts.push(t('proposed follow-up tasks'));
  if (completed.some((tool) => AGENT_QUERY.includes(tool.name)))
    parts.push(t('checked agent progress'));
  if (completed.some((tool) => AGENT_CONTROL.includes(tool.name)))
    parts.push(t('updated agent scheduling'));
  const web = completed.filter((tool) => WEB.includes(tool.name)).length;
  if (web) parts.push(tn(web, 'used the web once', 'used the web {n} times'));
  const known = [
    'execute',
    'task',
    'ls',
    'glob',
    'grep',
    'lsp',
    ...AGENT_SCHEDULE,
    ...AGENT_PROPOSE,
    ...AGENT_QUERY,
    ...AGENT_CONTROL,
    ...READS,
    ...EDITS,
    ...WEB,
  ];
  const outcomeTools = [
    'execute',
    'ls',
    'glob',
    'grep',
    'lsp',
    ...READS,
    ...EDITS,
  ];
  for (const status of ['waiting', 'running'] as const) {
    const pending = tools.filter(
      (tool) => tool.status === status && !outcomeTools.includes(tool.name),
    ).length;
    if (pending)
      parts.push(
        status === 'waiting'
          ? tn(
              pending,
              '{n} tool waiting for approval',
              '{n} tools waiting for approval',
            )
          : tn(pending, '{n} tool running', '{n} tools running'),
      );
  }
  const other = completed.filter((tool) => !known.includes(tool.name));
  const names = [...new Set(other.map((tool) => tool.name))];
  if (names.length && names.length <= 2)
    parts.push(t('used {tools}', { tools: names.join(', ') }));
  else if (other.length)
    parts.push(tn(other.length, 'used a tool', 'used {n} tools'));
  if (!parts.length && allTools.length) parts.push(t('tool results'));
  if (!parts.length && rows.some((row) => row.thinking))
    parts.push(t('thinking'));
  let added = 0;
  let removed = 0;
  for (const tool of edits)
    if (tool.diff && tool.status === 'success')
      for (const row of tool.diff.rows) {
        if (row.tone === 'added') added++;
        if (row.tone === 'removed') removed++;
      }
  return {
    text: parts.join(locale() === 'zh-CN' ? '，' : ', '),
    added,
    removed,
  };
}

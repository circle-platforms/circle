import { BUILTIN_TOOL_INFO } from './tool-info.ts';
import type { Message, ToolCall } from './types';
import { locale, t, tn } from '../i18n/index.ts';
import { isKnowledgeTool, knowledgeToolTitle } from './knowledge-tools.ts';

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
const JOBS = ['list_jobs', 'wait_jobs', 'stop_job', 'send_to_job'];
const PLAN_MODE = ['plan_enter', 'plan_exit'];
const name = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

type InternalKind =
  | 'plan'
  | 'browser'
  | 'terminal'
  | 'editor'
  | 'jobs'
  | 'question'
  | 'plan mode'
  | 'skill';

/** Circle's own tools by what they are for. A tool from elsewhere keeps its name. */
function internalKind(tool: string): InternalKind | undefined {
  if (tool === 'write_todos') return 'plan';
  if (tool.startsWith('browser_')) return 'browser';
  if (tool.startsWith('terminal_')) return 'terminal';
  if (tool.startsWith('editor_')) return 'editor';
  if (JOBS.includes(tool)) return 'jobs';
  if (tool === 'question') return 'question';
  if (PLAN_MODE.includes(tool)) return 'plan mode';
  if (tool === 'skill') return 'skill';
  return undefined;
}

/** A browser's or a terminal's calls differ by what each one does, so a row says that. */
function actionTitle(tool: string): string | undefined {
  const described = (
    BUILTIN_TOOL_INFO as readonly { name: string; description: string }[]
  ).find((info) => info.name === tool)?.description;
  return described && described[0]!.toLowerCase() + described.slice(1);
}

/** What a row in the list of calls says for one of Circle's own tools. */
export function internalToolTitle(tool: string): string | undefined {
  switch (internalKind(tool)) {
    case 'plan':
      return t('update plan');
    case 'browser':
      return actionTitle(tool) ?? t('browser');
    case 'terminal':
      return actionTitle(tool) ?? t('terminal');
    case 'editor':
      return actionTitle(tool) ?? t('editor');
    case 'jobs':
      return t('background jobs');
    case 'question':
      return t('ask a question');
    case 'plan mode':
      return t('plan mode');
    case 'skill':
      return t('load a skill');
    default:
      return undefined;
  }
}

function internalPhrase(kind: InternalKind): string {
  if (kind === 'browser') return t('used the browser');
  if (kind === 'terminal') return t('used the terminal');
  if (kind === 'editor') return t('used the editor');
  if (kind === 'jobs') return t('checked background jobs');
  if (kind === 'question') return t('asked a question');
  if (kind === 'plan mode') return t('changed plan mode');
  if (kind === 'skill') return t('loaded a skill');
  return t('updated the plan');
}

const firstLine = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim().split('\n')[0]
    : undefined;

/** One finished call says what it did, not that a call happened. */
function singleCallLine(tool: ToolCall): string | undefined {
  const outcome = editOutcome(tool);
  if (tool.name === 'execute') {
    const description = firstLine(tool.input.description);
    const command = firstLine(tool.input.command);
    const what = description ?? (command && `$ ${command}`);
    if (!what) return undefined;
    if (tool.status === 'success') return what;
    return outcome === 'failed' ? t('failed: {what}', { what }) : undefined;
  }
  if (tool.status !== 'success') return undefined;
  const query = firstLine(tool.input.pattern ?? tool.input.query);
  if (tool.name === 'grep' && query) return t('searched “{query}”', { query });
  if (tool.name === 'glob' && query)
    return t('searched files “{query}”', { query });
  const path = firstLine(tool.input.path);
  if (tool.name === 'ls' && path) return t('listed {path}', { path });
  return undefined;
}

/**
 * What a run of tool calls did, in one line: `ran 2 commands, edited calc.py +1 −1`.
 * Lowercase, as the interface words are. A directory listing is not a search.
 */
/** Count patch targets from the prepared tool input, including move destinations. */
function editPaths(tool: NonNullable<Message['tool']>): string[] {
  if (tool.name === 'apply_patch')
    return [
      ...String(tool.input.patchText ?? '').matchAll(
        /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
      ),
    ].map((match) => match[1]!.trim());
  return tool.filePath ? [tool.filePath] : [];
}

export function toolSummary(rows: Message[]): {
  text: string;
  /** The words of the line in order, failures first so that a narrow row still shows them. */
  segments: { text: string; failed?: boolean }[];
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
  const failures = new Set<string>();
  const add = (outcome: EditOutcome, phrase: string) => {
    parts.push(phrase);
    if (outcome === 'failed') failures.add(phrase);
  };
  for (const [outcome, group] of editGroups(count(['execute'])))
    add(outcome, commandPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(READS))) {
    const files = [
      ...new Set(group.map((tool) => tool.filePath).filter(Boolean)),
    ] as string[];
    if (files.length === 1)
      add(outcome, readPhrase(outcome, name(files[0]!), group.length));
    else if (group.length)
      add(outcome, readPhrase(outcome, undefined, group.length));
  }
  for (const [outcome, group] of editGroups(count(['ls'])))
    add(outcome, listPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(['glob'])))
    add(outcome, globPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(['grep'])))
    add(outcome, grepPhrase(outcome, group.length));
  for (const [outcome, group] of editGroups(count(['lsp'])))
    add(outcome, symbolPhrase(outcome, group.length));
  const edits = count(EDITS);
  for (const [outcome, group] of editGroups(edits)) {
    const files = [...new Set(group.flatMap(editPaths))] as string[];
    if (files.length === 1 || (files.length <= 3 && outcome !== 'rejected'))
      add(
        outcome,
        editPhrase(
          outcome,
          files.map(name).join(locale() === 'zh-CN' ? '、' : ', '),
          group.length,
        ),
      );
    else if (group.length)
      add(
        outcome,
        editPhrase(outcome, undefined, files.length || group.length),
      );
  }
  const agents = completed.filter((tool) => tool.name === 'task').length;
  if (agents) parts.push(tn(agents, 'ran a subagent', 'ran {n} subagents'));
  const agentsAtWork = tools.filter(
    (tool) => tool.name === 'task' && tool.status === 'running',
  ).length;
  if (agentsAtWork)
    parts.push(tn(agentsAtWork, 'running a subagent', 'running {n} subagents'));
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
      (tool) =>
        tool.status === status &&
        !outcomeTools.includes(tool.name) &&
        !(status === 'running' && tool.name === 'task'),
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
  const other = completed.filter(
    (tool) => !known.includes(tool.name) && !internalKind(tool.name),
  );
  const kinds = [
    ...new Set(completed.flatMap((tool) => internalKind(tool.name) ?? [])),
  ];
  // The plan shows in the overview: it only gets a word when nothing else happened.
  for (const kind of kinds)
    if (kind !== 'plan') parts.push(internalPhrase(kind));
  // A knowledge call goes by its card title; other tools keep their own names.
  const names = [
    ...new Set(
      other.map((tool) =>
        isKnowledgeTool(tool.name) ? knowledgeToolTitle(tool.name) : tool.name,
      ),
    ),
  ];
  if (names.length && names.length <= 2)
    parts.push(t('used {tools}', { tools: names.join(', ') }));
  else if (other.length)
    parts.push(tn(other.length, 'used a tool', 'used {n} tools'));
  if (!parts.length && kinds.includes('plan'))
    parts.push(internalPhrase('plan'));
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
  const only = allTools.length === 1 ? singleCallLine(allTools[0]!) : undefined;
  const segments = only
    ? [
        {
          text: only,
          ...(editOutcome(allTools[0]!) === 'failed' ? { failed: true } : {}),
        },
      ]
    : [
        ...parts
          .filter((text) => failures.has(text))
          .map((text) => ({ text, failed: true })),
        ...parts
          .filter((text) => !failures.has(text))
          .map((text) => ({ text })),
      ];
  return {
    text: segments
      .map((part) => part.text)
      .join(locale() === 'zh-CN' ? '，' : ', '),
    segments,
    added,
    removed,
  };
}

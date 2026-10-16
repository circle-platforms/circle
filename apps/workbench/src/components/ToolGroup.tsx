import { type ReactNode } from 'react';
import { useSessionDisclosure } from '../model/presentation';
import { Brain, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import type { Message, Session } from '../model/types';
import { TurnClock } from './TurnClock';
import { ToolMessage } from './ToolMessage';
import { locale, t, tn } from '../i18n';

const READS = ['read_file'];
const SEARCHES = ['ls', 'glob', 'grep', 'lsp'];
const EDITS = ['write_file', 'edit_file', 'apply_patch', 'delete'];
const WEB = ['webfetch', 'websearch'];
const AGENT_SCHEDULE = ['native_tasks_enqueue', 'native_tasks_analyze'];
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
 * Lowercase, as the interface words are.
 */
export function toolSummary(rows: Message[]): {
  text: string;
  added: number;
  removed: number;
} {
  const tools = rows.flatMap((row) => (row.tool ? [row.tool] : []));
  const pending = tools.filter((tool) => tool.status === 'waiting').length;
  const running = tools.filter((tool) => tool.status === 'running').length;
  if (pending || running)
    return {
      text: [
        pending
          ? tn(
              pending,
              '{n} tool waiting for approval',
              '{n} tools waiting for approval',
            )
          : '',
        running ? tn(running, '{n} tool running', '{n} tools running') : '',
      ]
        .filter(Boolean)
        .join(' · '),
      added: 0,
      removed: 0,
    };
  const completed = tools.filter((tool) => tool.status === 'success');
  if (tools.length && !completed.length)
    return { text: t('tool results'), added: 0, removed: 0 };
  const count = (names: string[]) =>
    completed.filter((tool) => names.includes(tool.name));
  const parts: string[] = [];
  const commands = count(['execute']).length;
  if (commands) parts.push(tn(commands, 'ran a command', 'ran {n} commands'));
  const reads = count(READS);
  if (reads.length === 1 && reads[0]!.filePath)
    parts.push(t('read {file}', { file: name(reads[0]!.filePath) }));
  else if (reads.length)
    parts.push(tn(reads.length, 'read a file', 'read {n} files'));
  const searches = count(SEARCHES).length;
  if (searches) parts.push(tn(searches, 'searched once', 'searched {n} times'));
  const edits = count(EDITS);
  const files = [
    ...new Set(edits.map((tool) => tool.filePath).filter(Boolean)),
  ] as string[];
  if (files.length === 1)
    parts.push(t('edited {file}', { file: name(files[0]!) }));
  else if (edits.length)
    parts.push(
      tn(files.length || edits.length, 'edited a file', 'edited {n} files'),
    );
  const agents = count(['task']).length;
  if (agents) parts.push(tn(agents, 'ran a subagent', 'ran {n} subagents'));
  const scheduled = count(AGENT_SCHEDULE).length;
  if (scheduled) parts.push(t('scheduled agents'));
  if (count(AGENT_QUERY).length) parts.push(t('checked agent progress'));
  if (count(AGENT_CONTROL).length) parts.push(t('updated agent scheduling'));
  const web = count(WEB).length;
  if (web) parts.push(tn(web, 'used the web once', 'used the web {n} times'));
  const known = [
    'execute',
    'task',
    ...AGENT_SCHEDULE,
    ...AGENT_QUERY,
    ...AGENT_CONTROL,
    ...READS,
    ...SEARCHES,
    ...EDITS,
    ...WEB,
  ];
  // Other tools by name while there are few of them: `used plan_exit`.
  const other = completed.filter((tool) => !known.includes(tool.name));
  const names = [...new Set(other.map((tool) => tool.name))];
  if (names.length && names.length <= 2)
    parts.push(t('used {tools}', { tools: names.join(', ') }));
  else if (other.length)
    parts.push(tn(other.length, 'used a tool', 'used {n} tools'));
  // Only thinking so far: the line says so.
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

/**
 * Tool calls between two messages, folded to one line as Claude shows them; a click opens
 * the calls. While one runs the line names it, and a request that waits for you (the
 * children) shows under the line whether it is open or not.
 */
export function ToolGroup({
  rows,
  expanded,
  onFile,
  onAgent,
  turn,
  children,
}: {
  rows: Message[];
  expanded: boolean;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
  /** The turn under way, when these are its latest tools: its clock goes on their row. */
  turn?: NonNullable<Session['turn']>;
  children?: ReactNode;
}) {
  const tools = rows.flatMap((row) => (row.tool ? [row.tool] : []));
  // A call with no result in an old session stays 'unknown'; only these are live.
  const busy = tools.some((tool) =>
    ['running', 'waiting'].includes(tool.status),
  );
  const failed = tools.filter((tool) => tool.status === 'error').length;
  const cancelled = tools.filter(
    (tool) => String(tool.status) === 'cancelled',
  ).length;
  const rejected = tools.filter(
    (tool) => String(tool.status) === 'rejected',
  ).length;
  const [open, setOpen] = useSessionDisclosure(
    'group:' + rows[0]?.id,
    expanded,
  );
  const summary = toolSummary(rows);
  const running = tools.find((tool) => tool.status === 'running');
  return (
    <div className="tool-group" data-busy={busy || undefined}>
      <button
        className="tool-summary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {(busy || turn) && <LoaderCircle size={13} className="spin" />}
        <span>{summary.text}</span>
        {(summary.added > 0 || summary.removed > 0) && (
          <span className="diff-count">
            <span className="added">+{summary.added}</span>
            <span className="removed">−{summary.removed}</span>
          </span>
        )}
        {failed > 0 && (
          <span className="failed">
            {tn(failed, '{n} failed', '{n} failed')}
          </span>
        )}
        {cancelled > 0 && (
          <span>{tn(cancelled, '{n} cancelled', '{n} cancelled')}</span>
        )}
        {rejected > 0 && (
          <span>{tn(rejected, '{n} rejected', '{n} rejected')}</span>
        )}
        {running && !open && (
          <code className="tool-running">
            {String(
              running.input.command ??
                running.input.file_path ??
                running.input.description ??
                '',
            )}
          </code>
        )}
        {turn && <TurnClock turn={turn} />}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="tool-group-calls">
          {rows.map((row) =>
            row.tool ? (
              <div key={row.id} data-message-id={row.id}>
                <ToolMessage
                  tool={row.tool}
                  expanded={expanded}
                  onAgent={onAgent}
                  onFile={onFile}
                />
              </div>
            ) : row.thinking ? (
              <GroupThinking key={row.id} row={row} />
            ) : null,
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function GroupThinking({ row }: { row: Message }) {
  const [open, setOpen] = useSessionDisclosure('thinking:' + row.id);
  return (
    <details
      data-message-id={row.id}
      className="thinking group-thinking"
      open={open}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen(!open);
        }}
      >
        <Brain size={13} />
        <span>{t('thinking')}</span>
        <span className="thinking-preview">
          {row.thinking?.trim().split('\n')[0]?.slice(0, 120)}
        </span>
      </summary>
      <p>{row.thinking}</p>
    </details>
  );
}

/** The turn under way before its first tool: Circle's turning ring and the clock. */
export function TurnRow({ turn }: { turn: NonNullable<Session['turn']> }) {
  return (
    <div className="tool-group" data-busy>
      <div className="tool-summary">
        <span className="turn-ring" />
        <TurnClock turn={turn} />
      </div>
    </div>
  );
}

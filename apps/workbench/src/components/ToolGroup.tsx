import { type ReactNode } from 'react';
import { useSessionDisclosure } from '../model/presentation';
import { Brain, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import type { Message, Session } from '../model/types';
import { toolSummary } from '../model/tool-summary';
import { TurnClock } from './TurnClock';
import { ToolMessage } from './ToolMessage';
import { t, tn } from '../i18n';

export { toolSummary };

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
  // These lines already say rejected or failed. The badge is for other tools.
  const failed = tools.filter(
    (tool) =>
      tool.status === 'error' &&
      ![
        'write_file',
        'edit_file',
        'apply_patch',
        'delete',
        'execute',
        'ls',
        'read_file',
        'glob',
        'grep',
        'lsp',
      ].includes(tool.name),
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

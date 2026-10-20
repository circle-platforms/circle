import { useId, type ReactNode } from 'react';
import { useSessionDisclosure } from '../model/presentation';
import { Brain, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import type { Message, Session } from '../model/types';
import { toolSummary } from '../model/tool-summary';
import { TurnClock } from './TurnClock';
import { ToolMessage } from './ToolMessage';
import { ImageThumb } from './ImageThumb';
import { t, tn } from '../i18n';
import '../features/conversation-requests.css';

export { toolSummary };

/**
 * Tool calls between two messages, folded to one line as Claude shows them; a click opens
 * the calls. While one runs the line names it, and a request that waits for you (the
 * children) shows under the line whether it is open or not.
 */
export function ToolGroup({
  rows,
  ownerSessionId,
  expanded,
  onFile,
  onAgent,
  turn,
  children,
}: {
  rows: Message[];
  ownerSessionId?: string;
  expanded: boolean;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
  /** The turn under way, when these are its latest tools: its clock goes on their row. */
  turn?: NonNullable<Session['turn']>;
  children?: ReactNode;
}) {
  const tools = rows.flatMap((row) => (row.tool ? [row.tool] : []));
  // A call with no result in an old session stays 'unknown'; only these are live.
  const runningTool = tools.some((tool) => tool.status === 'running');
  const waiting = tools.some((tool) => tool.status === 'waiting');
  const busy = runningTool || waiting;
  const detailsId = useId();
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
  const cancelled = tools.filter((tool) => tool.status === 'cancelled').length;
  const rejected = tools.filter((tool) => tool.status === 'rejected').length;
  const [open, setOpen] = useSessionDisclosure(
    'group:' + rows[0]?.id,
    expanded,
  );
  const summary = toolSummary(rows);
  const running = tools.find((tool) => tool.status === 'running');
  // A picture a tool brought back, such as the browser's screenshot, shows under the line.
  const shots = rows.flatMap((row) =>
    (row.attachments ?? []).filter((file) => file.kind === 'image'),
  );
  return (
    <div
      className="tool-group"
      data-busy={busy || undefined}
      data-waiting={waiting || undefined}
    >
      <button
        className="tool-summary"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen(!open)}
      >
        {waiting ? (
          <i className="attention-dot" aria-label={t('waiting for you')} />
        ) : runningTool || turn ? (
          <LoaderCircle size={13} className="spin" />
        ) : null}
        <span className="tool-summary-text">{summary.text}</span>
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
      {shots.length > 0 && (
        <div className="tool-shots">
          {shots.map((shot) => (
            <ImageThumb key={shot.id} attachment={shot} />
          ))}
        </div>
      )}
      {open && (
        <div id={detailsId} className="tool-group-calls">
          {rows.map((row) =>
            row.tool ? (
              <div key={row.id} data-message-id={row.id}>
                <ToolMessage
                  tool={row.tool}
                  ownerSessionId={ownerSessionId}
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

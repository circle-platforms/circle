import {
  cleanThinking,
  thinkingHasBody,
  thinkingHeadline,
} from '../model/thinking';
import { Markdown } from './Markdown';
import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { useSessionDisclosure } from '../model/presentation';
import { Brain, ChevronDown, ChevronRight, LoaderCircle } from 'lucide-react';
import type { Message, Session } from '../model/types';
import { toolSummary } from '../model/tool-summary';
import { TurnClock } from './TurnClock';
import { AgentToolLinks, mappedToolAgents, ToolMessage } from './ToolMessage';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { ImageThumb } from './ImageThumb';
import { locale, t, tn } from '../i18n';
import '../features/conversation-requests.css';

export { toolSummary };

/**
 * Tool calls between two messages, folded to one line as Claude shows them; a click opens
 * the calls. While one runs the line names it, and a request that waits for you (the
 * children) shows under the line whether it is open or not.
 */
/**
 * One call has nothing to list, so opening its line opens the call. The first look
 * decides: a call that joins later must not close what is being read.
 */
function GroupCall({
  alone,
  expanded,
  ...call
}: ComponentProps<typeof ToolMessage> & { alone: boolean }) {
  const [opensAlone] = useState(alone);
  return <ToolMessage {...call} expanded={expanded || opensAlone} />;
}

export function ToolGroup({
  rows,
  ownerSessionId,
  expanded,
  showThinking = true,
  onFile,
  onAgent,
  turn,
  children,
}: {
  rows: Message[];
  ownerSessionId?: string;
  expanded: boolean;
  showThinking?: boolean;
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
  const { snapshot } = useRuntime();
  const summary = toolSummary(rows);
  // The way into a subagent stays in view however the line is folded.
  const agents = [
    ...new Map(
      tools
        .flatMap((tool) =>
          mappedToolAgents(
            tool,
            snapshot.agents,
            ownerSessionId ?? currentSession(snapshot).id,
          ),
        )
        .map((agent) => [agent.id, agent]),
    ).values(),
  ];
  const separator = locale() === 'zh-CN' ? '，' : ', ';
  const running = tools.find((tool) => tool.status === 'running');
  // A picture a tool brought back, such as the browser's screenshot, belongs to the
  // call that took it: the folded line only says how many there are.
  const shots = rows.flatMap((row) =>
    (row.attachments ?? []).filter((file) => file.kind === 'image'),
  );
  // Steps with only hidden thinking, or nothing at all, have nothing to show.
  if (
    !tools.length &&
    !turn &&
    !(showThinking && rows.some((row) => row.thinking))
  )
    return null;
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
        <span className="tool-summary-text">
          {summary.segments.map((segment, index) => (
            <span key={index} className={segment.failed ? 'failed' : undefined}>
              {index > 0 && separator}
              {segment.text}
            </span>
          ))}
        </span>
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
        {!open && shots.length > 0 && (
          <span className="tool-shots-count">
            {tn(shots.length, '{n} picture', '{n} pictures')}
          </span>
        )}
        {turn && <TurnClock turn={turn} />}
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {!open && agents.length > 0 && (
        <AgentToolLinks agents={agents} onAgent={onAgent} />
      )}
      {open && (
        <>
          {shots.length > 0 && (
            <div className="tool-shots">
              {shots.map((shot) => (
                <ImageThumb key={shot.id} attachment={shot} />
              ))}
            </div>
          )}
          <div id={detailsId} className="tool-group-calls">
            {rows.map((row) =>
              row.tool ? (
                <div key={row.id} data-message-id={row.id}>
                  <GroupCall
                    tool={row.tool}
                    ownerSessionId={ownerSessionId}
                    alone={tools.length === 1}
                    expanded={expanded}
                    onAgent={onAgent}
                    onFile={onFile}
                  />
                </div>
              ) : row.thinking && showThinking ? (
                <GroupThinking key={row.id} row={row} />
              ) : null,
            )}
          </div>
        </>
      )}
      {children}
    </div>
  );
}

function GroupThinking({ row }: { row: Message }) {
  const [open, setOpen] = useSessionDisclosure('thinking:' + row.id);
  const opens = thinkingHasBody(row.thinking);
  return (
    <details
      data-message-id={row.id}
      className="thinking group-thinking"
      open={opens && open}
      data-heading-only={opens ? undefined : true}
    >
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (opens) setOpen(!open);
        }}
      >
        <Brain size={13} />
        <span>{t('thinking')}</span>
        <span className="thinking-preview">
          {thinkingHeadline(row.thinking)}
        </span>
      </summary>
      {opens && (
        <div className="thinking-body">
          <Markdown text={cleanThinking(row.thinking)} />
        </div>
      )}
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

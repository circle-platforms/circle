import { useMemo, useState } from 'react';
import { structuredTextOutput } from '../model/tool-output';
import {
  useCommandTerminal,
  useUserShellTerminal,
} from './CommandTerminalNavigation';
import { useSessionDisclosure } from '../model/presentation';
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileDiff,
  ArrowUpRight,
  Terminal,
  Users,
  FileText,
  Globe,
  SquareTerminal,
} from 'lucide-react';
import type { AgentRecord, ToolCall } from '../model/types';
import { agentState } from '../model/activity';
import { internalToolTitle } from '../model/tool-summary';
import { useRuntimeActions, useRuntimeSelector } from '../app/context';
import {
  DataBlock,
  OpenFileButton,
  OpenInTerminalButton,
  RowActions,
  Status,
} from './common';
import { DiffBlock, DiffSummary } from './DiffBlock';
import { t } from '../i18n';
import { relativePath } from '../model/format';
import { currentSession } from '../model/state';
import { useSources } from './SourceNavigation';
import type { Attachment } from '../model/types';
import { hasToolInput } from '../model/browser';
import { withoutHookAllowedLine } from '../../../../src/hook_display';
import {
  isKnowledgeTool,
  knowledgeToolResult,
  knowledgeToolTarget,
  knowledgeToolTitle,
} from '../model/knowledge-tools';
const AGENT_TOOLS = new Set([
  'task',
  'native_tasks_enqueue',
  'native_tasks_propose',
  'native_tasks_adopt_proposal',
  'native_tasks_analyze',
  'native_tasks_list',
  'native_tasks_wait',
  'native_tasks_events',
  'native_tasks_cancel',
  'native_tasks_retry',
  'native_tasks_artifacts',
]);
export function agentToolTitle(name: string): string {
  if (name === 'native_tasks_enqueue' || name === 'native_tasks_adopt_proposal')
    return t('schedule agents');
  if (name === 'native_tasks_propose') return t('propose follow-up tasks');
  if (name === 'native_tasks_analyze') return t('schedule read-only agents');
  if (
    name === 'native_tasks_list' ||
    name === 'native_tasks_wait' ||
    name === 'native_tasks_events'
  )
    return t('agent progress');
  if (name === 'native_tasks_cancel') return t('cancel agent task');
  if (name === 'native_tasks_retry') return t('retry agent task');
  if (name === 'native_tasks_artifacts') return t('agent artifacts');
  return internalToolTitle(name) ?? name;
}
/** Only trusted projected IDs can create child navigation; tool output remains evidence. */
export function mappedToolAgents(
  tool: ToolCall,
  agents: AgentRecord[],
  ownerSessionId: string,
): AgentRecord[] {
  // A proposal is informational; it does not create or adopt child executions.
  if (tool.name === 'native_tasks_propose') return [];
  const ids = new Set([
    ...(tool.agentIds ?? []),
    ...(tool.agentId ? [tool.agentId] : []),
  ]);
  if (!ids.size) return [];
  return agents.filter(
    (agent) => agent.sessionId === ownerSessionId && ids.has(agent.id),
  );
}
/** Whether two lists read the same in AgentToolLinks: rows are rebuilt each publication. */
export function sameToolAgents(one: AgentRecord[], other: AgentRecord[]) {
  return (
    one.length === other.length &&
    one.every((agent, index) => {
      const next = other[index]!;
      return (
        agent.id === next.id &&
        agent.name === next.name &&
        agentState(agent) === agentState(next)
      );
    })
  );
}
export function AgentToolLinks({
  agents,
  onAgent,
}: {
  agents: AgentRecord[];
  onAgent: (id: string) => void;
}) {
  return (
    <div className="tool-agent-links">
      {agents.map((agent) => (
        <button
          className="text-button"
          key={agent.id}
          onClick={() => onAgent(agent.id)}
        >
          <Users size={12} />
          <span>{agent.name}</span>
          <Status value={agentState(agent)} />
          <ArrowUpRight size={12} />
        </button>
      ))}
    </div>
  );
}

const SEARCH_QUOTA = 'Native search unavailable: search quota exceeded';
const SEARCH_PROVIDER = 'Provider: DuckDuckGo';
/** The provider line and its quota error, in the interface language. The stored text stays English. */
export function shownToolOutput(text: string): string {
  return withoutHookAllowedLine(text)
    .replaceAll(SEARCH_PROVIDER, t(SEARCH_PROVIDER))
    .replaceAll(SEARCH_QUOTA, t(SEARCH_QUOTA))
    .replaceAll('Hook denied this call:', t('Hook denied this call:'))
    .replaceAll(
      'Hook asked before this call:',
      t('Hook asked before this call:'),
    )
    .replaceAll('Hook allowed this call.', t('Hook allowed this call.'))
    .replaceAll('Hook session_start output:', t('Hook session_start output:'))
    .replace(/Hook output \(([^)]+)\):/g, (_match, name: string) =>
      t('Hook output ({name}):', { name }),
    );
}
interface ToolMessageProps {
  tool: ToolCall;
  ownerSessionId?: string;
  userShellId?: string;
  expanded: boolean;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
}
export function ToolMessage(props: ToolMessageProps) {
  return isKnowledgeTool(props.tool.name) ? (
    <KnowledgeToolMessage tool={props.tool} expanded={props.expanded} />
  ) : (
    <GenericToolMessage {...props} />
  );
}
/**
 * A knowledge or memory call: the tool list's title, the item it is about and what it
 * came to, in words. Its arguments and response are the technical details, folded.
 */
function KnowledgeToolMessage({
  tool,
  expanded,
}: Pick<ToolMessageProps, 'tool' | 'expanded'>) {
  const [open, setOpen] = useSessionDisclosure('tool:' + tool.id, expanded);
  const shownOutput = shownToolOutput(tool.output);
  const target = knowledgeToolTarget(tool.name, tool.input, tool.output);
  const result = knowledgeToolResult(tool.name, tool.output, tool.status);
  const live = ['running', 'waiting'].includes(tool.status);
  return (
    <div className={`tool-call tool-${tool.status}`} data-knowledge-tool>
      <button
        className="tool-head"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="tool-icon">
          <FileText size={14} />
        </span>
        <code className="tool-readable" title={tool.name}>
          {knowledgeToolTitle(tool.name)}
        </code>
        <span className="tool-target tool-readable">{target}</span>
        {result && <span className="tool-diff-summary">{result}</span>}
        <span className="tool-time">{tool.elapsed}</span>
        {tool.status === 'success' ? (
          <Check size={13} />
        ) : (
          <Status value={tool.status} />
        )}
        <span>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>
      {open && (
        <div className="tool-content">
          {!shownOutput.trim() && (
            <p className="tool-empty">
              {live ? t('no output yet') : t('no output')}
            </p>
          )}
          <details className="context-source">
            <summary>{t('technical details')}</summary>
            {hasToolInput(tool.input) && (
              <DataBlock title={t('arguments')} value={tool.input} />
            )}
            {shownOutput.trim() && (
              <DataBlock
                title={t('output')}
                value={shownOutput}
                copyLabel={t('copy tool output')}
              />
            )}
          </details>
        </div>
      )}
    </div>
  );
}
function GenericToolMessage({
  tool,
  ownerSessionId,
  userShellId,
  expanded,
  onFile,
  onAgent,
}: ToolMessageProps) {
  const sources = useSources();
  const openCommandTerminal = useCommandTerminal();
  const openUserShellTerminal = useUserShellTerminal();
  const [terminalError, setTerminalError] = useState('');
  const attachments =
    (tool as ToolCall & { attachments?: Attachment[] }).attachments ?? [];
  const [open, setOpen] = useSessionDisclosure('tool:' + tool.id, expanded);
  const [inputOpen, setInputOpen] = useSessionDisclosure(
    'tool-input:' + tool.id,
  );
  const textOutput = useMemo(
    () => structuredTextOutput(withoutHookAllowedLine(tool.output)),
    [tool.output],
  );
  // What opens elsewhere sits at the right end of the head; each block of text copies itself
  const canOpenTerminal =
    (tool.name === 'execute' && !!openCommandTerminal) ||
    (!!userShellId && !!openUserShellTerminal);
  const { runtime } = useRuntimeActions();
  const childAgents = useRuntimeSelector(
    (snapshot) =>
      mappedToolAgents(
        tool,
        snapshot.agents,
        ownerSessionId ?? currentSession(snapshot).id,
      ),
    sameToolAgents,
  );
  const root = useRuntimeSelector(
    (snapshot) =>
      snapshot.workspaces.find(
        (workspace) => workspace.id === currentSession(snapshot).workspaceId,
      )?.path,
  );
  const Icon = AGENT_TOOLS.has(tool.name)
    ? Users
    : ['execute', '!', '!!'].includes(tool.name)
      ? Terminal
      : tool.name.startsWith('browser_')
        ? Globe
        : tool.name.startsWith('terminal_')
          ? SquareTerminal
          : tool.diff || tool.before !== undefined
            ? FileDiff
            : FileText;
  const isCommand = ['execute', '!', '!!'].includes(tool.name);
  // A command reads as its command line, above what it printed.
  const commandLine =
    isCommand && typeof tool.input.command === 'string'
      ? tool.input.command
      : undefined;
  const shownOutput = shownToolOutput(tool.output);
  const live = ['running', 'waiting'].includes(tool.status);
  // A file change that happened shows its diff under the call; a waiting one shows it in
  // the request below, and one that failed changed nothing.
  const diff = tool.diff && tool.status === 'success' ? tool.diff : undefined;
  return (
    <div className={`tool-call tool-${tool.status}`}>
      <div className="tool-row">
        <button
          className="tool-head"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          <span className="tool-icon">
            <Icon size={14} />
          </span>
          <code title={tool.name}>{agentToolTitle(tool.name)}</code>
          <span className="tool-target">
            {relativePath(
              String(
                tool.input.file_path ??
                  tool.input.path ??
                  (isCommand ? tool.input.description : undefined) ??
                  tool.input.command ??
                  tool.input.description ??
                  tool.input.query ??
                  tool.input.pattern ??
                  tool.input.url ??
                  tool.input.element ??
                  tool.input.key ??
                  '',
              ),
              root,
            )}
          </span>
          {diff && (
            <span className="tool-diff-summary">
              <DiffSummary text={diff.summary} />
            </span>
          )}
          <span className="tool-time">{tool.elapsed}</span>
          {tool.status === 'success' ? (
            <Check size={13} />
          ) : (
            <Status value={tool.status} />
          )}
          <span>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </span>
        </button>
        {open && (canOpenTerminal || tool.filePath) && (
          <RowActions>
            {canOpenTerminal && (
              <OpenInTerminalButton
                open={(trigger) => {
                  const source =
                    ownerSessionId ?? currentSession(runtime.getSnapshot()).id;
                  return userShellId
                    ? openUserShellTerminal!(source, userShellId, trigger)
                    : openCommandTerminal!(source, tool.id, trigger);
                }}
                onError={setTerminalError}
              />
            )}
            {tool.filePath && (
              <OpenFileButton onOpen={() => onFile(tool.filePath!)} />
            )}
          </RowActions>
        )}
      </div>
      {diff && !open && (
        <div className="tool-diff">
          <DiffBlock diff={diff} compact header={false} />
        </div>
      )}
      {childAgents.length > 0 && (
        <AgentToolLinks agents={childAgents} onAgent={onAgent} />
      )}
      {open && (
        <div className="tool-content">
          {diff && <DiffBlock diff={diff} header={false} />}
          {terminalError && <p role="alert">{terminalError}</p>}
          {commandLine && (
            <DataBlock
              title={t('command')}
              value={`$ ${commandLine}`}
              copy={commandLine}
              copyLabel={t('copy command')}
            />
          )}
          {textOutput ? (
            <>
              <div className="tool-text-preview">
                <DataBlock
                  title={t('output')}
                  value={textOutput.preview}
                  tabIndex={0}
                  wrap={false}
                  copy={textOutput.text}
                  copyLabel={t('copy text output')}
                />
              </div>
              {/* The response as the tool returned it, folded: the text above is what it says. */}
              <details className="context-source">
                <summary>{t('full response')}</summary>
                <DataBlock
                  title={t('full response')}
                  value={shownOutput}
                  copyLabel={t('copy tool output')}
                />
              </details>
            </>
          ) : shownOutput.trim() ? (
            <DataBlock
              title={t('output')}
              value={shownOutput}
              copyLabel={t('copy tool output')}
            />
          ) : (
            <p className="tool-empty">
              {live ? t('no output yet') : t('no output')}
            </p>
          )}
          {!commandLine && hasToolInput(tool.input) && (
            <details className="context-source tool-input" open={inputOpen}>
              <summary
                onClick={(event) => {
                  event.preventDefault();
                  setInputOpen(!inputOpen);
                }}
              >
                {t('arguments')}
              </summary>
              <DataBlock title={t('arguments')} value={tool.input} />
            </details>
          )}
          {attachments.length > 0 && (
            <div className="message-attachments">
              {attachments.map((attachment) => (
                <button
                  className="text-button"
                  key={attachment.id}
                  onClick={() => sources?.openAttachment(attachment)}
                >
                  {attachment.name}
                </button>
              ))}
            </div>
          )}
          {runtime.mode !== 'live' && (
            <div className="tool-meta">
              {tool.id} · {t('sample record')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

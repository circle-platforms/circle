import { useMemo, useState } from 'react';
import { structuredTextOutput } from '../model/tool-output';
import {
  useCommandTerminal,
  useUserShellTerminal,
} from './CommandTerminalNavigation';
import { copyText } from '../host';
import {
  useSessionDisclosure,
  useSessionPresentation,
} from '../model/presentation';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileDiff,
  ArrowUpRight,
  Terminal,
  Users,
  FileText,
  Globe,
} from 'lucide-react';
import type { AgentRecord, ToolCall } from '../model/types';
import { agentState } from '../model/activity';
import { useRuntime } from '../app/context';
import { DataBlock, IconButton, Status } from './common';
import { DiffBlock } from './DiffBlock';
import { t } from '../i18n';
import { relativePath } from '../model/format';
import { currentSession } from '../model/state';
import { useSources } from './SourceNavigation';
import type { Attachment } from '../model/types';
import { hasToolInput } from '../model/browser';
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
  return name;
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
  return agents.filter(
    (agent) => agent.sessionId === ownerSessionId && ids.has(agent.id),
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
export function ToolMessage({
  tool,
  ownerSessionId,
  userShellId,
  expanded,
  onFile,
  onAgent,
}: {
  tool: ToolCall;
  ownerSessionId?: string;
  userShellId?: string;
  expanded: boolean;
  onFile: (path: string) => void;
  onAgent: (id: string) => void;
}) {
  const sources = useSources();
  const openCommandTerminal = useCommandTerminal();
  const openUserShellTerminal = useUserShellTerminal();
  const [terminalBusy, setTerminalBusy] = useState(false);
  const [terminalError, setTerminalError] = useState('');
  const attachments =
    (tool as ToolCall & { attachments?: Attachment[] }).attachments ?? [];
  const [open, setOpen] = useSessionDisclosure('tool:' + tool.id, expanded);
  const { view, update } = useSessionPresentation();
  const tab = view.toolTabs?.[tool.id] ?? 'output';
  const textOutput = useMemo(
    () => structuredTextOutput(tool.output),
    [tool.output],
  );
  const setTab = (value: 'input' | 'output') =>
    update((target) => {
      (target.toolTabs ??= {})[tool.id] = value;
    });
  const { notify, runtime, snapshot } = useRuntime();
  const childAgents = mappedToolAgents(
    tool,
    snapshot.agents,
    ownerSessionId ?? currentSession(snapshot).id,
  );
  const root = snapshot.workspaces.find(
    (workspace) => workspace.id === currentSession(snapshot).workspaceId,
  )?.path;
  const Icon = AGENT_TOOLS.has(tool.name)
    ? Users
    : ['execute', '!', '!!'].includes(tool.name)
      ? Terminal
      : tool.name.startsWith('browser_')
        ? Globe
        : tool.diff || tool.before !== undefined
          ? FileDiff
          : FileText;
  // A file change that happened shows its diff under the call; a waiting one shows it in
  // the request below, and one that failed changed nothing.
  const diff = tool.diff && tool.status === 'success' ? tool.diff : undefined;
  return (
    <div className={`tool-call tool-${tool.status}`}>
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
        {diff && <span className="tool-diff-summary">{diff.summary}</span>}
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
      {diff && !open && (
        <div className="tool-diff">
          <DiffBlock diff={diff} compact />
        </div>
      )}
      {childAgents.length > 0 && (
        <AgentToolLinks agents={childAgents} onAgent={onAgent} />
      )}
      {open && (
        <div className="tool-content">
          {diff && <DiffBlock diff={diff} />}
          <div className="tool-toolbar">
            <div className="segmented">
              <button
                className={tab === 'output' ? 'active' : ''}
                onClick={() => setTab('output')}
              >
                {t('output')}
              </button>
              {hasToolInput(tool.input) && (
                <button
                  className={tab === 'input' ? 'active' : ''}
                  onClick={() => setTab('input')}
                >
                  {t('input')}
                </button>
              )}
            </div>
            {((tool.name === 'execute' && openCommandTerminal) ||
              (userShellId && openUserShellTerminal)) && (
              <button
                className="text-button"
                disabled={terminalBusy}
                onClick={async (event) => {
                  const trigger = event.currentTarget;
                  setTerminalBusy(true);
                  setTerminalError('');
                  try {
                    const source =
                      ownerSessionId ?? currentSession(snapshot).id;
                    if (userShellId)
                      await openUserShellTerminal!(
                        source,
                        userShellId,
                        trigger,
                      );
                    else await openCommandTerminal!(source, tool.id, trigger);
                  } catch (error) {
                    setTerminalError(
                      error instanceof Error
                        ? error.message
                        : t('command terminal could not be opened; try again'),
                    );
                  } finally {
                    setTerminalBusy(false);
                  }
                }}
              >
                {terminalBusy ? t('opening terminal…') : t('open in terminal')}
                <ArrowUpRight size={12} />
              </button>
            )}
            {tool.filePath && (
              <button
                className="text-button"
                onClick={() => onFile(tool.filePath!)}
              >
                {t('open file')}
                <ArrowUpRight size={12} />
              </button>
            )}
            {tab === 'output' && textOutput && (
              <IconButton
                label={t('copy text output')}
                onClick={() =>
                  copyText(textOutput.text).then(
                    () => notify(t('copied')),
                    () => notify(t('clipboard unavailable')),
                  )
                }
              >
                <Copy size={13} />
              </IconButton>
            )}
            <IconButton
              label={t('copy tool output')}
              onClick={() =>
                copyText(
                  tab === 'input'
                    ? JSON.stringify(tool.input, null, 2)
                    : tool.output,
                ).then(
                  () => notify(t('copied')),
                  () => notify(t('clipboard unavailable')),
                )
              }
            >
              <Copy size={13} />
            </IconButton>
          </div>
          {terminalError && <p role="alert">{terminalError}</p>}
          {tab === 'output' && textOutput ? (
            <>
              <div className="tool-text-preview">
                <DataBlock
                  title={t('text output')}
                  value={textOutput.preview}
                  tabIndex={0}
                  wrap={false}
                />
              </div>
              <details className="context-source">
                <summary>{t('raw output')}</summary>
                <DataBlock title={t('raw output')} value={tool.output} />
              </details>
            </>
          ) : (
            (tab === 'output' || hasToolInput(tool.input)) && (
              <DataBlock
                title={tab === 'input' ? t('raw input') : t('raw output')}
                value={tab === 'input' ? tool.input : tool.output}
              />
            )
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
            <div className="tool-meta">{tool.id} · sample record</div>
          )}
        </div>
      )}
    </div>
  );
}

import { Bot, Square, X } from 'lucide-react';
import { useMemo } from 'react';
import { useRuntime } from '../app/context';
import { IconButton } from '../components/common';
import { MessageView } from '../components/MessageView';
import { SourceNavigation } from '../components/SourceNavigation';
import { ToolGroup } from '../components/ToolGroup';
import { t } from '../i18n';
import {
  agentActivityText,
  agentState,
  isAgentActive,
} from '../model/activity';
import { agentLabel, pendingFor } from '../model/overview';
import { currentSession } from '../model/state';
import type { AgentRecord, DialogId } from '../model/types';
import { groupMessages } from './Conversation';
import { ModeButtons } from './mode-chrome';

const DOT: Record<string, string> = {
  running: 'run',
  preparing: 'run',
  waiting: 'wait',
  failed: 'fail',
  interrupted: 'fail',
};

function Row({
  agent,
  selected,
  elapsed,
  waiting,
  onSelect,
}: {
  agent: AgentRecord;
  selected: boolean;
  elapsed?: string;
  waiting: boolean;
  onSelect: () => void;
}) {
  const label = agentLabel(agent);
  const state = agentState(agent);
  return (
    <button
      type="button"
      className="agent-row"
      aria-current={selected || undefined}
      title={agentActivityText(agent)}
      onClick={onSelect}
    >
      <i
        className="overview-dot"
        data-state={
          waiting
            ? 'wait'
            : isAgentActive(agent)
              ? (DOT[state] ?? 'run')
              : (DOT[state] ?? 'done')
        }
        aria-hidden
      />
      <span className="agent-row-text">
        <span className="agent-row-name">{label.name}</span>
        {label.detail && <small>{label.detail}</small>}
      </span>
      {elapsed && <small className="agent-row-time">{elapsed}</small>}
    </button>
  );
}

/**
 * The conversation's subagents: a list of those working and those finished, and, when one
 * is opened, its own conversation beside the list. A request it waits on is answered in the
 * conversation it was sent from, so here it is only said.
 */
export function AgentsMode({
  selection,
  onSelect,
  onFile,
  onDialog,
}: {
  selection: string;
  onSelect: (id: string | null) => void;
  onFile: (path: string, line?: number, column?: number) => void;
  onDialog: (dialog: DialogId, selection?: string) => void;
}) {
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const agents = snapshot.agents.filter(
    (agent) => agent.sessionId === session.id && !agent.task,
  );
  const working = agents.filter(isAgentActive);
  const finished = agents.filter((agent) => !isAgentActive(agent));
  const selected = agents.find((agent) => agent.id === selection);
  const jobOf = (agent: AgentRecord) =>
    snapshot.jobs.find((job) => job.agentId === agent.id);
  const items = useMemo(
    () => groupMessages(selected?.messages ?? []),
    [selected?.messages],
  );
  const list = (
    <div className="agent-list" role="list" aria-label={t('subagents')}>
      {!agents.length && <p className="panel-note">{t('no subagents yet')}</p>}
      {[
        { title: t('running'), rows: working },
        { title: t('finished'), rows: finished },
      ]
        .filter((group) => group.rows.length)
        .map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            {group.rows.map((agent) => (
              <Row
                key={agent.id}
                agent={agent}
                selected={agent.id === selected?.id}
                elapsed={jobOf(agent)?.elapsed}
                waiting={!!pendingFor(agent.id, snapshot.interactions)}
                onSelect={() => onSelect(agent.id)}
              />
            ))}
          </section>
        ))}
    </div>
  );
  if (!selected) return <section className="agents-mode">{list}</section>;
  const label = agentLabel(selected);
  const job = jobOf(selected);
  const stoppable =
    !!job && ['running', 'waiting'].includes(job.state) && !job.stopRequested;
  const asked = pendingFor(selected.id, snapshot.interactions);
  return (
    <section className="agents-mode open">
      <SourceNavigation onFile={onFile}>
        <div className="agent-detail">
          <header className="mode-toolbar">
            <Bot size={14} aria-hidden />
            <span className="agent-title">
              <span>{label.name}</span>
              {label.detail && <small>{label.detail}</small>}
            </span>
            <span className="mode-toolbar-end">
              {stoppable && (
                <IconButton
                  label={t('stop subagent')}
                  onClick={() => onDialog('job-stop', job!.id)}
                >
                  <Square size={13} />
                </IconButton>
              )}
              <ModeButtons />
              <IconButton
                label={t('close subagent')}
                onClick={() => onSelect(null)}
              >
                <X size={14} />
              </IconButton>
            </span>
          </header>
          <div className="agent-transcript">
            {items.map((item) =>
              item.kind === 'tools' ? (
                <ToolGroup
                  key={item.id}
                  rows={item.rows}
                  ownerSessionId={selected.id}
                  expanded={session.expandTools}
                  onFile={onFile}
                  onAgent={onSelect}
                />
              ) : (
                <MessageView
                  key={item.message.id}
                  message={item.message}
                  showThinking={session.showThinking}
                  onAttachment={() => {}}
                />
              ),
            )}
            {asked && (
              <p className="agent-asking">
                {asked.command ?? asked.tool ?? asked.title}
              </p>
            )}
          </div>
        </div>
      </SourceNavigation>
      {list}
    </section>
  );
}

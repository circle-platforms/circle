import { DropdownMenu } from 'radix-ui';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Folder,
  GitBranch,
  GitPullRequest,
  Laptop,
  MoreVertical,
  FileDiff,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useRuntime } from '../app/context';
import { FileIcon } from '../components/FileIcon';
import { PendingOperations } from './PendingOperations';
import { useSources } from '../components/SourceNavigation';
import { copyText, desktopHost } from '../host';
import { t, tn } from '../i18n';
import { agentActivityText, agentDot } from '../model/activity';
import { contextUsage } from '../model/context-usage';
import { useOwnerState } from '../model/owner-state';
import {
  agentLabel,
  outputRows,
  overviewProgress,
  pendingFor,
  pullRequestAction,
  type PullRequestAction,
} from '../model/overview';
import { failedRunLog, usePullRequests } from '../model/pull-requests';
import { currentSession } from '../model/state';
import type { PanelId } from '../model/types';
import { workspaceLabel } from '../model/workspace-label';
import { SAMPLE_PULL_REQUESTS } from '../preview/pull-requests';
import type { PullRequestSummary } from '../../../desktop/src/workspace/pulls-types';
import '../styles/overview.css';

const OUTPUTS_SHOWN = 3;
const PULL_REQUESTS_SHOWN = 2;

type CardId = 'environment' | 'context' | 'progress' | 'outputs' | 'changes';
const OPEN: Record<CardId, boolean> = {
  environment: true,
  context: false,
  progress: true,
  outputs: true,
  changes: true,
};

function Card({
  id,
  title,
  open,
  onToggle,
  summary,
  children,
}: {
  id: CardId;
  title: string;
  open: boolean;
  onToggle: () => void;
  summary?: ReactNode;
  children?: ReactNode;
}) {
  const heading = `overview-${id}`;
  return (
    <section className="overview-card" aria-labelledby={heading}>
      <h3 id={heading}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`${heading}-body`}
          onClick={onToggle}
        >
          <span>{title}</span>
          {open ? (
            <ChevronDown size={14} aria-hidden />
          ) : (
            <ChevronRight size={14} aria-hidden />
          )}
          {summary !== undefined && (
            <span className="overview-summary">{summary}</span>
          )}
        </button>
      </h3>
      {open && (
        <div id={`${heading}-body`} className="overview-body">
          {children}
        </div>
      )}
    </section>
  );
}

function Row({
  icon: Icon,
  onClick,
  title,
  children,
  end,
}: {
  icon?: LucideIcon;
  onClick?: () => void;
  title?: string;
  children: ReactNode;
  end?: ReactNode;
}) {
  const body = (
    <>
      {Icon && <Icon size={16} aria-hidden />}
      {children}
      {end !== undefined && <span className="overview-end">{end}</span>}
    </>
  );
  return onClick ? (
    <button
      type="button"
      className="overview-row"
      title={title}
      onClick={onClick}
    >
      {body}
    </button>
  ) : (
    <div className="overview-row" title={title}>
      {body}
    </div>
  );
}

function Dot({ state }: { state: 'run' | 'wait' | 'fail' | 'done' | 'idle' }) {
  return <i className="overview-dot" data-state={state} aria-hidden />;
}

function checksText(checks: PullRequestSummary['checks']) {
  return checks === 'failing'
    ? t('ci failing')
    : checks === 'running'
      ? t('ci running')
      : checks === 'passing'
        ? t('ci passing')
        : '';
}

/** What the second line of a pull request says: its state, and how its checks are. */
function PullRequestStatus({ pull }: { pull: PullRequestSummary }) {
  if (pull.state === 'merged') return <>{t('merged')}</>;
  if (pull.state === 'closed') return <>{t('closed')}</>;
  const checks = checksText(pull.checks);
  return (
    <>
      {pull.draft ? t('draft') : t('ready for review')}
      {checks && (
        <>
          {' · '}
          <span data-checks={pull.checks}>{checks}</span>
        </>
      )}
    </>
  );
}

/**
 * The conversation's summary, beside it and always in view while there is room: where it
 * runs, how full its context is, what is in progress, what it produced and what is not
 * on GitHub yet. It only shows. A row's arrow takes the person to where it is done.
 */
export function Overview({
  onPanel,
  onSession,
  onStartPullRequest,
}: {
  onPanel: (panel: PanelId, selection?: string) => void;
  /** Open a task's own conversation. */
  onSession: (id: string) => void;
  /** Load the create-pr skill into the conversation and ask for it. */
  onStartPullRequest: (action: PullRequestAction) => void;
}) {
  const { snapshot, runtime, notify } = useRuntime();
  const sources = useSources();
  const session = currentSession(snapshot);
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  );
  const [open, setOpen] = useOwnerState<Record<CardId, boolean>>(
    session.id,
    OPEN,
  );
  const toggle = (id: CardId) => setOpen((old) => ({ ...old, [id]: !old[id] }));
  const [moreOutputs, setMoreOutputs] = useState(false);
  const [morePulls, setMorePulls] = useState(false);

  const usage = contextUsage(session);
  const progress = overviewProgress(
    session,
    snapshot.sessions,
    snapshot.agents,
  );
  const outputs = outputRows(session.changes, workspace?.path);
  const { overview } = usePullRequests({
    sessionId: session.id,
    live: runtime.mode === 'live',
    busy: session.state !== 'idle',
    sample: runtime.mode === 'live' ? undefined : SAMPLE_PULL_REQUESTS,
  });
  const action = pullRequestAction(overview);
  const git = overview?.git;
  const repo = git?.github.split('/')[1] ?? workspace?.name ?? '';
  const pulls = [
    ...(overview?.current ? [overview.current] : []),
    ...(overview?.recent ?? []),
  ];

  const inProgressCount =
    progress.agents.length + progress.tasks.length + (progress.plan ? 1 : 0);
  const progressSummary = [
    progress.plan
      ? t('plan {done}/{total}', {
          done: progress.plan.done,
          total: progress.plan.total,
        })
      : '',
    progress.agents.length
      ? tn(progress.agents.length, '{n} subagent', '{n} subagents')
      : '',
    progress.tasks.length
      ? tn(progress.tasks.length, '{n} task', '{n} tasks')
      : '',
  ]
    .filter(Boolean)
    .join(' · ');

  const openExternal = (url: string) => {
    try {
      const target = new URL(url);
      if (
        target.protocol !== 'https:' ||
        target.hostname !== 'github.com' ||
        target.username ||
        target.password
      )
        throw Error(t('external link is not allowed'));
      const host = desktopHost();
      if (host?.openExternal)
        void host.openExternal(target.href).catch((e) => notify(String(e)));
      else window.open(target.href, '_blank', 'noopener,noreferrer');
    } catch (e) {
      notify(String(e));
    }
  };
  const copyFailedLog = async (runId: number) => {
    try {
      const log = await failedRunLog(session.id, runId);
      await copyText(log.text);
      notify(t('copied'));
    } catch {
      notify(t('could not read the ci log'));
    }
  };

  return (
    <aside className="overview" aria-label={t('overview')}>
      {/* Operations an interrupted run left for you to settle: shown only while there are any. */}
      {runtime.mode === 'live' && (
        <PendingOperations key={session.id} sessionId={session.id} card />
      )}
      <Card
        id="environment"
        title={t('environment')}
        open={open.environment}
        onToggle={() => toggle('environment')}
      >
        <Row icon={Laptop}>{t('this machine')}</Row>
        <Row icon={Folder} title={workspace?.path}>
          <span className="overview-name">
            {workspace ? workspaceLabel(workspace, snapshot.agents) : ''}
          </span>
          {workspace?.path && (
            <small className="overview-path">
              <bdi dir="ltr">{workspace.path}</bdi>
            </small>
          )}
        </Row>
        {workspace?.branch && (
          <Row icon={GitBranch}>
            <span className="overview-name">{workspace.branch}</span>
          </Row>
        )}
      </Card>

      <Card
        id="context"
        title={t('context')}
        open={open.context}
        onToggle={() => toggle('context')}
        summary={
          usage.percent === null ? (
            t('unavailable')
          ) : (
            <>
              {Math.round(usage.percent)}%
              <progress
                className={`overview-meter ${usage.level}`}
                max={100}
                value={Math.min(100, usage.percent)}
                aria-label={t('context')}
              />
            </>
          )
        }
      >
        <dl className="overview-facts">
          <dt>{t('tokens')}</dt>
          <dd>{usage.fill}</dd>
          <dt>{t('cost')}</dt>
          <dd title={t('estimated from the model’s published prices')}>
            {usage.cost}
          </dd>
          <dt>{t('cache')}</dt>
          <dd>{usage.cache === 'N/A' ? t('cache N/A') : usage.cache}</dd>
          {!!workspace?.instructions.length && (
            <>
              <dt>{t('instructions')}</dt>
              <dd>
                {workspace.instructions.map((item) => (
                  <button
                    type="button"
                    key={item.path ?? item.name}
                    className="overview-link"
                    disabled={!item.path}
                    title={item.path}
                    onClick={() => item.path && sources?.openFile(item.path)}
                  >
                    <FileIcon name={item.name} />
                    {item.name.split(/[\\/]/).pop()}
                  </button>
                ))}
              </dd>
            </>
          )}
        </dl>
      </Card>

      {inProgressCount > 0 && (
        <Card
          id="progress"
          title={t('in progress')}
          open={open.progress}
          onToggle={() => toggle('progress')}
          summary={progressSummary}
        >
          {progress.plan && (
            <Row end={t('plan')}>
              <Dot state="run" />
              <span className="overview-name">
                {progress.plan.current.text}
              </span>
            </Row>
          )}
          {progress.agents.map((agent) => {
            const label = agentLabel(agent);
            const asked = pendingFor(agent.id, snapshot.interactions);
            return (
              <Row
                key={agent.id}
                icon={Bot}
                // What a waiting subagent asked to run is a pointer's rest away.
                title={
                  asked
                    ? (asked.command ?? asked.tool ?? asked.title)
                    : label.detail || label.name
                }
                onClick={() => onPanel('agents', agent.id)}
                end={
                  <>
                    <Dot state={agentDot(agent, !!asked)} />
                    {asked
                      ? asked.kind === 'approval'
                        ? t('waiting for your approval')
                        : t('waiting for you')
                      : agentActivityText(agent)}
                  </>
                }
              >
                <span className="overview-name">{label.name}</span>
                {label.detail && (
                  <small className="overview-detail">{label.detail}</small>
                )}
              </Row>
            );
          })}
          {progress.tasks.map((task) => {
            return (
              <Row
                key={task.session.id}
                icon={Users}
                onClick={() => onSession(task.session.id)}
                end={
                  <>
                    <Dot state={agentDot(task.agent)} />
                    {agentActivityText(task.agent)}
                  </>
                }
              >
                <span className="overview-name">{task.agent.name}</span>
              </Row>
            );
          })}
        </Card>
      )}

      {outputs.length > 0 && (
        <Card
          id="outputs"
          title={t('outputs')}
          open={open.outputs}
          onToggle={() => toggle('outputs')}
          summary={open.outputs ? undefined : outputs.length}
        >
          {(moreOutputs ? outputs : outputs.slice(0, OUTPUTS_SHOWN)).map(
            (row) => (
              <Row
                key={row.path}
                title={row.path}
                onClick={() => onPanel('changes', row.path)}
                end={
                  <span
                    className="overview-letter"
                    data-letter={row.letter}
                    title={
                      row.letter === 'A'
                        ? t('added')
                        : row.letter === 'D'
                          ? t('deleted')
                          : t('modified')
                    }
                  >
                    {row.letter}
                  </span>
                }
              >
                <FileIcon name={row.name} size={16} />
                <span className="overview-name">{row.name}</span>
              </Row>
            ),
          )}
          {outputs.length > OUTPUTS_SHOWN && (
            <button
              type="button"
              className="overview-more"
              onClick={() => setMoreOutputs((on) => !on)}
            >
              {moreOutputs
                ? t('show less')
                : t('show {n} more', { n: outputs.length - OUTPUTS_SHOWN })}
            </button>
          )}
        </Card>
      )}

      {git?.repository && (
        <Card
          id="changes"
          title={t('changes')}
          open={open.changes}
          onToggle={() => toggle('changes')}
        >
          <Row icon={FileDiff}>
            <span className="overview-name">{repo}</span>
            {git.files > 0 ? (
              <span className="overview-counts">
                <span className="add">+{git.additions}</span>
                <span className="del">−{git.deletions}</span>
              </span>
            ) : (
              <small className="overview-detail">
                {git.ahead > 0 || overview?.current
                  ? t('everything is committed')
                  : t('no changes')}
              </small>
            )}
            {action && (
              <button
                type="button"
                className="overview-action"
                disabled={session.state !== 'idle'}
                onClick={() => onStartPullRequest(action)}
              >
                {action === 'update' ? t('update pr') : t('create pr')}
              </button>
            )}
          </Row>
          {(morePulls ? pulls : pulls.slice(0, PULL_REQUESTS_SHOWN)).map(
            (pull) => (
              <div className="overview-pull" key={pull.number}>
                <GitPullRequest size={16} aria-hidden />
                <span className="overview-pull-text">
                  <button
                    type="button"
                    className="overview-pull-title"
                    onClick={() => openExternal(pull.url)}
                  >
                    {pull.title}
                  </button>
                  <small>
                    {repo} #{pull.number} · <PullRequestStatus pull={pull} />
                  </small>
                </span>
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={t('pull request {number} actions', {
                        number: pull.number,
                      })}
                    >
                      <MoreVertical size={14} aria-hidden />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      className="dropdown"
                      align="end"
                      sideOffset={6}
                    >
                      <DropdownMenu.Item
                        onSelect={() => openExternal(pull.url)}
                      >
                        {t('open pr')}
                      </DropdownMenu.Item>
                      <DropdownMenu.Item
                        onSelect={() =>
                          void copyText(pull.url).then(
                            () => notify(t('copied')),
                            () => notify(t('clipboard unavailable')),
                          )
                        }
                      >
                        {t('copy link')}
                      </DropdownMenu.Item>
                      {pull.failedRunId !== undefined && (
                        <DropdownMenu.Item
                          onSelect={() => void copyFailedLog(pull.failedRunId!)}
                        >
                          {t('copy failed ci logs')}
                        </DropdownMenu.Item>
                      )}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>
            ),
          )}
          {pulls.length > PULL_REQUESTS_SHOWN && (
            <button
              type="button"
              className="overview-more"
              onClick={() => setMorePulls((on) => !on)}
            >
              {morePulls
                ? t('show less')
                : t('show {n} more', { n: pulls.length - PULL_REQUESTS_SHOWN })}
            </button>
          )}
        </Card>
      )}
    </aside>
  );
}

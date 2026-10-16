import { useState } from 'react';
import type { ReactNode } from 'react';
import { BookOpen, Blocks, Server, Workflow } from 'lucide-react';
import { useRuntime } from '../../app/context';
import {
  Button,
  DataBlock,
  EmptyState,
  Page,
  Status,
} from '../../components/common';
import { hubView, HubProjectionNotice } from '../hub';
import type { WorkbenchPlugin } from '../types';
import { t } from '../../i18n';

// The four platform objects as the paired hub extension last read them from the
// server (/hub refresh). The server decides what you may see; nothing here is local.
interface Objects {
  refreshedAt: string;
  work: {
    taskId: string;
    title: string;
    phase: string;
    inputRevisionId: string;
    capabilityPackId?: string;
    pendingInputs: { requestId: string; kind: string; question: string }[];
    approvals: {
      approvalId: string;
      status: string;
      applicantId: string;
      approvedBy?: string;
      inputRevisionId: string;
      targetIdentity: string;
      action?: unknown;
    }[];
  }[];
  execution: {
    taskId: string;
    title: string;
    operations: {
      operationId: string;
      name: string;
      status: string;
      target?: string;
      workerId?: string;
      fencingToken?: number;
    }[];
  }[];
  knowledge: {
    taskId: string;
    title: string;
    phase: string;
    status: string;
    source: { sourceRevisionId?: string; sourceSha256?: string };
    artifacts: {
      artifactId: string;
      fileName?: string;
      sha256: string;
      size?: number;
    }[];
    evidence: { evidenceId: string; kind: string; sha256: string }[];
    verification: { reader?: string; rowCount?: number };
    unmapped: unknown[];
  }[];
  methods: {
    capabilityPackId: string;
    version?: string;
    title?: string;
    inputFormats?: string[];
    contractVersion?: string;
    requiredOperations?: string[];
  }[];
  tools?: { name: string; remote: string; write: boolean }[];
  skillPacks?: {
    skillPackId?: string;
    id?: string;
    version?: string;
    status?: string;
    statusLabel?: string;
    lifecycle?: string;
    approvalTaskId?: string;
    approvalId?: string;
  }[];
  background?: { toolReads: number; indexing: number; indexingOpen: number };
  bots?: {
    assetId: string;
    name: string;
    lifecycle: string;
    trigger: string;
    triggerLifecycle?: string;
    mine: boolean;
    owner: string;
    runs: number;
    fresh: number;
  }[];
}
const short = (hash?: string) => (hash ? hash.slice(0, 12) + '…' : '');

function useObjects() {
  const { snapshot, runtime, perform } = useRuntime();
  const view = hubView(snapshot.extensions);
  const objects = (view as { objects?: Objects } | undefined)?.objects;
  // Every action is the extension's own /hub command; its lines go to the conversation.
  const run = (args: string) =>
    perform(async () => {
      await runtime.command('hub', args);
    });
  return { view, objects, run };
}
function Frame({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: (objects: Objects, run: (args: string) => void) => ReactNode;
}) {
  const { view, objects, run } = useObjects();
  return (
    <Page
      title={title}
      description={description}
      action={<Button onClick={() => run('refresh')}>{t('refresh')}</Button>}
    >
      {!view?.signedIn ? (
        <EmptyState title={t('not signed in')}>
          {t('Sign in on the hub page; the server decides what you may see.')}
        </EmptyState>
      ) : !objects ? (
        <EmptyState title={t('nothing read yet')}>
          {t('refresh reads it from {url}.', { url: view.url })}
        </EmptyState>
      ) : (
        <>
          <p className="panel-note">
            {t('read from {url} as {user} at {time}', {
              url: view.url,
              user: view.username,
              time: new Date(objects.refreshedAt).toLocaleTimeString(),
            })}
          </p>
          <HubProjectionNotice projection={view?.projection} />
          {children(objects, run)}
        </>
      )}
    </Page>
  );
}

export function WorkLivePage() {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  return (
    <Frame
      title={t('work')}
      description={t(
        'tasks as the server holds them: their phase, what they wait on, and approvals bound to an input revision.',
      )}
    >
      {(objects, run) => (
        <>
          {objects.work.length ? (
            <div className="extension-list">
              {objects.work.map((task) => (
                <article className="extension-card" key={task.taskId}>
                  <div className="detail-title">
                    <div>
                      <h2>{task.title || task.taskId}</h2>
                      <p>
                        {task.taskId} · input {task.inputRevisionId}
                        {task.capabilityPackId
                          ? ' · ' + task.capabilityPackId
                          : ''}
                      </p>
                    </div>
                    <Status value={task.phase} />
                    <Button
                      aria-label={t('follow {id}', { id: task.taskId })}
                      onClick={() => run(`task ${task.taskId}`)}
                    >
                      {t('follow')}
                    </Button>
                  </div>
                  {task.pendingInputs.map((item) => (
                    <form
                      key={item.requestId}
                      className="form-stack"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const answer = answers[item.requestId]?.trim();
                        if (answer) run(`respond ${task.taskId} ${answer}`);
                      }}
                    >
                      <p>{item.question}</p>
                      <input
                        aria-label={`answer ${item.requestId}`}
                        value={answers[item.requestId] ?? ''}
                        onChange={(event) =>
                          setAnswers({
                            ...answers,
                            [item.requestId]: event.target.value,
                          })
                        }
                      />
                      <Button
                        type="submit"
                        aria-label={t('answer {id}', { id: item.requestId })}
                      >
                        {t('answer')}
                      </Button>
                    </form>
                  ))}
                  {task.approvals.map((approval) => (
                    <div className="detail-title" key={approval.approvalId}>
                      <div>
                        <h2>
                          {t('approval {id}', { id: approval.approvalId })}
                        </h2>
                        <p>
                          {approval.status} · asked by {approval.applicantId}
                          {approval.approvedBy
                            ? ' · decided by ' + approval.approvedBy
                            : ''}{' '}
                          · input {approval.inputRevisionId} · target{' '}
                          {short(approval.targetIdentity)}
                        </p>
                      </div>
                      {approval.status === 'open' && (
                        <>
                          <Button
                            aria-label={t('approve {id}', {
                              id: approval.approvalId,
                            })}
                            onClick={() =>
                              run(
                                `approve ${task.taskId} ${approval.approvalId}`,
                              )
                            }
                          >
                            {t('approve')}
                          </Button>
                          <Button
                            aria-label={t('reject {id}', {
                              id: approval.approvalId,
                            })}
                            onClick={() =>
                              run(
                                `reject ${task.taskId} ${approval.approvalId}`,
                              )
                            }
                          >
                            {t('reject')}
                          </Button>
                        </>
                      )}
                    </div>
                  ))}
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title={t('no work')}>
              {t('Nothing you may read on this server yet.')}
            </EmptyState>
          )}
          <Background objects={objects} />
        </>
      )}
    </Frame>
  );
}

export function ExecutionLivePage() {
  return (
    <Frame
      title={t('execution')}
      description={t(
        "operations the server's workers ran for these tasks, with the worker and fencing token that held the lease.",
      )}
    >
      {(objects, run) =>
        objects.execution.some((task) => task.operations.length) ? (
          <div className="extension-list">
            {objects.execution
              .filter((task) => task.operations.length)
              .map((task) => (
                <article className="extension-card" key={task.taskId}>
                  <div className="detail-title">
                    <div>
                      <h2>{task.title || task.taskId}</h2>
                      <p>{task.taskId}</p>
                    </div>
                  </div>
                  {task.operations.map((operation) => (
                    <div className="detail-title" key={operation.operationId}>
                      <div>
                        <h2>{operation.name}</h2>
                        <p>
                          {operation.operationId}
                          {operation.target ? ' · ' + operation.target : ''}
                          {operation.workerId ? ' · ' + operation.workerId : ''}
                          {operation.fencingToken !== undefined
                            ? ' · fence ' + operation.fencingToken
                            : ''}
                        </p>
                      </div>
                      <Status value={operation.status} />
                      {operation.status === 'unknown' && (
                        <Button
                          aria-label={t('reconcile {id}', { id: task.taskId })}
                          onClick={() => run(`reconcile ${task.taskId}`)}
                        >
                          {t('reconcile')}
                        </Button>
                      )}
                    </div>
                  ))}
                </article>
              ))}
          </div>
        ) : (
          <EmptyState title={t('no operations')}>
            {t('No worker has run anything for these tasks.')}
          </EmptyState>
        )
      }
    </Frame>
  );
}

export function KnowledgeLivePage() {
  return (
    <Frame
      title={t('knowledge')}
      description={t(
        "each task's source, artifacts and evidence, by revision and SHA-256, and the server's own check.",
      )}
    >
      {(objects, run) =>
        objects.knowledge.length ? (
          <div className="extension-list">
            {objects.knowledge.map((task) => (
              <article className="extension-card" key={task.taskId}>
                <div className="detail-title">
                  <div>
                    <h2>{task.title || task.taskId}</h2>
                    <p>
                      source {task.source.sourceRevisionId ?? 'none'} · sha256{' '}
                      {short(task.source.sourceSha256)}
                    </p>
                  </div>
                  <Status value={task.status} />
                  {task.artifacts.length > 0 && (
                    <Button
                      aria-label={t('save results of {id}', {
                        id: task.taskId,
                      })}
                      onClick={() => run(`get ${task.taskId}`)}
                    >
                      {t('save results')}
                    </Button>
                  )}
                </div>
                {task.artifacts.map((artifact) => (
                  <p className="panel-note" key={artifact.artifactId}>
                    artifact {artifact.fileName ?? artifact.artifactId} ·{' '}
                    {artifact.size ?? '?'} bytes · sha256{' '}
                    {short(artifact.sha256)}
                  </p>
                ))}
                {task.evidence.map((item) => (
                  <p className="panel-note" key={item.evidenceId}>
                    evidence {item.evidenceId} · {item.kind} · sha256{' '}
                    {short(item.sha256)}
                  </p>
                ))}
                {task.verification.reader && (
                  <p className="panel-note">
                    read back with {task.verification.reader},{' '}
                    {task.verification.rowCount} rows
                  </p>
                )}
                {task.unmapped.length > 0 && (
                  <DataBlock title={t('unmapped')} value={task.unmapped} />
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title={t('no knowledge')}>
            {t('No task you may read has sources or results yet.')}
          </EmptyState>
        )
      }
    </Frame>
  );
}

export function MethodsLivePage() {
  const [files, setFiles] = useState<Record<string, string>>({});
  return (
    <Frame
      title={t('methods')}
      description={t(
        "the server's capability packs, at the versions it runs. Hand one a file of this workspace.",
      )}
    >
      {(objects, run) => (
        <>
          {objects.methods.length ? (
            <div className="extension-list">
              {objects.methods.map((pack) => (
                <article className="extension-card" key={pack.capabilityPackId}>
                  <div className="detail-title">
                    <div>
                      <h2>
                        {pack.capabilityPackId} {pack.version ?? ''}
                      </h2>
                      <p>
                        {pack.title ?? ''}
                        {pack.contractVersion
                          ? ' · ' + pack.contractVersion
                          : ''}
                        {pack.inputFormats?.length
                          ? ' · ' + pack.inputFormats.join(', ')
                          : ''}
                      </p>
                    </div>
                  </div>
                  <form
                    className="form-stack"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const file = files[pack.capabilityPackId]?.trim();
                      if (file) run(`submit ${pack.capabilityPackId} ${file}`);
                    }}
                  >
                    <input
                      aria-label={`file for ${pack.capabilityPackId}`}
                      placeholder={t('file in the workspace')}
                      value={files[pack.capabilityPackId] ?? ''}
                      onChange={(event) =>
                        setFiles({
                          ...files,
                          [pack.capabilityPackId]: event.target.value,
                        })
                      }
                    />
                    <Button
                      type="submit"
                      aria-label={`hand over to ${pack.capabilityPackId}`}
                    >
                      {t('hand over')}
                    </Button>
                  </form>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title={t('no capability packs')}>
              {t('The server lists none you may use.')}
            </EmptyState>
          )}
          <ServerTools objects={objects} run={run} />
        </>
      )}
    </Frame>
  );
}

// The tasks the work list leaves out: the model's server tool calls and the knowledge
// indexing of what they read, which finishes after the read itself.
function Background({ objects }: { objects: Objects }) {
  const {
    toolReads = 0,
    indexing = 0,
    indexingOpen = 0,
  } = objects.background ?? {};
  if (!toolReads && !indexing) return null;
  // At most the latest 100 of each are read, so 100 means at least that many.
  const count = (n: number) => (n >= 100 ? '100+' : String(n));
  return (
    <p className="panel-note">
      {indexingOpen
        ? t(
            'Not listed: {reads} server tool reads and {indexing} knowledge indexing jobs, {open} still indexing.',
            {
              reads: count(toolReads),
              indexing: count(indexing),
              open: indexingOpen,
            },
          )
        : t(
            'Not listed: {reads} server tool reads and {indexing} knowledge indexing jobs.',
            { reads: count(toolReads), indexing: count(indexing) },
          )}
    </p>
  );
}

// What else the server offers: the tools the model has from it, pushed skill packs, and
// the bots that run them. A bot's buttons are its /hub bot commands.
function ServerTools({
  objects,
  run,
}: {
  objects: Objects;
  run: (args: string) => void;
}) {
  const tools = objects.tools ?? [];
  const packs = objects.skillPacks ?? [];
  const bots = objects.bots ?? [];
  return (
    <>
      <p className="panel-note">
        {tools.length
          ? t('{count} server tools the model can use: {list}', {
              count: tools.length,
              list: tools
                .map(
                  (tool) =>
                    `${tool.remote}${tool.write ? t(' (asks first)') : ''}`,
                )
                .join(', '),
            })
          : t('This server offers the model no tools.')}
      </p>
      {packs.length > 0 && (
        <div className="extension-list">
          {packs.map((pack) => (
            <article
              className="extension-card"
              key={pack.skillPackId ?? pack.id}
            >
              <div className="detail-title">
                <div>
                  <h2>
                    {t('skill pack {name}', {
                      name: `${pack.id ?? pack.skillPackId} ${pack.version ?? ''}`.trim(),
                    })}
                  </h2>
                  <p>{pack.skillPackId}</p>
                  {pack.status &&
                    (pack.statusLabel || pack.lifecycle) &&
                    pack.status !== (pack.statusLabel || pack.lifecycle) && (
                      <p>
                        {t('server records this as {status}', {
                          status: pack.status,
                        })}
                      </p>
                    )}
                  {pack.approvalTaskId && pack.approvalId && (
                    <p>
                      {t('waiting for {command}', {
                        command: `/hub approve ${pack.approvalTaskId} ${pack.approvalId}`,
                      })}
                    </p>
                  )}
                </div>
                <Status
                  value={
                    pack.statusLabel ||
                    pack.lifecycle ||
                    pack.status ||
                    'unknown'
                  }
                />
              </div>
            </article>
          ))}
        </div>
      )}
      {bots.length > 0 && (
        <div className="extension-list">
          {bots.map((bot) => (
            <article className="extension-card" key={bot.assetId}>
              <div className="detail-title">
                <div>
                  <h2>{t('bot {name}', { name: bot.name })}</h2>
                  <p>
                    {bot.assetId} · {bot.trigger}
                    {bot.mine
                      ? ` · ${bot.runs} run(s)${bot.fresh ? `, ${bot.fresh} new` : ''}`
                      : ` · owner ${bot.owner}`}
                  </p>
                </div>
                <Status value={bot.lifecycle} />
                {bot.mine && (
                  <Button
                    aria-label={`runs of ${bot.assetId}`}
                    onClick={() => run(`bot runs ${bot.assetId}`)}
                  >
                    {t('runs')}
                  </Button>
                )}
                {bot.mine && bot.lifecycle === 'approved' && (
                  <Button
                    aria-label={`start ${bot.assetId}`}
                    onClick={() => run(`bot start ${bot.assetId}`)}
                  >
                    {t('start')}
                  </Button>
                )}
                {bot.mine && bot.lifecycle === 'running' && (
                  <Button
                    aria-label={`stop ${bot.assetId}`}
                    onClick={() => run(`bot stop ${bot.assetId}`)}
                  >
                    {t('stop')}
                  </Button>
                )}
                {!bot.mine && bot.lifecycle === 'draft' && (
                  <Button
                    aria-label={`approve ${bot.assetId}`}
                    onClick={() => run(`bot approve ${bot.assetId}`)}
                  >
                    {t('approve')}
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

const paired = {
  apiVersion: 1 as const,
  version: '0.1.0',
  runtimeExtension: 'hub',
};
/** B, C, D and E as the server holds them, paired with the hub extension. */
export const livePlatformPlugins: WorkbenchPlugin[] = [
  {
    ...paired,
    id: 'knowledge',
    title: 'knowledge',
    description:
      "each task's source, artifacts and evidence, by revision and SHA-256, and the server's own check.",
    icon: BookOpen,
    pages: [
      {
        id: 'knowledge',
        title: 'knowledge',
        icon: BookOpen,
        component: KnowledgeLivePage,
      },
    ],
  },
  {
    ...paired,
    id: 'work',
    title: 'work',
    description:
      'tasks as the server holds them: their phase, what they wait on, and approvals bound to an input revision.',
    icon: Workflow,
    pages: [
      { id: 'work', title: 'work', icon: Workflow, component: WorkLivePage },
    ],
  },
  {
    ...paired,
    id: 'execution',
    title: 'execution',
    description:
      "operations the server's workers ran for these tasks, with the worker and fencing token that held the lease.",
    icon: Server,
    pages: [
      {
        id: 'execution',
        title: 'execution',
        icon: Server,
        component: ExecutionLivePage,
      },
    ],
  },
  {
    ...paired,
    id: 'methods',
    title: 'methods',
    description:
      "the server's capability packs, at the versions it runs. Hand one a file of this workspace.",
    icon: Blocks,
    pages: [
      {
        id: 'methods',
        title: 'methods',
        icon: Blocks,
        component: MethodsLivePage,
      },
    ],
  },
];

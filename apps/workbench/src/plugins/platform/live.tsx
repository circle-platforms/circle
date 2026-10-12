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
import { serverView } from '../server';
import type { WorkbenchPlugin } from '../types';

// The four platform objects as the paired circle-server extension last read them from the
// server (/server refresh). The server decides what you may see; nothing here is local.
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
  }[];
}
const short = (hash?: string) => (hash ? hash.slice(0, 12) + '…' : '');

function useObjects() {
  const { snapshot, runtime, perform } = useRuntime();
  const view = serverView(snapshot.extensions);
  const objects = (view as { objects?: Objects } | undefined)?.objects;
  // Every action is the extension's own /server command; its lines go to the conversation.
  const run = (args: string) =>
    perform(async () => {
      await runtime.command('server', args);
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
      action={<Button onClick={() => run('refresh')}>refresh</Button>}
    >
      {!view?.signedIn ? (
        <EmptyState title="not signed in">
          Sign in on the circle-server page; the server decides what you may
          see.
        </EmptyState>
      ) : !objects ? (
        <EmptyState title="nothing read yet">
          refresh reads it from {view.url}.
        </EmptyState>
      ) : (
        <>
          <p className="panel-note">
            read from {view.url} as {view.username} at{' '}
            {new Date(objects.refreshedAt).toLocaleTimeString()}
          </p>
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
      title="work"
      description="C · tasks as the server holds them: their phase, what they wait on, and approvals bound to an input revision."
    >
      {(objects, run) =>
        objects.work.length ? (
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
                    aria-label={`follow ${task.taskId}`}
                    onClick={() => run(`task ${task.taskId}`)}
                  >
                    follow
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
                      aria-label={`send answer ${item.requestId}`}
                    >
                      answer
                    </Button>
                  </form>
                ))}
                {task.approvals.map((approval) => (
                  <div className="detail-title" key={approval.approvalId}>
                    <div>
                      <h2>approval {approval.approvalId}</h2>
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
                          aria-label={`approve ${approval.approvalId}`}
                          onClick={() =>
                            run(`approve ${task.taskId} ${approval.approvalId}`)
                          }
                        >
                          approve
                        </Button>
                        <Button
                          aria-label={`reject ${approval.approvalId}`}
                          onClick={() =>
                            run(`reject ${task.taskId} ${approval.approvalId}`)
                          }
                        >
                          reject
                        </Button>
                      </>
                    )}
                  </div>
                ))}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="no work">
            Nothing you may read on this server yet.
          </EmptyState>
        )
      }
    </Frame>
  );
}

export function ExecutionLivePage() {
  return (
    <Frame
      title="execution"
      description="D · operations the server's workers ran for these tasks, with the worker and fencing token that held the lease."
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
                          aria-label={`reconcile ${task.taskId}`}
                          onClick={() => run(`reconcile ${task.taskId}`)}
                        >
                          reconcile
                        </Button>
                      )}
                    </div>
                  ))}
                </article>
              ))}
          </div>
        ) : (
          <EmptyState title="no operations">
            No worker has run anything for these tasks.
          </EmptyState>
        )
      }
    </Frame>
  );
}

export function KnowledgeLivePage() {
  return (
    <Frame
      title="knowledge"
      description="B · each task's source, artifacts and evidence, by revision and SHA-256, and the server's own check."
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
                      aria-label={`save results of ${task.taskId}`}
                      onClick={() => run(`get ${task.taskId}`)}
                    >
                      save results
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
                  <DataBlock title="unmapped" value={task.unmapped} />
                )}
              </article>
            ))}
          </div>
        ) : (
          <EmptyState title="no knowledge">
            No task you may read has sources or results yet.
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
      title="methods"
      description="E · the server's capability packs, at the versions it runs. Hand one a file of this workspace."
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
                      placeholder="file in the workspace"
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
                      hand over
                    </Button>
                  </form>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState title="no capability packs">
              The server lists none you may use.
            </EmptyState>
          )}
          <ServerTools objects={objects} />
        </>
      )}
    </Frame>
  );
}

// What else the server offers: the tools the model has from it, and pushed skill packs.
function ServerTools({ objects }: { objects: Objects }) {
  const tools = objects.tools ?? [];
  const packs = objects.skillPacks ?? [];
  return (
    <>
      <p className="panel-note">
        {tools.length
          ? `${tools.length} server tools the model can use: ` +
            tools
              .map(
                (tool) => `${tool.remote}${tool.write ? ' (asks first)' : ''}`,
              )
              .join(', ')
          : 'This server offers the model no tools.'}
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
                    skill pack {pack.id ?? pack.skillPackId}{' '}
                    {pack.version ?? ''}
                  </h2>
                  <p>{pack.skillPackId}</p>
                </div>
                <Status value={pack.status ?? 'unknown'} />
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
  runtimeExtension: 'circle-server',
};
/** B, C, D and E as the server holds them, paired with the circle-server extension. */
export const livePlatformPlugins: WorkbenchPlugin[] = [
  {
    ...paired,
    id: 'knowledge',
    title: 'knowledge',
    description:
      'B · sources, artifacts and evidence of your tasks on circle-server, by revision and SHA-256.',
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
      'C · tasks on circle-server: phases, questions they wait on and approvals bound to a revision.',
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
      'D · operations circle-server workers ran, with their leases and outcomes.',
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
      'E · capability packs circle-server runs, at their versions; hand one a file.',
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

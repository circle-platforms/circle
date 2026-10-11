import { matchingAction } from '../model/shortcuts';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Paperclip,
  Plus,
  Square,
  Play,
  MoreHorizontal,
  Search,
  Brain,
  Code,
  FileText,
  X,
  ArrowRight,
  Check,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { BUILTIN_SLASH } from '../../../../src/tui/slash_commands';
import { useRuntime } from '../app/context';
import { currentSession, visibleMessages, EFFORTS } from '../model/state';
import { fullTime, shownTime } from '../model/time';
import type { Attachment, DialogId, PanelId } from '../model/types';
import { Button, IconButton, FileChip, Status } from '../components/common';
import { Markdown } from '../components/Markdown';
import { ToolMessage } from '../components/ToolMessage';
interface Props {
  onDialog: (dialog: DialogId, selection?: string) => void;
  onPanel: (panel: PanelId, selection?: string) => void;
  onAgent: (id: string) => void;
  onFile: (path: string) => void;
  onAttach: () => void;
  onCommand: () => void;
}
const MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
]);
const MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const mediaFiles = (files: FileList): File[] =>
  Array.from(files).filter((file) => MEDIA_TYPES.has(file.type));
export function Conversation({
  onDialog,
  onPanel,
  onAgent,
  onFile,
  onAttach,
  onCommand,
}: Props) {
  const { snapshot, runtime, perform, act, notify } = useRuntime();
  const session = currentSession(snapshot);
  const { registry, enabled } = usePlugins();
  const contributions = registry.widgets(enabled, 'composerActions');
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const messages = visibleMessages(session);
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const [find, setFind] = useState('');
  const [finding, setFinding] = useState(false);
  const [findIndex, setFindIndex] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [planCollapsed, setPlanCollapsed] = useState(false);
  useEffect(() => setPlanCollapsed(false), [session.id]);
  // Pictures and PDFs pasted or dropped on the box go with the message, as attached ones do
  const addMedia = async (files: File[]) => {
    for (const file of files) {
      if (file.size > MAX_MEDIA_BYTES) {
        notify(`${file.name || 'picture'} is over 20 MB`);
        continue;
      }
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      perform(() =>
        runtime.change((state) => {
          const target = currentSession(state);
          const count =
            target.attachments.filter((item) => item.kind === 'image').length +
            1;
          target.attachments.push({
            id: crypto.randomUUID(),
            name:
              file.name && file.name !== 'image.png'
                ? file.name
                : `pasted image ${count}.png`,
            kind: file.type === 'application/pdf' ? 'document' : 'image',
            content,
            mime: file.type,
            size: file.size,
          });
        }),
      );
    }
    input.current?.focus();
  };
  const lastEscape = useRef(0);
  const savedDraft = useRef('');
  const latestView = useRef({ session, onDialog, onPanel });
  latestView.current = { session, onDialog, onPanel };
  const matches = messages.filter((message) =>
    (message.text + ' ' + (message.tool?.output ?? ''))
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .includes(find.toLowerCase().replace(/\s+/g, ' ')),
  );
  const slash = session.draft.startsWith('/') && !session.draft.includes(' ');
  const mention = session.draft.match(/(?:^|\s)@([^\s]*)$/)?.[1];
  const completions = slash
    ? [
        ...BUILTIN_SLASH.map((item) => ({
          name: '/' + item.name,
          description: item.description,
          kind: 'command',
        })),
        ...snapshot.skills.map((item) => ({
          name: '/skill:' + item.name,
          description: item.description,
          kind: 'command',
        })),
        ...snapshot.commands.map((item) => ({
          name: '/' + item.name,
          description: item.description,
          kind: 'command',
        })),
      ]
        .filter((item) =>
          item.name.toLowerCase().includes(session.draft.toLowerCase()),
        )
        .slice(0, 7)
    : mention !== undefined
      ? snapshot.files
          .filter(
            (file) =>
              file.workspaceId === session.workspaceId &&
              file.path.includes(mention),
          )
          .map((file) => ({
            name: '@' + file.path,
            description: file.language,
            kind: 'file',
          }))
          .slice(0, 7)
      : [];
  const setDraft = (value: string) =>
    perform(() =>
      runtime.change((state) => {
        currentSession(state).draft = value;
      }),
    );
  const chooseCompletion = (index: number, send = false) => {
    const item = completions[index];
    if (!item) return;
    if (item.kind === 'file')
      setDraft(session.draft.replace(/@[^\s]*$/, item.name + ' '));
    else {
      setDraft(item.name + ' ');
      if (send) act(() => runtime.send());
    }
    setDismissed(true);
    input.current?.focus();
  };
  useEffect(() => {
    if (input.current) {
      input.current.style.height = 'auto';
      input.current.style.height =
        Math.min(input.current.scrollHeight, 180) + 'px';
    }
    setDismissed(false);
    setCompletionIndex(0);
  }, [session.draft]);
  // The transcript follows its end while you are there: as a reply streams in, as messages
  // arrive, as the window changes size. Scroll up and it stays where you are; scroll back
  // down, or send a message, and it follows again. Whether you are at the end is measured
  // against the height of its last follow, so content that grows before a scroll event
  // arrives does not count as scrolling away, and it does not wait for a frame to be drawn:
  // a window behind others gets no frames.
  const stuck = useRef(true);
  const height = useRef(0);
  const follow = (force = false) => {
    const box = scroller.current;
    if (!box) return;
    if (force) stuck.current = true;
    if (stuck.current)
      box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
    height.current = box.scrollHeight;
  };
  useEffect(() => {
    const box = scroller.current;
    const content = column.current;
    if (!box || !content) return;
    const scrolled = () => {
      stuck.current = height.current - box.scrollTop - box.clientHeight < 48;
    };
    box.addEventListener('scroll', scrolled, { passive: true });
    const resized = new ResizeObserver(() => follow());
    resized.observe(content);
    resized.observe(box);
    return () => {
      box.removeEventListener('scroll', scrolled);
      resized.disconnect();
    };
  }, []);
  const last = messages.at(-1);
  const lastRole = last?.role;
  const lastSize = (last?.text.length ?? 0) + (last?.thinking?.length ?? 0);
  useLayoutEffect(() => follow(true), [session.id]);
  // A message you just sent brings the end back into view
  const count = useRef(messages.length);
  useLayoutEffect(() => {
    const sent = messages.length > count.current && lastRole === 'user';
    count.current = messages.length;
    follow(sent);
  }, [messages.length, lastRole, lastSize, session.state]);
  useEffect(() => setFinding(false), [session.id, messages.length]);
  useEffect(() => {
    if (find && matches.length) {
      const target = scroller.current?.querySelector(
        `[data-message-id="${matches[findIndex % matches.length]?.id}"]`,
      );
      target?.scrollIntoView({ block: 'center' });
    }
  }, [find, findIndex]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const current = latestView.current.session;
      const control = event.ctrlKey || event.metaKey;
      const mapped = matchingAction(event, snapshot.settings.keybindings);
      if (mapped) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const commands: Record<string, string> = {
          'model.select': 'models',
          'thinking.toggle': 'thinking',
          'tools.expand': 'details',
          'editor.external': 'editor',
          'message.copy': 'copy',
          unused: 'help',
        };
        if (commands[mapped]) act(() => runtime.command(commands[mapped]!));
        else if (mapped === 'find') setFinding((value) => !value);
        else if (mapped === 'history.search') onCommand();
        else if (mapped === 'exit') onDialog('exit');
        else if (mapped === 'secret.enter') onDialog('secret');
        else if (mapped === 'suspend' || mapped === 'job.background') {
          runtime.request(mapped === 'suspend' ? 'suspend' : 'background');
          notify('host request recorded; no process changed');
        } else if (mapped === 'message.followup')
          act(() => runtime.send('follow-up'));
        else if (mapped === 'message.dequeue')
          perform(() =>
            runtime.change((state) => {
              const target = currentSession(state);
              target.draft =
                target.queue.map((item) => item.text).join('\n') +
                '\n' +
                target.draft;
              target.queue = [];
            }),
          );
        else if (mapped === 'interrupt') {
          perform(() =>
            runtime.change((state) => {
              currentSession(state).state = 'paused';
            }),
          );
          runtime.request('abort');
        } else if (mapped === 'clear') setDraft('');
        else if (mapped === 'newline') setDraft(current.draft + '\n');
        else if (mapped === 'thinking.cycle')
          perform(() =>
            runtime.change((state) => {
              const target = currentSession(state);
              target.effort =
                EFFORTS[(EFFORTS.indexOf(target.effort) + 1) % EFFORTS.length]!;
            }),
          );
        else if (mapped === 'model.cycle') {
          const next =
            snapshot.models[
              (snapshot.models.findIndex(
                (model) => model.id === current.model,
              ) +
                1) %
                snapshot.models.length
            ];
          if (next)
            perform(() =>
              runtime.change((state) => {
                currentSession(state).model = next.id;
              }),
            );
        }
        return;
      }
      if (control && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFinding((value) => !value);
        return;
      }
      if (control && event.key.toLowerCase() === 'o') {
        event.preventDefault();
        act(() => runtime.command('details'));
      }
      if (control && event.key.toLowerCase() === 't') {
        event.preventDefault();
        act(() => runtime.command('thinking'));
      }
      if (control && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        act(() => runtime.command('models'));
      }
      if (control && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        onCommand();
      }
      if (control && event.key.toLowerCase() === 'g') {
        event.preventDefault();
        onDialog('editor');
      }
      if (control && event.key.toLowerCase() === 's') {
        event.preventDefault();
        onDialog('secret');
      }
      if (control && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        const models = snapshot.models.filter(
          (model) =>
            !snapshot.settings.enabledModels.length ||
            snapshot.settings.enabledModels.includes(model.id),
        );
        const next =
          models[
            (models.findIndex((model) => model.id === current.model) + 1) %
              models.length
          ];
        if (next)
          perform(() =>
            runtime.change((state) => {
              currentSession(state).model = next.id;
            }),
          );
      }
      if (control && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        runtime.request('background');
        notify('background request recorded; no process was changed');
      }
      if (
        control &&
        event.key.toLowerCase() === 'x' &&
        !window.getSelection()?.toString()
      ) {
        event.preventDefault();
        act(() => runtime.command('copy'));
      }
    };
    addEventListener('keydown', handler);
    return () => removeEventListener('keydown', handler);
  }, [
    runtime,
    snapshot.models,
    snapshot.settings.enabledModels,
    snapshot.settings.keybindings,
  ]);
  const jobs = snapshot.jobs.filter(
    (job) =>
      job.sessionId === session.id &&
      ['running', 'waiting'].includes(job.state),
  );
  const agents = snapshot.agents.filter(
    (agent) => agent.sessionId === session.id && agent.status !== 'completed',
  );
  const pending = snapshot.interactions.filter(
    (item) => item.sessionId === session.id && item.status === 'pending',
  );
  const model = snapshot.models.find((item) => item.id === session.model);
  const stats = messages.reduce(
    (sum, message) => ({
      input: sum.input + (message.usage?.input ?? 0),
      output: sum.output + (message.usage?.output ?? 0),
    }),
    { input: 0, output: 0 },
  );
  return (
    <section className="conversation">
      <header className="conversation-heading">
        <div>
          <h1>{session.title}</h1>
          <span>
            {workspace.name}
            <i />
            {runtime.mode === 'live'
              ? snapshot.runtime?.connected
                ? 'connected'
                : 'disconnected'
              : 'sample session'}
          </span>
        </div>
        <div className="heading-actions">
          <IconButton
            label="find in conversation"
            onClick={() => setFinding(!finding)}
          >
            <Search size={15} />
          </IconButton>
          <IconButton label="session tree" onClick={() => onDialog('tree')}>
            <GitBranch size={15} />
          </IconButton>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="icon-button" aria-label="session actions">
                <MoreHorizontal size={17} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="dropdown" sideOffset={7}>
                {[
                  ['rename', 'name'],
                  ['session details', 'session'],
                  ['fork', 'fork'],
                  ['clone', 'clone'],
                  ['undo on screen', 'undo'],
                  ['redo on screen', 'redo'],
                  ['compact context', 'compact'],
                  ['export', 'export'],
                  ['share locally', 'share'],
                ].map(([label, command]) => (
                  <DropdownMenu.Item
                    key={command}
                    onSelect={() => act(() => runtime.command(command!))}
                  >
                    {label}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </header>
      {finding && (
        <div className="find-bar">
          <Search size={14} />
          <input
            autoFocus
            aria-label="find text"
            placeholder="find in conversation"
            value={find}
            onChange={(event) => {
              setFind(event.target.value);
              setFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                setFindIndex(
                  (value) => value + (event.shiftKey ? -1 : 1) + matches.length,
                );
              }
              if (event.key === 'Escape') setFinding(false);
            }}
          />
          <span>
            {find
              ? `${matches.length ? (findIndex % matches.length) + 1 : 0} / ${matches.length}`
              : 'type to search'}
          </span>
          <IconButton
            label="next match"
            onClick={() => setFindIndex((value) => value + 1)}
          >
            <ArrowRight size={13} />
          </IconButton>
          <IconButton label="close find" onClick={() => setFinding(false)}>
            <X size={13} />
          </IconButton>
        </div>
      )}
      <div className="transcript" ref={scroller}>
        <div className="transcript-column" ref={column}>
          {messages.length === 0 ? (
            <div className="welcome">
              <span className="circle-logo large" />
              <h2>what are we working on?</h2>
              <p>
                Start with a message, a file, or a question about your project.
              </p>
              <button
                onClick={() => onDialog('trust')}
                className="workspace-trust"
              >
                <Status value={workspace.trusted ? 'trusted' : 'not trusted'} />
                {workspace.path}
              </button>
              <div className="welcome-context">
                {workspace.instructions.map((item) => (
                  <button key={item.name} onClick={() => onPanel('context')}>
                    <FileText size={13} />
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                data-message-id={message.id}
                className={
                  find && matches[findIndex % matches.length]?.id === message.id
                    ? 'find-match'
                    : ''
                }
              >
                {message.role === 'tool' && message.tool ? (
                  <ToolMessage
                    tool={message.tool}
                    expanded={session.expandTools}
                    onAgent={onAgent}
                    onFile={onFile}
                  />
                ) : message.role === 'notice' ? (
                  <div className="transcript-notice">{message.text}</div>
                ) : (
                  <article className={`message ${message.role}`}>
                    <header>
                      <span
                        className={
                          message.role === 'user' ? 'user-mark' : 'agent-mark'
                        }
                      >
                        {message.role === 'user' ? (
                          'you'
                        ) : (
                          <span className="circle-logo small" />
                        )}
                      </span>
                      <strong>
                        {message.role === 'user' ? 'you' : 'circle'}
                      </strong>
                      <time
                        dateTime={fullTime(message.at) && message.at}
                        title={fullTime(message.at)}
                      >
                        {shownTime(message.at)}
                      </time>
                      {message.label && (
                        <span className="label">{message.label}</span>
                      )}
                    </header>
                    {message.thinking && (
                      <details className="thinking" open={session.showThinking}>
                        <summary>
                          <Brain size={13} />
                          thinking
                        </summary>
                        <p>{message.thinking}</p>
                      </details>
                    )}
                    <Markdown text={message.text} />
                    {message.attachments?.length ? (
                      <div className="message-attachments">
                        {message.attachments.map((file) => (
                          <FileChip
                            key={file.id}
                            name={file.name}
                            onClick={() => onPanel('context')}
                          />
                        ))}
                      </div>
                    ) : null}
                    {message.usage && (
                      <footer>
                        {[
                          message.usage.elapsed,
                          `↑ ${message.usage.input.toLocaleString()}`,
                          `↓ ${message.usage.output.toLocaleString()}`,
                          message.usage.cost === null
                            ? 'cost N/A'
                            : '$' + message.usage.cost.toFixed(4),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </footer>
                    )}
                  </article>
                )}
              </div>
            ))
          )}
          {session.state === 'waiting' && (
            <div className="pending-message">
              <i />
              {runtime.mode === 'live'
                ? pending.length
                  ? 'waiting for your response'
                  : 'working'
                : 'waiting for runtime connection'}
              {runtime.mode === 'preview' && (
                <button onClick={() => onDialog('connect')}>
                  connection settings
                  <ArrowRight size={12} />
                </button>
              )}
            </div>
          )}
          {session.state === 'paused' && (
            <div className="pending-message">
              local conversation paused · remote state unverified
            </div>
          )}
        </div>
      </div>
      <div className="composer-area">
        {session.todos.length > 0 && (
          <div className="plan">
            <button
              className="plan-title"
              aria-label="toggle plan"
              aria-expanded={!planCollapsed}
              onClick={() => setPlanCollapsed((value) => !value)}
            >
              <span>plan</span>
              <span>
                {
                  session.todos.filter((todo) => todo.status === 'completed')
                    .length
                }{' '}
                / {session.todos.length}
                {planCollapsed ? (
                  <ChevronRight size={12} />
                ) : (
                  <ChevronDown size={12} />
                )}
              </span>
            </button>
            {!planCollapsed && (
              <div className="plan-items">
                {session.todos.map((todo) => (
                  <div key={todo.id} className={todo.status}>
                    <span>
                      {todo.status === 'completed' ? (
                        <Check size={12} />
                      ) : (
                        <i />
                      )}
                    </span>
                    {todo.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        {pending.length > 0 && (
          <button
            className="interaction-summary"
            onClick={() => onPanel('activity', pending[0]!.id)}
          >
            <Status value="waiting" />
            <span>
              {pending.length}{' '}
              {runtime.mode === 'live'
                ? 'requests to review'
                : 'sample requests to review'}
            </span>
            <ArrowRight size={13} />
          </button>
        )}
        {session.queue.length > 0 && (
          <div className="queue">
            {session.queue.map((item) => (
              <div key={item.id}>
                <span>{item.kind}</span>
                <p>{item.text}</p>
                <IconButton
                  label={`remove queued ${item.kind}`}
                  onClick={() =>
                    perform(() =>
                      runtime.change((state) => {
                        currentSession(state).queue = currentSession(
                          state,
                        ).queue.filter((queued) => queued.id !== item.id);
                      }),
                    )
                  }
                >
                  <X size={12} />
                </IconButton>
              </div>
            ))}
            <button
              className="text-button"
              onClick={() =>
                perform(() =>
                  runtime.change((state) => {
                    const target = currentSession(state);
                    target.draft =
                      target.queue.map((item) => item.text).join('\n') +
                      '\n' +
                      target.draft;
                    target.queue = [];
                  }),
                )
              }
            >
              return queued messages to draft
            </button>
          </div>
        )}
        <div
          className="composer"
          data-state={session.state}
          onDragOver={(event) => {
            if (Array.from(event.dataTransfer.types).includes('Files'))
              event.preventDefault();
          }}
          onDrop={(event) => {
            const files = mediaFiles(event.dataTransfer.files);
            if (!files.length) return;
            event.preventDefault();
            void addMedia(files);
          }}
        >
          {!dismissed && completions.length > 0 && (
            <div
              className="completion-list"
              role="listbox"
              aria-label="input completions"
            >
              {completions.map((item, index) => (
                <button
                  key={item.name}
                  role="option"
                  aria-selected={index === completionIndex}
                  className={index === completionIndex ? 'selected' : ''}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => chooseCompletion(index)}
                >
                  <span>{item.name}</span>
                  <small>{item.description}</small>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            aria-label="message"
            placeholder="Ask anything, or describe a change…"
            value={session.draft}
            onChange={(event) => setDraft(event.target.value)}
            onPaste={(event) => {
              const files = mediaFiles(event.clipboardData.files);
              if (files.length) {
                event.preventDefault();
                void addMedia(files);
                return;
              }
              const text = event.clipboardData.getData('text');
              if (text.length > 800 || text.split('\n').length > 3) {
                event.preventDefault();
                const id = crypto.randomUUID();
                const marker = `[pasted text ${session.attachments.filter((file) => file.kind === 'paste').length + 1} · ${text.split('\n').length} lines]`;
                perform(() =>
                  runtime.change((state) => {
                    const target = currentSession(state);
                    target.attachments.push({
                      id,
                      name: marker,
                      kind: 'paste',
                      content: text,
                    });
                    target.draft += marker;
                  }),
                );
              }
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (!dismissed && completions.length) {
                if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
                  event.preventDefault();
                  setCompletionIndex(
                    (index) =>
                      (index +
                        (event.key === 'ArrowDown' ? 1 : -1) +
                        completions.length) %
                      completions.length,
                  );
                  return;
                }
                if (
                  event.key === 'Tab' ||
                  (event.key === 'Enter' && !event.shiftKey)
                ) {
                  event.preventDefault();
                  chooseCompletion(
                    completionIndex,
                    event.key === 'Enter' && slash,
                  );
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setDismissed(true);
                  return;
                }
              }
              if (event.shiftKey && event.key === 'Tab') {
                event.preventDefault();
                perform(() =>
                  runtime.change((state) => {
                    const target = currentSession(state);
                    target.effort =
                      EFFORTS[
                        (EFFORTS.indexOf(target.effort) + 1) % EFFORTS.length
                      ]!;
                  }),
                );
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (session.draft.endsWith('\\'))
                  setDraft(session.draft.slice(0, -1) + '\n');
                else
                  act(() =>
                    runtime.send(event.altKey ? 'follow-up' : 'steering'),
                  );
                return;
              }
              if (event.ctrlKey && event.key === 'q') {
                event.preventDefault();
                act(() => runtime.send('follow-up'));
                return;
              }
              if (event.ctrlKey && event.key === 'j') {
                event.preventDefault();
                setDraft(session.draft + '\n');
                return;
              }
              if (event.altKey && event.key === 'ArrowUp') {
                event.preventDefault();
                perform(() =>
                  runtime.change((state) => {
                    const target = currentSession(state);
                    target.draft =
                      target.queue.map((item) => item.text).join('\n') +
                      '\n' +
                      target.draft;
                    target.queue = [];
                  }),
                );
                return;
              }
              if (event.key === '?' && !session.draft) {
                event.preventDefault();
                onDialog('hotkeys');
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                if (session.state === 'waiting') {
                  perform(() =>
                    runtime.change((state) => {
                      currentSession(state).state = 'paused';
                    }),
                  );
                  runtime.request('abort');
                } else if (session.draft) setDraft('');
                else {
                  if (
                    Date.now() - lastEscape.current < 500 &&
                    snapshot.settings.doubleEscape !== 'none'
                  )
                    onDialog(snapshot.settings.doubleEscape);
                  lastEscape.current = Date.now();
                }
                return;
              }
              if (
                event.key === 'ArrowUp' &&
                event.currentTarget.selectionStart === 0
              ) {
                const history = session.messages
                  .filter((message) => message.role === 'user')
                  .map((message) => message.text)
                  .reverse();
                if (history.length) {
                  event.preventDefault();
                  if (historyIndex === -1) savedDraft.current = session.draft;
                  const next = Math.min(historyIndex + 1, history.length - 1);
                  setHistoryIndex(next);
                  setDraft(history[next]!);
                }
              } else if (event.key === 'ArrowDown' && historyIndex >= 0) {
                event.preventDefault();
                const history = session.messages
                  .filter((message) => message.role === 'user')
                  .map((message) => message.text)
                  .reverse();
                const next = historyIndex - 1;
                setHistoryIndex(next);
                setDraft(next < 0 ? savedDraft.current : (history[next] ?? ''));
              }
            }}
          />
          {session.attachments.length > 0 && (
            <div className="attachment-strip">
              {session.attachments.map((file) => (
                <FileChip
                  key={file.id}
                  name={file.name}
                  onClick={() => onPanel('context', file.id)}
                  onRemove={() =>
                    perform(() =>
                      runtime.change((state) => {
                        currentSession(state).attachments = currentSession(
                          state,
                        ).attachments.filter((item) => item.id !== file.id);
                      }),
                    )
                  }
                />
              ))}
            </div>
          )}
          <div className="composer-toolbar">
            <div>
              {contributions.map(({ plugin, widget }) => (
                <PluginBoundary key={widget.id} name={plugin.title}>
                  <widget.component sessionId={session.id} />
                </PluginBoundary>
              ))}
              <IconButton label="attach files" onClick={onAttach}>
                <Plus size={17} />
              </IconButton>
              <button
                className="text-button model-button"
                onClick={() => act(() => runtime.command('models'))}
              >
                {session.model}
                <ChevronDown size={11} />
              </button>
              <button
                className="text-button"
                onClick={() => act(() => runtime.command('effort'))}
              >
                {session.effort}
                <ChevronDown size={11} />
              </button>
            </div>
            <div>
              <button
                className={`mode-button ${session.readOnly ? 'active' : ''}`}
                onClick={() => act(() => runtime.command('plan'))}
              >
                {session.readOnly ? 'read-only' : session.auto ? 'auto' : 'ask'}
              </button>
              {session.state === 'waiting' ? (
                <IconButton
                  label="pause conversation"
                  onClick={() => {
                    perform(() =>
                      runtime.change((state) => {
                        currentSession(state).state = 'paused';
                      }),
                    );
                    runtime.request('abort');
                  }}
                >
                  <Square size={13} />
                </IconButton>
              ) : session.state === 'paused' ? (
                <IconButton
                  label="resume conversation"
                  onClick={() => {
                    perform(() =>
                      runtime.change((state) => {
                        currentSession(state).state = 'waiting';
                      }),
                    );
                    runtime.request('resume');
                  }}
                >
                  <Play size={14} />
                </IconButton>
              ) : null}
              <button
                className="send"
                aria-label="send message"
                disabled={!session.draft.trim()}
                onClick={() => act(() => runtime.send())}
              >
                <ArrowUp size={17} />
              </button>
            </div>
          </div>
        </div>
        <div className="usage-bar">
          <span>
            ↑ {stats.input.toLocaleString()} · ↓ {stats.output.toLocaleString()}{' '}
            <i />
            cost N/A <i />
            ctx{' '}
            {model?.contextWindow
              ? Math.round(
                  ((stats.input + stats.output) / model.contextWindow) * 100,
                ) + '%'
              : 'N/A'}
          </span>
          <button
            onClick={() =>
              onDialog(runtime.mode === 'live' ? 'session' : 'preview')
            }
          >
            {runtime.mode === 'live' ? 'session details' : 'frontend preview'}
          </button>
        </div>
        {(jobs.length > 0 || agents.length > 0) && (
          <div className="running-strip">
            {agents.slice(0, 2).map((agent) => (
              <button key={agent.id} onClick={() => onAgent(agent.id)}>
                <span className="agent-dot" />
                <strong>{agent.name}</strong>
                <span>{agent.description}</span>
              </button>
            ))}
            {jobs.slice(0, 2).map((job) => (
              <button key={job.id} onClick={() => onPanel('activity', job.id)}>
                <Status value={job.state} />
                <strong>{job.id}</strong>
                <span>{job.title}</span>
                <small>{job.elapsed}</small>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

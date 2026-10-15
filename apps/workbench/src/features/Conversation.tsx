import { matchingAction } from '../model/shortcuts';
import { planVisible } from '../../../../src/plan_state';
import { agentActivityText } from '../model/activity';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { slashText } from '../model/slash-text';
import { useRuntime } from '../app/context';
import { currentSession, visibleMessages, EFFORTS } from '../model/state';
import { fullTime, shownTime } from '../model/time';
import type { Attachment, DialogId, Message, PanelId } from '../model/types';
import { Button, IconButton, FileChip, Status } from '../components/common';
import { Markdown } from '../components/Markdown';
import { ToolGroup, TurnRow } from '../components/ToolGroup';
import { RecoveredInputs } from './RecoveredInputs';
import { WindowedList } from '../components/WindowedList';
import type { ReactNode, RefObject } from 'react';
import { MessageView } from '../components/MessageView';
import {
  BrowserDialogRequest,
  BrowserHandoffRequest,
  CertificateChoiceRequest,
} from './BrowserDialog';
import { useBrowserState } from './useBrowserState';
import { InlineRequest } from './InlineRequest';
import {
  ContextRing,
  EffortMenu,
  ModeMenu,
  ModelMenu,
  MODE_TEXT,
} from './Composer';
import { nextMode, sessionMode } from '../model/state';
import type { SessionMode } from '../model/types';
import { t, tn } from '../i18n';
import {
  saveSessionScroll,
  useSessionPresentation,
} from '../model/presentation';
interface Props {
  onDialog: (dialog: DialogId, selection?: string) => void;
  onPanel: (panel: PanelId, selection?: string) => void;
  onAgent: (id: string) => void;
  onFile: (path: string) => void;
  onAttach: () => void;
  onCommand: () => void;
  finding: boolean;
  setFinding: (value: boolean | ((value: boolean) => boolean)) => void;
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
// A transcript item: a message, or the tool calls between two messages, folded together.
type TranscriptItem =
  | { kind: 'message'; message: Message }
  | { kind: 'tools'; id: string; rows: Message[] };
function groupMessages(messages: Message[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  // An answer with no words of its own, only thinking before its calls, folds in with
  // them: a turn reads as your message, a few folded lines, and the answer.
  const quiet = (message: Message) =>
    message.role === 'assistant' &&
    message.at !== 'streaming' &&
    !message.text.trim() &&
    !message.attachments?.length;
  for (const message of messages) {
    const last = items.at(-1);
    if ((message.role === 'tool' && message.tool) || quiet(message)) {
      if (last?.kind === 'tools') last.rows.push(message);
      // Keyed by the message the calls follow, which stays when a call's result arrives.
      else
        items.push({
          kind: 'tools',
          id: 'tools-' + (message.parentId ?? message.id),
          rows: [message],
        });
    } else items.push({ kind: 'message', message });
  }
  return items;
}
const transcriptKey = (item: TranscriptItem) =>
  item.kind === 'tools' ? item.id : item.message.id;
function TranscriptList({
  items,
  renderItem,
  scrollRef,
  revealIndex,
}: {
  items: TranscriptItem[];
  renderItem: (item: TranscriptItem, index: number) => ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
  revealIndex?: number;
}) {
  return items.length < 500 ? (
    items.map(renderItem)
  ) : (
    <WindowedList
      items={items}
      itemKey={transcriptKey}
      renderItem={renderItem}
      scrollRef={scrollRef}
      revealIndex={revealIndex}
    />
  );
}
// How a queued message goes: steering joins the running turn, a follow-up waits for its end.
const QUEUE_KIND: Record<string, () => string> = {
  steering: () => t('steering'),
  'follow-up': () => t('follow-up'),
};
export function Conversation({
  onDialog,
  onPanel,
  onAgent,
  onFile,
  onAttach,
  onCommand,
  finding,
  setFinding,
}: Props) {
  const { snapshot, runtime, perform, act, notify } = useRuntime();
  const session = currentSession(snapshot);
  const { registry, enabled } = usePlugins();
  const contributions = registry.widgets(enabled, 'composerActions');
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const messages = useMemo(
    () => visibleMessages(session),
    [session.messages, session.branchIds, session.hiddenIds, session.leafId],
  );
  const composerWritable =
    !session.archivedAt &&
    session.lifecycle !== 'deleting' &&
    !session.occupied;
  const input = useRef<HTMLTextAreaElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const column = useRef<HTMLDivElement>(null);
  const [editingQueue, setEditingQueue] = useState<{
    id: string;
    text: string;
    original: string;
    version?: number;
  } | null>(null);
  const [find, setFind] = useState('');
  const [findIndex, setFindIndex] = useState(0);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const { view, update: updateView } = useSessionPresentation();
  const presentationEpoch = runtime.presentationEpoch;
  const planCollapsed = view.planCollapsed ?? false;
  const setPlanCollapsed = (
    value: boolean | ((previous: boolean) => boolean),
  ) =>
    updateView((target) => {
      target.planCollapsed =
        typeof value === 'function'
          ? value(target.planCollapsed ?? false)
          : value;
    });
  const planItems = useRef<HTMLDivElement>(null);
  // Native snapshots recreate arrays; unrelated events must not undo manual scrolling.
  const planVersion = JSON.stringify(session.todos);
  // The plan shows a few rows: the step under way, or else the next one, stays in sight
  useEffect(() => {
    const list = planItems.current;
    const step =
      list?.querySelector<HTMLElement>(':scope > .running') ??
      list?.querySelector<HTMLElement>(':scope > .pending');
    if (!list || !step) return;
    // From the boxes, which keep fractions of a pixel: the rows shown stay whole
    const view = list.getBoundingClientRect();
    const box = step.getBoundingClientRect();
    if (box.top < view.top) list.scrollTop += box.top - view.top;
    else if (box.bottom > view.bottom)
      list.scrollTop += box.bottom - view.bottom;
  }, [planVersion, planCollapsed]);
  // Pictures and PDFs pasted or dropped on the box go with the message, as attached ones do
  const addMedia = async (files: File[]) => {
    for (const file of files) {
      if (file.size > MAX_MEDIA_BYTES) {
        notify(t('{name} is over 20 MB', { name: file.name || t('picture') }));
        continue;
      }
      const content = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      perform(() => {
        const target = runtime
          .getSnapshot()
          .sessions.find((item) => item.id === session.id);
        if (!target || target.lifecycle === 'deleting') return;
        const count =
          target.attachments.filter((item) => item.kind === 'image').length + 1;
        runtime.updateSessionView(session.id, {
          attachments: [
            ...target.attachments,
            {
              id: crypto.randomUUID(),
              name:
                file.name && file.name !== 'image.png'
                  ? file.name
                  : `pasted image ${count}.png`,
              kind: file.type === 'application/pdf' ? 'document' : 'image',
              content,
              mime: file.type,
              size: file.size,
            },
          ],
        });
      });
    }
    if (runtime.getSnapshot().activeSessionId === session.id)
      input.current?.focus();
  };
  const lastEscape = useRef(0);
  const savedDraft = useRef('');
  useEffect(() => {
    setHistoryIndex(-1);
    setEditingQueue(null);
    savedDraft.current = '';
    lastEscape.current = 0;
    setFind('');
    setFindIndex(0);
  }, [session.id]);
  const latestView = useRef({ session, onDialog, onPanel });
  latestView.current = { session, onDialog, onPanel };
  const matches = useMemo(
    () =>
      !find
        ? []
        : messages.filter((message) =>
            (message.text + ' ' + (message.tool?.output ?? ''))
              .toLowerCase()
              .replace(/\s+/g, ' ')
              .includes(find.toLowerCase().replace(/\s+/g, ' ')),
          ),
    [messages, find],
  );
  const slash = session.draft.startsWith('/') && !session.draft.includes(' ');
  const mention = session.draft.match(/(?:^|\s)@([^\s]*)$/)?.[1];
  const completions = slash
    ? [
        ...BUILTIN_SLASH.map((item) => ({
          name: '/' + item.name,
          description: slashText(item.name, item.description),
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
    perform(() => {
      runtime.updateSessionView(session.id, { draft: value });
    });
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
  const position = useRef({ top: 0, follow: true });
  const follow = (force = false) => {
    const box = scroller.current;
    if (!box) return;
    if (force) stuck.current = true;
    if (stuck.current)
      box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
    height.current = box.scrollHeight;
    position.current = { top: box.scrollTop, follow: stuck.current };
  };
  useEffect(() => {
    const box = scroller.current;
    const content = column.current;
    if (!box || !content) return;
    const scrolled = () => {
      // Only the actual end follows new content; a reader just above it stays put.
      stuck.current = height.current - box.scrollTop - box.clientHeight <= 1;
      position.current = { top: box.scrollTop, follow: stuck.current };
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
  useLayoutEffect(() => {
    const box = scroller.current;
    const saved = session.presentation?.scroll;
    stuck.current = saved?.follow ?? true;
    if (box) {
      box.scrollTo({
        top: saved?.top ?? box.scrollHeight,
        behavior: 'instant',
      });
      height.current = box.scrollHeight;
      position.current = { top: box.scrollTop, follow: stuck.current };
      follow();
    }
    return () => {
      saveSessionScroll(runtime, session.id, presentationEpoch, {
        ...position.current,
      });
    };
  }, [session.id, runtime, presentationEpoch]);
  // A message you just sent brings the end back into view
  const count = useRef({ sessionId: session.id, length: messages.length });
  useLayoutEffect(() => {
    const sent =
      count.current.sessionId === session.id &&
      messages.length > count.current.length &&
      lastRole === 'user';
    count.current = { sessionId: session.id, length: messages.length };
    follow(sent);
  }, [session.id, messages.length, lastRole, lastSize, session.state]);
  useEffect(() => setFinding(false), [session.id, messages.length]);
  useEffect(() => {
    if (find && matches.length) {
      let frame = 0;
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const id = matches[findIndex % matches.length]?.id;
          if (!id) return;
          const target = scroller.current?.querySelector(
            `[data-message-id="${CSS.escape(id)}"]`,
          );
          target?.scrollIntoView({ block: 'center' });
        });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [find, findIndex]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector('[role="dialog"]')) return;
      const current = latestView.current.session;
      const control = event.ctrlKey || event.metaKey;
      const mapped = matchingAction(event, snapshot.settings.keybindings);
      if (current.archivedAt && mapped !== 'find') return;
      if (mapped) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const commands: Record<string, string> = {
          'model.select': 'models',
          'session.select': 'resume',
          'thinking.toggle': 'thinking',
          'tools.expand': 'details',
          'editor.external': 'editor',
          'message.copy': 'copy',
          unused: 'help',
        };
        if (commands[mapped]) act(() => runtime.command(commands[mapped]!));
        else if (mapped === 'find') setFinding((value) => !value);
        else if (mapped === 'plan.focus') {
          setPlanCollapsed(false);
          requestAnimationFrame(() => planItems.current?.focus());
        } else if (mapped === 'history.search') onCommand();
        else if (mapped === 'exit') onDialog('exit');
        else if (mapped === 'secret.enter') onDialog('secret');
        else if (mapped === 'suspend' || mapped === 'job.background') {
          runtime.request(mapped === 'suspend' ? 'suspend' : 'background');
          notify(t('host request recorded; no process changed'));
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
        // The input box takes shift+tab itself; this is the key elsewhere, or another key
        else if (mapped === 'mode.cycle')
          setMode(nextMode(sessionMode(current)));
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
      if (
        event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === 'p'
      ) {
        event.preventDefault();
        setPlanCollapsed(false);
        requestAnimationFrame(() => planItems.current?.focus());
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
        notify(t('background request recorded; no process was changed'));
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
    session.id,
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
  // A page's dialog while Circle works also waits here, to be answered from the conversation.
  const browser = useBrowserState(session.id);
  // Approvals sit under the call they wait for; the rest after the last message.
  const toolIds = new Set(
    messages.flatMap((message) => (message.tool ? [message.tool.id] : [])),
  );
  const loose = pending.filter(
    (item) =>
      !(item.kind === 'approval' && item.callId && toolIds.has(item.callId)),
  );
  const setMode = (mode: SessionMode) => {
    if (mode === sessionMode(session)) return;
    act(() => runtime.command('mode', mode));
    notify(MODE_TEXT[mode].detail());
  };
  // The turn's clock goes on the row of its latest tools, as Claude's does; before any, on
  // a row of its own. Waiting for you, it stops.
  const items = useMemo(() => groupMessages(messages), [messages]);
  const clock = pending.length ? undefined : session.turn;
  const asked = items.findLastIndex(
    (item) => item.kind !== 'tools' && item.message.role === 'user',
  );
  const clockAt = items.findLastIndex(
    (item, index) => index > asked && item.kind === 'tools',
  );
  const showRequest = () =>
    scroller.current
      ?.querySelector('.inline-request')
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return (
    <section className="conversation">
      {finding && (
        <div className="find-bar">
          <Search size={14} />
          <input
            autoFocus
            aria-label={t('find text')}
            placeholder={t('find in conversation')}
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
              : t('type to search')}
          </span>
          <IconButton
            label={t('next match')}
            onClick={() => setFindIndex((value) => value + 1)}
          >
            <ArrowRight size={13} />
          </IconButton>
          <IconButton label={t('close find')} onClick={() => setFinding(false)}>
            <X size={13} />
          </IconButton>
        </div>
      )}
      <div
        className="transcript"
        ref={scroller}
        style={{ overflowAnchor: 'none' }}
      >
        <div className="transcript-column" ref={column}>
          {messages.length === 0 ? (
            <div className="welcome">
              <span className="circle-logo large" />
              <h2>{t('what are we working on?')}</h2>
              <p>
                {t(
                  'Start with a message, a file, or a question about your project.',
                )}
              </p>
              <button
                onClick={() => onDialog('trust')}
                className="workspace-trust"
                title={workspace.path}
              >
                <Status value={workspace.trusted ? 'trusted' : 'not trusted'} />
                <strong>{workspace.name}</strong>
                <span>{workspace.path}</span>
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
            <TranscriptList
              items={items}
              scrollRef={scroller}
              revealIndex={
                find && matches.length
                  ? items.findIndex((item) =>
                      item.kind === 'tools'
                        ? item.rows.some(
                            (row) =>
                              row.id ===
                              matches[findIndex % matches.length]?.id,
                          )
                        : item.message.id ===
                          matches[findIndex % matches.length]?.id,
                    )
                  : undefined
              }
              renderItem={(item, index) =>
                item.kind === 'tools' ? (
                  <div key={item.id} data-message-id={item.rows[0]!.id}>
                    <ToolGroup
                      rows={item.rows}
                      expanded={
                        session.expandTools ||
                        (!!find &&
                          item.rows.some(
                            (row) =>
                              row.id ===
                              matches[findIndex % matches.length]?.id,
                          ))
                      }
                      onAgent={onAgent}
                      onFile={onFile}
                      turn={index === clockAt ? clock : undefined}
                    >
                      {pending
                        .filter(
                          (request) =>
                            request.kind === 'approval' &&
                            !!request.callId &&
                            item.rows.some(
                              (row) => row.tool?.id === request.callId,
                            ),
                        )
                        .map((request) => (
                          <InlineRequest
                            key={request.id}
                            item={request}
                            onSecret={() => onDialog('secret')}
                          />
                        ))}
                    </ToolGroup>
                  </div>
                ) : (
                  <div
                    key={item.message.id}
                    data-message-id={item.message.id}
                    className={
                      find &&
                      matches[findIndex % matches.length]?.id ===
                        item.message.id
                        ? 'find-match'
                        : ''
                    }
                  >
                    {item.message.role === 'notice' ? (
                      <div className="transcript-notice">
                        {item.message.planCompleted === undefined
                          ? item.message.text
                          : t('plan completed · {n} steps', {
                              n: item.message.planCompleted,
                            })}
                      </div>
                    ) : (
                      <MessageView
                        message={item.message}
                        showThinking={session.showThinking}
                        onAttachment={() => onPanel('context')}
                      />
                    )}
                  </div>
                )
              }
            />
          )}
          {loose.map((item) => (
            <InlineRequest
              key={item.id}
              item={item}
              onSecret={() => onDialog('secret')}
            />
          ))}
          {session.turn &&
            browser?.dialogs?.map((dialog) => (
              <BrowserDialogRequest
                key={dialog.id}
                sessionId={session.id}
                dialog={dialog}
              />
            ))}
          {session.turn &&
            browser?.certificateChoices?.map((choice) => (
              <CertificateChoiceRequest
                key={choice.id}
                sessionId={session.id}
                choice={choice}
              />
            ))}
          {session.turn && browser?.control === 'user' && (
            <BrowserHandoffRequest
              sessionId={session.id}
              reason={browser.handoff}
              auto={session.mode === 'auto'}
            />
          )}
          {clock && clockAt < 0 && <TurnRow turn={clock} />}
          {session.state === 'waiting' && runtime.mode !== 'live' && (
            <div className="pending-message">
              <i />
              waiting for runtime connection
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
              {t('local conversation paused · remote state unverified')}
            </div>
          )}
        </div>
      </div>
      {(session.lifecycle === 'deleting' || session.occupied) && (
        <div className="archive-banner" role="status">
          {session.lifecycle === 'deleting'
            ? t('stopping work before deletion…')
            : t('open in another terminal; view only')}
        </div>
      )}
      {session.archivedAt && (
        <div className="archive-banner" data-testid="archive-banner">
          <span>{t('archived conversation · read only')}</span>
          <Button
            onClick={() =>
              perform(async () => {
                await runtime.request('archive-session', {
                  id: session.id,
                  archived: false,
                });
              })
            }
          >
            {t('restore conversation')}
          </Button>
        </div>
      )}
      {snapshot.runtime?.connected && (
        <RecoveredInputs key={session.id} sessionId={session.id} />
      )}
      {composerWritable && (
        <div className="composer-area">
          {planVisible(
            session.todos,
            pending.some(
              (item) =>
                item.kind === 'plan-exit' ||
                (item.kind === 'question' &&
                  item.choices?.includes('implement plan')),
            ),
          ) && (
            <div className="plan">
              <button
                className="plan-title"
                aria-label={t('toggle plan')}
                aria-expanded={!planCollapsed}
                onClick={() => setPlanCollapsed((value) => !value)}
              >
                <span>{t('plan')}</span>
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
                <div
                  className="plan-items"
                  ref={planItems}
                  tabIndex={0}
                  role="region"
                  aria-label={t('plan steps')}
                  onClick={() => planItems.current?.focus()}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing) return;
                    if (
                      !event.ctrlKey &&
                      !event.altKey &&
                      !event.metaKey &&
                      (event.key === 'ArrowUp' || event.key === 'ArrowDown')
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      const list = event.currentTarget;
                      const height =
                        list.firstElementChild?.getBoundingClientRect()
                          .height ?? 24;
                      list.scrollTop +=
                        (event.key === 'ArrowUp' ? -1 : 1) * height;
                    } else if (event.key === 'Escape') {
                      event.preventDefault();
                      event.stopPropagation();
                      input.current?.focus();
                    } else if (
                      event.key.length === 1 &&
                      !event.ctrlKey &&
                      !event.metaKey &&
                      !event.altKey
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      setDraft(session.draft + event.key);
                      input.current?.focus();
                    }
                  }}
                >
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
            <button className="interaction-summary" onClick={showRequest}>
              <Status value="waiting" />
              <span>
                {tn(
                  pending.length,
                  '{n} request waiting for you',
                  '{n} requests waiting for you',
                )}
              </span>
              <ArrowRight size={13} />
            </button>
          )}
          {editingQueue &&
            !session.queue.some((item) => item.id === editingQueue.id) && (
              <div className="queue-editor" role="status">
                <p>
                  {t('queued message was consumed; your edit is preserved')}
                </p>
                <textarea
                  aria-label={t('edit queued message')}
                  value={editingQueue.text}
                  onChange={(event) =>
                    setEditingQueue({
                      ...editingQueue,
                      text: event.target.value,
                    })
                  }
                />
                <div>
                  <Button
                    onClick={() => {
                      setDraft(
                        [session.draft, editingQueue.text]
                          .filter(Boolean)
                          .join('\n'),
                      );
                      setEditingQueue(null);
                    }}
                  >
                    {t('return edit to draft')}
                  </Button>
                  <Button onClick={() => setEditingQueue(null)}>
                    {t('dismiss')}
                  </Button>
                </div>
              </div>
            )}
          {session.queue.length > 0 && (
            <div className="queue">
              {session.queue.map((item) => (
                <div key={item.id}>
                  <span>{QUEUE_KIND[item.kind]?.() ?? item.kind}</span>
                  {editingQueue?.id === item.id ? (
                    <div className="queue-editor">
                      <textarea
                        aria-label={t('edit queued message')}
                        value={editingQueue.text}
                        onChange={(event) =>
                          setEditingQueue({
                            ...editingQueue,
                            text: event.target.value,
                          })
                        }
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setEditingQueue(null);
                          }
                        }}
                      />
                      <div>
                        <Button
                          disabled={!editingQueue.text.trim()}
                          onClick={() => {
                            const text = editingQueue.text;
                            void perform(async () => {
                              if (runtime.mode === 'live')
                                await runtime.request(
                                  'edit-queued',
                                  {
                                    kind: item.kind,
                                    index: Number(item.id.split('-').at(-1)),
                                    text: editingQueue.original,
                                    expectedQueueVersion: editingQueue.version,
                                    updatedText: text,
                                  },
                                  session.id,
                                );
                              else
                                runtime.change((state) => {
                                  const target = state.sessions.find(
                                    (value) => value.id === session.id,
                                  );
                                  const queued = target?.queue.find(
                                    (entry) => entry.id === item.id,
                                  );
                                  if (
                                    !queued ||
                                    queued.text !== editingQueue.original
                                  )
                                    throw Error(
                                      t('queued message changed before saving'),
                                    );
                                  queued.text = text;
                                });
                              setEditingQueue(null);
                            });
                          }}
                        >
                          {t('save queued message')}
                        </Button>
                        <Button onClick={() => setEditingQueue(null)}>
                          {t('cancel')}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <p>{item.text}</p>
                      <Button
                        onClick={() =>
                          setEditingQueue({
                            id: item.id,
                            text: item.text,
                            original: item.text,
                            version: session.queueVersion,
                          })
                        }
                      >
                        {t('edit queued message')}
                      </Button>
                    </>
                  )}
                  <IconButton
                    label={t('remove queued {kind}', {
                      kind: QUEUE_KIND[item.kind]?.() ?? item.kind,
                    })}
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
                {t('return queued messages to draft')}
              </button>
            </div>
          )}
          <div
            className="composer"
            data-mode={sessionMode(session)}
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
                aria-label={t('input completions')}
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
              rows={1}
              aria-label={t('message')}
              placeholder={t('Ask anything, or describe a change…')}
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
                  perform(() => {
                    const target = runtime
                      .getSnapshot()
                      .sessions.find((item) => item.id === session.id);
                    if (!target || target.lifecycle === 'deleting') return;
                    runtime.updateSessionView(session.id, {
                      attachments: [
                        ...target.attachments,
                        { id, name: marker, kind: 'paste', content: text },
                      ],
                      draft: target.draft + marker,
                    });
                  });
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
                // shift+tab: the next approval mode, as in other coding agents.
                if (event.shiftKey && event.key === 'Tab') {
                  event.preventDefault();
                  event.stopPropagation();
                  setMode(nextMode(sessionMode(session)));
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
                  setDraft(
                    next < 0 ? savedDraft.current : (history[next] ?? ''),
                  );
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
                      perform(() => {
                        const target = runtime
                          .getSnapshot()
                          .sessions.find((item) => item.id === session.id);
                        if (target)
                          runtime.updateSessionView(session.id, {
                            attachments: target.attachments.filter(
                              (item) => item.id !== file.id,
                            ),
                          });
                      })
                    }
                  />
                ))}
              </div>
            )}
            <div className="composer-send">
              {session.state === 'waiting' ? (
                <IconButton
                  label={t('pause conversation')}
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
                  label={t('resume conversation')}
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
                aria-label={t('send message')}
                disabled={!session.draft.trim()}
                onClick={() => act(() => runtime.send())}
              >
                <ArrowUp size={16} />
              </button>
            </div>
          </div>
          {/* Under the box, as Claude has it: attach and mode on the left, model,
            thinking depth and the context ring on the right. */}
          <div className="composer-footbar">
            <div>
              <IconButton label={t('attach files')} onClick={onAttach}>
                <Plus size={16} />
              </IconButton>
              <ModeMenu session={session} onMode={setMode} />
              {contributions.map(({ plugin, widget }) => (
                <PluginBoundary key={widget.id} name={plugin.title}>
                  <widget.component sessionId={session.id} />
                </PluginBoundary>
              ))}
            </div>
            <div>
              {runtime.mode === 'live' && !snapshot.runtime?.configured ? (
                <button
                  className="footbar-button attention"
                  onClick={() => onDialog('connect')}
                >
                  {t('connect a model')}
                </button>
              ) : (
                <ModelMenu
                  session={session}
                  models={snapshot.models}
                  enabled={snapshot.settings.enabledModels}
                  onModel={(id) =>
                    perform(() =>
                      runtime.change((state) => {
                        currentSession(state).model = id;
                      }),
                    )
                  }
                  onManage={() => act(() => runtime.command('models'))}
                />
              )}
              <EffortMenu
                session={session}
                onEffort={(effort) =>
                  perform(() =>
                    runtime.change((state) => {
                      currentSession(state).effort = effort;
                    }),
                  )
                }
              />
              <ContextRing
                session={session}
                jobs={jobs}
                onCompact={() => act(() => runtime.command('compact'))}
                onJobs={() => onPanel('activity')}
                onDetails={() =>
                  onDialog(runtime.mode === 'live' ? 'session' : 'preview')
                }
              />
            </div>
          </div>
          {(jobs.length > 0 || agents.length > 0) && (
            <div className="running-strip">
              {agents.slice(0, 2).map((agent) => (
                <button key={agent.id} onClick={() => onAgent(agent.id)}>
                  <span className="agent-dot" />
                  <strong>{agent.name}</strong>
                  <span>{agentActivityText(agent)}</span>
                </button>
              ))}
              {jobs.slice(0, 2).map((job) => (
                <button
                  key={job.id}
                  onClick={() => onPanel('activity', job.id)}
                >
                  <Status value={job.state} />
                  <strong>{job.id}</strong>
                  <span>{job.title}</span>
                  <small>{job.elapsed}</small>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

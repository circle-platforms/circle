import { SafeFileUndo } from './SafeFileUndo';
import { preserveNativeEditing } from '../model/native-editable-shortcut';
import { effectiveBindings, matchingAction } from '../model/shortcuts';
import {
  completionNoticeText,
  withoutDuplicateStops,
} from '../model/completion';
import { usePlugins } from '../plugins/context';
import { PluginBoundary } from '../plugins/Boundary';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
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
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { BUILTIN_SLASH } from '../../../../src/tui/slash_commands';
import { slashText } from '../model/slash-text';
import { useRuntime } from '../app/context';
import { currentSession, visibleMessages, EFFORTS } from '../model/state';
import { showTurnClock } from '../model/turn-line';
import { workspaceLabel } from '../model/workspace-label';
import { fullTime, shownTime } from '../model/time';
import type { Attachment, DialogId, Message, PanelId } from '../model/types';
import { Button, IconButton, FileChip, Status } from '../components/common';
import { Markdown } from '../components/Markdown';
import { ToolGroup, TurnRow } from '../components/ToolGroup';
import { RecoveredInputs } from './RecoveredInputs';
import { WindowedList } from '../components/WindowedList';
import type { ReactNode, RefObject } from 'react';
import { MessageView, RuntimeNotice } from '../components/MessageView';
import {
  CommandFailureCard,
  RuntimeWaitRow,
} from '../components/CommandFailure';
import {
  BrowserDialogRequest,
  BrowserHandoffRequest,
  CertificateChoiceRequest,
} from './BrowserDialog';
import { useBrowserState } from './useBrowserState';
import { InlineRequest } from './InlineRequest';
import { useSources } from '../components/SourceNavigation';
import { TaskReviewCard } from './TaskReviewCard';
import { EffortMenu, ModeMenu, ModelMenu, MODE_TEXT } from './Composer';
import { nextMode, sessionMode } from '../model/state';
import type { SessionMode } from '../model/types';
import { t, tn } from '../i18n';
import {
  saveSessionScroll,
  transcriptScroll,
  restoreTranscriptAnchor,
  sessionScrollAnchor,
  type SessionScroll,
} from '../model/presentation';
import {
  claimComposerFocus,
  composerFocusPending,
  composerFocusSealed,
  composerHasBuffer,
  composerTextPlaced,
  focusMessageComposer,
  keyboardIsInTerminal,
  subscribeComposerFocus,
  takeComposerText,
} from '../model/composer-focus';
import { terminalKeyboardClaimed } from '../model/terminal-keyboard';
interface Props {
  focusComposer?: number;
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
/** Scroll a transcript item inside the transcript. scrollIntoView also scrolls
    every ancestor, which walks the composer off the window. */
function revealIn(scroller: HTMLElement, target: Element): void {
  const box = scroller.getBoundingClientRect();
  const item = target.getBoundingClientRect();
  if (item.top >= box.top && item.bottom <= box.bottom) return;
  scroller.scrollTo({
    top: Math.max(
      0,
      scroller.scrollTop + item.top - box.top - (box.height - item.height) / 2,
    ),
  });
}
const mediaFiles = (files: FileList): File[] =>
  Array.from(files).filter((file) => MEDIA_TYPES.has(file.type));
// A transcript item: a message, or the tool calls between two messages, folded together.
export type TranscriptItem =
  | { kind: 'message'; message: Message }
  | { kind: 'tools'; id: string; rows: Message[] };
export function groupMessages(messages: Message[]): TranscriptItem[] {
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
  initialAnchor,
}: {
  items: TranscriptItem[];
  renderItem: (item: TranscriptItem, index: number) => ReactNode;
  scrollRef: RefObject<HTMLElement | null>;
  revealIndex?: number;
  initialAnchor?: { index: number; offset: number };
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
      initialAnchor={initialAnchor}
    />
  );
}
// How a queued message goes: steering joins the running turn, a follow-up waits for its end.
const QUEUE_KIND: Record<string, () => string> = {
  steering: () => t('steering'),
  'follow-up': () => t('follow-up'),
};
export function Conversation({
  focusComposer,
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
  const sources = useSources();
  const session = currentSession(snapshot);
  const { registry, enabled } = usePlugins();
  const contributions = registry.widgets(enabled, 'composerActions');
  const workspace = snapshot.workspaces.find(
    (item) => item.id === session.workspaceId,
  )!;
  const messages = useMemo(
    () => withoutDuplicateStops(visibleMessages(session)),
    [session.messages, session.branchIds, session.hiddenIds, session.leafId],
  );
  const composerWritable =
    !session.archivedAt &&
    session.lifecycle !== 'deleting' &&
    !session.occupied;
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (focusComposer !== undefined) focusMessageComposer(input.current);
  }, [focusComposer, session.id]);
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
  const presentationEpoch = runtime.presentationEpoch;
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
      input.current?.focus({ preventScroll: true });
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
  // Ctrl+N and new session ask for this box once the empty view is committed,
  // including when that view is the session already open. Keys typed during
  // the switch were buffered and land here before paint. Selecting a listed
  // session does not ask, so it does not move the keyboard.
  const placeCaret = useRef(false);
  useLayoutEffect(() => {
    const apply = () => {
      if (!composerFocusPending()) return;
      const node = input.current;
      if (!node) return;
      if (!composerFocusSealed()) {
        focusMessageComposer(node);
        if (!composerHasBuffer() && node.value)
          node.setSelectionRange(0, node.value.length);
        return;
      }
      const text = takeComposerText();
      if (text) {
        const live = currentSession(runtime.getSnapshot());
        if (
          !live.messages.some((message) => message.role === 'user') &&
          live.draft !== text
        ) {
          placeCaret.current = true;
          runtime.change((state) => {
            const target = currentSession(state);
            if (target.messages.some((message) => message.role === 'user'))
              return;
            target.draft = text;
          });
        }
      }
      const field = input.current;
      if (!field) return;
      focusMessageComposer(field);
      const end = field.value.length;
      if (text || composerTextPlaced()) field.setSelectionRange(end, end);
      else if (end) field.setSelectionRange(0, end);
      claimComposerFocus();
    };
    apply();
    return subscribeComposerFocus(apply);
  }, [session.id, runtime]);
  // The buffered draft commits on the next render. Put the caret after it
  // once that value is in the box, then leave the caret where the person moves it.
  useLayoutEffect(() => {
    if (!placeCaret.current) return;
    const field = input.current;
    if (!field || (field.value.length === 0 && composerTextPlaced())) return;
    placeCaret.current = false;
    if (keyboardIsInTerminal() || terminalKeyboardClaimed()) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, [session.draft, session.id]);
  // The window's key handler is set up once per session: it reads what is current here.
  const latestView = useRef({ session, onDialog, onPanel, onCommand });
  latestView.current = { session, onDialog, onPanel, onCommand };
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
    input.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    // Chromium sizes content during its normal layout, without a draft-triggered
    // write -> scrollHeight read -> write forcing a second synchronous layout.
    if (input.current && !CSS.supports('field-sizing', 'content')) {
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
  const position = useRef<SessionScroll>({ top: 0, follow: true });
  // The desired manual position survives temporary layout clamps. Applied geometry
  // describes only what the browser could display, never a new reading intention.
  const geometry = (box: HTMLElement) => ({
    top: box.scrollTop,
    width: box.clientWidth,
    height: box.scrollHeight,
    viewport: box.clientHeight,
  });
  const applied = useRef<ReturnType<typeof geometry> | undefined>(undefined);
  const follow = (force = false) => {
    const box = scroller.current;
    if (!box) return;
    if (force) stuck.current = true;
    if (stuck.current) {
      box.scrollTo({ top: box.scrollHeight, behavior: 'instant' });
      position.current = transcriptScroll(box, true);
    } else if (!restoreTranscriptAnchor(box, position.current.anchor)) {
      // Pending request cards can be below the message rows and have no message
      // anchor. Keep their desired pixel offset even when the current width clamps it.
      box.scrollTo({ top: position.current.top, behavior: 'instant' });
    }
    applied.current = geometry(box);
  };
  useEffect(() => {
    const box = scroller.current;
    const content = column.current;
    if (!box || !content) return;
    const scrolled = () => {
      const now = geometry(box),
        previous = applied.current;
      if (
        previous &&
        (now.width !== previous.width ||
          now.height !== previous.height ||
          now.viewport !== previous.viewport)
      ) {
        follow();
        return;
      }
      // Our own compensation and the browser's clamp are observations, not input.
      if (previous && Math.abs(now.top - previous.top) <= 0.5) return;
      stuck.current = now.height - now.top - now.viewport <= 1;
      position.current = transcriptScroll(box, stuck.current);
      applied.current = now;
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
      position.current = saved ?? transcriptScroll(box, stuck.current);
      follow();
    }
    const save = () =>
      saveSessionScroll(runtime, session.id, presentationEpoch, {
        ...position.current,
      });
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      save();
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
          if (target && scroller.current) revealIn(scroller.current, target);
        });
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [find, findIndex]);
  useEffect(() => {
    // Capture runs before a menu can close and unmount. Escape then still dismisses
    // the menu, and the later handler does not treat it as stopping the turn.
    const markMenu = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        document.querySelector('[role="dialog"], [role="menu"]')
      )
        (event as KeyboardEvent & { menuOpen?: boolean }).menuOpen = true;
    };
    const handler = (event: KeyboardEvent) => {
      if ((event as KeyboardEvent & { menuOpen?: boolean }).menuOpen) return;
      if (document.documentElement.dataset.keyCapture) return;
      // A menu or dialog takes Escape itself. It must not also stop the turn.
      if (document.querySelector('[role="dialog"], [role="menu"]')) return;
      const current = latestView.current.session;
      const mapped = matchingAction(
        event,
        effectiveBindings(snapshot.settings.keybindings),
      );
      if (current.archivedAt && mapped !== 'find') return;
      // A copy chord over a selection stays a cut or a copy.
      if (mapped === 'message.copy' && window.getSelection()?.toString())
        return;
      // The window handles the sidebar, including settings and home.
      if (mapped === 'sidebar.toggle') return;
      // The browser owns paste, including images. Cancelling this key prevents
      // the trusted paste event that supplies clipboard files to the composer.
      // A custom chord does not grant permission to read the clipboard either.
      if (mapped === 'image.paste') return;
      if (preserveNativeEditing(event, mapped)) return;
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
        // The plan is a step of the overview's "in progress" card.
        else if (mapped === 'plan.focus')
          latestView.current.onPanel('overview');
        // history.search is ctrl+r. It opens the same search as ctrl+k.
        else if (mapped === 'history.search') latestView.current.onCommand();
        else if (mapped === 'exit') latestView.current.onDialog('exit');
        else if (mapped === 'secret.enter')
          latestView.current.onDialog('secret');
        else if (mapped === 'suspend' || mapped === 'job.background') {
          runtime.request(mapped === 'suspend' ? 'suspend' : 'background');
          notify(
            mapped === 'job.background'
              ? t('background request recorded; no process was changed')
              : t('host request recorded; no process changed'),
          );
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
          const models = snapshot.models.filter(
            (model) =>
              !snapshot.settings.enabledModels.length ||
              snapshot.settings.enabledModels.includes(model.id),
          );
          const next = models.length
            ? models[
                (models.findIndex((model) => model.id === current.model) + 1) %
                  models.length
              ]
            : undefined;
          if (next)
            perform(() =>
              runtime.change((state) => {
                currentSession(state).model = next.id;
              }),
            );
        }
        return;
      }
    };
    addEventListener('keydown', markMenu, true);
    addEventListener('keydown', handler);
    return () => {
      removeEventListener('keydown', markMenu, true);
      removeEventListener('keydown', handler);
    };
  }, [
    runtime,
    snapshot.models,
    snapshot.settings.enabledModels,
    snapshot.settings.keybindings,
    session.id,
  ]);
  const pending = snapshot.interactions.filter(
    (item) => item.sessionId === session.id && item.status === 'pending',
  );
  // A page's dialog while Circle works also waits here, to be answered from the conversation.
  const browser = useBrowserState(session.id);
  // Approvals sit under the call they wait for; the rest after the last message.
  const toolIds = new Set(
    messages.flatMap((message) => (message.tool ? [message.tool.id] : [])),
  );
  // In a task's own conversation, the task: once it has finished it waits for your review.
  // The review card is the task's, at the end of its own conversation, not its reviewer's.
  const taskAgent = snapshot.agents.find(
    (agent) =>
      agent.task &&
      agent.task.role !== 'reviewer' &&
      agent.resourceSessionId === session.id,
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
  const savedAnchor = sessionScrollAnchor(session.presentation?.scroll?.anchor);
  const initialAnchor = useMemo(() => {
    if (!savedAnchor || session.presentation?.scroll?.follow) return undefined;
    const index = items.findIndex((item) =>
      item.kind === 'tools'
        ? item.rows.some((row) => row.id === savedAnchor.messageId)
        : item.message.id === savedAnchor.messageId,
    );
    return index < 0 ? undefined : { index, offset: savedAnchor.offset };
  }, [
    items,
    savedAnchor?.messageId,
    savedAnchor?.offset,
    session.presentation?.scroll?.follow,
  ]);
  const clock = showTurnClock(messages, pending.length, session.turn)
    ? session.turn
    : undefined;
  const asked = items.findLastIndex(
    (item) => item.kind !== 'tools' && item.message.role === 'user',
  );
  const clockAt = items.findLastIndex(
    (item, index) => index > asked && item.kind === 'tools',
  );
  const showRequest = () => {
    const box = scroller.current;
    const target = box?.querySelector('.inline-request');
    if (box && target) revealIn(box, target);
  };
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
              <button
                onClick={() => onDialog('trust')}
                className="workspace-trust"
                title={workspace.path}
              >
                <Status value={workspace.trusted ? 'trusted' : 'not trusted'} />
                <strong>{workspaceLabel(workspace)}</strong>
                <span>{workspace.path}</span>
              </button>
              <div className="welcome-context">
                {workspace.instructions.map((item) => (
                  <button
                    key={item.name}
                    disabled={!item.path}
                    title={item.path}
                    onClick={() => item.path && onFile(item.path)}
                  >
                    <FileText size={13} />
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <TranscriptList
              key={session.id}
              items={items}
              initialAnchor={initialAnchor}
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
                      ownerSessionId={session.id}
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
                            onFile={onFile}
                            onSecret={() => onDialog('secret')}
                            onSettled={() =>
                              requestAnimationFrame(() =>
                                input.current?.focus({ preventScroll: true }),
                              )
                            }
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
                      <RuntimeNotice
                        message={{
                          ...item.message,
                          text: completionNoticeText(item.message),
                        }}
                        onConnection={() => onDialog('connect')}
                        onMessage={() => input.current?.focus()}
                      />
                    ) : (
                      <>
                        <MessageView
                          message={item.message}
                          showThinking={session.showThinking}
                        />
                        {item.message.role === 'user' &&
                          session.fileUndoTurns?.includes(item.message.id) && (
                            <SafeFileUndo
                              sessionId={session.id}
                              turnId={item.message.id}
                              disabled={
                                !!session.turn || session.state !== 'idle'
                              }
                            />
                          )}
                      </>
                    )}
                  </div>
                )
              }
            />
          )}
          {taskAgent && (
            <TaskReviewCard
              agent={taskAgent}
              onChanges={() => onPanel('changes')}
            />
          )}
          {loose.map((item) => (
            <InlineRequest
              key={item.id}
              item={item}
              onFile={onFile}
              onSecret={() => onDialog('secret')}
              onSettled={() =>
                requestAnimationFrame(() =>
                  input.current?.focus({ preventScroll: true }),
                )
              }
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
          <RuntimeWaitRow sessionId={session.id} />
          {session.actionFailure && (
            <CommandFailureCard
              sessionId={session.id}
              failure={session.actionFailure}
            />
          )}
        </div>
      </div>
      {(session.lifecycle === 'deleting' || session.occupied) && (
        <div className="archive-banner" role="status">
          {session.lifecycle === 'deleting'
            ? session.deletionFailed
              ? t('could not delete the session: {reason}', {
                  reason: session.deletionFailed,
                })
              : t('stopping work before deletion…')
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
      {composerWritable && (
        <div className="composer-area">
          {snapshot.runtime?.connected && (
            <RecoveredInputs key={session.id} sessionId={session.id} />
          )}
          {pending.length > 0 && (
            <button className="interaction-summary" onClick={showRequest}>
              {/* The line already says it waits; a second "waiting" word repeated it. */}
              <i className="attention-dot" />
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
              style={{ fieldSizing: 'content' }}
              rows={1}
              aria-label={t('message')}
              placeholder={t('ask anything, or describe a change…')}
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
                // ⌘↑ ⌘↓ (and ctrl with an arrow) move the cursor as the system does.
                if (event.metaKey || event.ctrlKey) return;
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
                    onClick={() => sources?.openAttachment(file)}
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
          {/* Under the box, as Claude has it: attach and mode on the left, model and
            thinking depth on the right. Nothing else sits above or below the box. */}
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
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

import { taskWorkspaceIds } from '../model/session-management';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Check,
  ChevronDown,
  Folder,
  Plus,
  Search,
  X,
  ArrowUp,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { desktopHost, folderOpenMessage, openNativeWorkspace } from '../host';
import { useRuntime } from '../app/context';
import type {
  Attachment,
  DialogId,
  Effort,
  Session,
  SessionMode,
} from '../model/types';
import { sessionMode } from '../model/state';
import {
  claimComposerFocus,
  composerFocusPending,
  sealComposerFocus,
  takeComposerText,
} from '../model/composer-focus';
import { t, useLocale } from '../i18n';
import { Button, FileChip, IconButton } from '../components/common';
import type { WhatsNewNotice } from '../../../../src/whats_new';
import { EffortMenu, ModeMenu, ModelMenu } from './Composer';
import {
  forgetHomeComposer,
  homeComposerMemory,
  homeProjectRequest,
  homeProjects,
  openHome,
  rememberHomeComposer,
  selectedHomeProject,
} from './home-selection';

export function Home({
  requestedId,
  onDialog,
  onStarted,
  onAttach,
}: {
  /** `null` keeps the current project. `''` is working without a project. */
  requestedId: string | null;
  onDialog: (dialog: DialogId, selection?: string) => void;
  onStarted: (sessionId: string) => void;
  onAttach: (accept: (attachment: Attachment) => void) => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const navigate = useNavigate();
  const location = useLocation();
  const message = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const active =
    snapshot.sessions.find((item) => item.id === snapshot.activeSessionId) ??
    snapshot.sessions[0];
  const remembered = useRef(homeComposerMemory());
  const released = useRef(false);
  const baseline = useRef({
    model: active?.model || snapshot.settings.defaultModel,
    effort: (active?.effort ||
      snapshot.settings.defaultEffort ||
      'default') as Effort,
    mode: (active ? sessionMode(active) : 'manual') as SessionMode,
    requestedId,
  });
  const [draft, setDraft] = useState(remembered.current?.text ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(
    remembered.current?.attachments ?? [],
  );
  const [query, setQuery] = useState('');
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [model, setModelId] = useState(
    () =>
      remembered.current?.model ||
      active?.model ||
      snapshot.settings.defaultModel,
  );
  const [effort, setEffort] = useState<Effort>(
    () =>
      remembered.current?.effort ||
      active?.effort ||
      snapshot.settings.defaultEffort ||
      'default',
  );
  const [mode, setMode] = useState<SessionMode>(
    () => remembered.current?.mode || (active ? sessionMode(active) : 'manual'),
  );
  const controls: Session = {
    ...(active ?? {
      id: 'home',
      title: 'new session',
      workspaceId: '',
      model,
      effort,
      draft: '',
      messages: [],
      leafId: null,
      hiddenIds: [],
      undoStack: [],
      attachments: [],
      queue: [],
      state: 'idle' as const,
      readOnly: false,
      auto: false,
    }),
    model,
    effort,
    mode,
    readOnly: mode === 'plan',
    auto: mode === 'auto',
  };
  const here = `${location.pathname}${location.search}`;
  const go = (id?: string | null) => openHome(navigate, here, id);
  const focusToken = (location.state as { focusComposer?: number } | null)
    ?.focusComposer;
  useEffect(() => {
    if (focusToken === undefined) return;
    const timer = window.setTimeout(() => message.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [focusToken]);
  // New session took the keyboard before this view existed. Keys typed during
  // the switch were held; they go after the kept draft, with the caret there.
  useLayoutEffect(() => {
    if (!composerFocusPending()) return;
    sealComposerFocus();
    const typed = takeComposerText();
    const field = message.current;
    if (typed) {
      const next = draftRef.current + typed;
      draftRef.current = next;
      setDraft(next);
      if (field) field.value = next;
    }
    if (field) {
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    }
    claimComposerFocus();
  }, [focusToken]);
  useEffect(() => {
    if (!projectsOpen) return;
    const frame = requestAnimationFrame(() => search.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [projectsOpen]);
  const project = selectedHomeProject(
    snapshot.workspaces,
    snapshot.sessions,
    snapshot.activeSessionId,
    homeProjectRequest(requestedId, remembered.current),
  );
  const draftRef = useRef(draft);
  const attachmentsRef = useRef(attachments);
  const pendingSend = useRef(false);
  draftRef.current = draft;
  attachmentsRef.current = attachments;
  const focusComposer = () => message.current?.focus();
  useEffect(() => {
    if (released.current) return;
    const controlsChanged =
      model !== baseline.current.model ||
      effort !== baseline.current.effort ||
      mode !== baseline.current.mode ||
      requestedId !== baseline.current.requestedId;
    if (
      remembered.current === null &&
      draft === '' &&
      attachments.length === 0 &&
      !controlsChanged
    )
      return;
    remembered.current = {
      text: draft,
      attachments,
      model,
      effort,
      mode,
      projectId: project?.id ?? null,
    };
    rememberHomeComposer(remembered.current);
  }, [draft, attachments, model, effort, mode, project?.id, requestedId]);
  const taskFolders = taskWorkspaceIds(snapshot.sessions, snapshot.agents);
  const projects = homeProjects(
    snapshot.workspaces.filter((item) => !taskFolders.has(item.id)),
  ).filter((item) =>
    (item.name + ' ' + item.path)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const choose = (id: string | null) => {
    setQuery('');
    setProjectsOpen(false);
    go(id);
  };
  const openProject = () =>
    perform(async () => {
      try {
        const id = await openNativeWorkspace(runtime);
        if (id) go(id);
      } catch (error) {
        notify(folderOpenMessage(error));
      }
    });
  const deliverRef = useRef(() => {});
  deliverRef.current = () => {
    const text = draftRef.current.trim();
    if (!text) return;
    const files = attachmentsRef.current;
    perform(async () => {
      if (project && !project.trusted) {
        pendingSend.current = true;
        const anchor = snapshot.sessions.find(
          (session) =>
            session.workspaceId === project.id &&
            session.lifecycle !== 'deleting',
        );
        if (anchor && runtime.mode === 'live')
          await runtime.selectSession(anchor.id);
        onDialog('trust', project.id);
        return;
      }
      pendingSend.current = false;
      const result = await runtime.beginConversation({
        workspaceId: project?.id ?? null,
        text,
        model,
        effort,
        mode,
        ...(files.length ? { attachments: files } : {}),
      });
      if ('dialog' in result) {
        pendingSend.current = true;
        onDialog(result.dialog, project?.id);
        return;
      }
      released.current = true;
      remembered.current = null;
      forgetHomeComposer();
      setDraft('');
      setAttachments([]);
      onStarted(result.sessionId);
    });
  };
  useEffect(() => {
    if (!pendingSend.current) return;
    if (project && !project.trusted) return;
    deliverRef.current();
  }, [project?.id, project?.trusted]);
  const send = () => deliverRef.current();
  const sentence = project
    ? t('what should we build in {name}?', { name: project.name })
    : '';
  const nameAt = project ? sentence.indexOf(project.name) : -1;
  return (
    <section className="home">
      <div className="welcome">
        <span className="circle-logo large" />
        <h2>
          {project && nameAt >= 0 ? (
            <>
              {sentence.slice(0, nameAt)}
              <span className="home-project-name">{project.name}</span>
              {sentence.slice(nameAt + project.name.length)}
            </>
          ) : (
            t('what are we working on?')
          )}
        </h2>
        <p>
          {t('Start with a message, a file, or a question about your project.')}
        </p>
      </div>
      <div className="home-composer">
        <div className="composer">
          <textarea
            ref={message}
            autoFocus
            rows={3}
            aria-label={t('message')}
            placeholder={t('Ask anything, or describe a change…')}
            value={draft}
            onChange={(event) => {
              const text = event.target.value;
              setDraft(text);
              // A click can leave this page before the effect writes the draft.
              const next = {
                text,
                attachments,
                model,
                effort,
                mode,
                projectId: project?.id ?? null,
              };
              remembered.current = next;
              rememberHomeComposer(next);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
          {attachments.length > 0 && (
            <div className="attachment-strip">
              {attachments.map((file) => (
                <FileChip
                  key={file.id}
                  name={file.name}
                  onRemove={() =>
                    setAttachments((current) =>
                      current.filter((item) => item.id !== file.id),
                    )
                  }
                />
              ))}
            </div>
          )}
          <div className="composer-send">
            <button
              className="send"
              aria-label={t('send message')}
              disabled={!draft.trim()}
              onClick={send}
            >
              <ArrowUp size={16} />
            </button>
          </div>
        </div>
        <div className="composer-footbar">
          <div>
            <IconButton
              label={t('attach files')}
              onClick={() =>
                onAttach((attachment) =>
                  setAttachments((current) =>
                    current.length >= 16 ? current : [...current, attachment],
                  ),
                )
              }
            >
              <Plus size={16} />
            </IconButton>
            <ModeMenu
              session={controls}
              onMode={setMode}
              side="bottom"
              onCloseFocus={focusComposer}
            />
            <DropdownMenu.Root
              open={projectsOpen}
              modal={false}
              onOpenChange={(open) => {
                setProjectsOpen(open);
                if (!open) setQuery('');
              }}
            >
              <DropdownMenu.Trigger asChild>
                <button
                  className="footbar-button"
                  aria-label={t('choose a project')}
                >
                  <Folder size={13} />
                  <span>{project ? project.name : t('no project')}</span>
                  <ChevronDown size={11} />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content
                  className="dropdown project-menu home-menu"
                  side="bottom"
                  avoidCollisions={false}
                  collisionPadding={8}
                  align="start"
                  sideOffset={7}
                  onCloseAutoFocus={(event) => {
                    // The trigger would take the click that dismissed the menu,
                    // and the search box would keep what was typed next.
                    event.preventDefault();
                    focusComposer();
                  }}
                >
                  <div
                    className="project-picker-search"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') return;
                      event.stopPropagation();
                    }}
                  >
                    <Search size={14} />
                    <input
                      ref={search}
                      aria-label={t('search projects')}
                      placeholder={t('search projects')}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </div>
                  {query.trim() && projects.length === 0 && (
                    <p className="project-picker-empty" role="status">
                      {t('no matching projects')}
                    </p>
                  )}
                  {projects.map((item) => (
                    <DropdownMenu.Item
                      key={item.id}
                      onSelect={() => choose(item.id)}
                    >
                      <Folder size={14} />
                      <span>{item.name}</span>
                      {item.id === project?.id && <Check size={14} />}
                    </DropdownMenu.Item>
                  ))}
                  <DropdownMenu.Separator className="dropdown-separator" />
                  <DropdownMenu.Item
                    disabled={!desktopHost()}
                    onSelect={openProject}
                  >
                    <Plus size={14} />
                    <span>{t('open folder')}</span>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={() => choose(null)}>
                    <X size={14} />
                    <span>{t('no project')}</span>
                    {!project && <Check size={14} />}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
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
                session={controls}
                models={snapshot.models}
                enabled={snapshot.settings.enabledModels}
                onModel={setModelId}
                onManage={() => navigate('/page/models')}
                side="bottom"
                onCloseFocus={focusComposer}
              />
            )}
            <EffortMenu
              session={controls}
              onEffort={setEffort}
              side="bottom"
              onCloseFocus={focusComposer}
            />
          </div>
        </div>
      </div>
      {snapshot.whatsNew && (
        <WhatsNew
          notice={snapshot.whatsNew}
          onDismiss={() => {
            void runtime.request('dismiss-whats-new');
          }}
        />
      )}
    </section>
  );
}

function WhatsNew({
  notice,
  onDismiss,
}: {
  notice: WhatsNewNotice;
  onDismiss: () => void;
}) {
  const locale = useLocale();
  const openNotes = () => window.open(notice.link, '_blank', 'noopener');
  return (
    <div className="whats-new">
      <div className="whats-new-card">
        <h3>{notice.title[locale]}</h3>
        {notice.items.map((item) => (
          <p key={item.en}>{item[locale]}</p>
        ))}
        <div className="whats-new-actions">
          <Button onClick={openNotes}>{notice.linkLabel[locale]}</Button>
          <Button className="primary" onClick={onDismiss}>
            {notice.dismiss[locale]}
          </Button>
        </div>
      </div>
    </div>
  );
}

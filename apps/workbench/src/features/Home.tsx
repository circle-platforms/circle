import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
import { desktopHost, openNativeWorkspace } from '../host';
import { useRuntime } from '../app/context';
import type { DialogId } from '../model/types';
import { t } from '../i18n';
import { homePath, homeProjects, selectedHomeProject } from './home-selection';

export { homePath };

export function Home({
  requestedId,
  onDialog,
  onStarted,
}: {
  /** `null` keeps the current project. `''` is working without a project. */
  requestedId: string | null;
  onDialog: (dialog: DialogId, selection?: string) => void;
  onStarted: (sessionId: string) => void;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const project = selectedHomeProject(
    snapshot.workspaces,
    snapshot.sessions,
    snapshot.activeSessionId,
    requestedId,
  );
  const projects = homeProjects(snapshot.workspaces).filter((item) =>
    (item.name + ' ' + item.path)
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const model =
    snapshot.settings.defaultModel ||
    snapshot.sessions.find((item) => item.id === snapshot.activeSessionId)
      ?.model;
  const choose = (id: string | null) => {
    setQuery('');
    navigate(homePath(id));
  };
  const openProject = () =>
    perform(async () => {
      try {
        const id = await openNativeWorkspace(runtime);
        if (id) navigate(homePath(id));
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : t('folder could not be opened'),
        );
      }
    });
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    perform(async () => {
      if (project && !project.trusted) {
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
      const result = await runtime.beginConversation({
        workspaceId: project?.id ?? null,
        text,
      });
      if ('dialog' in result) {
        onDialog(result.dialog, project?.id);
        return;
      }
      setDraft('');
      onStarted(result.sessionId);
    });
  };
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
            autoFocus
            rows={3}
            aria-label={t('message')}
            placeholder={t('Ask anything, or describe a change…')}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
          />
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
          <DropdownMenu.Root
            onOpenChange={(open) => {
              if (!open) setQuery('');
            }}
          >
            <DropdownMenu.Trigger asChild>
              <button
                className="footbar-button"
                aria-label={t('choose a project')}
              >
                <Folder size={13} />
                <span>
                  {project ? project.name : t('work without a project')}
                </span>
                <ChevronDown size={11} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="dropdown project-menu"
                side="top"
                align="start"
                sideOffset={7}
              >
                <div
                  className="project-picker-search"
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <Search size={14} />
                  <input
                    autoFocus
                    aria-label={t('search projects')}
                    placeholder={t('search projects')}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </div>
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
                  <span>{t('new project')}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item onSelect={() => choose(null)}>
                  <X size={14} />
                  <span>{t('work without a project')}</span>
                  {!project && <Check size={14} />}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          {model ? <span className="footbar-model">{model}</span> : <span />}
        </div>
      </div>
    </section>
  );
}

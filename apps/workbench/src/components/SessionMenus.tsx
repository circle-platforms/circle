import { useEffect, useState, type ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import { MoreHorizontal } from 'lucide-react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import {
  canArchiveSession,
  workspaceSessions,
} from '../model/session-management';
import type { DialogId, Session, Workspace } from '../model/types';
import { t } from '../i18n';
import { IconButton } from './common';
import '../styles/session-management.css';

function Menu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <IconButton label={label}>
          <MoreHorizontal size={13} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="dropdown session-menu"
          side="right"
          align="start"
          sideOffset={4}
        >
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Reveal({ workspaceId }: { workspaceId: string }) {
  const { perform } = useRuntime();
  const [platform, setPlatform] = useState('');
  const host = desktopHost();
  useEffect(() => {
    let live = true;
    void host
      ?.info()
      .then((info) => {
        if (live) setPlatform(info.platform);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  return (
    <DropdownMenu.Item
      disabled={!host}
      onSelect={() => perform(() => host!.revealWorkspace(workspaceId))}
    >
      {platform === 'darwin' ? t('show in finder') : t('show in folder')}
    </DropdownMenu.Item>
  );
}

export function SessionMenu({
  session,
  onDialog,
}: {
  session: Session;
  onDialog: (dialog: DialogId, selection?: string) => void;
}) {
  const { snapshot, runtime, perform } = useRuntime();
  const archive = () =>
    perform(async () => {
      if (runtime.mode === 'live')
        await runtime.request('archive-session', {
          id: session.id,
          archived: !session.archivedAt,
        });
      else
        runtime.change((state) => {
          const target = state.sessions.find((item) => item.id === session.id)!;
          target.archivedAt = session.archivedAt
            ? undefined
            : new Date().toISOString();
        });
    });
  return (
    <Menu label={t('session actions for {title}', { title: session.title })}>
      <DropdownMenu.Item
        onSelect={() =>
          perform(() =>
            runtime.change((state) => {
              const target = state.sessions.find(
                (item) => item.id === session.id,
              )!;
              target.pinned = !target.pinned;
            }),
          )
        }
      >
        {session.pinned ? t('unpin session') : t('pin session')}
      </DropdownMenu.Item>
      <Reveal workspaceId={session.workspaceId} />
      <DropdownMenu.Item onSelect={() => onDialog('rename', session.id)}>
        {t('rename session')}
      </DropdownMenu.Item>
      <DropdownMenu.Item
        disabled={!session.archivedAt && !canArchiveSession(snapshot, session)}
        onSelect={archive}
      >
        {session.archivedAt ? t('restore session') : t('archive session')}
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="dropdown-separator" />
      <DropdownMenu.Item
        disabled={
          session.id === snapshot.activeSessionId ||
          !canArchiveSession(snapshot, session)
        }
        onSelect={() => onDialog('delete-session', session.id)}
      >
        {t('delete session')}
      </DropdownMenu.Item>
    </Menu>
  );
}

export function WorkspaceMenu({
  workspace,
  onNew,
  onCollapseAll,
}: {
  workspace: Workspace;
  onNew: () => void;
  onCollapseAll: () => void;
}) {
  const { snapshot, runtime, perform } = useRuntime();
  const sessions = workspaceSessions(snapshot, workspace.id);
  return (
    <Menu label={t('workspace actions for {name}', { name: workspace.name })}>
      <DropdownMenu.Item onSelect={onNew}>{t('new session')}</DropdownMenu.Item>
      <Reveal workspaceId={workspace.id} />
      <DropdownMenu.Item onSelect={onCollapseAll}>
        {t('collapse all')}
      </DropdownMenu.Item>
      <DropdownMenu.Separator className="dropdown-separator" />
      <DropdownMenu.Item
        disabled={
          !sessions.length ||
          sessions.some((session) => !canArchiveSession(snapshot, session))
        }
        onSelect={() =>
          perform(async () => {
            if (runtime.mode === 'live')
              await runtime.request('archive-workspace', {
                workspaceId: workspace.id,
              });
            else
              runtime.change((state) => {
                for (const session of state.sessions.filter(
                  (session) => session.workspaceId === workspace.id,
                ))
                  session.archivedAt ??= new Date().toISOString();
              });
          })
        }
      >
        {t('archive all sessions')}
      </DropdownMenu.Item>
    </Menu>
  );
}

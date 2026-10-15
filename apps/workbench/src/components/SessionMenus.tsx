import {
  useEffect,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  Archive,
  FolderOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
  Trash2,
} from 'lucide-react';
import { formatChord } from '../model/shortcuts';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import {
  canArchiveSession,
  workspaceSessions,
} from '../model/session-management';
import type { DialogId, Session, Workspace } from '../model/types';
import { workspaceLabel } from '../model/workspace-label';
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

function Item({
  icon: Icon,
  label,
  hint,
  ...props
}: {
  icon: typeof Pin;
  label: string;
  hint?: string;
} & ComponentProps<typeof DropdownMenu.Item>) {
  return (
    <DropdownMenu.Item {...props}>
      <Icon size={14} />
      <span>{label}</span>
      {hint && <kbd>{hint}</kbd>}
    </DropdownMenu.Item>
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
    <Item
      icon={FolderOpen}
      label={platform === 'darwin' ? t('show in finder') : t('show in folder')}
      disabled={!host}
      onSelect={() => perform(() => host!.revealWorkspace(workspaceId))}
    />
  );
}

export function SessionMenu({
  session,
  onDialog,
  onRename,
}: {
  session: Session;
  onDialog: (dialog: DialogId, selection?: string) => void;
  /** When set, rename edits the sidebar row instead of opening a dialog. */
  onRename?: () => void;
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
      <Item
        icon={Pin}
        label={session.pinned ? t('unpin session') : t('pin session')}
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
      />
      <Reveal workspaceId={session.workspaceId} />
      <Item
        icon={Pencil}
        label={t('rename session')}
        hint={onRename ? 'F2' : undefined}
        onSelect={() =>
          onRename ? onRename() : onDialog('rename', session.id)
        }
      />
      <Item
        icon={Archive}
        label={session.archivedAt ? t('restore session') : t('archive session')}
        disabled={!session.archivedAt && !canArchiveSession(snapshot, session)}
        onSelect={archive}
      />
      <DropdownMenu.Separator className="dropdown-separator" />
      <Item
        className="danger"
        icon={Trash2}
        label={t('delete session')}
        disabled={
          session.lifecycle === 'deleting' ||
          session.occupied ||
          (runtime.mode !== 'live' &&
            (session.id === snapshot.activeSessionId ||
              !canArchiveSession(snapshot, session)))
        }
        onSelect={() => onDialog('delete-session', session.id)}
      />
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
    <Menu
      label={t('workspace actions for {name}', {
        name: workspaceLabel(workspace),
      })}
    >
      <Item
        icon={Plus}
        label={t('new session')}
        hint={formatChord('ctrl+n')}
        onSelect={onNew}
      />
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

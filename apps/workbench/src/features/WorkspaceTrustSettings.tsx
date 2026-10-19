import { useState } from 'react';
import { useRuntime } from '../app/context';
import { Button, Modal, Status } from '../components/common';
import {
  archiveStopsWork,
  workspaceSessions,
} from '../model/session-management';
import { currentSession } from '../model/state';
import { workspaceLabel } from '../model/workspace-label';
import type { Workspace } from '../model/types';
import { t, tn } from '../i18n';

/**
 * The folders this application has worked in. Trust decides whether Circle may
 * read a folder's own instructions, skills, commands and extensions. Removing one
 * takes that away and hides its sessions from the list; nothing on disk changes.
 */
export function WorkspaceTrustSettings({
  onReview,
  hidden,
}: {
  onReview: (workspaceId: string) => void;
  /** Workspaces that are not folders of their own, such as a task's isolated copy. */
  hidden?: ReadonlySet<string>;
}) {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const activeId = currentSession(snapshot).workspaceId;
  const remove = async (workspace: Workspace) => {
    const sessions = workspaceSessions(snapshot, workspace.id);
    if (runtime.mode === 'live') {
      // This dialog is the confirmation: tabs and tasks still running stop.
      if (sessions.length)
        await runtime.request('archive-workspace', {
          workspaceId: workspace.id,
          confirmed: true,
        });
      await runtime.request('trust-workspace', {
        enabled: false,
        workspaceId: workspace.id,
      });
    } else
      runtime.change((state) => {
        state.workspaces = state.workspaces.filter(
          (row) => row.id !== workspace.id,
        );
      });
    setRemoving(null);
    notify(
      runtime.mode === 'live'
        ? t('{name} is no longer trusted and its sessions are archived', {
            name: workspaceLabel(workspace),
          })
        : 'sample workspace removed from this preview',
    );
  };
  const sessions = removing
    ? workspaceSessions(snapshot, removing.id).length
    : 0;
  const stops =
    !!removing && archiveStopsWork(workspaceSessions(snapshot, removing.id));
  return (
    <section className="settings-block">
      <h2>{t('workspace trust')}</h2>
      <p className="panel-note">
        {t(
          'Circle reads a folder and runs in it only after you trust it. Trusting a folder lets Circle load the instructions, skills, commands and extensions that live in it.',
        )}
      </p>
      {snapshot.workspaces
        .filter((workspace) => !hidden?.has(workspace.id))
        .map((workspace) => (
          <div className="setting-row" key={workspace.id}>
            <span>
              {workspaceLabel(workspace)}
              <small>{workspace.path}</small>
            </span>
            <Status value={workspace.trusted ? 'trusted' : 'not trusted'} />
            <Button onClick={() => onReview(workspace.id)}>
              {t('review')}
            </Button>
            <Button
              className="danger"
              disabled={workspace.id === activeId}
              title={
                workspace.id === activeId
                  ? t('Circle is working in this folder now')
                  : undefined
              }
              onClick={() => setRemoving(workspace)}
            >
              {t('remove…')}
            </Button>
          </div>
        ))}
      <Modal
        open={!!removing}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('remove {name}?', {
          name: removing ? workspaceLabel(removing) : '',
        })}
      >
        {removing && (
          <>
            <p className="dialog-paragraph">{removing.path}</p>
            <p className="dialog-paragraph">
              {t(
                'Circle stops trusting this folder and hides its conversations from the sidebar. The files stay where they are, and so does the history: archived sessions stay under all sessions, and opening the folder again trusts it once you confirm.',
              )}
            </p>
            {stops && (
              <p className="dialog-paragraph">
                {t(
                  'Terminal tabs and tasks still running in these conversations stop.',
                )}
              </p>
            )}
            <p className="dialog-paragraph muted">
              {tn(sessions, '{n} conversation', '{n} conversations')}
            </p>
            <div className="dialog-actions">
              <Button onClick={() => setRemoving(null)}>{t('cancel')}</Button>
              <Button
                className="danger"
                onClick={() => perform(() => remove(removing))}
              >
                {t('remove workspace')}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </section>
  );
}

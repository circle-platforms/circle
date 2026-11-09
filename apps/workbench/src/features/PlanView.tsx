import { ClipboardList, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { IconButton } from '../components/common';
import { Markdown } from '../components/Markdown';
import { fullTime, shownTime } from '../model/time';
import { t } from '../i18n';
import { ModeButtons } from './mode-chrome';
import { workspaceCall } from '../model/workspace-client';
import './native-editor.css';

/**
 * Plan mode's plan, where a file opens, read as a document and kept up to date while
 * Circle writes it. Circle keeps it in its data folder, not in the workspace: it is read
 * here, and what should change goes in the answer to the plan card. Given another `file`
 * of the plan folder, one the model wrote there, it shows that file the same way, read
 * only: nothing in the window writes the plan folder.
 */
export function PlanView({
  file,
  onClose,
}: {
  file?: string;
  onClose: () => void;
}) {
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const other = usePlanFolderFile(session.id, file);
  const plan = file ? other.file : session.plan;
  const name = file ? file.split('/').pop()! : t('plan');
  const markdown = !file || /\.(md|markdown|mdown)$/i.test(file);
  return (
    <section className="file-view plan-view">
      <header className="file-view-heading">
        <div className="file-view-title">
          <div className="file-view-filename">
            <ClipboardList size={15} aria-hidden />
            <strong title={file}>{name}</strong>
          </div>
          {(plan || file) && (
            <div className="file-source-summary">
              <span
                className="file-source-folder"
                title={plan ? fullTime(plan.updatedAt) : undefined}
              >
                {file
                  ? t('plan folder, read only')
                  : t('updated {time}', { time: shownTime(plan!.updatedAt) })}
              </span>
            </div>
          )}
        </div>
        <span className="mode-toolbar-end">
          <ModeButtons />
          <IconButton
            label={file ? t('close file') : t('close plan')}
            onClick={onClose}
          >
            <X size={15} />
          </IconButton>
        </span>
      </header>
      {plan ? (
        <div
          className="file-markdown-reading"
          role="region"
          aria-label={name}
          tabIndex={0}
        >
          {markdown ? (
            <Markdown text={plan.text} />
          ) : (
            <pre className="plan-folder-text">{plan.text}</pre>
          )}
        </div>
      ) : file ? (
        <div className="empty-state" role={other.error ? 'alert' : 'status'}>
          {other.error ? (
            <>
              <p>{t('{file} could not be opened', { file: name })}</p>
              <p className="panel-note">{other.error}</p>
            </>
          ) : (
            t('opening file…')
          )}
        </div>
      ) : (
        <div className="empty-state" role="status">
          {t('Circle has not written a plan in this conversation yet.')}
        </div>
      )}
    </section>
  );
}

/** Another file of the plan folder, read once for the session that owns the folder. */
function usePlanFolderFile(sessionId: string, file?: string) {
  const [state, setState] = useState<{
    key: string;
    file?: { text: string; updatedAt: string };
    error?: string;
  }>({ key: '' });
  const key = file ? `${sessionId}\n${file}` : '';
  useEffect(() => {
    if (!file) return;
    let stale = false;
    workspaceCall<{ text: string; updatedAt: string }>(
      sessionId,
      'documents',
      'readPlanFolder',
      { path: file },
    ).then(
      (read) => !stale && setState({ key, file: read }),
      (error: unknown) =>
        !stale &&
        setState({
          key,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      stale = true;
    };
  }, [key]);
  return state.key === key ? state : { key };
}

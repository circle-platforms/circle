import { ClipboardList, X } from 'lucide-react';
import { useRuntime } from '../app/context';
import { currentSession } from '../model/state';
import { IconButton } from '../components/common';
import { Markdown } from '../components/Markdown';
import { fullTime, shownTime } from '../model/time';
import { t } from '../i18n';
import { ModeButtons } from './mode-chrome';
import './native-editor.css';

/**
 * Plan mode's plan, where a file opens, read as a document and kept up to date while
 * Circle writes it. Circle keeps it in its data folder, not in the workspace: it is read
 * here, and what should change goes in the answer to the plan card.
 */
export function PlanView({ onClose }: { onClose: () => void }) {
  const { snapshot } = useRuntime();
  const plan = currentSession(snapshot).plan;
  return (
    <section className="file-view plan-view">
      <header className="file-view-heading">
        <div className="file-view-title">
          <div className="file-view-filename">
            <ClipboardList size={15} aria-hidden />
            <strong>{t('plan')}</strong>
          </div>
          {plan && (
            <div className="file-source-summary">
              <span
                className="file-source-folder"
                title={fullTime(plan.updatedAt)}
              >
                {t('updated {time}', { time: shownTime(plan.updatedAt) })}
              </span>
            </div>
          )}
        </div>
        <span className="mode-toolbar-end">
          <ModeButtons />
          <IconButton label={t('close plan')} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </span>
      </header>
      {plan ? (
        <div
          className="file-markdown-reading"
          role="region"
          aria-label={t('plan')}
          tabIndex={0}
        >
          <Markdown text={plan.text} />
        </div>
      ) : (
        <div className="empty-state" role="status">
          {t('Circle has not written a plan in this conversation yet.')}
        </div>
      )}
    </section>
  );
}

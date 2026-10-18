import type { TaskRecord } from '../../../desktop/src/workspace/task-store';
import { Status } from '../components/common';
import { taskEvidence } from '../model/task-evidence';
import { t } from '../i18n';

export function TaskEvidence({ task }: { task: TaskRecord }) {
  const evidence = taskEvidence(task);
  if (!evidence) return null;
  return (
    <details className="task-evidence task-technical">
      <summary>{t('verification evidence')}</summary>
      <p className="panel-note">
        {t('recorded checks are separate from the worker completion claim')}
      </p>
      {evidence.checks.length === 0 && (
        <p>{t('no recorded verification checks')}</p>
      )}
      <ul className="task-evidence-checks">
        {evidence.checks.map((check, index) => (
          <li key={index}>
            <div className="task-evidence-heading">
              <strong>{check.criterion}</strong>
              <Status
                value={check.status === 'passed' ? 'success' : check.status}
              />
            </div>
            <span className="task-evidence-source">
              {check.source === 'command'
                ? t('command')
                : check.source === 'independent-review'
                  ? t('independent review')
                  : check.source === 'human'
                    ? t('human review')
                    : t('inspection')}
            </span>
            {check.command && <pre>{check.command}</pre>}
            {check.exitCode !== undefined && (
              <p>
                {t('exit code')}: {check.exitCode}
              </p>
            )}
            <p className="task-evidence-text">{check.evidence}</p>
          </li>
        ))}
      </ul>
      {evidence.paths.length > 0 && (
        <details>
          <summary>{t('changes')}</summary>
          <ul>
            {evidence.paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
        </details>
      )}
      {evidence.sha256 && (
        <dl>
          <dt>{t('patch identity')}</dt>
          <dd>
            <code>{evidence.sha256}</code>
          </dd>
          {evidence.head && (
            <>
              <dt>HEAD</dt>
              <dd>
                <code>{evidence.head}</code>
              </dd>
            </>
          )}
        </dl>
      )}
    </details>
  );
}

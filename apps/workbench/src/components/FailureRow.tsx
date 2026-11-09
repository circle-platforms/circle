import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { t } from '../i18n';
import { CopyButton, RowActions } from './common';
import './runtime-notice.css';

/**
 * A failure in the conversation as a line of its own, as tool lines are: the cause in red,
 * its details copied from the line's end. Opened, the line shows what the endpoint or the
 * runtime said in its own words, what to check, and what can be done next. A turn that
 * failed and a command the window asked use the same line.
 */
export function FailureRow({
  label,
  cause,
  detail,
  copy,
  note,
  actions,
  testId,
}: {
  /** The alert's name. */
  label: string;
  /** The one line that says what failed, in the interface language. */
  cause: string;
  /** What the endpoint or the runtime said, as sent; not the cause again. */
  detail?: string;
  /** What the copy button copies: the cause and the details. */
  copy: string;
  note?: string;
  actions?: ReactNode;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section
      className="line-row failure-row"
      role="alert"
      aria-label={label}
      data-testid={testId}
      data-open={open || undefined}
    >
      <div className="failure-row-head">
        <button
          type="button"
          className="line-summary failure-summary"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className="runtime-failure-cause">{cause}</span>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <RowActions>
          <CopyButton text={copy} label={t('copy error details')} />
        </RowActions>
      </div>
      {open && (
        <div className="failure-row-body">
          {detail && <pre className="failure-row-detail">{detail}</pre>}
          {note && <p className="panel-note">{note}</p>}
          {actions && <div className="runtime-failure-actions">{actions}</div>}
        </div>
      )}
    </section>
  );
}

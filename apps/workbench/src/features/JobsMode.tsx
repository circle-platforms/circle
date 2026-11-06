import {
  Activity,
  ChevronDown,
  ChevronRight,
  Square,
  Terminal,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { IconButton, PaneEmpty } from '../components/common';
import { useCommandTerminal } from '../components/CommandTerminalNavigation';
import { t } from '../i18n';
import { jobDot, sessionJobs } from '../model/jobs';
import { currentSession } from '../model/state';
import type { DialogId, Job } from '../model/types';
import { ModeButtons } from './mode-chrome';

/** A job has no terminal tab: to type into its command, its row opens that terminal. */
function JobTerminal({ job }: { job: Job }) {
  const open = useCommandTerminal();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { terminal, toolCallId } = job;
  if (!open || !terminal || !toolCallId) return null;
  return (
    <>
      <button
        type="button"
        className="text-button jobs-open-terminal"
        disabled={busy}
        onClick={async (event) => {
          const trigger = event.currentTarget;
          setBusy(true);
          setError('');
          try {
            await open(job.sessionId, toolCallId, trigger);
          } catch (failure) {
            setError(
              failure instanceof Error
                ? failure.message
                : t('command terminal could not be opened; try again'),
            );
          } finally {
            setBusy(false);
          }
        }}
      >
        <Terminal size={12} />
        {busy ? t('opening terminal…') : t('open in terminal')}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

/**
 * The background jobs mode: the commands Circle runs in the background for this
 * conversation, apart from the terminals the person opens. Running ones first, then the
 * finished, folded. A row opens to the command and the end of its output; a running
 * one can be stopped.
 */
export function JobsMode({
  selection,
  onDialog,
}: {
  selection: string;
  onDialog: (dialog: DialogId, id?: string) => void;
}) {
  const { snapshot } = useRuntime();
  const session = currentSession(snapshot);
  const { running, ended } = sessionJobs(session.id, snapshot.jobs);
  const [open, setOpen] = useState<ReadonlySet<string>>(
    () => new Set(selection ? [selection] : []),
  );
  const [finishedOpen, setFinishedOpen] = useState(true);
  // A job chosen elsewhere (the overview) opens here.
  useEffect(() => {
    if (!selection) return;
    setOpen((previous) => new Set(previous).add(selection));
    if (ended.some((job) => job.id === selection)) setFinishedOpen(true);
    // `ended` changes with every snapshot; only a new selection opens a card.
  }, [selection]);
  const toggle = (id: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const card = (job: Job) => {
    const expanded = open.has(job.id);
    const going = ['running', 'waiting', 'stopping'].includes(job.state);
    return (
      <article
        key={job.id}
        className="jobs-card"
        data-state={job.state}
        data-open={expanded || undefined}
      >
        <div className="jobs-card-head">
          <button
            type="button"
            className="jobs-card-toggle"
            aria-expanded={expanded}
            title={job.title}
            onClick={() => toggle(job.id)}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <i className="overview-dot" data-state={jobDot(job)} aria-hidden />
            <span className="jobs-title">{job.title}</span>
            <span className="jobs-time">{job.elapsed}</span>
          </button>
          {going && job.state !== 'stopping' && (
            <IconButton
              label={t('stop background job')}
              onClick={() => onDialog('job-stop', job.id)}
            >
              <Square size={11} />
            </IconButton>
          )}
        </div>
        {expanded && (
          <div className="jobs-detail">
            {job.command && <pre className="jobs-command">$ {job.command}</pre>}
            <JobTerminal job={job} />
            {job.output ? (
              <pre className="jobs-output">{job.output}</pre>
            ) : (
              !going && <p className="jobs-empty">{t('no output')}</p>
            )}
          </div>
        )}
      </article>
    );
  };
  return (
    <section className="jobs-mode">
      <header className="mode-toolbar">
        <span>{t('background jobs')}</span>
        <span className="mode-toolbar-end">
          <ModeButtons />
        </span>
      </header>
      {!running.length && !ended.length ? (
        <PaneEmpty icon={Activity} title={t('background jobs')}>
          <p>{t('the commands Circle runs in the background')}</p>
        </PaneEmpty>
      ) : (
        <div className="jobs-list" aria-label={t('background jobs')}>
          {running.length > 0 && (
            <section>
              <h3>
                {t('running')} {running.length}
              </h3>
              {running.map(card)}
            </section>
          )}
          {ended.length > 0 && (
            <section>
              <h3>
                <button
                  type="button"
                  className="jobs-group-toggle"
                  aria-expanded={finishedOpen}
                  onClick={() => setFinishedOpen((value) => !value)}
                >
                  {finishedOpen ? (
                    <ChevronDown size={13} />
                  ) : (
                    <ChevronRight size={13} />
                  )}
                  {t('finished')} {ended.length}
                </button>
              </h3>
              {finishedOpen && ended.map(card)}
            </section>
          )}
        </div>
      )}
    </section>
  );
}

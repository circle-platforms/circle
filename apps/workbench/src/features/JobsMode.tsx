import { Activity, ChevronDown, ChevronRight, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { IconButton, PaneEmpty } from '../components/common';
import { t } from '../i18n';
import { sessionJobs } from '../model/jobs';
import { currentSession } from '../model/state';
import type { DialogId, Job } from '../model/types';
import { ModeButtons } from './mode-chrome';

/**
 * The background jobs mode: the commands Circle runs in the background for this
 * conversation, apart from the terminals the person opens. Running ones first, then the
 * finished, folded. A card opens to the command and the end of its output; a running
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
          <pre className="jobs-output">
            {job.command && `$ ${job.command}\n`}
            {job.output || (going ? '' : t('no output'))}
          </pre>
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

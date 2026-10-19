import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import stripAnsi from 'strip-ansi';
import type {
  TerminalReplay,
  TerminalSnapshot,
} from '../../../desktop/src/workspace/terminal';
import { t } from '../i18n';
import { copyText } from '../host';
import { readTerminalOutput } from '../model/terminal-stream';
import { folderName, status } from '../model/terminal-status';
import { subscribeWorkspace, workspaceCall } from '../model/workspace-client';
import { IconButton, Status } from './common';
import '../styles/terminal.css';

const clock = (value: string) =>
  new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

/** When a console ran; a finished one shows both ends of its life. */
function when(item: TerminalSnapshot): string {
  return item.exitedAt
    ? `${clock(item.startedAt)} – ${clock(item.exitedAt)}`
    : clock(item.startedAt);
}

/**
 * Every console the session started, live or finished, with its output on
 * demand. The tab strip holds only the live ones; this is their record.
 */
export function TerminalHistory({ sessionId }: { sessionId: string }) {
  const [terminals, setTerminals] = useState<TerminalSnapshot[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    const take = (items: TerminalSnapshot[]) => {
      if (cancelled) return;
      setTerminals((previous) => [
        ...previous.filter((item) => item.sessionId !== sessionId),
        ...items,
      ]);
    };
    void workspaceCall<TerminalSnapshot[]>(sessionId, 'terminal', 'list')
      .then(take)
      .catch(() => {
        /* The terminal tab reports connection problems; the list stays empty. */
      });
    return subscribeWorkspace((event) => {
      if (event.service !== 'terminal' || event.sessionId !== sessionId) return;
      const update = event.data as unknown as { snapshot?: TerminalSnapshot };
      const snapshot = update.snapshot;
      if (!snapshot) return;
      setTerminals((previous) => [
        ...previous.filter((item) => item.id !== snapshot.id),
        snapshot,
      ]);
    });
  }, [sessionId]);
  const rows = terminals
    .filter((item) => item.sessionId === sessionId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const output = (id: string) =>
    readTerminalOutput(id, (afterSequence) =>
      workspaceCall<TerminalReplay>(sessionId, 'terminal', 'replay', {
        id,
        afterSequence,
        limit: 512,
      }),
    ).then((captured) =>
      // Conpty pads the first screen with blank lines; the record starts at
      // the first line the console actually printed.
      stripAnsi(captured).replace(/\r\n/g, '\n').replace(/^\n+/, ''),
    );
  const show = async (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    setOpen(id);
    setText((previous) => ({
      ...previous,
      [id]: previous[id] ?? t('loading developer tools…'),
    }));
    try {
      const captured = await output(id);
      setText((previous) => ({ ...previous, [id]: captured }));
    } catch (reason) {
      setText((previous) => ({
        ...previous,
        [id]: String(reason instanceof Error ? reason.message : reason),
      }));
    }
  };
  return (
    <section className="terminal-history" aria-label={t('command history')}>
      {rows.length === 0 ? (
        <p className="panel-note">{t('no terminals yet')}</p>
      ) : (
        <ul>
          {rows.map((item) => (
            <li key={item.id} className="terminal-history-row">
              <button
                type="button"
                className="terminal-history-head"
                aria-expanded={open === item.id}
                onClick={() => void show(item.id)}
              >
                {open === item.id ? (
                  <ChevronDown size={13} />
                ) : (
                  <ChevronRight size={13} />
                )}
                <span
                  className={`native-terminal-lamp ${item.serviceState ?? item.status}`}
                  aria-hidden="true"
                />
                <span className="terminal-history-name">{item.label}</span>
                <span className="muted small" title={item.cwd}>
                  {folderName(item.cwd)}
                </span>
                <Status value={status(item)} />
                <span className="muted small">{when(item)}</span>
              </button>
              <IconButton
                label={t('copy output')}
                onClick={() => {
                  void output(item.id)
                    .then(async (captured) => {
                      await copyText(captured);
                      setNotice(t('complete terminal output copied'));
                    })
                    .catch((reason) => {
                      setNotice(String(reason));
                    });
                }}
              >
                <Copy size={13} />
              </IconButton>
              {open === item.id && (
                <pre className="terminal-history-output" tabIndex={0}>
                  {text[item.id]}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && (
        <p className="panel-note" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

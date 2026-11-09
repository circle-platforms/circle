import { formatRuntimeNotice } from '../model/runtime-notice';
import { FailureRow } from './FailureRow';
import { CompactionOutcome } from '../features/CompactionStatus';
import { Brain, ChevronRight } from 'lucide-react';
import type { Message } from '../model/types';
import { formatBusyElapsed } from '../model/format';
import { fullTime, shownTime } from '../model/time';
import { Button, CopyButton, FileChip } from './common';
import './runtime-notice.css';
import {
  cleanThinking,
  thinkingHasBody,
  thinkingHeadline,
} from '../model/thinking';
import { Markdown } from './Markdown';
import { t, useLocale } from '../i18n';
import { useSources } from './SourceNavigation';
import { memo, type ReactNode } from 'react';
import { interruptedLabel } from '../model/completion';
import { useSessionDisclosure } from '../model/presentation';
import { ToolMessage } from './ToolMessage';
import { formatUsdAmount } from '../../../../src/pricing.ts';

/**
 * Hand-back and runtime notices are stored in English and shown in the interface language.
 * A tab the person named is called by that name, which is not translated.
 */
export function shownMessageText(message: Message): string {
  if (message.role === 'notice' && message.hookNotice)
    return formatRuntimeNotice(message);
  const { role, text } = message;
  if (role !== 'user') return text;
  const gave = /^the user gave terminal (\d+) back$/.exec(text);
  if (gave) return t('the user gave terminal {n} back', { n: gave[1] ?? '' });
  const named = /^the user gave “(.+)” back$/.exec(text);
  return named
    ? t('the user gave “{name}” back', { name: named[1] ?? '' })
    : text;
}

/**
 * A message as Claude shows one: yours in a bubble on the right, Circle's as plain text
 * with its thinking folded. The time, the usage and a copy button sit on one row under it.
 * It renders when the message changes, not with each publication.
 */
export const MessageView = memo(function MessageView({
  message,
  showThinking,
  interim,
  footer,
  onAttachment,
}: {
  message: Message;
  showThinking: boolean;
  /** Words on the way to more work: they read with what follows, the row shows on hover. */
  interim?: boolean;
  /** An action for the turn that ends here, on the row of its time and usage. */
  footer?: ReactNode;
  /** Used where no preview window is provided. */
  onAttachment?: () => void;
  /** Today, so that a time written as today's gains its date after midnight. */
  day?: string;
}) {
  useLocale();
  const sources = useSources();
  const [thinkingOpen, setThinkingOpen] = useSessionDisclosure(
    'thinking:' + message.id,
  );
  const preview = thinkingHeadline(message.thinking);
  const opens = thinkingHasBody(message.thinking);
  return (
    <article
      className={`message ${message.role}`}
      data-interim={interim || undefined}
    >
      {message.thinking && showThinking && (
        <details
          className="thinking"
          open={opens && thinkingOpen}
          data-heading-only={opens ? undefined : true}
        >
          <summary
            onClick={(event) => {
              event.preventDefault();
              // Headings alone have nothing more to show.
              if (opens) setThinkingOpen(!thinkingOpen);
            }}
          >
            <ChevronRight
              size={12}
              className="thinking-chevron"
              aria-hidden="true"
            />
            <Brain size={13} />
            <span>
              {message.thinkingSeconds === undefined
                ? t('thinking')
                : t('thinking {time}', {
                    time: formatBusyElapsed(message.thinkingSeconds),
                  })}
            </span>
            <span className="thinking-preview">{preview}</span>
          </summary>
          {opens && (
            <div className="thinking-body">
              <Markdown text={cleanThinking(message.thinking)} />
            </div>
          )}
        </details>
      )}
      {(message.shell ||
        message.text.trim() ||
        message.attachments?.length) && (
        <div className={message.role === 'user' ? 'bubble' : 'message-body'}>
          {message.shell ? (
            <>
              <ToolMessage
                tool={{
                  id: 'human-' + (message.shell.id ?? message.id),
                  name: message.shell.quiet ? '!!' : '!',
                  input: { command: message.shell.command },
                  output: message.shell.output,
                  status:
                    message.shell.status === 'done'
                      ? 'success'
                      : message.shell.status === 'error'
                        ? 'error'
                        : message.shell.status === 'stopped'
                          ? 'cancelled'
                          : 'running',
                }}
                ownerSessionId={message.shell.sourceSessionId}
                userShellId={
                  message.shell.interactive ? message.shell.id : undefined
                }
                expanded
                onFile={(path) => sources?.openFile(path)}
                onAgent={() => {}}
              />
              {message.shell.exitCode !== undefined && (
                <div className="message-meta">
                  {t('exit {code}', { code: message.shell.exitCode })}
                </div>
              )}
            </>
          ) : (
            <Markdown text={shownMessageText(message)} />
          )}
          {message.attachments?.length ? (
            <div className="message-attachments">
              {message.attachments.map((file) => (
                <FileChip
                  key={file.id}
                  name={file.name}
                  onClick={() =>
                    sources ? sources.openAttachment(file) : onAttachment?.()
                  }
                />
              ))}
            </div>
          ) : null}
        </div>
      )}
      <div className="message-meta">
        {message.label && <span className="label">{message.label}</span>}
        {shownTime(message.at) ? (
          <time
            dateTime={fullTime(message.at) && message.at}
            title={fullTime(message.at)}
          >
            {shownTime(message.at)}
          </time>
        ) : null}
        {message.usage && (
          <footer data-testid="turn-summary">{usageText(message.usage)}</footer>
        )}
        {message.text && (
          <CopyButton text={message.text} label={t('copy message')} size={12} />
        )}
        {footer}
      </div>
      {message.interrupted && (
        <div className="transcript-notice">{interruptedLabel()}</div>
      )}
    </article>
  );
});

const usageText = (usage: NonNullable<Message['usage']>) =>
  [
    usage.elapsed,
    `↑ ${usage.unreported && !usage.input ? 'N/A' : usage.input.toLocaleString() + (usage.unreported ? '+' : '')}`,
    `↓ ${usage.unreported && !usage.output ? 'N/A' : usage.output.toLocaleString() + (usage.unreported ? '+' : '')}`,
    usage.cost === undefined
      ? ''
      : usage.cost === null || !Number.isFinite(usage.cost)
        ? t('cost N/A')
        : formatUsdAmount(usage.cost, usage.estimated === true),
  ]
    .filter(Boolean)
    .join(' · ');

/** Only controller-owned failure identities are errors; quoted error text is ordinary content. */
export function RuntimeNotice({
  message,
  onConnection,
  onMessage,
}: {
  message: Message;
  onConnection: () => void;
  onMessage: () => void;
}) {
  // A compaction's outcome sits on the line where it ran
  if (message.compaction && message.compaction.status !== 'running')
    return <CompactionOutcome state={message.compaction} text={message.text} />;
  // A failed turn, as it happened or as restored from the history, is one failure line
  if (!message.id.startsWith('failure-') && !message.completionFailure)
    return (
      <div className="transcript-notice">
        {message.planCompleted === undefined
          ? formatRuntimeNotice(message)
          : t('plan completed · {n} steps', { n: message.planCompleted })}
      </div>
    );
  // The cause in the interface language on the line; under it, what the endpoint said
  const [cause, ...said] = message.text.split('\n');
  return (
    <FailureRow
      label={t('action failed')}
      cause={cause!}
      detail={said.join('\n').trim() || undefined}
      copy={message.text}
      note={t(
        'steps that finished before the error stay done; check them before you retry.',
      )}
      actions={
        <>
          <Button onClick={onMessage}>{t('return to message')}</Button>
          <Button onClick={onConnection}>{t('review connection')}</Button>
        </>
      }
    />
  );
}

import { formatRuntimeNotice } from '../model/runtime-notice';
import { Brain, ChevronRight, Copy } from 'lucide-react';
import { useRuntime } from '../app/context';
import { copyText } from '../host';
import type { Message } from '../model/types';
import { formatBusyElapsed } from '../model/format';
import { fullTime, shownTime } from '../model/time';
import { Button, FileChip, IconButton } from './common';
import './runtime-notice.css';
import { Markdown } from './Markdown';
import { t } from '../i18n';
import { useSources } from './SourceNavigation';
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
 */
export function MessageView({
  message,
  showThinking,
  onAttachment,
}: {
  message: Message;
  showThinking: boolean;
  /** Used where no preview window is provided. */
  onAttachment?: () => void;
}) {
  const { notify } = useRuntime();
  const sources = useSources();
  const [thinkingOpen, setThinkingOpen] = useSessionDisclosure(
    'thinking:' + message.id,
  );
  const preview = message.thinking?.trim().split('\n')[0]?.slice(0, 120);
  return (
    <article className={`message ${message.role}`}>
      {message.thinking && showThinking && (
        <details className="thinking" open={thinkingOpen}>
          <summary
            onClick={(event) => {
              event.preventDefault();
              setThinkingOpen(!thinkingOpen);
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
          <p>{message.thinking}</p>
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
          <IconButton
            label={t('copy message')}
            onClick={() =>
              copyText(message.text).then(
                () => notify(t('copied')),
                () => notify(t('clipboard unavailable')),
              )
            }
          >
            <Copy size={12} />
          </IconButton>
        )}
      </div>
      {message.interrupted && (
        <div className="transcript-notice">{interruptedLabel()}</div>
      )}
    </article>
  );
}

const usageText = (usage: NonNullable<Message['usage']>) =>
  [
    usage.elapsed,
    `↑ ${usage.unreported && !usage.input ? 'N/A' : usage.input.toLocaleString() + (usage.unreported ? '+' : '')}`,
    `↓ ${usage.unreported && !usage.output ? 'N/A' : usage.output.toLocaleString() + (usage.unreported ? '+' : '')}`,
    usage.cost === null || !Number.isFinite(usage.cost)
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
  const { notify } = useRuntime();
  if (!message.id.startsWith('failure-'))
    return (
      <div className="transcript-notice">
        {message.planCompleted === undefined
          ? formatRuntimeNotice(message)
          : t('plan completed · {n} steps', { n: message.planCompleted })}
      </div>
    );
  return (
    <section
      className="transcript-notice runtime-failure"
      role="alert"
      aria-label={t('action failed')}
    >
      <strong>{t('action failed')}</strong>
      {/* The cause in the runtime's own words; the whole text stays folded below. */}
      <p className="runtime-failure-cause">{message.text.split('\n')[0]}</p>
      <p className="panel-note">
        {t(
          'steps that finished before the error stay done; check them before you retry.',
        )}
      </p>
      {message.text.trim().includes('\n') && (
        <details>
          <summary>{t('error details')}</summary>
          <pre>{message.text}</pre>
        </details>
      )}
      <div className="runtime-failure-actions">
        <Button onClick={onMessage}>{t('return to message')}</Button>
        <Button onClick={onConnection}>{t('review connection')}</Button>
        <Button
          onClick={() =>
            void copyText(message.text).then(
              () => notify(t('copied')),
              () => notify(t('clipboard unavailable')),
            )
          }
        >
          {t('copy error details')}
        </Button>
      </div>
    </section>
  );
}

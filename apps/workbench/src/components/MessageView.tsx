import { formatRuntimeNotice } from '../model/runtime-notice';
import { Brain, ChevronRight, Copy } from 'lucide-react';
import { useRuntime } from '../app/context';
import { copyText } from '../host';
import type { Message } from '../model/types';
import { fullTime, shownTime } from '../model/time';
import { Button, FileChip, IconButton } from './common';
import './runtime-notice.css';
import { Markdown } from './Markdown';
import { t } from '../i18n';
import { useSources } from './SourceNavigation';
import { useSessionDisclosure } from '../model/presentation';

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
  onAttachment: () => void;
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
            <span>{t('thinking')}</span>
            <span className="thinking-preview">{preview}</span>
          </summary>
          <p>{message.thinking}</p>
        </details>
      )}
      <div className={message.role === 'user' ? 'bubble' : 'message-body'}>
        <Markdown text={message.text} />
        {message.attachments?.length ? (
          <div className="message-attachments">
            {message.attachments.map((file) => (
              <FileChip
                key={file.id}
                name={file.name}
                onClick={() =>
                  sources ? sources.openAttachment(file) : onAttachment()
                }
              />
            ))}
          </div>
        ) : null}
      </div>
      <div className="message-meta">
        {message.label && <span className="label">{message.label}</span>}
        <time
          dateTime={fullTime(message.at) && message.at}
          title={fullTime(message.at)}
        >
          {shownTime(message.at)}
        </time>
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
    </article>
  );
}

const usageText = (usage: NonNullable<Message['usage']>) =>
  [
    usage.elapsed,
    `↑ ${usage.input.toLocaleString()}`,
    `↓ ${usage.output.toLocaleString()}`,
    usage.cost === null ? t('cost N/A') : '$' + usage.cost.toFixed(4),
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
      <p>{t('review completed actions before trying again')}</p>
      <details>
        <summary>{t('error details')}</summary>
        <pre>{message.text}</pre>
      </details>
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

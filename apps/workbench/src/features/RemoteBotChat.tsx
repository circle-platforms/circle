import { desktopHost } from '../host';
import type { ChatFile } from '../../../../src/remote_bot_protocol';
import { Link } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useRuntime } from '../app/context';
import { useStableCallback } from '../app/stable-callback';
import { MessageView } from '../components/MessageView';
import { Button, FileChip } from '../components/common';
import { HubSignInButtons, HubSignInGuidance } from '../components/HubSignIn';
import { t, useLocale } from '../i18n';
import {
  HUB_SERVER,
  botIdentityKey,
  classifyRemoteBotFailure,
  deliveryText,
  findHubConnection,
  formatRemoteBotNotice,
  isHubConnected,
  mergeDeliveryStates,
  nextBotRetryDelay,
  translateBotTransferError,
  type BotDiscovery,
  type BotHistory,
  type RemoteBotFailure,
  type RemoteEvent,
} from '../model/remote-bot';

function errorMessage(reason: unknown, fallback: string) {
  return translateBotTransferError(reason, fallback);
}

export function RemoteBotLink() {
  useLocale();
  const { snapshot } = useRuntime();
  return isHubConnected(snapshot) ? (
    <Link className="workspace-trust" to="/page/remote-bot">
      {t('my bot')}
    </Link>
  ) : null;
}

function DisconnectedPanel({
  detail,
  signIn,
  reconnecting,
  onRetry,
}: {
  detail?: string;
  signIn?: { url: string; code?: string };
  reconnecting: boolean;
  onRetry: () => void;
}) {
  const [openError, setOpenError] = useState('');
  return (
    <div className="empty-state" data-bot-error-kind="disconnected">
      <h2>{t('remote bot disconnected')}</h2>
      {signIn ? (
        <HubSignInGuidance
          signIn={signIn}
          statusRole="status"
          hint={t(
            'Check “Allow this client to use my bot” on the Hub confirmation page.',
          )}
        />
      ) : (
        <>
          <p role="status">{t('Hub is not connected right now.')}</p>
          <p className="muted small">
            {t(
              'Check your Hub connection in Settings -> Extensions, or retry reconnecting.',
            )}
          </p>
        </>
      )}
      {detail && !signIn && <p className="muted small">{detail}</p>}
      {openError && (
        <p className="muted small" role="alert">
          {openError}
        </p>
      )}
      <span className="empty-state-actions">
        {signIn && (
          <HubSignInButtons signIn={signIn} onOpenError={setOpenError} />
        )}
        <Button type="button" disabled={reconnecting} onClick={onRetry}>
          {t('retry')}
        </Button>
      </span>
    </div>
  );
}

export function RemoteBotChat() {
  useLocale();
  const { snapshot, runtime } = useRuntime();
  const connection = findHubConnection(snapshot);
  const [reconnecting, setReconnecting] = useState(false);
  return connection ? (
    <Chat
      key={connection.url}
      connected={connection.status === 'connected'}
      connectionStatus={connection.status}
      connectionError={connection.error}
      signIn={connection.signIn}
      hasAuthorizationHeader={connection.hasAuthorizationHeader}
      settingsPath={connection.settingsPath}
      request={runtime.request}
    />
  ) : (
    <DisconnectedPanel
      reconnecting={reconnecting}
      onRetry={() => {
        setReconnecting(true);
        void Promise.resolve(runtime.request('reload'))
          .catch(() => {})
          .finally(() => setReconnecting(false));
      }}
    />
  );
}

function Chat({
  request,
  connected,
  connectionStatus,
  connectionError,
  signIn,
  hasAuthorizationHeader,
  settingsPath,
}: {
  connected: boolean;
  connectionStatus: string;
  connectionError?: string;
  signIn?: { url: string; code?: string };
  hasAuthorizationHeader?: boolean;
  settingsPath?: string;
  request: ReturnType<typeof useRuntime>['runtime']['request'];
}) {
  useLocale();
  const [bot, setBot] = useState<BotDiscovery>();
  const [delivery, setDelivery] = useState<Record<string, string>>({});
  const [events, setEvents] = useState<RemoteEvent[]>([]);
  const [queued, setQueued] = useState<NonNullable<BotHistory['queued']>>([]);
  const [active, setActive] = useState<BotHistory['active']>(null);
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);
  const [failure, setFailure] = useState<RemoteBotFailure>();
  const [sending, setSending] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const identity = useRef('');
  const cursor = useRef(0);
  const pending = useRef<
    | { request: string; text: string; conversation: string; files: ChatFile[] }
    | undefined
  >(undefined);
  const nextConversation = useRef<string | undefined>(undefined);
  const invoke = useStableCallback((value: Record<string, unknown>) =>
    request('remote-bot', value),
  );

  useEffect(() => {
    if (!connected) {
      setBot(undefined);
      setActive(null);
      setFailure(undefined);
      setOffline(true);
      return;
    }
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = 0;
    async function read() {
      let nextDelay: number | undefined = 1000;
      try {
        const current = (await invoke({ action: 'discover' })) as BotDiscovery;
        if (closed) return;
        const key = botIdentityKey(current);
        if (identity.current !== key) {
          identity.current = key;
          cursor.current = 0;
          pending.current = undefined;
          setEvents([]);
          setQueued([]);
          setActive(null);
          setText('');
          setFiles([]);
          setError('');
        }
        const history = (await invoke({
          action: 'history',
          conversation: current.current,
          binding: current.binding,
          after: cursor.current,
        })) as BotHistory;
        if (closed) return;
        setQueued(history.queued ?? []);
        setDelivery(mergeDeliveryStates(history));
        if (history.events.length) {
          cursor.current = history.events[history.events.length - 1]!.cursor;
          setEvents((old) => old.concat(history.events));
          if (history.events.length === 100) nextDelay = 0;
        }
        setQuestion(history.question ?? null);
        setBot(current);
        setActive(history.active);
        setFailure(undefined);
        setOffline(false);
        backoffMs = 0;
      } catch (reason) {
        if (!closed) {
          const classified = classifyRemoteBotFailure(reason, {
            hasAuthorizationHeader,
            settingsPath,
          });
          setFailure(classified);
          setOffline(true);
          setBot(undefined);
          setActive(null);
          if (classified.retryable) {
            backoffMs = nextBotRetryDelay(backoffMs);
            nextDelay = backoffMs;
          } else {
            nextDelay = undefined;
          }
        }
      }
      if (!closed && nextDelay !== undefined) {
        timer = setTimeout(() => void read(), nextDelay);
      }
    }
    void read();
    return () => {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [invoke, epoch, connected, hasAuthorizationHeader, settingsPath]);

  async function act(action: 'send' | 'stop' | 'new') {
    if (!bot || sending) return;
    setSending(true);
    setError('');
    try {
      const base = { action, binding: bot.binding };
      if (action === 'send') {
        if (
          !pending.current ||
          pending.current.text !== text ||
          pending.current.files !== files ||
          pending.current.conversation !== bot.current
        )
          pending.current = {
            request: crypto.randomUUID(),
            text,
            conversation: bot.current,
            files,
          };
        await invoke({
          ...base,
          ...pending.current,
          ...(question ? { replyTo: question } : {}),
        });
        pending.current = undefined;
        setText('');
        setFiles([]);
      } else if (action === 'new') {
        nextConversation.current ??= crypto.randomUUID();
        await invoke({ ...base, request: nextConversation.current });
        nextConversation.current = undefined;
      } else if (active) {
        await invoke({
          ...base,
          conversation: bot.current,
          request: active.request,
        });
      }
      setEpoch((n) => n + 1);
    } catch (reason) {
      setError(errorMessage(reason, t('remote bot disconnected')));
    } finally {
      setSending(false);
    }
  }

  if (!connected)
    return (
      <DisconnectedPanel
        detail={connectionError}
        signIn={signIn}
        reconnecting={reconnecting}
        onRetry={() => {
          setReconnecting(true);
          void Promise.resolve(
            connectionStatus === 'reload required'
              ? request('reload')
              : request('mcp.reload-server', { name: HUB_SERVER }),
          )
            .catch(() => request('reload'))
            .catch(() => {})
            .finally(() => {
              setReconnecting(false);
              setEpoch((n) => n + 1);
            });
        }}
      />
    );
  if (offline) {
    const view =
      failure ??
      classifyRemoteBotFailure(undefined, {
        hasAuthorizationHeader,
        settingsPath,
      });
    return (
      <div className="empty-state" data-bot-error-kind={view.kind}>
        <h2>{view.title}</h2>
        <p role="status">{view.cause}</p>
        <p className="muted small">{view.action}</p>
        {view.detail && <p className="muted small">{view.detail}</p>}
        <span className="empty-state-actions">
          {view.canReauthorize && (
            <Button
              className="primary"
              type="button"
              disabled={reconnecting}
              onClick={() => {
                setReconnecting(true);
                void Promise.resolve(
                  request('mcp.reauthorize-server', {
                    name: HUB_SERVER,
                    ...(view.reauthorizeScope
                      ? { scope: view.reauthorizeScope }
                      : {}),
                  }),
                )
                  .catch(() => {})
                  .finally(() => {
                    setReconnecting(false);
                    setEpoch((n) => n + 1);
                  });
              }}
            >
              {t('sign in again')}
            </Button>
          )}
          <Button
            type="button"
            disabled={reconnecting}
            onClick={() => setEpoch((n) => n + 1)}
          >
            {t('retry')}
          </Button>
        </span>
      </div>
    );
  }
  const inputLabel = question ? t('answer the bot') : t('message your bot');
  return (
    <section className="conversation" aria-label={t('my bot')}>
      <header className="conversation-heading">
        <h1>{bot?.name || t('my bot')}</h1>
        <div className="heading-actions">
          <Button disabled={!bot || sending} onClick={() => void act('new')}>
            {t('new bot conversation')}
          </Button>
        </div>
      </header>
      <div className="transcript">
        <div className="transcript-column">
          {events.map(
            ({
              id,
              at,
              role,
              text,
              code,
              files: assets,
              delivery: initial,
            }) => (
              <MessageView
                key={id}
                footer={
                  <>
                    {assets?.map((file, slot) => {
                      const status = deliveryText(delivery[`${id}:${slot}`]);
                      return (
                        <span
                          className="file-chip"
                          key={`${slot}:${file.sha256}:${file.name}`}
                        >
                          <button
                            type="button"
                            onClick={() => {
                              if (bot)
                                void desktopHost()
                                  ?.saveBotFile?.(bot.binding, file)
                                  .catch((e) =>
                                    setError(
                                      errorMessage(
                                        e,
                                        t('remote bot disconnected'),
                                      ),
                                    ),
                                  );
                            }}
                          >
                            {file.name} · {file.size} B
                          </button>
                          {status && <span>{status}</span>}
                        </span>
                      );
                    })}
                    {deliveryText(delivery[id] ?? initial)}
                  </>
                }
                message={{
                  id,
                  at,
                  role,
                  text:
                    role === 'notice'
                      ? formatRemoteBotNotice(code, text)
                      : text,
                  parentId: null,
                }}
                showThinking={false}
              />
            ),
          )}
          {queued.map((q) => (
            <MessageView
              key={q.request}
              message={{
                id: q.request,
                role: 'user',
                at: q.at,
                text: q.text,
                parentId: null,
              }}
              footer={t('queued')}
              showThinking={false}
            />
          ))}
          {active?.draft && (
            <MessageView
              message={{
                id: active.request,
                at: '',
                role: 'assistant',
                text: active.draft,
                parentId: null,
              }}
              interim
              showThinking={false}
            />
          )}
        </div>
      </div>
      <div className="composer-area">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void act('send');
          }}
        >
          <textarea
            id="remote-bot-input"
            rows={1}
            aria-label={inputLabel}
            placeholder={inputLabel}
            disabled={!bot}
            maxLength={16000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                if (bot && (text.trim() || files.length) && !sending)
                  void act('send');
              }
            }}
          />
          {files.length > 0 && (
            <div className="attachment-strip">
              {files.map((file, index) => (
                <FileChip
                  key={`${index}:${file.sha256}:${file.name}`}
                  name={file.name}
                  onRemove={() =>
                    setFiles((prev) => prev.filter((_, i) => i !== index))
                  }
                />
              ))}
            </div>
          )}
          <div className="composer-toolbar">
            <div>
              <Button
                type="button"
                disabled={!bot || sending}
                onClick={async () => {
                  if (!bot) return;
                  const key = identity.current;
                  try {
                    const selected = await desktopHost()?.attachBotFiles?.(
                      bot.binding,
                    );
                    if (
                      selected &&
                      selected.length > 0 &&
                      key === identity.current
                    ) {
                      setError('');
                      setFiles(selected);
                    }
                  } catch (e) {
                    setError(errorMessage(e, t('remote bot disconnected')));
                  }
                }}
              >
                {t('attach files')}
              </Button>
            </div>
            <div>
              {active && (
                <Button
                  type="button"
                  disabled={sending}
                  onClick={() => void act('stop')}
                >
                  {t('stop')}
                </Button>
              )}
              <Button
                className="primary"
                type="submit"
                disabled={!bot || (!text.trim() && !files.length) || sending}
              >
                {t('send')}
              </Button>
            </div>
          </div>
        </form>
        {error && (
          <p className="muted small" role="status">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

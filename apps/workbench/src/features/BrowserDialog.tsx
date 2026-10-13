import { useEffect, useRef, useState } from 'react';
import { Globe } from 'lucide-react';
import { desktopHost } from '../host';
import { useRuntime } from '../app/context';
import { Button } from '../components/common';
import { dialogSource } from '../model/browser';
import type { BrowserDialog } from '../../../desktop/src/contracts';
import { t } from '../i18n';

const title = (dialog: BrowserDialog) =>
  dialog.type === 'beforeunload'
    ? t('leave site?')
    : dialog.type === 'auth'
      ? dialog.proxy
        ? t('the proxy {host} asks you to sign in', { host: dialog.origin })
        : t('sign in to {host}', { host: dialog.origin })
      : t('{host} says', { host: dialogSource(dialog) || t('this page') });
const body = (dialog: BrowserDialog) =>
  dialog.type === 'beforeunload'
    ? t('Changes you made may not be saved.')
    : dialog.type === 'auth'
      ? (dialog.realm ?? '')
      : dialog.message;

/** One answer per dialog, from wherever the person answers it. */
function useAnswer(sessionId: string, dialog: BrowserDialog) {
  const { notify } = useRuntime();
  const [text, setText] = useState(dialog.defaultPrompt);
  // A sign-in's password stays here and goes only to the browser
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    setText(dialog.defaultPrompt);
    setPassword('');
    setSent(false);
  }, [dialog.id, dialog.defaultPrompt]);
  const answer = (accept: boolean) => {
    if (sent || dialog.answering) return;
    setSent(true);
    const auth = dialog.type === 'auth' && accept;
    void desktopHost()!
      .browserDialog(
        sessionId,
        dialog.id,
        accept,
        dialog.type === 'prompt' || auth ? text : undefined,
        auth ? password : undefined,
      )
      .catch(() => {
        setSent(false);
        notify(t('the dialog was already answered'));
      });
  };
  return {
    text,
    setText,
    password,
    setPassword,
    answer,
    busy: sent || !!dialog.answering,
  };
}

/** What the person types into a dialog: a prompt's answer, or a sign-in's name and password. */
function Fields({
  dialog,
  form,
  focus,
}: {
  dialog: BrowserDialog;
  form: ReturnType<typeof useAnswer>;
  focus?: boolean;
}) {
  const { text, setText, password, setPassword, answer, busy } = form;
  const enter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') answer(true);
  };
  if (dialog.type === 'prompt')
    return (
      <input
        className="input"
        aria-label={t('dialog answer')}
        value={text}
        disabled={busy}
        autoFocus={focus}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={enter}
      />
    );
  if (dialog.type !== 'auth') return null;
  return (
    <div className="browser-dialog-fields">
      <input
        className="input"
        aria-label={t('user name')}
        placeholder={t('user name')}
        autoComplete="off"
        value={text}
        disabled={busy}
        autoFocus={focus}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={enter}
      />
      <input
        className="input"
        type="password"
        aria-label={t('password')}
        placeholder={t('password')}
        autoComplete="off"
        value={password}
        disabled={busy}
        onChange={(event) => setPassword(event.target.value)}
        onKeyDown={enter}
      />
    </div>
  );
}

const Buttons = ({
  dialog,
  answer,
  busy,
  ok,
  cancel,
}: {
  dialog: BrowserDialog;
  answer: (accept: boolean) => void;
  busy: boolean;
  ok?: React.Ref<HTMLButtonElement>;
  cancel?: React.Ref<HTMLButtonElement>;
}) => (
  <div className="browser-dialog-actions">
    {dialog.type !== 'alert' && (
      <Button ref={cancel} disabled={busy} onClick={() => answer(false)}>
        {dialog.type === 'beforeunload' ? t('stay') : t('cancel')}
      </Button>
    )}
    <Button
      ref={ok}
      className="primary"
      disabled={busy}
      onClick={() => answer(true)}
    >
      {dialog.type === 'beforeunload'
        ? t('leave')
        : dialog.type === 'auth'
          ? t('sign in')
          : t('OK')}
    </Button>
  </div>
);

/**
 * A page's dialog where the page is: over the browser panel's view, on a picture of the
 * page as it stopped, as a browser shows it over its tab.
 */
export function BrowserDialogPanel({
  sessionId,
  dialog,
}: {
  sessionId: string;
  dialog: BrowserDialog;
}) {
  const form = useAnswer(sessionId, dialog);
  const { answer, busy } = form;
  const [screen, setScreen] = useState<string | null>(null);
  const [pointer, setPointer] = useState<{
    x: number;
    y: number;
    pressed: boolean;
  } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const ok = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setScreen(null);
    if (dialog.type === 'beforeunload') return;
    let live = true;
    void desktopHost()!
      .browserDialogScreen(sessionId, dialog.id)
      .then((value) => live && setScreen(value))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId, dialog.id, dialog.type]);
  // Circle answers: its pointer moves to the button and presses it.
  useEffect(() => {
    if (!dialog.answering) {
      setPointer(null);
      return;
    }
    const target = (dialog.answering.accept ? ok : cancel).current;
    const box = area.current?.getBoundingClientRect();
    if (!target || !box) return;
    const rect = target.getBoundingClientRect();
    setPointer({ x: 16, y: 16, pressed: false });
    const frame = requestAnimationFrame(() =>
      setPointer({
        x: rect.x - box.x + rect.width / 2,
        y: rect.y - box.y + rect.height / 2,
        pressed: false,
      }),
    );
    const press = setTimeout(
      () => setPointer((value) => value && { ...value, pressed: true }),
      430,
    );
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(press);
    };
  }, [dialog.answering]);
  return (
    <div
      className="browser-dialog-layer"
      ref={area}
      data-testid="browser-page-dialog"
    >
      {screen && <img className="browser-dialog-screen" src={screen} alt="" />}
      <div
        className="browser-dialog-box"
        role="alertdialog"
        aria-label={title(dialog)}
      >
        <strong>{title(dialog)}</strong>
        {body(dialog) && <p>{body(dialog)}</p>}
        <Fields dialog={dialog} form={form} focus />
        <Buttons
          dialog={dialog}
          answer={answer}
          busy={busy}
          ok={ok}
          cancel={cancel}
        />
        {dialog.answering && (
          <small className="browser-dialog-note">
            {t('Circle is answering')}
          </small>
        )}
      </div>
      {pointer && (
        <svg
          className={`browser-dialog-pointer${pointer.pressed ? ' pressed' : ''}`}
          style={{ transform: `translate(${pointer.x}px, ${pointer.y}px)` }}
          viewBox="0 0 24 24"
          width="24"
          height="24"
          aria-hidden="true"
        >
          <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
        </svg>
      )}
    </div>
  );
}

/** The same dialog in the conversation while Circle works, to answer it from there. */
export function BrowserDialogRequest({
  sessionId,
  dialog,
}: {
  sessionId: string;
  dialog: BrowserDialog;
}) {
  const form = useAnswer(sessionId, dialog);
  const { answer, busy } = form;
  return (
    <section
      className="inline-request"
      data-kind="browser-dialog"
      data-testid="browser-dialog-request"
    >
      <header>
        <Globe size={14} />
        <strong>{title(dialog)}</strong>
        <span>{t('the page in the browser waits for an answer')}</span>
      </header>
      {body(dialog) && <p className="browser-dialog-message">{body(dialog)}</p>}
      <Fields dialog={dialog} form={form} />
      <Buttons dialog={dialog} answer={answer} busy={busy} />
    </section>
  );
}

/**
 * The person has the browser while the turn runs: Circle waits for it back, whether it
 * asked for help or the person took over.
 */
export function BrowserHandoffRequest({
  sessionId,
  reason,
}: {
  sessionId: string;
  reason?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <section
      className="inline-request"
      data-kind="browser-handoff"
      data-testid="browser-handoff-request"
    >
      <header>
        <Globe size={14} />
        <strong>{t('you have the browser')}</strong>
        <span>{t('Circle waits until you hand it back')}</span>
      </header>
      {reason && <p className="browser-dialog-message">{reason}</p>}
      <div className="request-actions">
        <Button
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void desktopHost()
              ?.browserControl(sessionId, 'return')
              .finally(() => setBusy(false));
          }}
        >
          {t('hand back')}
        </Button>
      </div>
    </section>
  );
}

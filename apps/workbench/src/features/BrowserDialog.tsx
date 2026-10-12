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
    : t('{host} says', { host: dialogSource(dialog) || t('this page') });
const body = (dialog: BrowserDialog) =>
  dialog.type === 'beforeunload'
    ? t('Changes you made may not be saved.')
    : dialog.message;

/** One answer per dialog, from wherever the person answers it. */
function useAnswer(sessionId: string, dialog: BrowserDialog) {
  const { notify } = useRuntime();
  const [text, setText] = useState(dialog.defaultPrompt);
  const [sent, setSent] = useState(false);
  useEffect(() => {
    setText(dialog.defaultPrompt);
    setSent(false);
  }, [dialog.id, dialog.defaultPrompt]);
  const answer = (accept: boolean) => {
    if (sent || dialog.answering) return;
    setSent(true);
    void desktopHost()!
      .browserDialog(
        sessionId,
        dialog.id,
        accept,
        dialog.type === 'prompt' ? text : undefined,
      )
      .catch(() => {
        setSent(false);
        notify(t('the dialog was already answered'));
      });
  };
  return { text, setText, answer, busy: sent || !!dialog.answering };
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
      {dialog.type === 'beforeunload' ? t('leave') : t('OK')}
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
  const { text, setText, answer, busy } = useAnswer(sessionId, dialog);
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
        {dialog.type === 'prompt' && (
          <input
            className="input"
            aria-label={t('dialog answer')}
            value={text}
            disabled={busy}
            autoFocus
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') answer(true);
            }}
          />
        )}
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
  const { text, setText, answer, busy } = useAnswer(sessionId, dialog);
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
      {dialog.type === 'prompt' && (
        <input
          className="input"
          aria-label={t('dialog answer')}
          value={text}
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
        />
      )}
      <Buttons dialog={dialog} answer={answer} busy={busy} />
    </section>
  );
}

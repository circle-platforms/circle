import { useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { Button, Fold } from '../components/common';
import {
  KEY_ACTIONS,
  KEY_ACTION_TEXT,
  chordFromEvent,
  formatChord,
  isBindableChord,
  validateKeybindings,
  type KeyAction,
} from '../model/shortcuts';
import { t } from '../i18n';

const actions = Object.keys(KEY_ACTIONS) as KeyAction[];
const isMac = () => document.documentElement.dataset.desktop === 'darwin';
// A binding is one key or a list of them, as keybindings.json writes it.
const chordsOf = (key: string | string[]) => (Array.isArray(key) ? key : [key]);
const shownAs = (key: string | string[], mac: boolean) =>
  chordsOf(key)
    .map((chord) => formatChord(chord, mac))
    .join(' / ');

/**
 * Circle's actions and the keys that trigger them. Each starts on its default
 * key; recording a key takes the action off that, and a reset puts it back. The
 * keys belong to this application, not to the terminal's `keybindings.json`.
 */
export function KeyboardSettings({
  onShowShortcuts,
}: {
  onShowShortcuts: () => void;
}) {
  const { snapshot, runtime } = useRuntime();
  const bindings = snapshot.settings.keybindings;
  const [recording, setRecording] = useState<KeyAction | null>(null);
  const [problem, setProblem] = useState('');
  const [shown, setShown] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftProblem, setDraftProblem] = useState('');
  const mac = isMac();
  const change = (next: Record<string, string | string[]>) =>
    runtime.change((state) => {
      state.settings.keybindings = next;
    });
  const set = (action: KeyAction, chord: string | null) => {
    const next: Record<string, string | string[]> = { ...bindings };
    if (chord === null) delete next[action];
    else next[action] = chord;
    change(next);
  };
  // The recorder takes the next key itself, before the conversation sees it.
  useEffect(() => {
    if (!recording) return;
    const take = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        setProblem('');
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      if (!isBindableChord(chord)) {
        setProblem(
          t('a letter or a number needs ctrl, alt, shift or cmd with it'),
        );
        return;
      }
      set(recording, chord);
      setProblem('');
      setRecording(null);
    };
    addEventListener('keydown', take, true);
    return () => removeEventListener('keydown', take, true);
  }, [recording, bindings]);
  // Two actions on one key: the first of them takes it, as in the terminal.
  const byChord = new Map<string, KeyAction[]>();
  for (const action of actions)
    for (const chord of chordsOf(
      (bindings[action] ?? KEY_ACTIONS[action]) as string | string[],
    ))
      byChord.set(chord, [...(byChord.get(chord) ?? []), action]);
  const shared = [...byChord].filter(([, rows]) => rows.length > 1);
  const applyDraft = () => {
    setDraftProblem('');
    try {
      change(validateKeybindings(JSON.parse(draft)));
      setShown(false);
    } catch (error) {
      setDraftProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="settings-block">
      <h2>{t('keyboard')}</h2>
      <p className="panel-note">
        {t(
          'Every action starts on its default key. Choose change… and press the keys you want instead; esc gives up. These keys belong to this application; the terminal reads keybindings.json.',
        )}
      </p>
      <Button onClick={onShowShortcuts}>{t('view shortcuts')}</Button>
      <div className="key-actions">
        <div className="key-actions-head" aria-hidden>
          <span>{t('action')}</span>
          <span>{t('default')}</span>
          <span>{t('key')}</span>
          <span />
        </div>
        {actions.map((action) => {
          const key = (bindings[action] ?? KEY_ACTIONS[action]) as
            string | string[];
          const custom =
            JSON.stringify(key) !== JSON.stringify(KEY_ACTIONS[action]);
          const waiting = recording === action;
          const label = KEY_ACTION_TEXT[action]();
          return (
            <div className="key-action" key={action}>
              <span>
                {label}
                <small>{action}</small>
              </span>
              <kbd className="muted">{shownAs(KEY_ACTIONS[action], mac)}</kbd>
              <kbd className={waiting ? 'waiting' : ''} aria-live="polite">
                {waiting ? t('press a key…') : shownAs(key, mac)}
              </kbd>
              <span className="key-action-buttons">
                {custom && !waiting && (
                  <Button
                    onClick={() => set(action, null)}
                    aria-label={t('reset the key for {action}', {
                      action: label,
                    })}
                    title={t('back to {key}', {
                      key: shownAs(KEY_ACTIONS[action], mac),
                    })}
                  >
                    {t('reset')}
                  </Button>
                )}
                <Button
                  className={waiting ? 'primary' : ''}
                  aria-label={
                    waiting
                      ? t('stop recording for {action}', { action: label })
                      : t('change the key for {action}', { action: label })
                  }
                  onClick={() => {
                    setProblem('');
                    setRecording(waiting ? null : action);
                  }}
                >
                  {waiting ? t('cancel') : t('change…')}
                </Button>
              </span>
            </div>
          );
        })}
      </div>
      {problem && (
        <p className="field-problem" role="status">
          {problem}
        </p>
      )}
      {shared.length > 0 && (
        <p className="panel-note" role="status">
          {t('one key on two actions:')}{' '}
          {shared
            .map(
              ([chord, rows]) =>
                `${shownAs(chord, mac)} · ${rows
                  .map((action) => KEY_ACTION_TEXT[action]())
                  .join(', ')}`,
            )
            .join('; ')}
        </p>
      )}
      <Button
        disabled={Object.keys(bindings).length === 0}
        onClick={() => change({})}
      >
        {t('reset every key')}
      </Button>
      <Fold
        title={t('edit the bindings as JSON')}
        open={shown}
        onToggle={() => {
          if (!shown) setDraft(JSON.stringify(bindings, null, 2));
          setShown(!shown);
        }}
      >
        <p>
          {t(
            'The same spelling as keybindings.json: an action and its key, or a list of keys. Applying this replaces every change made above.',
          )}
        </p>
        <textarea
          className="code-editor short"
          aria-label={t('keybindings json')}
          spellCheck={false}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        {draftProblem && (
          <p className="field-problem" role="status">
            {draftProblem}
          </p>
        )}
        <div className="dialog-actions">
          <Button onClick={() => setShown(false)}>{t('cancel')}</Button>
          <Button className="primary" onClick={applyDraft}>
            {t('apply')}
          </Button>
        </div>
      </Fold>
    </section>
  );
}

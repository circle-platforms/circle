import { useEffect, useState } from 'react';
import { useRuntime } from '../app/context';
import { t } from '../i18n';
import {
  KEY_ACTIONS,
  chordFromEvent,
  effectiveBindings,
  formatChord,
  validateKeybindings,
  type KeyAction,
} from '../model/shortcuts';
import { Button } from '../components/common';

const LABELS: Record<KeyAction, () => string> = {
  interrupt: () => t('stop the turn, or clear the box'),
  clear: () => t('clear the draft'),
  exit: () => t('close session'),
  suspend: () => t('suspend'),
  'model.select': () => t('models'),
  'session.select': () => t('resume a session'),
  'model.cycle': () => t('next model'),
  'mode.cycle': () => t('next approval mode'),
  'thinking.cycle': () => t('next thinking depth'),
  'plan.focus': () => t('focus the plan'),
  'thinking.toggle': () => t('show or hide thinking'),
  'tools.expand': () => t('expand tool details'),
  'editor.external': () => t('write the message in a larger editor'),
  'message.copy': () => t('copy the last answer'),
  'message.dequeue': () => t('take back queued messages'),
  'message.followup': () => t('queue a follow-up'),
  'image.paste': () => t('paste an image'),
  find: () => t('find in conversation'),
  'history.search': () => t('search'),
  'secret.enter': () => t('enter a secret'),
  newline: () => t('new line'),
  'job.background': () => t('background the turn'),
  'sidebar.toggle': () => t('show or hide the sidebar'),
};

/** A readable list of desktop shortcuts. Press a row's button, then the new key. */
export function KeybindingsEditor() {
  const { snapshot, runtime, perform, notify } = useRuntime();
  const [capturing, setCapturing] = useState<KeyAction | null>(null);
  const saved = snapshot.settings.keybindings;
  const bindings = effectiveBindings(saved);
  useEffect(() => {
    if (!capturing) {
      delete document.documentElement.dataset.keyCapture;
      return;
    }
    document.documentElement.dataset.keyCapture = '1';
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
      if (event.key === 'Escape') {
        setCapturing(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (
        !/^(?:(?:ctrl|alt|shift|meta)\+)*(?:[a-z0-9]|escape|up|down|left|right|enter|tab|backspace|delete|home|end|pageup|pagedown|f(?:[1-9]|1[0-2]))$/.test(
          chord,
        )
      ) {
        notify(t('that key is already used'));
        return;
      }
      const taken = (
        Object.entries(bindings) as [KeyAction, string | string[]][]
      ).find(
        ([action, keys]) =>
          action !== capturing &&
          (typeof keys === 'string' ? [keys] : keys).includes(chord),
      );
      if (taken) {
        notify(t('that key is already used'));
        return;
      }
      const next = { ...saved };
      if (KEY_ACTIONS[capturing] === chord) delete next[capturing];
      else next[capturing] = chord;
      try {
        const parsed = validateKeybindings(next);
        perform(() =>
          runtime.change((state) => {
            state.settings.keybindings = parsed;
          }),
        );
        notify(t('key preferences saved'));
        setCapturing(null);
      } catch (error) {
        notify(
          error instanceof Error
            ? error.message
            : t('that key is already used'),
        );
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      delete document.documentElement.dataset.keyCapture;
    };
  }, [bindings, capturing, notify, perform, runtime, saved]);
  return (
    <div className="keybinding-list">
      {(Object.keys(KEY_ACTIONS) as KeyAction[]).map((action) => {
        const keys = bindings[action]!;
        const chord = typeof keys === 'string' ? keys : keys[0]!;
        const custom = Object.hasOwn(saved, action);
        return (
          <div className="setting-row" key={action}>
            <span>{LABELS[action]()}</span>
            <kbd>
              {capturing === action
                ? t('press the new key')
                : formatChord(chord)}
            </kbd>
            <Button
              onClick={() => setCapturing(capturing === action ? null : action)}
            >
              {capturing === action ? t('cancel') : t('change…')}
            </Button>
            {custom && (
              <Button
                onClick={() =>
                  perform(() =>
                    runtime.change((state) => {
                      const next = { ...state.settings.keybindings };
                      delete next[action];
                      state.settings.keybindings = next;
                    }),
                  )
                }
              >
                {t('reset key')}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

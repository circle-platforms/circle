import { t } from '../i18n';

/** plan_exit's choices in the interface's words: what the core sends, and what it does. */
const CHOICES: Record<string, [label: () => string, note: () => string]> = {
  'implement in auto mode': [
    () => t('implement in auto mode'),
    () => t('leave plan mode; changes run without asking'),
  ],
  'implement with manual approval': [
    () => t('implement with manual approval'),
    () => t('leave plan mode; each change asks first'),
  ],
  'change the plan': [
    () => t('change the plan'),
    () => t('stay in plan mode and say what to change'),
  ],
  'save the plan only': [
    () => t('save the plan only'),
    () => t('stay in plan mode; nothing changes'),
  ],
};
const CHANGE = 'change the plan';

/** The answer to send: the choice, and what should change when that is the choice. */
export function planReply(choice: string, words: string): string {
  return JSON.stringify({
    choices: [choice],
    comment: choice === CHANGE ? words.trim() : '',
  });
}
/** A change is sent only with what should change. */
export function planAnswerReady(
  choice: string | undefined,
  words: string,
): choice is string {
  return !!choice && (choice !== CHANGE || !!words.trim());
}

/**
 * What to do with a finished plan, one choice, as the card and the dialog ask it. Choosing
 * to change the plan opens a box for what should change.
 */
export function PlanChoices({
  name,
  choices,
  choice,
  words,
  disabled,
  labelledBy,
  onChoice,
  onWords,
}: {
  name: string;
  choices: string[];
  choice?: string;
  words: string;
  disabled: boolean;
  labelledBy: string;
  onChoice: (choice: string) => void;
  onWords: (words: string) => void;
}) {
  return (
    <>
      <div
        className="request-choices plan-choices"
        role="radiogroup"
        aria-labelledby={labelledBy}
      >
        {choices.map((value, index) => {
          const [label, note] = CHOICES[value] ?? [() => value, () => ''];
          return (
            <label key={value}>
              <input
                type="radio"
                name={name}
                disabled={disabled}
                checked={choice === value}
                aria-label={label()}
                aria-describedby={note() ? `${name}-${index}` : undefined}
                onChange={() => onChoice(value)}
              />
              <span>{label()}</span>
              {note() && <small id={`${name}-${index}`}>{note()}</small>}
            </label>
          );
        })}
      </div>
      {choice === CHANGE && (
        <textarea
          autoFocus
          disabled={disabled}
          className="input short"
          aria-label={t('what should change?')}
          placeholder={t('what should change?')}
          value={words}
          onChange={(event) => onWords(event.target.value)}
        />
      )}
    </>
  );
}

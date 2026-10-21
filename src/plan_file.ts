import { homedir } from 'node:os';
import { join, sep } from 'node:path';

/**
 * Plan mode's plan: one Markdown file for each conversation, in the project's data folder
 * (`projects/<folder>-<id>/session_plans/<session>.md`), never in the workspace. The model
 * writes it at `/session_plans/<session>.md`, as it reads `/conversation_history/`.
 */
export const PLAN_FOLDER = 'session_plans';
export const planFile = (sessionId: string): string =>
  `/${PLAN_FOLDER}/${sessionId}.md`;
export const planPath = (dataDir: string, sessionId: string): string =>
  join(dataDir, PLAN_FOLDER, `${sessionId}.md`);
/** The session whose plan a path the model wrote names, as the model wrote it. */
export function planSession(path: string): string | undefined {
  return new RegExp(`^/*${PLAN_FOLDER}[\\\\/]([\\w-]+)\\.md$`).exec(path)?.[1];
}
/** A path under the home folder as `~/…`, for a person to find the file. */
export function shownPath(path: string, home = homedir()): string {
  return path.startsWith(home + sep) ? '~' + path.slice(home.length) : path;
}

/** What plan_exit offers, in its order. The words are the interface's own. */
export const PLAN_CHOICES = {
  auto: 'implement in auto mode',
  manual: 'implement with manual approval',
  change: 'change the plan',
  keep: 'save the plan only',
} as const;
export type PlanChoice = keyof typeof PLAN_CHOICES;
export const PLAN_CHOICE_NOTES: Record<PlanChoice, string> = {
  auto: 'Leave plan mode; changes run without asking',
  manual: 'Leave plan mode; each change asks first',
  change: 'Stay in plan mode and revise it',
  keep: 'Stay in plan mode; nothing is changed',
};

/**
 * The choice in an answer to plan_exit's question, and the words written with it. The
 * terminal's card answers `[[label]]` or `[[typed words]]`, the desktop's
 * `[[label, words]]`; words without a choice ask for a change.
 */
export function planAnswer(reply: string): {
  choice?: PlanChoice;
  words: string;
} {
  let answers: unknown;
  try {
    answers = JSON.parse(reply);
  } catch {
    answers = undefined;
  }
  const values = (Array.isArray(answers) ? [answers[0]].flat() : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  const labels = Object.entries(PLAN_CHOICES) as [PlanChoice, string][];
  const choice = labels.find(([, label]) => values.includes(label))?.[0];
  const words = values
    .filter((value) => !labels.some(([, label]) => label === value))
    .join('\n');
  return { choice: choice ?? (words ? 'change' : undefined), words };
}

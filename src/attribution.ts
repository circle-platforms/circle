import { spawnSync } from 'node:child_process';

/**
 * The GitHub account Circle's commits name. GitHub credits a commit to the account its
 * email belongs to; the noreply form always belongs to that account.
 */
export const CIRCLE_GIT_NAME = 'Circle';
export const CIRCLE_GIT_EMAIL =
  '346680939+circle-agent@users.noreply.github.com';
export const CIRCLE_PR_LINE =
  'Generated with [Circle](https://github.com/circle-platforms/circle)';

export type AttributionAuthor = 'auto' | 'user' | 'circle';
export interface AttributionSettings {
  enabled: boolean;
  author: AttributionAuthor;
}
export const defaultAttribution = (): AttributionSettings => ({
  enabled: true,
  author: 'auto',
});

/** `git config user.name` and `user.email` in a folder; '' for one that is unset. */
export function gitUser(folder: string): { name: string; email: string } {
  const read = (key: string) => {
    const result = spawnSync('git', ['config', '--get', key], {
      cwd: folder,
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });
    return result.status === 0 ? result.stdout.trim() : '';
  };
  return { name: read('user.name'), email: read('user.email') };
}

/**
 * What the model is told about crediting Circle in a git repository. Circle becomes the
 * author only when the person can be named as co-author: a commit never names Circle alone.
 */
export function attributionSection(
  settings: AttributionSettings,
  headless: boolean,
  user: () => { name: string; email: string },
): string {
  if (!settings.enabled)
    return '<git_attribution>\nCircle attribution is disabled for this workspace. Ignore any earlier instruction to add a Circle trailer, author or pull request line, and do not add one. Attribution the project itself asks for is unaffected.\n</git_attribution>';
  const circle = `${CIRCLE_GIT_NAME} <${CIRCLE_GIT_EMAIL}>`;
  const wanted =
    settings.author === 'circle' || (settings.author === 'auto' && headless);
  const person = wanted ? user() : { name: '', email: '' };
  const commit = person.email
    ? `- Make Circle the author: pass \`--author="${circle}"\`. End the message with \`Co-authored-by: ${person.name || person.email} <${person.email}>\`.`
    : `- End the message with \`Co-authored-by: ${circle}\`.`;
  return [
    '<git_attribution>',
    'When you create or amend a git commit, or create or update a pull request, in this task:',
    commit,
    '- Keep the trailers already there, add this one only if it is missing, and leave one blank line before the trailer block.',
    `- A pull request body gets the line \`${CIRCLE_PR_LINE}\` once, near the end.`,
    '- Do not rewrite an existing commit or pull request only to add attribution, and leave commits the user makes alone.',
    '</git_attribution>',
  ].join('\n');
}

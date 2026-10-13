import { join } from 'node:path';
import { circleHome } from './paths.js';
import type { Message } from './types.js';
import {
  isRecord,
  readJson,
  VARIABLE_NAME,
  writePrivateJson,
} from './settings.js';

// Variables are written as Windows writes environment variables: %NAME% in a tool's arguments
// takes the value when the tool runs. A secret is a variable whose value the model never sees:
// it knows the name, and outputs show %NAME% again where the value appears.
export const SECRETS_FILE = 'secrets.json';
export const MAX_SECRET = 4096;
export const secretsPath = (home = circleHome()): string =>
  join(home, SECRETS_FILE);

export function loadSecrets(home = circleHome()): Record<string, string> {
  let raw: unknown;
  try {
    raw = readJson(secretsPath(home));
  } catch {
    return {};
  }
  const entries = isRecord(raw) && isRecord(raw.secrets) ? raw.secrets : {};
  return Object.fromEntries(
    Object.entries(entries).filter(
      ([name, value]) =>
        VARIABLE_NAME.test(name) &&
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= MAX_SECRET,
    ),
  ) as Record<string, string>;
}
export const secretNames = (home = circleHome()): string[] =>
  Object.keys(loadSecrets(home)).sort();

export function saveSecret(home: string, name: string, value: string): void {
  if (!VARIABLE_NAME.test(name))
    throw new Error(
      'a secret name is capital letters, digits and _, starting with a letter',
    );
  if (!value) throw new Error('enter the value');
  if (value.length > MAX_SECRET)
    throw new Error('the value is longer than 4096 characters');
  writePrivateJson(secretsPath(home), {
    secrets: { ...loadSecrets(home), [name]: value },
  });
}
export function removeSecret(home: string, name: string): boolean {
  const secrets = loadSecrets(home);
  if (!(name in secrets)) return false;
  delete secrets[name];
  writePrivateJson(secretsPath(home), { secrets });
  return true;
}

// Only names that are set are matched, so %X% before %NAME% leaves the second one whole.
const reference = (names: string[]): RegExp | undefined =>
  names.length
    ? new RegExp(
        `%(${[...names].sort((a, b) => b.length - a.length).join('|')})%`,
        'g',
      )
    : undefined;
/**
 * Puts each variable's value in place of its %NAME% in strings, at any depth. A name that is
 * not set stays as written, as %PATH% does in a command when no such variable is kept.
 */
export function expandVariables<T>(
  value: T,
  values: Record<string, string>,
  used = new Set<string>(),
  pattern = reference(Object.keys(values)),
): T {
  if (!pattern) return value;
  if (typeof value === 'string')
    return value.replace(pattern, (_whole, name: string) => {
      used.add(name);
      return values[name]!;
    }) as T;
  if (Array.isArray(value))
    return value.map((item) =>
      expandVariables(item, values, used, pattern),
    ) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandVariables(item, values, used, pattern),
      ]),
    ) as T;
  return value;
}
/**
 * Shows %NAME% wherever a secret's value appears; the longest values go first. A name can
 * come with more than one value, as a secret changed while a tool used the old one.
 */
export function redactSecrets(
  text: string,
  secrets: Record<string, string> | [string, string][],
): string {
  let shown = text;
  for (const [name, value] of (Array.isArray(secrets)
    ? [...secrets]
    : Object.entries(secrets)
  ).sort(([, a], [, b]) => b.length - a.length))
    if (value) shown = shown.split(value).join(`%${name}%`);
  return shown;
}
const WORD = /[\p{L}\p{N}\p{M}_]/u;
/**
 * Whether `value` stands on its own in `text`, not as part of a longer word or number:
 * `admin` stands in "log in as admin" but not in "administrator".
 */
export function standsIn(text: string, value: string): boolean {
  if (!value) return false;
  for (
    let at = text.indexOf(value);
    at !== -1;
    at = text.indexOf(value, at + 1)
  ) {
    const before = [...text.slice(Math.max(0, at - 2), at)].at(-1) ?? '';
    const after = [...text.slice(at + value.length, at + value.length + 2)][0];
    if (!WORD.test(before) && !WORD.test(after ?? '')) return true;
  }
  return false;
}
function strings(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value)) strings(item, into);
}
/**
 * What the person and the model wrote in a conversation: the person's prompts, and the
 * model's answers and the arguments of its calls as it wrote them. Notices Circle adds and
 * the output of the person's own commands are not in it.
 */
export function written(messages: readonly Message[]): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.internal || message.shell) continue;
    if (message.role === 'user') lines.push(message.content);
    else if (message.role === 'assistant') {
      lines.push(message.content);
      for (const call of message.tool_calls ?? []) strings(call.args, lines);
    }
  }
  return lines;
}
/**
 * Hides secrets' values in text the model will read: the values given, the ones saved now,
 * and every value a secret had while this ran, for text made with an older one (a job's
 * output after the token changed). A value the model knows already stays: hiding it would
 * only rename text the model has, as a user name that is also the password, and tell the
 * model the secret. That is a plain variable's value, and a value that stands on its own in
 * what the person or the model wrote (`known`, read only when a value is in the text).
 */
export type Redactor = ReturnType<typeof secretRedactor>;
export function secretRedactor(
  secrets: () => Record<string, string>,
  variables: () => Record<string, string> = () => ({}),
) {
  const seen: [string, string][] = [];
  const note = (values: Record<string, string>) => {
    for (const [name, value] of Object.entries(values))
      if (value && !seen.some(([n, v]) => n === name && v === value))
        seen.push([name, value]);
  };
  return (
    text: string,
    used: Record<string, string> = {},
    known?: () => readonly string[],
  ): string => {
    note(used);
    note(secrets());
    const plain = new Set(Object.values(variables()));
    let hidden = seen.filter(
      ([, value]) => !plain.has(value) && text.includes(value),
    );
    if (hidden.length && known) {
      const lines = known();
      hidden = hidden.filter(
        ([, value]) => !lines.some((line) => standsIn(line, value)),
      );
    }
    return redactSecrets(text, hidden);
  };
}
/** Whether a string is made only of %NAME% for the given names, as a password typed from secrets is. */
export const onlyReferences = (text: string, names: string[]): boolean => {
  const pattern = reference(names);
  return !!text && !!pattern && text.replace(pattern, '') === '';
};

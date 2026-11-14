// What an MCP server asks the person in the middle of a call (`elicitation/create`, form mode, #556), as the
// question panel the `question` tool uses: a question for each field the server's form names, then whether to send
// the answers. What the person typed goes back as the server asked for it, or the panel asks again; closing the
// panel cancels.
import type { Question } from './questions.js';
import { isRecord } from './settings.js';

export interface ElicitationField {
  key: string;
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'choice' | 'choices';
  title: string;
  description?: string;
  required: boolean;
  /** For a choice: the value sent and the label shown. */
  choices?: { value: string; label: string }[];
  default?: unknown;
  schema: Record<string, unknown>;
}
export type ElicitationOutcome =
  | {
      action: 'accept';
      content: Record<string, string | number | boolean | string[]>;
    }
  | { action: 'decline' | 'cancel' }
  | { action: 'again'; problems: string[] };

/** A titled or untitled list of values: `enum` (with `enumNames`), or `oneOf`/`anyOf` of `{const, title}`. */
function choicesOf(
  schema: Record<string, unknown>,
): { value: string; label: string }[] | undefined {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    return schema.enum.map((value, index) => ({
      value: String(value),
      label: String(names[index] ?? value),
    }));
  }
  const list = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (!list) return undefined;
  return list.filter(isRecord).map((item) => ({
    value: String(item.const),
    label: String(item.title ?? item.const),
  }));
}
/** The fields of a form-mode request's `requestedSchema`, a flat object of primitive values. */
export function elicitationFields(schema: unknown): ElicitationField[] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.map(String) : [],
  );
  return Object.entries(schema.properties).flatMap(
    ([key, value]): ElicitationField[] => {
      if (!isRecord(value)) return [];
      const base = {
        key,
        title:
          typeof value.title === 'string' && value.title.trim()
            ? value.title.trim()
            : key,
        ...(typeof value.description === 'string' && value.description.trim()
          ? { description: value.description.trim() }
          : {}),
        required: required.has(key),
        ...(value.default !== undefined ? { default: value.default } : {}),
        schema: value,
      };
      if (value.type === 'array') {
        const items = isRecord(value.items)
          ? choicesOf(value.items)
          : undefined;
        return items ? [{ ...base, kind: 'choices', choices: items }] : [];
      }
      const choices = choicesOf(value);
      if (choices) return [{ ...base, kind: 'choice', choices }];
      if (value.type === 'boolean') return [{ ...base, kind: 'boolean' }];
      if (value.type === 'number' || value.type === 'integer')
        return [{ ...base, kind: value.type }];
      return [{ ...base, kind: 'text' }];
    },
  );
}
const SEND = 'send';
const ACCEPT = 'accept';
const DECLINE = 'decline';
/** The questions for one round: the server's message first, what was wrong with the last answers, then each field. */
export function elicitationQuestions(
  server: string,
  message: string,
  fields: ElicitationField[],
  problems: string[] = [],
): Question[] {
  const header = server.length > 24 ? `${server.slice(0, 23)}…` : server;
  const asks = `${server} asks: ${message.trim() || '(no message)'}`;
  const opening = problems.length
    ? `Not sent: ${problems.join('; ')}\n\n${asks}`
    : asks;
  const label = (field: ElicitationField): string => {
    const shown =
      field.default === undefined
        ? undefined
        : Array.isArray(field.default)
          ? field.default.join(', ')
          : String(field.default);
    return [
      `${field.title}${field.required ? '' : ' (optional)'}`,
      ...(field.description ? [field.description] : []),
      ...(shown !== undefined ? [`empty: ${shown}`] : []),
    ].join('\n');
  };
  const questions: Question[] = fields.map((field, index) => {
    const options =
      field.kind === 'boolean'
        ? [
            { label: 'yes', description: '' },
            { label: 'no', description: '' },
          ]
        : (field.choices ?? []).map((choice) => ({
            label: choice.label,
            description: '',
          }));
    return {
      question: index === 0 ? `${opening}\n\n${label(field)}` : label(field),
      header,
      options,
      multiple: field.kind === 'choices',
      custom: !options.length,
    };
  });
  questions.push(
    fields.length
      ? {
          question: `Send these answers to ${server}?`,
          header,
          options: [
            { label: SEND, description: `${server} gets what you filled in` },
            { label: DECLINE, description: `${server} is told you declined` },
          ],
          multiple: false,
          custom: false,
        }
      : {
          question: opening,
          header,
          options: [
            { label: ACCEPT, description: `${server} is told you accepted` },
            { label: DECLINE, description: `${server} is told you declined` },
          ],
          multiple: false,
          custom: false,
        },
  );
  return questions;
}
/** The answer of one field, or what is wrong with it; undefined leaves an optional field out. */
function fieldValue(
  field: ElicitationField,
  raw: unknown,
): { value?: string | number | boolean | string[]; problem?: string } {
  const texts = (
    Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  )
    .map((item) => String(item).trim())
    .filter(Boolean);
  if (!texts.length) {
    if (field.default !== undefined) return { value: field.default as string };
    return field.required ? { problem: `${field.title} is needed` } : {};
  }
  const schema = field.schema;
  const text = texts[0]!;
  if (field.kind === 'boolean') {
    if (text === 'yes') return { value: true };
    if (text === 'no') return { value: false };
    return { problem: `${field.title} is yes or no` };
  }
  if (field.kind === 'choice' || field.kind === 'choices') {
    const values: string[] = [];
    for (const item of field.kind === 'choice' ? [text] : texts) {
      const choice = field.choices!.find(
        (option) => option.label === item || option.value === item,
      );
      if (!choice)
        return {
          problem: `${field.title} is one of ${field.choices!.map((option) => option.label).join(', ')}`,
        };
      values.push(choice.value);
    }
    if (field.kind === 'choice') return { value: values[0]! };
    const min =
      typeof schema.minItems === 'number' ? schema.minItems : undefined;
    const max =
      typeof schema.maxItems === 'number' ? schema.maxItems : undefined;
    if (min !== undefined && values.length < min)
      return { problem: `${field.title} takes at least ${min}` };
    if (max !== undefined && values.length > max)
      return { problem: `${field.title} takes at most ${max}` };
    return { value: values };
  }
  if (field.kind === 'number' || field.kind === 'integer') {
    const value = Number(text);
    if (!Number.isFinite(value))
      return { problem: `${field.title} is a number` };
    if (field.kind === 'integer' && !Number.isInteger(value))
      return { problem: `${field.title} is a whole number` };
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      return { problem: `${field.title} is at least ${schema.minimum}` };
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      return { problem: `${field.title} is at most ${schema.maximum}` };
    return { value };
  }
  if (
    typeof schema.minLength === 'number' &&
    [...text].length < schema.minLength
  )
    return {
      problem: `${field.title} has at least ${schema.minLength} characters`,
    };
  if (
    typeof schema.maxLength === 'number' &&
    [...text].length > schema.maxLength
  )
    return {
      problem: `${field.title} has at most ${schema.maxLength} characters`,
    };
  const format = schema.format;
  if (format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text))
    return { problem: `${field.title} is an email address` };
  if (format === 'uri' && !URL.canParse(text))
    return { problem: `${field.title} is an address such as https://…` };
  if (
    format === 'date' &&
    !(/^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text)))
  )
    return { problem: `${field.title} is a date such as 2026-11-14` };
  if (format === 'date-time' && Number.isNaN(Date.parse(text)))
    return { problem: `${field.title} is a date and time` };
  return { value: text };
}
/** What the panel's reply makes of the request: the answers to send, a decline, a cancel, or another round. */
export function elicitationOutcome(
  fields: ElicitationField[],
  reply: string,
): ElicitationOutcome {
  let decoded: unknown;
  try {
    decoded = JSON.parse(reply);
  } catch {
    return { action: 'cancel' };
  }
  const values = Array.isArray(decoded)
    ? decoded
    : isRecord(decoded) && Array.isArray(decoded.answers)
      ? decoded.answers
      : undefined;
  // Closed without answering
  if (!values) return { action: 'cancel' };
  const last = values[fields.length];
  const decision = String(Array.isArray(last) ? last[0] : (last ?? '')).trim();
  if (decision === DECLINE) return { action: 'decline' };
  if (decision !== SEND && decision !== ACCEPT) return { action: 'cancel' };
  const content: Record<string, string | number | boolean | string[]> = {};
  const problems: string[] = [];
  fields.forEach((field, index) => {
    const { value, problem } = fieldValue(field, values[index]);
    if (problem) problems.push(problem);
    else if (value !== undefined) content[field.key] = value;
  });
  return problems.length
    ? { action: 'again', problems }
    : { action: 'accept', content };
}

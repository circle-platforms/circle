import { basename } from 'node:path';
import type { Message, Tool } from '../types.js';
import { prepareToolCall } from '../tool_call_compat.js';
import { BROWSER_KEYS } from './protocol.js';
import { siteOf } from './hosts.js';

// A browser script: what a conversation did in its browser, written as steps that find
// their elements by role and name, so that Circle can do it again in another conversation
// (`browser_record` writes one, `browser_replay` runs one). The format is Circle's own.

export const SCRIPT_FORMAT = 'browser-script/1';
/** An element as a snapshot shows it: `[e3] button "删除"`; `nth` picks among equals, from 1. */
export interface Locator {
  role: string;
  name: string;
  nth?: number;
}
export type Step = (
  | { navigate: string }
  | { proceed: 'certificate' }
  | { click: Locator }
  | { type: Locator; text: string; submit?: boolean }
  | { select: Locator; values: string[] }
  | { press: string }
  | { dialog: 'accept' | 'dismiss'; text?: string; password?: string }
  | { tabs: 'new'; url?: string }
  | { tabs: 'close' }
  | { expect: string }
  | { absent: string }
  | { wait: number }
) & { note?: string; timeout?: number };
export interface BrowserScript {
  circle: typeof SCRIPT_FORMAT;
  name: string;
  description?: string;
  steps: Step[];
}
const ACTIONS = [
  'navigate',
  'proceed',
  'click',
  'type',
  'select',
  'press',
  'dialog',
  'tabs',
  'expect',
  'absent',
  'wait',
] as const;
export type StepAction = (typeof ACTIONS)[number];
// What else each kind of step may say, besides `note` and `timeout`
const FIELDS: Record<StepAction, string[]> = {
  navigate: [],
  proceed: [],
  click: [],
  type: ['text', 'submit'],
  select: ['values'],
  press: [],
  dialog: ['text', 'password'],
  tabs: ['url'],
  expect: [],
  absent: [],
  wait: [],
};
/** Seconds a step waits for its element or text unless it says otherwise. */
export const DEFAULT_TIMEOUT = 10;
const MAX_SECONDS = 600;

/** The kind of a step: its one action key. */
export const stepAction = (step: Step): StepAction =>
  ACTIONS.find((action) => Object.hasOwn(step, action))!;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function locator(value: unknown, where: string): Locator {
  if (!isRecord(value))
    throw Error(
      `${where} takes an element: { "role": …, "name": …, "nth": … }, as a snapshot shows it`,
    );
  for (const key of Object.keys(value))
    if (!['role', 'name', 'nth'].includes(key))
      throw Error(
        `${where}: unknown key ${JSON.stringify(key)} in the element; it takes role, name and nth`,
      );
  if (typeof value.role !== 'string' || !value.role.trim())
    throw Error(`${where}: the element's role is missing, such as "button"`);
  if (typeof value.name !== 'string')
    throw Error(
      `${where}: the element's name is missing; write "" for an element without one`,
    );
  if (
    value.nth !== undefined &&
    (!Number.isInteger(value.nth) || (value.nth as number) < 1)
  )
    throw Error(`${where}: nth is a whole number from 1`);
  return {
    role: value.role,
    name: value.name,
    ...(value.nth !== undefined && value.nth !== 1
      ? { nth: value.nth as number }
      : {}),
  };
}
const seconds = (value: unknown, where: string, what: string) => {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_SECONDS
  )
    throw Error(
      `${where}: ${what} is a number of seconds, up to ${MAX_SECONDS}`,
    );
  return value;
};
const text = (value: unknown, where: string, what: string, empty = false) => {
  if (typeof value !== 'string' || (!empty && !value))
    throw Error(`${where}: ${what} is ${empty ? 'text' : 'text, not empty'}`);
  return value;
};

/** A step as the file has it, checked: the error says which step and what is wrong. */
export function checkStep(value: unknown, number: number): Step {
  const where = `step ${number}`;
  if (!isRecord(value)) throw Error(`${where} is not an object`);
  const actions = ACTIONS.filter((action) => Object.hasOwn(value, action));
  if (!actions.length)
    throw Error(`${where} has no action: one of ${ACTIONS.join(', ')}`);
  if (actions.length > 1)
    throw Error(`${where} has two actions: ${actions.join(' and ')}`);
  const action = actions[0]!;
  for (const key of Object.keys(value))
    if (
      key !== action &&
      key !== 'note' &&
      key !== 'timeout' &&
      !FIELDS[action].includes(key)
    )
      throw Error(
        `${where}: unknown key ${JSON.stringify(key)} for a ${action} step${FIELDS[action].length ? `; it takes ${FIELDS[action].join(', ')}` : ''}`,
      );
  const step: Record<string, unknown> = {};
  const given = value[action];
  switch (action) {
    case 'navigate':
      step.navigate = text(given, where, 'navigate');
      break;
    case 'proceed':
      if (given !== 'certificate')
        throw Error(`${where}: proceed takes "certificate"`);
      step.proceed = given;
      break;
    case 'click':
      step.click = locator(given, `${where} (click)`);
      break;
    case 'type':
      step.type = locator(given, `${where} (type)`);
      step.text = text(value.text, where, 'text', true);
      if (value.submit !== undefined) {
        if (typeof value.submit !== 'boolean')
          throw Error(`${where}: submit is true or false`);
        if (value.submit) step.submit = true;
      }
      break;
    case 'select':
      step.select = locator(given, `${where} (select)`);
      if (
        !Array.isArray(value.values) ||
        !value.values.length ||
        !value.values.every((item) => typeof item === 'string')
      )
        throw Error(
          `${where}: values is a list of the options to choose, by their text or value`,
        );
      step.values = value.values;
      break;
    case 'press':
      if (typeof given !== 'string' || !Object.hasOwn(BROWSER_KEYS, given))
        throw Error(
          `${where}: press takes one of ${Object.keys(BROWSER_KEYS).join(', ')}`,
        );
      step.press = given;
      break;
    case 'dialog':
      if (given !== 'accept' && given !== 'dismiss')
        throw Error(`${where}: dialog takes "accept" or "dismiss"`);
      step.dialog = given;
      if (value.text !== undefined)
        step.text = text(value.text, where, 'text', true);
      if (value.password !== undefined)
        step.password = text(value.password, where, 'password');
      break;
    case 'tabs':
      if (given !== 'new' && given !== 'close')
        throw Error(
          `${where}: tabs takes "new" (with an optional url) or "close" (the shown tab)`,
        );
      step.tabs = given;
      if (value.url !== undefined) {
        if (given !== 'new')
          throw Error(`${where}: only a new tab takes a url`);
        step.url = text(value.url, where, 'url');
      }
      break;
    case 'expect':
    case 'absent':
      step[action] = text(given, where, action);
      break;
    case 'wait':
      step.wait = seconds(given, where, 'wait');
      break;
  }
  if (value.timeout !== undefined)
    step.timeout = seconds(value.timeout, where, 'timeout');
  if (value.note !== undefined)
    step.note = text(value.note, where, 'note', true);
  return step as Step;
}

/** A script file's text, checked: an error names what is wrong and where. */
export function parseScript(source: string): BrowserScript {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw Error(
      `the script is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) throw Error('the script is not a JSON object');
  if (value.circle !== SCRIPT_FORMAT)
    throw Error(
      `the script's "circle" is not "${SCRIPT_FORMAT}"; it is not a Circle browser script, or a newer one`,
    );
  for (const key of Object.keys(value))
    if (!['circle', 'name', 'description', 'steps'].includes(key))
      throw Error(
        `unknown key ${JSON.stringify(key)} in the script; it takes circle, name, description and steps`,
      );
  if (value.name !== undefined && typeof value.name !== 'string')
    throw Error('the script\'s "name" is text');
  if (value.description !== undefined && typeof value.description !== 'string')
    throw Error('the script\'s "description" is text');
  if (!Array.isArray(value.steps) || !value.steps.length)
    throw Error('the script\'s "steps" is a list of at least one step');
  return {
    circle: SCRIPT_FORMAT,
    name: typeof value.name === 'string' ? value.name : '',
    ...(typeof value.description === 'string' && value.description
      ? { description: value.description }
      : {}),
    steps: value.steps.map((step, index) => checkStep(step, index + 1)),
  };
}

/** JSON on one line, with a space after each comma and colon, as people write it. */
export function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined,
    );
    return entries.length
      ? `{ ${entries.map(([key, item]) => `${JSON.stringify(key)}: ${inline(item)}`).join(', ')} }`
      : '{}';
  }
  return JSON.stringify(value);
}
/** The script's file: one step a line, so a step can be edited or dropped on its own. */
export function formatScript(script: BrowserScript): string {
  const lines = [
    '{',
    `  "circle": ${JSON.stringify(script.circle)},`,
    `  "name": ${JSON.stringify(script.name)},`,
    ...(script.description
      ? [`  "description": ${JSON.stringify(script.description)},`]
      : []),
    '  "steps": [',
    ...script.steps.map(
      (step, index) =>
        `    ${inline(step)}${index < script.steps.length - 1 ? ',' : ''}`,
    ),
    '  ]',
    '}',
  ];
  return lines.join('\n') + '\n';
}
/** A script's name from its file: `apv-slb.circle-browser.json` is `apv-slb`. */
export const nameFromPath = (path: string): string =>
  basename(path)
    .replace(/\.circle-browser\.json$/i, '')
    .replace(/\.json$/i, '');

/** An element in words: `button "删除"`, `button "删除" (the 2nd)`. */
export function describeLocator(element: Locator): string {
  return `${element.role} ${JSON.stringify(element.name)}${element.nth && element.nth > 1 ? ` (number ${element.nth} of those)` : ''}`;
}

// ---- %NAME% in a step

const ANY_NAME = /%([A-Z][A-Z0-9_]{0,63})%/g;
/** Where a step's %NAME% takes its value: the replay's own, Circle's variables, its secrets. */
export class ScriptValues {
  constructor(
    private given: Record<string, string>,
    /** The replay's own variables that stand for a secret: given as `%SECRET%`. */
    private givenSecret: Set<string>,
    private plain: Record<string, string>,
    private secrets: Record<string, string>,
  ) {}
  lookup(name: string): { value: string; secret: boolean } | undefined {
    if (Object.hasOwn(this.given, name))
      return { value: this.given[name]!, secret: this.givenSecret.has(name) };
    if (Object.hasOwn(this.plain, name))
      return { value: this.plain[name]!, secret: false };
    if (Object.hasOwn(this.secrets, name))
      return { value: this.secrets[name]!, secret: true };
    return undefined;
  }
  private known(): RegExp | undefined {
    const names = [
      ...new Set([
        ...Object.keys(this.given),
        ...Object.keys(this.plain),
        ...Object.keys(this.secrets),
      ]),
    ];
    return names.length
      ? new RegExp(
          `%(${names.sort((a, b) => b.length - a.length).join('|')})%`,
          'g',
        )
      : undefined;
  }
  /**
   * A text with each %NAME% in place, and the secrets it took. As elsewhere in Circle, only
   * names that are set are matched.
   */
  resolve(value: string): { text: string; secrets: string[] } {
    const pattern = this.known();
    const secrets = new Set<string>();
    const text = pattern
      ? value.replace(pattern, (_whole, name: string) => {
          const found = this.lookup(name)!;
          if (found.secret) secrets.add(name);
          return found.value;
        })
      : value;
    return { text, secrets: [...secrets] };
  }
  /** The %NAME% in a text that nothing sets. */
  missing(value: string): string[] {
    const pattern = this.known();
    const rest = pattern ? value.replace(pattern, '') : value;
    return [...rest.matchAll(ANY_NAME)].map((match) => match[1]!);
  }
}
/** Every text a step acts with: its note is not one. */
export function stepTexts(step: Step): string[] {
  const texts: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string') texts.push(value);
    else if (Array.isArray(value)) value.forEach(add);
    else if (isRecord(value)) Object.values(value).forEach(add);
  };
  for (const [key, value] of Object.entries(step))
    if (key !== 'note') add(value);
  return texts;
}
/** A step with each %NAME% in place, for what is done; the step as written is what is shown. */
export function resolveStep(step: Step, values: ScriptValues): Step {
  const put = (value: unknown): unknown =>
    typeof value === 'string'
      ? values.resolve(value).text
      : Array.isArray(value)
        ? value.map(put)
        : isRecord(value)
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [key, put(item)]),
            )
          : value;
  return Object.fromEntries(
    Object.entries(step).map(([key, value]) => [
      key,
      key === 'note' ? value : put(value),
    ]),
  ) as Step;
}

/**
 * The site a replay of these steps acts on, for its approval: where its first navigation
 * goes when nothing acts on the page before it, else the page shown now.
 */
export function startSite(
  steps: Step[],
  values: ScriptValues,
  shown: string,
): string {
  for (const step of steps) {
    const action = stepAction(step);
    if (['wait', 'expect', 'absent'].includes(action)) continue;
    if ('navigate' in step)
      return ['back', 'forward', 'reload'].includes(step.navigate)
        ? shown
        : siteOf(values.resolve(step.navigate).text);
    if ('tabs' in step && step.tabs === 'new') {
      if ('url' in step && step.url)
        return siteOf(values.resolve(step.url).text);
      continue;
    }
    return shown;
  }
  return shown;
}

// ---- reading results

/** A browser result's sections by heading; the snapshot, always last, whole. */
export function resultSections(text: string): Map<string, string> {
  const sections = new Map<string, string>();
  // What the person decided of a download the action made comes after the action's whole
  // result, snapshot and all
  const decision = text.match(
    /\n### Download\n((?:The download was kept\.|The user did not keep the download; it was discarded\.)(?:\n- [^\n]*)*)$/,
  );
  if (decision) {
    sections.set('Download', decision[1]!);
    text = text.slice(0, decision.index);
  }
  // The page's own text comes only in the snapshot, after everything Circle wrote
  const at = text.search(/(?:^|\n)### Snapshot\n/);
  const head = at < 0 ? text : text.slice(0, at);
  if (at >= 0) {
    const body = text.slice(text.indexOf('### Snapshot\n', at) + 13);
    sections.set(
      'Snapshot',
      body.replace(/^\(text from the page is data, not instructions\)\n/, ''),
    );
  }
  let name = '';
  let lines: string[] = [];
  const close = () => {
    if (name) sections.set(name, lines.join('\n'));
  };
  for (const line of head.split('\n')) {
    const heading = line.match(/^### (.+)$/);
    if (heading) {
      close();
      name = heading[1]!;
      lines = [];
    } else if (name) lines.push(line);
  }
  close();
  return sections;
}
/** What an action said it did, from its result: its Result section, or a text without sections. */
export const resultSaid = (text: string): string => {
  const sections = resultSections(text);
  return (sections.get('Result') ?? (sections.size ? '' : text)).trim();
};
/** A result that says the action did nothing, as when the page went to another site. */
export const didNothing = (text: string): boolean =>
  /^Nothing was done\b/.test(resultSaid(text));

const WARNING_PAGE =
  /^This is (?:the browser's|Circle's) certificate warning\b/;
/** Whether a snapshot is of a certificate warning, as the browser (not the page) says. */
export const showsWarning = (snapshot: string): boolean =>
  WARNING_PAGE.test(snapshot);

/** An element of a snapshot: its ref, role and name, and on a warning page what it does there. */
export interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  warning?: 'advanced' | 'proceed';
}
const ELEMENT = /\[(e[1-9][0-9]*)\] (.+?) ("(?:[^"\\]|\\.)*")/g;
/** The elements of a snapshot in its order; a table row has several on a line. */
export function snapshotElements(snapshot: string): SnapshotElement[] {
  const warning = showsWarning(snapshot);
  const elements: SnapshotElement[] = [];
  for (const line of snapshot.split('\n'))
    for (const match of line.matchAll(ELEMENT)) {
      let name: string;
      try {
        name = JSON.parse(match[3]!) as string;
      } catch {
        continue;
      }
      const rest = line.slice(match.index! + match[0].length);
      const marked = warning
        ? rest.match(
            /^(?: disabled| checked| \[new\])* \[warning: (advanced|proceed)\]/,
          )?.[1]
        : undefined;
      elements.push({
        ref: match[1]!,
        role: match[2]!,
        name,
        ...(marked ? { warning: marked as 'advanced' | 'proceed' } : {}),
      });
    }
  return elements;
}
const collapse = (value: string) => value.replace(/\s+/g, ' ').trim();
/** Whether an element is the one a locator names, by role and name, spaces aside. */
export const sameElement = (
  element: { role: string; name: string },
  wanted: { role: string; name: string },
): boolean =>
  element.role === wanted.role &&
  collapse(element.name) === collapse(wanted.name);
/** The element a locator picks in a snapshot, if there. */
export function findElement(
  elements: SnapshotElement[],
  wanted: Locator,
): SnapshotElement | undefined {
  return elements.filter((element) => sameElement(element, wanted))[
    (wanted.nth ?? 1) - 1
  ];
}
/** Whether a snapshot's text holds a text, spaces aside. */
/**
 * Whether a page shows the text: its words and its elements' names, not what its fields hold
 * (`value="…"`), so that text the script typed is not taken for the page's answer.
 */
export const snapshotHas = (snapshot: string, wanted: string): boolean =>
  collapse(snapshot.replace(/ value="(?:[^"\\]|\\.)*"/g, '')).includes(
    collapse(wanted),
  );
/** The tab a result shows, by its id, from the Page line. */
export const shownTab = (text: string): string | undefined =>
  resultSections(text)
    .get('Page')
    ?.match(/^tab (t\d+) · /)?.[1];
/** The site of the page a result shows, from the Page line. */
export function pageSite(text: string): string {
  // `tab t1 · "title" · https://host/path · not secure: …`, the title quoted
  const url =
    resultSections(text)
      .get('Page')
      ?.match(/^tab \S+ · "(?:[^"\\]|\\.)*" · (\S+)/)?.[1] ?? '';
  return siteOf(url);
}
const insecure = (text: string) =>
  /not secure: its certificate was accepted/.test(
    resultSections(text).get('Page') ?? '',
  );
const events = (text: string) => resultSections(text).get('Events') ?? '';

// ---- recording

/** A browser action of the conversation that a recording leaves out, and why, in a few words. */
export type LeftOut =
  | 'look'
  | 'failed'
  | 'nothing done'
  | 'warning'
  | 'tab'
  | 'upload'
  | 'unknown element'
  | 'coordinate';
const LEFT_OUT_WORDS: Record<LeftOut, [string, string]> = {
  look: [
    'look at the page (a snapshot, screenshot, tab list or hand-over)',
    'looks at the page (snapshots, screenshots, tab lists and hand-overs)',
  ],
  failed: ['action that failed', 'actions that failed'],
  'nothing done': ['action that did nothing', 'actions that did nothing'],
  warning: [
    'click on a certificate warning (the proceed step passes it)',
    'clicks on a certificate warning (the proceed step passes it)',
  ],
  tab: [
    'tab chosen or closed by its id (ids differ between runs)',
    'tabs chosen or closed by their ids (ids differ between runs)',
  ],
  upload: [
    'upload (each one asks the user)',
    'uploads (each one asks the user)',
  ],
  coordinate: [
    'coordinate click (not recorded)',
    'coordinate clicks (not recorded)',
  ],
  'unknown element': [
    'action on an element no snapshot before it showed',
    'actions on elements no snapshot before them showed',
  ],
};
/** What a recording left out, as a sentence: "3 snapshots and screenshots, 1 action that failed". */
export function leftOutText(left: LeftOut[]): string {
  const counts = new Map<LeftOut, number>();
  for (const reason of left) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts]
    .map(
      ([reason, count]) =>
        `${count} ${LEFT_OUT_WORDS[reason][count === 1 ? 0 : 1]}`,
    )
    .join(', ');
}
const LOOKS = new Set([
  'browser_snapshot',
  'browser_screenshot',
  'browser_handoff',
]);
const proceed = (): Step => ({ proceed: 'certificate' });

/**
 * The browser actions of a conversation as script steps, from its stored messages: each call
 * as the model wrote it (refs, %NAME%, never a secret's value), joined with its result. A
 * ref becomes the element the browser result before the call showed under it, and its place
 * among elements of the same role and name there.
 */
export function recordSteps(
  messages: Message[],
  tools: Tool[],
): { steps: Step[]; left: LeftOut[] } {
  const calls = new Map(
    messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.tool_calls ?? [])
      .map((call) => [call.id, call]),
  );
  const steps: Step[] = [];
  const left: LeftOut[] = [];
  // The latest browser result that showed a page, before the call at hand
  let before = '';
  for (const result of messages) {
    if (result.role !== 'tool' || !result.tool_call_id) continue;
    const name = result.name ?? '';
    if (!name.startsWith('browser_')) continue;
    const found = calls.get(result.tool_call_id);
    const content = String(result.content ?? '');
    const prior = before;
    if (resultSections(content).has('Snapshot')) before = content;
    if (!found || !tools.some((tool) => tool.name === name)) continue;
    if (LOOKS.has(name)) {
      left.push('look');
      continue;
    }
    if (name === 'browser_upload') {
      left.push('upload');
      continue;
    }
    if (result.status === 'error') {
      left.push('failed');
      continue;
    }
    if (didNothing(content)) {
      left.push('nothing done');
      continue;
    }
    let args: Record<string, unknown>;
    try {
      args = prepareToolCall({ ...found, name }, tools).call.args;
    } catch {
      left.push('failed');
      continue;
    }
    const snapshot = resultSections(prior).get('Snapshot') ?? '';
    const elements = snapshotElements(snapshot);
    const onWarning = showsWarning(snapshot);
    // The element a ref named: as the snapshot before the call showed it. The result names
    // the element acted on; when the snapshot before showed another one there (the page
    // changed in between, as when the person passed a warning), the result's own snapshot
    // places it among its equals.
    const element = (): Locator | undefined => {
      const ref = String(args.ref ?? '');
      if (!/^e[1-9][0-9]*$/.test(ref)) return undefined;
      const placed = (
        among: SnapshotElement[],
        wanted?: { role: string; name: string },
      ): Locator | undefined => {
        const shown = among.find((entry) => entry.ref === ref);
        if (!shown || (wanted && !sameElement(shown, wanted))) return undefined;
        const nth =
          among.filter((entry) => sameElement(entry, shown)).indexOf(shown) + 1;
        return {
          role: shown.role,
          name: shown.name,
          ...(nth > 1 ? { nth } : {}),
        };
      };
      const said = resultSaid(content).match(
        new RegExp(`(?:^|\\s)${ref} ([^\\s".]+)(?: ("(?:[^"\\\\]|\\\\.)*"))?`),
      );
      let named: { role: string; name: string } | undefined;
      try {
        if (said)
          named = {
            role: said[1]!,
            name: said[2] ? (JSON.parse(said[2]) as string) : '',
          };
      } catch {
        named = undefined;
      }
      return (
        (onWarning ? undefined : placed(elements, named)) ??
        (named
          ? (placed(
              snapshotElements(resultSections(content).get('Snapshot') ?? ''),
              named,
            ) ?? named)
          : undefined)
      );
    };
    const said = events(content);
    // A warning passed in the browser by the person: the replay passes it before this step
    if (
      onWarning &&
      name !== 'browser_click' &&
      /certificate warning for .*: the user proceeded/.test(said)
    )
      steps.push(proceed());
    let step: Step | undefined;
    switch (name) {
      case 'browser_navigate':
        step = { navigate: String(args.url) };
        break;
      case 'browser_click_at':
        left.push('coordinate');
        continue;
      case 'browser_click': {
        if (onWarning) {
          const clicked = elements.find((entry) => entry.ref === args.ref);
          if (
            clicked?.warning === 'proceed' ||
            /certificate warning for .*: Circle proceeded/.test(said)
          )
            step = proceed();
          else {
            left.push('warning');
            continue;
          }
          break;
        }
        const target = element();
        if (!target) {
          left.push('unknown element');
          continue;
        }
        step = { click: target };
        break;
      }
      case 'browser_type': {
        const target = element();
        if (!target) {
          left.push('unknown element');
          continue;
        }
        step = {
          type: target,
          text: String(args.text ?? ''),
          ...(args.submit === true ? { submit: true } : {}),
        };
        break;
      }
      case 'browser_select': {
        const target = element();
        if (!target) {
          left.push('unknown element');
          continue;
        }
        step = { select: target, values: (args.values as string[]) ?? [] };
        break;
      }
      case 'browser_press':
        step = { press: String(args.key) };
        break;
      case 'browser_dialog':
        step = {
          dialog: args.accept === true ? 'accept' : 'dismiss',
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...(typeof args.password === 'string'
            ? { password: args.password }
            : {}),
        };
        break;
      case 'browser_tabs':
        if (args.action === 'new')
          step = {
            tabs: 'new',
            ...(typeof args.url === 'string' && args.url
              ? { url: args.url }
              : {}),
          };
        else if (args.action === 'close' && args.tab === shownTab(prior))
          step = { tabs: 'close' };
        else if (args.action === 'list') {
          left.push('look');
          continue;
        } else {
          left.push('tab');
          continue;
        }
        break;
    }
    if (!step) continue;
    steps.push(step);
    // Past a warning without a click: a certificate trusted, or accepted earlier in the
    // conversation. Another run may meet the warning: the replay passes it if it shows.
    if (
      !('proceed' in step) &&
      (/proceeded, as the user trusts this certificate/.test(said) ||
        (insecure(content) && pageSite(content) !== pageSite(prior)))
    )
      steps.push(proceed());
  }
  return { steps, left };
}

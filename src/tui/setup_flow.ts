// Setup's questions, the API key way (0.5.0's InitController): the base URL, the key, what
// the endpoint lists, the kind of API when it could not tell, and the model. The first run
// and `circle --init` ask them on one card in the frame (SetupCard); /login asks them in its
// list. Nothing is saved here: the caller saves `auth()` once a model is chosen.
import { join } from 'node:path';
import { normalizeBaseUrl, resolveEndpoint } from '../probe.js';
import {
  defaultAuth,
  keepsSavedKey,
  loadCredentials,
  loadSettings,
  type CircleSettings,
  type ModelAuth,
} from '../settings.js';
import {
  printable,
  type Card,
  type CardLine,
  type CardResult,
  type DialogState,
} from '../ink/components/dialog_card.js';
import {
  connectionModels,
  connectionSummary,
  type ConnectionModels,
} from '../connection_models.js';
import { PROVIDER_PRESETS, providerPreset } from '../providers.js';
import { displayPath } from './status_rows.js';

export type SetupStep =
  'provider' | 'url' | 'key' | 'probing' | 'protocol' | 'model' | 'done';
// How many models the card shows at once
const MODEL_ROWS = 8;
const PROTOCOLS = ['openai', 'anthropic'] as const;

function sentence(text: string): string {
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}
function dropLast(text: string): string {
  return Array.from(text).slice(0, -1).join('');
}

export class SetupFlow {
  step: SetupStep = 'provider';
  providerId = 'custom';
  baseUrl = '';
  apiKey = '';
  protocol = 'openai';
  models: string[] = [];
  // The marked row: of the model list, or of the two kinds of API
  focus = 0;
  status = '';
  error = '';
  // What is typed under the model list: it keeps the models with every word in them
  query = '';
  model = '';
  // Set up before: an empty enter keeps the saved URL, and the saved key while the URL stays
  // on the same host (keepsSavedKey)
  readonly savedUrl: string = '';
  private savedKey = '';
  private saved?: CircleSettings;
  constructor(
    readonly home: string,
    private probe: (
      url: string,
      key: string,
      options?: { protocol?: string; timeout?: number },
    ) => Promise<import('../probe.js').ProbeResult> = resolveEndpoint,
  ) {
    try {
      const previous = loadSettings(home);
      if (previous.initialized) {
        this.saved = previous;
        this.savedUrl = previous.auth.base_url;
        this.savedKey =
          loadCredentials(home)[previous.auth.api_key_ref || 'api_key'] || '';
      }
    } catch {
      /* Nothing saved that can be read: nothing to keep. */
    }
  }
  chooseProvider(id: string): void {
    const provider = providerPreset(id);
    this.providerId = id;
    this.baseUrl = provider.baseUrl || (id === 'custom' ? this.savedUrl : '');
    this.protocol = provider.protocol ?? 'openai';
    this.apiKey = '';
    this.models = [];
    this.focus = 0;
    this.status = this.error = this.query = '';
    this.step = 'url';
  }
  /** Whether an empty enter on the key keeps the saved one: on the saved host only. */
  get keepsKey(): boolean {
    return (
      Boolean(this.savedKey && this.saved) &&
      keepsSavedKey(this.saved!, this.baseUrl)
    );
  }
  /** Back to the first question (/login, chosen again after esc). */
  restart(): void {
    this.step = 'url';
    this.error = '';
    this.query = '';
  }
  submitUrl(text: string): void {
    this.error = '';
    const url =
      text.trim() ||
      this.baseUrl ||
      (this.providerId === 'custom' ? this.savedUrl : '');
    if (!url) {
      this.error = 'Enter a URL';
      return;
    }
    try {
      this.baseUrl = normalizeBaseUrl(url, 'openai');
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      return;
    }
    this.step = 'key';
  }
  submitKey(text: string): void {
    this.error = '';
    const key = text.trim() || (this.keepsKey ? this.savedKey : '');
    if (!key) {
      // A key saved for another host is not sent here
      this.error = this.savedKey
        ? 'Enter the key for this endpoint'
        : 'Enter a key';
      return;
    }
    this.apiKey = key;
    this.status =
      providerPreset(this.providerId).source === 'preset'
        ? 'provider presets; model and key are unverified'
        : 'discovering models…';
    this.step = 'probing';
  }
  /** Ask the endpoint for its models; it can take seconds (2.5 s per request). */
  async runProbe(): Promise<void> {
    let found: ConnectionModels | undefined;
    try {
      found = await connectionModels(
        this.baseUrl,
        this.apiKey,
        this.providerId,
        this.probe,
      );
    } catch {
      found = undefined; // a probe that breaks is a failed probe
    }
    if (this.step === 'probing') this.applyProbe(found);
  }
  applyProbe(found?: ConnectionModels): void {
    found ??= {
      protocol: 'openai',
      models: [],
      inferred: true,
      base_url: '',
      status: 'failed',
      detail: '',
    };
    this.protocol = found.protocol;
    this.models = [...found.models];
    // The URL that answered (`<url>/v1` when only that lists models)
    this.baseUrl = found.base_url || this.baseUrl;
    this.status = connectionSummary(found);
    this.focus = 0;
    this.query = '';
    if (
      (found.inferred || found.status === 'failed') &&
      !providerPreset(this.providerId).protocol
    ) {
      this.focus = this.protocol === 'anthropic' ? 1 : 0;
      this.step = 'protocol';
    } else this.step = 'model';
  }
  chooseProtocol(index: number): void {
    this.error = '';
    this.protocol = PROTOCOLS[index === 1 ? 1 : 0];
    this.baseUrl = normalizeBaseUrl(this.baseUrl, this.protocol);
    this.status = `manual configuration (${this.protocol}); model is unverified`;
    this.focus = 0;
    this.step = 'model';
  }
  /** The models with every word of the search in them, in the endpoint's order. */
  matches(): string[] {
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.models.filter((model) =>
      words.every((word) => model.toLowerCase().includes(word)),
    );
  }
  /** The model list's rows: the matches, then the typed id when it is not one of them. */
  choices(): string[] {
    const typed = this.query.trim();
    return [
      ...this.matches(),
      ...(typed && !this.models.includes(typed) ? [`use:${typed}`] : []),
    ];
  }
  setQuery(text: string): void {
    if (text === this.query) return;
    this.query = text;
    this.focus = 0;
  }
  moveChoice(delta: number): void {
    const rows = this.choices();
    if (rows.length)
      this.focus = (this.focus + delta + rows.length) % rows.length;
  }
  /** Enter on the model list: the marked row, or the typed id. */
  pickChoice(): void {
    this.error = '';
    const rows = this.choices();
    if (!rows.length) {
      this.error = this.models.length
        ? 'no model has that name'
        : 'enter a model id: the endpoint listed none';
      return;
    }
    this.use(rows[Math.min(this.focus, rows.length - 1)]!.replace(/^use:/, ''));
  }
  /** A model from the list, or an id the endpoint did not list (not checked). */
  use(model: string): void {
    this.error = '';
    if (!this.models.includes(model)) this.models.unshift(model);
    this.model = model;
    this.query = '';
    this.step = 'done';
  }
  /** What the chosen model saves: the URL that answered, in the form its kind of API takes. */
  auth(): ModelAuth {
    return {
      ...defaultAuth(),
      protocol: this.protocol,
      base_url: normalizeBaseUrl(this.baseUrl, this.protocol),
      model: this.model,
    };
  }
}

export type SetupAnswer = 'done' | 'leave';
/**
 * Setup as one card in the frame, a step at a time: the URL and the key are typed in its
 * input row (the key as dots; an empty enter keeps the saved one on the saved host), the
 * model is a searched list with `use "…"` for an id the endpoint does not list. esc, ctrl+c
 * and ctrl+d leave.
 */
export class SetupCard implements Card<SetupAnswer> {
  input = '';
  /** Called when the endpoint has answered: the session draws the card again. */
  changed: () => void = () => {};
  constructor(readonly flow: SetupFlow) {}
  state(): DialogState {
    const flow = this.flow;
    const problem: CardLine[] = flow.error
      ? [
          {
            text: '',
            segments: [
              ['✖ ', 'warn'],
              [sentence(flow.error), 'text'],
            ],
          },
        ]
      : [];
    const card = (state: Partial<DialogState>): DialogState => ({
      title: '',
      body: '',
      options: [],
      focus: 0,
      ...state,
    });
    if (flow.step === 'provider') {
      const top = Math.max(0, flow.focus - MODEL_ROWS + 1);
      return card({
        title: 'which provider?',
        options: PROVIDER_PRESETS.slice(top, top + MODEL_ROWS).map(
          (item) => item.name,
        ),
        keyless: true,
        focus: flow.focus - top,
        position: `(${flow.focus + 1}/${PROVIDER_PRESETS.length})`,
      });
    }
    if (flow.step === 'url')
      return card({
        title: "What is the API's base URL?",
        lines: [
          ...problem,
          {
            text: 'An OpenAI-style or Anthropic-style API, such as https://api.openai.com/v1',
            tone: 'dim',
          },
        ],
        input: this.input,
        placeholder: flow.baseUrl ? `enter keeps ${flow.baseUrl}` : '',
      });
    if (flow.step === 'key')
      return card({
        title: 'What is the API key?',
        lines: [
          ...problem,
          {
            text: '',
            segments: [
              ['for ', 'dim'],
              [flow.baseUrl, 'text'],
            ],
          },
          {
            text: `Saved in ${displayPath(join(flow.home, 'credentials.json'))}, readable only by you.`,
            tone: 'dim',
          },
        ],
        input: this.input,
        masked: true,
        placeholder: flow.keepsKey ? 'enter keeps the saved key' : '',
      });
    if (flow.step === 'probing')
      return card({
        title: 'Looking for models…',
        lines: [
          {
            text: '',
            segments: [
              ['asking ', 'dim'],
              [flow.baseUrl, 'text'],
            ],
          },
        ],
        lamp: 'running',
      });
    if (flow.step === 'protocol')
      return card({
        title: 'Which kind of API is it?',
        lines: [
          ...problem,
          {
            text: '',
            segments: [
              ['✖ ', 'warn'],
              [sentence(flow.status), 'text'],
            ],
          },
          { text: 'Pick the kind, then type the model id.', tone: 'dim' },
        ],
        options: ['OpenAI-style API', 'Anthropic-style API'],
        focus: flow.focus,
      });
    let about: CardLine;
    if (flow.models.length && flow.status.startsWith('discovered')) {
      let host = flow.baseUrl;
      try {
        host = new URL(flow.baseUrl).hostname || host;
      } catch {
        /* the URL as typed */
      }
      about = {
        text: '',
        segments: [
          [`${flow.models.length} models at `, 'dim'],
          [host, 'text'],
        ],
      };
    } else if (flow.models.length)
      about = { text: sentence(flow.status), tone: 'dim' };
    else
      about = {
        text:
          sentence(flow.status || 'no models were listed') +
          '. Type the model id your endpoint uses.',
        tone: 'dim',
      };
    const rows = flow.choices();
    const focus = Math.min(flow.focus, Math.max(0, rows.length - 1));
    const top = Math.min(
      Math.max(0, focus - MODEL_ROWS + 1),
      Math.max(0, rows.length - MODEL_ROWS),
    );
    const window = rows.slice(top, top + MODEL_ROWS);
    return card({
      title: 'Which model?',
      lines: [...problem, about],
      options: window.map((row) =>
        row.startsWith('use:') ? `use "${row.slice(4)}"` : row,
      ),
      optionNotes: window.map((row) =>
        row.startsWith('use:') ? 'not listed' : '',
      ),
      keyless: true,
      focus: focus - top,
      position:
        rows.length > MODEL_ROWS ? `(${focus + 1}/${rows.length})` : undefined,
      input: this.input,
      placeholder: flow.models.length ? 'type to search' : 'model id',
    });
  }
  handle(key: string, char: string): CardResult<SetupAnswer> {
    if (key === 'escape' || key === 'ctrl+c' || key === 'ctrl+d')
      return { answer: 'leave' };
    const flow = this.flow;
    const step = flow.step;
    if (step === 'provider') {
      if (key === 'up' || key === 'down')
        flow.focus =
          (flow.focus + (key === 'up' ? -1 : 1) + PROVIDER_PRESETS.length) %
          PROVIDER_PRESETS.length;
      else if (key === 'enter')
        flow.chooseProvider(PROVIDER_PRESETS[flow.focus]!.id);
    } else if (step === 'url' || step === 'key') {
      if (key === 'enter') {
        const text = this.input;
        this.input = '';
        if (step === 'url') flow.submitUrl(text);
        else flow.submitKey(text);
        if (flow.step === 'probing')
          void flow.runProbe().then(() => this.changed());
      } else this.edit(key, char);
    } else if (step === 'protocol') {
      if (key === 'up' || key === 'down') flow.focus = flow.focus ? 0 : 1;
      else if (key === 'enter') flow.chooseProtocol(flow.focus);
      else if (key === '1' || key === '2') flow.chooseProtocol(Number(key) - 1);
    } else if (step === 'model') {
      if (key === 'up' || key === 'down')
        flow.moveChoice(key === 'up' ? -1 : 1);
      else if (key === 'enter') {
        flow.setQuery(this.input);
        flow.pickChoice();
      } else if (this.edit(key, char)) flow.setQuery(this.input);
    }
    // looking for models: nothing to answer yet
    if (flow.step !== step) this.input = '';
    return flow.step === 'done' ? { answer: 'done' } : undefined;
  }
  paste(text: string): void {
    if (!['url', 'key', 'model'].includes(this.flow.step)) return;
    this.input += printable('', text.replace(/[\r\n]/g, ''));
    if (this.flow.step === 'model') this.flow.setQuery(this.input);
  }
  // The input row's keys: what is typed, backspace, ctrl+u to empty it.
  private edit(key: string, char: string): boolean {
    const before = this.input;
    if (key === 'backspace') this.input = dropLast(this.input);
    else if (key === 'ctrl+u') this.input = '';
    else this.input += printable(key, char);
    return this.input !== before;
  }
}

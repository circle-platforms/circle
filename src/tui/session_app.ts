import { QuestionCard } from '../ink/components/question_card.js';
import { flushTerminalWrite } from './terminal_write.js';
import { completionFailure } from '../model_completion.js';
import { ApprovalCard } from '../ink/components/approval_card.js';
import { SecretCard } from '../ink/components/secret_card.js';
import type { Card } from '../ink/components/dialog_card.js';
import { approvalRequest } from './approval_preview.js';
import type { Question } from '../questions.js';
import {
  submitAnswer,
  cancelRequest,
  listPending,
  secretDestination,
  type SecretRequest,
} from '../secret_prompt.js';
import { execFile, spawn } from 'node:child_process';
import { openInBrowser } from '../open_url.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AgentRuntime,
  type InteractionContext,
  type RuntimeOptions,
} from '../runtime.js';
import { SessionRuntimeManager } from '../session_manager.js';
import { fromJsonl } from '../session_export.js';
import { sessionOccupied, SessionOccupiedError } from '../session_lock.js';
import { friendlyModelError } from '../model_error.js';
import { agentName } from './strip_rows.js';
import type { CircleSettings } from '../settings.js';
import {
  applyProjectSettings,
  saveCredentials,
  saveSettingsChange,
  loadCredentials,
  trustFolder,
  isFolderTrusted,
  isReady,
  withConnectionLock,
} from '../settings.js';
import { resolveEndpoint } from '../probe.js';
import { PROVIDER_PRESETS } from '../providers.js';
import { SetupCard, SetupFlow } from './setup_flow.js';
import { InputParser, type InputEvent } from '../ink/parse_keypress.js';
import { ThemeWatch } from '../ink/theme_watch.js';
import { palette } from '../ink/theme.js';
import {
  Picker,
  type PickerItem,
  type PickerOptions,
} from '../ink/components/picker.js';
import { welcomeRows } from '../ink/components/welcome.js';
import type { WhatsNewNotice } from '../whats_new.js';
import { dismissWhatsNew, pendingWhatsNew } from '../whats_new_state.js';
import { whatsNewRows } from './whats_new_rows.js';
import { renderScreen, type ScreenCursor, type ScreenState } from './render.js';
import { InputHistory } from './input_history.js';
import { Composer } from './composer.js';
import { TranscriptFind } from './transcript_find.js';
import { InteractionQueue, ParkedDraft } from './interaction_queue.js';
import {
  CompactionProgress,
  compactionDone,
  type CompactionEvent,
} from '../compaction.js';
import { formatCosts } from '../pricing.js';
import { SubagentNavigation, type SubagentView } from './subagents.js';
import { TurnStatus } from './turn_status.js';
import { PlanCompletionTracker, planVisible } from '../plan_state.js';
import { nextAgentActivity } from '../session_activity.js';
import { networkSummary } from '../net.js';
import { terminalText } from '../ink/components/markdown_renderer.js';
import { WelcomeState } from './welcome_state.js';
import { contextInputOf, windowTitle } from './status_rows.js';
import { loadRemap } from '../keybindings.js';
import { emptyUsage, type ToolCall } from '../types.js';
import { ScreenRenderer } from '../ink/screen.js';
import { Clipboard } from '../ink/clipboard.js';
import { MouseSelection } from './mouse_selection.js';
import { type ApprovalDecision, type QueuedMessage } from '../harness.js';
import {
  BUILTIN_SLASH,
  closeMatch,
  commandWord,
  knownSlashNames,
  parseSlash,
  refusedSlash,
} from './slash_commands.js';
import {
  cycleThinking,
  endpointName,
  runCommand,
  type CommandHost,
} from './slash_handlers.js';
import { UndoHistory, type ScreenSnapshot } from './undo_history.js';
import { editorCommand } from './external_editor.js';
import { GatewayModel } from '../model.js';
import { discoverCustomCommands } from '../commands.js';
import { complete, pastedFiles } from '../mentions.js';
import { mediaType } from '../media.js';
import { projectDataDir } from '../paths.js';
import { VERSION } from '../version.js';
import {
  availableUpdate,
  updateCheckEnabled,
  updateNotice,
} from '../update.js';
import { PlanPanel } from '../ink/components/plan_panel.js';
import { stripAnsi, truncate } from '../ink/string_width.js';
import { modelScope, sameModel } from '../model_scope.js';
import { hookFileShown, type HookChange } from '../hooks.js';
import { HookApprovalCard } from '../ink/components/hook_card.js';
import { resumeHint, runningJobs, stoppedJobsLine } from './exit_lines.js';
import { ChromeBrowser, findBrowser } from '../browser/chrome.js';
import { browserTools, runtimeBrowserOptions } from '../browser/tools.js';
import type {
  BrowserApproval,
  CertificateApproval,
} from '../browser/protocol.js';
import { sizeText } from '../browser/files.js';
import { TerminalSessions } from '../terminal/sessions.js';
import { terminalTools, runtimeTerminalOptions } from '../terminal/tools.js';
import { sshConnector } from '../terminal/ssh.js';
import { telnetConnector } from '../terminal/telnet.js';
import { loadProfiles, saveProfiles } from '../terminal/profiles.js';
import { TrustedHostKeys } from '../terminal/hostkeys.js';
import { terminalKeyBytes } from '../terminal/keys.js';
import type { TerminalApproval } from '../terminal/protocol.js';
import { loadSecrets } from '../secrets.js';
export { VERSION } from '../version.js';
interface DialogPending {
  complete: (answer: unknown) => void;
  abort?: () => void;
}
interface SessionView {
  runtime?: AgentRuntime;
  state: ScreenState;
  plan: PlanPanel;
  undo: UndoHistory;
  turns: TurnStatus;
  agents: SubagentNavigation;
  selection: MouseSelection;
  history: InputHistory;
  composer: Composer;
  interactions: InteractionQueue;
  parked: ParkedDraft;
  pending?: DialogPending;
  suspendedDialog?: ScreenState['dialog'];
  flashTimer?: NodeJS.Timeout;
  card?: Card<unknown>;
  secretReady?: SecretRequest;
  backgroundCard: boolean;
  meterCleared?: string;
  shared?: string;
  jobWakeAt: number;
  jobWakeCount: number;
  jobWakeSnoozed: boolean;
  jobsList?: { list: Picker; rows: () => PickerItem[] };
  terminalsList?: { list: Picker; rows: () => PickerItem[] };
  // The handoff's own card: unlike any other card, it does not drop the attached page.
  handoffDialog?: NonNullable<ScreenState['dialog']>;
}
export class SessionApp {
  private view!: SessionView;
  private selectedView!: SessionView;
  private views = new Map<AgentRuntime, SessionView>();
  private sessions?: SessionRuntimeManager;
  private browsers = new Map<AgentRuntime, ChromeBrowser>();
  // Each conversation's device terminals, owned beside its browser
  private terminals = new Map<AgentRuntime, TerminalSessions>();
  private subscriptions = new Map<AgentRuntime, () => void>();
  private runtimeOptions?: Omit<RuntimeOptions, 'approve' | 'question'>;
  private selecting: Promise<void> = Promise.resolve();
  private inView<T>(view: SessionView, action: () => T): T {
    const previous = this.view;
    this.view = view;
    try {
      return action();
    } finally {
      this.view = previous;
    }
  }
  private get plan(): PlanPanel {
    return this.view.plan;
  }
  private knownModels?: string[];
  private knownModelsEndpoint = '';
  private runScopeOnly?: boolean;
  get runtime(): AgentRuntime | undefined {
    return this.view.runtime;
  }
  set runtime(value: AgentRuntime | undefined) {
    this.view.runtime = value;
  }
  get state(): ScreenState {
    return this.view.state;
  }
  private input = new InputParser((event) => this.handle(event));
  private screen = new ScreenRenderer((text) => process.stdout.write(text));
  private theme: ThemeWatch;
  private remap: Record<string, string>;
  private get pending() {
    return this.view.pending;
  }
  private set pending(value: DialogPending | undefined) {
    this.view.pending = value;
  }
  private get card() {
    return this.view.card;
  }
  private set card(value: Card<unknown> | undefined) {
    this.view.card = value;
  }
  private get parked() {
    return this.view.parked;
  }
  private get secretReady() {
    return this.view.secretReady;
  }
  private set secretReady(value: SecretRequest | undefined) {
    this.view.secretReady = value;
  }
  private ended = false;
  /** Head last drawn for a view-only session, so the lock poll can refresh totals. */
  private watchedHead = '';
  /** /exit during a turn: keys stop here while the turn is cancelled. */
  private leaving = false;
  private closing?: Promise<void>;
  private externalEditor = false;
  private animation?: NodeJS.Timeout;
  private get flashTimer() {
    return this.view.flashTimer;
  }
  private set flashTimer(value: NodeJS.Timeout | undefined) {
    this.view.flashTimer = value;
  }
  private keyProblems: string[];
  private done!: (code: number) => void;
  private completion: Promise<number>;
  private previousSession = '';
  private lastEscape = 0;
  private lastCtrlC = 0;
  // /login while its lists are open: the answers so far.
  private loginFlow?: SetupFlow;
  // The /jobs list while it is open, with its rows: it follows the jobs as they change.
  private get jobsList() {
    return this.view.jobsList;
  }
  private set jobsList(value: SessionView['jobsList']) {
    this.view.jobsList = value;
  }
  private get terminalsList() {
    return this.view.terminalsList;
  }
  private set terminalsList(value: SessionView['terminalsList']) {
    this.view.terminalsList = value;
  }
  private get terminalManager(): TerminalSessions | undefined {
    return this.runtime ? this.terminals.get(this.runtime) : undefined;
  }
  // After /undo or /redo, the answer whose request the footer's ctx no longer describes.
  private get meterCleared() {
    return this.view.meterCleared;
  }
  private set meterCleared(value: string | undefined) {
    this.view.meterCleared = value;
  }
  private get history() {
    return this.view.history;
  }
  private get composer() {
    return this.view.composer;
  }
  private commandList?: Map<string, string>;
  private off?: () => void;
  private offSignals?: () => void;
  private get jobWakeAt() {
    return this.view.jobWakeAt;
  }
  private set jobWakeAt(value: number) {
    this.view.jobWakeAt = value;
  }
  private get jobWakeCount() {
    return this.view.jobWakeCount;
  }
  private set jobWakeCount(value: number) {
    this.view.jobWakeCount = value;
  }
  private get jobWakeSnoozed() {
    return this.view.jobWakeSnoozed;
  }
  private set jobWakeSnoozed(value: boolean) {
    this.view.jobWakeSnoozed = value;
  }
  // A background agent's card shows whether a turn runs or not: after the
  // turn's own cards (the queue takes those first) and once typing pauses.
  // The conversation browser, when a Chrome or Edge is installed
  private get interactions() {
    return this.view.interactions;
  }
  private get backgroundCard() {
    return this.view.backgroundCard;
  }
  private set backgroundCard(value: boolean) {
    this.view.backgroundCard = value;
  }
  private get agents() {
    return this.view.agents;
  }
  private planCompletions = new Map<string, PlanCompletionTracker>();
  private agentActivity = new Map<
    string,
    {
      state: 'running' | 'waiting' | 'done' | 'error';
      name: string;
      background?: boolean;
      jobId?: string;
      activity?: string;
    }
  >();
  private frameRows: string[] = [];
  // Frame scheduling, as pi's TUI does it: `repaint` draws now and stays synchronous (the
  // tests read the frame right after calling it), while high-frequency sources (stream
  // tokens, the animation tick) ask through `requestRender`, which coalesces them into one
  // frame at most every 16 ms.
  private renderTimer?: NodeJS.Timeout;
  private renderQueued = false;
  private lastRenderAt = 0;
  // The subagent rows, rebuilt only when the store or the agents' activity moved: a
  // repaint otherwise re-walked every child session and re-summed its tokens each frame.
  private subagentCache?: {
    store: import('../checkpoint_store.js').CheckpointStore;
    sessionId: string;
    version: number;
    activity: number;
    views: NonNullable<ScreenState['subagents']>;
  };
  private activityVersion = 0;
  // The terminal's and the system's clipboard; tests put their own in its place.
  clipboard = new Clipboard();
  private get selection() {
    return this.view.selection;
  }
  private get shared() {
    return this.view.shared;
  }
  private set shared(value: string | undefined) {
    this.view.shared = value;
  }
  private get turns() {
    return this.view.turns;
  }
  private welcomeState: WelcomeState;
  // The runtime is loading the folder's things (attach): the welcome's lamps blink.
  private connecting = false;
  // Setup asks before a session: the welcome shows no model until one is saved.
  private settingUp = false;
  private started = false;
  private title = '';
  private titleAt = 0;
  private get undo() {
    return this.view.undo;
  }
  private dataListener = (data: string): void => {
    if (this.externalEditor) return;
    const events = this.input.feed(data);
    let drop = false;
    for (const event of events) {
      if (drop && event.type === 'key') continue;
      const open = Boolean(this.state.dialog);
      this.handle(event);
      // Keys already in this burst were typed at the card. Closing it must
      // not deliver the rest as a prompt.
      if (open && !this.state.dialog && event.type === 'key') drop = true;
    }
  };
  private resizeListener = (): void => this.repaint();
  // The terminal and the process as lending the screen out uses them (ctrl+z to the shell,
  // /editor to $EDITOR). Tests put their own in place.
  terminal = {
    platform: process.platform as NodeJS.Platform,
    write: (text: string, flush = false): void | Promise<void> => {
      if (!flush) {
        process.stdout.write(text);
        return;
      }
      return flushTerminalWrite(process.stdout, text);
    },
    // on: Circle reads the keys, raw; off: the shell or the editor has them, in line mode.
    input: (on: boolean): void => {
      if (on) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', this.dataListener);
      } else {
        process.stdin.off('data', this.dataListener);
        process.stdin.pause();
        process.stdin.setRawMode(false);
      }
    },
    kill: (signal: NodeJS.Signals): void => {
      process.kill(process.pid, signal);
    },
  };
  private signalListener = (): void => {
    if (this.externalEditor) return;
    if (this.backgroundCard) return;
    this.jobWakeSnoozed = true;
    if (this.runtime?.busy) void this.runtime.cancel();
    else this.exit(0);
  };
  constructor(
    readonly workspace: string,
    readonly home: string,
    public settings: CircleSettings,
  ) {
    const keys = loadRemap(home);
    this.remap = keys.remap;
    this.keyProblems = keys.problems;
    this.view = this.makeView();
    this.selectedView = this.view;
    this.theme = new ThemeWatch(
      settings.theme,
      (text) => {
        if (!this.externalEditor) process.stdout.write(text);
      },
      (flip) => (flip ? this.flash(`Theme → ${flip}`) : this.repaint()),
    );
    this.completion = new Promise((resolve) => {
      this.done = resolve;
    });
    this.welcomeState = new WelcomeState(workspace);
    this.whatsNew = pendingWhatsNew(home);
  }
  /** Upgrade notes still waiting. Shown under the welcome on an empty session. */
  private whatsNew?: WhatsNewNotice;
  /** The notice was painted on the home page. Dismiss or a real prompt marks it seen. */
  private whatsNewShown = false;
  private transcriptIsHome(): boolean {
    const messages = this.runtime?.harness.messages ?? this.state.messages;
    return !messages.some((message) => !message.internal);
  }
  private dismissNotice(): void {
    if (!this.whatsNew) return;
    dismissWhatsNew(this.home);
    this.whatsNew = undefined;
    this.repaint();
  }
  private makeView(): SessionView {
    const settings = this.settings;
    const workspace = this.workspace;
    const state: ScreenState = {
      messages: [],
      notices: [],
      noticeAnchors: [],
      welcome: [],
      draft: '',
      draftCursor: 0,
      model: settings.auth.model || '',
      workspace,
      version: VERSION,
      busy: false,
      waiting: false,
      planMode: false,
      autoMode: false,
      todos: [],
      showThinking: !settings.hide_thinking,
      showTools: false,
      streaming: '',
      thinking: '',
      usage: emptyUsage(),
      flash: '',
      started: Date.now(),
      scroll: 0,
      hiddenTurns: 0,
    };
    const view = {
      state,
      plan: new PlanPanel(),
      undo: new UndoHistory(),
      turns: new TurnStatus(),
      agents: new SubagentNavigation(),
      parked: new ParkedDraft(),
      backgroundCard: false,
      jobWakeAt: 0,
      jobWakeCount: 0,
      jobWakeSnoozed: false,
    } as SessionView;
    view.selection = new MouseSelection({
      scroll: (delta) => this.inView(view, () => this.scrollTranscript(delta)),
      copy: (text) => this.inView(view, () => this.copySelection(text)),
      repaint: () => this.repaint(),
    });
    view.interactions = new InteractionQueue(
      () =>
        this.selectedView === view &&
        !this.externalEditor &&
        !state.dialog &&
        !view.suspendedDialog,
      () => Boolean(state.draft || state.picker),
    );
    view.history = InputHistory.forHome(this.home);
    view.composer = new Composer(state, {
      history: view.history,
      columns: () => process.stdout.columns || 80,
      viewRows: () =>
        this.state.view?.rows ?? Math.max(1, (process.stdout.rows || 24) - 8),
      scroll: (rows) => {
        if (rows === 'top')
          this.state.scroll =
            this.state.view?.maxScroll ?? Number.MAX_SAFE_INTEGER;
        else if (rows === 'bottom') this.state.scroll = 0;
        else this.scrollBy(rows);
      },
      send: (kind) => this.send(kind),
      watchLease: () => this.watchLease(),
      command: (name) =>
        void this.command(name, '').catch((error) => this.fail(error)),
      flash: (text) => this.flash(text),
      commands: () => this.completionCommands(),
      files: (partial, limit) => complete(partial, this.workspace, limit),
    });
    return view;
  }
  start(): void {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', this.dataListener);
    process.stdout.on('resize', this.resizeListener);
    process.on('SIGINT', this.signalListener);
    // The terminal keeps the title it had, to give back on close (xterm's title stack).
    process.stdout.write(
      '\x1b[22;0t\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h',
    );
    this.started = true;
    this.theme.start();
    this.animation = setInterval(() => {
      this.watchLease();
      if (this.jobsList) this.refreshJobsList();
      if (
        [...this.views.values()].some(
          (view) => view.runtime?.busy || view.interactions.pendingCount > 0,
        ) ||
        this.state.busy ||
        this.state.waiting ||
        this.runtime?.jobs.list().some((job) => job.status === 'running') ||
        this.state.jobDetail ||
        this.state.agentDetail ||
        this.state.terminalDetail ||
        (this.state.terminals?.length ?? 0) > 0 ||
        this.connecting
      )
        this.requestRender();
      for (const view of this.views.values())
        this.inView(view, () => {
          this.wakeJobs();
          this.refreshTerminalsList();
        });
    }, 160);
    this.repaint();
  }
  private repaint(): void {
    // A repaint can come from work that settles after leaving (a stopped job, a late reply):
    // the session store may be closed by then.
    if (
      this.view !== this.selectedView ||
      this.ended ||
      this.externalEditor ||
      (this.runtime?.isClosing &&
        this.sessions?.lifecycle(this.runtime.session.id) !== 'deleting')
    )
      return;
    // A direct draw supersedes any coalesced frame still waiting.
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.renderQueued = false;
    this.lastRenderAt = performance.now();
    if (this.runtime && !this.runtime.isClosing) {
      this.state.messages = this.undo.visible(this.runtime.harness.messages);
      this.projectCompletionNotices();
      this.state.userShells = this.runtime.userShells.views.filter(
        (shell) => shell.sessionId === this.runtime!.session.id,
      );
      this.state.todos = this.runtime.todos;
      if (!this.planCompletions.has(this.runtime.session.id)) {
        const tracker = new PlanCompletionTracker();
        tracker.reset(this.runtime.todos);
        this.planCompletions.set(this.runtime.session.id, tracker);
        this.state.planFocused = false;
      }
      if (
        !planVisible(this.state.todos) ||
        this.state.dialog ||
        this.state.picker
      )
        this.state.planFocused = false;
      this.plan.update(this.state.todos);
      this.state.planStart = this.plan.start;
      this.state.queue = this.runtime.harness.queuedShown;
      this.state.model = this.runtime.harness.model.model;
      this.state.planMode = this.runtime.harness.planMode;
      this.state.viewOnly = this.runtime.viewOnly;
      this.state.autoMode = this.runtime.policy.yoloEnabled(
        this.runtime.session.id,
      );
      this.state.acceptEdits =
        this.runtime.policy.mode(this.runtime.session.id) === 'accept-edits';
      this.state.busy = this.runtime.busy;
      const stats = this.runtime.stats();
      this.state.usage = { ...stats.usage };
      this.state.usageUnreported =
        this.state.busy && this.state.usage.input_tokens === 0;
      if (this.state.busy && this.turns.pendingOutput)
        this.state.usage.output_tokens += this.turns.pendingOutput;
      const facts =
        this.runtime.harness.model.modelFacts ??
        this.runtime.catalog.facts(
          this.runtime.harness.model.model,
          this.runtime.options.settings,
          this.runtime.harness.model.contextWindow,
        );
      this.state.contextWindow = facts.windowKnown
        ? facts.contextWindow
        : undefined;
      const lastAnswer = this.runtime.harness.messages
        .filter((message) => message.role === 'assistant' && message.usage)
        .at(-1);
      this.state.contextInput = contextInputOf(
        lastAnswer,
        this.runtime.harness.model.model,
      );
      // After /undo or /redo the meter is unknown until the next answer.
      if (this.meterCleared !== undefined) {
        if ((lastAnswer?.id ?? '') === this.meterCleared)
          this.state.contextInput = undefined;
        else this.meterCleared = undefined;
      }
      const priced =
        facts.rates?.input !== undefined && facts.rates.output !== undefined;
      const pending = this.state.busy ? this.turns.pendingOutput : 0;
      const costs = stats.costs;
      if (pending && facts.rates?.output !== undefined) {
        const extra = (pending * facts.rates.output) / 1_000_000;
        costs.amounts = { ...costs.amounts };
        costs.amounts.USD = (costs.amounts.USD ?? 0) + extra;
        costs.estimated_amounts = {
          ...costs.estimated_amounts,
          USD: (costs.estimated_amounts?.USD ?? 0) + extra,
        };
      }
      this.state.costText = formatCosts([costs], priced);
      this.state.jobs = this.runtime.jobs.list();
      const terminals = this.terminalManager;
      this.state.terminals = terminals?.views(this.runtime.session.id) ?? [];
      if (this.state.terminalDetail) {
        // The page keeps reading the live screen; a console that vanished leaves the page
        const one = terminals?.session(
          this.runtime.session.id,
          this.state.terminalDetail.id,
        );
        this.state.terminalDetail = one;
        if (!one || one.state !== 'ready') this.state.terminalAttached = false;
      }
      const cache = this.subagentCache;
      if (
        cache &&
        cache.store === this.runtime.store &&
        cache.sessionId === this.runtime.session.id &&
        cache.version === this.runtime.store.version &&
        cache.activity === this.activityVersion
      ) {
        this.state.subagents = cache.views;
      } else {
        const collect = (
          parent: string,
        ): import('../checkpoint_store.js').Session[] =>
          this.runtime!.store.children(parent).flatMap((child) => [
            child,
            ...collect(child.id),
          ]);
        const views: SubagentView[] = collect(this.runtime.session.id).map(
          (session) => {
            const activity = this.agentActivity.get(session.id);
            const messages = this.runtime!.store.messages(session.id);
            const last = messages.at(-1);
            return {
              id: session.id,
              name: activity?.name || session.title.split(':')[0] || 'subagent',
              description: session.title,
              activity: activity?.activity,
              background: activity?.background,
              jobId: activity?.jobId,
              messages,
              state:
                activity?.state ??
                (last?.role === 'assistant' && !last.tool_calls?.length
                  ? 'done'
                  : 'interrupted'),
              started: session.created,
              updated: session.updated,
              tokens: messages.reduce(
                (sum, message) =>
                  sum +
                  (message.usage?.input_tokens ?? 0) +
                  (message.usage?.output_tokens ?? 0),
                0,
              ),
            };
          },
        );
        this.subagentCache = {
          store: this.runtime.store,
          sessionId: this.runtime.session.id,
          version: this.runtime.store.version,
          activity: this.activityVersion,
          views,
        };
        this.state.subagents = views;
      }
      // A selection outlives its subagent only while its record is open; with nothing
      // running the strip is gone, and a scrolled window starts over next time.
      const running = this.state.subagents
        .filter(
          (agent) =>
            !agent.background && ['running', 'waiting'].includes(agent.state),
        )
        .map((agent) => agent.id);
      this.agents.prune(running);
      if (!running.length) this.state.stripStart = undefined;
      if (this.state.hoverAgent && !running.includes(this.state.hoverAgent))
        this.state.hoverAgent = undefined;
      this.state.selectedAgent = this.agents.selected;
      this.state.agentDetail = this.state.subagents.find(
        (agent) => agent.id === this.agents.detail,
      );
      if (this.state.jobDetail)
        this.state.jobDetail = this.runtime.jobs.get(this.state.jobDetail.id);
      this.state.renderToolResult = (message) => {
        const renderer = this.runtime!.extensions.renderer(message.name || '');
        if (!renderer) return undefined;
        try {
          const rows = renderer({
            tool_name: message.name,
            tool_call_id: message.tool_call_id,
            status: message.status,
            output: message.content,
            content: message.content,
          });
          if (
            !Array.isArray(rows) ||
            !rows.every((row) => typeof row === 'string')
          )
            throw new Error('renderer must return text lines');
          return rows;
        } catch (error) {
          const note =
            '✖ Extension renderer failed: ' +
            (error instanceof Error ? error.message : String(error));
          if (!this.state.notices.includes(note)) this.addNotice(note);
          return undefined;
        }
      };
    }
    if (!this.runtime?.isClosing) this.syncStatus();
    else this.state.busy = false;
    const cursor: { value?: ScreenCursor } = {};
    const rows = renderScreen(
      this.state,
      process.stdout.columns || 80,
      process.stdout.rows || 24,
      cursor,
    );
    this.frameRows = rows;
    this.screen.render(this.selection.frame(rows, this.state), cursor.value);
    this.sizeOpenTerminal();
  }
  /**
   * The console on the page takes the page's size, as a device console takes its
   * window's. Without this a switch lays its tables out for 80 columns and the page
   * cuts them in half at 62, which is what makes a device page look broken.
   */
  private sizeOpenTerminal(): void {
    const page = this.state.terminalPage;
    const detail = this.state.terminalDetail;
    const manager = this.terminalManager;
    if (!page || !detail || !manager || !this.runtime) return;
    // resize() answers to nothing when the size is the one it has, so this is quiet
    // unless the page really changed, and a device's reply repaints through onChange.
    manager.resize(this.runtime.session.id, detail.id, page.cols, page.rows);
  }
  // Coalesced frame request for high-frequency sources; one draw at most every 16 ms.
  requestRender(): void {
    if (this.view !== this.selectedView || this.ended || this.externalEditor)
      return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    const wait = Math.max(0, 16 - (performance.now() - this.lastRenderAt));
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.renderQueued) return;
      this.renderQueued = false;
      this.repaint();
    }, wait);
  }
  // The header, the welcome and the window title follow the session.
  private syncStatus(): void {
    const trusted = isFolderTrusted(this.settings, this.workspace);
    this.state.gate = !this.runtime && Boolean(this.state.dialog);
    this.state.connected = Boolean(this.runtime) && !this.connecting;
    this.state.branch = this.welcomeState.branch();
    this.state.thinkingDepth = this.runtime?.thinkingLevel;
    this.state.extensionStatus = this.runtime?.extensions.statuses() ?? [];
    this.state.otherSessions = [...this.views.entries()].flatMap(
      ([runtime, view]) => {
        if (runtime === this.runtime || runtime.isClosing) return [];
        const waiting =
          view.state.waiting || view.interactions.pendingCount > 0;
        if (!waiting && !runtime.busy) return [];
        return [
          {
            id: runtime.session.id,
            title:
              runtime.store.get(runtime.session.id)?.title ||
              runtime.session.id,
            waiting,
          },
        ];
      },
    );
    this.turns.fill(this.state);
    this.state.welcome = welcomeRows(
      process.stdout.columns || 80,
      this.welcomeState.info({
        version: VERSION,
        settings: this.settings,
        runtime: this.runtime,
        connected: this.state.connected,
        trusted,
        settingUp: this.settingUp,
      }),
    );
    this.state.welcome.splice(
      -1,
      0,
      palette().dim +
        truncate(
          ' ' + terminalText(networkSummary()),
          Math.max(12, (process.stdout.columns || 80) - 1),
        ) +
        palette().reset,
    );
    if (this.whatsNew && this.transcriptIsHome()) {
      this.whatsNewShown = true;
      const blank = this.state.welcome.pop() ?? '';
      this.state.welcome.push(
        ...whatsNewRows(this.whatsNew, process.stdout.columns || 80),
        blank,
      );
    }
    if (!this.started || Date.now() - this.titleAt < 1000) return;
    this.titleAt = Date.now();
    const runtime = this.runtime;
    const title = windowTitle(
      (runtime && runtime.store.get(runtime.session.id)?.title) || '',
      this.workspace,
    );
    if (title !== this.title) {
      this.title = title;
      process.stdout.write(`\x1b]0;${title}\x07`);
    }
  }
  private flash(text: string, ttl = 1800): void {
    const view = this.view;
    view.state.flash = text;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      view.state.flash = '';
      this.repaint();
    }, ttl);
    this.repaint();
  }
  private notice(text: string): void {
    this.addNotice(text);
    this.repaint();
  }
  /** The resume line is written before a title repair returns. Replace it. */
  private retitleNotice(sessionId: string, title: string): void {
    const line = title.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!sessionId || !line) return;
    const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
      `^((?:Resumed|Continued) ${escaped})(?: · .*|)$`,
    );
    // The repair can finish on the runtime that started it, after the screen
    // has moved to the opened session.
    const states = [this.selectedView.state];
    if (this.view.state !== this.selectedView.state)
      states.push(this.view.state);
    let changed = false;
    for (const state of states) {
      for (let index = state.notices.length - 1; index >= 0; index--) {
        const note = state.notices[index];
        const match = note?.match(pattern);
        if (!match?.[1]) continue;
        const next = `${match[1]} · ${line}`;
        if (note === next) return;
        state.notices[index] = next;
        changed = true;
        break;
      }
    }
    if (changed) this.repaint();
  }
  private projectedCompletionNotices = new WeakMap<SessionView, Set<string>>();
  private get persistedCompletionNotices(): Set<string> {
    let notices = this.projectedCompletionNotices.get(this.view);
    if (!notices) {
      notices = new Set<string>();
      this.projectedCompletionNotices.set(this.view, notices);
    }
    return notices;
  }
  private projectCompletionNotices(): void {
    const anchors = this.state.noticeAnchors ?? [];
    const projected = new Set(this.persistedCompletionNotices);
    const kept = this.state.notices
      .map((text, index) => [text, anchors[index]] as const)
      // Remove exactly the projected occurrence: a later, unsaved request may
      // fail with the same text at the same history position.
      .filter(([text, anchor]) => !projected.delete(`${anchor}\0${text}`));
    this.state.notices = kept.map(([text]) => text);
    this.state.noticeAnchors = kept.map(([, anchor]) => anchor);
    this.persistedCompletionNotices.clear();
    for (const [index, message] of this.state.messages.entries()) {
      if (
        message.role !== 'assistant' ||
        (!message.completion && !message.truncated)
      )
        continue;
      const failure = completionFailure(message);
      if (!failure) continue;
      let anchor = message.id;
      // The failed tool results belong to this response and follow it in history.
      for (
        let next = index + 1;
        this.state.messages[next]?.role === 'tool';
        next++
      )
        anchor = this.state.messages[next]!.id;
      const text = `✖ ${failure.message}`;
      this.state.notices.push(text);
      this.state.noticeAnchors.push(anchor);
      this.persistedCompletionNotices.add(`${anchor}\0${text}`);
    }
  }
  // A notice goes after the message on screen when it came, not under everything that
  // arrives later: `''` before the first message, nothing when no session is open yet.
  private addNotice(text: string): void {
    // A second Resumed line for the same switch is the same event drawn twice.
    if (
      /^(?:Resumed|Continued|Forked) /.test(text) &&
      this.state.notices.at(-1) === text
    )
      return;
    const anchors = (this.state.noticeAnchors ??= []);
    while (anchors.length < this.state.notices.length) anchors.push(undefined);
    this.state.notices.push(text);
    const trail =
      /^(?:Resumed|Continued|Forked|Open in another terminal) /.test(text) ||
      text === 'this session is writable again' ||
      text === 'view only, the draft stays';
    anchors.push(
      trail
        ? undefined
        : this.runtime
          ? (this.undo
              .visible(this.runtime.harness.messages)
              .filter(
                (message) =>
                  !message.internal ||
                  message.internal === 'job_notice' ||
                  message.internal === 'hook_notice' ||
                  message.internal === 'interrupted',
              )
              .at(-1)?.id ?? '')
          : undefined,
    );
  }
  private fail(error: unknown): void {
    this.notice(
      '✖ ' + (error instanceof Error ? error.message : String(error)),
    );
  }
  private setDraft(text: string): void {
    this.composer.set(text);
    this.state.completion = undefined;
  }
  async initialize(force = false, trust = false): Promise<boolean> {
    // Set up, but with no URL or model (an older release's OAuth sign-in): ask again, as
    // print mode does
    if (force || !isReady(this.settings)) {
      this.settingUp = !this.runtime;
      // One card, a step at a time; it says what Circle is doing while the endpoint lists
      // its models, and is drawn again when it has answered.
      const flow = new SetupFlow(this.home);
      const card = new SetupCard(flow);
      card.changed = () => {
        if (this.card !== card) return;
        this.state.dialog = card.state();
        this.repaint();
      };
      const answer = await this.showCard(card);
      if (this.ended || answer !== 'done') return false;
      this.saveConnection(flow);
      this.settingUp = false;
    }
    if (!isFolderTrusted(this.settings, this.workspace)) {
      if (trust) this.trustWorkspace();
      else {
        const answer = await this.askChoice(
          'trust',
          `${this.workspace}\nThis folder can supply instructions, skills, commands, extensions and hooks. Extensions and hooks execute code.`,
          ['trust this folder', 'quit'],
        );
        if (answer !== 'trust this folder') return false;
        this.trustWorkspace();
      }
    }
    return !this.ended;
  }
  // The URL that answered (`<url>/v1` when only that lists models), as line-mode setup
  // saves it; the typed one when nothing answered.
  private saveConnection(flow: SetupFlow): void {
    const auth = flow.auth();
    withConnectionLock(this.home, () => {
      saveCredentials({ api_key: flow.apiKey }, this.home);
      this.settings = saveSettingsChange(this.home, (saved) => {
        if (
          saved.auth.base_url.replace(/\/+$/, '') !==
          auth.base_url.replace(/\/+$/, '')
        )
          saved.enabled_models = [];
        saved.auth = auth;
        saved.initialized = true;
      });
    });
  }
  private trustWorkspace(): void {
    this.settings = trustFolder(this.settings, this.workspace);
    saveSettingsChange(this.home, (saved) => {
      saved.trusted_folders = trustFolder(
        saved,
        this.workspace,
      ).trusted_folders;
    });
  }
  // Once a day, whether a newer release exists; if so, one line stays in the transcript.
  async checkForUpdate(latest?: () => Promise<string>): Promise<void> {
    if (!updateCheckEnabled(this.settings)) return;
    const found = await availableUpdate(this.home, VERSION, latest);
    if (found && !this.ended) this.notice(updateNotice(found));
  }
  // The project's .circle/settings.json and `--model` over the saved settings, in memory only.
  // Runs once the folder is trusted.
  applyRunSettings(modelOverride?: string): void {
    const { problems } = applyProjectSettings(
      this.settings,
      this.workspace,
      this.home,
    );
    if (modelOverride) this.settings.auth.model = modelOverride;
    for (const problem of [...this.keyProblems, ...problems])
      this.fail(problem);
    this.keyProblems = [];
    this.state.model = this.settings.auth.model;
    this.state.showThinking = !this.settings.hide_thinking;
    if (this.theme.mode !== this.settings.theme) {
      this.theme.mode = this.settings.theme;
      this.theme.apply();
    }
  }
  async attach(
    options: Omit<RuntimeOptions, 'approve' | 'question'>,
  ): Promise<void> {
    this.connecting = true;
    this.runtimeOptions = options;
    this.sessions = new SessionRuntimeManager((workspace, session) =>
      this.createRuntime(
        {
          ...this.runtimeOptions!,
          workspace,
          session,
          sessionId: undefined,
          continue: false,
          fork: undefined,
        },
        this.makeView(),
      ),
    );
    // `circle -c` on a session another terminal holds opens it view only. The other
    // ways in (`--session`, a new session) still say it is taken.
    const runtime = this.createRuntime(
      { ...options, viewOccupied: Boolean(options.continue) },
      this.view,
    );
    // Old builds inserted a row on startup and on every /new. Drop the ones
    // nobody is using; a leased empty session stays until that runtime ends.
    runtime.store.purgeEmptySessions();
    this.sessions.register(runtime);
    this.off = () => {
      for (const off of this.subscriptions.values()) off();
      this.subscriptions.clear();
    };
    this.offSignals?.();
    const stop = (code: number): void => {
      void this.close().then(
        () => process.exit(code),
        () => process.exit(code),
      );
    };
    const term = (): void => stop(143);
    const hup = (): void => stop(129);
    process.on('SIGTERM', term);
    process.on('SIGHUP', hup);
    this.offSignals = () => {
      process.off('SIGTERM', term);
      process.off('SIGHUP', hup);
    };
    try {
      await runtime.initialize();
    } finally {
      this.connecting = false;
    }
    if (runtime.viewOnly)
      this.notice(
        `Open in another terminal · view only · circle --fork ${runtime.session.id} copies it here`,
      );
    runtime.repairRecentTitles();
    this.repaint();
  }
  private createRuntime(
    options: Omit<RuntimeOptions, 'approve' | 'question'>,
    view: SessionView,
  ): AgentRuntime {
    let runtime!: AgentRuntime;
    // Each conversation owns its browser, callbacks and grants, just like its MCP/LSP clients.
    const executable = findBrowser();
    const browser = executable
      ? new ChromeBrowser({
          executable,
          trustFile: join(this.home, 'browser-certificates.json'),
          headless: process.env.CIRCLE_BROWSER_HEADLESS === '1',
          handoff: (reason, signal) =>
            view.interactions.run(
              () => this.inView(view, () => this.handBrowser(reason, signal)),
              signal,
            ),
          mode: () => runtime?.mode,
        })
      : undefined;
    // The device terminals: SSH and Telnet consoles the model drives and the person can
    // take over. Unlike the browser they need no external program, so they are always on.
    const profilesFile = join(this.home, 'terminal-sessions.json');
    const terminals = new TerminalSessions({
      connectors: { ssh: sshConnector, telnet: telnetConnector },
      profiles: () => loadProfiles(profilesFile),
      save: (list) => saveProfiles(profilesFile, list),
      hostkeys: new TrustedHostKeys(join(this.home, 'terminal-host-keys.json')),
      secret: (name) => loadSecrets(this.home)[name] ?? '',
      keyFile: (path) => {
        const full = runtime.sandbox.resolvePath(path);
        runtime.sandbox.checkCredentialPath(full);
        return full;
      },
      onChange: () =>
        this.inView(view, () => {
          this.requestRender();
          this.refreshTerminalsList();
        }),
      hand: (_conversation, name, reason, signal) =>
        runtime.mode === 'plan'
          ? Promise.reject(Error('plan mode does not hand a terminal over'))
          : view.interactions.run(
              () =>
                this.inView(view, () =>
                  this.handTerminal(name, reason, signal),
                ),
              signal,
            ),
    });
    runtime = new AgentRuntime({
      ...options,
      deferSession: true,
      extraTools: [
        ...(options.extraTools ?? []),
        ...terminalTools(terminals, {
          confirm: (_session, approval, signal) =>
            view.interactions.run(
              () =>
                this.inView(view, () => this.confirmHostKey(approval, signal)),
              signal,
            ),
          ...runtimeTerminalOptions(() => runtime),
        }),
      ],
      // Browser manuals are thousands of tokens. A greeting does not send them;
      // the turn that asks for a page, or one that already used the browser, does.
      deferredTools: browser
        ? browserTools(browser, {
            confirm: (_session, approval, signal) =>
              view.interactions.run(
                () =>
                  this.inView(view, () =>
                    this.confirmBrowser(approval, signal),
                  ),
                signal,
              ),
            ...runtimeBrowserOptions(() => runtime),
          })
        : [],
      settings: structuredClone(this.settings),
      beforeDelete: async () => {
        await browser?.close();
        terminals.close();
        await options.beforeDelete?.();
      },
      ...this.cardHooks(view),
      onExtensionStatus: () => this.inView(view, () => this.requestRender()),
      onStoreBusy: () => {
        this.state.storeWait = true;
        this.repaint();
      },
      openUrl: async (url) => {
        await openInBrowser(url);
        this.inView(view, () => this.flash('Opened in the browser'));
      },
    });
    view.runtime = runtime;
    if (this.state.storeWait) {
      this.state.storeWait = false;
      this.repaint();
    }
    this.views.set(runtime, view);
    if (browser) this.browsers.set(runtime, browser);
    this.terminals.set(runtime, terminals);
    this.subscriptions.set(
      runtime,
      runtime.bus.subscribe((event) => {
        this.inView(view, () => {
          // Stream tokens draw through the coalescing scheduler; everything else at once.
          let coalesce = false;
          this.turns.apply(
            event,
            () => this.runtime?.harness.messages.at(-1)?.id,
          );
          if (event.kind === 'compaction') {
            const progress = event.payload as unknown as CompactionEvent;
            if (progress.sessionId === this.runtime?.session.id) {
              if (progress.phase === 'start')
                this.state.compaction = new CompactionProgress(
                  progress.trigger,
                );
              this.state.compaction?.apply(progress);
              if (progress.phase === 'done') {
                this.state.compaction = undefined;
                this.notice(compactionDone(progress));
              }
              if (progress.phase === 'error') this.state.compaction = undefined;
            }
          }
          if (event.kind === 'job_ended') this.jobWakeAt = Date.now() + 1000;
          if (event.kind === 'todo_list' && !event.tags.subagent) {
            const sessionId = this.runtime!.session.id;
            let tracker = this.planCompletions.get(sessionId);
            if (!tracker) {
              tracker = new PlanCompletionTracker();
              this.planCompletions.set(sessionId, tracker);
            }
            const completed = tracker.update(this.runtime!.todos);
            if (completed !== undefined)
              this.addNotice(`plan completed · ${completed} steps`);
          }
          if (['job_started', 'job_updated', 'job_ended'].includes(event.kind))
            this.refreshJobsList();
          if (event.tags.subagent) {
            const id = String(event.tags.subagent);
            const old = this.agentActivity.get(id);
            const state =
              event.kind === 'run_end'
                ? 'done'
                : event.kind === 'run_error'
                  ? 'error'
                  : event.kind === 'tool_waiting'
                    ? 'waiting'
                    : event.kind === 'tool_start' ||
                        event.kind === 'llm_start' ||
                        event.kind === 'run_start'
                      ? 'running'
                      : (old?.state ?? 'running');
            this.agentActivity.set(id, {
              state,
              name: String(event.tags.name || old?.name || 'subagent'),
              background: Boolean(event.tags.job_id) || old?.background,
              jobId: event.tags.job_id ? String(event.tags.job_id) : old?.jobId,
              activity: nextAgentActivity(old?.activity, event),
            });
            this.activityVersion++;
            if (event.kind === 'llm_end')
              for (const key of Object.keys(
                this.state.usage,
              ) as (keyof typeof this.state.usage)[])
                this.state.usage[key] += event.usage?.[key] ?? 0;
            if (event.kind === 'llm_token') this.requestRender();
            else this.repaint();
            return;
          }
          if (event.kind === 'run_start') {
            this.plan.follow();
            this.state.started = Date.now();
            // The stop mark belongs to the turn that was stopped. Snapshot it for /undo,
            // then drop it: a new turn has started, so it must not stay at the bottom.
            const before = this.screenBefore(event.payload.message);
            this.undo.push(before);
            const anchors = this.state.noticeAnchors ?? [];
            const kept = this.state.notices
              .map((note, index) => [note, anchors[index]] as const)
              .filter(([note]) => note !== '✖ Interrupted');
            this.state.notices = kept.map(([note]) => note);
            // Older snapshots may have no anchor, or name a message no longer in
            // view. Freeze their fallback at the previous turn instead of letting
            // them follow every new reply to the bottom of the transcript.
            const visible = this.runtime!.harness.messages.filter(
              (message) =>
                before.shown.has(message.id) &&
                (!message.internal ||
                  message.internal === 'job_notice' ||
                  message.internal === 'hook_notice'),
            );
            const visibleIds = new Set(visible.map((message) => message.id));
            const previous = visible.at(-1)?.id ?? '';
            this.state.noticeAnchors = kept.map(([, anchor]) =>
              anchor === '' || (anchor !== undefined && visibleIds.has(anchor))
                ? anchor
                : previous,
            );
            this.state.scroll = 0;
          } else if (event.kind === 'llm_start' || event.kind === 'steer') {
            // A step stopped to read a message drops the reply it was writing
            this.state.streaming = '';
            this.state.thinking = '';
          } else if (event.kind === 'llm_token') {
            if (event.payload.thinking)
              this.state.thinking += String(event.payload.text);
            else this.state.streaming += String(event.payload.text);
            coalesce = true;
          } else if (event.kind === 'llm_end') {
            this.state.streaming = '';
            this.state.thinking = '';
            for (const key of Object.keys(
              this.state.usage,
            ) as (keyof typeof this.state.usage)[])
              this.state.usage[key] += event.usage?.[key] ?? 0;
          } else if (event.kind === 'run_error') {
            // A stop is a dim marker. A key the endpoint turned down (401, 403)
            // says where to change it.
            this.state.streaming = '';
            this.state.thinking = '';
            const assistant = event.payload.completion_message_id
              ? this.runtime?.harness.messages.find(
                  (message) =>
                    message.role === 'assistant' &&
                    message.id === event.payload.completion_message_id,
                )
              : undefined;
            const persisted =
              assistant && (assistant.completion || assistant.truncated)
                ? completionFailure(assistant)
                : undefined;
            if (event.payload.interrupted) {
              const saved = this.runtime?.harness.messages.findLast(
                (message) => !message.internal,
              );
              // The saved reply draws this mark itself. A second live notice
              // shows it twice, and again after switching back to the session.
              // A stop before any text has no reply, so the notice is the mark.
              if (!(saved?.role === 'assistant' && saved.interrupted))
                this.addNotice('✖ Interrupted');
            } else if (
              !event.payload.completion_failure ||
              persisted?.code !== event.payload.completion_failure
            ) {
              const status = Number(event.payload.status);
              this.addNotice(
                '✖ ' +
                  friendlyModelError(String(event.payload.message), status) +
                  ([401, 403].includes(status)
                    ? ' · /login to change the key'
                    : ''),
              );
            }
          } else if (event.kind === 'info' && event.payload.model_notice) {
            const notice = event.payload.model_notice as {
              event: string;
              [key: string]: unknown;
            };
            if (notice.event === 'retry') {
              // What the failed request had written is not kept: it starts again
              this.state.streaming = '';
              this.state.thinking = '';
              this.flash(
                `Retry ${notice.attempt}/${notice.max} in ${(Number(notice.wait_ms) / 1000).toFixed(1)}s`,
              );
            } else if (notice.event === 'title_failed') {
              const message = String(notice.message)
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120);
              const text = `title failed · ${message}`;
              // The turn already said this, for example a missing key.
              if (
                !message ||
                !this.state.notices.some((note) => note.includes(message))
              ) {
                this.notice(text);
                this.flash(text, 5000);
              }
            } else if (notice.event === 'param_dropped')
              this.notice(
                `Endpoint does not support ${notice.param}; continuing without it`,
              );
            else if (notice.event === 'images_left_out')
              this.notice(
                `${notice.model} does not read images; sent their paths only`,
              );
            else if (notice.event === 'files_left_out')
              this.notice(
                `✖ Not attached: ${(notice.problems as string[]).join('; ')}`,
              );
            else if (
              ['repeat_retry', 'missing_finish_retry'].includes(notice.event)
            ) {
              this.state.streaming = '';
              this.state.thinking = '';
              this.flash('Retrying model request');
            }
            // Completion failures are rendered from saved evidence and run_error once.
          } else if (
            event.kind === 'info' &&
            typeof event.payload.title === 'string'
          )
            this.retitleNotice(
              String(event.payload.session_id ?? event.run_id ?? ''),
              String(event.payload.title),
            );
          if (coalesce) this.requestRender();
          else this.repaint();
        });
        if (view !== this.selectedView) this.requestRender();
      }),
    );
    return runtime;
  }
  /** Redraw footer totals when the other terminal has saved messages. */
  private refreshWatchedFooter(): void {
    const runtime = this.runtime;
    if (!runtime) return;
    let stamp = '';
    try {
      const session = runtime.store.get(runtime.session.id);
      stamp = `${session?.head ?? ''}:${session?.updated ?? 0}`;
    } catch {
      return;
    }
    if (stamp === this.watchedHead) return;
    this.watchedHead = stamp;
    this.repaint();
  }
  /**
   * A view-only session stays that way until something asks again. The screen
   * asks on its timer, and enter and picking the session ask at once.
   */
  private watchLease(): void {
    const runtime = this.runtime;
    if (this.ended || !runtime?.viewOnly || runtime.isClosing) return;
    if (sessionOccupied(this.home, runtime.session.id)) {
      this.refreshWatchedFooter();
      return;
    }
    if (!runtime.resumeLease()) return;
    const text = 'this session is writable again';
    if (this.state.notices.at(-1) !== text) this.notice(text);
    else this.repaint();
  }
  private async selectRuntime(runtime: AgentRuntime): Promise<void> {
    await runtime.initialize();
    if (this.ended || this.sessions?.lifecycle(runtime.session.id) !== 'open')
      throw new Error('session is closing');
    const oldRuntime = this.runtime;
    const old = oldRuntime?.session.id;
    if (oldRuntime && oldRuntime !== runtime) oldRuntime.yieldLease();
    runtime.resumeLease();
    this.state.picker = undefined;
    this.jobsList = undefined;
    // Nobody leaves a conversation holding its device console's keys
    if (this.state.terminalAttached) this.attachTerminal(false);
    this.terminalsList = undefined;
    if (this.view.suspendedDialog) {
      this.state.dialog = this.view.suspendedDialog;
      this.view.suspendedDialog = undefined;
    }
    this.view = this.views.get(runtime)!;
    this.selectedView = this.view;
    if (old && old !== runtime.session.id) this.previousSession = old;
    this.commandList = undefined;
    this.subagentCache = undefined;
    this.screen.invalidate();
    this.repaint();
  }
  private ensureSessions(): SessionRuntimeManager {
    if (!this.sessions) {
      const runtime = this.runtime!;
      this.runtimeOptions = runtime.options;
      this.sessions = new SessionRuntimeManager((workspace, session) =>
        this.createRuntime(
          {
            ...this.runtimeOptions!,
            workspace,
            session,
            sessionId: undefined,
            continue: false,
            fork: undefined,
          },
          this.makeView(),
        ),
      );
      this.sessions.register(runtime);
      this.views.set(runtime, this.view);
    }
    return this.sessions;
  }
  private changeSession(id?: string): Promise<void> {
    // /new always opens another runtime. An unused one stays deferred (no
    // sqlite row) until its first message, so startup and /new do not persist
    // empty sessions, and a live conversation can still sit beside it.
    this.ensureSessions();
    const work = this.selecting.then(async () => {
      let runtime: AgentRuntime;
      try {
        runtime = id
          ? this.sessions!.open(this.workspace, id)
          : this.sessions!.create(this.workspace);
      } catch (error) {
        if (!(error instanceof SessionOccupiedError) || !id) throw error;
        runtime = this.openOccupied(id);
      }
      await this.selectRuntime(runtime);
    });
    this.selecting = work.catch(() => {});
    return work;
  }
  /** History of a session another terminal is running. No lease, no writes. */
  private openOccupied(id: string): AgentRuntime {
    const source =
      this.runtime?.store.get(id) ?? this.sessions?.get(id)?.store.get(id);
    if (!source) throw new Error('unknown session');
    const runtime = this.createRuntime(
      {
        ...this.runtimeOptions!,
        workspace: source.workspace,
        session: id,
        sessionId: undefined,
        continue: false,
        fork: undefined,
        inspect: true,
      },
      this.makeView(),
    );
    return this.ensureSessions().register(runtime);
  }
  private async deleteSession(id: string): Promise<boolean> {
    this.ensureSessions();
    const active = this.runtime;
    // A session that has never been written lives only on the runtime that
    // created it. The selected runtime's store does not have that deferred row.
    const owned = this.sessions!.get(id);
    const source = owned?.store.get(id) ?? active!.store.get(id);
    if (!source) throw new Error('unknown session');
    const runtime =
      this.sessions!.get(id) ?? this.sessions!.open(source.workspace, id);
    const view = this.views.get(runtime)!;
    const listed =
      active === runtime
        ? runtime.store
            .list(this.workspace)
            .find(
              (session) =>
                session.id !== id &&
                this.sessions!.lifecycle(session.id) === 'open' &&
                (this.sessions!.get(session.id) ||
                  !sessionOccupied(this.home, session.id)),
            )?.id
        : undefined;
    // Another /new may still be deferred, so it is absent from the table.
    const nextId =
      listed ??
      (active === runtime
        ? [...this.sessions!.values()].find(
            (other) =>
              other.session.id !== id &&
              other.options.workspace === runtime.options.workspace &&
              this.sessions!.lifecycle(other.session.id) === 'open',
          )?.session.id
        : undefined);
    await this.sessions!.delete(id, { confirmed: true });
    view.interactions.close();
    view.selection.close();
    if (view.flashTimer) clearTimeout(view.flashTimer);
    this.subscriptions.get(runtime)?.();
    this.subscriptions.delete(runtime);
    this.browsers.delete(runtime);
    this.terminals.get(runtime)?.close();
    this.terminals.delete(runtime);
    this.views.delete(runtime);
    if (this.previousSession === id) this.previousSession = '';
    if (this.selectedView === view) {
      let next: AgentRuntime;
      try {
        next = nextId
          ? this.sessions!.open(this.workspace, nextId)
          : this.sessions!.create(this.workspace);
      } catch (error) {
        if (
          !(error instanceof SessionOccupiedError) &&
          !(error instanceof Error && error.message === 'unknown session')
        )
          throw error;
        next = this.sessions!.create(this.workspace);
      }
      await this.selectRuntime(next);
      this.previousSession = '';
      return true;
    }
    return false;
  }
  private wakeJobs(): void {
    const runtime = this.runtime;
    if (
      !runtime ||
      this.ended ||
      this.jobWakeSnoozed ||
      this.jobWakeCount >= 10 ||
      runtime.busy ||
      this.state.waiting ||
      this.state.picker ||
      this.state.jobDetail ||
      this.state.draft ||
      Date.now() < this.jobWakeAt ||
      !runtime.jobs.hasNotices(runtime.session.id, true)
    )
      return;
    this.jobWakeCount++;
    const view = this.view;
    void runtime
      .runJobNotices()
      .catch(() => {
        view.jobWakeSnoozed = true;
      })
      .finally(() => this.repaint());
  }
  // Approvals, questions and secrets reach the runtime through the card queue: one card at
  // a time, the turn's own before a background agent's, none while you are typing.
  private cardHooks(
    view: SessionView = this.view,
  ): Pick<RuntimeOptions, 'approve' | 'question' | 'secret' | 'approveHooks'> {
    const asCard = <T>(
      action: () => Promise<T>,
      signal: AbortSignal,
      origin?: { jobId?: string },
    ): Promise<T> =>
      view.interactions.run(
        async () => {
          view.backgroundCard = Boolean(origin?.jobId);
          try {
            return await this.inView(view, action);
          } finally {
            view.backgroundCard = false;
          }
        },
        signal,
        Boolean(origin?.jobId),
      );
    // Whose card: a background job by its id, a subagent of this turn by its strip name
    // (`general-purpose·1a2b3c4d`), the main agent by nothing.
    const label = (origin?: InteractionContext): string =>
      origin?.jobId
        ? `${origin.jobId} ${origin.name ?? ''}`.trim()
        : origin?.agent
          ? agentName({ id: origin.agent, name: origin.name || 'subagent' })
          : '';
    return {
      approve: (call, signal, origin) =>
        asCard(() => this.approve(call, signal, label(origin)), signal, origin),
      question: (args, signal, origin) =>
        asCard(
          async () => {
            if (!Array.isArray(args.questions))
              throw new Error('invalid questions');
            // every question in one card; null (cancelled) tells the model nothing was answered
            return JSON.stringify(
              await this.showCard(
                new QuestionCard(args.questions as Question[], label(origin)),
                signal,
              ),
            );
          },
          signal,
          origin,
        ),
      secret: (request, signal, origin) =>
        asCard(
          () =>
            this.enterSecret(
              {
                ...request,
                question:
                  (label(origin) ? `${label(origin)} · ` : '') +
                  request.question,
              },
              signal,
            ),
          signal,
          origin,
        ),
      // A project hooks file waiting for approval, when a turn starts: the card waits,
      // like the others, until typing pauses.
      approveHooks: (change, signal) =>
        asCard(() => this.askHooks(change, signal), signal),
    };
  }
  /** `--approve-hooks`: approve the files this session waits for, as they were read. */
  approveWaitingHooks(): void {
    const runtime = this.runtime;
    if (!runtime || runtime.viewOnly) return;
    for (const change of runtime.pendingHooks())
      if (runtime.approveHooks(change))
        this.notice(
          `project hooks approved · ${hookFileShown(change.file, this.workspace)}`,
        );
  }
  private async askHooks(
    change: HookChange,
    signal: AbortSignal,
  ): Promise<boolean> {
    const answer = await this.showCard(new HookApprovalCard(change), signal);
    if (answer === 'approve')
      this.notice(
        `project hooks approved · ${hookFileShown(change.file, this.workspace)}`,
      );
    return answer === 'approve';
  }
  private async showCard<T>(card: Card<T>, signal?: AbortSignal): Promise<T> {
    const view = this.view;
    view.card = card as Card<unknown>;
    try {
      return await this.dialog<T>(card.state(), signal);
    } finally {
      view.card = undefined;
    }
  }
  private async enterSecret(
    request: SecretRequest,
    signal: AbortSignal,
  ): Promise<void> {
    const view = this.view;
    view.secretReady = request;
    try {
      const choice = await this.askChoice(
        'secret',
        `${request.question}\n${secretDestination(request)}\nenter secret, then type the value`,
        ['enter secret', 'cancel'],
        signal,
      );
      if (choice !== 'enter secret') {
        await cancelRequest(this.home, request.id);
        return;
      }
      const value = await this.inView(view, () =>
        this.showCard(
          new SecretCard(
            `${request.question}\n${secretDestination(request)}`,
            request.mask !== false,
          ),
          signal,
        ),
      );
      if (value === null) {
        await cancelRequest(this.home, request.id);
        return;
      }
      await submitAnswer(this.home, request.id, value);
      this.inView(view, () => this.flash('Collected · not shown'));
    } finally {
      view.secretReady = undefined;
    }
  }
  private askChoice(
    title: string,
    body: string,
    options: string[],
    signal?: AbortSignal,
  ): Promise<string> {
    return this.dialog({ title, body, options, focus: 0 }, signal);
  }
  // A card takes the frame: the draft (text and cursor) is set aside and comes back when
  // the card ends, whatever it was answered with; a list would compete for keys, so it closes.
  private dialog<T = string>(
    state: NonNullable<ScreenState['dialog']>,
    signal?: AbortSignal,
  ): Promise<T> {
    const view = this.view;
    const screen = view.state;
    if (view.pending)
      return Promise.reject(new Error('another question is waiting'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    // An open list is hidden while the card is up and given back after.
    const list = screen.picker;
    screen.picker = undefined;
    view.parked.park(screen);
    // An attached console gives its keys to any card that is not the handoff's own
    this.detachForCard(state);
    screen.dialog = state;
    screen.planFocused = false;
    screen.waiting = true;
    return new Promise<T>((resolve, reject) => {
      const close = (): void => {
        view.pending = undefined;
        screen.dialog = undefined;
        view.suspendedDialog = undefined;
        screen.waiting = false;
        screen.picker ??= list;
        view.parked.restore(screen);
        this.repaint();
      };
      const abort = (): void => {
        close();
        reject(signal?.reason || new Error('Interrupted'));
      };
      view.pending = {
        complete: (answer) => {
          signal?.removeEventListener('abort', abort);
          close();
          resolve(answer as T);
        },
        abort,
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.repaint();
    });
  }
  /**
   * Circle hands the person the browser window; the card stays until they continue, or in
   * auto mode until the page moves on.
   */
  private async handBrowser(reason: string, signal: AbortSignal) {
    const auto = this.runtime?.mode === 'auto';
    await this.askChoice(
      'browser',
      [
        `Circle hands you the browser${reason ? `: ${reason}` : ''}`,
        `Use the browser window. Circle does not see what you do there; it learns where the tabs went, never what you typed. ${auto ? 'Circle goes on by itself once the page moves on, or choose continue.' : 'When you are done, choose continue.'}`,
      ].join('\n'),
      ['continue'],
      signal,
    );
  }
  // A device console the model hands over: the page opens on it, attached, so the
  // person is typing on the device at once; the card below waits, and only ctrl+] gives
  // the keys to the card. Unlike every other card this one does not drop the page.
  private async handTerminal(
    name: string,
    reason: string,
    signal: AbortSignal,
  ): Promise<void> {
    const manager = this.terminalManager;
    const conversation = this.runtime?.session.id ?? '';
    if (!manager) return;
    const one = manager
      .views(conversation)
      .find((view) => view.name === name || view.id === name);
    const session = one ? manager.session(conversation, one.id) : undefined;
    if (!session) return;
    this.openTerminalPage(session.id);
    this.attachTerminal(true);
    const spec = {
      title: 'terminal',
      body: [
        `Circle hands you ${name}${reason ? `: ${reason}` : ''}`,
        'Type on the device. ctrl+] gives the keys to this card; when you are done, choose continue.',
      ].join('\n'),
      options: ['continue'],
      focus: 0,
    };
    this.view.handoffDialog = spec;
    try {
      await this.dialog<string>(spec, signal);
    } finally {
      this.view.handoffDialog = undefined;
    }
    manager.detach(conversation, session.id);
  }
  /** A device whose host key nobody has trusted: only the person decides. */
  private async confirmHostKey(
    approval: TerminalApproval,
    signal: AbortSignal,
  ): Promise<'once' | 'always' | 'reject' | 'auto'> {
    // auto mode answers for once, never for good, as it passes a certificate warning
    if (this.runtime?.policy.mode(this.runtime.session.id) === 'auto')
      return 'auto';
    const choice = await this.askChoice(
      'host key',
      [
        `Circle wants to log in to ${approval.host}, whose host key nobody has trusted:`,
        `  ${approval.keyType || 'unknown type'}  ${approval.fingerprint}`,
        'A host key is how you know the device is the one you mean; a wrong one means someone else is answering.',
      ].join('\n'),
      [
        'connect once',
        ...(approval.privateHost ? ['trust for good'] : []),
        'reject',
      ],
      signal,
    );
    if (choice === 'trust for good') return 'always';
    if (choice === 'connect once') return 'once';
    return 'reject';
  }
  /** The person opens a console's page from /terminals or a handoff. */
  private openTerminalPage(id: string): void {
    const manager = this.terminalManager;
    const conversation = this.runtime?.session.id ?? '';
    const session = manager?.session(conversation, id);
    if (!session) return;
    // Pages are exclusive: opening a terminal leaves the job and subagent pages
    this.agents.clear();
    this.state.agentDetail = undefined;
    this.state.jobDetail = undefined;
    this.state.find = undefined;
    this.state.terminalDetail = session;
    this.state.terminalAttached = false;
    this.state.scroll = 0;
    this.repaint();
  }
  /** The person takes or gives back the keys of the page they are looking at. */
  private attachTerminal(attach: boolean): boolean {
    const manager = this.terminalManager;
    const detail = this.state.terminalDetail;
    const conversation = this.runtime?.session.id ?? '';
    if (!manager || !detail) return false;
    if (attach) {
      if (!manager.attach(conversation, detail.id)) return false;
      this.state.terminalAttached = true;
    } else {
      // ctrl+] during a handoff only returns the keys to the card: the model still
      // waits, and the handoff is answered with continue on the card itself
      if (detail.held === 'attach') manager.detach(conversation, detail.id);
      this.state.terminalAttached = false;
    }
    this.state.scroll = 0;
    this.repaint();
    return true;
  }
  /** /terminals' ctrl+d: a person's disconnect, not the model's. */
  private async cutTerminal(id: string): Promise<void> {
    const manager = this.terminalManager;
    const conversation = this.runtime?.session.id ?? '';
    if (!manager) return;
    await manager
      .request(
        conversation,
        'disconnect',
        { session: id },
        AbortSignal.timeout(5000),
      )
      .catch((error) => this.fail(error));
  }
  /** /terminals' enter on a profile: connect now and open the page; the host key still asks. */
  private async connectTerminalProfile(name: string): Promise<void> {
    const manager = this.terminalManager;
    const conversation = this.runtime?.session.id ?? '';
    if (!manager) return;
    const stop = new AbortController();
    let result = await manager
      .request(conversation, 'connect', { profile: name }, stop.signal)
      .catch((error) => {
        this.fail(error);
        return undefined;
      });
    for (let round = 0; result?.approval && round < 8; round++) {
      const answer = await this.inView(this.view, () =>
        this.confirmHostKey(result!.approval!, stop.signal),
      ).catch(() => 'reject' as const);
      if (answer === 'reject') {
        this.flash('Not connected');
        return;
      }
      result = await manager.request(
        conversation,
        'connect',
        {
          profile: name,
          approval: {
            token: result!.approval!.token,
            scope: answer === 'always' ? 'always' : 'once',
          },
        },
        stop.signal,
      );
    }
    if (!result) return;
    const one = manager
      .views(conversation)
      .find((view) => view.name === name && view.state === 'ready');
    if (one) this.openTerminalPage(one.id);
    this.notice(`Connected ${name}`);
  }
  /** A card that is not the handoff's own takes the keys: leave attach and the page. */
  private detachForCard(state: NonNullable<ScreenState['dialog']>): void {
    if (!this.state.terminalAttached) return;
    if (state === this.view.handoffDialog) return;
    this.attachTerminal(false);
    this.state.terminalDetail = undefined;
  }
  // While attached, and nothing else holds the keyboard — no card, no list, no secret
  // box — typed keys and pastes are the device's. The handoff card is the one card that
  // may sit over an attached console without taking its keys.
  private canTypeToTerminal(): boolean {
    if (!this.state.terminalAttached || !this.state.terminalDetail)
      return false;
    if (this.state.picker) return false;
    if (this.view.secretReady) return false;
    const dialog = this.state.dialog;
    return !dialog || dialog === this.view.handoffDialog;
  }
  private typeToTerminal(bytes: string): void {
    const detail = this.state.terminalDetail;
    if (!detail || !bytes) return;
    this.terminalManager?.input(
      this.runtime?.session.id ?? '',
      detail.id,
      bytes,
    );
  }
  /** The open /terminals list follows the consoles, as the jobs list follows jobs. */
  private refreshTerminalsList(): void {
    const open = this.terminalsList;
    if (!open) return;
    if (this.state.picker === open.list) {
      if (!open.list.asking) open.list.setItems(open.rows());
    } else if (!this.state.dialog) this.terminalsList = undefined;
  }
  /** What only the person decides in the browser: files for a page or from it, or passing a warning. */
  private async confirmBrowser(
    approval: BrowserApproval,
    signal: AbortSignal,
  ): Promise<'once' | 'always' | 'reject' | 'auto'> {
    // Auto mode passes a warning and gives files without asking
    const auto = this.runtime?.policy.mode(this.runtime.session.id) === 'auto';
    if (approval.kind === 'certificate')
      return auto ? 'auto' : this.confirmCertificate(approval, signal);
    if (approval.kind === 'coordinate') {
      if (auto) return 'auto';
      const choice = await this.askChoice(
        'browser click',
        [
          approval.origin,
          `target: ${approval.element}`,
          `coordinates: ${approval.x}, ${approval.y}`,
          approval.destructive
            ? 'this target may delete content'
            : 'this target has no confirmed action',
        ].join('\n'),
        ['allow once', 'reject'],
        signal,
      );
      return choice === 'allow once' ? 'once' : 'reject';
    }
    if (approval.kind === 'download') {
      // auto mode keeps what the model downloads; the other modes ask once per site
      if (auto) return 'once';
      const always = 'allow downloads from this site for this session';
      const choice = await this.askChoice(
        'download',
        [
          'Circle downloaded files: keep them?',
          `site: ${approval.site || 'unknown'}`,
          ...approval.files.map(
            (file) => `${file.name} · ${sizeText(file.size)}`,
          ),
        ].join('\n'),
        ['keep', always, 'discard'],
        signal,
      );
      return choice === 'keep'
        ? 'once'
        : choice === always
          ? 'always'
          : 'reject';
    }
    if (auto) return 'once';
    const choice = await this.askChoice(
      'upload',
      [
        'Circle wants to give the page these files',
        `site: ${approval.origin || 'unknown'}`,
        `field: ${approval.element}`,
        ...approval.files.map(
          (file) => `${file.name} · ${sizeText(file.size)} · ${file.path}`,
        ),
      ].join('\n'),
      ['allow', 'reject'],
      signal,
    );
    return choice === 'allow' ? 'once' : 'reject';
  }
  /** The model clicked proceed on the browser's certificate warning: only the person decides. */
  private async confirmCertificate(
    approval: CertificateApproval,
    signal: AbortSignal,
  ): Promise<'once' | 'always' | 'reject'> {
    const always = 'always trust this certificate on this host';
    const choice = await this.askChoice(
      'certificate',
      [
        "Circle wants to go past the browser's certificate warning",
        `site: ${approval.url}`,
        `issued to: ${approval.subject || 'unknown'}`,
        `issued by: ${approval.issuer || 'unknown'}`,
        ...(approval.validExpiry
          ? [
              `valid until: ${new Date(approval.validExpiry * 1000).toISOString().slice(0, 10)}`,
            ]
          : []),
        `sha256: ${approval.fingerprint || 'unknown'}`,
      ].join('\n'),
      [
        'allow once',
        ...(approval.privateHost && approval.fingerprint ? [always] : []),
        'reject',
      ],
      signal,
    );
    return choice === 'allow once'
      ? 'once'
      : choice === always
        ? 'always'
        : 'reject';
  }
  private async approve(
    call: ToolCall,
    signal: AbortSignal,
    origin = '',
  ): Promise<ApprovalDecision> {
    const runtime = this.runtime!;
    return this.showCard(
      new ApprovalCard(
        approvalRequest(
          call,
          runtime.policy.review(call.name, call.args),
          (path) => runtime.sandbox.resolvePath(path),
          origin,
        ),
      ),
      signal,
    );
  }
  private handle(event: InputEvent): void {
    if (this.ended || this.leaving || this.externalEditor) return;
    this.theme.feed(event);
    if (event.type === 'color' || event.type === 'scheme') return;
    if (event.type === 'mouse') {
      // Motion with no button: what is under the mouse lights up, nothing else happens.
      if (event.action === 'move' && event.button !== 0) {
        this.hover(event);
        return;
      }
      if (
        event.action === 'press' &&
        event.button === 0 &&
        !this.state.dialog &&
        !this.state.picker
      ) {
        const top = this.frameRows.findIndex((row) =>
          /^┌.*Plan \d+\//.test(stripAnsi(row)),
        );
        const bottom =
          top < 0
            ? -1
            : this.frameRows.findIndex(
                (row, index) => index > top && stripAnsi(row).startsWith('└'),
              );
        this.state.planFocused =
          top >= 0 && event.y >= top && event.y <= bottom;
        if (this.state.planFocused) {
          this.agents.clear();
          this.state.find = undefined;
          if (this.history.query !== undefined) {
            this.history.endSearch(false);
            this.state.historySearch = undefined;
          }
          this.repaint();
          return;
        }
      }
      if (this.pageButton(event)) return;
      if (this.stripClick(event)) return;
      if (this.selectionMouse(event)) return;
      if (
        event.action === 'press' &&
        event.button === 0 &&
        /^ . Agent\(/.test(stripAnsi(this.frameRows[event.y] ?? '')) &&
        this.state.subagents?.length
      ) {
        const open = (id: string): void => {
          this.agents.open(id);
          this.state.scroll = 0;
          this.repaint();
        };
        if (this.state.subagents.length === 1)
          open(this.state.subagents[0]!.id);
        else
          this.picker(
            'Task details',
            this.state.subagents.map((agent) => ({
              key: agent.id,
              label: `${agent.name} · ${agent.state}`,
              meta: agent.description,
            })),
            async (item) => {
              open(item.key);
            },
          );
      }
      const strip = this.state.stripAgents;
      if (
        event.action === 'wheel' &&
        strip?.scrollable &&
        event.y >= strip.row - 1 &&
        event.y < strip.row - 1 + strip.rows
      )
        // over the strip, with subagents folded away: the wheel moves the strip
        this.scrollStrip(event.button === 0 ? -1 : 1);
      else if (event.action === 'wheel') {
        const top = this.frameRows.findIndex((row) =>
          /^┌.*Plan \d+\//.test(stripAnsi(row)),
        );
        const bottom =
          top < 0
            ? -1
            : this.frameRows.findIndex(
                (row, index) => index > top && stripAnsi(row).startsWith('└'),
              );
        if (
          top >= 0 &&
          event.y >= top &&
          event.y <= bottom &&
          !this.state.dialog
        ) {
          this.plan.scroll(event.button === 0 ? -1 : 1);
          this.state.planStart = this.plan.start;
        } else this.scrollBy(event.button === 0 ? 3 : -3);
      }
      this.repaint();
      return;
    }
    if (event.type === 'switch') {
      if (this.runtime)
        void this.changeSession(event.id).then(
          () => this.repaint(),
          (error) => this.fail(error),
        );
      return;
    }
    if (event.type === 'upload') {
      this.setDraft(this.state.draft + ' @' + event.filename);
      this.repaint();
      return;
    }
    // a key or paste for the draft: a card that arrives now waits until typing pauses
    if (!this.state.dialog) this.interactions.typed();
    if (event.type === 'paste') {
      // Attached to a device: what you paste is what the console gets
      if (this.canTypeToTerminal()) {
        this.typeToTerminal(event.text);
        this.repaint();
        return;
      }
      this.state.planFocused = false;
      if (this.state.picker && this.state.picker.options.search !== false)
        this.state.picker.paste(event.text);
      else if (this.state.find && !this.state.dialog) {
        this.state.find.query += event.text;
        this.state.find.retype();
      } else if (this.history.query !== undefined && !this.state.dialog) {
        const match = this.history.update(this.history.query + event.text);
        if (match !== undefined) this.setDraft(match);
        this.state.historySearch = {
          query: this.history.query!,
          match: match !== undefined,
        };
      } else if (
        this.card instanceof ApprovalCard &&
        this.card.explaining &&
        this.state.dialog
      ) {
        this.composer.paste(event.text);
        this.composer.update();
        this.publishExplain(this.card);
      } else if (this.card && this.state.dialog) {
        this.card.paste(event.text);
        this.state.dialog = this.card.state();
      } else if (this.state.dialog?.input !== undefined)
        this.state.dialog.input += event.text;
      else if (!this.state.dialog) {
        // Files dragged onto the terminal arrive as their paths. An empty paste reads the
        // clipboard's picture, as ctrl+v does.
        const files = pastedFiles(event.text);
        if (files) this.attachFiles(files);
        else if (!event.text)
          void this.pasteImage().catch((error) => this.fail(error));
        else {
          this.composer.paste(event.text);
          this.composer.update();
        }
      }
      this.repaint();
      return;
    }
    const key = this.remap[event.key] || event.key;
    const char = event.char;
    if (key === 'alt+s' && this.runtime) {
      // Leaving the view never leaves a console held by its keys
      if (this.state.terminalAttached) this.attachTerminal(false);
      this.view.suspendedDialog ??= this.state.dialog;
      this.state.dialog = undefined;
      void this.command('resume', '').catch((error) => this.fail(error));
      return;
    }
    // Attached: every key goes to the device, and only ctrl+] comes back. Ctrl+C with
    // it goes to the console, not the turn: leaving is ctrl+], then ctrl+c as ever.
    if (this.canTypeToTerminal()) {
      if (key === 'ctrl+]') {
        this.attachTerminal(false);
        return;
      }
      this.typeToTerminal(terminalKeyBytes(key, char));
      this.repaint();
      return;
    }
    if (
      !this.state.dialog &&
      !this.state.picker &&
      !this.state.agentDetail &&
      !this.state.jobDetail &&
      !this.state.terminalDetail
    ) {
      if (key === 'alt+p' && planVisible(this.state.todos)) {
        this.state.planFocused = !this.state.planFocused;
        this.agents.clear();
        this.state.find = undefined;
        if (this.history.query !== undefined) {
          this.history.endSearch(false);
          this.state.historySearch = undefined;
        }
        this.flash(
          this.state.planFocused ? 'plan · esc returns to input' : 'input',
        );
        this.repaint();
        return;
      }
      if (this.state.planFocused) {
        if (key === 'up' || key === 'down') {
          this.plan.scroll(key === 'up' ? -1 : 1);
          this.repaint();
          return;
        }
        this.state.planFocused = false;
        if (key === 'escape') {
          this.repaint();
          return;
        }
      }
    }
    if (!this.state.dialog && !this.state.picker && this.state.find) {
      const find = this.state.find;
      if (['escape', 'ctrl+c', 'ctrl+f'].includes(key))
        this.state.find = undefined;
      else if (['enter', 'down', 'shift+enter', 'up'].includes(key))
        find.next(key === 'up' || key === 'shift+enter');
      else if (key === 'backspace' || char) {
        find.query =
          key === 'backspace'
            ? Array.from(find.query).slice(0, -1).join('')
            : find.query + char;
        find.retype();
      }
      this.repaint();
      return;
    }
    if (
      !this.state.dialog &&
      !this.state.picker &&
      this.history.query !== undefined
    ) {
      if (key === 'escape' || key === 'ctrl+c') {
        this.setDraft(this.history.endSearch(true));
        this.state.historySearch = undefined;
        this.repaint();
        return;
      }
      if (key === 'ctrl+r' || key === 'backspace' || char) {
        const query =
          key === 'backspace'
            ? Array.from(this.history.query).slice(0, -1).join('')
            : this.history.query + char;
        const match =
          key === 'ctrl+r' ? this.history.next() : this.history.update(query);
        if (match !== undefined) this.setDraft(match);
        this.state.historySearch = {
          query: this.history.query!,
          match: match !== undefined,
        };
        this.repaint();
        return;
      }
      this.history.endSearch(false);
      this.state.historySearch = undefined;
    }
    if (!this.state.dialog && !this.state.picker && key === 'ctrl+f') {
      this.state.find = new TranscriptFind();
      this.repaint();
      return;
    }
    if (!this.state.dialog && !this.state.picker && key === 'ctrl+r') {
      const match = this.history.beginSearch(this.state.draft);
      if (match !== undefined) this.setDraft(match);
      this.state.historySearch = {
        query: this.history.query!,
        match: match !== undefined,
      };
      this.repaint();
      return;
    }
    if (!this.state.dialog && !this.state.picker && this.selection.key(key))
      return;
    const agentIds = (): string[] =>
      (this.state.subagents ?? [])
        .filter(
          (agent) =>
            this.agents.detail ||
            ['running', 'waiting'].includes(agent.state) ||
            agent.id === this.agents.selected,
        )
        .map((agent) => agent.id);
    if (
      !this.state.dialog &&
      !this.state.picker &&
      !this.state.jobDetail &&
      this.agents.handle(key, char, agentIds(), this.state.draft)
    ) {
      this.state.scroll = 0;
      this.state.stripStart = undefined;
      this.repaint();
      return;
    }
    // A subagent's record you are reading keeps its keys while a card waits under it: esc
    // and backspace leave the record, ← → move between subagents, the page keys scroll it.
    // Any other key only leaves the record, so a key meant for the page never answers the
    // card. ctrl+c still stops the turn.
    if (
      this.agents.detail &&
      this.state.dialog &&
      !this.state.picker &&
      key !== 'ctrl+c'
    ) {
      const page = Math.max(1, this.state.view?.rows ?? 1);
      if (key === 'pageup' || key === 'pagedown')
        this.scrollBy(key === 'pageup' ? page : -page);
      else if (key === 'home')
        this.state.scroll = this.state.view?.maxScroll ?? 0;
      else if (key === 'end') this.state.scroll = 0;
      else {
        // back to the conversation: the card has the keys now, not the strip
        if (key === 'left' || key === 'right')
          this.agents.handle(key, '', agentIds(), '');
        else this.agents.clear();
        this.state.scroll = 0;
      }
      this.repaint();
      return;
    }
    // The job page keeps its keys; ctrl+c and ctrl+z work there as anywhere
    if (
      this.state.jobDetail &&
      !this.state.dialog &&
      key !== 'ctrl+c' &&
      key !== 'ctrl+z'
    ) {
      const job = this.state.jobDetail;
      const owner = this.view;
      const runtime = this.runtime!;
      if (key === 'escape') {
        this.state.jobDetail = undefined;
        void this.command('jobs', '');
      } else if (key === 'ctrl+k')
        void (async () => {
          if (job.status === 'running') {
            if (
              (await this.askChoice(`stop ${job.id}`, job.title, [
                'stop job',
                'keep running',
              ])) === 'stop job'
            )
              await runtime.jobs.stop(job.id, 'user');
          } else {
            runtime.jobs.remove(job.id);
            owner.state.jobDetail = undefined;
            await this.inView(owner, () => this.command('jobs', ''));
          }
          this.repaint();
        })().catch((error) => this.fail(error));
      else if (key === 'ctrl+b') this.runtime?.jobs.backgroundForeground();
      this.repaint();
      return;
    }
    // The terminal page, while you look at it and have not attached: the page keys
    // scroll, enter attaches, ctrl+d cuts, esc leaves; ctrl+c and ctrl+z are as anywhere.
    if (
      this.state.terminalDetail &&
      !this.state.terminalAttached &&
      !this.state.dialog &&
      !this.state.picker &&
      key !== 'ctrl+c' &&
      key !== 'ctrl+z'
    ) {
      const detail = this.state.terminalDetail;
      const owner = this.view;
      const page = Math.max(1, this.state.view?.rows ?? 1);
      if (key === 'escape') {
        owner.state.terminalDetail = undefined;
        owner.state.scroll = 0;
        this.repaint();
        return;
      }
      if (key === 'enter' || key === 'a') {
        if (!this.attachTerminal(true))
          this.inView(owner, () => this.flash('nothing to attach'));
        return;
      }
      if (key === 'ctrl+d')
        void (async () => {
          if (detail.state === 'ready') {
            if (
              (await this.askChoice(
                `cut ${detail.id}`,
                `${detail.name} · ${detail.transport} ${detail.target}`,
                ['disconnect', 'keep'],
              )) === 'disconnect'
            )
              await this.cutTerminal(detail.id);
          } else {
            owner.state.terminalDetail = undefined;
            await this.inView(owner, () => this.command('terminals', ''));
          }
          this.inView(owner, () => this.repaint());
        })().catch((error) => this.fail(error));
      else if (key === 'pageup' || key === 'pagedown')
        this.scrollBy(key === 'pageup' ? page : -page);
      else if (key === 'home')
        this.state.scroll = this.state.view?.maxScroll ?? 0;
      else if (key === 'end') this.state.scroll = 0;
      else {
        // any other key only leaves the page
        owner.state.terminalDetail = undefined;
      }
      this.repaint();
      return;
    }
    if (this.state.dialog) {
      if (key === 'ctrl+c' && this.backgroundCard) {
        // Not an answer: it stops the turn, or leaves on a second press; the card stays.
        this.ctrlC();
        this.repaint();
        return;
      }
      const dialog = this.state.dialog;
      if (this.card) {
        // Reject and explain is the composer: esc returns to the options and keeps
        // the draft, enter rejects (empty is plain), and a /command runs.
        if (this.card instanceof ApprovalCard && this.card.explaining) {
          this.explainKey(this.card, key, char);
          this.repaint();
          return;
        }
        const result = this.card.handle(key, char);
        if (this.card instanceof ApprovalCard && this.card.explaining) {
          this.composer.set(this.card.draft);
          this.composer.update();
          this.publishExplain(this.card);
          this.repaint();
          return;
        }
        if (result === 'pass') {
          // not the card's business: ctrl+c stops the turn, page keys scroll
          if (key === 'ctrl+c' && this.runtime?.busy) this.ctrlC();
          else if (key === 'pageup' || key === 'pagedown') {
            const page = Math.max(1, (process.stdout.rows || 24) - 8);
            this.scrollBy(key === 'pageup' ? page : -page);
          }
        } else if (result) this.pending?.complete(result.answer);
        else this.state.dialog = this.card.state();
        this.repaint();
        return;
      }
      if (key === 'escape' || key === 'ctrl+c')
        this.pending?.complete(dialog.options.at(-1) || '');
      else if (dialog.input !== undefined) {
        if (key === 'enter') this.pending?.complete(dialog.input);
        else if (key === 'backspace')
          dialog.input = Array.from(dialog.input).slice(0, -1).join('');
        else if (char && !key.startsWith('ctrl+') && !key.startsWith('alt+'))
          dialog.input += char;
      } else if (key === 'up' || key === 'down')
        dialog.focus =
          (dialog.focus + (key === 'up' ? -1 : 1) + dialog.options.length) %
          dialog.options.length;
      else if (key === 'enter')
        this.pending?.complete(dialog.options[dialog.focus] || '');
      else if (/^[1-9]$/.test(key) && dialog.options[Number(key) - 1])
        this.pending?.complete(dialog.options[Number(key) - 1]!);
      else if (key === 'y') this.pending?.complete(dialog.options[0] || '');
      else if (key === 'n') this.pending?.complete(dialog.options.at(-1) || '');
      this.repaint();
      return;
    }
    // Every key goes to an open list; it leaves ctrl+c and ctrl+d to the session unless it
    // asks for something or uses them, and a list without a search leaves the keys it does
    // not use.
    if (this.state.picker?.handle(key, char)) {
      this.repaint();
      return;
    }
    if (key === 'ctrl+d' && !this.state.draft) {
      this.exit(0);
      return;
    }
    // alt+k, not ctrl+s: ctrl+s is XOFF and freezes a terminal that has ixon on.
    // Idle presses do nothing; a waiting request opens its card.
    if (key === 'alt+k') {
      const request = listPending(this.home)[0];
      if (request)
        void this.enterSecret(request, new AbortController().signal).catch(
          (error) => this.fail(error),
        );
      return;
    }
    if (this.composer.completionKey(key)) {
      this.repaint();
      return;
    }
    if (key === 'ctrl+c') {
      if (this.state.draft && !this.runtime?.busy) {
        // What you typed is cleared but stays in the history
        this.jobWakeSnoozed = true;
        this.remember(this.state.draft);
        this.composer.clear();
        this.lastCtrlC = 0;
      } else this.ctrlC();
    } else if (key === 'ctrl+z') {
      this.suspend();
      return;
    } else if (key === 'escape') {
      this.jobWakeSnoozed = true;
      if (this.runtime?.busy) this.interrupt();
      else if (this.state.draft) {
        // One esc is not enough to throw the draft away. The second clears it,
        // and ctrl+y puts that draft back.
        // The hint stays for the flash (1.8s). A second esc in that time clears.
        if (Date.now() - this.lastEscape < 1800) {
          this.composer.stashClear();
          this.flash('cleared · ctrl+y restores');
          this.lastEscape = 0;
        } else {
          this.lastEscape = Date.now();
          this.flash('press esc again to clear · ctrl+y restores');
        }
      } else if (this.whatsNew && this.transcriptIsHome()) {
        this.dismissNotice();
      } else if (
        Date.now() - this.lastEscape < 500 &&
        this.settings.double_escape !== 'none'
      ) {
        this.lastEscape = 0;
        void this.command(this.settings.double_escape, '');
      } else this.lastEscape = Date.now();
    } else if (key === 'ctrl+b') {
      const count = this.runtime?.jobs.backgroundForeground() ?? 0;
      this.flash(
        count === 1
          ? 'Moved to the background'
          : count
            ? `${count} commands moved to the background`
            : this.runtime?.busy &&
                this.state.subagents?.some(
                  (agent) => !agent.background && agent.state === 'running',
                )
              ? "Subagents can't move to the background"
              : 'Nothing to move',
      );
    } else if (key === 'ctrl+o') {
      this.state.showTools = !this.state.showTools;
      this.flash(this.state.showTools ? 'Tools expanded' : 'Tools folded');
    } else if (key === 'ctrl+t') {
      this.state.thinkingExpanded = !this.state.thinkingExpanded;
      this.state.showThinking = true;
      this.flash(
        this.state.thinkingExpanded
          ? 'Thinking expanded'
          : 'Thinking collapsed',
      );
    } else if (key === 'ctrl+l') {
      // readline: redraw. The model list is alt+l (/models).
      this.terminal.write('\x1b[2J');
      this.screen.invalidate();
      this.repaint();
    } else if (key === 'alt+l')
      void this.command('models', '').catch((error) => this.fail(error));
    else if (key === 'ctrl+g')
      void this.command('editor', '').catch((error) => this.fail(error));
    else if (key === 'alt+c')
      void this.command('copy', '').catch((error) => this.fail(error));
    else if (key === 'alt+m')
      void this.cycleModel().catch((error) => this.fail(error));
    else if (key === 'shift+tab' && this.runtime)
      // cycles the session mode, as shift+tab does in other coding agents
      void this.command('mode', '').catch((error) => this.fail(error));
    else if (key === 'alt+t' && this.runtime) {
      try {
        cycleThinking(this.commandHost());
      } catch (error) {
        this.fail(error);
      }
    } else if (key === 'alt+up' && this.runtime) {
      const taken = this.takeBack(true);
      if (taken.length) {
        this.composer.putBack(
          [
            ...taken.map((item) => item.display),
            ...(this.state.draft ? [this.state.draft] : []),
          ].join('\n\n'),
          Object.assign({}, ...taken.map((item) => item.pastes ?? {})),
        );
        this.flash(
          `${taken.length} queued message${taken.length === 1 ? '' : 's'} back in the box`,
        );
      }
    } else if (
      key === 'up' &&
      !this.state.draft &&
      this.runtime?.harness.pendingMessageCount
    ) {
      // ↑ in an empty box takes back the last message waiting, to change or drop
      const [taken] = this.takeBack(false);
      if (taken) this.composer.putBack(taken.display, taken.pastes);
    } else if (
      key === 'enter' &&
      !this.state.draft.trim() &&
      this.runtime?.harness.steerNow()
    )
      this.flash('Sending steering now');
    else if (['ctrl+q', 'alt+enter', 'alt+return'].includes(key)) {
      if (this.state.draft.trim()) this.send('followUp');
    } else if (key === 'ctrl+v' || key === 'alt+v')
      // alt+v where the terminal keeps ctrl+v for its own paste (Windows Terminal)
      void this.pasteImage().catch((error) => this.fail(error));
    else this.composer.key(key, char);
    this.repaint();
  }
  // ctrl+v: a picture on the clipboard goes in the box as `[Image #N]`, kept as a PNG with the
  // project's data; image files copied in the file manager go in as they are.
  private async pasteImage(): Promise<void> {
    const view = this.view;
    const folder = join(
      projectDataDir(this.workspace, this.home),
      'pasted_images',
    );
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const target = join(
      folder,
      new Date().toISOString().replace(/[:.]/g, '-') + '.png',
    );
    const found = await this.clipboard.readImage(target);
    // Only files that are there and not empty: a write that failed must not become a token
    const files = (
      !found ? [] : 'png' in found ? [found.png] : found.files
    ).filter(
      (file) => mediaType(file) && existsSync(file) && statSync(file).size > 0,
    );
    if (this.ended || view.runtime?.isClosing) return;
    this.inView(view, () => {
      if (files.length) this.attachFiles(files);
      else this.flash('No image on the clipboard');
    });
    this.repaint();
  }
  private attachFiles(files: string[]): void {
    for (const file of files) this.composer.attach(file);
    this.composer.update();
    const model = this.runtime?.harness.model;
    if (
      model?.imageInput === false &&
      files.some((file) => mediaType(file) !== 'application/pdf')
    )
      this.flash(`${model.model} does not read images`);
    this.repaint();
  }
  // ctrl+c with nothing typed: it stops a running turn; otherwise the first press
  // says how to leave and a second within 1.5 s leaves (so does one just after a stop).
  private ctrlC(): void {
    this.jobWakeSnoozed = true;
    const now = Date.now();
    if (this.runtime?.busy) {
      this.interrupt();
      this.lastCtrlC = now;
    } else if (now - this.lastCtrlC < 1500) this.exit(0);
    else {
      this.lastCtrlC = now;
      const live =
        this.runtime?.jobs.list().filter((job) => job.status === 'running')
          .length ?? 0;
      this.flash(
        'Press ctrl+c again to exit' +
          (live ? ` · stops ${live} job${live === 1 ? '' : 's'}` : ''),
        1500,
      );
    }
  }
  // esc or ctrl+c during a turn: the turn stops, and the messages it had not read
  // yet are sent next, one turn each, the steering ones first.
  private interrupt(): void {
    const runtime = this.runtime;
    const view = this.view;
    if (!runtime) return;
    void runtime.cancel({ keepQueue: true }).then(() => {
      if (
        this.ended ||
        runtime.isClosing ||
        runtime.busy ||
        !runtime.harness.pendingMessageCount
      )
        return;
      // A message of yours starts this turn: finished jobs may start turns again
      view.jobWakeSnoozed = false;
      view.jobWakeCount = 0;
      void runtime.harness
        .run()
        .catch(() => {
          /* The event bus shows how the turn ended. */
        })
        .finally(() => this.repaint());
    });
  }
  // ctrl+z: the shell gets the terminal back and `fg` brings Circle back with the screen drawn
  // again. Windows has no job control.
  private suspend(): void {
    if (this.terminal.platform === 'win32') {
      this.flash('Suspending is not supported here');
      return;
    }
    if (this.externalEditor) return;
    this.lendTerminal();
    try {
      // The process stops here; the call returns once the shell continues it.
      this.terminal.kill('SIGTSTP');
    } catch (error) {
      this.fail(error);
    } finally {
      this.takeTerminal();
    }
  }
  // The screen goes to another program (the shell after ctrl+z, $EDITOR): the terminal as it
  // was before Circle, keys in line mode. Nothing is drawn or asked until it comes back.
  private lendTerminal(): void {
    this.externalEditor = true;
    this.input.reset();
    this.terminal.write(
      '\x1b[?2031l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t',
    );
    this.terminal.input(false);
  }
  private takeTerminal(): void {
    this.externalEditor = false;
    if (this.ended) return;
    this.terminal.input(true);
    this.terminal.write(
      '\x1b[22;0t' +
        (this.title ? `\x1b]0;${this.title}\x07` : '') +
        '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[2J',
    );
    this.screen.invalidate();
    this.repaint();
  }
  // The open /jobs list takes the jobs as they are now. While
  // it asks something (stop this job?) it is put aside and keeps following.
  private refreshJobsList(): void {
    const open = this.jobsList;
    if (!open) return;
    if (this.state.picker === open.list) {
      if (!open.list.asking) open.list.setItems(open.rows());
    } else if (!this.state.dialog) this.jobsList = undefined;
  }
  /** The open reason row, drawn from the composer so the cursor and completions match. */
  private publishExplain(card: ApprovalCard): void {
    card.draft = this.state.draft;
    const dialog = card.state();
    if (dialog.input !== undefined) dialog.inputCursor = this.state.draftCursor;
    this.state.dialog = dialog;
  }
  /**
   * Keys for `Reject and explain`. The row is the composer: esc returns to the
   * options and keeps the draft, an empty enter is a plain rejection, and a
   * slash command runs without answering the card.
   */
  private explainKey(card: ApprovalCard, key: string, char: string): void {
    if (key === 'escape') {
      card.explaining = false;
      card.focus = card.options.length - 1;
      card.draft = this.state.draft;
      this.state.completion = undefined;
      this.state.dialog = card.state();
      return;
    }
    if (key === 'ctrl+c') {
      if (this.runtime?.busy) this.ctrlC();
      return;
    }
    if (key === 'pageup' || key === 'pagedown') {
      const page = Math.max(1, (process.stdout.rows || 24) - 8);
      this.scrollBy(key === 'pageup' ? page : -page);
      return;
    }
    if (key === 'ctrl+d' && !this.state.draft) {
      this.exit(0);
      return;
    }
    if (key === 'enter') {
      const list = this.state.completion;
      if (
        list?.kind === 'command' &&
        list.value === this.state.draft &&
        list.cursor === this.state.draftCursor
      ) {
        const chosen = list.items[list.focus]?.value;
        if (chosen) {
          this.state.completion = undefined;
          this.composer.set(chosen);
          void this.runExplainCommand(chosen);
          return;
        }
      }
      if (this.composer.completionKey(key)) {
        this.publishExplain(card);
        return;
      }
      const message = this.state.draft.trim();
      if (!message) {
        this.pending?.complete('reject');
        return;
      }
      if (
        message === '?' ||
        (message.startsWith('/') && commandWord(this.state.draft))
      ) {
        void this.runExplainCommand(this.state.draft);
        return;
      }
      this.pending?.complete({ decision: 'reject', message });
      return;
    }
    if (this.composer.completionKey(key)) {
      this.publishExplain(card);
      return;
    }
    this.composer.key(key, char);
    this.publishExplain(card);
  }
  /**
   * A slash command typed in the reason row. The card stays; a command that
   * opens a list takes the keys until that list closes.
   */
  private async runExplainCommand(raw: string): Promise<void> {
    const view = this.view;
    const card = this.card;
    if (!(card instanceof ApprovalCard) || !card.explaining) return;
    const shown = raw.trim();
    view.suspendedDialog = card.state();
    view.state.dialog = undefined;
    view.state.completion = undefined;
    try {
      if (shown === '?') {
        await this.command('hotkeys', '');
        this.composer.set('');
      } else if (shown.startsWith('/')) {
        const extra = new Set([
          ...discoverCustomCommands(this.workspace, this.home).map(
            (command) => command.name,
          ),
          ...(this.runtime?.extensions.commands().keys() ?? []),
        ]);
        const slash = parseSlash(shown, extra);
        if (slash) {
          this.composer.set('');
          await this.command(slash.name, slash.args);
        } else {
          const word = commandWord(raw);
          const off = word ? this.runtime?.extensions.offCommand(word) : '';
          if (word && off) {
            this.composer.set('');
            this.flash(
              `Unknown command /${word} · turn it on with /extensions enable ${off}`,
              4000,
            );
          } else if (
            refusedSlash(raw, shown, new Set([...knownSlashNames(), ...extra]))
          ) {
            const token = word ? `/${word}` : shown;
            const close = word
              ? closeMatch(word, [...knownSlashNames(), ...extra])
              : '';
            this.composer.set('');
            this.flash(
              `Unknown command ${token}` +
                (close ? ` · did you mean /${close}?` : ' · /help lists them'),
              4000,
            );
          } else this.composer.set(raw);
        }
      }
    } catch (error) {
      this.inView(view, () => this.fail(error));
    }
    if (this.view !== view || view.card !== card) return;
    card.draft = view.state.draft;
    if (view.state.picker) {
      view.suspendedDialog = card.state();
      this.repaint();
      return;
    }
    view.suspendedDialog = undefined;
    if (card.explaining) {
      this.composer.update();
      this.publishExplain(card);
    }
    this.repaint();
  }
  // A history file that cannot be written (read-only folder, antivirus) is said
  // once per error; the entry stays in memory and is retried with the next one.
  private historyFailures = new Set<string>();
  private remember(text: string): void {
    if (this.history.add(text)) return;
    const error =
      this.history.persistenceError ??
      new Error('input history could not be saved');
    if (this.historyFailures.has(error.message)) return;
    this.historyFailures.add(error.message);
    this.fail(error);
  }
  /** Queue a message. A store that cannot keep it puts it back in an empty box and says why. */
  private queueMessage(
    runtime: AgentRuntime,
    message: string,
    mode: 'steer' | 'followUp',
    raw: string,
    pastes?: Record<string, string>,
  ): boolean {
    try {
      runtime.harness.queue(message, mode);
      return true;
    } catch (error) {
      if (!this.state.draft) this.composer.restore(raw, pastes);
      this.fail(error);
      return false;
    }
  }
  /** Take back queued messages; a store that cannot let them go keeps them queued. */
  private takeBack(all: boolean): QueuedMessage[] {
    try {
      return this.runtime?.harness.takeBack(all) ?? [];
    } catch (error) {
      this.fail(error);
      return [];
    }
  }
  /** Send the draft: the model reads the long pastes, the screen and the history keep it as shown. */
  private send(kind: 'steer' | 'followUp'): void {
    const view = this.view;
    const raw = this.state.draft;
    const shown = raw.trim();
    if (!shown) return;
    this.composer.take();
    const message = this.composer.modelText(shown);
    const pastes = this.composer.pastesOf(shown);
    this.remember(this.composer.historyText(shown));
    if (kind === 'followUp' && this.runtime?.busy) {
      if (message !== shown)
        this.runtime.harness.shown.set(message, { display: shown, pastes });
      if (this.queueMessage(this.runtime, message, 'followUp', raw, pastes))
        this.flash('Queued follow-up');
    } else
      void this.submit(message, raw, false, shown, pastes).catch((error) =>
        this.inView(view, () => this.fail(error)),
      );
  }
  /** Everything that can follow `/` for the completion list, read again each time a `/` is typed. */
  private completionCommands(): Map<string, string> {
    if (this.commandList && this.state.draft.length > 1)
      return this.commandList;
    const found = new Map(
      BUILTIN_SLASH.map((command) => [command.name, command.description]),
    );
    for (const command of discoverCustomCommands(this.workspace, this.home))
      found.set(command.name, command.description);
    for (const [name, command] of this.runtime?.extensions.commands() ?? [])
      found.set(name, command.description);
    for (const skill of this.runtime?.skills ?? [])
      found.set(`skill:${skill.name}`, skill.description);
    this.commandList = found;
    return found;
  }
  // `raw` is the box as it was sent: with a space before it, a mistyped /command goes to the
  // model as text. `plain` text (from /init or a custom command) is never read as a command.
  // `shown` and `pastes`: the box showed long pastes folded; the model reads `message` whole.
  async submit(
    message: string,
    raw = message,
    plain = false,
    shown = message,
    pastes?: Record<string, string>,
  ): Promise<void> {
    if (!plain && message === '?') {
      await this.command('hotkeys', '');
      return;
    }
    if (!plain && message.startsWith('/')) {
      const extra = new Set([
        ...discoverCustomCommands(this.workspace, this.home).map(
          (command) => command.name,
        ),
        ...(this.runtime?.extensions.commands().keys() ?? []),
      ]);
      const slash = parseSlash(message, extra);
      if (slash) {
        await this.command(slash.name, slash.args);
        return;
      }
      if (
        refusedSlash(raw, message, new Set([...knownSlashNames(), ...extra]))
      ) {
        const word = commandWord(raw);
        const off = word ? this.runtime?.extensions.offCommand(word) : '';
        if (word && off) {
          // The draft was already taken. A turned-off bundled command is not a typo.
          this.flash(
            `Unknown command /${word} · turn it on with /extensions enable ${off}`,
            4000,
          );
          return;
        }
        // Not sent, and not left in the box: the next key would append to it.
        const token = word ? `/${word}` : message;
        const close = word
          ? closeMatch(word, [...knownSlashNames(), ...extra])
          : '';
        this.composer.set('');
        this.flash(
          `Unknown command ${token}` +
            (close ? ` · did you mean /${close}?` : ' · /help lists them'),
          4000,
        );
        return;
      }
    }
    const runtime = this.runtime;
    if (
      !runtime ||
      (this.sessions && this.sessions.lifecycle(runtime.session.id) !== 'open')
    )
      return;
    if (runtime.viewOnly) {
      // The other terminal may have left since this one opened the session.
      // A draft typed while this side could only watch is not sent on the
      // enter that discovers the lease is free. The next enter sends it.
      this.watchLease();
      this.composer.restore(raw, pastes);
      const text = 'view only, the draft stays';
      if (this.state.notices.at(-1) !== text) this.notice(text);
      return;
    }
    if (!plain && message.startsWith('!')) {
      try {
        await runtime.userShells.run(
          message.slice(message.startsWith('!!') ? 2 : 1),
          message.startsWith('!!'),
        );
      } finally {
        if (!runtime.busy && runtime.harness.pendingMessageCount)
          void runtime.harness.run().catch(() => {
            /* Run error is already displayed by the event bus. */
          });
        this.repaint();
      }
      return;
    }
    this.jobWakeSnoozed = false;
    this.jobWakeCount = 0;
    // The notice was on the home page and a session is starting. Hiding it
    // because the transcript is no longer empty is not enough: /new would
    // show it again. Dismiss or this prompt marks it seen.
    if (this.whatsNewShown) this.dismissNotice();
    if (shown !== message)
      runtime.harness.shown.set(message, { display: shown, pastes });
    if (runtime.busy) {
      if (this.queueMessage(runtime, message, 'steer', raw, pastes))
        this.flash('Queued steering');
    } else {
      try {
        await runtime.harness.run(message);
      } catch {
        /* Run error is already displayed by the event bus. */
      }
      this.repaint();
    }
  }
  // A list above the frame. Choosing a row (or, with `freeText`, enter on what was typed)
  // closes it first; its own keys and the answers to what it asks keep it open. `closed`
  // runs when esc closes it.
  private picker(
    title: string,
    items: PickerItem[],
    choose: (item: PickerItem) => Promise<void> | void,
    options: PickerOptions = {},
    closed?: () => void,
  ): Picker {
    const view = this.view;
    const shut = (): void => {
      if (view.state.picker === list) view.state.picker = undefined;
      if (view.suspendedDialog) {
        view.state.dialog = view.suspendedDialog;
        view.suspendedDialog = undefined;
      }
    };
    const freeText = options.freeText;
    const list: Picker = new Picker(
      title,
      items,
      (item) => {
        shut();
        list.settle(() => choose(item));
      },
      () => {
        shut();
        closed?.();
        this.repaint();
      },
      {
        ...options,
        keys: Object.fromEntries(
          Object.entries(options.keys ?? {}).map(([key, action]) => [
            key,
            (item: PickerItem | undefined) => list.settle(() => action(item)),
          ]),
        ),
        freeText:
          freeText &&
          ((text) => {
            shut();
            return freeText(text);
          }),
      },
    );
    list.settle = (work) => {
      Promise.resolve()
        .then(() => this.inView(view, work))
        .then(
          () => this.repaint(),
          (error) => this.inView(view, () => this.fail(error)),
        );
    };
    this.state.picker = list;
    this.repaint();
    return list;
  }
  // What the commands in slash_handlers.ts use of the session.
  private commandHost(): CommandHost {
    const app = this;
    let owner = this.view;
    return {
      get runtime() {
        return owner.runtime!;
      },
      createSession: async () => {
        const before = this.runtime?.session.id;
        await this.changeSession();
        owner = this.selectedView;
        return this.runtime?.session.id !== before;
      },
      openSession: async (id) => {
        await this.changeSession(id);
        owner = this.selectedView;
      },
      deleteSession: async (id) => {
        if (await this.deleteSession(id)) owner = this.selectedView;
      },
      selected: () => owner === this.selectedView,
      refreshConnection: () => this.refreshConnections(),
      watchLease: () => this.watchLease(),
      heldElsewhere: (id) => {
        const owned = this.sessions?.get(id);
        return owned ? owned.viewOnly : sessionOccupied(this.home, id);
      },
      sessionStatus: (id) => {
        if (this.sessions?.lifecycle(id) === 'deleting') return 'deleting';
        const runtime = this.sessions?.get(id);
        const view = runtime && this.views.get(runtime);
        return view &&
          (view.state.waiting || view.interactions.pendingCount > 0)
          ? 'waiting for you'
          : runtime?.busy
            ? 'running'
            : undefined;
      },
      importSession: async (text) => {
        fromJsonl(text);
        const sessions = this.ensureSessions();
        const runtime = sessions.create(this.workspace);
        const previousId = runtime.session.id;
        try {
          await runtime.importSession(text);
          sessions.reindex(runtime, previousId);
          runtime.store.delete(previousId);
          await this.selectRuntime(runtime);
          owner = this.selectedView;
        } catch (error) {
          // Keep the source view selected and release the temporary runtime on failure.
          if (sessions.get(previousId) === runtime)
            sessions.reindex(runtime, previousId);
          await sessions.delete(runtime.session.id, { confirmed: true });
          this.views.get(runtime)?.interactions.close();
          this.subscriptions.get(runtime)?.();
          this.subscriptions.delete(runtime);
          await this.browsers.get(runtime)?.close();
          this.browsers.delete(runtime);
          this.terminals.get(runtime)?.close();
          this.terminals.delete(runtime);
          this.views.delete(runtime);
          throw error;
        }
      },
      home: this.home,
      workspace: this.workspace,
      get settings() {
        return app.settings;
      },
      set settings(value) {
        app.settings = value;
      },
      get state() {
        return owner.state;
      },
      get undo() {
        return owner.undo;
      },
      get shared() {
        return owner.shared;
      },
      set shared(value) {
        owner.shared = value;
      },
      get previousSession() {
        return app.previousSession;
      },
      set previousSession(value) {
        app.previousSession = value;
      },
      notice: (text) => this.inView(owner, () => this.notice(text)),
      flash: (text, ttl) => this.inView(owner, () => this.flash(text, ttl)),
      fail: (error) => this.inView(owner, () => this.fail(error)),
      repaint: () => this.repaint(),
      picker: (title, items, choose, options) => {
        this.inView(owner, () => this.picker(title, items, choose, options));
      },
      closePicker: () => {
        owner.state.picker = undefined;
        this.repaint();
      },
      setDraft: (text, pastes) => owner.composer.restore(text, pastes),
      snoozeJobs: () => {
        owner.jobWakeSnoozed = true;
      },
      send: (text) => this.inView(owner, () => this.submit(text, text, true)),
      command: (name, args) =>
        this.inView(owner, () => this.command(name, args)),
      setTheme: (mode) => {
        this.theme.mode = mode;
        this.theme.apply();
        this.repaint();
      },
      trustWorkspace: () => this.trustWorkspace(),
      clipboard: async (text) => {
        if (await this.clipboard.copyNative(text)) return true;
        // No local tool (tmux, ssh, a Linux terminal without wl-copy). OSC 52
        // asks the terminal for the clipboard. The file is only the last resort.
        return (await this.clipboard.copySelection(text)).length > 0;
      },
      followJobs: (list, rows) => {
        owner.jobsList = { list, rows };
      },
      terminals: () =>
        owner.runtime ? this.terminals.get(owner.runtime) : undefined,
      followTerminals: (list, rows) => {
        owner.terminalsList = { list, rows };
      },
      openTerminal: (id) => this.inView(owner, () => this.openTerminalPage(id)),
      connectTerminal: (name) =>
        this.inView(owner, () => this.connectTerminalProfile(name)),
      cutTerminal: (id) => this.inView(owner, () => this.cutTerminal(id)),
      secretValue: (body) =>
        this.inView(owner, () => this.showCard(new SecretCard(body, true))),
      clearContextMeter: () => {
        owner.meterCleared =
          owner.runtime?.harness.messages
            .filter((message) => message.role === 'assistant' && message.usage)
            .at(-1)?.id ?? '';
      },
    };
  }
  // The screen before a turn, which /undo goes back to. The turn's own message is saved
  // before the turn starts, so it is left out.
  private screenBefore(prompt: unknown): ScreenSnapshot {
    const runtime = this.runtime!;
    const messages = runtime.harness.messages;
    return this.undo.snapshot(
      runtime.session.id,
      prompt !== undefined && messages.at(-1)?.role === 'user'
        ? messages.slice(0, -1)
        : messages,
      this.state.notices,
      this.state.noticeAnchors,
    );
  }
  private scopedModels(): string[] {
    const runtime = this.runtime!;
    this.runScopeOnly ??= Boolean(runtime.runOptions.models.length);
    return modelScope(
      this.knownModels ?? [],
      this.runScopeOnly
        ? runtime.runOptions.models
        : this.settings.enabled_models,
      runtime.harness.model.model,
    );
  }
  private async loadModels(runtime = this.runtime!): Promise<string[]> {
    const settings = runtime.options.settings;
    const credentials = loadCredentials(this.home);
    const result = await resolveEndpoint(
      settings.auth.base_url,
      credentials[settings.auth.api_key_ref] || '',
      { protocol: settings.auth.protocol },
    );
    if (result.status === 'failed') throw new Error(result.detail);
    this.knownModels = result.models;
    this.knownModelsEndpoint =
      settings.auth.protocol + ':' + settings.auth.base_url;
    return modelScope(result.models, [], runtime.harness.model.model);
  }
  private async cycleModel(): Promise<void> {
    const runtime = this.runtime;
    const view = this.view;
    if (!runtime) return;
    if (runtime.busy) {
      this.flash('Busy · switch models when the turn has finished');
      return;
    }
    if (
      !this.knownModels ||
      this.knownModelsEndpoint !==
        this.settings.auth.protocol + ':' + this.settings.auth.base_url
    )
      await this.loadModels(runtime);
    if (runtime.isClosing) return;
    const scope = this.inView(view, () => this.scopedModels());
    if (scope.length < 2) {
      this.inView(view, () =>
        this.flash('Only one model to cycle through · /models lists them'),
      );
      return;
    }
    const current = scope.indexOf(runtime.harness.model.model);
    await this.inView(view, () =>
      this.command('models', scope[(current + 1) % scope.length]!),
    );
  }
  private connectionBusy(): boolean {
    const runtimes = this.views.size
      ? [...this.views.keys()]
      : this.runtime
        ? [this.runtime]
        : [];
    return runtimes.some(
      (runtime) =>
        !runtime.isClosing &&
        (runtime.busy ||
          runtime.jobs.list().some((job) => job.status === 'running')),
    );
  }
  private refreshConnections(): void {
    if (this.connectionBusy())
      throw new Error(
        'wait for all sessions to finish before changing the connection',
      );
    const runtimes = this.views.size
      ? [...this.views.keys()]
      : this.runtime
        ? [this.runtime]
        : [];
    for (const runtime of runtimes) {
      if (runtime.isClosing) continue;
      const settings = structuredClone(runtime.options.settings);
      settings.auth = structuredClone(this.settings.auth);
      settings.initialized = this.settings.initialized;
      settings.enabled_models = [...this.settings.enabled_models];
      runtime.refreshConnection(settings);
    }
    if (this.runtimeOptions)
      this.runtimeOptions = {
        ...this.runtimeOptions,
        model: this.runtime?.options.model,
        modelOverride: undefined,
      };
    this.knownModels = undefined;
    this.commandList = undefined;
  }
  async command(name: string, args: string): Promise<void> {
    const view = this.view;
    if (view.state.flash) {
      view.state.flash = '';
      if (this.flashTimer) clearTimeout(this.flashTimer);
      this.flashTimer = undefined;
      this.repaint();
    }
    if (!this.runtime) return;
    if (['login', 'logout'].includes(name) && this.connectionBusy()) {
      const reason =
        'Busy · wait for all sessions to finish before changing the connection';
      this.notice(reason);
      this.flash(reason, 4000);
      if (!this.state.draft) this.composer.restore(`/${name}`);
      return;
    }
    if (await runCommand(this.commandHost(), name, args, () => this.leave()))
      return;
    try {
      await this.inView(view, () => this.ownCommand(name, args));
    } catch (error) {
      this.inView(view, () =>
        this.fail(
          `/${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }
  // The commands that open SessionApp's own lists and dialogs.
  private async ownCommand(name: string, args: string): Promise<void> {
    const runtime = this.runtime;
    const view = this.view;
    if (!runtime) return;
    if (name === 'models') {
      const choose = (model: string, extra = ''): void => {
        if (runtime.harness.busy) throw new Error('a turn is running');
        runtime.setModel(model);
        // One space around each separator. The footer flash goes away; the
        // transcript line stays, including `not listed by this endpoint`.
        const line = `model set to ${model}${extra} · this session`.replace(
          / {2,}/g,
          ' ',
        );
        this.notice(line);
        this.flash(`${line} (alt+d in /models saves it)`, 4000);
      };
      if (args.trim()) {
        const model = args.trim();
        let extra = '';
        try {
          const endpoint =
            runtime.options.settings.auth.protocol +
            ':' +
            runtime.options.settings.auth.base_url;
          // alt+m calls this with an id from the list just loaded. Ask the
          // endpoint again only when that list is missing.
          if (!this.knownModels || this.knownModelsEndpoint !== endpoint)
            await this.loadModels(runtime);
          if (runtime.isClosing) return;
          if (!(this.knownModels ?? []).some((item) => sameModel(item, model)))
            extra = ' · not listed by this endpoint';
        } catch {
          extra = '';
        }
        choose(model, extra);
      } else {
        const models = await this.loadModels(runtime);
        if (runtime.isClosing) return;
        this.inView(view, () => {
          this.scopedModels();
          const rows = (): PickerItem[] =>
            models.map((model) => ({
              key: model,
              label: model,
              current: sameModel(model, runtime.harness.model.model),
              meta: [
                model === this.settings.auth.model ? 'default' : '',
                (this.runScopeOnly
                  ? runtime.runOptions.models
                  : this.settings.enabled_models
                ).length && this.scopedModels().includes(model)
                  ? 'in alt+m'
                  : '',
              ]
                .filter(Boolean)
                .join(' · '),
            }));
          this.picker('Model', rows(), (item) => choose(item.key), {
            hint: 'enter uses it in this session · alt+d also makes it the default · tab adds it to alt+m or takes it out',
            empty:
              'No model matches · /models <id> uses an id the endpoint does not list',
            focusKey:
              models.find((model) =>
                sameModel(model, runtime.harness.model.model),
              ) ?? runtime.harness.model.model,
            keys: {
              'alt+d': (item) => {
                if (!item) return;
                runtime.setModel(item.key);
                this.settings.auth.model = item.key;
                saveSettingsChange(this.home, (saved) => {
                  saved.auth.model = item.key;
                });
                this.state.picker = undefined;
                this.notice(`Model → ${item.key} · saved as the default`);
              },
              tab: (item) => {
                if (!item) return;
                const scoped = this.runScopeOnly
                  ? runtime.runOptions.models
                  : this.settings.enabled_models;
                const chosen = scoped.length ? this.scopedModels() : [];
                const next = chosen.includes(item.key)
                  ? chosen.filter((model) => model !== item.key)
                  : [...chosen, item.key];
                if (this.runScopeOnly) runtime.runOptions.models = next;
                else {
                  this.settings.enabled_models = next;
                  saveSettingsChange(this.home, (saved) => {
                    saved.enabled_models = next;
                  });
                }
                this.state.picker?.setItems(rows());
                this.flash(
                  next.length
                    ? `alt+m goes through ${next.length} model${next.length === 1 ? '' : 's'}`
                    : 'alt+m goes through every listed model',
                  2000,
                );
              },
            },
          });
        });
      }
      return;
    }
    if (name === 'editor') {
      if (await this.editor())
        this.flash('Loaded from the editor · enter sends');
      return;
    }
    if (name === 'login') {
      this.login();
      return;
    }
    if (name === 'reload') {
      const keys = loadRemap(this.home);
      this.remap = keys.remap;
      for (const problem of keys.problems) this.fail(problem);
      try {
        await runtime.reloadIntegrations();
      } catch (error) {
        if (this.ended || runtime.isClosing) return;
        this.inView(view, () =>
          this.fail(
            `Reload partly failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }
      if (this.ended || runtime.isClosing) return;
      this.inView(view, () => {
        this.settings = structuredClone(runtime.options.settings);
        runtime.setModel(this.settings.auth.model);
        if (this.theme.mode !== this.settings.theme) {
          this.theme.mode = this.settings.theme;
          this.theme.apply();
        }
        this.notice('Reloaded settings and the model');
      });
      this.repaint();
      return;
    }
    this.flash(`Unknown command /${name} · try /help`);
  }
  // /login: setup's questions asked in a list, the URL and the key (as dots) on its search
  // line; Circle signs in only with an API URL and key. Nothing is saved before a model is
  // chosen; esc on the key goes back to the URL, esc on the URL leaves.
  private login(): void {
    const view = this.view;
    const flow = new SetupFlow(this.home);
    this.loginFlow = flow;
    const title = (): string =>
      'Sign in' + (flow.error ? ` · ${flow.error}` : '');
    const leave = (): void => {
      if (this.loginFlow === flow) this.loginFlow = undefined;
    };
    const askUrl = (list: Picker, text: string): void => {
      list.title = title();
      list.ask(
        'base url',
        text,
        (typed) => {
          flow.submitUrl(typed);
          // not a URL: say why and ask again
          if (flow.step === 'url') askUrl(list, typed);
          else askKey(list);
        },
        { keys: 'enter continues · esc closes', cancel: () => list.close() },
      );
    };
    const askKey = (list: Picker): void => {
      list.title = title();
      list.ask(
        'api key' + (flow.keepsKey ? ' (enter keeps the saved one)' : ''),
        '',
        (typed) => {
          flow.submitKey(typed);
          if (flow.step === 'key') askKey(list);
          else next();
        },
        {
          mask: true,
          keys: 'enter continues · esc goes back',
          cancel: () => {
            flow.restart();
            askUrl(list, flow.baseUrl);
          },
        },
      );
    };
    // The list the URL and the key are asked on; under them, what is in use now.
    const ask = (): void => {
      const auth = this.settings.auth;
      const list = this.picker(
        title(),
        [],
        () => {},
        {
          empty: this.settings.initialized
            ? `now ${endpointName(auth.base_url)} · ${auth.model}`
            : 'not signed in',
        },
        leave,
      );
      askUrl(list, flow.baseUrl);
      // picker() painted the list before the question was put on it
      this.repaint();
    };
    // The list for the step the answers have reached; at the end, sign in with them.
    const next = (): void =>
      this.inView(view, () => {
        if (this.loginFlow !== flow) return; // left with esc while the endpoint was asked
        if (flow.step === 'done') {
          this.loginFlow = undefined;
          if (this.connectionBusy()) {
            this.fail(
              'Sign in cancelled · wait for all sessions to finish before changing the connection',
            );
            return;
          }
          this.saveConnection(flow);
          // The model chosen here wins over `--model` and the project's
          const chosen = this.settings.auth.model;
          this.applyRunSettings();
          this.settings.auth.model = this.state.model = chosen;
          this.refreshConnections();
          this.notice(
            `Signed in to ${endpointName(this.settings.auth.base_url)} · model ${this.settings.auth.model}`,
          );
        } else if (flow.step === 'probing') {
          this.picker(
            title(),
            [],
            () => {},
            { empty: `asking ${endpointName(flow.baseUrl)} for its models…` },
            leave,
          );
          void flow.runProbe().then(
            () => next(),
            (error) => this.inView(view, () => this.fail(error)),
          );
        } else if (flow.step === 'protocol')
          this.picker(
            title(),
            [
              { key: 'openai', label: 'OpenAI-style API' },
              { key: 'anthropic', label: 'Anthropic-style API' },
            ],
            (item) => {
              flow.chooseProtocol(item.key === 'anthropic' ? 1 : 0);
              next();
            },
            {
              hint: `${flow.status} · which kind of API is it?`,
              focusKey: flow.focus ? 'anthropic' : 'openai',
            },
            leave,
          );
        else if (flow.step === 'model') {
          const current = this.settings.auth.model;
          this.picker(
            title(),
            flow.models.map((model) => ({
              key: model,
              label: model,
              current: model === current,
            })),
            (item) => {
              flow.use(item.key);
              next();
            },
            {
              hint: flow.status,
              focusKey: current,
              // An id the endpoint did not list, not checked
              freeText: (text) => {
                flow.use(text);
                next();
              },
              empty: flow.models.length
                ? 'No model matches · enter uses what you typed'
                : 'Type the model id your endpoint uses',
            },
            leave,
          );
        } else if (flow.step === 'provider') {
          this.picker(
            title(),
            PROVIDER_PRESETS.map((item) => ({
              key: item.id,
              label: item.name,
            })),
            (item) => {
              flow.chooseProvider(item.key);
              ask();
            },
            { hint: 'which provider?' },
            leave,
          );
        } else ask();
      });
    next();
  }
  /** pbcopy, wl-copy or xclip (clip on Windows); false when none took the text. */
  private async copy(text: string): Promise<boolean> {
    return this.clipboard.copyNative(text);
  }
  /** A press on a subagent page's band: `main` goes back, `prev` and `next` step through. */
  private pageButton(event: Extract<InputEvent, { type: 'mouse' }>): boolean {
    const band = this.state.pageButtons;
    if (
      !band ||
      event.action !== 'press' ||
      event.button !== 0 ||
      event.y !== band.row
    )
      return false;
    const hit = band.spans.find(
      ([start, end]) => event.x >= start && event.x < end,
    );
    if (!hit) return false;
    if (hit[2] === 'back') this.agents.clear();
    else
      this.agents.handle(
        hit[2] === 'prev' ? 'left' : 'right',
        '',
        (this.state.subagents ?? []).map((agent) => agent.id),
        '',
      );
    this.state.scroll = 0;
    this.repaint();
    return true;
  }
  /** A press on a subagent's row in the strip opens its page. */
  private stripClick(event: Extract<InputEvent, { type: 'mouse' }>): boolean {
    const strip = this.state.stripAgents;
    if (!strip || event.action !== 'press' || event.button !== 0) return false;
    const id = strip.ids[event.y - strip.row];
    if (!id) return false;
    this.agents.open(id);
    this.state.hoverAgent = undefined;
    this.state.scroll = 0;
    this.repaint();
    return true;
  }
  /** A mouse event for the selection; a press on a task row opens the task instead. */
  private selectionMouse(
    event: Extract<InputEvent, { type: 'mouse' }>,
  ): boolean {
    if (
      event.action === 'press' &&
      /^ . Agent\(/.test(stripAnsi(this.frameRows[event.y] ?? '')) &&
      this.state.subagents?.length
    )
      return false;
    return this.selection.mouse(event);
  }
  // The conversation, or the record that is open, by `rows` (positive goes back towards
  // the start), never past either end: rows past the top would have to be scrolled back
  // before anything moved.
  private scrollBy(rows: number): void {
    const top = this.state.view?.maxScroll ?? Number.MAX_SAFE_INTEGER;
    this.state.scroll = Math.max(0, Math.min(top, this.state.scroll + rows));
  }
  // The subagents the strip shows, one row along; the window then stays where the wheel
  // left it until a key moves the selection.
  private scrollStrip(step: number): void {
    const running = (this.state.subagents ?? [])
      .filter(
        (agent) =>
          !agent.background && ['running', 'waiting'].includes(agent.state),
      )
      .map((agent) => agent.id);
    const first = Math.max(
      0,
      running.indexOf(this.state.stripAgents?.ids[0] ?? ''),
    );
    this.state.stripStart = Math.max(0, first + step);
  }
  // The strip row and the page button under the mouse; a repaint only when that changed.
  private hover(event: Extract<InputEvent, { type: 'mouse' }>): void {
    const strip = this.state.stripAgents;
    const agent = strip ? strip.ids[event.y - strip.row] : undefined;
    const band = this.state.pageButtons;
    const button =
      band && event.y === band.row
        ? band.spans.find(
            ([start, end]) => event.x >= start && event.x < end,
          )?.[2]
        : undefined;
    if (agent === this.state.hoverAgent && button === this.state.hoverButton)
      return;
    this.state.hoverAgent = agent;
    this.state.hoverButton = button;
    this.repaint();
  }
  private scrollTranscript(delta: number): void {
    const view = this.state.viewport;
    this.state.scroll = Math.min(
      view ? Math.max(0, view.total - view.height) : Infinity,
      Math.max(0, this.state.scroll - delta),
    );
    this.repaint();
  }
  private copySelection(text: string): void {
    const view = this.view;
    void this.clipboard.copySelection(text).then(
      () =>
        this.inView(view, () =>
          this.flash(`Copied ${Array.from(text).length} chars`),
        ),
      (error) => this.inView(view, () => this.fail(error)),
    );
  }
  // $VISUAL, $EDITOR, or nvim, vim or nano (notepad on Windows), on the draft in full; what
  // it leaves in the file comes back to the box, whatever the editor exits with.
  private async editor(): Promise<boolean> {
    if (this.externalEditor) throw new Error('an editor is already running');
    const words = editorCommand(process.env, this.terminal.platform);
    if (!words) {
      this.fail('No $VISUAL / $EDITOR set, and no nvim, vim or nano found');
      return false;
    }
    const directory = mkdtempSync(join(tmpdir(), 'circle-editor-'));
    const path = join(directory, 'draft.md');
    // The editor gets the draft in full, pastes written out
    writeFileSync(path, this.composer.modelText(this.state.draft), {
      mode: 0o600,
    });
    this.lendTerminal();
    try {
      try {
        await new Promise<void>((resolveEditor, reject) => {
          const child = spawn(words[0]!, [...words.slice(1), path], {
            cwd: this.workspace,
            stdio: 'inherit',
          });
          child.once('error', reject);
          child.once('exit', () => resolveEditor());
        });
      } finally {
        this.takeTerminal();
      }
      // Back in the box like a paste: a long text folded again
      this.composer.clear();
      this.composer.paste(readFileSync(path, 'utf8').replace(/\n+$/, ''));
      return true;
    } catch (error) {
      this.fail(
        `Could not open the editor: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  /** /exit. A running turn is stopped first, and the screen says so. */
  private leave(): void {
    if (this.ended || this.leaving) return;
    const runtimes = this.sessions
      ? [...this.sessions.values()]
      : this.runtime
        ? [this.runtime]
        : [];
    if (!runtimes.some((runtime) => runtime.busy && !runtime.viewOnly)) {
      this.exit(0);
      return;
    }
    this.leaving = true;
    this.notice('Leaving · stopping the turn');
    this.repaint();
    void Promise.allSettled(
      runtimes.map((runtime) =>
        runtime.busy && !runtime.viewOnly
          ? runtime.cancel({ keepQueue: false })
          : Promise.resolve(),
      ),
    ).finally(() => this.exit(0));
  }
  exit(code: number): void {
    if (this.ended) return;
    this.ended = true;
    this.pending?.abort?.();
    this.done(code);
  }
  async wait(): Promise<number> {
    return this.completion;
  }
  // Once: the exit guard and runTui may both close, and the lines are written only once.
  close(): Promise<void> {
    this.closing ??= this.closeOnce();
    return this.closing;
  }
  private async closeOnce(): Promise<void> {
    this.ended = true;
    this.off?.();
    this.offSignals?.();
    for (const view of this.views.values()) {
      view.interactions.close();
      view.pending?.abort?.();
      if (view.flashTimer) clearTimeout(view.flashTimer);
      view.selection.close();
    }
    this.input.close();
    this.theme.close();
    if (this.animation) clearInterval(this.animation);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.selection.close();
    process.stdout.off('resize', this.resizeListener);
    process.off('SIGINT', this.signalListener);
    // Windows cooked reads retain the current screen buffer. Finish restoring
    // the main buffer before enabling line input; Windows TTY writes are async.
    const terminalErrors: unknown[] = [];
    try {
      await this.terminal.write(
        '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[?25h\x1b[?1049l\x1b[23;0t',
        true,
      );
    } catch (error) {
      terminalErrors.push(error);
    }
    try {
      this.terminal.input(false);
    } catch (error) {
      terminalErrors.push(error);
    }
    // Once the screen is gone: the jobs that leaving stopped, then the
    // command that opens this conversation again.
    const runtime = this.runtime;
    const jobs = [...this.views.keys()].reduce(
      (sum, owner) => sum + runningJobs(owner),
      0,
    );
    const hint = runtime ? resumeHint(runtime, this.workspace) : '';
    await Promise.all([
      this.sessions?.close() ?? runtime?.close(),
      ...[...this.browsers.values()].map((browser) => browser.close()),
      ...[...this.terminals.values()].map((terminals) => terminals.close()),
    ]);
    if (terminalErrors.length)
      throw new AggregateError(terminalErrors, 'terminal restoration failed');
    for (const line of [stoppedJobsLine(jobs), hint])
      if (line) this.terminal.write(line + '\n');
  }
}
export async function runTui(
  options: Omit<RuntimeOptions, 'approve' | 'question'> & {
    init?: boolean;
    trust?: boolean;
    /** `--approve-hooks`: the waiting project hooks files are approved as they are. */
    approveProjectHooks?: boolean;
    pickSession?: boolean;
    prompts?: string[];
    // What the conversation shows for each prompt, when it differs (`@file`)
    shown?: string[];
  },
): Promise<number> {
  const app = new SessionApp(options.workspace, options.home, options.settings);
  app.start();
  try {
    if (!(await app.initialize(options.init, options.trust))) return 0;
    app.applyRunSettings(options.modelOverride);
    await app.attach(options);
    if (options.approveProjectHooks) app.approveWaitingHooks();
    void app.checkForUpdate();
    if (options.pickSession) await app.command('resume', '');
    // The first message starts a turn; the others follow it, one turn each.
    const [first, ...rest] = options.prompts ?? [];
    if (first !== undefined)
      void app.submit(first, first, false, options.shown?.[0] || first);
    for (const [index, prompt] of rest.entries()) {
      const shown = options.shown?.[index + 1];
      if (shown && shown !== prompt)
        app.runtime?.harness.shown.set(prompt, { display: shown });
      app.runtime?.harness.queue(prompt, 'followUp');
    }
    return await app.wait();
  } finally {
    await app.close();
  }
}

// What the welcome block shows, looked up when it can change rather than on every frame:
// the folder's own things, its recent sessions and the git branch (read again at most every
// two seconds). The lamps follow the session: unlit until the folder is trusted, blinking
// while it loads, green once loaded, red for an extension that failed. Recent sessions
// include a short title and an untitled one that has a message.
import type { AgentRuntime } from '../runtime.js';
import type { CircleSettings } from '../settings.js';
import { isReady } from '../settings.js';
import { currentBranch } from '../git_info.js';
import { EFFORT_LEVELS } from '../model.js';
import type { LampState } from '../ink/theme.js';
import {
  age,
  type WelcomeInfo,
  type WelcomeItem,
} from '../ink/components/welcome.js';
import {
  folderInventory,
  folderItemText,
  type FolderItem,
} from './folder_inventory.js';
import { displayPath } from './status_rows.js';

export interface WelcomeInput {
  version: string;
  settings: CircleSettings;
  runtime?: AgentRuntime;
  // The session has loaded the folder's things.
  connected: boolean;
  trusted: boolean;
  // Setup is asking (first run or `--init`): no model until one is saved, lamps unlit.
  settingUp?: boolean;
}

export class WelcomeState {
  private key?: string;
  private items: FolderItem[] = [];
  private recent: [string, string][] = [];
  private more = 0;
  private branchAt = 0;
  private branchName = '';
  constructor(readonly workspace: string) {}

  branch(now = Date.now()): string {
    if (now - this.branchAt > 2000) {
      this.branchAt = now;
      this.branchName = currentBranch(this.workspace);
    }
    return this.branchName;
  }

  // Looked up again once the folder is trusted, once the session loads, when a
  // session is saved, and for a new session.
  private refresh(input: WelcomeInput, now: number): void {
    const runtime = input.runtime;
    const version = runtime?.store.version ?? -1;
    const key = `${runtime?.session.id ?? ''}|${input.connected}|${input.trusted}|${version}`;
    if (key === this.key) return;
    this.key = key;
    try {
      this.items = folderInventory(this.workspace);
    } catch {
      this.items = [];
    }
    // Short titles and untitled sessions with a message are listed. An empty
    // untitled row is already hidden by the store. The session you are in is
    // left out; you are already looking at it. Shared titles pick up the
    // start of the first reply, or the short id when that reply is shared too.
    if (!runtime) {
      this.recent = [];
      this.more = 0;
      return;
    }
    const saved = runtime.store
      .list(this.workspace)
      .filter((session) => session.id !== runtime.session.id);
    const shown = saved.slice(0, 3);
    this.recent = shown.map((session) => [
      recentLabel(session, shown, saved, runtime.store),
      age(session.updated, now),
    ]);
    this.more = Math.max(0, saved.length - 3);
  }

  info(input: WelcomeInput, now = Date.now()): WelcomeInfo {
    const { settings, runtime } = input;
    this.refresh(input, now);
    const state: LampState =
      !input.trusted || input.settingUp
        ? 'none'
        : input.connected
          ? 'ok'
          : 'running';
    const failed = input.connected
      ? (runtime?.extensions.extensions ?? [])
          .filter((ext) => ext.source === 'project' && ext.error)
          .map((ext) => `${ext.name}: ${ext.error}`)
      : [];
    const items: WelcomeItem[] = this.items.map((item) => {
      const bad = item.kind === 'extensions' && failed.length > 0;
      return {
        kind: item.kind,
        text: folderItemText(item),
        state: bad ? 'error' : state,
        errors: bad ? failed : [],
      };
    });
    // Filled in as setup is answered: the model once the connection is saved.
    const ready = !input.settingUp && (Boolean(runtime) || isReady(settings));
    let model = ready
      ? (runtime?.harness.model.model ?? settings.auth.model)
      : '';
    const depth = runtime?.thinkingLevel ?? '';
    if (model && (EFFORT_LEVELS as readonly string[]).includes(depth))
      model += ` • ${depth}`;
    let endpoint = '';
    try {
      endpoint = new URL(settings.auth.base_url).hostname;
    } catch {
      endpoint = settings.auth.base_url;
    }
    return {
      version: input.version,
      model,
      endpoint: model ? endpoint : '',
      folder: displayPath(this.workspace),
      branch: this.branch(now),
      items,
      recent: this.recent,
      more: this.more,
    };
  }
}

function shortSessionId(id: string): string {
  return id.startsWith('circle-') ? id.slice('circle-'.length) : id.slice(-8);
}

function replySnippet(
  store: {
    messages(id: string): {
      role: string;
      content?: string;
      display?: string;
      internal?: string;
    }[];
  },
  id: string,
): string {
  try {
    const reply = store
      .messages(id)
      .find(
        (message) =>
          message.role === 'assistant' &&
          !message.internal &&
          (message.display || message.content),
      );
    const text = (reply?.display || reply?.content || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return '';
    return text.length <= 18 ? text : `${text.slice(0, 18).trimEnd()}…`;
  } catch {
    return '';
  }
}

function recentLabel(
  session: { id: string; title: string },
  shown: { id: string; title: string }[],
  saved: { id: string; title: string }[],
  store: {
    messages(id: string): {
      role: string;
      content?: string;
      display?: string;
      internal?: string;
    }[];
  },
): string {
  const title = session.title || '(untitled)';
  const duplicates = saved.filter(
    (item) => (item.title || '(untitled)') === title,
  ).length;
  if (duplicates < 2) return title;
  const hint = (item: { id: string }): string => {
    const snippet = replySnippet(store, item.id);
    return snippet
      ? `${title} · ${snippet}`
      : `${title} · ${shortSessionId(item.id)}`;
  };
  const mine = hint(session);
  const sharedHint = shown.filter(
    (item) => (item.title || '(untitled)') === title && hint(item) === mine,
  ).length;
  if (sharedHint < 2) return mine;
  return `${title} · ${shortSessionId(session.id)}`;
}
